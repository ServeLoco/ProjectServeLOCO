const config = require('../config/env');
const { signAdminToken } = require('../utils/auth');
const { pool } = require('../db/mysql');
const { validatePagination } = require('../validators');
const { roundMoney, toMoney } = require('../utils/money');
const { resolvePeriod, ReportPeriodError } = require('../utils/reportPeriods');
const notificationService = require('../utils/notificationService');
const {
  notifyShopsForOrder,
  notifyShopsOrderCancelled,
  notifyShopsOrderStatusChanged,
  notifyShopsOrderRemarkUpdated,
} = require('../utils/shops');
const realtimeEvents = require('../realtime/orderEvents');
const { emitToCustomer, emitToAdmins } = require('../realtime/socket');
const orderAutoAccept = require('../realtime/orderAutoAccept');
const adminInbox = require('../utils/adminNotifications');
const { requestAreaId, getDefaultArea, getAreaById } = require('../utils/areaScope');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { calculateCart } = require('./cartController');
const { createOrder } = require('./orderController');

const ORDER_STATUS_VALUES = ['Pending', 'Accepted', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'];

const getCancelledPaymentStatus = (paymentMethod) => (
  paymentMethod === 'UPI' ? 'Refunded' : 'Failed'
);


const queryRows = async (sql, params) => {
  const result = await pool.query(sql, params);
  return Array.isArray(result) ? result[0] || [] : [];
};

// Dashboard mixes order/sales KPIs (which could aggregate) with the same
// shop_open/delivery_available/rain_charge_enabled booleans the Settings
// page shows — those don't mean anything summed across areas, so unlike the
// 6 report endpoints below (which DO accept 'all', per §2.10), the Dashboard
// requires one concrete area, same as Settings/Delivery Zones/Store Modes.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'This action cannot target "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

// §2.10: Orders, Reports and Analytics accept X-Area-Id: all and return a
// cross-area roll-up. No silent default: a super_admin with no header gets
// a 400 (area_admin never sees a choice — resolveAdminArea already pins
// them to their own area).
const resolveAreaOrAll = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action (pass a specific area, or "all")' });
    return undefined;
  }
  return areaId;
};

// Attaches areaCode/area_code to each row of a cross-area ('all') report
// result — §2.10's "areaCode/area_code column added to each row". Areas are
// a tiny, TTL-cached table (§3.9), so a lookup per row is cheap.
const withAreaCodes = async (rows, areaIdField = 'area_id') => {
  const out = [];
  for (const row of rows) {
    const area = await getAreaById(row[areaIdField]);
    out.push({ ...row, areaCode: area?.code || null, area_code: area?.code || null });
  }
  return out;
};

// Account-level lockout, independent of the per-IP login rate limiter — a
// distributed brute force (many source IPs) would otherwise never trip the
// per-IP bucket. There is one shared owner account, so a single counter row
// is enough (see admin_auth_state).
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const skipLockoutCheck = () => process.env.NODE_ENV === 'test';

// Fixed dummy bcrypt hash — never a real credential, just a constant-cost
// target for the timing-side-channel fix below.
const DUMMY_BCRYPT_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8Q0mSvdvSVQBjOBUkeoZfmpQyG.jFa';

const login = async (req, res) => {
  const { id: username, password } = req.validatedData;

  if (!skipLockoutCheck()) {
    const [[state]] = await pool.query('SELECT locked_until FROM admin_auth_state WHERE id = 1');
    if (state?.locked_until && new Date(state.locked_until).getTime() > Date.now()) {
      return res.status(423).json({
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed login attempts. Try again later.'
      });
    }
  }

  // Primary path: a real row in `admins` (super_admin | area_admin).
  const [adminRows] = await pool.query(
    'SELECT id, username, password_hash, role, area_id, active FROM admins WHERE username = ?',
    [username]
  );
  const adminRow = adminRows[0] && adminRows[0].active ? adminRows[0] : null;

  let isMatch = false;
  let matchedAdmin = null;
  let usedEnvFallback = false;
  let ranRealCompare = false;

  if (adminRow) {
    isMatch = await bcrypt.compare(password, adminRow.password_hash);
    ranRealCompare = true;
    if (isMatch) matchedAdmin = adminRow;
  } else {
    // Legacy env-password bootstrap — ONLY while `admins` has zero rows at
    // all (a fresh install before migrate.js's seed has run, or a wiped
    // table). Once any admin row exists — the seed, or one created via the
    // admin API — this path can never fire again for that installation.
    // See plans/multi-area.md H10.
    const [[{ cnt: adminCount }]] = await pool.query('SELECT COUNT(*) AS cnt FROM admins');
    if (Number(adminCount) === 0) {
      const ownerId = process.env.ADMIN_OWNER_ID || config.ADMIN_OWNER_ID;
      const ownerPasswordHash = process.env.ADMIN_PASSWORD_HASH || config.ADMIN_PASSWORD_HASH;
      const ownerPassword = process.env.ADMIN_PASSWORD || config.ADMIN_PASSWORD;

      if (username === ownerId) {
        // Prefer ADMIN_PASSWORD_HASH (bcrypt) when set; otherwise fall back
        // to a constant-time plaintext comparison against ADMIN_PASSWORD.
        if (ownerPasswordHash) {
          isMatch = await bcrypt.compare(password, ownerPasswordHash);
          ranRealCompare = true;
        } else if (ownerPassword) {
          const a = Buffer.from(String(password));
          const b = Buffer.from(String(ownerPassword));
          isMatch = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
        if (isMatch) {
          usedEnvFallback = true;
          matchedAdmin = { id: ownerId, role: 'super_admin', area_id: null };
        }
      }
    }
  }

  // Minor timing side-channel fix: without this, an unknown/inactive
  // username short-circuited to the final 401 without ever calling
  // bcrypt.compare, while a known username with a wrong password took the
  // full ~100ms bcrypt round trip — response time alone told an attacker
  // whether a given admin username exists. Burn the same cost either way.
  if (!ranRealCompare) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
  }

  if (isMatch && matchedAdmin) {
    if (usedEnvFallback) {
      console.warn(
        '[adminController] Logged in via the legacy ADMIN_PASSWORD/ADMIN_PASSWORD_HASH env ' +
        'fallback — the admins table has no rows yet. Run the migration (it seeds one automatically) ' +
        'or create a real admin via the admin API.'
      );
    }
    if (!skipLockoutCheck()) {
      // admin_id is recorded for audit/debugging ("who last succeeded/
      // failed here") — the lockout counter itself stays a single shared
      // threshold (admin_auth_state remains the one row it always was).
      // A genuinely per-admin-isolated counter would need admin_auth_state
      // to become a real one-row-per-admin table, which is a schema change
      // beyond this task's scope; a shared threshold is not a weaker
      // posture in the meantime — it still stops distributed brute-forcing
      // across multiple admin usernames.
      await pool.query(
        'UPDATE admin_auth_state SET failed_attempts = 0, locked_until = NULL, admin_id = ? WHERE id = 1',
        [usedEnvFallback ? null : matchedAdmin.id]
      );
    }
    const adminRole = usedEnvFallback ? 'super_admin' : matchedAdmin.role;
    const areaId = usedEnvFallback ? null : matchedAdmin.area_id;
    const token = signAdminToken(matchedAdmin.id, { adminRole, areaId });
    return res.status(200).json({
      message: 'Admin login successful',
      token,
      user: {
        id: matchedAdmin.id,
        role: 'admin',
        adminRole,
        admin_role: adminRole,
        areaId,
        area_id: areaId,
      }
    });
  }

  if (!skipLockoutCheck()) {
    // Single atomic UPDATE — the previous read-then-write (SELECT, then
    // UPDATE with the computed value) let two concurrent failed logins read
    // the same starting count and both write attempts+1, silently losing an
    // increment under a real distributed brute force. MySQL row-locks the
    // UPDATE itself, so this can't lose a count no matter how concurrent.
    //
    // ORDER MATTERS: MySQL evaluates SET assignments left-to-right using the
    // UPDATED values (nonstandard). locked_until must be assigned first, while
    // failed_attempts still holds its original value — the reverse order would
    // zero failed_attempts before the locked_until CASE reads it, and the
    // lockout would never engage.
    await pool.query(
      `UPDATE admin_auth_state
         SET locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END,
             failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END,
             admin_id = ?
       WHERE id = 1`,
      [LOCKOUT_THRESHOLD, new Date(Date.now() + LOCKOUT_DURATION_MS), LOCKOUT_THRESHOLD, adminRow ? adminRow.id : null]
    );
  }

  return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid admin credentials' });
};

// TASK 25 fix: this used to return only { id, role: 'admin' } — fine before
// multi-area, but it left the admin client with no way to know adminRole/
// areaId after a page reload (login's own response already includes them;
// this is the only other place `user` gets populated, since AuthProvider
// calls /me on boot instead of re-logging in). Mirrors login's user shape
// from req.admin, which requireAdmin already decoded off the JWT — no extra
// DB read needed.
const me = (req, res) => {
  const { id, adminRole, areaId } = req.admin;
  res.status(200).json({
    user: {
      id,
      role: 'admin',
      adminRole,
      admin_role: adminRole,
      areaId,
      area_id: areaId,
    }
  });
};

// Kill switch for a leaked admin token: any token issued before this moment
// (including the caller's own) stops working on its next request. Does not
// touch JWT_SECRET, so customer sessions are unaffected.
const revokeSessions = async (req, res) => {
  // Whole-second precision to match JWT `iat` (also whole seconds). The
  // revocation check below uses a strict "<" so a token issued in the same
  // second as this revoke is still treated as valid — it can only exist
  // because the admin already re-logged-in after triggering the revoke.
  await pool.query(
    'UPDATE admin_auth_state SET revoked_before = NOW() WHERE id = 1'
  );
  res.status(200).json({ message: 'All admin sessions revoked. Log in again to continue.' });
};

const getAdminCustomers = async (req, res) => {
  const { search, trusted, blocked } = req.query;
  const pageNum = req.validatedData?.page || parseInt(req.query.page, 10) || 1;
  const limitNum = req.validatedData?.limit || parseInt(req.query.limit, 10) || 20;
  const offset = (pageNum - 1) * limitNum;

  let query = `
    SELECT u.id, u.name, u.phone, u.whatsapp_number, u.address, u.short_address, u.trusted, u.blocked, u.created_at, u.updated_at,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id) as order_count
    FROM users u
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ' AND (u.name LIKE ? OR u.phone LIKE ? OR u.whatsapp_number LIKE ?)';
    const searchWildcard = `%${search}%`;
    params.push(searchWildcard, searchWildcard, searchWildcard);
  }

  if (trusted !== undefined && trusted !== '') {
    query += ' AND u.trusted = ?';
    params.push(trusted === 'true' || trusted === '1' ? 1 : 0);
  }

  if (blocked !== undefined && blocked !== '') {
    query += ' AND u.blocked = ?';
    params.push(blocked === 'true' || blocked === '1' ? 1 : 0);
  }

  let countQuery = 'SELECT COUNT(*) as total FROM users u WHERE 1=1';
  const countParams = [];
  if (search) {
    countQuery += ' AND (u.name LIKE ? OR u.phone LIKE ? OR u.whatsapp_number LIKE ?)';
    const searchWildcard = `%${search}%`;
    countParams.push(searchWildcard, searchWildcard, searchWildcard);
  }
  if (trusted !== undefined && trusted !== '') {
    countQuery += ' AND u.trusted = ?';
    countParams.push(trusted === 'true' || trusted === '1' ? 1 : 0);
  }
  if (blocked !== undefined && blocked !== '') {
    countQuery += ' AND u.blocked = ?';
    countParams.push(blocked === 'true' || blocked === '1' ? 1 : 0);
  }
  const [countRows] = await pool.query(countQuery, countParams);
  const total = countRows[0].total;

  query += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
  params.push(limitNum, offset);

  const [rows] = await pool.query(query, params);

  res.status(200).json({
    data: rows,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    }
  });
};

const setBlockStatus = async (req, res) => {
  const { id, blocked } = req.validatedData;

  const [result] = await pool.query('UPDATE users SET blocked = ? WHERE id = ?', [blocked ? 1 : 0, id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
  }

  res.status(200).json({ message: `User ${blocked ? 'blocked' : 'unblocked'} successfully` });
};

const setTrustStatus = async (req, res) => {
  const { id, trusted } = req.validatedData;

  const [result] = await pool.query('UPDATE users SET trusted = ? WHERE id = ?', [trusted ? 1 : 0, id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
  }

  res.status(200).json({ message: `User ${trusted ? 'trusted' : 'untrusted'} successfully` });
};

const getDashboard = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const [metricsRow = {}] = await queryRows(`
    SELECT
      COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) as today_orders,
      COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() AND status != 'Cancelled' THEN total ELSE 0 END), 0) as today_sales,
      COUNT(CASE WHEN status = 'Pending' THEN 1 END) as pending_orders,
      COUNT(CASE WHEN status = 'Delivered' THEN 1 END) as delivered_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'Cash' AND status != 'Cancelled' THEN total ELSE 0 END), 0) as cash_total,
      COALESCE(SUM(CASE WHEN payment_method = 'UPI' AND status != 'Cancelled' THEN total ELSE 0 END), 0) as upi_total,
      COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() AND payment_status = 'Pending' AND status != 'Cancelled' THEN total ELSE 0 END), 0) as pending_payment_total
    FROM orders
    WHERE area_id = ?
  `, [areaId]);

  const latestOrders = await queryRows(`
    SELECT * FROM orders
    WHERE area_id = ?
    ORDER BY (status = 'Pending') DESC, created_at DESC
    LIMIT 10
  `, [areaId]);

  const unavailableProducts = await queryRows(`
    SELECT id, name, price FROM products WHERE available = 0 AND area_id = ?
  `, [areaId]);

  const topProducts = await queryRows(`
    SELECT oi.product_id, oi.item_type, oi.product_name, SUM(oi.quantity) as total_quantity, SUM(oi.line_total) as total_sales
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status != 'Cancelled' AND o.area_id = ?
    GROUP BY oi.product_id, oi.item_type, oi.product_name
    ORDER BY total_sales DESC
    LIMIT 5
  `, [areaId]);

  const [settingsRow] = await queryRows('SELECT shop_open, delivery_available, rain_charge_enabled FROM settings WHERE area_id = ? LIMIT 1', [areaId]);

  res.status(200).json({
    data: {
      sales: {
        totalSales: metricsRow.totalSales || metricsRow.today_sales || 0,
        todaySales: metricsRow.today_sales || metricsRow.totalSales || 0,
        totalOrders: metricsRow.totalOrders || metricsRow.today_orders || 0,
        todayOrders: metricsRow.today_orders || metricsRow.totalOrders || 0,
        pendingOrders: metricsRow.pending_orders || metricsRow.pendingOrders || 0,
        deliveredOrders: metricsRow.delivered_orders || metricsRow.deliveredOrders || 0,
        cashTotal: metricsRow.cash_total || metricsRow.cashTotal || 0,
        upiTotal: metricsRow.upi_total || metricsRow.upiTotal || 0,
        pendingPaymentTotal: metricsRow.pending_payment_total || metricsRow.pendingPaymentTotal || 0
      },
      shop_open: settingsRow ? !!settingsRow.shop_open : true,
      delivery_available: settingsRow ? !!settingsRow.delivery_available : true,
      rain_charge_enabled: settingsRow ? !!settingsRow.rain_charge_enabled : false,
      latest_orders: latestOrders,
      product_alerts: unavailableProducts,
      top_products: topProducts
    }
  });
};

const getSalesReport = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const { period } = req.query;
  const allowedPeriods = ['today', 'week', 'month', 'all'];
  if (period && !allowedPeriods.includes(period)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid period parameter' });
  }

  let dateFilter = '1=1';
  if (period === 'today') {
    dateFilter = 'DATE(created_at) = CURDATE()';
  } else if (period === 'week') {
    dateFilter = 'YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)';
  } else if (period === 'month') {
    dateFilter = 'YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())';
  }
  // areaId === 'all' (super_admin, §2.10) intentionally leaves this at '1=1'
  // — every query below sums/groups across every area, a real cross-area
  // roll-up rather than one row per area (there's nothing per-row here to
  // attach an areaCode to).
  const areaParams = [];
  if (areaId !== 'all') {
    dateFilter += ' AND area_id = ?';
    areaParams.push(areaId);
  }

  const [[salesRow]] = await pool.query(`
    SELECT
      -- Rule: Revenue includes all non-cancelled orders, regardless of payment status.
      COALESCE(SUM(CASE WHEN status != 'Cancelled' THEN total ELSE 0 END), 0) as total_revenue,
      COUNT(*) as total_orders
    FROM orders
    WHERE ${dateFilter}
  `, areaParams);

  const [statusRows] = await pool.query(`SELECT status, COUNT(*) as count FROM orders WHERE ${dateFilter} GROUP BY status`, areaParams);
  const [paymentBreakdownRows] = await pool.query(`SELECT payment_method, COUNT(*) as count FROM orders WHERE ${dateFilter} GROUP BY payment_method`, areaParams);
  const [paymentStatusRows] = await pool.query(`SELECT payment_status, COUNT(*) as count FROM orders WHERE ${dateFilter} GROUP BY payment_status`, areaParams);

  const status_breakdown = {};
  statusRows.forEach(row => { status_breakdown[row.status.toLowerCase()] = row.count; });
  const payment_breakdown = {};
  paymentBreakdownRows.forEach(row => { payment_breakdown[(row.payment_method || 'unknown').toLowerCase()] = row.count; });
  const payment_status = {};
  paymentStatusRows.forEach(row => { payment_status[(row.payment_status || 'unknown').toLowerCase()] = row.count; });

  const legacyAreaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const legacyAreaParams = areaId === 'all' ? [] : [areaId];
  const [[legacySalesRow]] = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN total ELSE 0 END), 0) as today_sales,
      COALESCE(SUM(CASE WHEN YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1) THEN total ELSE 0 END), 0) as week_sales,
      COALESCE(SUM(CASE WHEN YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) THEN total ELSE 0 END), 0) as month_sales
    FROM orders
    WHERE status != 'Cancelled'${legacyAreaClause}
  `, legacyAreaParams);

  res.status(200).json({
    total_revenue: salesRow.total_revenue,
    total_orders: salesRow.total_orders,
    status_breakdown,
    payment_breakdown,
    payment_status,
    today: legacySalesRow.today_sales,
    week: legacySalesRow.week_sales,
    month: legacySalesRow.month_sales
  });
};

const getAdminCustomerById = async (req, res) => {
  const { id } = req.params;
  const [userRows] = await pool.query('SELECT id, name, phone, whatsapp_number, address, short_address, trusted, blocked, created_at, updated_at FROM users WHERE id = ?', [id]);
  
  if (userRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
  }

  const customer = userRows[0];
  const [orderRows] = await pool.query('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [id]);

  const lifetimeSpend = orderRows
    .filter(o => o.status !== 'Cancelled')
    .reduce((sum, o) => sum + Number(o.total), 0);

  customer.orders = orderRows;
  customer.lifetime_spend = lifetimeSpend;
  customer.order_count = orderRows.length;

  res.status(200).json({ data: customer });
};

const getTopProductsReport = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const { period } = req.query;
  const allowedPeriods = ['today', 'week', 'month', 'all'];
  if (period && !allowedPeriods.includes(period)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid period parameter' });
  }

  let dateFilter = '1=1';
  if (period === 'today') {
    dateFilter = 'DATE(o.created_at) = CURDATE()';
  } else if (period === 'week') {
    dateFilter = 'YEARWEEK(o.created_at, 1) = YEARWEEK(CURDATE(), 1)';
  } else if (period === 'month') {
    dateFilter = 'YEAR(o.created_at) = YEAR(CURDATE()) AND MONTH(o.created_at) = MONTH(CURDATE())';
  }

  // 'all' mode groups by area too — products aren't shared across areas yet
  // (§2.5/2.6, TASK 18's job), so the same product_id in two different areas
  // is two distinct catalog rows, not one to merge together.
  const areaParams = [];
  let groupBy = 'oi.product_id, oi.item_type, oi.product_name';
  if (areaId === 'all') {
    groupBy = 'oi.area_id, ' + groupBy;
  } else {
    dateFilter += ' AND oi.area_id = ?';
    areaParams.push(areaId);
  }

  const [rows] = await pool.query(`
    SELECT ${areaId === 'all' ? 'oi.area_id,' : ''} oi.product_id, oi.item_type, oi.product_name, SUM(oi.quantity) as total_quantity, SUM(oi.line_total) as total_sales
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status != 'Cancelled' AND ${dateFilter}
    GROUP BY ${groupBy}
    ORDER BY total_quantity DESC
  `, areaParams);
  const data = areaId === 'all' ? await withAreaCodes(rows) : rows;
  res.status(200).json({ data });
};

// Deliberately NOT area-scoped: customers are a global identity (§2.2), not
// owned by an area — the same reasoning TASK 13 applied to a customer's own
// order history. total/trusted/blocked customer counts are platform-wide by
// nature; scoping them would just be wrong, not more precise.
const getCustomersReport = async (req, res) => {
  const { period } = req.query;
  const allowedPeriods = ['today', 'week', 'month', 'all'];
  if (period && !allowedPeriods.includes(period)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid period parameter' });
  }

  let dateFilter = '1=1';
  if (period === 'today') {
    dateFilter = 'DATE(created_at) = CURDATE()';
  } else if (period === 'week') {
    dateFilter = 'YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)';
  } else if (period === 'month') {
    dateFilter = 'YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())';
  }

  const [[metrics]] = await pool.query(`
    SELECT
      COUNT(*) as total_customers,
      COUNT(CASE WHEN ${dateFilter} THEN 1 END) as new_customers,
      COUNT(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 END) as new_customers_30d,
      COUNT(CASE WHEN trusted = 1 THEN 1 END) as trusted_customers,
      COUNT(CASE WHEN blocked = 1 THEN 1 END) as blocked_customers
    FROM users
  `);
  res.status(200).json({ data: metrics });
};

const getShopsReport = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const { period } = req.query;
  const allowedPeriods = ['today', 'week', 'month', 'all'];
  if (period && !allowedPeriods.includes(period)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid period parameter' });
  }

  let dateFilter = '1=1';
  if (period === 'today') {
    dateFilter = 'DATE(o.created_at) = CURDATE()';
  } else if (period === 'week') {
    dateFilter = 'YEARWEEK(o.created_at, 1) = YEARWEEK(CURDATE(), 1)';
  } else if (period === 'month') {
    dateFilter = 'YEAR(o.created_at) = YEAR(CURDATE()) AND MONTH(o.created_at) = MONTH(CURDATE())';
  }
  if (areaId !== 'all') {
    dateFilter += ' AND o.area_id = ?';
  }
  const areaParams = areaId === 'all' ? [] : [areaId];

  // Excluding Cancelled here means a cancelled order simply never counts —
  // covers the "handle cancellations" requirement without any separate
  // subtraction logic to keep in sync.
  // shop_id itself is a global PK (unlike product_id, no cross-area
  // collision risk), so 'all' mode needs no extra GROUP BY key here — just
  // an areaCode annotation per row. Reads oi.area_id (not shops.area_id) so
  // house items (shop_id NULL, no shops row to join) still get a real area
  // — every order_item carries its own area_id regardless of shop_id (TASK 13).
  const [shopRows] = await pool.query(`
    SELECT oi.shop_id, s.name AS shop_name, oi.area_id AS area_id,
      COUNT(DISTINCT oi.order_id) AS order_count,
      COALESCE(SUM(oi.line_total), 0) AS total_amount,
      COALESCE(SUM(oi.quantity), 0) AS total_items_sold
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN shops s ON s.id = oi.shop_id
    WHERE o.status != 'Cancelled' AND ${dateFilter}
    GROUP BY oi.shop_id, s.name, oi.area_id
    ORDER BY total_amount DESC
  `, areaParams);

  const [productRows] = await pool.query(`
    SELECT oi.shop_id, oi.product_id, oi.item_type, oi.product_name,
      SUM(oi.quantity) AS quantity,
      SUM(oi.line_total) AS total_sales
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status != 'Cancelled' AND ${dateFilter}
    GROUP BY oi.shop_id, oi.product_id, oi.item_type, oi.product_name
    ORDER BY quantity DESC
  `, areaParams);

  const productsByShop = new Map();
  for (const row of productRows) {
    const key = row.shop_id ?? 'house';
    if (!productsByShop.has(key)) productsByShop.set(key, []);
    productsByShop.get(key).push(row);
  }

  let data = shopRows.map((row) => {
    const key = row.shop_id ?? 'house';
    return {
      shop_id: row.shop_id,
      shop_name: row.shop_id ? (row.shop_name || 'Deleted Shop') : 'House (No Shop)',
      area_id: row.area_id,
      order_count: row.order_count,
      total_amount: row.total_amount,
      total_items_sold: row.total_items_sold,
      products: productsByShop.get(key) || [],
    };
  });

  if (areaId === 'all') {
    data = await withAreaCodes(data);
  }

  res.status(200).json({ data });
};

// Business-day date filter shared by the profit/payout report endpoints.
// resolved.key='all' (report PERIOD, e.g. "all time" — unrelated to the
// areaId 'all' below) skips the date clause; every other period key was
// already resolved to a concrete [from, to] business-day range by
// resolvePeriod(). areaId is a separate axis: a number appends an area
// filter, 'all' (super_admin cross-area roll-up, §2.10) or undefined skips it.
const buildPeriodDateFilter = (resolved, areaId, column = 'o.created_at') => {
  const parts = [];
  const params = [];
  if (resolved.key !== 'all') {
    parts.push(`DATE(CONVERT_TZ(${column}, '+00:00', ?)) BETWEEN ? AND ?`);
    params.push(resolved.timezone, resolved.from, resolved.to);
  }
  if (areaId !== undefined && areaId !== 'all') {
    parts.push('o.area_id = ?');
    params.push(areaId);
  }
  return { clause: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
};

// Profit & payout report — the daily business ledger. Basis is Delivered
// orders only (see plans/profit-report.md): in-flight orders are surfaced
// separately as "pipeline" so they're visible without polluting profit, and
// cancelled orders never count anywhere. Shop cost comes from the
// order_items.shop_line_total snapshot (never the live catalog), excluding
// items the shop rejected and items that were never priced (NULL — counted
// as zero cost but flagged via warnings.unpricedItemsCount so margin doesn't
// silently read optimistic).
const getProfitSummary = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  let resolved;
  try {
    resolved = resolvePeriod({ period: req.query.period, from: req.query.from, to: req.query.to });
  } catch (err) {
    if (err instanceof ReportPeriodError) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: err.message });
    }
    throw err;
  }

  const { clause: dateFilter, params: dateParams } = buildPeriodDateFilter(resolved, areaId);

  const [[deliveredRow]] = await pool.query(`
    SELECT
      COUNT(*) AS delivered_orders,
      COALESCE(SUM(subtotal), 0) AS app_sales,
      COALESCE(SUM(delivery_charge), 0) AS delivery_charge,
      COALESCE(SUM(night_charge), 0) AS night_charge,
      COALESCE(SUM(rain_charge), 0) AS rain_charge,
      COALESCE(SUM(fast_delivery_charge), 0) AS fast_delivery_charge,
      COALESCE(SUM(discount_amount), 0) AS discount,
      COALESCE(SUM(free_delivery_waiver_amount), 0) AS free_delivery_waiver,
      COALESCE(SUM(total), 0) AS customer_paid,
      COUNT(CASE WHEN payment_method = 'Cash' THEN 1 END) AS cash_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total ELSE 0 END), 0) AS cash_amount,
      COUNT(CASE WHEN payment_method = 'UPI' THEN 1 END) AS upi_orders,
      COALESCE(SUM(CASE WHEN payment_method = 'UPI' THEN total ELSE 0 END), 0) AS upi_amount
    FROM orders o
    WHERE o.status = 'Delivered' AND ${dateFilter}
  `, dateParams);

  const [[shopCostRow]] = await pool.query(`
    SELECT COALESCE(SUM(oi.shop_line_total), 0) AS shop_cost
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status = 'Delivered' AND ${dateFilter}
      AND oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NOT NULL
  `, dateParams);

  // unpriced = a real shop item (shop_id set) missing shop_price at purchase time.
  // House items and combos always have shop_id NULL by design and are not "unpriced".
  const [[warningsRow]] = await pool.query(`
    SELECT
      COUNT(CASE WHEN oi.shop_id IS NOT NULL AND oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NULL THEN 1 END) AS unpriced_items_count,
      COALESCE(SUM(CASE WHEN oi.shop_id IS NOT NULL AND oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NULL THEN oi.line_total ELSE 0 END), 0) AS unpriced_items_app_total,
      COUNT(CASE WHEN oi.shop_rejected_at IS NOT NULL THEN 1 END) AS rejected_items_count
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status = 'Delivered' AND ${dateFilter}
  `, dateParams);

  const [shopRows] = await pool.query(`
    SELECT oi.shop_id, s.name AS shop_name, oi.area_id AS area_id,
      COUNT(DISTINCT oi.order_id) AS delivered_orders,
      COALESCE(SUM(oi.quantity), 0) AS items_sold,
      COALESCE(SUM(oi.line_total), 0) AS app_sales,
      COALESCE(SUM(CASE WHEN oi.shop_rejected_at IS NULL THEN oi.shop_line_total ELSE 0 END), 0) AS shop_cost,
      COUNT(CASE WHEN oi.shop_id IS NOT NULL AND oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NULL THEN 1 END) AS unpriced_items
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN shops s ON s.id = oi.shop_id
    WHERE o.status = 'Delivered' AND ${dateFilter}
    GROUP BY oi.shop_id, s.name, oi.area_id
    ORDER BY shop_cost DESC
  `, dateParams);

  const [[pipelineRow]] = await pool.query(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS value
    FROM orders o
    WHERE o.status NOT IN ('Delivered', 'Cancelled') AND ${dateFilter}
  `, dateParams);

  const [[cancelledRow]] = await pool.query(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS value
    FROM orders o
    WHERE o.status = 'Cancelled' AND ${dateFilter}
  `, dateParams);

  const appSales = toMoney(deliveredRow.app_sales);
  const shopCost = toMoney(shopCostRow.shop_cost);
  const productMargin = roundMoney(appSales - shopCost);
  const deliveryCharge = toMoney(deliveredRow.delivery_charge);
  const nightCharge = toMoney(deliveredRow.night_charge);
  const rainCharge = toMoney(deliveredRow.rain_charge);
  const fastDeliveryCharge = toMoney(deliveredRow.fast_delivery_charge);
  const chargesIncome = roundMoney(deliveryCharge + nightCharge + rainCharge + fastDeliveryCharge);
  const discount = toMoney(deliveredRow.discount);
  const freeDeliveryWaiver = toMoney(deliveredRow.free_delivery_waiver);
  const customerPaid = toMoney(deliveredRow.customer_paid);
  const netProfit = roundMoney(customerPaid - shopCost);
  const deliveredOrders = Number(deliveredRow.delivered_orders) || 0;
  const avgOrderValue = deliveredOrders > 0 ? roundMoney(customerPaid / deliveredOrders) : 0;
  const avgProfitPerOrder = deliveredOrders > 0 ? roundMoney(netProfit / deliveredOrders) : 0;
  const marginPercent = customerPaid > 0 ? roundMoney((netProfit / customerPaid) * 100) : 0;

  const totals = {
    deliveredOrders, delivered_orders: deliveredOrders,
    appSales, app_sales: appSales,
    shopCost, shop_cost: shopCost,
    productMargin, product_margin: productMargin,
    deliveryCharge, delivery_charge: deliveryCharge,
    nightCharge, night_charge: nightCharge,
    rainCharge, rain_charge: rainCharge,
    fastDeliveryCharge, fast_delivery_charge: fastDeliveryCharge,
    chargesIncome, charges_income: chargesIncome,
    discount, discount_amount: discount,
    freeDeliveryWaiver, free_delivery_waiver: freeDeliveryWaiver,
    customerPaid, customer_paid: customerPaid,
    netProfit, net_profit: netProfit,
    avgOrderValue, avg_order_value: avgOrderValue,
    avgProfitPerOrder, avg_profit_per_order: avgProfitPerOrder,
    marginPercent, margin_percent: marginPercent,
  };

  let shops = shopRows.map((row) => {
    const rowAppSales = toMoney(row.app_sales);
    const rowShopCost = toMoney(row.shop_cost);
    const rowMargin = roundMoney(rowAppSales - rowShopCost);
    const shopName = row.shop_id ? (row.shop_name || 'Deleted Shop') : 'House (No Shop)';
    const deliveredOrdersForShop = Number(row.delivered_orders) || 0;
    const itemsSold = Number(row.items_sold) || 0;
    const unpricedItems = Number(row.unpriced_items) || 0;
    return {
      shopId: row.shop_id, shop_id: row.shop_id,
      shopName, shop_name: shopName,
      area_id: row.area_id,
      deliveredOrders: deliveredOrdersForShop, delivered_orders: deliveredOrdersForShop,
      itemsSold, items_sold: itemsSold,
      appSales: rowAppSales, app_sales: rowAppSales,
      shopCost: rowShopCost, shop_cost: rowShopCost,
      margin: rowMargin,
      unpricedItems, unpriced_items: unpricedItems,
    };
  });
  if (areaId === 'all') {
    shops = await withAreaCodes(shops);
  }

  const paymentSplit = {
    cash: { orders: Number(deliveredRow.cash_orders) || 0, amount: toMoney(deliveredRow.cash_amount) },
    upi: { orders: Number(deliveredRow.upi_orders) || 0, amount: toMoney(deliveredRow.upi_amount) },
  };

  res.status(200).json({
    period: resolved,
    totals,
    pipeline: { orders: Number(pipelineRow.orders) || 0, value: toMoney(pipelineRow.value) },
    cancelled: { orders: Number(cancelledRow.orders) || 0, value: toMoney(cancelledRow.value) },
    paymentSplit, payment_split: paymentSplit,
    shops,
    warnings: {
      unpricedItemsCount: Number(warningsRow.unpriced_items_count) || 0,
      unpriced_items_count: Number(warningsRow.unpriced_items_count) || 0,
      unpricedItemsAppTotal: toMoney(warningsRow.unpriced_items_app_total),
      unpriced_items_app_total: toMoney(warningsRow.unpriced_items_app_total),
      rejectedItemsCount: Number(warningsRow.rejected_items_count) || 0,
      rejected_items_count: Number(warningsRow.rejected_items_count) || 0,
    },
  });
};

const PROFIT_ORDERS_SORTS = {
  time: 'o.created_at DESC, o.id DESC',
  profit: 'net_profit DESC',
  value: 'o.total DESC',
};

const getProfitOrders = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  let resolved;
  try {
    resolved = resolvePeriod({ period: req.query.period, from: req.query.from, to: req.query.to });
  } catch (err) {
    if (err instanceof ReportPeriodError) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: err.message });
    }
    throw err;
  }

  const { shopId, sort } = req.query;
  const sortClause = PROFIT_ORDERS_SORTS[sort] || PROFIT_ORDERS_SORTS.time;
  const pagination = validatePagination(req.query.page, req.query.limit);
  const { clause: dateFilter, params: dateParams } = buildPeriodDateFilter(resolved, areaId);

  let shopFilterClause = '';
  const shopFilterParams = [];
  if (shopId !== undefined) {
    const shopIdNum = Number(shopId);
    if (!Number.isInteger(shopIdNum) || shopIdNum <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid shopId parameter' });
    }
    shopFilterClause = ' AND EXISTS (SELECT 1 FROM order_items soi WHERE soi.order_id = o.id AND soi.shop_id = ? AND soi.shop_rejected_at IS NULL)';
    shopFilterParams.push(shopIdNum);
  }

  const baseWhere = `o.status = 'Delivered' AND ${dateFilter}${shopFilterClause}`;
  const baseParams = [...dateParams, ...shopFilterParams];

  const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o WHERE ${baseWhere}`, baseParams);
  const total = Number(countRow.total) || 0;
  const offset = (pagination.page - 1) * pagination.limit;

  const [rows] = await pool.query(`
    SELECT o.id, o.order_number, o.area_id, o.created_at, o.delivered_at, o.customer_name, o.payment_method, o.status,
      o.subtotal AS app_items_total, o.delivery_charge, o.night_charge, o.rain_charge, o.fast_delivery_charge,
      o.discount_amount, o.total AS customer_paid,
      COALESCE((SELECT SUM(oi.shop_line_total) FROM order_items oi
                WHERE oi.order_id = o.id AND oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NOT NULL), 0) AS shop_cost,
      EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.shop_id IS NOT NULL
              AND oi2.shop_rejected_at IS NULL AND oi2.shop_line_total IS NULL) AS has_unpriced_items,
      (o.total - COALESCE((SELECT SUM(oi3.shop_line_total) FROM order_items oi3
                WHERE oi3.order_id = o.id AND oi3.shop_rejected_at IS NULL AND oi3.shop_line_total IS NOT NULL), 0)) AS net_profit
    FROM orders o
    WHERE ${baseWhere}
    ORDER BY ${sortClause}
    LIMIT ? OFFSET ?
  `, [...baseParams, pagination.limit, offset]);

  const orderIds = rows.map((r) => r.id);
  const shopsByOrder = new Map();
  if (orderIds.length > 0) {
    const [shopLineRows] = await pool.query(`
      SELECT oi.order_id, oi.shop_id, s.name AS shop_name,
        SUM(CASE WHEN oi.shop_rejected_at IS NULL THEN oi.shop_line_total ELSE 0 END) AS shop_cost
      FROM order_items oi
      LEFT JOIN shops s ON s.id = oi.shop_id
      WHERE oi.order_id IN (?) AND oi.shop_id IS NOT NULL
      GROUP BY oi.order_id, oi.shop_id, s.name
    `, [orderIds]);
    for (const row of shopLineRows) {
      if (!shopsByOrder.has(row.order_id)) shopsByOrder.set(row.order_id, []);
      const rowShopCost = toMoney(row.shop_cost);
      shopsByOrder.get(row.order_id).push({
        shopId: row.shop_id, shop_id: row.shop_id,
        shopName: row.shop_name || 'Deleted Shop', shop_name: row.shop_name || 'Deleted Shop',
        shopCost: rowShopCost, shop_cost: rowShopCost,
      });
    }
  }

  let data = rows.map((row) => {
    const appItemsTotal = toMoney(row.app_items_total);
    const shopCost = toMoney(row.shop_cost);
    const productMargin = roundMoney(appItemsTotal - shopCost);
    const chargesIncome = roundMoney(
      toMoney(row.delivery_charge) + toMoney(row.night_charge) + toMoney(row.rain_charge) + toMoney(row.fast_delivery_charge)
    );
    const discount = toMoney(row.discount_amount);
    const customerPaid = toMoney(row.customer_paid);
    const netProfit = roundMoney(customerPaid - shopCost);
    return {
      id: row.id,
      orderNumber: row.order_number, order_number: row.order_number,
      area_id: row.area_id,
      createdAt: row.created_at, created_at: row.created_at,
      deliveredAt: row.delivered_at, delivered_at: row.delivered_at,
      customerName: row.customer_name, customer_name: row.customer_name,
      paymentMethod: row.payment_method, payment_method: row.payment_method,
      status: row.status,
      appItemsTotal, app_items_total: appItemsTotal,
      shopCost, shop_cost: shopCost,
      productMargin, product_margin: productMargin,
      chargesIncome, charges_income: chargesIncome,
      discount, discount_amount: discount,
      customerPaid, customer_paid: customerPaid,
      netProfit, net_profit: netProfit,
      shops: shopsByOrder.get(row.id) || [],
      hasUnpricedItems: !!row.has_unpriced_items, has_unpriced_items: !!row.has_unpriced_items,
    };
  });
  if (areaId === 'all') {
    data = await withAreaCodes(data);
  }

  res.status(200).json({
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
  });
};

// Same fixed offset riders.js/shopOwnerController.js use for "today".
const ADMIN_ORDERS_TZ = config.RIDER_TODAY_TZ || '+05:30';

const getAdminOrders = async (req, res) => {
  const { status, paymentStatus, payment_status, paymentMethod, payment_method, search, dateFrom, from, dateTo, to, page, limit } = req.query;
  const pagination = validatePagination(page, limit);

  let query = `SELECT o.id, o.order_number, o.customer_id, o.customer_name, o.phone, o.whatsapp_number, o.address,
    o.latitude, o.longitude, o.map_url, o.subtotal, o.delivery_charge, o.night_charge, o.rain_charge, o.fast_delivery_charge, o.total, o.delivery_type,
    o.coupon_id, o.coupon_code, o.coupon_title, o.discount_amount, o.free_delivery_waiver_amount,
    o.payment_method, o.payment_status, o.status, o.note, o.admin_remark, o.cancel_reason, o.created_at, o.updated_at,
    o.rider_id, o.rider_assigned_at, o.rider_picked_up_at, o.rider_assignment_status,
    r.display_name AS rider_name, u.trusted AS customer_trusted
    FROM orders o
    LEFT JOIN riders r ON r.id = o.rider_id
    LEFT JOIN users u ON u.id = o.customer_id
    WHERE 1=1`;
  const params = [];

  const finalStatus = status;
  const finalPaymentStatus = paymentStatus || payment_status;
  const finalPaymentMethod = paymentMethod || payment_method;
  const finalDateFrom = dateFrom || from;
  const finalDateTo = dateTo || to;

  if (finalStatus) {
    query += ' AND o.status = ?';
    params.push(finalStatus);
  }

  if (finalPaymentStatus) {
    query += ' AND o.payment_status = ?';
    params.push(finalPaymentStatus);
  }

  if (finalPaymentMethod) {
    query += ' AND o.payment_method = ?';
    params.push(finalPaymentMethod);
  }

  if (search) {
    query += ' AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.phone LIKE ?)';
    const searchWildcard = `%${search}%`;
    params.push(searchWildcard, searchWildcard, searchWildcard);
  }

  // o.created_at is written by CURRENT_TIMESTAMP and rendered on read in the
  // MySQL server's session time_zone. Verified against the server: session
  // time_zone = SYSTEM = IST, so created_at IS an IST wall-clock value and
  // DATE(o.created_at) is already the IST calendar day — it must NOT be
  // passed through CONVERT_TZ('+00:00', ...) as if it were UTC, which
  // double-shifts it forward and pushes evening orders (18:30-23:59 IST)
  // onto the next calendar day, hiding them from "today". Only
  // UTC_TIMESTAMP() (a real UTC clock read) needs converting, to find
  // today's IST boundary.
  //
  // NOTE: buildPeriodDateFilter above, riders.js and shopOwnerController.js
  // still wrap created_at in CONVERT_TZ('+00:00', ...) and are therefore
  // off by a day for evening orders on this configuration. Left alone
  // deliberately — they must not be "fixed" without first confirming
  // production's @@global.time_zone, since the correct form flips if that
  // server runs UTC. See db/mysql.js's timezone option, which must agree.
  if (today) {
    query += ' AND DATE(o.created_at) = DATE(CONVERT_TZ(UTC_TIMESTAMP(), ?, ?))';
    params.push('+00:00', ADMIN_ORDERS_TZ);
  } else {
    if (finalDateFrom) {
      query += ' AND DATE(o.created_at) >= ?';
      params.push(finalDateFrom);
    }

    if (finalDateTo) {
      query += ' AND DATE(o.created_at) <= ?';
      params.push(finalDateTo);
    }
  }

  // Count total for pagination
  // COUNT over the same WHERE (params, incl. the leading area one, are
  // shared identically — the area push above happens before any filter,
  // so the placeholder order is positionally correct for both queries).
  const countQueryStr = query.replace(
    /SELECT[\s\S]+?FROM orders o/,
    'SELECT COUNT(*) as total FROM orders o'
  );
  const [countRows] = await pool.query(countQueryStr, params);
  const total = countRows[0].total;

  // Sorting and Pagination
  query += ` ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`;
  const offset = (pagination.page - 1) * pagination.limit;
  params.push(pagination.limit, offset);

  const [rows] = await pool.query(query, params);

  const itemsByOrderId = {};
  if (rows.length > 0) {
    const [itemRows] = await pool.query(
      'SELECT order_id, product_name, variant_label, quantity, unit_price, line_total FROM order_items WHERE order_id IN (?) ORDER BY id ASC',
      [rows.map((row) => row.id)]
    );
    for (const item of itemRows) {
      if (!itemsByOrderId[item.order_id]) itemsByOrderId[item.order_id] = [];
      itemsByOrderId[item.order_id].push(item);
    }
  }

  res.status(200).json({
    data: rows.map((row) => ({
      ...row,
      riderId: row.rider_id,
      riderName: row.rider_name,
      riderAssignmentStatus: row.rider_assignment_status,
      rider_assignment_status: row.rider_assignment_status,
      deliveryType: row.delivery_type,
      adminRemark: row.admin_remark,
      couponCode: row.coupon_code,
      couponTitle: row.coupon_title,
      discountAmount: row.discount_amount,
      freeDeliveryWaiverAmount: row.free_delivery_waiver_amount,
      customer_trusted: Boolean(row.customer_trusted),
      customerTrusted: Boolean(row.customer_trusted),
      items: itemsByOrderId[row.id] || [],
    })),
    pagination: {
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit)
    }
  });
};

const getAdminOrderById = async (req, res) => {
  const { id } = req.params;

  const [orderRows] = await pool.query(
    `SELECT o.id, o.order_number, o.customer_id, o.customer_name, o.phone, o.whatsapp_number, o.address,
      o.latitude, o.longitude, o.map_url, o.subtotal, o.delivery_charge, o.night_charge, o.rain_charge, o.fast_delivery_charge, o.total, o.delivery_type,
      o.coupon_id, o.coupon_code, o.coupon_title, o.discount_amount, o.free_delivery_waiver_amount,
      o.payment_method, o.payment_status, o.status, o.note, o.admin_remark, o.cancel_reason, o.created_at, o.updated_at,
      o.rider_id, o.rider_assigned_at, o.rider_picked_up_at, o.rider_assignment_status,
      r.display_name AS rider_name, u.trusted AS customer_trusted
     FROM orders o
     LEFT JOIN riders r ON r.id = o.rider_id
     LEFT JOIN users u ON u.id = o.customer_id
     WHERE o.id = ?`,
    [id]
  );
  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }

  const order = orderRows[0];
  order.riderId = order.rider_id;
  order.riderName = order.rider_name;
  order.riderAssignmentStatus = order.rider_assignment_status;
  order.deliveryType = order.delivery_type;
  order.adminRemark = order.admin_remark;
  order.couponId = order.coupon_id;
  order.couponCode = order.coupon_code;
  order.couponTitle = order.coupon_title;
  order.discountAmount = order.discount_amount;
  order.freeDeliveryWaiverAmount = order.free_delivery_waiver_amount;
  order.customer_trusted = Boolean(order.customer_trusted);
  order.customerTrusted = order.customer_trusted;
  order.couponApplied = Boolean(order.coupon_id || order.coupon_code);
  const [itemsRows] = await pool.query('SELECT oi.*, s.name AS shop_name FROM order_items oi LEFT JOIN shops s ON s.id = oi.shop_id WHERE oi.order_id = ?', [id]);

  order.items = itemsRows;

  // Per-shop confirmation state: one entry per distinct non-null shop_id among
  // the items. Orders with only house/combo items (shop_id IS NULL) get [].
  const shopMap = new Map();
  for (const it of itemsRows) {
    if (it.shop_id === null || it.shop_id === undefined) continue;
    const sid = it.shop_id;
    if (!shopMap.has(sid)) {
      shopMap.set(sid, { shopId: sid, shop_name: it.shop_name || null, items: [] });
    }
    shopMap.get(sid).items.push(it);
  }
  // When the whole order is Cancelled, surface that on each shop row so the
  // Orders drawer never keeps showing "⏳ Waiting" after admin cancel.
  const orderCancelled = order.status === 'Cancelled' || order.status === 'Canceled';
  order.shopConfirmations = Array.from(shopMap.values()).map(e => {
    const confirmed = e.items.length > 0 && e.items.every(it => it.shop_confirmed_at !== null);
    const confirmedTimestamps = e.items.map(it => it.shop_confirmed_at).filter(Boolean);
    // .sort() on Date objects/strings is lexicographic, not chronological
    // (e.g. "Fri Aug" sorts before "Thu Jul") — compare as epoch ms instead.
    const confirmedAt = confirmedTimestamps.length > 0
      ? confirmedTimestamps.reduce((latest, ts) => (new Date(ts) > new Date(latest) ? ts : latest))
      : null;
    const ready = e.items.length > 0 && e.items.every(it => it.shop_ready_at !== null);
    const readyTimestamps = e.items.map(it => it.shop_ready_at).filter(Boolean);
    const readyAt = readyTimestamps.length > 0
      ? readyTimestamps.reduce((latest, ts) => (new Date(ts) > new Date(latest) ? ts : latest))
      : null;
    const shopRejected = e.items.length > 0 && e.items.every(it => it.shop_rejected_at !== null);
    const rejected = orderCancelled || shopRejected;
    const rejectedTimestamps = e.items.map(it => it.shop_rejected_at).filter(Boolean);
    const rejectedAt = rejectedTimestamps.length > 0
      ? rejectedTimestamps.reduce((latest, ts) => (new Date(ts) > new Date(latest) ? ts : latest))
      : null;
    // What VillKro owes this shop for this order — same rule as the
    // shop-owner app: a cancelled order or a line the shop itself rejected
    // never counts (never fulfilled either way). Lines without a configured
    // shop_line_total (NULL) are silently excluded, not treated as free.
    const shopTotal = orderCancelled ? 0 : e.items
      .filter(it => it.shop_rejected_at === null && it.shop_line_total !== null && it.shop_line_total !== undefined)
      .reduce((sum, it) => sum + Number(it.shop_line_total), 0);
    return {
      shopId: e.shopId,
      shop_id: e.shopId,
      shopName: e.shop_name,
      shop_name: e.shop_name,
      confirmed: orderCancelled ? false : confirmed,
      confirmedAt: orderCancelled ? null : confirmedAt,
      confirmed_at: orderCancelled ? null : confirmedAt,
      ready: orderCancelled ? false : ready,
      readyAt: orderCancelled ? null : readyAt,
      ready_at: orderCancelled ? null : readyAt,
      rejected,
      rejectedAt,
      rejected_at: rejectedAt,
      orderCancelled,
      order_cancelled: orderCancelled,
      shopTotal,
      shop_total: shopTotal,
    };
  });

  // Additive shop pins + rider last-position for the admin live-tracking map.
  // Same shape/gate as the customer-facing getOrderById (orderController.js).
  if (order.status !== 'Pending') {
    const [shopRows] = await pool.query(
      `SELECT DISTINCT s.id, s.name, s.latitude, s.longitude
       FROM order_items oi JOIN shops s ON s.id = oi.shop_id
       WHERE oi.order_id = ? AND s.active = 1`,
      [id]
    );
    order.shops = shopRows.map((s) => ({
      id: s.id,
      name: s.name,
      latitude: s.latitude != null ? Number(s.latitude) : null,
      longitude: s.longitude != null ? Number(s.longitude) : null,
    }));
  }

  if (order.rider_id) {
    const [riderRows] = await pool.query(
      `SELECT id, user_id, display_name, phone, last_lat, last_lng, last_location_at
       FROM riders WHERE id = ?`,
      [order.rider_id]
    );
    if (riderRows.length > 0) {
      const r = riderRows[0];
      order.rider = {
        id: r.id,
        userId: r.user_id,
        user_id: r.user_id,
        displayName: r.display_name,
        display_name: r.display_name,
        phone: r.phone,
        lastLat: r.last_lat != null ? Number(r.last_lat) : null,
        lastLng: r.last_lng != null ? Number(r.last_lng) : null,
        lastLocationAt: r.last_location_at,
        last_lat: r.last_lat != null ? Number(r.last_lat) : null,
        last_lng: r.last_lng != null ? Number(r.last_lng) : null,
        last_location_at: r.last_location_at,
      };
    }
  }

  res.status(200).json({ data: order });
};

const updateOrderStatus = async (req, res) => {
  const { id } = req.params;
  let { status, cancel_reason } = req.body;

  // Normalize spelling to match DB ENUM
  if (status === 'Canceled') status = 'Cancelled';

  const validStatuses = ORDER_STATUS_VALUES;
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Valid status required. One of: ${validStatuses.join(', ')}` });
  }

  const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const currentStatus = orderRows[0].status;

  // Cancel the pending auto-accept (if any) the moment an admin acts on this order.
  if (currentStatus === 'Pending') {
    orderAutoAccept.cancel(parseInt(id, 10));
  }

  // Terminal states cannot be changed
  if (currentStatus === 'Delivered' || currentStatus === 'Cancelled') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot change status of a delivered or cancelled order' });
  }

  // Enforce forward-only progression
  const statusOrder = ORDER_STATUS_VALUES.filter(value => value !== 'Cancelled');
  const currentIdx = statusOrder.indexOf(currentStatus);
  const newIdx = statusOrder.indexOf(status);
  // Allow Cancelled from any non-terminal state, otherwise enforce progression
  if (status !== 'Cancelled' && newIdx !== -1 && currentIdx !== -1 && newIdx <= currentIdx) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Cannot move order from '${currentStatus}' back to '${status}'` });
  }

  if (status === 'Cancelled') {
    const cancelledPaymentStatus = getCancelledPaymentStatus(orderRows[0].payment_method);
    const { resolveCancelReason } = require('../utils/cancelReasons');
    const resolvedCancelReason = resolveCancelReason('admin', cancel_reason);
    // Cancel + coupon-quota restore must land together: soft-cancelling the
    // redemption releases the customer's per-user use and the global count
    // (only 'active' rows count toward limits), same as a customer cancel.
    const connection = await pool.getConnection();
    let conflict = false;
    try {
      await connection.beginTransaction();
      const [cancelResult] = await connection.query(
        'UPDATE orders SET status = ?, payment_status = ?, cancel_reason = ? WHERE id = ? AND status = ?',
        [status, cancelledPaymentStatus, resolvedCancelReason, id, currentStatus]
      );
      if (cancelResult.affectedRows === 0) {
        // The order status changed underneath us — do not overwrite it.
        await connection.rollback();
        conflict = true;
      } else {
        if (orderRows[0].coupon_id) {
          await connection.query(
            "UPDATE coupon_redemptions SET status = 'cancelled' WHERE order_id = ? AND coupon_id = ?",
            [id, orderRows[0].coupon_id]
          );
        }
        await connection.commit();
      }
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
    if (conflict) {
      const [freshRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
      return res.status(409).json({ code: 'CONCURRENCY_CONFLICT', message: 'Order was updated by someone else.', order: freshRows[0] });
    }
  } else {
    const setDeliveredAt = status === 'Delivered' ? ', delivered_at = NOW()' : '';
    // Delivered orders shouldn't sit at 'Pending' payment forever — flip to
    // 'Success' automatically, but only if the admin hasn't already set a
    // manual payment status (e.g. marked Failed for a COD dispute).
    const setPaymentSuccess = (status === 'Delivered' && orderRows[0].payment_status === 'Pending')
      ? ', payment_status = "Success"'
      : '';
    const [updateResult] = await pool.query(
      `UPDATE orders SET status = ?${setDeliveredAt}${setPaymentSuccess} WHERE id = ? AND status = ?`,
      [status, id, currentStatus]
    );
    if (updateResult.affectedRows === 0) {
      const [freshRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
      return res.status(409).json({ code: 'CONCURRENCY_CONFLICT', message: 'Order was updated by someone else.', order: freshRows[0] });
    }
  }
  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  const updatedOrder = updatedRows[0];

  if (currentStatus !== status) {
    let eventName = '';
    if (status === 'Accepted') eventName = 'status_accepted';
    else if (status === 'Preparing') eventName = 'status_preparing';
    else if (status === 'Out for Delivery') eventName = 'status_out_for_delivery';
    else if (status === 'Delivered') eventName = 'status_delivered';
    else if (status === 'Cancelled') eventName = 'status_cancelled';

    if (eventName) {
      notificationService.createOrderNotification({
        userId: updatedOrder.customer_id,
        order: updatedOrder,
        event: eventName
      }).then(result => realtimeEvents.emitNotificationCreated(updatedOrder.customer_id, result))
        .catch(err => console.error('[notify]', err.message));
    }

    // Shop owners must hear about an order the first time it leaves Pending —
    // an admin can jump straight from Pending to Preparing (skipping
    // Accepted), which would otherwise never fire the fan-out.
    if (currentStatus === 'Pending' && (status === 'Accepted' || status === 'Preparing')) {
      notifyShopsForOrder(updatedOrder); // fire-and-forget; owners get socket + push
      // House-only orders (no shop items) start rider assignment immediately.
      const { startAssignmentIfHouseOnly } = require('../services/riderAssignment');
      startAssignmentIfHouseOnly(updatedOrder.id).catch((e) =>
        console.error('[rider-assign] house start on admin accept failed:', e.message)
      );
    }

    // A shop already notified/preparing must be told when the order dies
    // underneath them — otherwise it silently disappears from their list.
    if (status === 'Cancelled' && (currentStatus === 'Accepted' || currentStatus === 'Preparing')) {
      notifyShopsOrderCancelled(updatedOrder);
      const { revokeOffersForOrder } = require('../services/riderAssignment');
      revokeOffersForOrder(updatedOrder.id).catch(() => {});
    }

    // Out for Delivery / Delivered leave the shop "Active" list (Accepted/Preparing only).
    if (
      (status === 'Out for Delivery' || status === 'Delivered')
      && (currentStatus === 'Accepted' || currentStatus === 'Preparing' || currentStatus === 'Out for Delivery')
    ) {
      notifyShopsOrderStatusChanged(updatedOrder);
    }

    // Admin moving Accepted -> Preparing directly (bypassing the shop's own
    // confirm-order action) must still reach the shop dashboard in real time,
    // not just on the next focus/foreground refetch.
    if (status === 'Preparing' && currentStatus === 'Accepted') {
      notifyShopsOrderStatusChanged(updatedOrder);
    }

    // A rider already en route must be told the order died underneath them —
    // otherwise they keep driving to a cancelled order (any prior status,
    // since a rider can be assigned as early as 'Accepted').
    if (status === 'Cancelled' && updatedOrder.rider_id) {
      (async () => {
        try {
          const [riderRows] = await pool.query('SELECT user_id FROM riders WHERE id = ?', [updatedOrder.rider_id]);
          if (riderRows[0]) {
            emitToCustomer(riderRows[0].user_id, 'rider.assignment.updated', {
              orderId: updatedOrder.id,
              status: 'cancelled',
            });
            const expoPush = require('../utils/expoPush');
            await expoPush.sendPushToUser(pool, riderRows[0].user_id, {
              title: 'Order cancelled',
              body: `Order ${updatedOrder.order_number} was cancelled by admin.`,
              data: { type: 'rider_assignment', orderId: updatedOrder.id },
            });
          }
        } catch (e) {
          console.error('[rider-assign] notify rider of admin cancel failed:', e.message);
        }
      })();
    }

    realtimeEvents.emitOrderStatusUpdated(updatedOrder);
  }

  res.status(200).json({ message: 'Order status updated successfully', order: updatedOrder });
};

// Admin "+30s" button — pushes the real server-side auto-accept timer back,
// not just a client-side display. Broadcasts the new deadline so every open
// admin tab/device stays in sync on the same countdown.
const extendAutoAccept = async (req, res) => {
  const { id } = req.params;
  const extraMs = 30_000;

  const [orderRows] = await pool.query('SELECT id, status, order_number, area_id FROM orders WHERE id = ?', [id]);
  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  if (orderRows[0].status !== 'Pending') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Order is no longer pending' });
  }

  const newDeadline = orderAutoAccept.extend(parseInt(id, 10), extraMs);
  if (newDeadline == null) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No active auto-accept timer for this order' });
  }

  const payload = { orderId: orderRows[0].id, orderNumber: orderRows[0].order_number, deadline: newDeadline };
  emitToAdmins(orderRows[0].area_id, 'admin.order.snoozed', payload);
  res.status(200).json({ message: 'Auto-accept window extended', ...payload });
};

const updateOrderPayment = async (req, res) => {
  const { id } = req.params;
  const { payment_status, paymentStatus } = req.body;

  const finalStatus = payment_status || paymentStatus;
  const validPaymentStatuses = ['Pending', 'Paid', 'Success', 'Failed', 'Refunded'];
  
  if (!finalStatus || !validPaymentStatuses.includes(finalStatus)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Valid payment status is required' });
  }

  const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const currentPaymentStatus = orderRows[0].payment_status;
  const currentStatus = orderRows[0].status;

  if (currentStatus === 'Canceled' || currentStatus === 'Cancelled') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot update payment for a canceled order' });
  }

  // Same-value no-op must not fall through to the compare-and-set UPDATE:
  // MySQL reports affectedRows = 0 when the new value equals the old one,
  // which would be indistinguishable from a real concurrent change and
  // return a bogus 409. Answer 200 with the current row instead.
  if (finalStatus === currentPaymentStatus) {
    return res.status(200).json({ message: 'Order payment status updated successfully', order: orderRows[0] });
  }

  const [paymentResult] = await pool.query('UPDATE orders SET payment_status = ? WHERE id = ? AND payment_status = ?', [finalStatus, id, currentPaymentStatus]);
  if (paymentResult.affectedRows === 0) {
    const [freshRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
    return res.status(409).json({ code: 'CONCURRENCY_CONFLICT', message: 'Order was updated by someone else.', order: freshRows[0] });
  }
  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  const updatedOrder = updatedRows[0];

  if (currentPaymentStatus !== finalStatus) {
    let eventName = '';
    if (finalStatus === 'Paid') eventName = 'payment_paid';
    else if (finalStatus === 'Failed') eventName = 'payment_failed';
    else if (finalStatus === 'Refunded') eventName = 'payment_refunded';

    if (eventName) {
      notificationService.createOrderNotification({
        userId: updatedOrder.customer_id,
        order: updatedOrder,
        event: eventName
      }).then(result => realtimeEvents.emitNotificationCreated(updatedOrder.customer_id, result))
        .catch(err => console.error('[notify]', err.message));
    }

    realtimeEvents.emitOrderPaymentUpdated(updatedOrder);
  }

  res.status(200).json({ message: 'Order payment status updated successfully', order: updatedOrder });
};

// Free-text admin note on an order (e.g. "delayed — rider shortage"),
// distinct from the customer's own checkout `note`. Visible to other admins
// and to the shop owner (getMyOrderHistory). Last-write-wins — unlike
// status/payment this isn't a state machine, so no compare-and-set — and
// editable on any order regardless of status (a note is often written after
// delivery/cancellation to explain what happened).
const MAX_ADMIN_REMARK_LENGTH = 1000;
const updateOrderRemark = async (req, res) => {
  const { id } = req.params;
  const { remark, admin_remark, adminRemark } = req.body;
  const rawRemark = remark ?? admin_remark ?? adminRemark ?? '';

  if (typeof rawRemark !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Remark must be text' });
  }
  const trimmedRemark = rawRemark.trim();
  if (trimmedRemark.length > MAX_ADMIN_REMARK_LENGTH) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Remark must be ${MAX_ADMIN_REMARK_LENGTH} characters or fewer` });
  }
  const finalRemark = trimmedRemark || null;

  const [orderRows] = await pool.query('SELECT id FROM orders WHERE id = ?', [id]);
  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }

  await pool.query('UPDATE orders SET admin_remark = ? WHERE id = ?', [finalRemark, id]);
  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [id]);
  const updatedOrder = updatedRows[0];

  try {
    emitToAdmins(updatedOrder.area_id, 'admin.order.updated', {
      orderId: updatedOrder.id,
      id: updatedOrder.id,
      admin_remark: updatedOrder.admin_remark,
      adminRemark: updatedOrder.admin_remark,
    });
    notifyShopsOrderRemarkUpdated(updatedOrder); // fire-and-forget
  } catch (_) {
    // Realtime is best-effort — the remark is already persisted.
  }

  res.status(200).json({ message: 'Order remark updated successfully', order: updatedOrder });
};

const ITEM_REPLACE_ALLOWED_STATUSES = ['Pending', 'Accepted', 'Preparing'];

// Admin swaps one order_items row for a different product when the
// original is out of stock — recomputes orders.subtotal/total (formula
// mirrors orderController.js's createOrder) but never touches
// discount_amount, which is a frozen checkout-time snapshot everywhere
// else in this codebase. See plans note in PR: no refund automation, a
// Paid order whose total shifts is reconciled by ops outside the app.
const replaceOrderItem = async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!Number.isFinite(orderId) || orderId <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order or item id' });
  }

  const { expectedProductId, expectedVariantId, expectedUnitPrice, newProductId, newVariantId } = req.body || {};
  if (!Number.isFinite(Number(expectedProductId)) || !Number.isFinite(Number(expectedUnitPrice)) || !Number.isFinite(Number(newProductId))) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'expectedProductId, expectedUnitPrice and newProductId are required' });
  }
  const normalizedExpectedVariantId = expectedVariantId === undefined || expectedVariantId === null ? null : Number(expectedVariantId);
  const normalizedNewVariantId = newVariantId === undefined || newVariantId === null ? null : Number(newVariantId);

  const areaId = requireOrderArea(req, res);
  if (areaId === null) return;
  const scope = orderAreaScope(areaId, '');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.query(`SELECT * FROM orders WHERE id = ?${scope.clause} FOR UPDATE`, [orderId, ...scope.params]);
    if (orderRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
    }
    const order = orderRows[0];

    if (!ITEM_REPLACE_ALLOWED_STATUSES.includes(order.status)) {
      await connection.rollback();
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: `Items can only be changed while the order is ${ITEM_REPLACE_ALLOWED_STATUSES.join(', ')}.`,
      });
    }

    const [itemRows] = await connection.query(
      'SELECT * FROM order_items WHERE id = ? AND order_id = ? AND area_id = ? FOR UPDATE',
      [itemId, orderId, order.area_id]
    );
    if (itemRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Order item not found' });
    }
    const item = itemRows[0];

    const casMismatch = item.product_id !== Number(expectedProductId)
      || Number(item.unit_price) !== Number(expectedUnitPrice)
      || (item.variant_id ?? null) !== normalizedExpectedVariantId;
    if (casMismatch) {
      await connection.rollback();
      const [freshItems] = await pool.query('SELECT * FROM order_items WHERE order_id = ? AND area_id = ?', [orderId, order.area_id]);
      return res.status(409).json({
        code: 'CONCURRENCY_CONFLICT',
        message: 'This item was already changed by someone else.',
        order,
        items: freshItems,
      });
    }

    if (item.item_type !== 'product') {
      await connection.rollback();
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Only product line items can be changed' });
    }

    const [productRows] = await connection.query(
      'SELECT id, name, price, shop_price, shop_id, area_id, available, deleted FROM products WHERE id = ?',
      [Number(newProductId)]
    );
    const newProduct = productRows[0];
    if (!newProduct || newProduct.deleted) {
      await connection.rollback();
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Replacement product not found' });
    }
    if (newProduct.area_id !== order.area_id) {
      await connection.rollback();
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Replacement product must belong to the same area' });
    }
    const shopMismatch = item.shop_id !== null
      ? newProduct.shop_id !== item.shop_id
      : newProduct.shop_id !== null;
    if (shopMismatch) {
      await connection.rollback();
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: item.shop_id !== null
          ? 'Replacement must be another product from the same shop'
          : 'Replacement must be a house product (no shop)',
      });
    }

    let newUnitPrice;
    let newShopUnitPrice;
    let newVariantLabel = null;
    if (normalizedNewVariantId !== null) {
      const [variantRows] = await connection.query(
        'SELECT id, label, price, shop_price FROM product_variants WHERE id = ? AND product_id = ? AND deleted = 0 AND available = 1',
        [normalizedNewVariantId, newProduct.id]
      );
      const variant = variantRows[0];
      if (!variant) {
        await connection.rollback();
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Replacement variant not found or unavailable' });
      }
      newUnitPrice = Number(variant.price);
      newShopUnitPrice = variant.shop_price != null ? Number(variant.shop_price) : null;
      newVariantLabel = variant.label;
    } else {
      if (!newProduct.available) {
        await connection.rollback();
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Replacement product is unavailable' });
      }
      newUnitPrice = Number(newProduct.price);
      newShopUnitPrice = newProduct.shop_price != null ? Number(newProduct.shop_price) : null;
    }

    const newProductName = newVariantLabel ? `${newProduct.name} (${newVariantLabel})` : newProduct.name;
    const newLineTotal = roundMoney(newUnitPrice * item.quantity);
    const newShopLineTotal = newShopUnitPrice != null ? roundMoney(newShopUnitPrice * item.quantity) : null;

    const [updateItemResult] = await connection.query(
      `UPDATE order_items
         SET product_id = ?, variant_id = ?, variant_label = ?, product_name = ?,
             unit_price = ?, line_total = ?, shop_unit_price = ?, shop_line_total = ?
       WHERE id = ? AND order_id = ? AND product_id = ? AND unit_price = ?`,
      [
        newProduct.id, normalizedNewVariantId, newVariantLabel, newProductName,
        newUnitPrice, newLineTotal, newShopUnitPrice, newShopLineTotal,
        itemId, orderId, item.product_id, item.unit_price,
      ]
    );
    if (updateItemResult.affectedRows === 0) {
      await connection.rollback();
      const [freshItems] = await pool.query('SELECT * FROM order_items WHERE order_id = ? AND area_id = ?', [orderId, order.area_id]);
      return res.status(409).json({ code: 'CONCURRENCY_CONFLICT', message: 'This item was already changed by someone else.', order, items: freshItems });
    }

    const [[{ subtotal: recomputedSubtotal }]] = await connection.query(
      'SELECT SUM(line_total) AS subtotal FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const subtotal = roundMoney(Number(recomputedSubtotal) || 0);
    const total = roundMoney(Math.max(0, subtotal
      + Number(order.delivery_charge)
      + Number(order.fast_delivery_charge)
      + Number(order.night_charge)
      + Number(order.rain_charge)
      - Number(order.discount_amount)));

    // discount_amount stays frozen (see this function's own header comment —
    // no refund/reconciliation automation), but a swap down to a cheaper
    // product can drop the new subtotal below the applied coupon's own
    // min_order_amount, silently shipping an order that violates the terms
    // it was granted under. Surface it rather than auto-adjusting money on
    // a payment-sensitive path — same "flag it, ops reconciles" pattern
    // this function already uses for the total shift itself.
    let couponWarning = null;
    if (order.coupon_id && Number(order.discount_amount) > 0) {
      const [couponRows] = await connection.query(
        'SELECT min_order_amount FROM coupons WHERE id = ?',
        [order.coupon_id]
      );
      const minOrderAmount = couponRows[0] ? Number(couponRows[0].min_order_amount) : null;
      if (minOrderAmount !== null && subtotal < minOrderAmount) {
        couponWarning = `Applied coupon "${order.coupon_code || order.coupon_title || order.coupon_id}" requires a minimum order of ₹${minOrderAmount}; the new subtotal is ₹${subtotal}. The ₹${order.discount_amount} discount was NOT auto-removed — review and adjust manually if needed.`;
      }
    }

    const [updateOrderResult] = await connection.query(
      `UPDATE orders SET subtotal = ?, total = ? WHERE id = ?${scope.clause} AND status = ?`,
      [subtotal, total, orderId, ...scope.params, order.status]
    );
    if (updateOrderResult.affectedRows === 0) {
      await connection.rollback();
      const [freshOrderRows] = await pool.query(`SELECT * FROM orders WHERE id = ?${scope.clause}`, [orderId, ...scope.params]);
      const [freshItems] = await pool.query('SELECT * FROM order_items WHERE order_id = ? AND area_id = ?', [orderId, order.area_id]);
      return res.status(409).json({ code: 'CONCURRENCY_CONFLICT', message: 'Order was updated by someone else.', order: freshOrderRows[0], items: freshItems });
    }

    await connection.commit();

    const [updatedOrderRows] = await pool.query(`SELECT * FROM orders WHERE id = ?${scope.clause}`, [orderId, ...scope.params]);
    const [updatedItemRows] = await pool.query('SELECT * FROM order_items WHERE id = ?', [itemId]);
    const updatedOrder = updatedOrderRows[0];
    const updatedItem = updatedItemRows[0];

    try {
      realtimeEvents.emitOrderItemReplaced(
        updatedOrder,
        itemId,
        { productId: item.product_id, productName: item.product_name, unitPrice: item.unit_price, lineTotal: item.line_total },
        { productId: updatedItem.product_id, productName: updatedItem.product_name, unitPrice: updatedItem.unit_price, lineTotal: updatedItem.line_total }
      );
      if (item.shop_id !== null) {
        notifyShopsOrderItemReplaced(updatedOrder, item.shop_id); // fire-and-forget
      }
    } catch (_) {
      // Realtime is best-effort — the swap is already persisted.
    }

    if (couponWarning) {
      adminInbox.createAdminNotification({
        type: adminInbox.TYPES.COUPON_TERMS_VIOLATED,
        title: `Order #${orderId} no longer meets its coupon's terms`,
        body: couponWarning,
        relatedUrl: `/orders?id=${orderId}`,
        relatedId: String(orderId),
        areaId: order.area_id,
      }).catch(() => {}); // best-effort — the swap is already persisted regardless
    }

    res.status(200).json({ message: 'Item replaced', order: updatedOrder, item: updatedItem, couponWarning });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// admin_notifications / notification_batches use the same resolveAreaOrAll
// helper defined near the top of this file (§2.10 also covers the
// operational inbox and broadcast history as legitimate cross-area H6
// views/audiences, not a single-tenant write).
const getAdminNotifications = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const pagination = validatePagination(req.query.page, req.query.limit);
  const offset = (pagination.page - 1) * pagination.limit;
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];

  const [rows] = await pool.query(
    `SELECT * FROM notification_batches WHERE deleted_at IS NULL${areaClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...areaParams, pagination.limit, offset]
  );

  const [countRows] = await pool.query(
    `SELECT COUNT(*) as total FROM notification_batches WHERE deleted_at IS NULL${areaClause}`,
    areaParams
  );
  const total = countRows[0].total;

  res.status(200).json({
    data: rows,
    pagination: {
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.ceil(total / pagination.limit)
    }
  });
};

const createAdminNotification = async (req, res) => {
  const { title, body, type, target, phones } = req.body;
  const adminId = req.admin.id;
  // H6/16.3: 'everyone' is scoped to one area by default; a super_admin may
  // explicitly opt into 'all' (X-Area-Id: all) to reach every area at once.
  // area_admin never sees a choice — resolveAdminArea already pins them to
  // their own area and 403s if they try to send the header themselves.
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;

  if (!title || !body || !type || !target) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'title, body, type, and target are required' });
  }

  if (body.length > 240) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Body too long (max 240 characters)' });
  }

  // Normalise a free-form phone entry — each top-level token (comma/semicolon/newline
  // separated) is one number. Internal whitespace, dashes, parens are stripped so
  // "+91 99999-90002" matches the stored "9199999002".
  const sanitizePhones = (raw) => {
    if (!Array.isArray(raw) && typeof raw !== 'string') return [];
    const list = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n\r]+/);
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      if (entry == null) continue;
      const cleaned = String(entry).replace(/[^\d+]/g, '');
      if (!cleaned) continue;
      // Preserve a single leading + then digits only.
      const hasPlus = cleaned.startsWith('+');
      const digits = cleaned.replace(/\D/g, '');
      const normalized = (hasPlus ? '+' : '') + digits;
      if (digits.length < 7) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  };

  let targetUserIds = [];
  let resolvedPhones = [];
  let unmatchedPhones = [];
  let targetLabel = target;
  // H6: customers are global and carry only last_area_id, a cache — this is
  // approximate by nature (reaches whoever's last order was in this area,
  // misses someone who has never ordered, includes someone who has since
  // moved). audienceNote below surfaces that in the response for whichever
  // admin UI reads it; not fixable without a precise per-user area signal
  // this codebase doesn't have (§2.2).
  let audienceNote = null;

  if (target === 'everyone') {
    if (areaId === 'all') {
      const [users] = await pool.query('SELECT id FROM users WHERE blocked = 0');
      targetUserIds = users.map(u => u.id);
      targetLabel = 'everyone (all areas)';
      audienceNote = 'Sent to every non-blocked customer across every area.';
    } else {
      const [users] = await pool.query('SELECT id FROM users WHERE blocked = 0 AND last_area_id = ?', [areaId]);
      targetUserIds = users.map(u => u.id);
      targetLabel = `everyone (area ${areaId})`;
      audienceNote = 'Approximate: reaches customers whose most recent order was in this area. Misses anyone who has never ordered, and may include someone who has since moved.';
    }
  } else if (target === 'phones') {
    const sanitized = sanitizePhones(phones);
    if (sanitized.length === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Provide at least one phone number (comma- or newline-separated).',
      });
    }

    // Generate digit-only variants for every input so a few common formats
    // match the same DB row:
    //   "9999999002"          → "9999999002"
    //   "+91 99999-9002"      → "9999999002", "9199999002", "9999999002"
    //   "9199999002"          → "9199999002", "9999999002"
    // We then query with REGEXP_REPLACE so DB-side phones get digit-stripped too.
    const digitVariants = new Set();
    for (const raw of sanitized) {
      const digitsOnly = raw.replace(/\D/g, '');
      if (!digitsOnly) continue;
      digitVariants.add(digitsOnly);
      if (digitsOnly.length > 10) digitVariants.add(digitsOnly.slice(-10));
    }
    const variants = Array.from(digitVariants);
    if (variants.length === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Phone numbers must contain at least 7 digits.',
      });
    }

    // Generate a digit-only form for every variant so we can compare against
    // the DB's `phone` column after stripping non-digits. Doing this in JS
    // avoids a function-on-column predicate (REGEXP_REPLACE is MySQL 8.0+
    // AND makes the WHERE non-sargable, full-scanning the users table).
    const [allUsers] = await pool.query(
      'SELECT id, phone FROM users WHERE blocked = 0 AND phone IS NOT NULL'
    );

    const stripDigits = (s) => String(s || '').replace(/\D/g, '');
    // Index each user under BOTH their full digit form AND their last-10 digits.
    // This makes matching symmetric: a plain 10-digit input matches a stored
    // number that has a country code (e.g. typed "9999999002" vs stored
    // "+919999999002"), and vice-versa. First write wins on collisions.
    const userDigitSet = new Map();   // digits-only key → user
    for (const u of allUsers) {
      const d = stripDigits(u.phone);
      if (!d) continue;
      if (!userDigitSet.has(d)) userDigitSet.set(d, u);
      if (d.length > 10) {
        const last10 = d.slice(-10);
        if (!userDigitSet.has(last10)) userDigitSet.set(last10, u);
      }
    }

    const users = [];
    const seenIds = new Set();
    for (const variant of variants) {
      // Try the full digit form first, then the last-10 form. Because users are
      // now indexed both ways, this matches regardless of which side carries the
      // country code.
      let u = userDigitSet.get(variant);
      if (!u && variant.length > 10) u = userDigitSet.get(variant.slice(-10));
      if (u && !seenIds.has(u.id)) {
        seenIds.add(u.id);
        users.push(u);
      }
    }

    if (users.length === 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'No active customers matched any of the supplied phone numbers.',
      });
    }
    targetUserIds = users.map(u => u.id);
    resolvedPhones = users.map(u => u.phone);

    // Identify which sanitized inputs didn't resolve to any customer. Use the
    // same digit-only comparison as the matching loop above so that an admin
    // who typed a 10-digit local number sees it reported as unmatched when
    // their input had no matching row, even when stored phones carry a
    // country code (and vice-versa).
    const matchedDigitSet = new Set();
    for (const u of users) {
      const d = stripDigits(u.phone);
      if (!d) continue;
      matchedDigitSet.add(d);
      if (d.length > 10) matchedDigitSet.add(d.slice(-10));
    }
    unmatchedPhones = sanitized.filter(phone => {
      const d = stripDigits(phone);
      if (!d) return false;
      if (matchedDigitSet.has(d)) return false;
      if (d.length > 10 && matchedDigitSet.has(d.slice(-10))) return false;
      return true;
    });
  } else {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Unsupported target' });
  }

  if (targetUserIds.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No recipients found for target' });
  }

  // notification_batches.area_id is NOT NULL and can't hold "every area" —
  // an 'all areas' broadcast still records the default area on this audit
  // row (getDefaultArea(), same fallback used wherever no single area
  // applies); targetLabel's own text is what actually documents true reach.
  const batchAreaId = areaId === 'all' ? (await getDefaultArea())?.id : areaId;

  const result = await notificationService.createBroadcastNotification({
    title,
    body,
    type,
    createdByAdminId: adminId,
    targetUserIds,
    targetName: target === 'phones' ? `phones:${resolvedPhones.join(',')}` : targetLabel,
    areaId: batchAreaId,
  });

  if (!result) {
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Failed to create broadcast notification' });
  }

  // Emit realtime events to all recipients so they get phone notifications.
  // Was N+1 (one SELECT per user); now a single batch SELECT + parallel emit.
  try {
    const [notifications] = await pool.query(
      'SELECT * FROM notifications WHERE user_id IN (?) AND batch_id = ? ORDER BY id DESC',
      [targetUserIds, result.batchId]
    );
    // Group by user_id (ordered DESC so the first per user is the most recent)
    const latestByUser = new Map();
    for (const n of notifications) {
      if (!latestByUser.has(Number(n.user_id))) {
        latestByUser.set(Number(n.user_id), n);
      }
    }
    await Promise.all(
      targetUserIds.map(async (userId) => {
        const notif = latestByUser.get(Number(userId));
        if (notif) {
          try {
            realtimeEvents.emitNotificationRow(userId, notif);
          } catch (error) {
            console.error(`Failed to emit notification to user ${userId}:`, error.message);
          }
        }
      })
    );
  } catch (error) {
    console.error('Failed to batch-load broadcast notifications:', error.message);
  }

  res.status(201).json({
    success: true,
    message: 'Broadcast sent successfully',
    data: {
      batchId: result.batchId,
      recipientCount: result.count,
      pushEligibleCount: result.pushEligibleCount ?? null,
      audienceNote,
      ...(target === 'phones'
        ? { matchedPhones: resolvedPhones, unmatchedPhones }
        : {}),
    }
  });
};

const getAdminNotificationById = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const { id } = req.params;
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];
  const [rows] = await pool.query(`SELECT * FROM notification_batches WHERE id = ?${areaClause}`, [id, ...areaParams]);

  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Notification batch not found' });
  }

  res.json({ data: rows[0] });
};

const deleteAdminNotification = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const { id } = req.params;
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];

  const [batchRows] = await pool.query(`SELECT * FROM notification_batches WHERE id = ?${areaClause}`, [id, ...areaParams]);
  if (batchRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Notification batch not found' });
  }

  await pool.query('UPDATE notification_batches SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  await pool.query('UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP WHERE batch_id = ?', [id]);

  res.json({ success: true, message: 'Broadcast deleted successfully' });
};

module.exports = {
  login,
  me,
  revokeSessions,
  getAdminCustomers,
  setBlockStatus,
  setTrustStatus,
  getDashboard,
  getSalesReport,
  getAdminOrders,
  getAdminOrderById,
  updateOrderStatus,
  extendAutoAccept,
  updateOrderPayment,
  updateOrderRemark,
  getAdminCustomerById,
  getTopProductsReport,
  getCustomersReport,
  getShopsReport,
  getProfitSummary,
  getProfitOrders,
  getAdminNotifications,
  createAdminNotification,
  getAdminNotificationById,
  deleteAdminNotification
};

// ──────────────────────────────────────────────────────────────────────────
// Admin-placed orders — lets an admin build and submit an order on behalf of
// an existing registered customer (phone lookup via GET /admin/customers),
// same money rules as the customer app. Both handlers resolve + validate the
// target customer, then delegate to the real cart/order controllers with
// req.user overridden to that customer — the money-calculation code itself
// is untouched, so cart preview and order creation stay byte-for-byte
// identical to what the customer would get placing it themselves.
// ──────────────────────────────────────────────────────────────────────────

const resolveOrderTargetCustomer = async (req, res) => {
  const customerId = Number(req.body?.customer_id || req.body?.customerId);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'customer_id is required' });
    return null;
  }
  const [rows] = await pool.query('SELECT id, blocked FROM users WHERE id = ?', [customerId]);
  const customer = rows[0];
  if (!customer) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Customer not found' });
    return null;
  }
  if (customer.blocked) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'This customer is blocked' });
    return null;
  }
  return customer;
};

// Multi-area audit finding (C1): admin-placed orders resolve their area from
// the customer PIN inside createOrder/calculateCart, NOT from the admin —
// so an area_admin could place an order into any area by pointing the pin
// there. Gate: the order's resolved area must equal the admin's scoped area
// (an area_admin is pinned to their own; a super_admin must pass an explicit
// X-Area-Id for the area they're placing into — 'all' and header-absent both
// reject a specific write).
const assertOrderAreaMatchesPin = async (req, res) => {
  const adminAreaId = requireOrderArea(req, res);
  if (adminAreaId === null) return false;
  // Accept the lat/lng aliases too, exactly as the downstream resolvers do
  // (cartController.calculateCart reads req.body.latitude ?? req.body.lat;
  // orderRoutes' createOrderSchema normalizes the same pair). Reading only
  // `latitude`/`longitude` here let a caller slip the gate by sending the
  // pin as `lat`/`lng`: this function saw no coordinates and waved the
  // request through, then calculateCart/createOrder resolved the aliased
  // pin into whatever area it actually falls in — placing an order outside
  // the admin's own area, which is the exact cross-area write this gate
  // exists to stop.
  const body = req.body || {};
  const latitude = body.latitude !== undefined ? body.latitude : body.lat;
  const longitude = body.longitude !== undefined ? body.longitude : body.lng;
  // A usable pin means BOTH coordinates present and numeric. A half-pin
  // (only one sent) or a non-numeric one is not something
  // resolveAreaIdForPricing can place either — it returns the default area
  // for those, same as for no pin at all — so they take the no-pin branch
  // rather than being cross-checked against a resolution that was never
  // real. Explicit null/''-checks rather than truthiness so latitude 0 still
  // counts as a provided coordinate.
  const coordProvided = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
  const hasPin = coordProvided(latitude) && coordProvided(longitude);
  // No pin at all (CreateOrderModal's map picker is optional — a phone order
  // taken without ever opening it) has nothing to cross-check: without
  // coordinates, resolveAreaIdForPricing can only fall back to the platform
  // DEFAULT area, which is neither "the area this order belongs to" nor
  // necessarily the admin's own scoped area, and would either misroute a
  // pinless order into the wrong area or 403 a legitimate one. Set the
  // override so calculateCart/createOrder use the admin's own area instead
  // of independently re-deriving (and landing on the default).
  if (!hasPin) {
    req.adminAreaOverride = Number(adminAreaId);
    return true;
  }
  const orderAreaId = await resolveAreaIdForPricing(latitude, longitude);
  if (orderAreaId !== Number(adminAreaId)) {
    res.status(403).json({
      code: 'FORBIDDEN',
      message: `Order resolves to area ${orderAreaId}; you are scoped to area ${adminAreaId}. Set the pin (and X-Area-Id) for that area.`,
    });
    return false;
  }
  return true;
};

const adminCalculateOrder = async (req, res) => {
  if (!(await assertOrderAreaMatchesPin(req, res))) return;
  const customer = await resolveOrderTargetCustomer(req, res);
  if (!customer) return;
  req.user = { id: customer.id };
  return calculateCart(req, res);
};

const adminCreateOrder = async (req, res) => {
  const customer = await resolveOrderTargetCustomer(req, res);
  if (!customer) return;
  req.user = { id: customer.id };
  return createOrder(req, res);
};

// ──────────────────────────────────────────────────────────────────────────
// Admin Inbox (bell icon). Distinct from the broadcast composer at
// /api/admin/notifications which targets customers.
// ──────────────────────────────────────────────────────────────────────────

const getInbox = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];
  const [rows] = await pool.query(
    `SELECT id, type, title, body, related_url, related_id, read_at, created_at
       FROM admin_notifications
      WHERE 1=1${areaClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [...areaParams, limit]
  );
  const [[count]] = await pool.query(
    `SELECT COUNT(*) AS n FROM admin_notifications WHERE read_at IS NULL${areaClause}`,
    areaParams
  );
  res.status(200).json({ data: rows, unread_count: Number(count.n) || 0 });
};

const getInboxUnreadCount = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const count = await adminInbox.getUnreadCount(areaId);
  res.status(200).json({ count });
};

const markInboxRead = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];
  await pool.query(
    `UPDATE admin_notifications SET read_at = NOW() WHERE id = ? AND read_at IS NULL${areaClause}`,
    [id, ...areaParams]
  );
  adminInbox.broadcastUnreadCount(areaId);
  res.status(200).json({ message: 'Marked as read' });
};

const markAllInboxRead = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];
  await pool.query(`UPDATE admin_notifications SET read_at = NOW() WHERE read_at IS NULL${areaClause}`, areaParams);
  adminInbox.broadcastUnreadCount(areaId);
  res.status(200).json({ message: 'All marked as read' });
};

const dismissInbox = async (req, res) => {
  const areaId = resolveAreaOrAll(req, res);
  if (areaId === undefined) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }
  const areaClause = areaId === 'all' ? '' : ' AND area_id = ?';
  const areaParams = areaId === 'all' ? [] : [areaId];
  await pool.query(`DELETE FROM admin_notifications WHERE id = ?${areaClause}`, [id, ...areaParams]);
  adminInbox.broadcastUnreadCount(areaId);
  res.status(200).json({ message: 'Dismissed' });
};

module.exports.adminCalculateOrder = adminCalculateOrder;
module.exports.adminCreateOrder = adminCreateOrder;
module.exports.getInbox = getInbox;
module.exports.getInboxUnreadCount = getInboxUnreadCount;
module.exports.markInboxRead = markInboxRead;
module.exports.markAllInboxRead = markAllInboxRead;
module.exports.dismissInbox = dismissInbox;
