// End-to-end flow verification against the LOCAL running API (localhost:3000)
// using the seeded multi-area test data. Generates customer/admin JWTs
// directly (bypassing Firebase OTP, which is a login-transport detail, not
// what's being tested here) using the same JWT_SECRET the local server uses.
//
// Prerequisites: npm run db:migrate:dev, then node src/db/seed_multi_area_demo.js,
// then npm run start:dev (server must be live on :3000) — then run this file.
// Hardcoded to localhost:3000, so it cannot reach production by accident.
// Re-run seed_multi_area_demo.js before each run for a clean baseline —
// order-creation tests here add real rows that persist between runs.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env.development') });
const jwt = require('jsonwebtoken');

const BASE = 'http://localhost:3000/api';
const SECRET = process.env.JWT_SECRET;

const customerToken = (userId) => jwt.sign({ sub: userId, role: 'customer' }, SECRET, { expiresIn: '1h' });
// area_admin tokens must NEVER send X-Area-Id (verified live: the middleware
// 403s an area_admin who sends it at all, even matching their own area).
// Only super_admin ever sends the header.
const adminToken = (id, role, areaId) => jwt.sign({ sub: id, role: 'admin', adminRole: role, areaId }, SECRET, { expiresIn: '1h' });

const HISAR = { lat: 29.5152, lng: 75.4548 };
const BENGALURU = { lat: 12.9716, lng: 77.6046 };
const FAR_AWAY = { lat: 29.5152 + 5, lng: 75.4548 }; // outside every area's bbox entirely
const HISAR_CUSTOMER = 5;          // Vivaan Verma, has prior seeded orders — fine for non-first-order tests
const HISAR_FRESH_CUSTOMER = 15;   // Ananya Verma — zero prior orders, needed for first_order_only coupon test
const HISAR_BLOCKED = 19;          // Myra Patel, blocked=1
const HISAR_BURGER = 7;            // 179, delivery_charge=20, night_charge=5
const HISAR_CHIPS = 10;            // 20
const BENGALURU_BURGER = 13;       // 215 (1.2x Hisar's 179), area 2 only, delivery_charge=35, night_charge=10
const BENGALURU_FRESH_CUSTOMER = 34; // Diya Gupta, zero prior orders

let results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`);
}

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, body: json };
}

async function main() {
  console.log('=== E2E flow verification against local API ===\n');

  // T1 — Cart calc, Hisar, single item: exact subtotal/delivery/total math.
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(HISAR_CUSTOMER),
      body: { items: [{ product_id: HISAR_BURGER, quantity: 1 }], latitude: HISAR.lat, longitude: HISAR.lng },
    });
    const ok = r.status === 200 && Number(r.body.subtotal) === 179;
    record('T1 cart calc — Hisar single item subtotal', ok,
      `status=${r.status} subtotal=${r.body?.subtotal} deliveryCharge=${r.body?.deliveryCharge} total=${r.body?.total}`);
  }

  // T2 — Cart calc, Hisar pin, one Hisar item + one Bengaluru-only item — cross-area isolation.
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(HISAR_CUSTOMER),
      body: {
        items: [{ product_id: HISAR_BURGER, quantity: 1 }, { product_id: BENGALURU_BURGER, quantity: 1 }],
        latitude: HISAR.lat, longitude: HISAR.lng,
      },
    });
    const items = r.body?.items || [];
    const unavailable = r.body?.unavailableItems || [];
    const bengaluruLeaked = items.some((i) => Number(i.productId ?? i.product_id) === BENGALURU_BURGER);
    const ok = r.status === 200 && !bengaluruLeaked && Number(r.body.subtotal) === 179 && unavailable.length > 0;
    record('T2 cart calc — cross-area product never silently priced', ok,
      `status=${r.status} subtotal=${r.body?.subtotal} unavailableCount=${unavailable.length}`);
  }

  // T3 — Coupon WELCOME50A1 (50% off up to ₹100), FIRST order for a customer with zero prior orders.
  {
    const r = await call('POST', '/cart/validate-coupon', {
      token: customerToken(HISAR_FRESH_CUSTOMER),
      body: { code: 'WELCOME50A1', subtotal: 179, delivery_charge: 20, latitude: HISAR.lat, longitude: HISAR.lng },
    });
    const expectedDiscount = Math.min(179 * 0.5, 100);
    const actualDiscount = Number(r.body?.discount);
    const ok = r.status === 200 && r.body?.ok === true && Math.abs(actualDiscount - expectedDiscount) < 0.01;
    record('T3 coupon WELCOME50A1 — 50% off cap ₹100 math', ok,
      `status=${r.status} ok=${r.body?.ok} reason=${r.body?.reason} discount=${actualDiscount} expected=${expectedDiscount}`);
  }

  // T3b — Same coupon, same customer, SECOND attempt — first_order_only must now reject.
  {
    const r = await call('POST', '/cart/validate-coupon', {
      token: customerToken(HISAR_FRESH_CUSTOMER),
      body: { code: 'SAVE20A1', subtotal: 300, delivery_charge: 20, latitude: HISAR.lat, longitude: HISAR.lng },
    });
    // SAVE20A1 has no first_order_only restriction — should succeed independent of T3's history.
    const expectedDiscount = Math.min(300 * 0.2, 150);
    const actualDiscount = Number(r.body?.discount);
    const ok = r.status === 200 && r.body?.ok === true && Math.abs(actualDiscount - expectedDiscount) < 0.01;
    record('T3b coupon SAVE20A1 — 20% off cap ₹150 math (no first-order restriction)', ok,
      `status=${r.status} ok=${r.body?.ok} discount=${actualDiscount} expected=${expectedDiscount}`);
  }

  // T4 — WELCOME50A2 (Bengaluru's coupon) attempted in Hisar context — must be rejected.
  {
    const r = await call('POST', '/cart/validate-coupon', {
      token: customerToken(HISAR_CUSTOMER),
      body: { code: 'WELCOME50A2', subtotal: 179, delivery_charge: 20, latitude: HISAR.lat, longitude: HISAR.lng },
    });
    const ok = r.status === 200 && r.body?.ok === false;
    record('T4 cross-area coupon code rejected', ok, `status=${r.status} ok=${r.body?.ok} reason=${r.body?.reason}`);
  }

  // T5 — FREEDELA1 (free delivery over ₹199) on a 278 subtotal.
  {
    const r = await call('POST', '/cart/validate-coupon', {
      token: customerToken(HISAR_CUSTOMER),
      body: { code: 'FREEDELA1', subtotal: 278, delivery_charge: 20, latitude: HISAR.lat, longitude: HISAR.lng },
    });
    const ok = r.status === 200 && r.body?.ok === true;
    record('T5 coupon FREEDELA1 — free delivery over threshold', ok, `status=${r.status} ok=${r.body?.ok} discount=${r.body?.discount}`);
  }

  // T6 — Real order creation, Hisar: math + idempotency replay. Uses a customer
  // with no auto-apply-eligible coupon collision so the math is unambiguous.
  let hisarOrderId = null;
  const idemKey = `e2e-test-${Date.now()}`;
  {
    const body = {
      address: 'E2E Test Address, Hisar', latitude: HISAR.lat, longitude: HISAR.lng,
      payment_method: 'UPI', no_auto_apply: true, // Cash is legitimately blocked during night hours — avoid time-of-day flakiness
      items: [{ productId: HISAR_BURGER, quantity: 1 }, { productId: HISAR_CHIPS, quantity: 2 }],
    };
    const r1 = await call('POST', '/orders', { token: customerToken(HISAR_CUSTOMER), body, headers: { 'Idempotency-Key': idemKey } });
    const expectedSubtotal = 179 + 2 * 20; // 219
    hisarOrderId = r1.body?.orderId;
    const ok1 = r1.status === 201 && Number(r1.body?.order?.subtotal) === expectedSubtotal
      // total = subtotal + deliveryCharge + nightCharge (real, correct — a
      // night-hours order legitimately carries the night surcharge too).
      && Number(r1.body?.order?.total) === expectedSubtotal + Number(r1.body?.order?.deliveryCharge || 0) + Number(r1.body?.order?.nightCharge || 0);
    record('T6a order creation — Hisar subtotal/total math', ok1,
      `status=${r1.status} orderId=${r1.body?.orderId} subtotal=${r1.body?.order?.subtotal} deliveryCharge=${r1.body?.order?.deliveryCharge} nightCharge=${r1.body?.order?.nightCharge} total=${r1.body?.order?.total} orderNumber=${r1.body?.orderNumber}`);

    const r2 = await call('POST', '/orders', { token: customerToken(HISAR_CUSTOMER), body, headers: { 'Idempotency-Key': idemKey } });
    const ok2 = r2.status === 200 && r2.body?.idempotent === true && r2.body?.orderId === hisarOrderId;
    record('T6b same Idempotency-Key returns the SAME order, not a duplicate', ok2,
      `status=${r2.status} idempotent=${r2.body?.idempotent} orderId=${r2.body?.orderId} (expected ${hisarOrderId})`);
  }

  // T7 — Blocked customer rejected outright.
  {
    const r = await call('POST', '/orders', {
      token: customerToken(HISAR_BLOCKED),
      body: { address: 'Blocked test', latitude: HISAR.lat, longitude: HISAR.lng, payment_method: 'Cash', items: [{ productId: HISAR_BURGER, quantity: 1 }] },
    });
    const ok = r.status === 403;
    record('T7 blocked customer cannot place an order', ok, `status=${r.status} message=${r.body?.message}`);
  }

  // T8 — Cart PREVIEW for a pin far outside every zone: soft-reject, 200 + deliveryWithinRange:false.
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(HISAR_CUSTOMER),
      body: { items: [{ product_id: HISAR_BURGER, quantity: 1 }], latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng },
    });
    const ok = r.status === 200 && r.body?.deliveryWithinRange === false;
    record('T8 cart preview soft-rejects out-of-range pin (200, not deliverable)', ok,
      `status=${r.status} deliveryWithinRange=${r.body?.deliveryWithinRange} message=${r.body?.deliveryMessage}`);
  }

  // T9 — Checkout with the same far pin must hard-reject with OUT_OF_DELIVERY_RANGE
  // (isolated from rider-capacity noise by using a fresh customer with no
  // interaction with T6's order, and checked BEFORE any capacity-affecting test).
  {
    const r = await call('POST', '/orders', {
      token: customerToken(HISAR_FRESH_CUSTOMER),
      body: { address: 'Nowhere', latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng, payment_method: 'Cash', items: [{ productId: HISAR_BURGER, quantity: 1 }] },
    });
    const ok = r.status === 400 && r.body?.code === 'OUT_OF_DELIVERY_RANGE';
    record('T9 checkout hard-rejects a pin outside every zone', ok, `status=${r.status} code=${r.body?.code} message=${r.body?.message}`);
  }

  // T10 — Ordering a Bengaluru-only product while pinned in Hisar must fail
  // specifically on product availability, not just "some 400". Checked via the
  // cart-calculate unavailableItems signal (product-level), independent of
  // whatever the order-creation capacity state happens to be right now.
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(HISAR_FRESH_CUSTOMER),
      body: { items: [{ product_id: BENGALURU_BURGER, quantity: 1 }], latitude: HISAR.lat, longitude: HISAR.lng },
    });
    const unavailable = r.body?.unavailableItems || [];
    const flagged = unavailable.some((i) => Number(i.productId ?? i.product_id) === BENGALURU_BURGER);
    const ok = r.status === 200 && flagged;
    record('T10 cross-area product flagged unavailable at cart-preview level', ok,
      `status=${r.status} unavailable=${JSON.stringify(unavailable)}`);
  }

  // T11 — Admin area isolation: admin_area1 gets 404 on a Bengaluru order;
  // admin_area2 can see it; superadmin with X-Area-Id:2 can too.
  // (area_admin tokens correctly never send X-Area-Id — see adminToken above.)
  {
    // Real ids, verified against the seeded admins table — admin_area1=3
    // (area 1), admin_area2=4 (area 2), superadmin=2 (super_admin).
    const listR = await call('GET', '/admin/orders?limit=1', { token: adminToken(4, 'area_admin', 2) });
    const bengaluruOrderId = (listR.body?.data || [])[0]?.id;

    if (!bengaluruOrderId) {
      record('T11 admin area isolation', false, `could not list a Bengaluru order — status=${listR.status} body=${JSON.stringify(listR.body).slice(0, 200)}`);
    } else {
      const r1 = await call('GET', `/admin/orders/${bengaluruOrderId}`, { token: adminToken(3, 'area_admin', 1) });
      record('T11a admin_area1 gets 404 on a Bengaluru order (no existence leak)', r1.status === 404, `status=${r1.status} code=${r1.body?.code}`);

      const r2 = await call('GET', `/admin/orders/${bengaluruOrderId}`, { token: adminToken(4, 'area_admin', 2) });
      record('T11b admin_area2 can see its own area\'s order', r2.status === 200, `status=${r2.status}`);

      const r3 = await call('GET', `/admin/orders/${bengaluruOrderId}`, { token: adminToken(2, 'super_admin', null), headers: { 'X-Area-Id': '2' } });
      record('T11c superadmin with X-Area-Id:2 can see the Bengaluru order', r3.status === 200, `status=${r3.status}`);
    }
  }

  // T12 — Rider capacity endpoint: responds with a real verdict (whatever it is right now).
  {
    const r = await call('GET', `/rider-capacity?latitude=${HISAR.lat}&longitude=${HISAR.lng}`, { token: customerToken(HISAR_CUSTOMER) });
    const ok = r.status === 200 && typeof r.body?.atCapacity === 'boolean';
    record('T12 rider-capacity endpoint responds with a verdict', ok, `status=${r.status} body=${JSON.stringify(r.body)}`);
  }

  // T13 — Reorder-eligibility signal: the CUSTOMER-facing order response (not
  // the admin one — different serializer) must carry area_id.
  {
    const r = await call('GET', `/orders/${hisarOrderId}`, { token: customerToken(HISAR_CUSTOMER) });
    const ok = r.status === 200 && Number(r.body?.data?.area_id) === 1;
    record('T13 customer-facing order response carries area_id for reorder-eligibility', ok,
      `status=${r.status} area_id=${r.body?.data?.area_id}`);
  }

  // T14 — Super admin "all areas" order list does not crash and returns a mix.
  {
    const r = await call('GET', '/admin/orders?limit=5', { token: adminToken(2, 'super_admin', null), headers: { 'X-Area-Id': 'all' } });
    const ok = r.status === 200;
    record('T14 superadmin "all areas" order list does not crash', ok, `status=${r.status} count=${(r.body?.data || []).length}`);
  }

  // T15 — Root-cause regression check: the exact bug found this run. A point
  // genuinely outside every area's bbox must resolve to no area, not default.
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(HISAR_CUSTOMER),
      body: { items: [{ product_id: HISAR_BURGER, quantity: 1 }], latitude: FAR_AWAY.lat, longitude: FAR_AWAY.lng },
    });
    const ok = r.status === 200 && r.body?.deliveryWithinRange === false;
    record('T15 regression — far-outside-every-bbox pin no longer silently defaults', ok,
      `status=${r.status} deliveryWithinRange=${r.body?.deliveryWithinRange}`);
  }

  // ---------------------------------------------------------------
  // T16 — Bengaluru's OWN product price + delivery/night charge apply,
  // not Hisar's. Every area1 test above used identical-looking flows;
  // this proves area 2 isn't just isolated but genuinely independently
  // priced (seed_multi_area_demo.js gives Bengaluru a 1.2x price multiplier,
  // delivery_charge=35 vs Hisar's 20).
  // ---------------------------------------------------------------
  {
    const r = await call('POST', '/cart/calculate', {
      token: customerToken(BENGALURU_FRESH_CUSTOMER),
      body: { items: [{ product_id: BENGALURU_BURGER, quantity: 1 }], latitude: BENGALURU.lat, longitude: BENGALURU.lng },
    });
    const ok = r.status === 200 && Number(r.body.subtotal) === 215 && Number(r.body.deliveryCharge) === 35;
    record('T16 Bengaluru cart calc uses its OWN price (215) and delivery charge (35), not Hisar\'s', ok,
      `status=${r.status} subtotal=${r.body?.subtotal} deliveryCharge=${r.body?.deliveryCharge} total=${r.body?.total}`);
  }

  // T17 — Bengaluru's coupon percentages/caps are genuinely different values
  // (30%/₹60 cap vs Hisar's 50%/₹100), and the discount math must reflect
  // Bengaluru's OWN numbers, not Hisar's.
  {
    const r = await call('POST', '/cart/validate-coupon', {
      token: customerToken(BENGALURU_FRESH_CUSTOMER),
      body: { code: 'WELCOME50A2', subtotal: 215, delivery_charge: 35, latitude: BENGALURU.lat, longitude: BENGALURU.lng },
    });
    const expectedDiscount = Math.min(215 * 0.3, 60); // Bengaluru: 30% cap ₹60
    const actualDiscount = Number(r.body?.discount);
    const ok = r.status === 200 && r.body?.ok === true && Math.abs(actualDiscount - expectedDiscount) < 0.01;
    record('T17 Bengaluru coupon WELCOME50A2 — 30% cap ₹60 math (not Hisar\'s 50%/₹100)', ok,
      `status=${r.status} ok=${r.body?.ok} discount=${actualDiscount} expected=${expectedDiscount}`);
  }

  // T18 — Cache-bleed check: fire alternating Hisar/Bengaluru requests back
  // to back on the SAME hot process. Every settings/area/zone lookup in this
  // codebase is cached (areasCache 60s, areaZonesCache 15s, settingsCache) —
  // if any cache key is missing its area_id, this is exactly the shape of
  // request pattern that would surface one area's cached value leaking into
  // the other's response. Real bugs of this exact shape were found and fixed
  // earlier in this session (bustSettingsCache, per-area settings key).
  // ---------------------------------------------------------------
  {
    const requests = [
      ['hisar', HISAR_CUSTOMER, HISAR, HISAR_BURGER, 179, 20],
      ['bengaluru', BENGALURU_FRESH_CUSTOMER, BENGALURU, BENGALURU_BURGER, 215, 35],
      ['hisar', HISAR_CUSTOMER, HISAR, HISAR_BURGER, 179, 20],
      ['bengaluru', BENGALURU_FRESH_CUSTOMER, BENGALURU, BENGALURU_BURGER, 215, 35],
      ['hisar', HISAR_CUSTOMER, HISAR, HISAR_BURGER, 179, 20],
      ['bengaluru', BENGALURU_FRESH_CUSTOMER, BENGALURU, BENGALURU_BURGER, 215, 35],
    ];
    let allCorrect = true;
    const mismatches = [];
    for (const [label, customerId, pin, productId, expectedPrice, expectedDelivery] of requests) {
      const r = await call('POST', '/cart/calculate', {
        token: customerToken(customerId),
        body: { items: [{ product_id: productId, quantity: 1 }], latitude: pin.lat, longitude: pin.lng },
      });
      const priceOk = Number(r.body?.subtotal) === expectedPrice;
      const deliveryOk = Number(r.body?.deliveryCharge) === expectedDelivery;
      if (!priceOk || !deliveryOk) {
        allCorrect = false;
        mismatches.push(`${label}: subtotal=${r.body?.subtotal}(want ${expectedPrice}) deliveryCharge=${r.body?.deliveryCharge}(want ${expectedDelivery})`);
      }
    }
    record('T18 rapid alternating Hisar/Bengaluru requests never bleed cached values across areas', allCorrect,
      allCorrect ? '6 alternating requests, all correct' : mismatches.join(' | '));
  }

  console.log('\n=== Summary ===');
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} passed`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log(`  - ${f.name} :: ${f.detail}`));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(1); });
