/**
 * Periodic sweeper for rider offer timeouts + boot rehydrate.
 * DB is source of truth (expires_at); works across multi-instance APIs.
 *
 * Deliberately NOT area-scoped (H2/15.5): expireDueOffers, remindPendingOffers
 * and recoverStuckAssignments each operate on already-known offer_id/order_id
 * rows pulled straight from the DB, and recoverStuckAssignments' own eligible-
 * rider lookup is scoped per order's area_id (utils/riders.js, TASK 15) — so
 * running this sweep globally across every area in one tick is safe, not a
 * gap. The one real gap: their admin.* socket emits still go to every
 * connected admin regardless of area (emitToAdmins), same as every other
 * realtime emit in the codebase until per-area rooms land in TASK 23.
 */

const config = require('../config/env');
const {
  expireDueOffers,
  recoverStuckAssignments,
  remindPendingOffers,
} = require('../services/riderAssignment');

const RIDER_SWEEPER_MS = config.RIDER_SWEEPER_MS || 5000;

let timer = null;
let running = false;

let missingTableLogged = false;

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await expireDueOffers();
    // Continuous Expo push while offer is pending (app open or closed).
    await remindPendingOffers();
    await recoverStuckAssignments();
    missingTableLogged = false;
  } catch (e) {
    // Avoid log spam every 5s when migrations have not been applied yet.
    const missing = e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146
      || /doesn't exist/i.test(e.message || ''));
    if (missing) {
      if (!missingTableLogged) {
        console.error('[rider-sweeper] rider tables missing — run npm run db:migrate:dev once. Further ticks suppressed until fixed.');
        missingTableLogged = true;
      }
    } else {
      console.error('[rider-sweeper] tick failed:', e.message);
    }
  } finally {
    running = false;
  }
};

const startRiderOfferSweeper = () => {
  if (timer) return;
  // Immediate rehydrate of anything already expired
  tick().catch(() => {});
  timer = setInterval(() => {
    tick().catch(() => {});
  }, RIDER_SWEEPER_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[rider-sweeper] started (interval=${RIDER_SWEEPER_MS}ms)`);
};

const stopRiderOfferSweeper = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = {
  startRiderOfferSweeper,
  stopRiderOfferSweeper,
  tick,
  RIDER_SWEEPER_MS,
};
