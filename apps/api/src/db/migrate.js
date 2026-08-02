const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const config = require('../config/env');
const { getMysqlSslOptions } = require('./mysqlSsl');

// One-time backfill helpers: turn a legacy circle/square/rectangle zone
// (defined around the old shared shop-center pin) into an equivalent polygon
// boundary, so pre-existing zones survive the move to per-zone polygons.
// Only used during the delivery_zones upgrade path below.
const LEGACY_KM_PER_DEG_LAT = 110.574;
const LEGACY_KM_PER_DEG_LNG_AT_EQUATOR = 111.320;

function legacyOffsetPoint(lat, lng, dLatKm, dLngKm) {
  return {
    lat: lat + dLatKm / LEGACY_KM_PER_DEG_LAT,
    lng: lng + dLngKm / (LEGACY_KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(lat * Math.PI / 180)),
  };
}

function legacyShapeToBoundary(zone, centerLat, centerLng) {
  const shape = zone.shape || 'circle';
  if (shape === 'square') {
    const half = Number(zone.side_km) / 2 || 1;
    return [
      legacyOffsetPoint(centerLat, centerLng, -half, -half),
      legacyOffsetPoint(centerLat, centerLng, -half, half),
      legacyOffsetPoint(centerLat, centerLng, half, half),
      legacyOffsetPoint(centerLat, centerLng, half, -half),
    ];
  }
  if (shape === 'rectangle') {
    const halfW = Number(zone.width_km) / 2 || 1;
    const halfH = Number(zone.height_km) / 2 || 1;
    return [
      legacyOffsetPoint(centerLat, centerLng, -halfH, -halfW),
      legacyOffsetPoint(centerLat, centerLng, -halfH, halfW),
      legacyOffsetPoint(centerLat, centerLng, halfH, halfW),
      legacyOffsetPoint(centerLat, centerLng, halfH, -halfW),
    ];
  }
  // circle -> 24-sided polygon approximation
  const radius = Number(zone.radius_km) || 1;
  const sides = 24;
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (2 * Math.PI * i) / sides;
    points.push(legacyOffsetPoint(centerLat, centerLng, radius * Math.cos(angle), radius * Math.sin(angle)));
  }
  return points;
}

const migrate = async () => {
  let connection;
  try {
    if (!/^[a-zA-Z0-9_]+$/.test(config.MYSQL_DATABASE || '')) {
      throw new Error('MYSQL_DATABASE must contain only letters, numbers, and underscores');
    }

    // Honor SKIP_SEED_DEFAULTS to leave the database empty after a wipe.
    // Set this in .env to suppress all auto-seeded rows (settings, default
    // categories, sample products, default dashboard sections/items, and the
    // default notification templates).
    const skipSeed = String(process.env.SKIP_SEED_DEFAULTS || '').toLowerCase() === 'true';

    const ssl = getMysqlSslOptions();
    const serverConnection = await mysql.createConnection({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      ssl,
      multipleStatements: true
    });

    await serverConnection.query(`CREATE DATABASE IF NOT EXISTS \`${config.MYSQL_DATABASE}\``);
    await serverConnection.end();

    connection = await mysql.createConnection({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
      ssl,
      multipleStatements: true
    });

    console.log('Connected to MySQL. Running migrations...');

    const ensureColumn = async (tableName, columnName, columnDefinition) => {
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `, [config.MYSQL_DATABASE, tableName, columnName]);

      if (columns.length === 0) {
        await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
      }
    };

    // Users Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NULL,
        firebase_uid VARCHAR(128) NULL,
        whatsapp_number VARCHAR(20),
        address TEXT,
        short_address VARCHAR(255),
        trusted BOOLEAN DEFAULT FALSE,
        blocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_phone (phone),
        INDEX idx_firebase_uid (firebase_uid)
      );
    `);
    // Make password_hash nullable for Firebase Phone Auth users (no password).
    await connection.query('ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) NULL');
    // Firebase UID column for linking Firebase accounts to local users.
    await ensureColumn('users', 'firebase_uid',
      'firebase_uid VARCHAR(128) NULL DEFAULT NULL AFTER password_hash');
    const [shortAddressColumns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'short_address'
    `, [config.MYSQL_DATABASE]);
    if (shortAddressColumns.length === 0) {
      await connection.query('ALTER TABLE users ADD COLUMN short_address VARCHAR(255) AFTER address');
    }
    // Soft-delete (30-day grace) tracking. When deletion_requested_at is set,
    // a daily sweep hard-deletes the user after 30 days. The user can cancel
    // anytime via cancelAccountDeletion.
    await ensureColumn('users', 'deletion_requested_at',
      'deletion_requested_at TIMESTAMP NULL DEFAULT NULL AFTER blocked');
    await ensureColumn('users', 'deletion_reason',
      'deletion_reason VARCHAR(255) NULL DEFAULT NULL AFTER deletion_requested_at');
    // Expo push token registered by the customer app on login/startup.
    // Used to send real push notifications when the app is in the background.
    await ensureColumn('users', 'push_token',
      'push_token VARCHAR(255) NULL DEFAULT NULL AFTER deletion_reason');
    // Native FCM registration token (Android) for high-priority data-only
    // alarm pushes (shop/rider). Separate from Expo push_token.
    await ensureColumn('users', 'fcm_token',
      'fcm_token VARCHAR(255) NULL DEFAULT NULL AFTER push_token');
    console.log('Users table ready.');

    // Shops Table — one row per physical shop. Shop owners are normal users who
    // log in through the same Firebase OTP flow as customers; owner_user_id
    // points at a users row. is_open = the owner's day-to-day toggle;
    // active = admin-level kill switch; a shop is customer-visible only when
    // BOTH is_open AND active are 1. v1 assumes 0-or-1 shop per user; if data
    // ever contains more than one, the lowest id wins (see utils/shops.js).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS shops (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        owner_user_id INT NULL,
        is_open BOOLEAN DEFAULT TRUE,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_shop_owner (owner_user_id)
      );
    `);
    console.log('Shops table ready.');
    // Pickup pin for rider map — set manually in admin Shops page.
    await ensureColumn('shops', 'latitude', 'latitude DECIMAL(10,7) NULL AFTER active');
    await ensureColumn('shops', 'longitude', 'longitude DECIMAL(10,7) NULL AFTER latitude');
    // Optional daily auto-open/auto-close schedule. Both NULL (default) means
    // no schedule — is_open stays purely manual, unchanged from today. Set
    // together via PATCH /shop/me/schedule; the sweeper (shopScheduleSweeper)
    // flips is_open the minute the clock matches either column, then leaves it
    // alone until the next boundary — manual toggles in between are untouched.
    await ensureColumn('shops', 'open_time', 'open_time TIME NULL AFTER longitude');
    await ensureColumn('shops', 'close_time', 'close_time TIME NULL AFTER open_time');

    // Riders — delivery partners. Same Firebase OTP login as customers;
    // user_id points at a users row. active = admin kill switch; is_online =
    // day-to-day toggle. last_heartbeat_at kept for schema compat (unused for eligibility). v1: one
    // phone is either shop owner OR rider, never both (enforced in admin API).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS riders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        display_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NULL,
        active BOOLEAN DEFAULT TRUE,
        is_online BOOLEAN DEFAULT FALSE,
        last_heartbeat_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_riders_online (active, is_online, last_heartbeat_at)
      );
    `);
    console.log('Riders table ready.');
    // Live tracking: latest rider GPS only (mutable; no history table).
    await ensureColumn('riders', 'last_lat', 'last_lat DECIMAL(10,7) NULL AFTER last_heartbeat_at');
    await ensureColumn('riders', 'last_lng', 'last_lng DECIMAL(10,7) NULL AFTER last_lat');
    await ensureColumn('riders', 'last_location_at', 'last_location_at TIMESTAMP NULL DEFAULT NULL AFTER last_lng');

    // Mobile Admins — phones the owner grants Admin Mode to in the phone app.
    // Same Firebase OTP login as customers; user_id backfills on first login
    // (nullable until then since owner can add a phone before it ever logs in).
    // phone is normalized 10-digit local (matches users.phone, see authController
    // normalizedPhone). active = soft on/off; one phone is admin XOR shop XOR
    // rider, never two (enforced in admin API, mirrors shop/rider exclusivity).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS mobile_admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        display_name VARCHAR(255) NULL,
        user_id INT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mobile_admins_phone (phone),
        KEY idx_mobile_admins_user (user_id),
        KEY idx_mobile_admins_active (active)
      );
    `);
    console.log('Mobile admins table ready.');

    // Product Groups — a shop owner's own bucket of products (e.g.
    // "Starters") that can be disabled all at once. active=false hides every
    // member product from customers exactly like a closed shop (see the
    // visibility filter fragment in productController/cartController/etc).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shop_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
        INDEX idx_product_group_shop (shop_id)
      );
    `);
    console.log('Product groups table ready.');

    // Password Reset Requests Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS password_reset_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMP NULL DEFAULT NULL,
        reviewed_by_admin_id VARCHAR(50),
        review_note VARCHAR(255),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_password_reset_status (status, requested_at),
        INDEX idx_password_reset_user_status (user_id, status)
      );
    `);
    console.log('Password reset requests table ready.');
    // Track the IP that submitted each reset request so the admin can spot abuse.
    await ensureColumn('password_reset_requests', 'requester_ip', 'requester_ip VARCHAR(45) DEFAULT NULL');

    // Categories Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        type VARCHAR(50) NOT NULL,
        image_id VARCHAR(255),
        active BOOLEAN DEFAULT TRUE,
        display_order INT NOT NULL DEFAULT 0,
        deleted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_slug (slug)
      );
    `);
    const [categoryOrderColumns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'categories' AND COLUMN_NAME = 'display_order'
    `, [config.MYSQL_DATABASE]);
    if (categoryOrderColumns.length === 0) {
      await connection.query('ALTER TABLE categories ADD COLUMN display_order INT NOT NULL DEFAULT 0 AFTER active');
    }
    await ensureColumn('categories', 'deleted', 'deleted BOOLEAN DEFAULT FALSE AFTER display_order');
    console.log('Categories table ready.');

    // Store Modes Table — admin-configurable list of store "modes" (formerly
    // the hardcoded packed/fast_food pair). slug is the canonical value stored
    // on categories/combos/offers/dashboard_sections/coupons.applies_to.
    // is_system rows (packed, fast_food) can't be deleted/renamed-slug to keep
    // old app builds (which hardcode these two) working.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS store_modes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(50) NOT NULL UNIQUE,
        label VARCHAR(100) NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_store_mode_active (active, display_order)
      );
    `);
    await connection.query(`
      INSERT IGNORE INTO store_modes (slug, label, display_order, active, is_system)
      VALUES ('packed', 'Packed Items', 1, TRUE, TRUE), ('fast_food', 'Fast Food', 2, TRUE, TRUE)
    `);
    // Admin-uploaded icon shown in the mode-switcher capsule (falls back to a
    // built-in lucide icon client-side when unset). Same image_id-FK-by-
    // convention as categories/products/combos/offers — see images table.
    await ensureColumn('store_modes', 'icon_image_id', 'icon_image_id INT NULL DEFAULT NULL AFTER is_system');
    // Which mode the customer app opens into on cold start. Only one row may
    // be TRUE at a time — enforced in the controller, not a DB constraint.
    await ensureColumn('store_modes', 'is_default', 'is_default BOOLEAN NOT NULL DEFAULT FALSE AFTER icon_image_id');
    console.log('Store modes table ready.');

    // Products Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        category_id INT NOT NULL,
        unit VARCHAR(50),
        description TEXT,
        image_id VARCHAR(255),
        available BOOLEAN DEFAULT TRUE,
        is_combo BOOLEAN DEFAULT FALSE,
        featured BOOLEAN DEFAULT FALSE,
        display_order INT NOT NULL DEFAULT 0,
        original_price DECIMAL(10, 2),
        discount_label VARCHAR(50),
        deleted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
        INDEX idx_category (category_id)
      );
    `);
    await ensureColumn('products', 'is_combo', 'is_combo BOOLEAN DEFAULT FALSE AFTER available');
    await ensureColumn('products', 'featured', 'featured BOOLEAN DEFAULT FALSE AFTER is_combo');
    await ensureColumn('products', 'display_order', 'display_order INT NOT NULL DEFAULT 0 AFTER featured');
    await ensureColumn('products', 'original_price', 'original_price DECIMAL(10, 2) AFTER display_order');
    await ensureColumn('products', 'discount_label', 'discount_label VARCHAR(50) AFTER original_price');
    await ensureColumn('products', 'deleted', 'deleted BOOLEAN DEFAULT FALSE AFTER discount_label');
    await ensureColumn('products', 'available_from_time', 'available_from_time TIME NULL AFTER deleted');
    await ensureColumn('products', 'available_until_time', 'available_until_time TIME NULL AFTER available_from_time');
    // Free-text sheet subtitle ("Choose size", "Choose type"). NULL -> client
    // shows "Choose an option".
    await ensureColumn('products', 'variant_prompt', 'variant_prompt VARCHAR(100) NULL AFTER available_until_time');
    // Shop linkage. NULL = "house" product with no owning shop (always passes
    // the shop-open visibility filter). FK deliberately omitted so shop
    // deletion policy stays in application code; integrity enforced by admin UI.
    await ensureColumn('products', 'shop_id', 'shop_id INT NULL AFTER category_id');
    // Group linkage (shop owner's own grouping, e.g. "Starters"). NULL =
    // ungrouped. No FK, same rationale as shop_id above.
    await ensureColumn('products', 'group_id', 'group_id INT NULL AFTER shop_id');
    // Cost price owed to the owning shop. NULL = not configured yet (renders
    // as "—" in admin), deliberately distinct from 0.00 which means the shop
    // supplies the item free. Commission = price - shop_price, always derived.
    await ensureColumn('products', 'shop_price', 'shop_price DECIMAL(10, 2) NULL AFTER price');
    console.log('Products table ready.');

    // Product Variants Table — purchasable child rows (sizes/types) of a
    // product, each with its own label + price. products.price ALWAYS mirrors
    // the default variant's price (the backward-compat keystone). Variant rows
    // are soft-deleted (deleted = 1) so live carts / order snapshots that hold
    // variant ids keep resolving. has_variants is DERIVED client-side.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_variants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        label VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        original_price DECIMAL(10,2) NULL,
        available BOOLEAN DEFAULT TRUE,
        is_default BOOLEAN DEFAULT FALSE,
        display_order INT NOT NULL DEFAULT 0,
        deleted BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_variant_product (product_id, deleted, available)
      );
    `);
    // Per-variant cost price owed to the shop. Same NULL semantics as
    // products.shop_price, which mirrors the DEFAULT variant's value (see
    // syncProductVariants) exactly like products.price already does.
    await ensureColumn('product_variants', 'shop_price', 'shop_price DECIMAL(10, 2) NULL AFTER price');
    console.log('Product variants table ready.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS product_combo_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        combo_product_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        display_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_combo_product (combo_product_id, product_id),
        FOREIGN KEY (combo_product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        INDEX idx_combo_product (combo_product_id),
        INDEX idx_combo_item_product (product_id)
      );
    `);
    console.log('Product combo items table ready.');

    // Combos Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS combos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) NOT NULL,
        original_price DECIMAL(10, 2),
        unit VARCHAR(50),
        image_id VARCHAR(255),
        available BOOLEAN DEFAULT TRUE,
        featured BOOLEAN DEFAULT FALSE,
        display_order INT NOT NULL DEFAULT 0,
        discount_label VARCHAR(50),
        deleted BOOLEAN DEFAULT FALSE,
        store_type VARCHAR(50) NOT NULL DEFAULT 'packed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_combo_store_type (store_type)
      );
    `);
    await ensureColumn('combos', 'store_type', 'store_type VARCHAR(50) NOT NULL DEFAULT "packed" AFTER deleted');
    await connection.query('ALTER TABLE combos MODIFY COLUMN store_type VARCHAR(50) NOT NULL DEFAULT "packed"');
    console.log('Combos table ready.');

    // Combo Items Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS combo_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        combo_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        display_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_combo_item (combo_id, product_id),
        FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
        INDEX idx_combo_item_combo (combo_id),
        INDEX idx_combo_item_product (product_id)
      );
    `);
    console.log('Combo items table ready.');

    // Data Migration for Combos
    await connection.query(`
      INSERT IGNORE INTO combos (id, name, description, price, original_price, unit, image_id, available, featured, display_order, discount_label, deleted, created_at, updated_at)
      SELECT id, name, description, price, original_price, unit, image_id, available, featured, display_order, discount_label, deleted, created_at, updated_at
      FROM products
      WHERE is_combo = 1
    `);
    
    await connection.query(`
      INSERT IGNORE INTO combo_items (combo_id, product_id, quantity, display_order, created_at)
      SELECT combo_product_id, product_id, quantity, display_order, created_at
      FROM product_combo_items
    `);
    await connection.query('UPDATE products SET deleted = 1 WHERE is_combo = 1');
    console.log('Combo data migration completed.');

    // Orders Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_number VARCHAR(20) NOT NULL UNIQUE,
        customer_id INT NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        whatsapp_number VARCHAR(20),
        address TEXT NOT NULL,
        latitude DECIMAL(10, 8),
        longitude DECIMAL(11, 8),
        map_url TEXT,
        subtotal DECIMAL(10, 2) NOT NULL,
        delivery_charge DECIMAL(10, 2) NOT NULL,
        night_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
        total DECIMAL(10, 2) NOT NULL,
        payment_method ENUM('Cash', 'UPI') DEFAULT 'Cash',
        payment_status ENUM('Pending', 'Paid', 'Failed', 'Refunded', 'Success') DEFAULT 'Pending',
        status ENUM('Pending', 'Accepted', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled') DEFAULT 'Pending',
        note TEXT,
        cancel_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE RESTRICT,
        INDEX idx_customer (customer_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      );
    `);
    await connection.query(`
      ALTER TABLE orders
      MODIFY COLUMN status ENUM('Pending', 'Accepted', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled') DEFAULT 'Pending'
    `);
    // 'Success' added so a delivered order's payment auto-flips off 'Pending'
    // instead of sitting there forever (existing installs need the widen too).
    await connection.query(`
      ALTER TABLE orders
      MODIFY COLUMN payment_status ENUM('Pending', 'Paid', 'Failed', 'Refunded', 'Success') DEFAULT 'Pending'
    `);
    await ensureColumn('orders', 'delivery_distance_km', 'delivery_distance_km DECIMAL(10, 4) DEFAULT NULL AFTER longitude');
    await ensureColumn('orders', 'delivery_radius_km_snapshot', 'delivery_radius_km_snapshot DECIMAL(10, 2) DEFAULT NULL AFTER delivery_distance_km');
    await ensureColumn('orders', 'delivery_cost_per_km_snapshot', 'delivery_cost_per_km_snapshot DECIMAL(10, 2) DEFAULT NULL AFTER delivery_radius_km_snapshot');
    await ensureColumn('orders', 'free_delivery_offer_snapshot', 'free_delivery_offer_snapshot BOOLEAN DEFAULT NULL AFTER delivery_cost_per_km_snapshot');
    await ensureColumn('orders', 'delivery_type', "delivery_type ENUM('standard', 'fast') DEFAULT 'standard' AFTER free_delivery_offer_snapshot");
    // Idempotency-Key support: lets the client safely retry a Create Order
    // request on a flaky connection without creating duplicate orders. The
    // controller looks up by (customer_id, idempotency_key) within a 5-minute
    // window and returns the existing order instead of inserting a new row.
    await ensureColumn('orders', 'idempotency_key', 'idempotency_key VARCHAR(64) DEFAULT NULL AFTER delivery_type');
    await ensureColumn('orders', 'idempotency_key_created_at', 'idempotency_key_created_at DATETIME DEFAULT NULL AFTER idempotency_key');
    // Rain charge snapshot — flat amount applied at order time, same shape as night_charge.
    await ensureColumn('orders', 'rain_charge', 'rain_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER night_charge');
    // Fast delivery add-on fee snapshot — additive on top of delivery_charge
    // (the standard fee), not a replacement. 0 when standard delivery was used.
    await ensureColumn('orders', 'fast_delivery_charge', 'fast_delivery_charge DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER rain_charge');
    // Rider assignment (auto engine). No FK — integrity enforced in service layer
    // (same pattern as products.shop_id). rider_assignment_status tracks engine
    // progress; rider_picked_up_at is soft "picked up" without a new status enum.
    await ensureColumn('orders', 'rider_id', 'rider_id INT NULL AFTER cancel_reason');
    await ensureColumn('orders', 'rider_assigned_at', 'rider_assigned_at TIMESTAMP NULL DEFAULT NULL AFTER rider_id');
    await ensureColumn('orders', 'rider_picked_up_at', 'rider_picked_up_at TIMESTAMP NULL DEFAULT NULL AFTER rider_assigned_at');
    await ensureColumn('orders', 'rider_assignment_status',
      "rider_assignment_status ENUM('none','searching','offered','assigned','failed') DEFAULT 'none' AFTER rider_picked_up_at");
    // When the assignment engine first enters searching (all shops confirmed / house Accepted).
    // Used as the clock start for the 10-minute "wait for riders to come online" window.
    await ensureColumn('orders', 'rider_search_started_at',
      'rider_search_started_at TIMESTAMP NULL DEFAULT NULL AFTER rider_assignment_status');
    // Stamped exactly when status transitions to Delivered — countCompletedDeliveriesToday
    // (D8, Asia/Kolkata "today") keys off this instead of updated_at, which drifts if the
    // row is touched again later (e.g. an unrelated admin edit) after delivery.
    await ensureColumn('orders', 'delivered_at', 'delivered_at TIMESTAMP NULL DEFAULT NULL AFTER rider_search_started_at');
    // Admin-authored remark on the order (e.g. "delayed — rider shortage").
    // Distinct from `note`, which is the customer's own checkout note.
    // Visible to admins and to the shop owner (getMyOrderHistory).
    await ensureColumn('orders', 'admin_remark', 'admin_remark TEXT DEFAULT NULL AFTER note');
    // Zone-pricing snapshots: which delivery_zones row priced this order and the
    // ETA promised for the chosen delivery type. No FK — snapshots must outlive
    // zone rows (zones are hard-deleted).
    await ensureColumn('orders', 'delivery_zone_id', 'delivery_zone_id INT NULL AFTER free_delivery_offer_snapshot');
    await ensureColumn('orders', 'delivery_eta_minutes_snapshot', 'delivery_eta_minutes_snapshot INT NULL AFTER delivery_zone_id');

    // Performance indexes for common order filter queries
    const ensureIndex = async (tableName, indexName, columns) => {
      const [rows] = await connection.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        [config.MYSQL_DATABASE, tableName, indexName]
      );
      if (rows.length === 0) {
        await connection.query(`ALTER TABLE ${tableName} ADD INDEX ${indexName} (${columns})`);
      }
    };

    await ensureIndex('orders', 'idx_orders_status_created', 'status, created_at');
    await ensureIndex('orders', 'idx_orders_payment_status_created', 'payment_status, created_at');
    await ensureIndex('orders', 'idx_orders_customer_created', 'customer_id, created_at');
    // Idempotency-Key index must be UNIQUE — a non-unique index lets the
    // SELECT-then-INSERT in createOrder double-insert under load. Older
    // installs may have created a non-unique variant here; drop it first if
    // present, then ensure the unique one. (MySQL allows multiple NULLs in a
    // unique index, so orders without a key are unaffected.)
    try {
      const [idempotencyIndexRows] = await connection.query(
        `SELECT NON_UNIQUE FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_idempotency' LIMIT 1`,
        [config.MYSQL_DATABASE]
      );
      if (idempotencyIndexRows.length > 0 && Number(idempotencyIndexRows[0].NON_UNIQUE) === 1) {
        await connection.query('ALTER TABLE orders DROP INDEX idx_orders_idempotency');
      }
    } catch (e) {
      // best-effort — if the index is already gone or never existed, fall through to the ensure
    }
    try {
      await connection.query(
        'ALTER TABLE orders ADD UNIQUE INDEX idx_orders_idempotency (customer_id, idempotency_key)'
      );
    } catch (e) {
      // Index already exists (unique) — fine.
    }
    await ensureIndex('products', 'idx_products_available_deleted', 'available, deleted');
    // Hot GET /products + dashboard product_block filters: deleted+available+category.
    await ensureIndex('products', 'idx_products_deleted_available_category', 'deleted, available, category_id');
    await ensureIndex('products', 'idx_products_shop', 'shop_id');
    await ensureIndex('products', 'idx_products_group', 'group_id');
    // Dashboard section item lookups by section + type + active.
    await ensureIndex('dashboard_section_items', 'idx_dsi_section_type_active', 'section_id, item_type, active');
    await ensureIndex('orders', 'idx_orders_rider', 'rider_id, status');
    // Rider-sweeper recover scan (every ~5s): orders stuck 'searching'/'offered'
    // with no rider. Leading on rider_assignment_status because those two values
    // are rare — idx_orders_rider's rider_id-IS-NULL prefix would instead match
    // every unassigned order (most active rows).
    await ensureIndex('orders', 'idx_orders_assignment_sweep', 'rider_assignment_status, rider_id');
    // NOTE: indexes for `notifications` and `offer_products` are added after
    // those tables are created later in this file (a fresh DB has no such
    // tables yet at this point).

    console.log('Orders table ready.');

    // Daily order-number counter — atomically reserves the next sequence per
    // date so two concurrent checkouts can never produce the same order_number.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS daily_order_counters (
        counter_date DATE PRIMARY KEY,
        seq INT NOT NULL DEFAULT 0
      );
    `);
    console.log('Daily order counters table ready.');

    // Order Items Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        product_id INT NOT NULL,
        item_type VARCHAR(50) DEFAULT 'product',
        product_name VARCHAR(255) NOT NULL,
        quantity INT NOT NULL,
        unit_price DECIMAL(10, 2) NOT NULL,
        line_total DECIMAL(10, 2) NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
    `);
    await ensureColumn('order_items', 'item_type', 'item_type VARCHAR(50) DEFAULT "product" AFTER product_id');
    // Variant snapshot columns. Deliberately NO foreign key on variant_id —
    // order snapshots must outlive catalog rows (the product FK is dropped
    // below for the same reason).
    await ensureColumn('order_items', 'variant_id', 'variant_id INT NULL AFTER product_id');
    await ensureColumn('order_items', 'variant_label', 'variant_label VARCHAR(100) NULL AFTER variant_id');
    // Shop snapshot at purchase time (same rationale as product_name/unit_price
    // snapshots: order history must not change when catalog rows change). No FK.
    await ensureColumn('order_items', 'shop_id', 'shop_id INT NULL AFTER variant_label');
    // Per-shop confirmation. NULL = pending; timestamp = when the shop owner
    // pressed Confirm. Informational for the admin; does NOT gate order status.
    await ensureColumn('order_items', 'shop_confirmed_at', 'shop_confirmed_at TIMESTAMP NULL DEFAULT NULL AFTER shop_id');
    // Per-shop rejection. NULL = not rejected; timestamp = when the shop
    // owner pressed Reject. Mutually exclusive with shop_confirmed_at in
    // practice (enforced by the controller, not the schema). Notifies the
    // admin — does NOT gate order status, same as confirm.
    await ensureColumn('order_items', 'shop_rejected_at', 'shop_rejected_at TIMESTAMP NULL DEFAULT NULL AFTER shop_confirmed_at');
    // Per-shop "ready for pickup" mark. NULL = not ready; timestamp = when the
    // shop owner pressed Ready. Only valid after shop_confirmed_at is set.
    // Informational for the admin — does NOT gate order status.
    await ensureColumn('order_items', 'shop_ready_at', 'shop_ready_at TIMESTAMP NULL DEFAULT NULL AFTER shop_rejected_at');
    const [orderItemProductFks] = await connection.query(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'order_items'
        AND COLUMN_NAME = 'product_id'
        AND REFERENCED_TABLE_NAME = 'products'
    `, [config.MYSQL_DATABASE]);
    for (const fk of orderItemProductFks) {
      await connection.query(`ALTER TABLE order_items DROP FOREIGN KEY ${fk.CONSTRAINT_NAME}`);
    }
    await ensureIndex('order_items', 'idx_order_items_shop', 'shop_id, order_id');
    // Shop-cost snapshot, same rationale as the unit_price/line_total
    // snapshots above: what we owe a shop for a past order must never change
    // when the catalog is re-priced. NULL = the item had no shop price at
    // purchase time (unconfigured, or a combo, which never has a shop).
    await ensureColumn('order_items', 'shop_unit_price', 'shop_unit_price DECIMAL(10, 2) NULL AFTER unit_price');
    await ensureColumn('order_items', 'shop_line_total', 'shop_line_total DECIMAL(10, 2) NULL AFTER line_total');
    console.log('Order Items table ready.');

    // Rider order offers — sequential Accept/Reject attempts (one pending offer
    // per order enforced in the assignment service, not via a partial unique).
    // uq_offer_order_rider guarantees a rider is never re-offered the same order.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS rider_order_offers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        rider_id INT NOT NULL,
        status ENUM('pending','accepted','rejected','expired','cancelled') NOT NULL DEFAULT 'pending',
        offered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        responded_at TIMESTAMP NULL DEFAULT NULL,
        reject_reason VARCHAR(64) NULL,
        UNIQUE KEY uq_offer_order_rider (order_id, rider_id),
        INDEX idx_offer_rider_status (rider_id, status),
        INDEX idx_offer_expires (status, expires_at),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY (rider_id) REFERENCES riders(id) ON DELETE CASCADE
      );
    `);
    console.log('Rider order offers table ready.');

    // Settings Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shop_open BOOLEAN DEFAULT TRUE,
        delivery_available BOOLEAN DEFAULT TRUE,
        minimum_order_amount DECIMAL(10, 2) DEFAULT 149.00,
        delivery_charge DECIMAL(10, 2) DEFAULT 0.00,
        night_charge DECIMAL(10, 2) DEFAULT 0.00,
        night_charge_start TIME DEFAULT '21:00:00',
        night_charge_end TIME DEFAULT '07:00:00',
        whatsapp_number VARCHAR(20),
        support_phone VARCHAR(20),
        upi_id VARCHAR(100),
        upi_qr_image_id VARCHAR(255),
        /* OBSOLETE LOCATION FIELDS - kept for schema stability */
        shop_latitude DECIMAL(10, 8) DEFAULT NULL,
        shop_longitude DECIMAL(11, 8) DEFAULT NULL,
        delivery_radius_km DECIMAL(10, 2) DEFAULT 8.00,
        delivery_cost_per_km DECIMAL(10, 2) DEFAULT 0.00,
        /* END OBSOLETE FIELDS */
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    await ensureColumn('settings', 'support_phone', 'support_phone VARCHAR(20) AFTER whatsapp_number');
    await ensureColumn('settings', 'upi_qr_image_id', 'upi_qr_image_id VARCHAR(255) AFTER upi_id');
    await ensureColumn('settings', 'shop_latitude', 'shop_latitude DECIMAL(10, 8) DEFAULT NULL AFTER upi_qr_image_id');
    await ensureColumn('settings', 'shop_longitude', 'shop_longitude DECIMAL(11, 8) DEFAULT NULL AFTER shop_latitude');
    await ensureColumn('settings', 'delivery_radius_km', 'delivery_radius_km DECIMAL(10, 2) DEFAULT 8.00 AFTER shop_longitude');
    await ensureColumn('settings', 'delivery_cost_per_km', 'delivery_cost_per_km DECIMAL(10, 2) DEFAULT 0.00 AFTER delivery_radius_km');
    // below_threshold_delivery_charge / free_delivery_above_minimum_active /
    // free_delivery_offer_active are superseded by the coupon system's
    // free_delivery discount type — see the one-time migration below.
    await ensureColumn('settings', 'fast_delivery_enabled', 'fast_delivery_enabled BOOLEAN DEFAULT FALSE AFTER delivery_cost_per_km');
    await ensureColumn('settings', 'fast_delivery_charge', 'fast_delivery_charge DECIMAL(10, 2) DEFAULT 0.00 AFTER fast_delivery_enabled');
    await ensureColumn('settings', 'standard_delivery_minutes', 'standard_delivery_minutes INT DEFAULT 60 AFTER fast_delivery_charge');
    await ensureColumn('settings', 'fast_delivery_minutes', 'fast_delivery_minutes INT DEFAULT 30 AFTER standard_delivery_minutes');
    // Minimum app version required to use the app. When set (e.g. "1.2.0"),
    // any client whose app.json version is lower will see a blocking
    // "Update required" modal on launch. Null means no minimum enforced.
    await ensureColumn('settings', 'minimum_version', 'minimum_version VARCHAR(20) NULL DEFAULT NULL AFTER fast_delivery_minutes');

    // current_version: the app version currently live on the Play Store. Purely
    // informational — shown in the admin panel so the admin knows what value to
    // set minimum_version to. Admin-editable; not enforced anywhere.
    await ensureColumn('settings', 'current_version', 'current_version VARCHAR(20) NULL DEFAULT NULL AFTER minimum_version');

    // Rain charge: manual admin on/off surcharge (unlike night_charge, no time
    // window — just a flat amount added to the bill while enabled).
    await ensureColumn('settings', 'rain_charge_enabled', 'rain_charge_enabled BOOLEAN DEFAULT FALSE AFTER current_version');
    await ensureColumn('settings', 'rain_charge', 'rain_charge DECIMAL(10, 2) DEFAULT 0.00 AFTER rain_charge_enabled');
    // Radius-based zone pricing master switch. Zone pricing applies only when
    // this is on AND shop_latitude/shop_longitude are set AND at least one
    // active delivery_zones row exists — otherwise flat pricing is used.
    await ensureColumn('settings', 'radius_pricing_active', 'radius_pricing_active BOOLEAN DEFAULT FALSE AFTER rain_charge');

    // Drop free_delivery_above column if it exists (Task 1.1)
    try {
      await connection.query('ALTER TABLE settings DROP COLUMN free_delivery_above');
    } catch(e) {
      // Ignore error if column doesn't exist
    }

    // Drop delivery_time_message column if it exists (orphaned free-text field — replaced by structured minutes)
    try {
      await connection.query('ALTER TABLE settings DROP COLUMN delivery_time_message');
    } catch(e) {
      // Ignore error if column doesn't exist
    }
    
    console.log('Settings table ready.');

    // Delivery Zones — each zone is its own irregular polygon (`boundary`,
    // an array of {lat,lng} vertices), independent of any shared center pin.
    // Zones may nest: a small "sub-village" zone can carry a parent_zone_id
    // pointing at the big "village" zone that geographically contains it —
    // when a customer's point falls inside both, the child zone wins (see
    // matchZone in deliveryPricing.js), letting the child carve a
    // differently-priced hole out of its parent's coverage. Per-shape
    // duplicate-size checks from the old shape system are gone — polygons
    // aren't compared for "duplicate size"; validation lives in
    // deliveryZonesController.js (min 3 vertices, parent must exist).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS delivery_zones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NULL,
        boundary JSON NULL,
        parent_zone_id INT NULL,
        normal_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        fast_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        normal_eta_minutes INT NOT NULL DEFAULT 60,
        fast_eta_minutes INT NOT NULL DEFAULT 30,
        night_charge DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        cod_enabled TINYINT(1) NOT NULL DEFAULT 1,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_delivery_zones_parent FOREIGN KEY (parent_zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL
      );
    `);
    // Older installs: add the new columns, backfill `boundary` for any
    // pre-existing circle/square/rectangle rows using the legacy shared
    // shop-center pin, then retire the old shape columns entirely.
    await ensureColumn('delivery_zones', 'name', 'name VARCHAR(255) NULL AFTER id');
    await ensureColumn('delivery_zones', 'boundary', 'boundary JSON NULL AFTER name');
    await ensureColumn('delivery_zones', 'parent_zone_id', 'parent_zone_id INT NULL AFTER boundary');
    try {
      await connection.query(
        'ALTER TABLE delivery_zones ADD CONSTRAINT fk_delivery_zones_parent FOREIGN KEY (parent_zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL'
      );
    } catch (e) {
      // ER_DUP_KEYNAME / ER_FK_DUP_NAME just mean a previous run already added
      // it. Anything else (engine mismatch, permissions) must NOT be silently
      // swallowed — without this constraint, deleting a parent zone leaves
      // children pointing at a row that no longer exists, and the delete
      // handler's "children fall back to ON DELETE SET NULL" promise is a lie.
      const alreadyExists = e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_FK_DUP_NAME'
        || e.errno === 1061 || e.errno === 1826;
      if (!alreadyExists) throw e;
    }

    // Checked independently (not "does `shape` exist implies the rest do
    // too") — a DROP COLUMN can fail silently mid-cleanup on a prior run
    // (each drop below is its own best-effort try/catch), leaving some
    // legacy columns gone and others still present. Building the SELECT from
    // whichever of these actually exist keeps re-runs self-healing instead
    // of crashing on a column that's already gone.
    const LEGACY_SHAPE_COLUMNS = ['shape', 'radius_km', 'side_km', 'width_km', 'height_km'];
    const [existingLegacyCols] = await connection.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'delivery_zones' AND COLUMN_NAME IN (?)
    `, [config.MYSQL_DATABASE, LEGACY_SHAPE_COLUMNS]);
    const presentLegacyCols = LEGACY_SHAPE_COLUMNS.filter(
      (col) => existingLegacyCols.some((row) => row.COLUMN_NAME === col)
    );
    if (presentLegacyCols.length > 0) {
      const [legacyZones] = await connection.query(
        `SELECT id, ${presentLegacyCols.join(', ')} FROM delivery_zones WHERE boundary IS NULL`
      );
      // The legacy shapes were all defined as offsets from the shared shop
      // pin. Without a real pin there is no way to reconstruct where they
      // were, and Number(null) === 0 would happily "succeed" by placing every
      // zone at 0,0 in the Atlantic. Bail out of BOTH the backfill and the
      // column drop in that case, so the original shape values survive for a
      // later run (or a manual fix) instead of being destroyed.
      let canDropLegacyColumns = true;
      if (legacyZones.length > 0) {
        const [settingsRows] = await connection.query('SELECT shop_latitude, shop_longitude FROM settings LIMIT 1');
        const rawLat = settingsRows[0]?.shop_latitude;
        const rawLng = settingsRows[0]?.shop_longitude;
        const legacyCenterLat = Number(rawLat);
        const legacyCenterLng = Number(rawLng);
        const hasLegacyCenter = rawLat !== null && rawLat !== undefined && rawLat !== ''
          && rawLng !== null && rawLng !== undefined && rawLng !== ''
          && Number.isFinite(legacyCenterLat) && Number.isFinite(legacyCenterLng);

        if (!hasLegacyCenter) {
          canDropLegacyColumns = false;
          console.warn(
            `[migrate] ${legacyZones.length} legacy delivery zone(s) still need a polygon boundary, but ` +
            'settings.shop_latitude/shop_longitude is not set — cannot reconstruct where those shapes were. ' +
            'Keeping the legacy shape columns intact. Set the shop pin in Settings and restart, or redraw the zones by hand.'
          );
        } else {
          for (const zone of legacyZones) {
            const boundary = legacyShapeToBoundary(zone, legacyCenterLat, legacyCenterLng);
            await connection.query('UPDATE delivery_zones SET boundary = ? WHERE id = ?', [JSON.stringify(boundary), zone.id]);
          }
        }
      }
      if (canDropLegacyColumns) {
        try { await connection.query('ALTER TABLE delivery_zones DROP INDEX uq_delivery_zone_radius'); } catch (e) { /* already gone */ }
        for (const col of presentLegacyCols) {
          try { await connection.query(`ALTER TABLE delivery_zones DROP COLUMN ${col}`); } catch (e) { /* best-effort */ }
        }
      }
    }
    console.log('Delivery zones table ready.');

    // Delivery exclusion zones — independent no-delivery squares (e.g. a govt
    // building's compound) layered on top of the zone/flat pricing above.
    // Each carries its own center pin, so it can sit anywhere regardless of
    // which pricing zone contains it. Checked before zone matching in
    // resolveDeliveryPricing — a hit blocks delivery outright, even inside
    // an otherwise-deliverable zone. See utils/deliveryPricing.js.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS delivery_exclusion_zones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label VARCHAR(255) NOT NULL,
        center_lat DECIMAL(10,7) NOT NULL,
        center_lng DECIMAL(10,7) NOT NULL,
        side_km DECIMAL(6,2) NOT NULL,
        message VARCHAR(255) NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    console.log('Delivery exclusion zones table ready.');

    // Offers Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        image_id VARCHAR(255),
        active BOOLEAN DEFAULT FALSE,
        deleted BOOLEAN DEFAULT FALSE,
        store_type VARCHAR(50) NOT NULL DEFAULT 'packed',
        is_clickable BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_active (active),
        INDEX idx_offer_store_type (store_type)
      );
    `);
    await ensureColumn('offers', 'deleted', 'deleted BOOLEAN DEFAULT FALSE AFTER active');
    await ensureColumn('offers', 'store_type', 'store_type VARCHAR(50) NOT NULL DEFAULT "packed" AFTER deleted');
    await connection.query('ALTER TABLE offers MODIFY COLUMN store_type VARCHAR(50) NOT NULL DEFAULT "packed"');
    await ensureColumn('offers', 'is_clickable', 'is_clickable BOOLEAN DEFAULT FALSE AFTER store_type');
    console.log('Offers table ready.');

    // Offer Products Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS offer_products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        offer_id INT NOT NULL,
        product_id INT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY idx_offer_product (offer_id, product_id),
        INDEX idx_offer_id (offer_id),
        INDEX idx_product_id (product_id),
        INDEX idx_active (active),
        FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      );
    `);
    await ensureIndex('offer_products', 'idx_offer_products_active_display', 'offer_id, active, display_order');
    console.log('Offer products table ready.');

    // Dashboard Sections Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS dashboard_sections (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        section_type ENUM('offer_banner', 'category_grid', 'product_block', 'combo_block') NOT NULL,
        store_type VARCHAR(50) NOT NULL DEFAULT 'all',
        active BOOLEAN DEFAULT TRUE,
        display_order INT NOT NULL DEFAULT 0,
        max_visible_items INT NOT NULL DEFAULT 6,
        show_see_all BOOLEAN DEFAULT TRUE,
        show_hot_badge BOOLEAN DEFAULT FALSE,
        section_icon VARCHAR(50) DEFAULT NULL,
        linked_category_id INT DEFAULT NULL,
        linked_offer_id INT DEFAULT NULL,
        starts_at TIMESTAMP NULL DEFAULT NULL,
        ends_at TIMESTAMP NULL DEFAULT NULL,
        version INT NOT NULL DEFAULT 1,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY idx_section_store_slug (store_type, slug, deleted_at),
        INDEX idx_active (active),
        INDEX idx_display_order (display_order),
        INDEX idx_store_type (store_type)
      );
    `);
    await ensureColumn('dashboard_sections', 'starts_at', 'starts_at TIMESTAMP NULL DEFAULT NULL AFTER linked_offer_id');
    await ensureColumn('dashboard_sections', 'ends_at', 'ends_at TIMESTAMP NULL DEFAULT NULL AFTER starts_at');
    await ensureColumn('dashboard_sections', 'version', 'version INT NOT NULL DEFAULT 1 AFTER ends_at');
    await ensureColumn('dashboard_sections', 'deleted_at', 'deleted_at TIMESTAMP NULL DEFAULT NULL AFTER version');
    await ensureColumn('dashboard_sections', 'show_hot_badge', 'show_hot_badge BOOLEAN DEFAULT FALSE AFTER show_see_all');
    await ensureColumn('dashboard_sections', 'section_icon', "section_icon VARCHAR(50) DEFAULT NULL AFTER show_hot_badge");
    await connection.query('ALTER TABLE dashboard_sections MODIFY COLUMN store_type VARCHAR(50) NOT NULL DEFAULT "all"');
    console.log('Dashboard sections table ready.');
    try {
      await connection.query('ALTER TABLE dashboard_sections DROP INDEX unique_active_slug');
      await connection.query('ALTER TABLE dashboard_sections ADD UNIQUE KEY idx_section_store_slug (store_type, slug, deleted_at)');
    } catch (e) {
      // Ignored if already dropped/added
    }

    // Dashboard Section Items Table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS dashboard_section_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        section_id INT NOT NULL,
        item_type ENUM('product', 'category', 'combo', 'offer') NOT NULL,
        item_id INT NOT NULL,
        display_order INT NOT NULL DEFAULT 0,
        active BOOLEAN DEFAULT TRUE,
        starts_at TIMESTAMP NULL DEFAULT NULL,
        ends_at TIMESTAMP NULL DEFAULT NULL,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_section_item (section_id, item_type, item_id, deleted_at),
        FOREIGN KEY (section_id) REFERENCES dashboard_sections(id) ON DELETE CASCADE,
        INDEX idx_active (active),
        INDEX idx_display_order (display_order)
      );
    `);
    await ensureColumn('dashboard_section_items', 'starts_at', 'starts_at TIMESTAMP NULL DEFAULT NULL AFTER active');
    await ensureColumn('dashboard_section_items', 'ends_at', 'ends_at TIMESTAMP NULL DEFAULT NULL AFTER starts_at');
    await ensureColumn('dashboard_section_items', 'deleted_at', 'deleted_at TIMESTAMP NULL DEFAULT NULL AFTER ends_at');
    console.log('Dashboard section items table ready.');

    // ---------------------------------------------------------
    // SEED DATA (Idempotent)
    // ---------------------------------------------------------
    if (skipSeed) {
      console.log('SKIP_SEED_DEFAULTS=true — skipping all seed data.');
    } else {
    console.log('Seeding data...');

    // Seed Settings
    const [settingsRows] = await connection.query('SELECT * FROM settings LIMIT 1');
    if (settingsRows.length === 0) {
      await connection.query(`
        INSERT INTO settings (night_charge_start, night_charge_end, delivery_charge)
        VALUES ('21:00:00', '07:00:00', 20.00)
      `);
      console.log('Seeded default settings.');
    }

    // Seed Categories
    const categories = [
      { name: 'Cold Drinks', slug: 'cold-drinks', type: 'packed', display_order: 1 },
      { name: 'Snacks', slug: 'snacks', type: 'packed', display_order: 2 },
      { name: 'Fast Food', slug: 'fast-food', type: 'fast_food', display_order: 3 },
      { name: 'Groceries', slug: 'groceries', type: 'packed', display_order: 4 },
      { name: 'Desserts', slug: 'desserts', type: 'fast_food', display_order: 5 },
      { name: 'Daily Essentials', slug: 'daily-essentials', type: 'packed', display_order: 6 }
    ];

    for (const cat of categories) {
      await connection.query(`
        INSERT IGNORE INTO categories (name, slug, type, display_order) VALUES (?, ?, ?, ?)
      `, [cat.name, cat.slug, cat.type, cat.display_order]);
      await connection.query(`
        UPDATE categories SET display_order = ? WHERE slug = ? AND display_order = 0
      `, [cat.display_order, cat.slug]);
    }
    console.log('Seeded frontend categories.');

    // Seed Optional Sample Products (for local testing)
    const [catRows] = await connection.query('SELECT id, slug FROM categories');
    const catMap = catRows.reduce((acc, row) => ({ ...acc, [row.slug]: row.id }), {});

    const sampleProducts = [
      { name: 'Coca Cola', price: 40.00, category_id: catMap['cold-drinks'], unit: '750ml' },
      { name: 'Lays Classic Salted', price: 20.00, category_id: catMap['snacks'], unit: '1 Pack' },
      { name: 'Aloo Tikki Burger', price: 60.00, category_id: catMap['fast-food'], unit: '1 pc' },
      { name: 'Atta (Wheat Flour)', price: 250.00, category_id: catMap['groceries'], unit: '5kg' },
      { name: 'Chocolate Brownie', price: 90.00, category_id: catMap['desserts'], unit: '1 pc' },
      { name: 'Amul Milk', price: 33.00, category_id: catMap['daily-essentials'], unit: '500ml' }
    ];

    for (const prod of sampleProducts) {
      if (prod.category_id) {
        await connection.query(`
          INSERT INTO products (name, price, category_id, unit) 
          SELECT ?, ?, ?, ? FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM products WHERE name = ?)
        `, [prod.name, prod.price, prod.category_id, prod.unit, prod.name]);
      }
    }
    console.log('Seeded sample products.');

    // Seed Dashboard Sections (Idempotent per default section)
    console.log('Ensuring default dashboard sections...');
    const ensureDashboardSection = async ({ title, slug, sectionType, displayOrder, maxVisibleItems, showSeeAll }) => {
      const [existing] = await connection.query(
        'SELECT id FROM dashboard_sections WHERE slug = ? LIMIT 1',
        [slug]
      );
      if (existing.length > 0) return { id: existing[0].id, isNew: false };

      const [result] = await connection.query(`
        INSERT INTO dashboard_sections (title, slug, section_type, store_type, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon)
        VALUES (?, ?, ?, 'all', ?, ?, ?, 0, NULL)
      `, [title, slug, sectionType, displayOrder, maxVisibleItems, showSeeAll]);
      return { id: result.insertId, isNew: true };
    };

    // Item seeding below only runs the first time a default section is created,
    // so admins retain full control over what appears once the layout exists —
    // newly created categories/combos are never auto-injected on later restarts.

    const { id: offerSectionId, isNew: offerSectionIsNew } = await ensureDashboardSection({
      title: 'Special Offers',
      slug: 'hero-offers',
      sectionType: 'offer_banner',
      displayOrder: 0,
      maxVisibleItems: 1,
      showSeeAll: false
    });

    if (offerSectionIsNew) {
      const [activeOffers] = await connection.query('SELECT id FROM offers WHERE active = 1 AND deleted = 0 LIMIT 1');
      if (activeOffers.length > 0) {
        await connection.query(`
          INSERT INTO dashboard_section_items (section_id, item_type, item_id, display_order)
          SELECT ?, 'offer', ?, 0 FROM DUAL
          WHERE NOT EXISTS (
            SELECT 1 FROM dashboard_section_items
            WHERE section_id = ? AND item_type = 'offer' AND item_id = ?
          )
        `, [offerSectionId, activeOffers[0].id, offerSectionId, activeOffers[0].id]);
      }
    }

    const { id: catSectionId, isNew: catSectionIsNew } = await ensureDashboardSection({
      title: 'Shop by Category',
      slug: 'categories-grid',
      sectionType: 'category_grid',
      displayOrder: 1,
      maxVisibleItems: 8,
      showSeeAll: false
    });

    if (catSectionIsNew) {
      const [activeCats] = await connection.query('SELECT id, display_order FROM categories WHERE active = 1 AND deleted = 0 ORDER BY display_order ASC, id ASC');
      for (const cat of activeCats) {
        await connection.query(`
          INSERT INTO dashboard_section_items (section_id, item_type, item_id, display_order)
          SELECT ?, 'category', ?, ? FROM DUAL
          WHERE NOT EXISTS (
            SELECT 1 FROM dashboard_section_items
            WHERE section_id = ? AND item_type = 'category' AND item_id = ?
          )
        `, [catSectionId, cat.id, cat.display_order, catSectionId, cat.id]);
      }
    }

    const { id: comboSectionId, isNew: comboSectionIsNew } = await ensureDashboardSection({
      title: 'Popular Combos',
      slug: 'popular-combos',
      sectionType: 'combo_block',
      displayOrder: 2,
      maxVisibleItems: 6,
      showSeeAll: true
    });

    if (comboSectionIsNew) {
      const [activeCombos] = await connection.query('SELECT id FROM combos WHERE available = 1 AND deleted = 0 ORDER BY display_order ASC, id ASC');
      let comboOrder = 0;
      for (const combo of activeCombos) {
        await connection.query(`
          INSERT INTO dashboard_section_items (section_id, item_type, item_id, display_order)
          SELECT ?, 'combo', ?, ? FROM DUAL
          WHERE NOT EXISTS (
            SELECT 1 FROM dashboard_section_items
            WHERE section_id = ? AND item_type = 'combo' AND item_id = ?
          )
        `, [comboSectionId, combo.id, comboOrder++, comboSectionId, combo.id]);
      }
    }
    console.log('Default dashboard sections and items ready.');
    } // end if (!skipSeed)

    // Notification Batches Table (for Admin broadcasts)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notification_batches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        type VARCHAR(50) NOT NULL,
        target VARCHAR(50) NOT NULL,
        recipient_count INT NOT NULL DEFAULT 0,
        created_by_admin_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL
      );
    `);
    console.log('Notification batches table ready.');

    // Notifications Table (per-user rows)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        type VARCHAR(50) NOT NULL,
        source_type VARCHAR(50),
        source_id INT,
        event_key VARCHAR(100),
        batch_id INT,
        action_type VARCHAR(50),
        action_payload JSON,
        read_at TIMESTAMP NULL DEFAULT NULL,
        seen_at TIMESTAMP NULL DEFAULT NULL,
        created_by_admin_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (batch_id) REFERENCES notification_batches(id) ON DELETE SET NULL,
        INDEX idx_notifications_user_created (user_id, created_at),
        INDEX idx_notifications_user_read (user_id, read_at),
        INDEX idx_notifications_source (source_type, source_id),
        INDEX idx_notifications_batch (batch_id),
        INDEX idx_notifications_deleted (deleted_at),
        UNIQUE KEY uniq_notification_event (user_id, source_type, source_id, event_key)
      );
    `);
    await ensureIndex('notifications', 'idx_notifications_user_unread', 'user_id, read_at, deleted_at');
    console.log('Notifications table ready.');

    // Cleanup: Convert 'all' offer banner sections to 'packed' and 'fast_food'
    const [allOfferSections] = await connection.query(`SELECT * FROM dashboard_sections WHERE section_type = 'offer_banner' AND store_type = 'all' AND deleted_at IS NULL`);
    
    for (const sec of allOfferSections) {
      // 1. Create packed section
      const [packedResult] = await connection.query(
        `INSERT INTO dashboard_sections (title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at)
         VALUES (?, ?, ?, 'packed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sec.title, sec.slug + '-packed', sec.section_type, sec.active, sec.display_order, sec.max_visible_items, sec.show_see_all, sec.show_hot_badge, sec.section_icon, sec.linked_category_id, sec.linked_offer_id, sec.starts_at, sec.ends_at, sec.version, sec.created_at, sec.updated_at]
      );
      const packedId = packedResult.insertId;

      // 2. Create fast_food section
      const [fastFoodResult] = await connection.query(
        `INSERT INTO dashboard_sections (title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at)
         VALUES (?, ?, ?, 'fast_food', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sec.title, sec.slug + '-fast-food', sec.section_type, sec.active, sec.display_order, sec.max_visible_items, sec.show_see_all, sec.show_hot_badge, sec.section_icon, sec.linked_category_id, sec.linked_offer_id, sec.starts_at, sec.ends_at, sec.version, sec.created_at, sec.updated_at]
      );
      const fastFoodId = fastFoodResult.insertId;

      // 3. Move items
      const [items] = await connection.query(
        `SELECT dsi.*, o.store_type as offer_store_type
         FROM dashboard_section_items dsi
         JOIN offers o ON o.id = dsi.item_id
         WHERE dsi.section_id = ? AND dsi.item_type = 'offer'`,
        [sec.id]
      );

      for (const item of items) {
        if (item.offer_store_type === 'packed') {
          await connection.query(
            `INSERT INTO dashboard_section_items (section_id, item_type, item_id, active, display_order, created_at, updated_at)
             VALUES (?, 'offer', ?, ?, ?, ?, ?)`,
            [packedId, item.item_id, item.active, item.display_order, item.created_at, item.updated_at]
          );
        } else if (item.offer_store_type === 'fast_food') {
          await connection.query(
            `INSERT INTO dashboard_section_items (section_id, item_type, item_id, active, display_order, created_at, updated_at)
             VALUES (?, 'offer', ?, ?, ?, ?, ?)`,
            [fastFoodId, item.item_id, item.active, item.display_order, item.created_at, item.updated_at]
          );
        }
      }

      // 4. Mark old section as deleted
      await connection.query(`UPDATE dashboard_sections SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, [sec.id]);
    }

    // Notification Templates Table (for admin-customizable messages)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS notification_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_key VARCHAR(50) NOT NULL UNIQUE,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        enabled TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_event_key (event_key)
      );
    `);

    if (!skipSeed) {
    const defaultTemplates = [
      { event_key: 'order_placed',            title: '🎉 Order Confirmed!',        body: "Your order has been placed successfully. We'll notify you once it's accepted." },
      { event_key: 'status_accepted',          title: '✅ Order Accepted!',          body: 'Great news! Your order has been accepted and will be prepared shortly.' },
      { event_key: 'status_preparing',         title: '👨‍🍳 Preparing Your Order',   body: 'Your delicious order is being prepared with care. Hang tight!' },
      { event_key: 'status_out_for_delivery',  title: '🚚 On The Way!',             body: 'Your order is out for delivery. It will reach you soon!' },
      { event_key: 'status_delivered',         title: '🎊 Delivered!',              body: 'Your order has been delivered. Enjoy your meal!' },
      { event_key: 'status_cancelled',         title: '❌ Order Cancelled',          body: 'Your order was cancelled. Contact us if you need help.' },
      { event_key: 'payment_paid',             title: '💰 Payment Received',        body: 'Your payment has been confirmed. Thank you!' },
      { event_key: 'payment_failed',           title: '⚠️ Payment Issue',           body: 'Payment failed. Please try again or contact support.' },
      { event_key: 'payment_refunded',         title: '💸 Refund Processed',        body: 'Your payment has been refunded successfully.' },
      { event_key: 'rider_assigned',           title: '🛵 Rider Assigned',          body: 'A delivery partner has accepted your order and will pick it up soon.' },
      { event_key: 'rider_picked_up',          title: '📦 Order Picked Up',         body: 'Your order has been picked up and is heading your way.' },
    ];

    for (const t of defaultTemplates) {
      await connection.query(
        `INSERT INTO notification_templates (event_key, title, body) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body)`,
        [t.event_key, t.title, t.body]
      );
    }
    } // end if (!skipSeed) for notification_templates
    console.log('Notification templates table ready.');

    // ---------------------------------------------------------
    // COUPONS — admin-managed discount codes & auto-apply offers.
    // A coupon is a single rule (flat / percent / free_delivery)
    // that subtracts a Discount line from the cart grand total.
    // Only ONE coupon applies per order (no stacking): if the user
    // enters a code it wins; otherwise the best auto-apply offer is
    // picked. Usage is tracked in coupon_redemptions (per-user +
    // global caps). Targeting can be all users or a selected subset
    // (coupon_users). Scheduling supports a date window, day-of-week
    // bitmask, and an optional time-of-day window.
    // ---------------------------------------------------------
    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupons (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(40) NULL,
        title VARCHAR(120) NOT NULL,
        description TEXT,

        -- Discount rule
        discount_type ENUM('flat','percent','free_delivery') NOT NULL DEFAULT 'flat',
        discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
        max_discount_amount DECIMAL(10,2) NULL,

        -- Eligibility
        min_order_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        min_item_count INT NULL,
        max_order_amount DECIMAL(10,2) NULL,
        applies_to VARCHAR(50) NOT NULL DEFAULT 'all',

        -- Scheduling / time window
        starts_at DATETIME NULL,
        ends_at DATETIME NULL,
        active_days_mask TINYINT NULL,
        active_time_start TIME NULL,
        active_time_end TIME NULL,

        -- Usage limits
        total_usage_limit INT NULL,
        per_user_usage_limit INT NULL DEFAULT 1,
        first_order_only TINYINT(1) NOT NULL DEFAULT 0,
        first_n_orders INT NULL,

        -- Targeting
        target_audience ENUM('all','selected') NOT NULL DEFAULT 'all',

        -- Behaviour
        auto_apply TINYINT(1) NOT NULL DEFAULT 0,
        requires_code TINYINT(1) NOT NULL DEFAULT 1,
        priority INT NOT NULL DEFAULT 0,

        -- Lifecycle
        active TINYINT(1) NOT NULL DEFAULT 1,
        deleted TINYINT(1) NOT NULL DEFAULT 0,
        created_by_admin_id VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        INDEX idx_coupons_active_window (active, deleted, starts_at, ends_at),
        INDEX idx_coupons_code (code),
        INDEX idx_coupons_auto_apply (auto_apply, active, deleted)
      );
    `);
    // Ensure columns exist for databases created before coupons were added.
    await ensureColumn('coupons', 'min_item_count', 'min_item_count INT NULL AFTER min_order_amount');
    await ensureColumn('coupons', 'max_order_amount', 'max_order_amount DECIMAL(10,2) NULL AFTER min_item_count');
    await ensureColumn('coupons', 'active_days_mask', 'active_days_mask TINYINT NULL AFTER ends_at');
    await ensureColumn('coupons', 'first_n_orders', 'first_n_orders INT NULL AFTER first_order_only');
    await ensureColumn('coupons', 'target_audience', "target_audience ENUM('all','selected') NOT NULL DEFAULT 'all' AFTER first_n_orders");
    await ensureColumn('coupons', 'priority', 'priority INT NOT NULL DEFAULT 0 AFTER requires_code');
    await ensureColumn('coupons', 'created_by_admin_id', 'created_by_admin_id VARCHAR(50) NULL AFTER deleted');
    // Lets a flat/percent coupon ALSO waive standard delivery, without
    // needing a separate discount_type. Ignored when discount_type is
    // already 'free_delivery' (that type already waives delivery alone).
    await ensureColumn('coupons', 'also_free_delivery', 'also_free_delivery TINYINT(1) NOT NULL DEFAULT 0 AFTER discount_type');
    await connection.query('ALTER TABLE coupons MODIFY COLUMN applies_to VARCHAR(50) NOT NULL DEFAULT "all"');
    // Enforce code uniqueness among non-deleted coupons. A plain UNIQUE
    // index would block re-creating a soft-deleted code, so we scope
    // uniqueness to deleted = 0 (NULL is treated as distinct by MySQL,
    // which is exactly what we want: multiple deleted rows can share
    // a code, but only one live row may hold it).
    try {
      await connection.query(
        'ALTER TABLE coupons ADD UNIQUE KEY uniq_live_coupon_code (code, deleted)'
      );
    } catch (e) {
      // Index already exists — fine.
    }
    console.log('Coupons table ready.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupon_redemptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        coupon_id INT NOT NULL,
        user_id INT NOT NULL,
        order_id INT NOT NULL,
        discount_amount DECIMAL(10,2) NOT NULL,
        -- Redemptions are soft-cancelled (never deleted) when their order is
        -- cancelled, so quota restoration stays auditable. Only 'active' rows
        -- count toward per-user/global usage limits.
        status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
        redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
        INDEX idx_redemption_user_coupon (user_id, coupon_id),
        INDEX idx_redemption_coupon (coupon_id),
        INDEX idx_redemption_order (order_id)
      );
    `);
    await ensureColumn('coupon_redemptions', 'status', "status ENUM('active','cancelled') NOT NULL DEFAULT 'active' AFTER discount_amount");
    console.log('Coupon redemptions table ready.');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupon_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        coupon_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_coupon_user (coupon_id, user_id),
        FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_coupon_users_coupon (coupon_id),
        INDEX idx_coupon_users_user (user_id)
      );
    `);
    console.log('Coupon users table ready.');

    // Zone targeting mirrors user targeting: 'all' (every zone, incl. flat/
    // non-zone pricing) or 'selected' (coupon_zones rows gate eligibility).
    // A cart/order with no matched zone (flat pricing, or radius pricing off)
    // is only blocked by a 'selected' coupon if it actually requires a zone —
    // see isZoneTargeted in utils/coupons.js for the exact semantics.
    await ensureColumn('coupons', 'target_zones', "target_zones ENUM('all','selected') NOT NULL DEFAULT 'all' AFTER target_audience");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS coupon_zones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        coupon_id INT NOT NULL,
        delivery_zone_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_coupon_zone (coupon_id, delivery_zone_id),
        FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
        FOREIGN KEY (delivery_zone_id) REFERENCES delivery_zones(id) ON DELETE CASCADE,
        INDEX idx_coupon_zones_coupon (coupon_id),
        INDEX idx_coupon_zones_zone (delivery_zone_id)
      );
    `);
    console.log('Coupon zones table ready.');

    // Snapshot coupon details on the order so reports/refunds survive
    // even if the coupon is later edited or soft-deleted.
    await ensureColumn('orders', 'coupon_id', 'coupon_id INT NULL AFTER total');
    await ensureColumn('orders', 'coupon_code', 'coupon_code VARCHAR(40) NULL AFTER coupon_id');
    await ensureColumn('orders', 'coupon_title', 'coupon_title VARCHAR(120) NULL AFTER coupon_code');
    await ensureColumn('orders', 'discount_amount', 'discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER coupon_title');
    // Snapshots the delivery-waiver portion of discount_amount so bill
    // displays can show "Delivery: FREE" + the remaining item discount
    // separately, even if the coupon is later edited/deleted.
    await ensureColumn('orders', 'free_delivery_waiver_amount', 'free_delivery_waiver_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER discount_amount');

    // ---------------------------------------------------------
    // ONE-TIME MIGRATION: replace the threshold/blanket delivery-fee
    // settings with an equivalent free_delivery coupon, then drop the old
    // columns. Guarded by presence of free_delivery_offer_active so this
    // block is a no-op on every run after the first (self-idempotent,
    // no separate migration-marker needed).
    // ---------------------------------------------------------
    const [oldDeliveryColumns] = await connection.query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'settings' AND COLUMN_NAME = 'free_delivery_offer_active'
    `, [config.MYSQL_DATABASE]);

    if (oldDeliveryColumns.length > 0) {
      const [settingsSnapshotRows] = await connection.query(`
        SELECT id, minimum_order_amount, delivery_charge, below_threshold_delivery_charge,
               free_delivery_above_minimum_active, free_delivery_offer_active
        FROM settings LIMIT 1
      `);

      if (settingsSnapshotRows.length > 0) {
        const { planFreeDeliveryMigration } = require('./migrateFreeDeliveryCoupon');
        const snapshot = settingsSnapshotRows[0];
        const { coupon, deliveryChargeUpdate, warning } = planFreeDeliveryMigration(snapshot);

        if (warning) {
          console.warn(warning);
        }

        if (coupon) {
          await connection.query(
            `INSERT INTO coupons (code, title, description, discount_type, discount_value,
               min_order_amount, applies_to, total_usage_limit, per_user_usage_limit,
               target_audience, auto_apply, requires_code, priority, active, created_by_admin_id)
             VALUES (?, ?, ?, ?, ?, ?, 'all', NULL, NULL, 'all', 1, 0, 0, 1, 'system-migration')`,
            [coupon.code, coupon.title, coupon.description, coupon.discount_type,
              coupon.discount_value, coupon.min_order_amount]
          );
          console.log(`[migrate] Seeded system free_delivery coupon (min_order_amount=${coupon.min_order_amount}) to replicate prior delivery-fee settings.`);
        }

        if (deliveryChargeUpdate !== null) {
          await connection.query('UPDATE settings SET delivery_charge = ? WHERE id = ?', [deliveryChargeUpdate, snapshot.id]);
          console.log(`[migrate] Reconciled settings.delivery_charge to ${deliveryChargeUpdate}.`);
        }
      }

      const oldDeliveryFeeColumns = [
        'minimum_order_amount',
        'below_threshold_delivery_charge',
        'free_delivery_above_minimum_active',
        'free_delivery_offer_active',
      ];
      for (const column of oldDeliveryFeeColumns) {
        try {
          await connection.query(`ALTER TABLE settings DROP COLUMN ${column}`);
        } catch (e) {
          // Ignore error if column doesn't exist
        }
      }
      console.log('[migrate] Dropped deprecated threshold delivery-fee columns from settings.');
    }

    // Admin Inbox — notifications shown in the admin panel bell.
    // Separate from `notifications` (customer-facing) because admin ids are
    // strings (owner id) and `notifications.user_id` is INT FK → users(id).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        related_url VARCHAR(255) NULL,
        related_id VARCHAR(64) NULL,
        read_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_notifications_unread (read_at, created_at),
        INDEX idx_admin_notifications_type (type, created_at)
      );
    `);
    // Deduplicate retry-prone events. Customer signups and order creates that
    // get retried by the client produce two fire-and-forget notifications;
    // this UNIQUE KEY + INSERT IGNORE makes them collapse to one row.
    try {
      await connection.query(
        'ALTER TABLE admin_notifications ADD UNIQUE KEY uniq_admin_inbox_event (type, related_id)'
      );
    } catch (e) {
      // Index already exists — fine.
    }
    console.log('Admin inbox table ready.');

    // Images — metadata for uploaded images (products/categories/combos/
    // offers/settings). Actual bytes live in S3 or local disk; this table
    // only stores the pointer + metadata. Replaces the MongoDB `images`
    // collection (legacy_mongo_id lets the one-time backfill script be
    // re-run safely by skipping rows already copied).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS images (
        id INT AUTO_INCREMENT PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        mime_type VARCHAR(100),
        size INT,
        storage_type ENUM('s3', 'disk') NOT NULL,
        url TEXT NOT NULL,
        alt_text VARCHAR(500),
        legacy_mongo_id VARCHAR(24) NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_legacy_mongo_id (legacy_mongo_id)
      );
    `);
    // Optional 320px WebP thumbnail URL (nullable for legacy images until backfill).
    await ensureColumn('images', 'thumb_url', 'thumb_url TEXT NULL AFTER url');
    console.log('Images table ready.');

    // Admin session revocation + brute-force lockout — single row (there is
    // one shared owner admin account, not a users table).
    // - revoked_before: any admin JWT whose `iat` is at or before this is
    //   rejected by requireAdmin even though its signature/expiry are still
    //   valid. Kill switch for a leaked token that doesn't require rotating
    //   JWT_SECRET (which would also nuke every customer session).
    // - failed_attempts / locked_until: account-level lockout independent of
    //   the per-IP login rate limiter, so a distributed brute force (many
    //   source IPs) still gets stopped.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_auth_state (
        id INT PRIMARY KEY DEFAULT 1,
        revoked_before TIMESTAMP NULL DEFAULT NULL,
        failed_attempts INT NOT NULL DEFAULT 0,
        locked_until TIMESTAMP NULL DEFAULT NULL
      );
    `);
    await ensureColumn('admin_auth_state', 'failed_attempts', 'failed_attempts INT NOT NULL DEFAULT 0');
    await ensureColumn('admin_auth_state', 'locked_until', 'locked_until TIMESTAMP NULL DEFAULT NULL');
    await connection.query(`
      INSERT IGNORE INTO admin_auth_state (id, revoked_before) VALUES (1, NULL)
    `);
    console.log('Admin auth state table ready.');

    // Switch the 5 image-reference columns from VARCHAR (holding the legacy
    // Mongo ObjectId hex string) to INT (holding the new `images.id`). Only
    // safe to run after the one-time backfill script has rewritten every
    // value to a plain numeric string — guarded so it's a no-op on repeat
    // deploys once the column is already INT.
    const convertImageIdColumnToInt = async (tableName, columnName) => {
      const [columns] = await connection.query(`
        SELECT DATA_TYPE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `, [config.MYSQL_DATABASE, tableName, columnName]);
      if (columns.length === 0 || columns[0].DATA_TYPE === 'int') return;

      // Second line of defense beyond deploy ordering: if the backfill
      // script hasn't rewritten every value to a plain numeric string yet
      // (e.g. this deploy landed before someone ran it), converting the
      // column now would corrupt every non-numeric value. Skip and warn
      // instead of risking data loss — safe to re-run once backfilled.
      const [nonNumeric] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE ${columnName} IS NOT NULL AND ${columnName} NOT REGEXP '^[0-9]+$'`
      );
      if (Number(nonNumeric[0].cnt) > 0) {
        console.warn(`[migrate] Skipping ${tableName}.${columnName} INT conversion — ${nonNumeric[0].cnt} non-numeric value(s) still present. Run the backfill script first.`);
        return;
      }

      await connection.query(`ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} INT NULL`);
    };
    await convertImageIdColumnToInt('products', 'image_id');
    await convertImageIdColumnToInt('categories', 'image_id');
    await convertImageIdColumnToInt('combos', 'image_id');
    await convertImageIdColumnToInt('offers', 'image_id');
    await convertImageIdColumnToInt('settings', 'upi_qr_image_id');
    console.log('Image reference columns ready.');

    // ============================================================
    // MULTI-AREA EXPANSION — see plans/multi-area.md for the full design.
    // Area 1 is the existing single-tenant install; nothing below changes
    // its behavior until later tasks (TASK 7+) start reading area_id.
    // ============================================================

    // ---- TASK 1 — areas table + seed Area 1 --------------------------
    await connection.query(`
      CREATE TABLE IF NOT EXISTS areas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(16) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
        min_lat DECIMAL(10,7) NULL,
        max_lat DECIMAL(10,7) NULL,
        min_lng DECIMAL(10,7) NULL,
        max_lng DECIMAL(10,7) NULL,
        catalog_version BIGINT NOT NULL DEFAULT 1,
        brand_color VARCHAR(9) NULL,
        logo_image_id INT NULL,
        features JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_areas_active_bbox (active, min_lat, max_lat)
      );
    `);
    await connection.query(`
      INSERT IGNORE INTO areas (id, code, name, is_default) VALUES (1, 'A1', 'Area 1', 1)
    `);
    console.log('Areas table ready.');

    // ---- TASK 2 — admins table + per-admin session state -------------
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('super_admin', 'area_admin') NOT NULL,
        area_id INT NULL,
        display_name VARCHAR(255) NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE RESTRICT,
        INDEX idx_admins_active_area (active, area_id)
      );
    `);
    console.log('Admins table ready.');

    await ensureColumn('admin_auth_state', 'admin_id', 'admin_id INT NULL DEFAULT NULL');

    // Bootstrap: seed one super_admin from the legacy env password so the
    // existing login keeps working immediately after this deploy. Fires
    // only while `admins` is empty — adminController.js's login (TASK 7)
    // falls back to the env password under the same condition, and logs a
    // warning when it does. Once any admin row exists (this seed, or one
    // created via the admin API), the env-password path stops being used.
    const [adminCountRows] = await connection.query('SELECT COUNT(*) AS cnt FROM admins');
    if (Number(adminCountRows[0].cnt) === 0) {
      const bootstrapHash = config.ADMIN_PASSWORD_HASH
        || (config.ADMIN_PASSWORD ? await bcrypt.hash(config.ADMIN_PASSWORD, 10) : null);
      if (bootstrapHash) {
        await connection.query(
          `INSERT INTO admins (username, password_hash, role, area_id, display_name)
           VALUES (?, ?, 'super_admin', NULL, 'Super Admin')`,
          [config.ADMIN_OWNER_ID || 'admin', bootstrapHash]
        );
        console.log('[migrate] Seeded initial super_admin from ADMIN_PASSWORD_HASH/ADMIN_PASSWORD env.');
      } else {
        console.warn('[migrate] No admins exist and no ADMIN_PASSWORD_HASH/ADMIN_PASSWORD set — admin login will fail until an admin is seeded.');
      }
    }

    // ---- TASK 3 — area_id columns, backfill, indexes, unique keys ----
    //
    // Order matters throughout this block (plans/multi-area.md §6.2):
    //   nullable column -> batched backfill -> verify zero orphans ->
    //   NOT NULL -> foreign key -> composite indexes -> unique key rewrites
    // Skipping the orphan check, or adding NOT NULL before backfill
    // completes, silently produces area_id = 0 rows with no matching area.

    // MySQL 8 only grants ALGORITHM=INSTANT to a column add when it has no
    // AFTER clause (appended at the end of the row). ensureColumn (above)
    // always accepts an AFTER-qualified definition for other migrations —
    // area_id must never use one, or adding it to a large table like
    // `orders` becomes a multi-minute rebuild on deploy. See §3.6.
    const ensureColumnAtEnd = async (tableName, columnName, columnDefinition) => {
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `, [config.MYSQL_DATABASE, tableName, columnName]);
      if (columns.length === 0) {
        await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
      }
    };

    // Batched + resumable: WHERE area_id IS NULL means a re-run after a
    // crash mid-backfill picks up exactly where it left off and never
    // re-touches already-set rows.
    const AREA_BACKFILL_BATCH_SIZE = 5000;
    const backfillAreaIdToDefault = async (tableName, pkColumn = 'id') => {
      for (;;) {
        const [result] = await connection.query(
          `UPDATE ${tableName} SET area_id = 1
           WHERE area_id IS NULL
           ORDER BY ${pkColumn}
           LIMIT ${AREA_BACKFILL_BATCH_SIZE}`
        );
        if (result.affectedRows === 0) break;
      }
    };

    // Hard gate: refuse to proceed to NOT NULL/FK if any row still has no
    // area_id, or points at an area that doesn't exist. An orphan here
    // becomes a customer seeing "no delivery" or an admin silently losing
    // a row from every scoped query — discovered only in production.
    const assertNoAreaOrphans = async (tableName) => {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM ${tableName}
         WHERE area_id IS NULL OR area_id NOT IN (SELECT id FROM areas)`
      );
      const cnt = Number(rows[0].cnt);
      if (cnt > 0) {
        throw new Error(`[migrate] ${tableName} has ${cnt} row(s) with an invalid area_id after backfill — aborting before NOT NULL/FK.`);
      }
    };

    const ensureForeignKey = async (tableName, fkName, ddl) => {
      try {
        await connection.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${fkName} ${ddl}`);
      } catch (e) {
        // ER_DUP_KEYNAME / ER_FK_DUP_NAME / errno 1061 (dup index) / 1826
        // (dup FK) just mean a previous run already added it. Anything
        // else must not be silently swallowed — see the delivery_zones
        // parent FK above for the same reasoning.
        const alreadyExists = e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_FK_DUP_NAME'
          || e.errno === 1061 || e.errno === 1826;
        if (!alreadyExists) throw e;
      }
    };

    const dropIndexIfExists = async (tableName, indexName) => {
      const [rows] = await connection.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        [config.MYSQL_DATABASE, tableName, indexName]
      );
      if (rows.length > 0) {
        await connection.query(`ALTER TABLE ${tableName} DROP INDEX ${indexName}`);
      }
    };

    const ensureUniqueIndex = async (tableName, indexName, columns) => {
      const [rows] = await connection.query(
        `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
        [config.MYSQL_DATABASE, tableName, indexName]
      );
      if (rows.length === 0) {
        await connection.query(`ALTER TABLE ${tableName} ADD UNIQUE INDEX ${indexName} (${columns})`);
      }
    };

    // Every table §1.1/§3.3 scopes to an area. `users` is deliberately
    // absent — customers are global (§2.2). `daily_order_counters`'
    // PRIMARY KEY change is deliberately deferred to TASK 13, where it
    // lands in the same commit as the order-number generator query it
    // must stay in lockstep with (§6.3) — do not add it here.
    const AREA_SCOPED_TABLES = [
      'shops', 'riders', 'mobile_admins', 'delivery_zones', 'delivery_exclusion_zones',
      'settings', 'orders', 'order_items', 'coupons', 'offers',
      'dashboard_sections', 'dashboard_section_items', 'categories', 'products', 'combos',
      'product_groups', 'store_modes', 'admin_notifications', 'notification_batches',
    ];

    for (const tableName of AREA_SCOPED_TABLES) {
      await ensureColumnAtEnd(tableName, 'area_id', 'area_id INT NULL');
    }
    console.log('[migrate] area_id column present (nullable) on all scoped tables.');

    for (const tableName of AREA_SCOPED_TABLES) {
      await backfillAreaIdToDefault(tableName, 'id');
    }
    console.log('[migrate] area_id backfilled to Area 1 on all scoped tables.');

    for (const tableName of AREA_SCOPED_TABLES) {
      await assertNoAreaOrphans(tableName);
    }
    console.log('[migrate] area_id orphan check passed on all scoped tables.');

    for (const tableName of AREA_SCOPED_TABLES) {
      const [col] = await connection.query(`
        SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'area_id'
      `, [config.MYSQL_DATABASE, tableName]);
      if (col[0] && col[0].IS_NULLABLE === 'YES') {
        await connection.query(`ALTER TABLE ${tableName} MODIFY COLUMN area_id INT NOT NULL`);
      }
    }
    console.log('[migrate] area_id set NOT NULL on all scoped tables.');

    for (const tableName of AREA_SCOPED_TABLES) {
      await ensureForeignKey(tableName, `fk_${tableName}_area`, 'FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE RESTRICT');
    }
    console.log('[migrate] area_id foreign keys added on all scoped tables.');

    // Composite indexes leading with area_id (§3.3). The single-column
    // orders.idx_status / idx_created_at these partially supersede are
    // deliberately NOT dropped here — that is a separate, later deploy
    // (§6.2 rule 5), so production never runs a window unindexed.
    await ensureIndex('orders', 'idx_orders_area_status_created', 'area_id, status, created_at');
    await ensureIndex('orders', 'idx_orders_area_created', 'area_id, created_at');
    await ensureIndex('orders', 'idx_orders_area_customer_created', 'area_id, customer_id, created_at');
    await ensureIndex('products', 'idx_products_area_category_available_order', 'area_id, category_id, available, display_order');
    await ensureIndex('products', 'idx_products_area_deleted_available', 'area_id, deleted, available');
    await ensureIndex('categories', 'idx_categories_area_active_order', 'area_id, active, display_order');
    await ensureIndex('dashboard_sections', 'idx_dashboard_sections_area_store_active_order', 'area_id, store_type, active, display_order');
    await ensureIndex('delivery_zones', 'idx_delivery_zones_area_active', 'area_id, active');
    await ensureIndex('shops', 'idx_shops_area_active_open', 'area_id, active, is_open');
    await ensureIndex('riders', 'idx_riders_area_active_online', 'area_id, active, is_online');
    await ensureIndex('coupons', 'idx_coupons_area_deleted_active', 'area_id, deleted, active');
    await ensureIndex('offers', 'idx_offers_area_active_deleted', 'area_id, active, deleted');
    console.log('[migrate] area_id composite indexes added.');

    // Per-area UNIQUE key rewrites (§1.3). The OLD global key is dropped
    // BEFORE the new composite is added (§6.2 rule 4) — if it survived,
    // a later per-area INSERT IGNORE (e.g. TASK 11 seeding packed/
    // fast_food store_modes into a new area) would silently insert
    // nothing, because the stale global key still considers the slug taken.
    await dropIndexIfExists('categories', 'slug');
    await ensureUniqueIndex('categories', 'uniq_categories_area_slug', 'area_id, slug');

    await dropIndexIfExists('store_modes', 'slug');
    await ensureUniqueIndex('store_modes', 'uniq_store_modes_area_slug', 'area_id, slug');

    await dropIndexIfExists('coupons', 'uniq_live_coupon_code');
    await ensureUniqueIndex('coupons', 'uniq_coupons_area_code_deleted', 'area_id, code, deleted');

    await dropIndexIfExists('dashboard_sections', 'idx_section_store_slug');
    await ensureUniqueIndex('dashboard_sections', 'idx_section_area_store_slug', 'area_id, store_type, slug, deleted_at');

    await dropIndexIfExists('admin_notifications', 'uniq_admin_inbox_event');
    await ensureUniqueIndex('admin_notifications', 'uniq_admin_inbox_area_event', 'area_id, type, related_id');
    console.log('[migrate] per-area unique keys in place.');

    // ---- TASK 11 — store_modes seeded per area, not just area 1 ---------
    // The original seed (above, table-creation time) only ever ran once
    // and only covers whichever area existed when the table was first
    // created (area 1). Any area created after that point starts with
    // zero store_modes rows unless seeded here — INSERT IGNORE against
    // uniq_store_modes_area_slug makes this idempotent across reruns.
    {
      const [areaRows] = await connection.query('SELECT id FROM areas');
      for (const { id: areaIdToSeed } of areaRows) {
        await connection.query(
          `INSERT IGNORE INTO store_modes (area_id, slug, label, display_order, active, is_system)
           VALUES (?, 'packed', 'Packed Items', 1, TRUE, TRUE), (?, 'fast_food', 'Fast Food', 2, TRUE, TRUE)`,
          [areaIdToSeed, areaIdToSeed]
        );
      }
    }
    console.log('[migrate] store_modes is_system rows seeded per area.');

    // ---- TASK 9 — settings becomes genuinely one row per area ----------
    // `settings` was never a UNIQUE-key-enforced singleton — every query
    // just relied on there only ever being one row and used LIMIT 1. Now
    // that it's one row PER AREA (settingsController.js), the same "just
    // one row" assumption needs a real constraint, or a duplicate INSERT
    // (e.g. two concurrent requests both finding zero rows for a brand new
    // area) creates a second row that LIMIT-1-style reads pick between
    // unpredictably. Safe to add now — exactly one settings row exists
    // (area 1's) at this point in the rollout.
    await ensureUniqueIndex('settings', 'uniq_settings_area', 'area_id');
    console.log('[migrate] settings.area_id unique key in place.');

    // users.last_area_id — a cold-start cache (§2.2), NOT an authorization
    // input, and deliberately NO foreign key (a stale/wrong cached area is
    // harmless; areas are deactivate-only per §6.8 so it could never
    // dangle anyway). Backfilled from order history: a user who has
    // ordered before transacted within Area 1, the only area that can
    // exist at this point in the rollout — the §6.6 gate blocks a second
    // area from being created before TASK 30's isolation sweep passes.
    // Real per-request point-in-zone resolution (areaScope.js, TASK 6)
    // takes over going forward; this backfill only seeds history.
    await ensureColumnAtEnd('users', 'last_area_id', 'last_area_id INT NULL DEFAULT NULL');
    for (;;) {
      const [result] = await connection.query(`
        UPDATE users u
        SET last_area_id = 1
        WHERE u.last_area_id IS NULL
          AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = u.id)
        ORDER BY u.id
        LIMIT ${AREA_BACKFILL_BATCH_SIZE}
      `);
      if (result.affectedRows === 0) break;
    }
    console.log('[migrate] users.last_area_id backfilled from order history.');

    console.log('Migration and seeding completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

// CLI: `node src/db/migrate.js` / npm run db:migrate*
// Also importable from initDB for `npm run dev` (which does not shell-run migrate).
if (require.main === module) {
  migrate();
}

module.exports = { migrate };
