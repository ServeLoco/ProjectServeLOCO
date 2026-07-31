const { pool } = require('../db/mysql');
const { roundMoney } = require('../utils/money');
const { getActiveStoreModeSlugs, isSystemModeSlug } = require('../utils/storeMode');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const toBool = (val) => (val === true || val === 'true' || val === 1 || val === '1');

const toNullIfEmpty = (val) => {
  if (val === undefined || val === null || val === '') return null;
  return val;
};

const toIntOrNull = (val) => {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
};

const toMoneyOrNull = (val) => {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
};

// Type-aware discount_value validation shared by create and update:
// percent must be within [0, 100]; flat must be ≥ 0. computeDiscount caps the
// result at subtotal either way, but an out-of-range value is always an admin
// mistake (a 500% coupon or a negative flat amount), so reject it up front.
const validateDiscountValue = (discountType, discountValue) => {
  if (discountType === 'free_delivery') return null;
  const value = Number(discountValue);
  if (!Number.isFinite(value) || value < 0) {
    return 'discount_value must be a non-negative number';
  }
  if (discountType === 'percent' && value > 100) {
    return 'Percent discount cannot exceed 100';
  }
  if (discountType === 'flat' && value > 5000) {
    return 'Flat discount cannot exceed ₹5000';
  }
  return null;
};

const computeStatus = (coupon, now = new Date()) => {
  if (!coupon.active) return 'Inactive';
  if (coupon.deleted) return 'Deleted';
  if (coupon.starts_at && new Date(coupon.starts_at) > now) return 'Scheduled';
  if (coupon.ends_at && new Date(coupon.ends_at) < now) return 'Expired';
  return 'Active';
};

const enrichCoupon = async (coupon) => {
  // Only 'active' redemptions count — cancelled orders soft-cancel their
  // redemption row, restoring the quota (see orderController/adminController).
  const [redeemRows] = await pool.query(
    "SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as unique_users, COALESCE(SUM(discount_amount),0) as total_discounted FROM coupon_redemptions WHERE coupon_id = ? AND status = 'active'",
    [coupon.id]
  );
  const stats = redeemRows[0] || {};
  return {
    ...coupon,
    status: computeStatus(coupon),
    totalRedemptions: Number(stats.total) || 0,
    uniqueUsers: Number(stats.unique_users) || 0,
    totalDiscounted: roundMoney(Number(stats.total_discounted) || 0),
  };
};

// ─────────────────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────────────────

const getAdminCoupons = async (req, res) => {
  const { status, active, auto_apply, target_audience, target_zones, applies_to } = req.query;

  let query = 'SELECT * FROM coupons WHERE deleted = 0';
  const params = [];

  if (active !== undefined) {
    query += ' AND active = ?';
    params.push(toBool(active) ? 1 : 0);
  }
  if (auto_apply !== undefined) {
    query += ' AND auto_apply = ?';
    params.push(toBool(auto_apply) ? 1 : 0);
  }
  if (target_audience) {
    query += ' AND target_audience = ?';
    params.push(target_audience);
  }
  if (target_zones) {
    query += ' AND target_zones = ?';
    params.push(target_zones);
  }
  if (applies_to) {
    query += ' AND applies_to = ?';
    params.push(applies_to);
  }

  query += ' ORDER BY id DESC';

  const [rows] = await pool.query(query, params);
  const enriched = await Promise.all(rows.map(enrichCoupon));

  let result = enriched;
  if (status) {
    result = enriched.filter(c => c.status.toLowerCase() === String(status).toLowerCase());
  }

  res.status(200).json({ data: result });
};

const getAdminCouponById = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM coupons WHERE id = ? AND deleted = 0', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Coupon not found' });
  }
  const coupon = await enrichCoupon(rows[0]);

  if (coupon.target_audience === 'selected') {
    const [userRows] = await pool.query(
      `SELECT cu.user_id, u.name, u.phone FROM coupon_users cu
       JOIN users u ON cu.user_id = u.id
       WHERE cu.coupon_id = ? ORDER BY u.name ASC`,
      [id]
    );
    coupon.targetedUsers = userRows;
  } else {
    coupon.targetedUsers = [];
  }

  if (coupon.target_zones === 'selected') {
    const [zoneRows] = await pool.query(
      `SELECT cz.delivery_zone_id, dz.name
       FROM coupon_zones cz
       JOIN delivery_zones dz ON cz.delivery_zone_id = dz.id
       WHERE cz.coupon_id = ? ORDER BY dz.id ASC`,
      [id]
    );
    coupon.targetedZones = zoneRows;
  } else {
    coupon.targetedZones = [];
  }

  res.status(200).json({ data: coupon });
};

const createCoupon = async (req, res) => {
  const adminId = req.admin?.id || null;
  const b = req.body;

  if (!b.title || typeof b.title !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Title is required' });
  }
  if (!b.discount_type || !['flat', 'percent', 'free_delivery'].includes(b.discount_type)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'discount_type must be flat, percent, or free_delivery' });
  }
  if (b.discount_type !== 'free_delivery' && (b.discount_value === undefined || b.discount_value === null)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'discount_value must be a non-negative number' });
  }
  const discountValueError = validateDiscountValue(b.discount_type, b.discount_value);
  if (discountValueError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: discountValueError });
  }

  let code = toNullIfEmpty(b.code);
  if (code) {
    code = String(code).trim().toUpperCase();
    const [existing] = await pool.query('SELECT id FROM coupons WHERE code = ? AND deleted = 0', [code]);
    if (existing.length > 0) {
      return res.status(409).json({ code: 'CONFLICT', message: 'A coupon with this code already exists' });
    }
  }

  const requiresCode = b.requires_code !== undefined ? toBool(b.requires_code) : true;
  if (requiresCode && !code) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Code is required when requires_code is true' });
  }

  const autoApply = b.auto_apply !== undefined ? toBool(b.auto_apply) : false;
  const targetAudience = b.target_audience === 'selected' ? 'selected' : 'all';
  const targetZones = b.target_zones === 'selected' ? 'selected' : 'all';
  let appliesTo = 'all';
  if (b.applies_to === 'all' || isSystemModeSlug(b.applies_to)) {
    appliesTo = b.applies_to;
  } else if (b.applies_to !== undefined) {
    const activeModeSlugs = await getActiveStoreModeSlugs();
    if (activeModeSlugs.includes(b.applies_to)) appliesTo = b.applies_to;
  }

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO coupons (
        code, title, description,
        discount_type, also_free_delivery, discount_value, max_discount_amount,
        min_order_amount, min_item_count, max_order_amount, applies_to,
        starts_at, ends_at, active_days_mask, active_time_start, active_time_end,
        total_usage_limit, per_user_usage_limit, first_order_only, first_n_orders,
        target_audience, target_zones, auto_apply, requires_code, priority,
        active, created_by_admin_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        code,
        b.title.trim(),
        toNullIfEmpty(b.description) || '',
        b.discount_type,
        b.discount_type !== 'free_delivery' && toBool(b.also_free_delivery) ? 1 : 0,
        b.discount_type === 'free_delivery' ? 0 : Number(b.discount_value),
        toMoneyOrNull(b.max_discount_amount),
        Number(b.min_order_amount) || 0,
        toIntOrNull(b.min_item_count),
        toMoneyOrNull(b.max_order_amount),
        appliesTo,
        toNullIfEmpty(b.starts_at),
        toNullIfEmpty(b.ends_at),
        toIntOrNull(b.active_days_mask),
        toNullIfEmpty(b.active_time_start),
        toNullIfEmpty(b.active_time_end),
        toIntOrNull(b.total_usage_limit),
        toIntOrNull(b.per_user_usage_limit) !== null ? toIntOrNull(b.per_user_usage_limit) : 1,
        toBool(b.first_order_only) ? 1 : 0,
        toIntOrNull(b.first_n_orders),
        targetAudience,
        targetZones,
        autoApply ? 1 : 0,
        requiresCode ? 1 : 0,
        Number(b.priority) || 0,
        adminId,
      ]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: 'CONFLICT', message: 'A coupon with this code already exists' });
    }
    throw err;
  }

  const couponId = result.insertId;

  if (targetAudience === 'selected' && Array.isArray(b.targeted_user_ids) && b.targeted_user_ids.length > 0) {
    const values = b.targeted_user_ids.map(uid => [couponId, Number(uid)]);
    await pool.query('INSERT IGNORE INTO coupon_users (coupon_id, user_id) VALUES ?', [values]);
  }

  if (targetZones === 'selected' && Array.isArray(b.targeted_zone_ids) && b.targeted_zone_ids.length > 0) {
    const values = b.targeted_zone_ids.map(zid => [couponId, Number(zid)]);
    await pool.query('INSERT IGNORE INTO coupon_zones (coupon_id, delivery_zone_id) VALUES ?', [values]);
  }

  res.status(201).json({ message: 'Coupon created', id: couponId });
};

const updateCoupon = async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const [existingRows] = await pool.query('SELECT * FROM coupons WHERE id = ? AND deleted = 0', [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Coupon not found' });
  }
  const existing = existingRows[0];

  // Validate the EFFECTIVE discount type/value combination — either side may
  // be unchanged in this request (e.g. editing only discount_value on a
  // percent coupon, or switching a flat-500 coupon to percent).
  if (b.discount_type !== undefined || b.discount_value !== undefined) {
    const finalType = b.discount_type !== undefined ? b.discount_type : existing.discount_type;
    const finalValue = b.discount_value !== undefined ? b.discount_value : existing.discount_value;
    const discountValueError = validateDiscountValue(finalType, finalValue);
    if (discountValueError) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: discountValueError });
    }
  }

  const updates = [];
  const params = [];

  if (b.code !== undefined) {
    let code = toNullIfEmpty(b.code);
    if (code) {
      code = String(code).trim().toUpperCase();
      const [dupe] = await pool.query('SELECT id FROM coupons WHERE code = ? AND deleted = 0 AND id != ?', [code, id]);
      if (dupe.length > 0) {
        return res.status(409).json({ code: 'CONFLICT', message: 'A coupon with this code already exists' });
      }
    }
    updates.push('code = ?');
    params.push(code);
  }

  if (b.title !== undefined) { updates.push('title = ?'); params.push(String(b.title).trim()); }
  if (b.description !== undefined) { updates.push('description = ?'); params.push(toNullIfEmpty(b.description) || ''); }
  if (b.discount_type !== undefined) {
    if (!['flat', 'percent', 'free_delivery'].includes(b.discount_type)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'discount_type must be flat, percent, or free_delivery' });
    }
    updates.push('discount_type = ?');
    params.push(b.discount_type);
  }
  if (b.also_free_delivery !== undefined) {
    const finalType = b.discount_type !== undefined ? b.discount_type : existing.discount_type;
    updates.push('also_free_delivery = ?');
    params.push(finalType !== 'free_delivery' && toBool(b.also_free_delivery) ? 1 : 0);
  }
  if (b.discount_value !== undefined) { updates.push('discount_value = ?'); params.push(Number(b.discount_value)); }
  if (b.max_discount_amount !== undefined) { updates.push('max_discount_amount = ?'); params.push(toMoneyOrNull(b.max_discount_amount)); }
  if (b.min_order_amount !== undefined) { updates.push('min_order_amount = ?'); params.push(Number(b.min_order_amount)); }
  if (b.min_item_count !== undefined) { updates.push('min_item_count = ?'); params.push(toIntOrNull(b.min_item_count)); }
  if (b.max_order_amount !== undefined) { updates.push('max_order_amount = ?'); params.push(toMoneyOrNull(b.max_order_amount)); }
  if (b.applies_to !== undefined) {
    const activeModeSlugs = await getActiveStoreModeSlugs();
    if (!['all', ...activeModeSlugs].includes(b.applies_to)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `applies_to must be all, ${activeModeSlugs.join(', ')}` });
    }
    updates.push('applies_to = ?');
    params.push(b.applies_to);
  }
  if (b.starts_at !== undefined) { updates.push('starts_at = ?'); params.push(toNullIfEmpty(b.starts_at)); }
  if (b.ends_at !== undefined) { updates.push('ends_at = ?'); params.push(toNullIfEmpty(b.ends_at)); }
  if (b.active_days_mask !== undefined) { updates.push('active_days_mask = ?'); params.push(toIntOrNull(b.active_days_mask)); }
  if (b.active_time_start !== undefined) { updates.push('active_time_start = ?'); params.push(toNullIfEmpty(b.active_time_start)); }
  if (b.active_time_end !== undefined) { updates.push('active_time_end = ?'); params.push(toNullIfEmpty(b.active_time_end)); }
  if (b.total_usage_limit !== undefined) { updates.push('total_usage_limit = ?'); params.push(toIntOrNull(b.total_usage_limit)); }
  if (b.per_user_usage_limit !== undefined) { updates.push('per_user_usage_limit = ?'); params.push(toIntOrNull(b.per_user_usage_limit)); }
  if (b.first_order_only !== undefined) { updates.push('first_order_only = ?'); params.push(toBool(b.first_order_only) ? 1 : 0); }
  if (b.first_n_orders !== undefined) { updates.push('first_n_orders = ?'); params.push(toIntOrNull(b.first_n_orders)); }
  if (b.target_audience !== undefined) {
    updates.push('target_audience = ?');
    params.push(b.target_audience === 'selected' ? 'selected' : 'all');
  }
  if (b.target_zones !== undefined) {
    updates.push('target_zones = ?');
    params.push(b.target_zones === 'selected' ? 'selected' : 'all');
  }
  if (b.auto_apply !== undefined) { updates.push('auto_apply = ?'); params.push(toBool(b.auto_apply) ? 1 : 0); }
  if (b.requires_code !== undefined) { updates.push('requires_code = ?'); params.push(toBool(b.requires_code) ? 1 : 0); }
  if (b.priority !== undefined) { updates.push('priority = ?'); params.push(Number(b.priority) || 0); }
  if (b.active !== undefined) { updates.push('active = ?'); params.push(toBool(b.active) ? 1 : 0); }

  if (updates.length === 0 && b.targeted_user_ids === undefined && b.targeted_zone_ids === undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid fields provided' });
  }

  if (updates.length > 0) {
    params.push(id);
    try {
      await pool.query(`UPDATE coupons SET ${updates.join(', ')} WHERE id = ?`, params);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ code: 'CONFLICT', message: 'A coupon with this code already exists' });
      }
      throw err;
    }
  }

  if (b.targeted_user_ids !== undefined) {
    await pool.query('DELETE FROM coupon_users WHERE coupon_id = ?', [id]);
    const targetAudience = b.target_audience ? (b.target_audience === 'selected' ? 'selected' : 'all') : existing.target_audience;
    if (targetAudience === 'selected' && Array.isArray(b.targeted_user_ids) && b.targeted_user_ids.length > 0) {
      const values = b.targeted_user_ids.map(uid => [Number(id), Number(uid)]);
      await pool.query('INSERT IGNORE INTO coupon_users (coupon_id, user_id) VALUES ?', [values]);
    }
  }

  if (b.targeted_zone_ids !== undefined) {
    await pool.query('DELETE FROM coupon_zones WHERE coupon_id = ?', [id]);
    const targetZones = b.target_zones ? (b.target_zones === 'selected' ? 'selected' : 'all') : existing.target_zones;
    if (targetZones === 'selected' && Array.isArray(b.targeted_zone_ids) && b.targeted_zone_ids.length > 0) {
      const values = b.targeted_zone_ids.map(zid => [Number(id), Number(zid)]);
      await pool.query('INSERT IGNORE INTO coupon_zones (coupon_id, delivery_zone_id) VALUES ?', [values]);
    }
  }

  res.status(200).json({ message: 'Coupon updated' });
};

const deleteCoupon = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT id FROM coupons WHERE id = ? AND deleted = 0', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Coupon not found' });
  }
  await pool.query('UPDATE coupons SET deleted = 1, active = 0 WHERE id = ?', [id]);
  res.status(200).json({ message: 'Coupon deleted' });
};

const duplicateCoupon = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM coupons WHERE id = ? AND deleted = 0', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Coupon not found' });
  }
  const c = rows[0];

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO coupons (
        code, title, description,
        discount_type, also_free_delivery, discount_value, max_discount_amount,
        min_order_amount, min_item_count, max_order_amount, applies_to,
        starts_at, ends_at, active_days_mask, active_time_start, active_time_end,
        total_usage_limit, per_user_usage_limit, first_order_only, first_n_orders,
        target_audience, target_zones, auto_apply, requires_code, priority,
        active, created_by_admin_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        c.code ? `${c.code}-COPY` : null,
        `${c.title} (Copy)`,
        c.description,
        c.discount_type,
        c.also_free_delivery,
        c.discount_value,
        c.max_discount_amount,
        c.min_order_amount,
        c.min_item_count,
        c.max_order_amount,
        c.applies_to,
        c.starts_at,
        c.ends_at,
        c.active_days_mask,
        c.active_time_start,
        c.active_time_end,
        c.total_usage_limit,
        c.per_user_usage_limit,
        c.first_order_only,
        c.first_n_orders,
        c.target_audience,
        c.target_zones,
        c.auto_apply,
        c.requires_code,
        c.priority,
        req.admin?.id || null,
      ]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: 'CONFLICT', message: 'A coupon with this code already exists. Rename the code before duplicating again.' });
    }
    throw err;
  }

  if (c.target_audience === 'selected') {
    await pool.query(
      'INSERT INTO coupon_users (coupon_id, user_id) SELECT ?, user_id FROM coupon_users WHERE coupon_id = ?',
      [result.insertId, id]
    );
  }

  if (c.target_zones === 'selected') {
    await pool.query(
      'INSERT INTO coupon_zones (coupon_id, delivery_zone_id) SELECT ?, delivery_zone_id FROM coupon_zones WHERE coupon_id = ?',
      [result.insertId, id]
    );
  }

  res.status(201).json({ message: 'Coupon duplicated', id: result.insertId });
};

const getCouponRedemptions = async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(100, Math.max(1, Number(limit) || 20));
  const offset = (p - 1) * l;

  const [countRows] = await pool.query(
    'SELECT COUNT(*) as total FROM coupon_redemptions WHERE coupon_id = ?',
    [id]
  );
  const total = Number(countRows[0]?.total) || 0;

  const [rows] = await pool.query(
    `SELECT cr.*, o.order_number, o.total as order_total, u.name as user_name, u.phone as user_phone
     FROM coupon_redemptions cr
     LEFT JOIN orders o ON cr.order_id = o.id
     LEFT JOIN users u ON cr.user_id = u.id
     WHERE cr.coupon_id = ?
     ORDER BY cr.redeemed_at DESC
     LIMIT ? OFFSET ?`,
    [id, l, offset]
  );

  res.status(200).json({
    data: rows,
    pagination: { page: p, limit: l, total, totalPages: Math.ceil(total / l) },
  });
};

module.exports = {
  getAdminCoupons,
  getAdminCouponById,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  duplicateCoupon,
  getCouponRedemptions,
};