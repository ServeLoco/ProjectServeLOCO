const { pool } = require('../db/mysql');
const config = require('../config/env');
const { roundMoney } = require('../utils/money');
const { syncAreaShopOpenState } = require('../utils/shops');
const { emitToAllCustomers, emitToAdmins } = require('../realtime/socket');
const { bustAreaCaches } = require('../utils/areaScope');
const {
  listShopActiveOrders,
  confirmShopOrder,
  rejectShopOrder,
  readyShopOrder,
} = require('../services/shopOrderActions');

// Same fixed offset riders.js uses for "today" — the DB session time_zone
// isn't guaranteed to be IST, so a plain DATE(created_at) comparison can put
// late-night orders on the wrong calendar day for the ?date= filter below.
const HISTORY_TODAY_TZ = config.RIDER_TODAY_TZ || '+05:30';

// MySQL TIME columns come back as 'HH:MM:SS' — trim to 'HH:MM' for the API.
const formatTime = (t) => (t ? String(t).slice(0, 5) : null);

const shopShape = (s) => ({
  id: s.id,
  name: s.name,
  is_open: Boolean(s.is_open),
  isOpen: Boolean(s.is_open),
  active: Boolean(s.active),
  open_time: formatTime(s.open_time),
  openTime: formatTime(s.open_time),
  close_time: formatTime(s.close_time),
  closeTime: formatTime(s.close_time),
});

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /me — the owner's own shop.
const getMyShop = async (req, res) => {
  res.status(200).json({ shop: shopShape(req.shop) });
};

// PATCH /me/toggle — open/close the shop. body { is_open } (isOpen accepted too).
// Closing is blocked while the shop still has active orders (Accepted/
// Preparing, not yet rejected) — the owner must finish or cancel them first.
const toggleMyShop = async (req, res) => {
  const isOpen = req.body.is_open !== undefined ? req.body.is_open : req.body.isOpen;
  if (typeof isOpen !== 'boolean') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'is_open (boolean) is required' });
  }

  if (!isOpen) {
    const [activeRows] = await pool.query(
      `SELECT COUNT(DISTINCT o.id) as cnt
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE oi.shop_id = ? AND o.status IN ('Accepted', 'Preparing') AND oi.shop_rejected_at IS NULL`,
      [req.shop.id]
    );
    if (activeRows[0].cnt > 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Cannot close the shop while you have active orders. Finish or cancel them first.',
      });
    }
  }

  await pool.query('UPDATE shops SET is_open = ? WHERE id = ? AND area_id = ?', [isOpen ? 1 : 0, req.shop.id, req.shop.area_id]);
  const [rows] = await pool.query('SELECT id, name, is_open, active, open_time, close_time FROM shops WHERE id = ?', [req.shop.id]);
  emitToAllCustomers(req.shop.area_id, 'shop.status.updated', { shopId: req.shop.id, isOpen: Boolean(isOpen) });
  // Admin dashboard's Shops table has no other way to learn a shop owner
  // toggled their own shop — keep it in sync the same way rider toggles do.
  try {
    emitToAdmins(req.shop.area_id, 'admin.shop.updated', {
      shopId: req.shop.id,
      id: req.shop.id,
      isOpen: Boolean(isOpen),
      is_open: Boolean(isOpen),
      active: Boolean(rows[0]?.active),
    });
  } catch (_) { /* best-effort */ }
  // Keep this area's "Shop Status" banner in sync — opening this shop can
  // auto-turn it on (if delivery is available), closing it can auto-turn
  // it off (if this was the last open shop). See syncAreaShopOpenState.
  await syncAreaShopOpenState(req.shop.area_id);
  // Products from this shop appear/disappear on dashboard even when the
  // area's shop_open is unchanged — bust its micro-cache.
  await bustAreaCaches(req.shop.area_id);
  res.status(200).json({ message: 'Shop updated', shop: shopShape(rows[0]) });
};

// PATCH /me/schedule — body { openTime, closeTime } as 'HH:MM' strings, or
// both null to turn the schedule off. Purely a schedule write: it does NOT
// touch is_open itself — shopScheduleSweeper is what flips is_open the
// minute the clock crosses either boundary, exactly once, only if the shop
// isn't already in that state (so it never fights a manual toggle made at
// any other time of day).
const updateMyShopSchedule = async (req, res) => {
  const openTime = req.body.openTime !== undefined ? req.body.openTime : req.body.open_time;
  const closeTime = req.body.closeTime !== undefined ? req.body.closeTime : req.body.close_time;

  const bothNull = openTime === null && closeTime === null;
  const bothValid = HHMM_RE.test(openTime) && HHMM_RE.test(closeTime);
  if (!bothNull && !bothValid) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Provide both openTime and closeTime as "HH:MM", or both null to turn scheduling off.',
    });
  }
  if (bothValid && openTime === closeTime) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Open and close time must be different.' });
  }

  await pool.query('UPDATE shops SET open_time = ?, close_time = ? WHERE id = ? AND area_id = ?', [openTime, closeTime, req.shop.id, req.shop.area_id]);
  const [rows] = await pool.query(
    'SELECT id, name, is_open, active, open_time, close_time FROM shops WHERE id = ? AND area_id = ?',
    [req.shop.id, req.shop.area_id],
  );
  res.status(200).json({ message: 'Shop schedule updated', shop: shopShape(rows[0]) });
};

// GET /products — this shop's non-deleted products, available as a boolean,
// with group membership and variants so the Products screen doesn't need
// extra calls.
const getMyProducts = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.id, p.name, p.price, p.unit, p.image_id, p.available, p.group_id, pg.name AS group_name
     FROM products p
     LEFT JOIN product_groups pg ON pg.id = p.group_id
     WHERE p.shop_id = ? AND p.deleted = 0
     ORDER BY p.name ASC`,
    [req.shop.id]
  );

  const productIds = rows.map(p => p.id);
  const [variantRows] = productIds.length > 0
    ? await pool.query(
        `SELECT id, product_id, label, price, available, is_default
         FROM product_variants
         WHERE product_id IN (?) AND deleted = 0
         ORDER BY display_order ASC`,
        [productIds]
      )
    : [[]];

  const variantsByProduct = variantRows.reduce((map, v) => {
    if (!map[v.product_id]) map[v.product_id] = [];
    map[v.product_id].push({
      id: v.id,
      label: v.label,
      price: v.price,
      available: Boolean(v.available),
      isDefault: Boolean(v.is_default),
    });
    return map;
  }, {});

  const products = rows.map(p => ({
    ...p,
    available: Boolean(p.available),
    groupId: p.group_id,
    groupName: p.group_name,
    variants: variantsByProduct[p.id] || [],
  }));
  res.status(200).json({ products });
};

// PATCH /products/:id/toggle — flip a product's availability. Scoped to this
// shop so a wrong-shop/unknown id both surface as 404 (not distinguished).
const toggleMyProduct = async (req, res) => {
  const available = req.body.available !== undefined ? req.body.available : req.body.isAvailable;
  if (typeof available !== 'boolean') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'available (boolean) is required' });
  }
  const productId = Number(req.params.id);
  const isAvailable = Boolean(available);
  const [result] = await pool.query(
    'UPDATE products SET available = ? WHERE id = ? AND shop_id = ? AND deleted = 0',
    [isAvailable ? 1 : 0, productId, req.shop.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }
  // Customers listening on dashboard/cart drop OOS lines live (and re-show when
  // the shop marks the item available again via silent catalog refresh).
  emitToAllCustomers(req.shop.area_id, 'product.availability.updated', {
    productId,
    id: productId,
    available: isAvailable,
    shopId: req.shop.id,
  });
  // Bust the server-side dashboard/categories cache too — otherwise the socket
  // event tells clients to refetch, but they'd get the same stale (30s TTL)
  // cached response back until it naturally expires.
  await bustAreaCaches(req.shop.area_id);
  res.status(200).json({
    message: 'Product updated',
    productId, product_id: productId,
    available: isAvailable,
  });
};

// PATCH /products/:id/variants/:variantId/toggle — flip a single variant's
// availability. Joins through products to confirm both the product and the
// variant belong to this shop, so a wrong-shop id 404s like toggleMyProduct.
const toggleMyProductVariant = async (req, res) => {
  const available = req.body.available !== undefined ? req.body.available : req.body.isAvailable;
  if (typeof available !== 'boolean') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'available (boolean) is required' });
  }
  const productId = Number(req.params.id);
  const variantId = Number(req.params.variantId);
  const isAvailable = Boolean(available);
  const [result] = await pool.query(
    `UPDATE product_variants v
     JOIN products p ON p.id = v.product_id
     SET v.available = ?
     WHERE v.id = ? AND v.product_id = ? AND p.shop_id = ? AND v.deleted = 0 AND p.deleted = 0`,
    [isAvailable ? 1 : 0, variantId, productId, req.shop.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Variant not found' });
  }
  emitToAllCustomers(req.shop.area_id, 'product.availability.updated', {
    productId,
    id: productId,
    variantId,
    available: isAvailable,
    shopId: req.shop.id,
  });
  await bustAreaCaches(req.shop.area_id);
  res.status(200).json({
    message: 'Variant updated',
    productId, product_id: productId,
    variantId, variant_id: variantId,
    available: isAvailable,
  });
};

// GET /orders — orders with ≥1 of this shop's items and status Accepted/Preparing.
// Only this shop's items are returned; no prices, address, phone, or totals.
// Includes expectedMinutes (from settings, keyed by the order's delivery_type)
// so the shop-owner popup can show "Fast — 20min" / "Standard — 55min"
// without a second round trip. Rejected orders are NOT filtered out — the
// owner's dashboard shows them in a "rejected, waiting on admin" state.
const getMyOrders = async (req, res) => {
  const orders = await listShopActiveOrders(req.shop.id);
  res.status(200).json({ orders });
};

// GET /orders/history — every order this shop has ever had items on,
// any status, most recent first. Unlike getMyOrders (scoped to
// Accepted/Preparing for the live dashboard queue), this is the full order
// list for the "Orders" tab. Capped at 100 rows — this is a recent-history
// view, not a paginated report.
const getMyOrderHistory = async (req, res) => {
  const { date } = req.query;
  if (date !== undefined && !DATE_RE.test(date)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'date must be "YYYY-MM-DD"' });
  }
  const params = [req.shop.id];
  let where = 'WHERE oi.shop_id = ?';
  if (date) {
    where += " AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) = ?";
    params.push(HISTORY_TODAY_TZ, date);
  }

  const [orders] = await pool.query(
    `SELECT DISTINCT o.id, o.order_number, o.status, o.note, o.admin_remark, o.created_at, o.delivery_type
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT 100`,
    params
  );

  // Payout total is computed independently via SQL SUM rather than folding
  // over the `orders` page above (which is capped at 100 rows). Bucketed by
  // created_at — same day scoping as the order list — so the total always
  // matches the orders shown on screen.
  const [payoutRows] = await pool.query(
    `SELECT COALESCE(SUM(oi.shop_line_total), 0) as total
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     ${where}
       AND o.status = 'Delivered'
       AND oi.shop_rejected_at IS NULL
       AND oi.shop_line_total IS NOT NULL`,
    params
  );
  const payableTotal = Number(payoutRows[0].total) || 0;

  if (orders.length === 0) {
    return res.status(200).json({
      orders: [],
      payableTotal: roundMoney(payableTotal),
      payable_total: roundMoney(payableTotal),
    });
  }

  const orderIds = orders.map(o => o.id);
  const [items] = await pool.query(
    'SELECT id, order_id, product_name, quantity, variant_label, shop_line_total, shop_confirmed_at, shop_rejected_at, shop_ready_at FROM order_items WHERE shop_id = ? AND order_id IN (?) ORDER BY id ASC',
    [req.shop.id, orderIds]
  );

  const itemsByOrder = items.reduce((map, it) => {
    if (!map[it.order_id]) map[it.order_id] = [];
    map[it.order_id].push(it);
    return map;
  }, {});

  const result = orders.map(o => {
    const myItems = itemsByOrder[o.id] || [];
    const confirmed = myItems.length > 0 && myItems.every(it => it.shop_confirmed_at !== null);
    const rejected = myItems.length > 0 && myItems.every(it => it.shop_rejected_at !== null);
    const ready = myItems.length > 0 && myItems.every(it => it.shop_ready_at !== null);
    const payableItems = o.status === 'Cancelled'
      ? []
      : myItems.filter(it => it.shop_rejected_at === null && it.shop_line_total !== null && it.shop_line_total !== undefined);
    const shopTotal = roundMoney(payableItems.reduce((sum, it) => sum + Number(it.shop_line_total), 0));
    return {
      id: o.id,
      orderNumber: o.order_number,
      order_number: o.order_number,
      status: o.status,
      note: o.note,
      adminRemark: o.admin_remark,
      admin_remark: o.admin_remark,
      createdAt: o.created_at,
      created_at: o.created_at,
      deliveryType: o.delivery_type,
      delivery_type: o.delivery_type,
      confirmed,
      rejected,
      ready,
      shopTotal,
      shop_total: shopTotal,
      items: myItems.map(it => ({
        id: it.id,
        productName: it.product_name,
        product_name: it.product_name,
        quantity: it.quantity,
        variantLabel: it.variant_label,
        variant_label: it.variant_label,
        shopLineTotal: it.shop_line_total !== null ? Number(it.shop_line_total) : null,
        shop_line_total: it.shop_line_total !== null ? Number(it.shop_line_total) : null,
      })),
    };
  });

  res.status(200).json({
    orders: result,
    payableTotal: roundMoney(payableTotal),
    payable_total: roundMoney(payableTotal),
  });
};

// PATCH /orders/:orderId/confirm — mark this shop's items as confirmed.
// Idempotent: re-confirming already-confirmed items is a no-op (still 200).
const confirmMyOrder = async (req, res) => {
  const result = await confirmShopOrder(req.shop.id, req.params.orderId, {
    shopName: req.shop.name,
  });
  if (!result.ok) {
    return res.status(result.status).json({ code: result.code, message: result.message });
  }
  res.status(200).json({ message: result.message });
};

// PATCH /orders/:orderId/reject — mark this shop's items as rejected.
// Does NOT touch orders.status (informational, same as confirm) — instead
// writes a persistent admin inbox notification so the admin can act (cancel,
// reassign, contact customer). Idempotent, same status guard as confirm.
const rejectMyOrder = async (req, res) => {
  const result = await rejectShopOrder(req.shop.id, req.params.orderId, {
    shopName: req.shop.name,
  });
  if (!result.ok) {
    return res.status(result.status).json({ code: result.code, message: result.message });
  }
  res.status(200).json({ message: result.message });
};

// PATCH /orders/:orderId/ready — mark this shop's items ready for pickup.
// Requires the shop to have already confirmed the order. Idempotent, same
// status guard as confirm/reject. Informational for the admin.
const readyMyOrder = async (req, res) => {
  const result = await readyShopOrder(req.shop.id, req.params.orderId, {
    shopName: req.shop.name,
  });
  if (!result.ok) {
    return res.status(result.status).json({ code: result.code, message: result.message });
  }
  res.status(200).json({ message: result.message });
};

const groupShape = (g) => ({
  id: g.id,
  name: g.name,
  active: Boolean(g.active),
  isActive: Boolean(g.active),
  productCount: g.product_count ?? 0,
  product_count: g.product_count ?? 0,
});

// GET /groups — this shop's product groups with member counts.
const getMyGroups = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pg.id, pg.name, pg.active,
       (SELECT COUNT(*) FROM products p WHERE p.group_id = pg.id AND p.deleted = 0) AS product_count
     FROM product_groups pg
     WHERE pg.shop_id = ? AND pg.area_id = ?
     ORDER BY pg.name ASC`,
    [req.shop.id, req.shop.area_id]
  );
  res.status(200).json({ groups: rows.map(groupShape) });
};

// POST /groups — body { name }. area_id is stamped from the shop's own row
// (shops isn't gated by an admin X-Area-Id session here — this is the
// self-service shop-owner flow, TASK 15 covers shops.area_id itself).
const createMyGroup = async (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Group name is required' });
  }
  const [result] = await pool.query(
    'INSERT INTO product_groups (area_id, shop_id, name) VALUES (?, ?, ?)',
    [req.shop.area_id, req.shop.id, String(name).trim()]
  );
  const [rows] = await pool.query(
    'SELECT id, name, active, 0 AS product_count FROM product_groups WHERE id = ?',
    [result.insertId]
  );
  res.status(201).json({ group: groupShape(rows[0]) });
};

// PATCH /groups/:id — body may contain name and/or active. Scoped to this
// shop AND area — a group id from another shop 404s, never trusted by id alone.
const updateMyGroup = async (req, res) => {
  const { id } = req.params;
  const { name, active } = req.body;

  const [existing] = await pool.query(
    'SELECT id FROM product_groups WHERE id = ? AND shop_id = ? AND area_id = ?',
    [id, req.shop.id, req.shop.area_id]
  );
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  }

  const sets = [];
  const values = [];
  if (name !== undefined) {
    if (!String(name).trim()) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Group name cannot be empty' });
    }
    sets.push('name = ?');
    values.push(String(name).trim());
  }
  if (active !== undefined) {
    sets.push('active = ?');
    values.push(active ? 1 : 0);
  }
  if (sets.length > 0) {
    values.push(id);
    await pool.query(`UPDATE product_groups SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  const [rows] = await pool.query(
    `SELECT pg.id, pg.name, pg.active,
       (SELECT COUNT(*) FROM products p WHERE p.group_id = pg.id AND p.deleted = 0) AS product_count
     FROM product_groups pg WHERE pg.id = ?`,
    [id]
  );
  res.status(200).json({ message: 'Group updated', group: groupShape(rows[0]) });
};

// DELETE /groups/:id — member products become ungrouped, not deleted.
const deleteMyGroup = async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.query(
    'SELECT id FROM product_groups WHERE id = ? AND shop_id = ? AND area_id = ?',
    [id, req.shop.id, req.shop.area_id]
  );
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  }
  await pool.query('UPDATE products SET group_id = NULL WHERE group_id = ?', [id]);
  await pool.query('DELETE FROM product_groups WHERE id = ?', [id]);
  res.status(200).json({ message: 'Group deleted' });
};

// PATCH /products/:id/group — body { group_id } (null clears it). Validates
// the group belongs to this shop when non-null.
const assignMyProductGroup = async (req, res) => {
  const { id } = req.params;
  const groupId = req.body.group_id !== undefined ? req.body.group_id : req.body.groupId;

  if (groupId !== null && groupId !== undefined) {
    const [groupRows] = await pool.query(
      'SELECT id FROM product_groups WHERE id = ? AND shop_id = ? AND area_id = ?',
      [groupId, req.shop.id, req.shop.area_id]
    );
    if (groupRows.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Unknown group_id' });
    }
  }

  const [result] = await pool.query(
    'UPDATE products SET group_id = ? WHERE id = ? AND shop_id = ? AND deleted = 0',
    [groupId || null, id, req.shop.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }
  res.status(200).json({ message: 'Product group updated' });
};

module.exports = {
  getMyShop,
  toggleMyShop,
  updateMyShopSchedule,
  getMyProducts,
  toggleMyProduct,
  toggleMyProductVariant,
  getMyOrders,
  getMyOrderHistory,
  confirmMyOrder,
  rejectMyOrder,
  readyMyOrder,
  getMyGroups,
  createMyGroup,
  updateMyGroup,
  deleteMyGroup,
  assignMyProductGroup,
};
