/**
 * Peak-hour dispatch simulation: many orders confirmed at once, several
 * riders online — who actually gets which order.
 *
 * Unlike riderAssignment.test.js (canned per-call mock queues), this file
 * runs the REAL engine (services/riderAssignment + utils/riders) against a
 * small stateful in-memory stand-in for MySQL, so every step sees the state
 * the previous step wrote: an offer created for order 101 really does remove
 * that rider from order 102's eligible pool, and an accept really does bump
 * the rider's active-order count.
 *
 * World (area 1 unless stated), all distances from Shop A:
 *   R1  0.11 km, 4 delivered today
 *   R2  0.56 km, 1 delivered today
 *   R3  1.44 km, 0 delivered today
 *   R4  2.78 km, 0 delivered today
 *   R5  0.06 km  — area 2        (must never be offered an area-1 order)
 *   R6  0.06 km  — offline       (must never be offered)
 *   R7  0.02 km  — 2 active orders = RIDER_MAX_ACTIVE_ORDERS (must be capped out)
 */

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));

jest.mock('../src/realtime/socket', () => ({
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));

jest.mock('../src/utils/expoPush', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
  sendPushToMany: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/utils/fcmAlarmPush', () => ({
  sendFcmDataOnlyToUser: jest.fn().mockResolvedValue({ sent: true }),
  sendFcmDataOnlyToMany: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: {
    RIDER_ASSIGNMENT_FAILED: 'rider_assignment_failed',
    RIDER_ZERO_AVAILABLE: 'rider_zero_available',
    ORDER_CANCELLED_NO_RIDER: 'order_cancelled_no_rider',
  },
  createAdminNotification: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/realtime/orderEvents', () => ({
  emitOrderStatusUpdated: jest.fn(),
  emitNotificationCreated: jest.fn(),
}));

jest.mock('../src/utils/shops', () => ({
  notifyShopsOrderCancelled: jest.fn(),
  notifyShopsRiderAssigned: jest.fn(),
  notifyShopsRiderAssignmentFailed: jest.fn(),
  syncAreaShopOpenState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));

const { pool } = require('../src/db/mysql');
const assignment = require('../src/services/riderAssignment');
const { emitToCustomer } = require('../src/realtime/socket');
const { RIDER_MAX_ACTIVE_ORDERS } = require('../src/utils/riders');

// ---------------------------------------------------------------------------
// Stateful fake MySQL
// ---------------------------------------------------------------------------

let db;

const resetDb = () => {
  db = {
    riders: [],
    orders: [],
    orderItems: [],
    shops: [],
    offers: [],
    nextOfferId: 1,
  };
};

const activeOrdersOf = (riderId) => db.orders.filter(
  (o) => Number(o.rider_id) === Number(riderId)
    && o.status !== 'Delivered' && o.status !== 'Cancelled'
).length;

// The fake treats every Delivered row as delivered today — the real query's
// CONVERT_TZ day-boundary logic is not what these scenarios exercise.
const completedTodayOf = (riderId) => db.orders.filter(
  (o) => Number(o.rider_id) === Number(riderId) && o.status === 'Delivered'
).length;

const hasPendingOffer = (riderId) => db.offers.some(
  (o) => Number(o.rider_id) === Number(riderId) && o.status === 'pending'
);

function runQuery(sql, params = []) {
  const q = String(sql).replace(/\s+/g, ' ').trim();
  const p = Array.isArray(params) ? params : [params];

  // ---- rider_order_offers -------------------------------------------------
  if (/^SELECT rider_id FROM rider_order_offers WHERE order_id = \?/.test(q)) {
    return [db.offers.filter((o) => o.order_id === Number(p[0]))
      .map((o) => ({ rider_id: o.rider_id }))];
  }
  if (/^SELECT id FROM rider_order_offers WHERE order_id = \? AND status = 'pending'/.test(q)) {
    return [db.offers.filter((o) => o.order_id === Number(p[0]) && o.status === 'pending')
      .map((o) => ({ id: o.id }))];
  }
  if (/^SELECT \* FROM rider_order_offers WHERE id = \?/.test(q)) {
    return [db.offers.filter((o) => o.id === Number(p[0])).map((o) => ({ ...o }))];
  }
  if (/is_expired FROM rider_order_offers/.test(q)) {
    const o = db.offers.find((x) => x.id === Number(p[0]));
    return [[{ is_expired: o && new Date(o.expires_at) <= new Date() ? 1 : 0 }]];
  }
  if (/^INSERT INTO rider_order_offers/.test(q)) {
    const [orderId, riderId, expiresAt] = p;
    const dup = (key) => {
      const err = new Error(`Duplicate entry for key 'rider_order_offers.${key}'`);
      err.code = 'ER_DUP_ENTRY';
      return err;
    };
    // The three unique keys the real table carries. pending_order_id and
    // pending_rider_id are generated columns that are NULL unless the row is
    // pending, so only pending rows collide.
    if (db.offers.some((o) => o.order_id === Number(orderId) && o.rider_id === Number(riderId))) {
      throw dup('uq_offer_order_rider');
    }
    if (db.offers.some((o) => o.status === 'pending' && o.order_id === Number(orderId))) {
      throw dup('uq_offer_pending_order');
    }
    if (db.offers.some((o) => o.status === 'pending' && o.rider_id === Number(riderId))) {
      throw dup('uq_offer_pending_rider');
    }
    const row = {
      id: db.nextOfferId++,
      order_id: Number(orderId),
      rider_id: Number(riderId),
      status: 'pending',
      expires_at: expiresAt,
      responded_at: null,
      reject_reason: null,
    };
    db.offers.push(row);
    return [{ insertId: row.id, affectedRows: 1 }];
  }
  if (/^UPDATE rider_order_offers SET status = '(\w+)'/.test(q)) {
    const status = q.match(/^UPDATE rider_order_offers SET status = '(\w+)'/)[1];
    const byOrder = /WHERE order_id = \?/.test(q);
    // The id is always the LAST placeholder — reject_reason binds before it.
    const target = Number(p[p.length - 1]);
    const targets = byOrder
      ? db.offers.filter((o) => o.order_id === target && o.status === 'pending')
      : db.offers.filter((o) => o.id === target && o.status === 'pending');
    for (const o of targets) {
      o.status = status;
      o.responded_at = new Date();
    }
    return [{ affectedRows: targets.length }];
  }

  // ---- orders -------------------------------------------------------------
  if (/^SELECT \* FROM orders WHERE id = \?/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[0]));
    return [o ? [{ ...o }] : []];
  }
  if (/rider_search_started_at IS NOT NULL AS stamped/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[1]));
    if (!o) return [[]];
    const windowSec = Number(p[0]);
    const stamped = o.rider_search_started_at != null;
    const open = stamped
      && (Date.now() - new Date(o.rider_search_started_at).getTime()) < windowSec * 1000;
    return [[{ stamped: stamped ? 1 : 0, open: open ? 1 : 0 }]];
  }
  if (/^UPDATE orders SET rider_assignment_status = 'searching'/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[0]));
    if (o) {
      o.rider_assignment_status = 'searching';
      if (o.rider_search_started_at == null) o.rider_search_started_at = new Date();
    }
    return [{ affectedRows: o ? 1 : 0 }];
  }
  if (/^UPDATE orders SET rider_assignment_status = 'offered'/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[0]));
    if (o) o.rider_assignment_status = 'offered';
    return [{ affectedRows: o ? 1 : 0 }];
  }
  if (/^UPDATE orders SET rider_id = \?, rider_assigned_at = NOW\(\), rider_assignment_status = 'assigned'/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[1]));
    if (o) {
      o.rider_id = Number(p[0]);
      o.rider_assigned_at = new Date();
      o.rider_assignment_status = 'assigned';
    }
    return [{ affectedRows: o ? 1 : 0 }];
  }
  if (/^UPDATE orders SET rider_assignment_status = 'failed'/.test(q)) {
    const o = db.orders.find((r) => r.id === Number(p[0]));
    if (o) o.rider_assignment_status = 'failed';
    return [{ affectedRows: o ? 1 : 0 }];
  }

  // ---- riders -------------------------------------------------------------
  if (/FROM riders r/.test(q) && /NOT EXISTS/.test(q)) {
    const maxAgeSec = Number(p[0]);
    const areaId = Number(p[1]);
    const maxActive = Number(p[2]);
    const exclude = p.slice(3).map(Number);
    const rows = db.riders.filter((r) => r.active === 1
      && r.is_online === 1
      && Number(r.area_id) === areaId
      && !hasPendingOffer(r.id)
      && activeOrdersOf(r.id) < maxActive
      && !exclude.includes(Number(r.id)));
    return [rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      display_name: r.display_name,
      phone: r.phone,
      active: r.active,
      is_online: r.is_online,
      last_lat: r.last_lat,
      last_lng: r.last_lng,
      location_fresh: (r.last_lat != null && r.last_lng != null
        && r.location_age_sec != null && r.location_age_sec < maxAgeSec) ? 1 : 0,
    }))];
  }
  if (/^SELECT user_id FROM riders WHERE id = \?/.test(q)) {
    const r = db.riders.find((x) => x.id === Number(p[0]));
    return [r ? [{ user_id: r.user_id }] : []];
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM riders r/.test(q)) {
    const areaId = Number(p[0]);
    return [[{ cnt: db.riders.filter((r) => r.active === 1 && r.is_online === 1
      && Number(r.area_id) === areaId).length }]];
  }

  // ---- batch counts -------------------------------------------------------
  if (/^SELECT rider_id, COUNT\(\*\) AS cnt FROM orders/.test(q)) {
    const isActive = /NOT IN \('Delivered', 'Cancelled'\)/.test(q);
    const ids = (isActive ? p : p.slice(0, -2)).map(Number);
    return [ids
      .map((id) => ({ rider_id: id, cnt: isActive ? activeOrdersOf(id) : completedTodayOf(id) }))
      .filter((row) => row.cnt > 0)];
  }

  // ---- order_items / shops ------------------------------------------------
  if (/FROM order_items oi/.test(q) && /JOIN shops s/.test(q)) {
    const items = db.orderItems.filter((it) => it.order_id === Number(p[0])
      && it.shop_id != null && it.shop_rejected_at == null);
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const shop = db.shops.find((s) => s.id === it.shop_id);
      if (!shop || shop.latitude == null || shop.longitude == null) continue;
      const key = `${shop.latitude},${shop.longitude}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ latitude: shop.latitude, longitude: shop.longitude });
    }
    return [out];
  }
  if (/^SELECT shop_id, shop_confirmed_at, shop_rejected_at FROM order_items/.test(q)) {
    return [db.orderItems.filter((it) => it.order_id === Number(p[0])).map((it) => ({ ...it }))];
  }

  // ---- misc ---------------------------------------------------------------
  if (/DATE_ADD\(NOW\(\), INTERVAL \? SECOND\) AS e/.test(q)) {
    return [[{ e: new Date(Date.now() + Number(p[0]) * 1000) }]];
  }
  if (/FROM settings/.test(q)) {
    return [[{ delivery_available: 1 }]];
  }
  if (/^UPDATE settings/.test(q)) {
    return [{ affectedRows: 0 }];
  }

  throw new Error(`fake-db: unhandled query: ${q}`);
}

// Async on purpose: every await point is a real interleaving point, which is
// what the concurrent-burst test below depends on.
const asyncQuery = async (sql, params) => {
  await new Promise((r) => setImmediate(r));
  return runQuery(sql, params);
};

const wireFakeDb = () => {
  pool.query.mockImplementation(asyncQuery);
  pool.getConnection.mockImplementation(async () => ({
    query: jest.fn(asyncQuery),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  }));
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP_A = { id: 1, latitude: 12.9, longitude: 77.6 };

const rider = (id, { lat, area = 1, online = 1, ageSec = 30 }) => ({
  id,
  user_id: 10 + id,
  display_name: `R${id}`,
  phone: `900000000${id}`,
  active: 1,
  is_online: online,
  area_id: area,
  last_lat: lat,
  last_lng: 77.6,
  location_age_sec: ageSec,
});

const order = (id, { area = 1, status = 'Accepted' } = {}) => ({
  id,
  order_number: `A${id}`,
  area_id: area,
  customer_id: 900 + id,
  status,
  rider_id: null,
  rider_assigned_at: null,
  rider_assignment_status: 'none',
  rider_search_started_at: null,
  total: 500,
  created_at: new Date(),
});

const seedPeakWorld = () => {
  resetDb();
  db.shops.push(SHOP_A);

  // 0.0010 deg lat ~= 0.11 km, 0.0050 ~= 0.56, 0.0130 ~= 1.44, 0.0250 ~= 2.78
  db.riders.push(
    rider(1, { lat: 12.901 }),
    rider(2, { lat: 12.905 }),
    rider(3, { lat: 12.913 }),
    rider(4, { lat: 12.925 }),
    rider(5, { lat: 12.9006, area: 2 }),
    rider(6, { lat: 12.9006, online: 0 }),
    rider(7, { lat: 12.9002 })
  );

  // Delivered history — R1 has done 4 today, R2 one, R3/R4 none.
  let histId = 500;
  for (let i = 0; i < 4; i += 1) {
    db.orders.push({ ...order(histId += 1), status: 'Delivered', rider_id: 1 });
  }
  db.orders.push({ ...order(histId += 1), status: 'Delivered', rider_id: 2 });

  // R7 is already carrying RIDER_MAX_ACTIVE_ORDERS live deliveries.
  for (let i = 0; i < RIDER_MAX_ACTIVE_ORDERS; i += 1) {
    db.orders.push({
      ...order(histId += 1), status: 'Out for Delivery', rider_id: 7, rider_assignment_status: 'assigned',
    });
  }

  // The peak burst: six orders, all picked up from Shop A.
  for (const id of [101, 102, 103, 104, 105, 106]) {
    db.orders.push(order(id));
    db.orderItems.push({
      order_id: id, shop_id: SHOP_A.id, shop_confirmed_at: new Date(), shop_rejected_at: null,
    });
  }
};

const offerMap = () => {
  const out = {};
  for (const o of db.offers) {
    if (o.status === 'pending') out[o.order_id] = o.rider_id;
  }
  return out;
};

const pendingOfferFor = (orderId) => db.offers.find(
  (o) => o.order_id === orderId && o.status === 'pending'
);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  seedPeakWorld();
  wireFakeDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('peak burst — which order goes to which rider', () => {
  it('fans four simultaneous orders out to four distinct riders, nearest ring first', async () => {
    const results = [];
    for (const id of [101, 102, 103, 104]) {
      results.push(await assignment.maybeStartRiderAssignment(id));
    }

    expect(results.map((r) => r.riderId)).toEqual([2, 1, 3, 4]);
    expect(offerMap()).toEqual({ 101: 2, 102: 1, 103: 3, 104: 4 });

    // 101: ring 1 (<=1 km) holds R1 (0.11 km, 4 done) and R2 (0.56 km, 1 done).
    // Both are free, so the tie breaks on least-delivered-today -> R2, NOT the
    // physically closest rider. Distance picks the ring, not the winner.
    // 102: R2 now holds a pending offer, so ring 1 leaves only R1.
    // 103: ring 1 exhausted -> ring 2 (R3). 104: ring 3 (R4).
    for (const id of [101, 102, 103, 104]) {
      expect(db.orders.find((o) => o.id === id).rider_assignment_status).toBe('offered');
    }
  });

  it('never offers to an offline rider, an other-area rider, or a rider at the active-order cap', async () => {
    for (const id of [101, 102, 103, 104, 105, 106]) {
      await assignment.maybeStartRiderAssignment(id);
    }
    const offered = new Set(db.offers.map((o) => o.rider_id));
    expect(offered.has(5)).toBe(false); // area 2
    expect(offered.has(6)).toBe(false); // offline
    expect(offered.has(7)).toBe(false); // at RIDER_MAX_ACTIVE_ORDERS
    expect([...offered].sort()).toEqual([1, 2, 3, 4]);
  });

  it('holds the 5th and 6th order in searching (no rider free, still inside the search window)', async () => {
    for (const id of [101, 102, 103, 104]) {
      await assignment.maybeStartRiderAssignment(id);
    }

    const fifth = await assignment.maybeStartRiderAssignment(105);
    expect(fifth).toMatchObject({ started: true, waiting: true, reason: 'waiting_for_riders' });
    expect(pendingOfferFor(105)).toBeUndefined();
    expect(db.orders.find((o) => o.id === 105).rider_assignment_status).toBe('searching');

    // Re-scan (what the 5s sweeper does) still finds nobody, and must NOT fail
    // the order while the search window is open.
    const rescan = await assignment.continueAssignment(105);
    expect(rescan).toMatchObject({ continued: false, waiting: true, failed: false });
    expect(db.orders.find((o) => o.id === 105).rider_assignment_status).toBe('searching');
  });

  it('gives the overflow order to the first rider who accepts and frees their offer slot', async () => {
    for (const id of [101, 102, 103, 104]) {
      await assignment.maybeStartRiderAssignment(id);
    }
    await assignment.maybeStartRiderAssignment(105); // waiting

    // R2 accepts order 101. R2 now carries 1 active order but holds no pending
    // offer, so R2 re-enters the pool.
    const offer101 = pendingOfferFor(101);
    const accepted = await assignment.acceptOffer(offer101.id, 2);
    expect(accepted.ok).toBe(true);
    expect(db.orders.find((o) => o.id === 101).rider_id).toBe(2);

    const overflow = await assignment.continueAssignment(105);
    expect(overflow).toMatchObject({ continued: true, riderId: 2 });
    expect(offerMap()[105]).toBe(2);

    // The rider's app is told over their own user socket, not a rider room.
    expect(emitToCustomer).toHaveBeenCalledWith(
      12, 'rider.offer.created', expect.objectContaining({ orderId: 105, riderId: 2 })
    );
  });

  it('stops offering to a rider once accepting would exceed RIDER_MAX_ACTIVE_ORDERS', async () => {
    for (const id of [101, 102, 103, 104]) {
      await assignment.maybeStartRiderAssignment(id);
    }
    await assignment.acceptOffer(pendingOfferFor(101).id, 2);
    await assignment.continueAssignment(105);
    await assignment.acceptOffer(pendingOfferFor(105).id, 2);

    // R2 is now at the cap (101 + 105 both live).
    expect(activeOrdersOf(2)).toBe(RIDER_MAX_ACTIVE_ORDERS);

    const sixth = await assignment.maybeStartRiderAssignment(106);
    expect(sixth).toMatchObject({ waiting: true });
    expect(pendingOfferFor(106)).toBeUndefined();

    // ...and frees up again the moment one of them is delivered.
    db.orders.find((o) => o.id === 101).status = 'Delivered';
    const retry = await assignment.continueAssignment(106);
    expect(retry).toMatchObject({ continued: true, riderId: 2 });
  });

  it('a rejection widens the search to the next ring instead of re-offering the same rider', async () => {
    await assignment.maybeStartRiderAssignment(101); // -> R2 (ring 1)
    await assignment.rejectOffer(pendingOfferFor(101).id, 2, 'manual');

    // R2 is excluded for THIS order only; ring 1 still has R1.
    expect(offerMap()[101]).toBe(1);

    await assignment.rejectOffer(pendingOfferFor(101).id, 1, 'manual');
    expect(offerMap()[101]).toBe(3); // ring 2

    await assignment.rejectOffer(pendingOfferFor(101).id, 3, 'manual');
    expect(offerMap()[101]).toBe(4); // ring 3

    // Everyone eligible has now rejected -> order waits for admin/new riders,
    // and R2 (who rejected first) is never re-offered the same order.
    await assignment.rejectOffer(pendingOfferFor(101).id, 4, 'manual');
    expect(pendingOfferFor(101)).toBeUndefined();
    expect(db.offers.filter((o) => o.order_id === 101).map((o) => o.rider_id).sort())
      .toEqual([1, 2, 3, 4]);
  });
});

describe('concurrent burst (orders confirmed in the same tick)', () => {
  it('never double-books a rider — the loser steps to the next-best rider', async () => {
    resetDb();
    db.shops.push(SHOP_A);
    db.riders.push(rider(1, { lat: 12.901 }), rider(2, { lat: 12.905 }));
    for (const id of [101, 102, 103]) {
      db.orders.push(order(id));
      db.orderItems.push({
        order_id: id, shop_id: SHOP_A.id, shop_confirmed_at: new Date(), shop_rejected_at: null,
      });
    }
    wireFakeDb();

    await Promise.all([
      assignment.maybeStartRiderAssignment(101),
      assignment.maybeStartRiderAssignment(102),
      assignment.maybeStartRiderAssignment(103),
    ]);

    // uq_offer_pending_rider makes the double-book impossible at the DB, and
    // offerBestEligibleRider walks to the next rider when it loses the race —
    // so two riders end up carrying one offer each, not one rider carrying two.
    const pending = db.offers.filter((o) => o.status === 'pending');
    const riderIds = pending.map((o) => o.rider_id).sort();
    expect(new Set(riderIds).size).toBe(riderIds.length);
    expect(pending.length).toBeLessThanOrEqual(2);

    // Whichever order missed out is still searching, so the sweeper retries it.
    for (const id of [101, 102, 103]) {
      const o = db.orders.find((x) => x.id === id);
      if (!pending.some((p) => p.order_id === id)) {
        expect(o.rider_assignment_status).toBe('searching');
      }
    }
  });

  it('one free rider and two orders: exactly one offer, never two', async () => {
    resetDb();
    db.shops.push(SHOP_A);
    db.riders.push(rider(1, { lat: 12.901 }));
    for (const id of [101, 102]) {
      db.orders.push(order(id));
      db.orderItems.push({
        order_id: id, shop_id: SHOP_A.id, shop_confirmed_at: new Date(), shop_rejected_at: null,
      });
    }
    wireFakeDb();

    await Promise.all([
      assignment.maybeStartRiderAssignment(101),
      assignment.maybeStartRiderAssignment(102),
    ]);

    const pendingForR1 = db.offers.filter((o) => o.rider_id === 1 && o.status === 'pending');
    expect(pendingForR1).toHaveLength(1);
  });

  it('a full peak burst spreads across every rider without collisions', async () => {
    seedPeakWorld();
    wireFakeDb();

    await Promise.all(
      [101, 102, 103, 104, 105, 106].map((id) => assignment.maybeStartRiderAssignment(id))
    );

    const pending = db.offers.filter((o) => o.status === 'pending');
    const riderIds = pending.map((o) => o.rider_id);
    expect(new Set(riderIds).size).toBe(riderIds.length); // no rider twice
    expect(new Set(pending.map((o) => o.order_id)).size).toBe(pending.length); // no order twice
    expect(riderIds).not.toContain(5); // area 2
    expect(riderIds).not.toContain(6); // offline
    expect(riderIds).not.toContain(7); // at the active-order cap
  });
});
