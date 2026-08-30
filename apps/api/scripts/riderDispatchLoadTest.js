#!/usr/bin/env node
/**
 * Production-level rider dispatch load harness.
 *
 * Runs the REAL assignment engine, the REAL Express app and the REAL rider
 * HTTP routes against a REAL MySQL schema (migrate.js output) — no mocks, no
 * in-memory fakes. Answers, under peak conditions: which order goes to which
 * rider, how evenly the load spreads, what breaks when everything happens in
 * the same tick, and what each dispatch costs in DB round trips (which is the
 * number that matters in prod, where MySQL is a ~94 ms cross-region hop).
 *
 * SAFETY: refuses to run unless MYSQL_DATABASE contains "loadtest". It
 * TRUNCATEs orders/riders/users/shops, so it must never see a real database.
 *
 *   createdb once:
 *     mysql -e "CREATE DATABASE serveloco_loadtest"
 *     APP_ENV=development MYSQL_DATABASE=serveloco_loadtest node src/db/migrate.js
 *   run:
 *     APP_ENV=development MYSQL_DATABASE=serveloco_loadtest node scripts/riderDispatchLoadTest.js
 *
 * Flags: --orders=N --riders=N --port=N --skip-http
 */

process.env.APP_ENV = process.env.APP_ENV || 'development';

const config = require('../src/config/env');

if (!/loadtest/i.test(String(config.MYSQL_DATABASE || ''))) {
  console.error(`REFUSING TO RUN: MYSQL_DATABASE is "${config.MYSQL_DATABASE}".`);
  console.error('This harness truncates tables. Point it at a database whose name contains "loadtest".');
  process.exit(2);
}

const { pool } = require('../src/db/mysql');
const assignment = require('../src/services/riderAssignment');
const { calculateDistance } = require('../src/utils/deliveryPricing');
const { RIDER_MAX_ACTIVE_ORDERS, RIDER_SEARCH_RADIUS_TIERS_KM } = require('../src/utils/riders');
const { signCustomerToken } = require('../src/utils/auth');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const ORDER_COUNT = arg('orders', 40);
const RIDER_COUNT = arg('riders', 12);
const HTTP_PORT = arg('port', 3111);
const PROD_RTT_MS = 94; // Azure HK MySQL round trip measured from the Mumbai API box

// ---------------------------------------------------------------------------
// Query instrumentation — counts every round trip the engine makes.
// ---------------------------------------------------------------------------

const stats = { queries: 0, connections: 0, byTag: new Map() };
let tag = 'setup';
const setTag = (t) => { tag = t; stats.byTag.set(t, stats.byTag.get(t) || { queries: 0, ms: 0 }); };
const bump = (t, ms) => {
  const e = stats.byTag.get(t) || { queries: 0, ms: 0 };
  e.queries += 1; e.ms += ms;
  stats.byTag.set(t, e);
};

const rawQuery = pool.query.bind(pool);
const rawGetConnection = pool.getConnection.bind(pool);

pool.query = async (...args) => {
  const t0 = process.hrtime.bigint();
  try {
    return await rawQuery(...args);
  } finally {
    stats.queries += 1;
    bump(tag, Number(process.hrtime.bigint() - t0) / 1e6);
  }
};
pool.getConnection = async (...args) => {
  const conn = await rawGetConnection(...args);
  stats.connections += 1;
  const rawConnQuery = conn.query.bind(conn);
  conn.query = async (...qargs) => {
    const t0 = process.hrtime.bigint();
    try {
      return await rawConnQuery(...qargs);
    } finally {
      stats.queries += 1;
      bump(tag, Number(process.hrtime.bigint() - t0) / 1e6);
    }
  };
  return conn;
};

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const SHOPS = [
  { id: 1, name: 'Peak Shop A', latitude: 12.9, longitude: 77.6 },
  { id: 2, name: 'Peak Shop B', latitude: 12.915, longitude: 77.61 },
  { id: 3, name: 'Peak Shop C', latitude: 12.89, longitude: 77.59 },
];

// Rider ring layout around Shop A, in degrees of latitude (0.01 deg ~ 1.11 km).
const RIDER_LAYOUT = [
  // ring 1 (<= 1 km)
  { dLat: 0.001 }, { dLat: 0.003 }, { dLat: 0.005 }, { dLat: 0.008 },
  // ring 2 (<= 2 km)
  { dLat: 0.011 }, { dLat: 0.013 }, { dLat: 0.015 }, { dLat: 0.017 },
  // ring 3 (<= 3 km)
  { dLat: 0.021 }, { dLat: 0.024 },
  // out of every ring — only reachable in the distance-blind pass
  { dLat: 0.06 },
  // online but GPS is 2 h stale — matches no ring
  { dLat: 0.002, staleSec: 7200 },
];

const seedWorld = async ({ riderCount, orderCount }) => {
  setTag('seed');
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['rider_order_offers', 'order_items', 'orders', 'riders', 'shops']) {
    await pool.query(`TRUNCATE TABLE ${t}`);
  }
  await pool.query("DELETE FROM users WHERE phone LIKE '7770%'");
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  await pool.query(
    "INSERT INTO areas (id, code, name) VALUES (2, 'A2', 'Load Area 2') ON DUPLICATE KEY UPDATE name = VALUES(name)"
  );

  for (const s of SHOPS) {
    await pool.query(
      'INSERT INTO shops (id, name, area_id, latitude, longitude, is_open) VALUES (?, ?, 1, ?, ?, 1)',
      [s.id, s.name, s.latitude, s.longitude]
    );
  }

  // Customer who places every order.
  const [cust] = await pool.query(
    "INSERT INTO users (name, phone, last_area_id) VALUES ('Load Customer', '7770000000', 1)"
  );
  const customerId = cust.insertId;

  const riders = [];
  for (let i = 0; i < riderCount; i += 1) {
    const layout = RIDER_LAYOUT[i % RIDER_LAYOUT.length];
    const [u] = await pool.query(
      'INSERT INTO users (name, phone, last_area_id) VALUES (?, ?, 1)',
      [`Rider ${i + 1}`, `7770${String(i + 1).padStart(6, '0')}`]
    );
    const lat = SHOPS[0].latitude + layout.dLat;
    const staleSec = layout.staleSec || 30;
    const [r] = await pool.query(
      `INSERT INTO riders (user_id, display_name, phone, active, is_online, area_id,
                           last_lat, last_lng, last_location_at)
       VALUES (?, ?, ?, 1, 1, 1, ?, ?, NOW() - INTERVAL ? SECOND)`,
      [u.insertId, `Rider ${i + 1}`, `7770${String(i + 1).padStart(6, '0')}`, lat, SHOPS[0].longitude, staleSec]
    );
    riders.push({
      id: r.insertId,
      userId: u.insertId,
      name: `R${i + 1}`,
      lat,
      lng: SHOPS[0].longitude,
      stale: staleSec > 600,
      distanceKm: calculateDistance(lat, SHOPS[0].longitude, SHOPS[0].latitude, SHOPS[0].longitude),
    });
  }

  // Control riders that must never receive an area-1 offer.
  const decoys = [];
  const addDecoy = async (label, { area = 1, online = 1 }) => {
    const [u] = await pool.query(
      'INSERT INTO users (name, phone, last_area_id) VALUES (?, ?, ?)',
      [label, `77709${String(decoys.length).padStart(5, '0')}`, area]
    );
    const [r] = await pool.query(
      `INSERT INTO riders (user_id, display_name, phone, active, is_online, area_id,
                           last_lat, last_lng, last_location_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, NOW())`,
      [u.insertId, label, `77709${String(decoys.length).padStart(5, '0')}`, online, area,
        SHOPS[0].latitude + 0.0004, SHOPS[0].longitude]
    );
    decoys.push({ id: r.insertId, label });
  };
  await addDecoy('Area2 Rider A', { area: 2 });
  await addDecoy('Area2 Rider B', { area: 2 });
  await addDecoy('Offline Rider', { online: 0 });

  // Orders — every one shop-confirmed, ready for dispatch. 80 % from Shop A
  // (the peak-hour reality: one busy kitchen), the rest split across B and C.
  const orders = [];
  for (let i = 0; i < orderCount; i += 1) {
    const shop = i % 5 === 4 ? SHOPS[1 + (i % 2)] : SHOPS[0];
    const [o] = await pool.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, phone, address,
                           subtotal, delivery_charge, total, status, area_id,
                           rider_assignment_status)
       VALUES (?, ?, 'Load Customer', '7770000000', 'Peak Test Address', 300, 20, 320, 'Accepted', 1, 'none')`,
      [`LT${Date.now() % 100000}-${i + 1}`, customerId]
    );
    await pool.query(
      `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price,
                                line_total, area_id, shop_id, shop_confirmed_at)
       VALUES (?, 1, 'Load Item', 1, 300, 300, 1, ?, NOW())`,
      [o.insertId, shop.id]
    );
    orders.push({ id: o.insertId, shopId: shop.id });
  }

  return { customerId, riders, decoys, orders };
};

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

const snapshotOffers = async () => {
  const [rows] = await pool.query(
    `SELECT o.id, o.order_id, o.rider_id, o.status, ord.rider_assignment_status, ord.rider_id AS assigned_rider
     FROM rider_order_offers o JOIN orders ord ON ord.id = o.order_id
     ORDER BY o.id ASC`
  );
  return rows;
};

const ringOf = (km) => {
  if (km == null) return 'blind';
  for (const t of RIDER_SEARCH_RADIUS_TIERS_KM) if (km <= t) return `<=${t}km`;
  return 'blind';
};

const report = (title, lines) => {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
  for (const l of lines) console.log(l);
};

const distribution = (offers, riders) => {
  const byRider = new Map();
  for (const o of offers) byRider.set(o.rider_id, (byRider.get(o.rider_id) || 0) + 1);
  return riders
    .map((r) => ({ ...r, offers: byRider.get(r.id) || 0 }))
    .sort((a, b) => b.offers - a.offers);
};

const doubleBooked = async () => {
  const [rows] = await pool.query(
    `SELECT rider_id, COUNT(*) AS pending FROM rider_order_offers
     WHERE status = 'pending' GROUP BY rider_id HAVING pending > 1`
  );
  return rows;
};

const capViolations = async () => {
  const [rows] = await pool.query(
    `SELECT rider_id, COUNT(*) AS active FROM orders
     WHERE rider_id IS NOT NULL AND status NOT IN ('Delivered','Cancelled')
     GROUP BY rider_id HAVING active > ?`,
    [RIDER_MAX_ACTIVE_ORDERS]
  );
  return rows;
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarioSequential = async (world) => {
  setTag('sequential');
  const before = stats.queries;
  const t0 = Date.now();
  const subset = world.orders.slice(0, Math.min(RIDER_COUNT + 2, world.orders.length));
  const picks = [];
  for (const o of subset) {
    const res = await assignment.maybeStartRiderAssignment(o.id);
    picks.push({ orderId: o.id, riderId: res.riderId || null, waiting: Boolean(res.waiting) });
  }
  const ms = Date.now() - t0;
  const queries = stats.queries - before;

  const offers = await snapshotOffers();
  const riderById = new Map(world.riders.map((r) => [r.id, r]));
  const lines = picks.map((p) => {
    const r = riderById.get(p.riderId);
    const km = r ? r.distanceKm : null;
    return `  order ${p.orderId} -> ${r ? `${r.name} (${km.toFixed(2)} km, ring ${ringOf(r.stale ? null : km)})` : 'NO RIDER (searching)'}`;
  });

  const distinct = new Set(picks.map((p) => p.riderId).filter(Boolean));
  lines.push('');
  lines.push(`  orders dispatched: ${picks.length}, distinct riders used: ${distinct.size}`);
  lines.push(`  unoffered (kept searching): ${picks.filter((p) => !p.riderId).length}`);
  lines.push(`  double-booked riders: ${(await doubleBooked()).length}`);
  lines.push(`  DB round trips: ${queries} total, ${(queries / picks.length).toFixed(1)} per dispatch`);
  lines.push(`  wall clock: ${ms} ms local  |  projected at ${PROD_RTT_MS} ms RTT: ${((queries * PROD_RTT_MS) / 1000).toFixed(1)} s`);
  report('SCENARIO 1 — sequential dispatch (confirmations arriving one at a time)', lines);
  return { picks, offers };
};

const scenarioConcurrentBurst = async (world) => {
  setTag('burst');
  // Reset dispatch state, keep the same riders/orders.
  await pool.query('DELETE FROM rider_order_offers');
  await pool.query(
    "UPDATE orders SET rider_id = NULL, rider_assigned_at = NULL, rider_assignment_status = 'none', rider_search_started_at = NULL"
  );

  const before = stats.queries;
  const t0 = Date.now();
  const results = await Promise.all(
    world.orders.map((o) => assignment.maybeStartRiderAssignment(o.id))
  );
  const ms = Date.now() - t0;
  const queries = stats.queries - before;

  const offers = await snapshotOffers();
  const pending = offers.filter((o) => o.status === 'pending');
  const dist = distribution(pending, world.riders);
  const dbl = await doubleBooked();
  const decoyIds = new Set(world.decoys.map((d) => d.id));
  const decoyOffers = offers.filter((o) => decoyIds.has(o.rider_id));

  const lines = [];
  lines.push(`  ${world.orders.length} orders confirmed in the same tick against ${RIDER_COUNT} online riders`);
  lines.push(`  offers created: ${offers.length}, orders left searching: ${results.filter((r) => r.waiting).length}`);
  const tally = new Map();
  for (const r of results) {
    const key = r.offer ? 'offer_created'
      : r.waiting ? 'waiting_for_riders'
        : r.error ? `error:${r.error}`
          : `no_offer:${r.reason || 'unknown'}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  lines.push(`  outcome per order: ${[...tally.entries()].map(([k, n]) => `${k}=${n}`).join('  ')}`);
  lines.push('');
  lines.push('  offers per rider:');
  for (const r of dist) {
    lines.push(`    ${r.name.padEnd(5)} ${String(r.offers).padStart(2)} offer(s)  ${r.distanceKm.toFixed(2)} km  ring ${ringOf(r.stale ? null : r.distanceKm)}`);
  }
  lines.push('');
  lines.push(`  riders holding more than one PENDING offer: ${dbl.length}` + (dbl.length ? ` -> ${dbl.map((d) => `rider ${d.rider_id}:${d.pending}`).join(', ')}` : ''));
  lines.push(`  offers leaked to offline / area-2 riders: ${decoyOffers.length}`);
  lines.push(`  DB round trips: ${queries}, connections taken: ${stats.connections}`);
  lines.push(`  wall clock: ${ms} ms local  |  projected at ${PROD_RTT_MS} ms RTT (serial worst case): ${((queries * PROD_RTT_MS) / 1000).toFixed(1)} s`);
  report('SCENARIO 2 — concurrent peak burst (every shop confirms at once)', lines);
  return { offers, dbl, decoyOffers };
};

const scenarioRecovery = async () => {
  setTag('recover');
  const [states] = await pool.query(
    'SELECT rider_assignment_status AS st, COUNT(*) AS n FROM orders GROUP BY st'
  );

  // The 5 s sweeper tick: recoverStuckAssignments re-scans every order left
  // in searching/offered with no rider and no pending offer.
  const before = stats.queries;
  const t0 = Date.now();
  let ticks = 0;
  let lastOffers = -1;
  let offersNow = 0;
  while (ticks < 12) {
    await assignment.recoverStuckAssignments();
    ticks += 1;
    const [c] = await pool.query("SELECT COUNT(*) AS n FROM rider_order_offers WHERE status = 'pending'");
    offersNow = Number(c[0].n);
    if (offersNow === lastOffers) break;
    lastOffers = offersNow;
  }
  const ms = Date.now() - t0;
  const queries = stats.queries - before;

  const [stillWaiting] = await pool.query(
    `SELECT COUNT(*) AS n FROM orders o
     WHERE o.rider_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM rider_order_offers ro WHERE ro.order_id = o.id AND ro.status = 'pending')`
  );

  const lines = [];
  lines.push(`  order state left by the burst: ${states.map((r) => `${r.st}:${r.n}`).join(' ')}`);
  lines.push('  (orders that found every rider busy stay in searching — this is the retry path)');
  lines.push(`  sweeper ticks needed to re-dispatch: ${ticks}`);
  lines.push(`  pending offers after recovery: ${offersNow} (ceiling is ${RIDER_COUNT}, one per online rider)`);
  lines.push(`  orders still with no rider and no offer: ${stillWaiting[0].n} — correct, there are only ${RIDER_COUNT} riders`);
  lines.push(`  recovery cost: ${queries} queries, ${ms} ms local`);
  lines.push(`  in production: ticks fire every ${(config.RIDER_SWEEPER_MS || 5000) / 1000} s and each recovery is serial —`);
  lines.push(`    ~${((queries * PROD_RTT_MS) / 1000).toFixed(1)} s of DB time at ${PROD_RTT_MS} ms RTT before the backlog clears`);
  report('SCENARIO 2b — sweeper picks up whatever the burst could not place', lines);
};

const scenarioAcceptStorm = async () => {
  setTag('accept');
  const [pending] = await pool.query(
    "SELECT id, order_id, rider_id FROM rider_order_offers WHERE status = 'pending' ORDER BY id ASC"
  );

  // Every rider accepts everything they were offered, all at once, and the
  // first offer is double-tapped (flaky network / impatient rider).
  const calls = pending.map((o) => assignment.acceptOffer(o.id, o.rider_id));
  if (pending.length > 0) calls.push(assignment.acceptOffer(pending[0].id, pending[0].rider_id));
  const results = await Promise.all(calls);

  const ok = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => !r.ok && r.code === 'CONFLICT').length;
  const other = results.filter((r) => !r.ok && r.code !== 'CONFLICT');
  const violations = await capViolations();

  const [assigned] = await pool.query(
    "SELECT rider_id, COUNT(*) AS n FROM orders WHERE rider_id IS NOT NULL GROUP BY rider_id ORDER BY n DESC"
  );

  const lines = [];
  lines.push(`  accept calls fired concurrently: ${calls.length} (one deliberate double-tap)`);
  lines.push(`  accepted: ${ok}, rejected as CONFLICT/409: ${conflicts}, other failures: ${other.length}`);
  lines.push(`  orders now assigned: ${assigned.reduce((s, r) => s + Number(r.n), 0)}`);
  lines.push(`  active orders per rider after the storm: ${assigned.map((r) => `${r.rider_id}:${r.n}`).join(' ') || '(none)'}`);
  lines.push(`  riders over RIDER_MAX_ACTIVE_ORDERS (${RIDER_MAX_ACTIVE_ORDERS}): ${violations.length}` + (violations.length ? ` -> ${violations.map((v) => `rider ${v.rider_id}:${v.active}`).join(', ')}` : ''));
  if (other.length) lines.push(`  unexpected errors: ${JSON.stringify(other.slice(0, 3))}`);
  report('SCENARIO 3 — accept storm (every offered rider accepts at once, plus a double-tap)', lines);
  return { ok, conflicts, violations };
};

const scenarioExpiryCascade = async (world) => {
  setTag('expiry');
  await pool.query('DELETE FROM rider_order_offers');
  await pool.query(
    "UPDATE orders SET rider_id = NULL, rider_assigned_at = NULL, rider_assignment_status = 'none', rider_search_started_at = NULL"
  );

  const targets = world.orders.slice(0, Math.min(6, world.orders.length));
  for (const o of targets) await assignment.maybeStartRiderAssignment(o.id);

  // Age every pending offer past its deadline, then run the sweeper's own
  // expiry pass — the real "nobody in the app tapped anything" path.
  await pool.query("UPDATE rider_order_offers SET expires_at = NOW() - INTERVAL 5 SECOND WHERE status = 'pending'");
  const t0 = Date.now();
  const expired = await assignment.expireDueOffers();
  const ms = Date.now() - t0;

  const [after] = await pool.query(
    `SELECT status, COUNT(*) AS n FROM rider_order_offers GROUP BY status`
  );
  const [orderStates] = await pool.query(
    `SELECT rider_assignment_status AS st, COUNT(*) AS n FROM orders WHERE id IN (${targets.map(() => '?').join(',')}) GROUP BY st`,
    targets.map((t) => t.id)
  );
  const [reoffered] = await pool.query(
    `SELECT order_id, COUNT(*) AS attempts FROM rider_order_offers GROUP BY order_id ORDER BY attempts DESC LIMIT 5`
  );

  const lines = [];
  const expiredCount = Array.isArray(expired) ? expired.length : 0;
  lines.push(`  offers expired by the sweeper: ${expiredCount} in ${ms} ms (expireDueOffers caps at 50 per 5 s tick)`);
  lines.push(`  offer rows by status: ${after.map((r) => `${r.status}:${r.n}`).join(' ')}`);
  lines.push(`  order dispatch state: ${orderStates.map((r) => `${r.st}:${r.n}`).join(' ')}`);
  lines.push(`  offer attempts per order (top 5): ${reoffered.map((r) => `${r.order_id}:${r.attempts}`).join(' ')}`);
  lines.push('  (an expired offer must immediately re-offer the order to the next ring, never drop it)');
  report('SCENARIO 4 — timeout cascade (nobody taps Accept)', lines);
};

const scenarioHttp = async (world) => {
  setTag('http');
  const app = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = app.listen(HTTP_PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    await pool.query('DELETE FROM rider_order_offers');
    await pool.query(
      "UPDATE orders SET rider_id = NULL, rider_assigned_at = NULL, rider_assignment_status = 'none', rider_search_started_at = NULL"
    );
    const targets = world.orders.slice(0, RIDER_COUNT);
    for (const o of targets) await assignment.maybeStartRiderAssignment(o.id);

    const [pending] = await pool.query(
      "SELECT id, rider_id FROM rider_order_offers WHERE status = 'pending'"
    );
    const riderByRiderId = new Map(world.riders.map((r) => [r.id, r]));
    const base = `http://127.0.0.1:${HTTP_PORT}/api/rider`;

    // Every rider polls their offer queue, then accepts — over real HTTP,
    // through requireCustomer + requireRider + the rate limiter.
    const t0 = Date.now();
    const responses = await Promise.all(pending.flatMap((o) => {
      const rider = riderByRiderId.get(o.rider_id);
      if (!rider) return [];
      const headers = { Authorization: `Bearer ${signCustomerToken(rider.userId)}`, 'Content-Type': 'application/json' };
      return [
        fetch(`${base}/offers/active`, { headers }).then((r) => ({ kind: 'poll', status: r.status })),
        fetch(`${base}/offers/${o.id}/accept`, { method: 'POST', headers, body: '{}' })
          .then(async (r) => ({ kind: 'accept', status: r.status, body: await r.json().catch(() => null) })),
        // duplicate accept from the same rider, same tick
        fetch(`${base}/offers/${o.id}/accept`, { method: 'POST', headers, body: '{}' })
          .then(async (r) => ({ kind: 'accept-dup', status: r.status, body: await r.json().catch(() => null) })),
      ];
    }));
    const ms = Date.now() - t0;

    const byKind = (k) => responses.filter((r) => r.kind === k);
    const codes = (k) => {
      const m = new Map();
      for (const r of byKind(k)) m.set(r.status, (m.get(r.status) || 0) + 1);
      return [...m.entries()].map(([s, n]) => `${s}:${n}`).join(' ');
    };

    const [assignedRows] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE rider_id IS NOT NULL");
    const violations = await capViolations();

    const lines = [];
    lines.push(`  ${responses.length} real HTTP requests from ${pending.length} riders in ${ms} ms`);
    lines.push(`  GET  /rider/offers/active      -> ${codes('poll')}`);
    lines.push(`  POST /rider/offers/:id/accept  -> ${codes('accept')}`);
    lines.push(`  POST same offer again (dup)    -> ${codes('accept-dup')}`);
    lines.push(`  orders assigned: ${assignedRows[0].n}`);
    lines.push(`  riders over the active-order cap: ${violations.length}`);
    lines.push(`  NOTE: dev rate limit is 2000/min per IP; production is 300/min per IP.`);
    lines.push(`        ${responses.length} requests came from one IP here — carrier-NAT'd riders share one in prod.`);
    report('SCENARIO 5 — real HTTP: riders poll and accept through the live routes', lines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

// ---------------------------------------------------------------------------

const main = async () => {
  console.log(`rider dispatch load harness — db=${config.MYSQL_DATABASE} orders=${ORDER_COUNT} riders=${RIDER_COUNT}`);
  console.log(`rings=${RIDER_SEARCH_RADIUS_TIERS_KM.join('/')} km, max active orders per rider=${RIDER_MAX_ACTIVE_ORDERS}, offer timeout=${config.RIDER_OFFER_TIMEOUT_SEC}s`);

  const world = await seedWorld({ riderCount: RIDER_COUNT, orderCount: ORDER_COUNT });

  await scenarioSequential(world);
  await scenarioConcurrentBurst(world);
  await scenarioRecovery();
  await scenarioAcceptStorm();
  await scenarioExpiryCascade(world);
  if (!hasFlag('skip-http')) await scenarioHttp(world);

  const perTag = [...stats.byTag.entries()]
    .map(([t, e]) => `    ${t.padEnd(12)} ${String(e.queries).padStart(5)} queries, ${e.ms.toFixed(0)} ms local, ${((e.queries * PROD_RTT_MS) / 1000).toFixed(1)} s projected @ ${PROD_RTT_MS}ms RTT`);
  report('TOTALS', [`  ${stats.queries} queries, ${stats.connections} pooled connections`, ...perTag]);

  // Let fire-and-forget notification work drain before closing the pool.
  await new Promise((r) => setTimeout(r, 1500));
  await pool.end();
};

main().catch(async (e) => {
  console.error('\nharness failed:', e);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
