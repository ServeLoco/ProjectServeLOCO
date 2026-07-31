/**
 * Periodic sweeper for shop auto-open/auto-close schedules (shops.open_time /
 * close_time). Boundary-triggered, not a window check: it only flips is_open
 * the exact minute the clock matches a set time, and only if the shop isn't
 * already in that state — so a manual toggle made any other time of day is
 * never fought (same reasoning as riderOfferSweeper's DB-is-source-of-truth
 * poll, just on a coarser interval since a minute of slack is fine here).
 */

const { pool } = require('../db/mysql');
const config = require('../config/env');

const SHOP_SCHEDULE_SWEEP_MS = config.SHOP_SCHEDULE_SWEEP_MS || 30000;
const SHOP_SCHEDULE_TZ = config.SHOP_SCHEDULE_TZ || 'Asia/Kolkata';

let timer = null;
let running = false;

// Shops whose scheduled close was blocked by an in-flight order. The close
// minute passes in ~2 ticks, so without this the retry has nothing left to
// match on and the shop stays open until tomorrow's close_time. Retried every
// tick until the order clears, the shop closes by any other route, or its own
// open_time boundary comes round again. Process-local: a restart forgets the
// pending close, same as every other in-memory sweeper state here.
const pendingCloses = new Set();

// Wall clock in the schedule's own timezone. Deliberately NOT
// `new Date().getHours()`: the container sets no TZ and runs on UTC, which
// would fire every schedule 5h30m early against IST times.
const currentHHMM = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_SCHEDULE_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
};

const applyScheduledChange = async (shopId, isOpen) => {
  await pool.query('UPDATE shops SET is_open = ? WHERE id = ?', [isOpen ? 1 : 0, shopId]);
  const [rows] = await pool.query('SELECT id, active FROM shops WHERE id = ?', [shopId]);
  const { emitToAllCustomers, emitToAdmins } = require('./socket');
  emitToAllCustomers('shop.status.updated', { shopId, isOpen });
  try {
    emitToAdmins('admin.shop.updated', {
      shopId, id: shopId, isOpen, is_open: isOpen, active: Boolean(rows[0]?.active),
    });
  } catch (_) { /* best-effort */ }
  const { syncGlobalShopOpenState } = require('../utils/shops');
  await syncGlobalShopOpenState();
  const microCache = require('../utils/microCache');
  microCache.bust('dashboard');
  microCache.bust('categories');
};

const tick = async () => {
  if (running) return;
  running = true;
  try {
    const hhmm = currentHHMM();

    const [toOpen] = await pool.query(
      `SELECT id FROM shops
       WHERE active = 1 AND is_open = 0 AND open_time IS NOT NULL
         AND TIME_FORMAT(open_time, '%H:%i') = ?`,
      [hhmm],
    );
    for (const row of toOpen) {
      // Reopening cancels any close still queued from the day that just
      // ended — that close must not slam the shop shut minutes after it
      // opened for the new day.
      pendingCloses.delete(row.id);
      await applyScheduledChange(row.id, true);
    }

    // Due now, plus anything whose close is still queued from an earlier tick.
    const closeClauses = ["TIME_FORMAT(close_time, '%H:%i') = ?"];
    const closeParams = [hhmm];
    const pendingIds = [...pendingCloses];
    if (pendingIds.length > 0) {
      closeClauses.push(`id IN (${pendingIds.map(() => '?').join(',')})`);
      closeParams.push(...pendingIds);
    }
    const [toClose] = await pool.query(
      `SELECT id FROM shops
       WHERE active = 1 AND is_open = 1 AND close_time IS NOT NULL
         AND (${closeClauses.join(' OR ')})`,
      closeParams,
    );

    // A queued shop the query no longer returns has closed by some other
    // route (manual toggle, deactivation) — nothing left to retry.
    const stillDue = new Set(toClose.map((row) => row.id));
    for (const id of pendingIds) {
      if (!stillDue.has(id)) pendingCloses.delete(id);
    }

    for (const row of toClose) {
      // Same active-order guard as the manual toggle — don't yank a shop
      // closed out from under an order it's still preparing.
      const [activeRows] = await pool.query(
        `SELECT COUNT(DISTINCT o.id) as cnt
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE oi.shop_id = ? AND o.status IN ('Accepted', 'Preparing') AND oi.shop_rejected_at IS NULL`,
        [row.id],
      );
      if (activeRows[0].cnt > 0) {
        pendingCloses.add(row.id);
        continue;
      }
      pendingCloses.delete(row.id);
      await applyScheduledChange(row.id, false);
    }
  } catch (e) {
    console.error('[shop-schedule-sweeper] tick failed:', e.message);
  } finally {
    running = false;
  }
};

const startShopScheduleSweeper = () => {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {});
  }, SHOP_SCHEDULE_SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[shop-schedule-sweeper] started (interval=${SHOP_SCHEDULE_SWEEP_MS}ms)`);
};

const stopShopScheduleSweeper = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pendingCloses.clear();
};

module.exports = {
  startShopScheduleSweeper,
  stopShopScheduleSweeper,
  tick,
  currentHHMM,
  pendingCloses,
  SHOP_SCHEDULE_SWEEP_MS,
  SHOP_SCHEDULE_TZ,
};
