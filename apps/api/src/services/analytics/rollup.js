// Daily rollup job — aggregates sessions + events for a calendar day into one
// analytics_daily doc PER AREA (TASK 17 — groups by (areaId, date), TTL
// 365d). Runs in-process at 00:05 via setTimeout; on startup also backfills
// yesterday if its docs are missing.

const { getDb } = require('../../db/mongodb');
const { listAreas } = require('../../utils/areaScope');

const ROLLOUT_HOUR = 0; // 00:xx
const ROLLOUT_MINUTE = 5; // 00:05

// Local-timezone YYYY-MM-DD. toISOString() would shift to UTC and, in
// timezones ahead of UTC (e.g. IST), roll up the wrong calendar day at 00:05.
const toLocalDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// A doc from before this task, or an event/session ingested through a code
// path that hasn't picked up areaId yet, has no areaId field at all — §9.5/
// 17.10 treat that as area 1 at query time (the only area that has ever
// existed), never a separate "unknown" bucket.
const AREA_ID_FALLBACK = 1;
const resolveAreaId = (doc) => (doc.areaId != null ? doc.areaId : AREA_ID_FALLBACK);

const computeStatsForDocs = (sessions, events) => {
  const distinctUsers = new Set();
  let totalTimeSec = 0;
  for (const s of sessions) {
    if (s.userId != null) distinctUsers.add(s.userId);
    totalTimeSec += s.durationSec || 0;
  }
  const visitors = distinctUsers.size;
  const sessionCount = sessions.length;
  const avgSessionSec = sessionCount > 0 ? Math.round(totalTimeSec / sessionCount) : 0;

  let orders = 0, cartAdds = 0, cartRemoves = 0;
  const usersWithCartAdd = new Set();
  const usersWithOrder = new Set();
  const hourlySet = Array.from({ length: 24 }, () => new Set());
  const productCounts = { cart_add: {}, cart_remove: {}, product_view: {} };

  for (const e of events) {
    const hour = new Date(e.createdAt).getHours();
    if (e.userId != null) hourlySet[hour].add(e.userId);

    if (e.type === 'order_placed') { orders++; usersWithOrder.add(e.userId); }
    if (e.type === 'cart_add') { cartAdds++; usersWithCartAdd.add(e.userId); }
    if (e.type === 'cart_remove') { cartRemoves++; }

    if (e.productId != null && productCounts[e.type]) {
      productCounts[e.type][e.productId] = (productCounts[e.type][e.productId] || 0) + 1;
    }
  }

  // Window shoppers: users with cart_add but no order_placed.
  let windowShoppers = 0;
  for (const uid of usersWithCartAdd) {
    if (!usersWithOrder.has(uid)) windowShoppers++;
  }

  const conversionPct = visitors > 0
    ? Math.round((usersWithOrder.size / visitors) * 1000) / 10
    : 0;

  const hourlyActive = hourlySet.map(s => s.size);

  const toTop10 = (counts) =>
    Object.entries(counts)
      .map(([productId, count]) => ({ productId: Number(productId), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

  return {
    visitors,
    sessions: sessionCount,
    newUsers: 0, // computed below if possible
    avgSessionSec,
    orders,
    conversionPct,
    cartAdds,
    cartRemoves,
    windowShoppers,
    hourlyActive,
    topAdded: toTop10(productCounts.cart_add),
    topRemoved: toTop10(productCounts.cart_remove),
    topViewed: toTop10(productCounts.product_view),
  };
};

/**
 * Compute + upsert one analytics_daily doc PER AREA for a given date string
 * (YYYY-MM-DD) — §9.5/17.7: groups by (areaId, date), one doc per area, not
 * one combined doc. Sessions/events for the whole day are fetched once (not
 * once per area) and partitioned in memory — cheap at "tens of areas" (§3.9),
 * and avoids N find() round trips for N areas.
 * @param {string} dateStr  e.g. '2026-07-08'
 * @param {import('mongodb').Db} [db]  optional injected db (for testing)
 * @returns {Promise<object[]>} the computed stats objects, one per area
 */
const computeDailyStats = async (dateStr, db) => {
  const database = db || getDb();
  const sessionsCol = database.collection('analytics_sessions');
  const eventsCol = database.collection('analytics_events');
  const dailyCol = database.collection('analytics_daily');

  // Date range for the given day (server timezone).
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dateStr + 'T23:59:59.999');

  const [sessions, events, areas] = await Promise.all([
    sessionsCol.find({ connectedAt: { $gte: dayStart, $lte: dayEnd } }).toArray(),
    eventsCol.find({ createdAt: { $gte: dayStart, $lte: dayEnd } }).toArray(),
    listAreas({ activeOnly: true }),
  ]);

  const sessionsByArea = new Map();
  for (const s of sessions) {
    const areaId = resolveAreaId(s);
    if (!sessionsByArea.has(areaId)) sessionsByArea.set(areaId, []);
    sessionsByArea.get(areaId).push(s);
  }
  const eventsByArea = new Map();
  for (const e of events) {
    const areaId = resolveAreaId(e);
    if (!eventsByArea.has(areaId)) eventsByArea.set(areaId, []);
    eventsByArea.get(areaId).push(e);
  }

  // Every active area gets a doc even with zero traffic (a real "0" day is
  // still data, distinct from "this area didn't exist yet"), plus any area
  // that has traffic but wasn't in the active list for some reason (e.g. a
  // deactivated area with historical data still needs its doc written).
  const areaIds = new Set(areas.map((a) => a.id));
  for (const areaId of sessionsByArea.keys()) areaIds.add(areaId);
  for (const areaId of eventsByArea.keys()) areaIds.add(areaId);
  if (areaIds.size === 0) areaIds.add(AREA_ID_FALLBACK);

  const results = [];
  for (const areaId of areaIds) {
    const stats = {
      areaId,
      date: dateStr,
      ...computeStatsForDocs(sessionsByArea.get(areaId) || [], eventsByArea.get(areaId) || []),
    };

    await dailyCol.updateOne(
      { areaId, date: dateStr },
      {
        $set: { ...stats, createdAt: new Date() },
        $setOnInsert: { areaId, date: dateStr },
      },
      { upsert: true }
    );

    results.push(stats);
  }

  return results;
};

/**
 * Milliseconds until the next 00:05 local time.
 */
const msUntilNextRun = (now = new Date()) => {
  const next = new Date(now);
  next.setHours(ROLLOUT_HOUR, ROLLOUT_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
};

/**
 * Backfill yesterday if it's missing a doc for any currently-active area
 * (called on startup). Compares doc count to active-area count rather than
 * a single findOne — a new area added after yesterday's rollup already ran
 * must still get its own doc, not be skipped because area 1's already exists.
 * computeDailyStats itself is a pure upsert either way, so re-running it for
 * a date that's already fully backfilled is a safe no-op, just wasted work.
 */
const backfillYesterday = async () => {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = toLocalDateStr(yesterday);
    const db = getDb();
    const [existingCount, activeAreas] = await Promise.all([
      db.collection('analytics_daily').countDocuments({ date: dateStr }),
      listAreas({ activeOnly: true }),
    ]);
    if (existingCount < Math.max(activeAreas.length, 1)) {
      await computeDailyStats(dateStr, db);
      console.log(`[analytics-rollup] backfilled yesterday (${dateStr})`);
    }
  } catch (error) {
    console.error('[analytics-rollup] backfillYesterday failed:', error.message);
  }
};

let rollupTimer = null;

/**
 * Schedule the daily rollup at 00:05 in-process (no node-cron). On startup,
 * also backfill yesterday. The timer is unref()'d so it doesn't keep the
 * process alive on graceful shutdown.
 */
const startRollupScheduler = () => {
  // Backfill yesterday on startup (fire-and-forget).
  backfillYesterday().catch(() => {});

  const scheduleNext = () => {
    const ms = msUntilNextRun();
    rollupTimer = setTimeout(async () => {
      try {
        // Roll up yesterday (the day that just ended).
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = toLocalDateStr(yesterday);
        await computeDailyStats(dateStr);
        console.log(`[analytics-rollup] computed daily stats for ${dateStr}`);
      } catch (error) {
        console.error('[analytics-rollup] scheduled run failed:', error.message);
      }
      scheduleNext();
    }, ms);
    rollupTimer.unref();
  };
  scheduleNext();
};

const stopRollupScheduler = () => {
  if (rollupTimer) {
    clearTimeout(rollupTimer);
    rollupTimer = null;
  }
};

module.exports = { computeDailyStats, startRollupScheduler, stopRollupScheduler, msUntilNextRun };
