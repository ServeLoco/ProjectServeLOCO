// Analytics controller — customer event ingestion + admin analytics endpoints.
// All Mongo reads/writes are fire-and-forget (Rule 7). If Mongo is down, the
// customer endpoint still returns 202 with accepted:0; admin endpoints return
// empty/default data rather than 500.

const { getDb } = require('../db/mongodb');
const { pool } = require('../db/mysql');
const { insertEvents } = require('../services/analytics/eventStore');
const { requestAreaId, listAreas } = require('../utils/areaScope');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

const clampDays = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
};

const dateRange = (days) => {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
};

// Local-timezone YYYY-MM-DD, matching how analytics_daily.date is written by
// the rollup job (toISOString() would shift to UTC and mis-align the range).
const toLocalDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Safely get a Mongo collection — returns null if Mongo isn't connected so
// callers can short-circuit to empty data without throwing.
const safeCollection = (name) => {
  try { return getDb().collection(name); } catch (_) { return null; }
};

// Every admin analytics endpoint is scoped to one area unless a super_admin
// explicitly opts into X-Area-Id: all (§2.10 — Analytics is one of the pages
// that accepts 'all', unlike Settings/Delivery Zones/Store Modes). No silent
// default: a super_admin with no header gets a 400, same as shops/riders'
// requireOneArea and adminController's notification endpoints.
const resolveAreaOrAll = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action (pass a specific area, or "all")' });
    return undefined;
  }
  return areaId;
};

// Mongo $match fragment for one area, or {} to match every area.
const areaMatch = (areaId) => (areaId === 'all' ? {} : { areaId });

// Attaches areaCode to each row of a Mongo aggregation result that was
// grouped by areaId (only meaningful in 'all' mode — §2.10's "areaCode/
// area_code column added to each row"). One cached list avoids N lookups on
// a cold cache for a report with many grouped rows.
const withAreaCodes = async (rows, areaIdField = 'areaId') => {
  const areasById = new Map((await listAreas()).map((area) => [Number(area.id), area]));
  return rows.map((row) => {
    const area = areasById.get(Number(row[areaIdField]));
    return { ...row, areaCode: area?.code || null, area_code: area?.code || null };
  });
};

// ── Customer: POST /api/analytics/events ──────────────────────────────────
const postEvents = async (req, res) => {
  const userId = req.user?.id;
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  // req.areaId comes from resolveCustomerArea on this route (§9.5/§4.2:
  // pin → users.last_area_id → default area).
  const accepted = await insertEvents(userId, events, req.areaId);
  res.status(202).json({ accepted });
};

// ── Admin: GET summary?days=30 ────────────────────────────────────────────
const getSummary = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const days = clampDays(req.query.days);
  const { start } = dateRange(days);
  let daily = [];
  try {
    const col = safeCollection('analytics_daily');
    if (col) {
      if (areaId === 'all') {
        // Cross-area roll-up: sum each date's per-area docs into one
        // combined row (§2.10). Approximate for `visitors` the same way
        // last_area_id-based broadcast targeting is approximate (H6) — a
        // user active in two areas the same day is counted in both areas'
        // per-day distinct-visitor figures, so the summed total can be a
        // slight overcount rather than a true cross-area distinct count.
        daily = await col.aggregate([
          { $match: { date: { $gte: toLocalDateStr(start) } } },
          { $group: {
            _id: '$date',
            visitors: { $sum: '$visitors' },
            sessions: { $sum: '$sessions' },
            orders: { $sum: '$orders' },
            cartAdds: { $sum: '$cartAdds' },
            cartRemoves: { $sum: '$cartRemoves' },
            windowShoppers: { $sum: '$windowShoppers' },
          } },
          { $project: { _id: 0, date: '$_id', visitors: 1, sessions: 1, orders: 1, cartAdds: 1, cartRemoves: 1, windowShoppers: 1 } },
          { $sort: { date: 1 } },
        ]).toArray();
      } else {
        const docs = await col.find({ date: { $gte: toLocalDateStr(start) }, areaId })
          .sort({ date: 1 }).toArray();
        daily.push(...docs);
      }
    }
  } catch (_) { /* fire-and-forget */ }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let today = { visitors: 0, sessions: 0, orders: 0, cartAdds: 0, cartRemoves: 0, conversionPct: 0 };
  try {
    const sessionsCol = safeCollection('analytics_sessions');
    const eventsCol = safeCollection('analytics_events');
    if (sessionsCol) {
      const a = await sessionsCol.aggregate([
        { $match: { connectedAt: { $gte: todayStart }, ...areaMatch(areaId) } },
        { $group: { _id: null, sessions: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      ]).toArray();
      if (a[0]) { today.sessions = a[0].sessions || 0; today.visitors = (a[0].users || []).length; }
    }
    if (eventsCol) {
      const a = await eventsCol.aggregate([
        { $match: { createdAt: { $gte: todayStart }, ...areaMatch(areaId) } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]).toArray();
      for (const r of a) {
        if (r._id === 'cart_add') today.cartAdds = r.count;
        if (r._id === 'cart_remove') today.cartRemoves = r.count;
        if (r._id === 'order_placed') today.orders = r.count;
      }
    }
    if (today.visitors > 0) today.conversionPct = Math.round((today.orders / today.visitors) * 1000) / 10;
  } catch (_) { /* fire-and-forget */ }
  res.status(200).json({ daily, today });
};

// ── Admin: GET products?days=30 ───────────────────────────────────────────
const getProducts = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const days = clampDays(req.query.days);
  const { start } = dateRange(days);
  let rows = [];
  try {
    const col = safeCollection('analytics_events');
    if (col) {
      rows = await col.aggregate([
        { $match: { createdAt: { $gte: start }, type: { $in: ['cart_add', 'cart_remove', 'product_view'] }, ...areaMatch(areaId) } },
        { $group: { _id: { productId: '$productId', type: '$type' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray();
    }
  } catch (_) { /* fire-and-forget */ }

  const productIds = [...new Set(rows.map(r => r._id.productId).filter(Number.isFinite))];
  const nameMap = {};
  if (productIds.length > 0) {
    try {
      const [pr] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [productIds]);
      for (const p of pr) nameMap[p.id] = p.name;
    } catch (_) { /* fire-and-forget */ }
  }
  const bucket = (type) => rows
    .filter(r => r._id.type === type)
    .map(r => ({ productId: r._id.productId, name: nameMap[r._id.productId] || null, count: r.count }))
    .slice(0, 10);
  res.status(200).json({ topAdded: bucket('cart_add'), topRemoved: bucket('cart_remove'), topViewed: bucket('product_view') });
};

// ── Admin: GET window-shoppers?days=7 ─────────────────────────────────────
const getWindowShoppers = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const days = clampDays(req.query.days || 7);
  const { start } = dateRange(days);
  let aggRows = [];
  try {
    const col = safeCollection('analytics_events');
    if (col) {
      aggRows = await col.aggregate([
        { $match: { createdAt: { $gte: start }, type: { $in: ['cart_add', 'cart_remove', 'order_placed'] }, ...areaMatch(areaId) } },
        { $group: { _id: '$userId',
          cartAdds: { $sum: { $cond: [{ $eq: ['$type', 'cart_add'] }, 1, 0] } },
          cartRemoves: { $sum: { $cond: [{ $eq: ['$type', 'cart_remove'] }, 1, 0] } },
          orders: { $sum: { $cond: [{ $eq: ['$type', 'order_placed'] }, 1, 0] } },
          lastActiveAt: { $max: '$createdAt' } } },
        { $match: { cartAdds: { $gt: 0 }, orders: 0 } },
        { $sort: { cartAdds: -1 } },
      ]).toArray();
    }
  } catch (_) { /* fire-and-forget */ }

  const userIds = aggRows.map(r => r._id).filter(Number.isFinite);
  const userMap = {};
  if (userIds.length > 0) {
    try {
      const [ur] = await pool.query('SELECT id, name, phone FROM users WHERE id IN (?)', [userIds]);
      for (const u of ur) userMap[u.id] = u;
    } catch (_) { /* fire-and-forget */ }
  }
  const data = aggRows.map(r => ({
    userId: r._id, name: userMap[r._id]?.name || null, phone: userMap[r._id]?.phone || null,
    lastActiveAt: r.lastActiveAt, cartAdds: r.cartAdds, cartRemoves: r.cartRemoves,
  }));
  res.status(200).json({ data });
};

// ── Admin: GET user/:id?days=30 ───────────────────────────────────────────
// Deliberately NOT area-scoped: a user's own activity history is a global
// identity concern (§2.2), same reasoning TASK 13 applied to a customer's
// own order history — an admin drilling into a specific already-known
// userId should see that person's full activity, not have it silently
// truncated to whichever area happens to be selected right now.
const getUserDrillDown = async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId)) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Invalid user id' });
  const days = clampDays(req.query.days);
  const { start } = dateRange(days);

  let userRow = null;
  try {
    const [rows] = await pool.query('SELECT id, name, phone, created_at as joinedAt FROM users WHERE id = ?', [userId]);
    userRow = rows[0];
  } catch (_) { /* fire-and-forget */ }
  if (!userRow) return res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });

  let orders = 0;
  try {
    const [or] = await pool.query('SELECT COUNT(*) as orderCount FROM orders WHERE customer_id = ?', [userId]);
    orders = or[0]?.orderCount || 0;
  } catch (_) { /* fire-and-forget */ }

  let sessions = [], sessionCount = 0;
  try {
    const col = safeCollection('analytics_sessions');
    if (col) {
      sessionCount = await col.countDocuments({ userId });
      sessions = await col.find({ userId }).sort({ connectedAt: -1 }).limit(50).toArray();
    }
  } catch (_) { /* fire-and-forget */ }

  let timeline = [], cartAdds = 0, cartRemoves = 0;
  try {
    const col = safeCollection('analytics_events');
    if (col) {
      const ta = await col.aggregate([
        { $match: { userId, createdAt: { $gte: start } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
      ]).toArray();
      for (const t of ta) { if (t._id === 'cart_add') cartAdds = t.count; if (t._id === 'cart_remove') cartRemoves = t.count; }
      timeline = await col.find({ userId }).sort({ at: -1, createdAt: -1 }).limit(200).toArray();
    }
  } catch (_) { /* fire-and-forget */ }

  const productIds = [...new Set(timeline.map(e => e.productId).filter(Number.isFinite))];
  const nameMap = {};
  if (productIds.length > 0) {
    try {
      const [pr] = await pool.query('SELECT id, name FROM products WHERE id IN (?)', [productIds]);
      for (const p of pr) nameMap[p.id] = p.name;
    } catch (_) { /* fire-and-forget */ }
  }
  const cleanTimeline = timeline.map(e => ({
    at: e.at || e.createdAt, type: e.type, productId: e.productId || null,
    productName: e.productId ? (nameMap[e.productId] || null) : null, qty: e.qty || null, orderId: e.orderId || null,
  }));
  const totalTimeSec = sessions.reduce((s, x) => s + (x.durationSec || 0), 0);
  const avgSessionSec = sessions.length > 0 ? Math.round(totalTimeSec / sessions.length) : 0;

  res.status(200).json({
    user: { id: userRow.id, name: userRow.name, phone: userRow.phone, joinedAt: userRow.joinedAt },
    totals: { sessions: sessionCount, totalTimeSec, avgSessionSec, orders, cartAdds, cartRemoves },
    sessions: sessions.map(s => ({ connectedAt: s.connectedAt, durationSec: s.durationSec || 0, platform: s.platform || null, screens: s.screens || {} })),
    timeline: cleanTimeline,
  });
};

// ── Admin: GET hourly?days=14 ─────────────────────────────────────────────
const getHourly = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const days = clampDays(req.query.days || 14);
  const { start } = dateRange(days);
  let docs = [];
  try {
    const col = safeCollection('analytics_daily');
    if (col) {
      if (areaId === 'all') {
        // Cross-area roll-up: sum each date's per-area hourlyActive arrays
        // element-wise (same approximate-distinct caveat as getSummary).
        const perAreaDocs = await col.find({ date: { $gte: toLocalDateStr(start) } })
          .sort({ date: 1 }).toArray();
        const byDate = new Map();
        for (const d of perAreaDocs) {
          const hourly = d.hourlyActive || new Array(24).fill(0);
          if (!byDate.has(d.date)) byDate.set(d.date, new Array(24).fill(0));
          const acc = byDate.get(d.date);
          for (let h = 0; h < 24; h++) acc[h] += hourly[h] || 0;
        }
        docs = [...byDate.entries()].map(([date, hourlyActive]) => ({ date, hourlyActive }));
      } else {
        docs = await col.find({ date: { $gte: toLocalDateStr(start) }, areaId }).sort({ date: 1 }).toArray();
      }
    }
  } catch (_) { /* fire-and-forget */ }
  const daysData = docs.map(d => ({ date: d.date, hourlyActive: d.hourlyActive || new Array(24).fill(0) }));
  res.status(200).json({ days: daysData });
};

// ── Admin: GET active-users?minutes=60&search=xyz ─────────────────────────
// Users whose session started within the last N minutes (i.e. "opened the
// app in the last hour/day/etc"), optionally narrowed by name/phone.
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 30 * 24 * 60; // 30 days

const clampMinutes = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_WINDOW_MINUTES) return 60;
  return Math.min(n, MAX_WINDOW_MINUTES);
};

const getActiveUsers = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const minutes = clampMinutes(req.query.minutes);
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const search = String(req.query.search || '').trim();

  let aggRows = [];
  try {
    const col = safeCollection('analytics_sessions');
    if (col) {
      aggRows = await col.aggregate([
        { $match: { connectedAt: { $gte: cutoff }, ...areaMatch(areaId) } },
        { $group: {
          _id: '$userId',
          sessions: { $sum: 1 },
          lastActiveAt: { $max: '$connectedAt' },
          platform: { $last: '$platform' },
          areaId: { $last: '$areaId' },
        } },
        { $sort: { lastActiveAt: -1 } },
        { $limit: 200 },
      ]).toArray();
    }
  } catch (_) { /* fire-and-forget */ }

  const userIds = aggRows.map(r => r._id).filter(Number.isFinite);
  let userRows = [];
  if (userIds.length > 0) {
    try {
      let sql = 'SELECT id, name, phone FROM users WHERE id IN (?)';
      const params = [userIds];
      if (search) {
        sql += ' AND (name LIKE ? OR phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }
      const [rows] = await pool.query(sql, params);
      userRows = rows;
    } catch (_) { /* fire-and-forget */ }
  }

  const userMap = {};
  for (const u of userRows) userMap[u.id] = u;

  let data = aggRows
    .filter(r => userMap[r._id])
    .map(r => ({
      userId: r._id,
      name: userMap[r._id].name,
      phone: userMap[r._id].phone,
      lastActiveAt: r.lastActiveAt,
      sessions: r.sessions,
      platform: r.platform || null,
      areaId: r.areaId ?? null,
    }));

  if (areaId === 'all') {
    data = await withAreaCodes(data);
  }

  res.status(200).json({ data, minutes });
};

module.exports = { postEvents, getSummary, getProducts, getWindowShoppers, getUserDrillDown, getHourly, getActiveUsers };
