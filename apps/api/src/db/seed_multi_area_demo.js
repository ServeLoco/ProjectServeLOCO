require('dotenv').config();

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Refusing to run demo seed in production. Set ALLOW_DEMO_SEED=true to override.');
  process.exit(1);
}

// Local test-data seed for the multi-area branch. Two independent areas,
// each with its own admin, shops, categories, products, riders, customers
// and order history — enough to click through every area-scoped flow
// (admin panel per area, checkout, rider dispatch, coupons, reorder) without
// pulling anything from production. All phone numbers/names below are
// obviously-fake, sequential test data, never real customer records.
//
// Run with: node src/db/seed_multi_area_demo.js
// (after `npm run db:migrate:dev`, same as seed_demo.js)

const bcrypt = require('bcrypt');
const { pool } = require('./mysql');
const { seedSystemStoreModes } = require('../utils/areaScope');

// Same coordinate convention this codebase's own tests already use
// (couponZoneDerivation.test.js's CENTER, cartOrder.test.js's beforeAll pin)
// — two real, well-separated Indian cities so bboxCandidateAreas' prefilter
// and real zone matching behave like two genuinely independent regions.
// Deliberately DIFFERENT pricing/discount config per area, not the same
// numbers duplicated under different codes — the whole point of this seed
// is to exercise "does area 2's own rate apply to area 2, never area 1's,"
// not just "is area 2's data invisible from area 1." priceMultiplier scales
// every product price for that area (Bengaluru priced ~20% higher).
const AREAS = [
  {
    id: 1, code: 'A1', name: 'Hisar', center: { lat: 29.5152, lng: 75.4548 },
    priceMultiplier: 1, deliveryCharge: 20, nightCharge: 5,
    welcomePct: 50, welcomeCap: 100,
    savePct: 20, saveCap: 150,
    freeDelThreshold: 199,
  },
  {
    id: 2, code: 'A2', name: 'Bengaluru', center: { lat: 12.9716, lng: 77.6046 },
    priceMultiplier: 1.2, deliveryCharge: 35, nightCharge: 10,
    welcomePct: 30, welcomeCap: 60,
    savePct: 15, saveCap: 100,
    freeDelThreshold: 250,
  },
];

const ADMIN_PASSWORD = 'Test@1234';

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_EQUATOR = 111.320;
const offsetPoint = (lat, lng, dLatKm, dLngKm) => ({
  lat: lat + dLatKm / KM_PER_DEG_LAT,
  lng: lng + dLngKm / (KM_PER_DEG_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180)),
});
const squareBoundary = (center, sideKm) => {
  const half = sideKm / 2;
  return [
    offsetPoint(center.lat, center.lng, -half, -half),
    offsetPoint(center.lat, center.lng, -half, half),
    offsetPoint(center.lat, center.lng, half, half),
    offsetPoint(center.lat, center.lng, half, -half),
  ];
};
// A point a couple km inside the zone but off-center, so shops/riders/orders
// aren't all stacked on the exact same pin.
const nearby = (center, dLatKm, dLngKm) => offsetPoint(center.lat, center.lng, dLatKm, dLngKm);

const FIRST_NAMES = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Ishaan', 'Kabir', 'Rohan', 'Sai',
  'Priya', 'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Myra', 'Anika', 'Ira', 'Kiara', 'Zara'];
const LAST_NAMES = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Kumar', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Chopra'];
const mockName = (seed) => `${FIRST_NAMES[seed % FIRST_NAMES.length]} ${LAST_NAMES[seed % LAST_NAMES.length]}`;

async function upsertUser({ name, phone, address, trusted = 1, blocked = 0, lastAreaId = null }) {
  await pool.query(
    `INSERT INTO users (name, phone, whatsapp_number, address, trusted, blocked, last_area_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), whatsapp_number = VALUES(whatsapp_number), address = VALUES(address),
       trusted = VALUES(trusted), blocked = VALUES(blocked), last_area_id = VALUES(last_area_id)`,
    [name, phone, phone, address, trusted, blocked, lastAreaId]
  );
  const [rows] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
  return rows[0].id;
}

async function seed() {
  console.log('Seeding multi-area test data...');
  const areaData = {}; // areaId -> { shops: [], categories: {}, products: [], riders: [], customers: [] }

  try {
    // ---- 1. Areas ------------------------------------------------------
    // Area 1 (id 1) already exists from migrate.js's own default seed —
    // just give it a real name/bbox instead of the generic "Area 1".
    await pool.query(
      `UPDATE areas SET name = ?, min_lat = ?, max_lat = ?, min_lng = ?, max_lng = ?
       WHERE id = 1`,
      [AREAS[0].name, AREAS[0].center.lat - 0.1, AREAS[0].center.lat + 0.1,
        AREAS[0].center.lng - 0.1, AREAS[0].center.lng + 0.1]
    );
    await pool.query(
      `INSERT INTO areas (id, code, name, active, is_default, min_lat, max_lat, min_lng, max_lng)
       VALUES (2, ?, ?, 1, 0, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), active = 1,
         min_lat = VALUES(min_lat), max_lat = VALUES(max_lat), min_lng = VALUES(min_lng), max_lng = VALUES(max_lng)`,
      [AREAS[1].code, AREAS[1].name,
        AREAS[1].center.lat - 0.1, AREAS[1].center.lat + 0.1,
        AREAS[1].center.lng - 0.1, AREAS[1].center.lng + 0.1]
    );
    console.log('  Areas ready:', AREAS.map((a) => `${a.id}=${a.name}`).join(', '));

    for (const area of AREAS) areaData[area.id] = {};

    // ---- 2. Settings + delivery zone per area --------------------------
    // Flat pricing (radius_pricing_active off) matches production's actual
    // default — a real delivery_zones polygon still gets configured per
    // area so area RESOLUTION (which area a pin belongs to) works
    // correctly regardless of pricing mode; see areaScope.resolveAreaIdForPricing.
    for (const area of AREAS) {
      await pool.query(
        `INSERT INTO settings (area_id, shop_open, delivery_available, delivery_charge, night_charge,
           standard_delivery_minutes, fast_delivery_minutes, shop_latitude, shop_longitude, radius_pricing_active)
         VALUES (?, 1, 1, ?, ?, 45, 20, ?, ?, 0)
         ON DUPLICATE KEY UPDATE shop_open = 1, delivery_available = 1,
           delivery_charge = VALUES(delivery_charge), night_charge = VALUES(night_charge),
           shop_latitude = VALUES(shop_latitude), shop_longitude = VALUES(shop_longitude)`,
        [area.id, area.deliveryCharge, area.nightCharge, area.center.lat, area.center.lng]
      );

      const boundary = squareBoundary(area.center, 12); // 12km-wide service square
      await pool.query(
        `DELETE FROM delivery_zones WHERE area_id = ? AND name = ?`,
        [area.id, `${area.name} — Service Area`]
      );
      await pool.query(
        `INSERT INTO delivery_zones (area_id, name, parent_zone_id, boundary, normal_charge, fast_charge,
           normal_eta_minutes, fast_eta_minutes, night_charge, cod_enabled, active)
         VALUES (?, ?, NULL, ?, 15, 30, 45, 20, 0, 1, 1)`,
        [area.id, `${area.name} — Service Area`, JSON.stringify(boundary)]
      );

      await seedSystemStoreModes(area.id, pool);
    }
    console.log('  Settings + delivery zones + store modes ready for both areas.');

    // ---- 3. Admins -------------------------------------------------------
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const admins = [
      { username: 'superadmin', role: 'super_admin', areaId: null, displayName: 'Super Admin' },
      { username: 'admin_area1', role: 'area_admin', areaId: 1, displayName: `${AREAS[0].name} Admin` },
      { username: 'admin_area2', role: 'area_admin', areaId: 2, displayName: `${AREAS[1].name} Admin` },
    ];
    for (const a of admins) {
      await pool.query(
        `INSERT INTO admins (username, password_hash, role, area_id, display_name, active)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role),
           area_id = VALUES(area_id), display_name = VALUES(display_name), active = 1`,
        [a.username, passwordHash, a.role, a.areaId, a.displayName]
      );
    }
    console.log(`  Admins ready — login with any of: ${admins.map((a) => a.username).join(', ')} / password "${ADMIN_PASSWORD}"`);

    // ---- 4. Per-area data: categories, shops, products, riders, customers, orders, coupons ----
    for (const area of AREAS) {
      const aid = area.id;
      const suffix = aid === 1 ? 'a1' : 'a2';

      // Categories (per-area now — UNIQUE(area_id, slug))
      await pool.query(
        `INSERT IGNORE INTO categories (area_id, name, slug, type, active, display_order) VALUES (?, 'Fast Food', ?, 'fast_food', 1, 1)`,
        [aid, `fast-food-${suffix}`]
      );
      await pool.query(
        `INSERT IGNORE INTO categories (area_id, name, slug, type, active, display_order) VALUES (?, 'Packed Items', ?, 'packed', 1, 2)`,
        [aid, `packed-items-${suffix}`]
      );
      const [ffCat] = await pool.query('SELECT id FROM categories WHERE area_id = ? AND slug = ?', [aid, `fast-food-${suffix}`]);
      const [pkCat] = await pool.query('SELECT id FROM categories WHERE area_id = ? AND slug = ?', [aid, `packed-items-${suffix}`]);
      const fastFoodCatId = ffCat[0].id;
      const packedCatId = pkCat[0].id;

      // Shop owner (real login) + one admin-managed shop (no owner)
      const ownerUserId = await upsertUser({
        name: `${mockName(aid * 7)} (Shop Owner)`,
        phone: `70000${aid}2001`,
        address: `${area.name} Main Market`,
      });
      const cornerStorePos = nearby(area.center, 0.5, 0.5);
      const quickMartPos = nearby(area.center, -0.5, 0.3);
      await pool.query(
        `INSERT INTO shops (area_id, name, owner_user_id, is_open, active, latitude, longitude)
         SELECT ?, ?, ?, 1, 1, ?, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM shops WHERE area_id = ? AND name = ?)`,
        [aid, `${area.name} Corner Store`, ownerUserId, cornerStorePos.lat, cornerStorePos.lng, aid, `${area.name} Corner Store`]
      );
      await pool.query(
        `INSERT INTO shops (area_id, name, owner_user_id, is_open, active, latitude, longitude)
         SELECT ?, ?, NULL, 1, 1, ?, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM shops WHERE area_id = ? AND name = ?)`,
        [aid, `${area.name} Quick Mart`, quickMartPos.lat, quickMartPos.lng, aid, `${area.name} Quick Mart`]
      );
      const [shopRows] = await pool.query(
        `SELECT id, name FROM shops WHERE area_id = ? AND name IN (?, ?)`,
        [aid, `${area.name} Corner Store`, `${area.name} Quick Mart`]
      );
      const shopIds = shopRows.map((s) => s.id);

      // Products: a few per shop across both categories, plus one house-only
      // (shop_id NULL) item to exercise that path too.
      const productSpecs = [
        { name: `${area.name} Zinger Burger`, price: 179, categoryId: fastFoodCatId, shopId: shopIds[0], unit: '1 pc' },
        { name: `${area.name} Loaded Fries`, price: 99, categoryId: fastFoodCatId, shopId: shopIds[0], unit: '1 box' },
        { name: `${area.name} Cold Coffee`, price: 89, categoryId: fastFoodCatId, shopId: shopIds[1], unit: '300ml' },
        { name: `${area.name} Chips Pack`, price: 20, categoryId: packedCatId, shopId: shopIds[1], unit: '1 packet' },
        { name: `${area.name} Instant Noodles`, price: 45, categoryId: packedCatId, shopId: shopIds[1], unit: '1 pack' },
        { name: `${area.name} Local Honey (House Brand)`, price: 220, categoryId: packedCatId, shopId: null, unit: '250g' },
      ];
      const productIds = [];
      for (const p of productSpecs) {
        // priceMultiplier makes each area's catalog genuinely its own rate,
        // not the same number copy-pasted under a different id.
        const areaPrice = Math.round(p.price * area.priceMultiplier);
        await pool.query(
          `INSERT INTO products (area_id, name, category_id, shop_id, price, unit, available)
           SELECT ?, ?, ?, ?, ?, ?, 1 FROM DUAL
           WHERE NOT EXISTS (SELECT 1 FROM products WHERE area_id = ? AND name = ?)`,
          [aid, p.name, p.categoryId, p.shopId, areaPrice, p.unit, aid, p.name]
        );
        const [row] = await pool.query('SELECT id, price FROM products WHERE area_id = ? AND name = ?', [aid, p.name]);
        productIds.push(row[0].id);
      }

      // Riders: 2 online (in range, ready to be dispatched to) + 1 offline.
      const riderSpecs = [
        { name: mockName(aid * 3 + 1), phone: `70000${aid}1001`, online: 1, offset: [0.2, 0.2] },
        { name: mockName(aid * 3 + 2), phone: `70000${aid}1002`, online: 1, offset: [-0.3, 0.1] },
        { name: mockName(aid * 3 + 3), phone: `70000${aid}1003`, online: 0, offset: [1.5, 1.5] },
      ];
      const riderIds = [];
      for (const r of riderSpecs) {
        const userId = await upsertUser({ name: r.name, phone: r.phone, address: `${area.name} Rider Colony` });
        const pos = nearby(area.center, r.offset[0], r.offset[1]);
        await pool.query(
          `INSERT INTO riders (area_id, user_id, display_name, phone, active, is_online, last_lat, last_lng, last_location_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE area_id = VALUES(area_id), display_name = VALUES(display_name), is_online = VALUES(is_online),
             last_lat = VALUES(last_lat), last_lng = VALUES(last_lng), last_location_at = NOW()`,
          [aid, userId, r.name, r.phone, r.online, pos.lat, pos.lng]
        );
        const [row] = await pool.query('SELECT id FROM riders WHERE user_id = ?', [userId]);
        riderIds.push(row[0].id);
      }

      // Customers: 15 per area. A mix of trusted/blocked, and roughly half
      // with last_area_id already set (exercises the no-pin fallback path).
      const customerIds = [];
      for (let i = 1; i <= 15; i++) {
        const phone = `70000${aid}0${String(i).padStart(3, '0')}`;
        const trusted = i % 10 === 0 ? 0 : 1;
        const blocked = i === 15 ? 1 : 0; // one deliberately-blocked test account per area
        const lastAreaId = i % 2 === 0 ? aid : null;
        const id = await upsertUser({
          name: mockName(aid * 100 + i),
          phone,
          address: `${i} ${area.name} Residency Road`,
          trusted,
          blocked,
          lastAreaId,
        });
        customerIds.push(id);
      }

      // Orders: spread across every status, several customers, some with a
      // rider already assigned/picked-up so dispatch/admin views have real
      // in-flight data to show, not just a pile of Delivered rows.
      const states = [
        { status: 'Pending', riderId: null, pickedUp: false },
        { status: 'Accepted', riderId: null, pickedUp: false },
        { status: 'Preparing', riderId: riderIds[0], pickedUp: false },
        { status: 'Out for Delivery', riderId: riderIds[0], pickedUp: true },
        { status: 'Out for Delivery', riderId: riderIds[1], pickedUp: true },
        { status: 'Delivered', riderId: riderIds[0], pickedUp: true },
        { status: 'Delivered', riderId: riderIds[1], pickedUp: true },
        { status: 'Delivered', riderId: riderIds[0], pickedUp: true },
        { status: 'Cancelled', riderId: null, pickedUp: false },
        { status: 'Delivered', riderId: riderIds[1], pickedUp: true },
      ];
      await pool.query(`DELETE oi FROM order_items oi INNER JOIN orders o ON oi.order_id = o.id WHERE o.order_number LIKE ?`, [`TEST-${suffix.toUpperCase()}-%`]);
      await pool.query(`DELETE FROM orders WHERE order_number LIKE ?`, [`TEST-${suffix.toUpperCase()}-%`]);

      for (let i = 0; i < states.length; i++) {
        const s = states[i];
        const customerId = customerIds[i % customerIds.length];
        const [custRow] = await pool.query('SELECT name, phone, address FROM users WHERE id = ?', [customerId]);
        const cust = custRow[0];
        const orderNumber = `TEST-${suffix.toUpperCase()}-${1000 + i}`;
        const prod1 = productIds[i % productIds.length];
        const prod2 = productIds[(i + 1) % productIds.length];
        const [p1Row] = await pool.query('SELECT name, price FROM products WHERE id = ?', [prod1]);
        const [p2Row] = await pool.query('SELECT name, price FROM products WHERE id = ?', [prod2]);
        const subtotal = Number(p1Row[0].price) + Number(p2Row[0].price);
        const deliveryCharge = 15;
        const total = subtotal + deliveryCharge;
        const paymentStatus = s.status === 'Delivered' ? 'Success' : (s.status === 'Cancelled' ? 'Failed' : 'Pending');
        const pos = nearby(area.center, (i % 5) * 0.1 - 0.2, (i % 3) * 0.1 - 0.1);

        const riderAssignmentStatus = s.riderId ? 'assigned' : (s.status === 'Cancelled' || s.status === 'Delivered' && !s.riderId ? 'none' : 'searching');

        const [orderRes] = await pool.query(
          `INSERT INTO orders (
             area_id, order_number, customer_id, customer_name, phone, address,
             latitude, longitude, subtotal, delivery_charge, night_charge, total,
             status, payment_method, payment_status,
             rider_id, rider_assignment_status, rider_assigned_at, rider_picked_up_at, delivered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            aid, orderNumber, customerId, cust.name, cust.phone, cust.address,
            pos.lat, pos.lng, subtotal, deliveryCharge, total,
            s.status, i % 2 === 0 ? 'Cash' : 'UPI', paymentStatus,
            s.riderId, riderAssignmentStatus,
            s.riderId ? new Date() : null,
            s.pickedUp ? new Date() : null,
            s.status === 'Delivered' ? new Date() : null,
          ]
        );
        const orderId = orderRes.insertId;
        await pool.query(
          `INSERT INTO order_items (area_id, order_id, product_id, product_name, quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [aid, orderId, prod1, p1Row[0].name, p1Row[0].price, p1Row[0].price]
        );
        await pool.query(
          `INSERT INTO order_items (area_id, order_id, product_id, product_name, quantity, unit_price, line_total)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [aid, orderId, prod2, p2Row[0].name, p2Row[0].price, p2Row[0].price]
        );
      }

      // Coupons — per-area unique codes AND deliberately per-area VALUES
      // (percent/cap/threshold), not the same numbers duplicated under a
      // different code — see the AREAS table comment above for why.
      await pool.query(`DELETE FROM coupons WHERE code IN (?, ?, ?)`, [`WELCOME50${suffix.toUpperCase()}`, `SAVE20${suffix.toUpperCase()}`, `FREEDEL${suffix.toUpperCase()}`]);
      await pool.query(
        `INSERT INTO coupons (
          area_id, code, title, description,
          discount_type, discount_value, max_discount_amount,
          min_order_amount, min_item_count, max_order_amount, applies_to,
          total_usage_limit, per_user_usage_limit, first_order_only,
          auto_apply, requires_code, priority, active
        ) VALUES
          (?, ?, 'Welcome Offer', ?,
            'percent', ?, ?, 0, NULL, NULL, 'all', NULL, 1, 1, 0, 1, 10, 1),
          (?, ?, 'Flat Off', ?,
            'percent', ?, ?, 0, NULL, NULL, 'all', NULL, 5, 0, 0, 1, 1, 1),
          (?, ?, 'Free Delivery', ?,
            'free_delivery', 0, NULL, ?, NULL, NULL, 'all', NULL, NULL, 0, 1, 0, 5, 1)`,
        [
          aid, `WELCOME50${suffix.toUpperCase()}`, `Flat ${area.welcomePct}% off up to ₹${area.welcomeCap} on your first order`, area.welcomePct, area.welcomeCap,
          aid, `SAVE20${suffix.toUpperCase()}`, `Flat ${area.savePct}% off, no minimum order value`, area.savePct, area.saveCap,
          aid, `FREEDEL${suffix.toUpperCase()}`, `Free delivery on orders above ₹${area.freeDelThreshold}`, area.freeDelThreshold,
        ]
      );

      areaData[aid] = { shopIds, productIds, riderIds, customerIds };
      console.log(`  Area ${aid} (${area.name}): ${shopIds.length} shops, ${productIds.length} products, ${riderIds.length} riders (2 online), ${customerIds.length} customers, ${states.length} orders, 3 coupons.`);
    }

    console.log('\nMulti-area test data seeded successfully.\n');
    console.log('Admin logins (POST /api/admin/login, {username, password}):');
    console.log(`  superadmin / ${ADMIN_PASSWORD}  (all areas)`);
    console.log(`  admin_area1 / ${ADMIN_PASSWORD}  (${AREAS[0].name} only)`);
    console.log(`  admin_area2 / ${ADMIN_PASSWORD}  (${AREAS[1].name} only)`);
    console.log('\nCustomer OTP logins (any customer phone above, e.g.):');
    console.log(`  700001000${1} .. 700001001${5}  (${AREAS[0].name} customers, last one blocked)`);
    console.log(`  700002000${1} .. 700002001${5}  (${AREAS[1].name} customers, last one blocked)`);
    console.log(`\nTest pins to drop in the app:`);
    console.log(`  ${AREAS[0].name}: ${AREAS[0].center.lat}, ${AREAS[0].center.lng}`);
    console.log(`  ${AREAS[1].name}: ${AREAS[1].center.lat}, ${AREAS[1].center.lng}`);
    process.exit(0);
  } catch (err) {
    console.error('Error seeding multi-area test data:', err);
    process.exit(1);
  }
}

seed();
