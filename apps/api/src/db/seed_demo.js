require('dotenv').config();

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
  console.error('Refusing to run demo seed in production. Set ALLOW_DEMO_SEED=true to override.');
  process.exit(1);
}

const { pool } = require('./mysql');
const { getDb, connect } = require('./mongodb');

async function seedDemoData() {
  console.log('Seeding demo data...');

  try {
    await connect();
    // 1. Settings and Offers — area_id = 1 (Area 1): this script only ever
    // seeds the default area (see plans/multi-area.md §2.12).
    await pool.query('INSERT IGNORE INTO settings (id, area_id, shop_open, delivery_charge) VALUES (1, 1, 1, 10)');
    await pool.query('DELETE FROM offers WHERE title = "Weekend Snack Combo"');
    await pool.query('INSERT INTO offers (area_id, title, description, active) VALUES (1, "Weekend Snack Combo", "Get 20% extra on all snacks this weekend!", 1)');

    // 2. Customers — OTP-only, no password
    await pool.query(
      `INSERT INTO users (name, phone, whatsapp_number, address, trusted, blocked)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        whatsapp_number = VALUES(whatsapp_number),
        address = VALUES(address),
        trusted = VALUES(trusted),
        blocked = VALUES(blocked)`,
      ['Demo User', '9999999999', '9999999999', '123 Demo Street', 1, 0]
    );
    await pool.query(
      `INSERT INTO users (name, phone, whatsapp_number, address, trusted, blocked)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        whatsapp_number = VALUES(whatsapp_number),
        address = VALUES(address),
        trusted = VALUES(trusted),
        blocked = VALUES(blocked)`,
      ['Blocked User', '8888888888', '8888888888', '456 Bad Street', 0, 1]
    );

    const [customerRows] = await pool.query('SELECT id FROM users WHERE phone = ?', ['9999999999']);
    const customerId = customerRows[0].id;

    await pool.query(`
      DELETE oi FROM order_items oi
      INNER JOIN orders o ON oi.order_id = o.id
      WHERE o.order_number LIKE 'SL-DEMO-%'
    `);
    await pool.query('DELETE FROM orders WHERE order_number LIKE "SL-DEMO-%"');

    // 3. Categories — insert if they don't exist
    await pool.query('INSERT IGNORE INTO categories (area_id, name, slug, type, active) VALUES (1, "Fast Food", "fast-food", "fast_food", 1)');
    await pool.query('INSERT IGNORE INTO categories (area_id, name, slug, type, active) VALUES (1, "Packed Items", "packed-items", "packed", 1)');

    const [fastFoodCat] = await pool.query('SELECT id FROM categories WHERE slug = "fast-food"');
    const [packedCat] = await pool.query('SELECT id FROM categories WHERE slug = "packed-items"');

    if (!fastFoodCat[0] || !packedCat[0]) {
      throw new Error('Required categories not found. Run npm run db:migrate first.');
    }

    // Mock Image in MongoDB
    const db = getDb();
    const imageDoc = {
      filename: 'demo-image.jpg',
      url: `${process.env.PUBLIC_BASE_URL || 'http://10.0.2.2:3000'}/uploads/demo-image.jpg`,
      storageType: 'disk',
      mimeType: 'image/jpeg',
      size: 1024,
      uploadedAt: new Date()
    };
    const imgResult = await db.collection('images').insertOne(imageDoc);
    const imageId = imgResult.insertedId.toString();

    // 4. Products
    // Fast Food — with image
    await pool.query(
      `INSERT INTO products (area_id, name, category_id, price, unit, available, image_id)
       SELECT ?, ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)`,
      [1, 'Demo Burger', fastFoodCat[0].id, 150, 'piece', 1, imageId, 'Demo Burger']
    );
    const [demoBurgerRows] = await pool.query('SELECT id FROM products WHERE name = ?', ['Demo Burger']);

    // Packed Item — no image
    await pool.query(
      `INSERT INTO products (area_id, name, category_id, price, unit, available)
       SELECT ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)`,
      [1, 'Demo Chips', packedCat[0].id, 20, 'packet', 1, 'Demo Chips']
    );
    const [demoChipsRows] = await pool.query('SELECT id FROM products WHERE name = ?', ['Demo Chips']);

    // Unavailable product
    await pool.query(
      `INSERT INTO products (area_id, name, category_id, price, unit, available)
       SELECT ?, ?, ?, ?, ?, ? FROM DUAL
       WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)`,
      [1, 'Out of Stock Item', packedCat[0].id, 50, 'packet', 0, 'Out of Stock Item']
    );

    const demoBurgerId = demoBurgerRows[0].id;
    const demoChipsId = demoChipsRows[0].id;

    // 5. Orders in various states — include all required NOT NULL columns
    const states = ['Pending', 'Accepted', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

    for (let i = 0; i < states.length; i++) {
      const orderNumber = `SL-DEMO-${1000 + i}`;
      const status = states[i];
      const paymentStatus = (status === 'Delivered') ? 'Paid' : 'Pending';

      const [orderRes] = await pool.query(
        'INSERT INTO orders (area_id, order_number, customer_id, customer_name, phone, address, subtotal, delivery_charge, night_charge, total, status, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [1, orderNumber, customerId, 'Demo User', '9999999999', '123 Demo Street', 160, 10, 0, 170, status, 'Cash', paymentStatus]
      );

      await pool.query(
        'INSERT INTO order_items (area_id, order_id, product_id, product_name, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, orderRes.insertId, demoBurgerId, 'Demo Burger', 1, 150, 150]
      );
      await pool.query(
        'INSERT INTO order_items (area_id, order_id, product_id, product_name, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1, orderRes.insertId, demoChipsId, 'Demo Chips', 1, 20, 20]
      );
    }

    // 6. Coupons — a representative spread of discount types/rules for
    // exercising the admin panel and customer coupon UI against real data.
    await pool.query(
      "DELETE FROM coupons WHERE code IN ('WELCOME50', 'FREEDEL', 'SAVE20', 'COMBO30', 'FREEDEL3', 'ORDER299')"
    );
    await pool.query(
      `INSERT INTO coupons (
        area_id, code, title, description,
        discount_type, discount_value, max_discount_amount,
        min_order_amount, min_item_count, max_order_amount, applies_to,
        total_usage_limit, per_user_usage_limit, first_order_only,
        auto_apply, requires_code, priority, active
      ) VALUES
        (1, 'WELCOME50', 'Welcome Offer', 'Flat 50% off up to ₹100 on your first order',
          'percent', 50, 100, 0, NULL, NULL, 'all', NULL, 1, 1, 0, 1, 10, 1),
        (1, 'FREEDEL', 'Free Delivery', 'Free delivery on orders above ₹199',
          'free_delivery', 0, NULL, 199, NULL, NULL, 'all', NULL, NULL, 0, 1, 0, 5, 1),
        (1, 'SAVE20', 'Flat 20% Off', 'Flat 20% off, no minimum order value',
          'percent', 20, 150, 0, NULL, NULL, 'all', NULL, 5, 0, 0, 1, 1, 1),
        (1, 'COMBO30', 'Combo Meal Deal', '30% off on combo meals over ₹300',
          'percent', 30, 200, 300, NULL, NULL, 'fast_food', 500, 3, 0, 0, 1, 3, 1),
        (1, 'FREEDEL3', 'Free Delivery (3 items)', 'Free delivery when you add 3 or more items',
          'free_delivery', 0, NULL, 0, 3, NULL, 'all', NULL, NULL, 0, 1, 0, 6, 1),
        (1, 'ORDER299', '₹50 off + 2 items', '₹50 off when order is ₹299+ and has 2+ items',
          'flat', 50, NULL, 299, 2, NULL, 'all', NULL, NULL, 0, 0, 1, 4, 1)`
    );

    console.log('Demo data seeded successfully.');
    console.log('Test credentials: phone=9999999999 (OTP login)');
    process.exit(0);
  } catch (err) {
    console.error('Error seeding demo data:', err);
    process.exit(1);
  }
}

seedDemoData();
