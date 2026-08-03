const { pool } = require('../db/mysql');
const { normalizePhone, mapMobileAdminRow } = require('../utils/mobileAdmins');
const { signAdminToken } = require('../utils/auth');
const { requestAreaId } = require('../utils/areaScope');

// mobile_admins carries a real area_id column (like shops/riders, TASK 3),
// but its own controller was never in any TASK 9-17 file list — a gap
// flagged during TASK 16/17 (multi-area-tasks.md ~L1039-1045, ~L1152-1157):
// the INSERT below never supplied area_id even though the column is
// NOT NULL with no default, so creating a mobile admin threw outright
// against the real schema. Same requireOneArea pattern as shops/riders.
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

const fetchMobileAdminRow = async (id) => {
  const [rows] = await pool.query(
    `SELECT ma.*, u.name AS user_name
     FROM mobile_admins ma
     LEFT JOIN users u ON u.id = ma.user_id
     WHERE ma.id = ?`,
    [id]
  );
  return rows.length > 0 ? mapMobileAdminRow(rows[0]) : null;
};

// D2 (extended to admin): reject if phone is an active shop owner or active rider.
const checkRoleExclusivity = async (userId) => {
  const [shopRows] = await pool.query(
    'SELECT id FROM shops WHERE owner_user_id = ? AND active = 1 LIMIT 1',
    [userId]
  );
  if (shopRows.length > 0) {
    return { code: 'ROLE_CONFLICT', message: 'Phone already assigned as shop owner. Remove or deactivate that role first.' };
  }
  const [riderRows] = await pool.query(
    'SELECT id FROM riders WHERE user_id = ? AND active = 1 LIMIT 1',
    [userId]
  );
  if (riderRows.length > 0) {
    return { code: 'ROLE_CONFLICT', message: 'Phone already assigned as rider. Remove or deactivate that role first.' };
  }
  return null;
};

// GET /api/admin/mobile-admins — every row (including inactive) for this area.
const listMobileAdmins = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const [rows] = await pool.query(
    `SELECT ma.*, u.name AS user_name
     FROM mobile_admins ma
     LEFT JOIN users u ON u.id = ma.user_id
     WHERE ma.area_id = ?
     ORDER BY ma.id ASC`,
    [areaId]
  );
  res.status(200).json({ mobileAdmins: rows.map(mapMobileAdminRow), mobile_admins: rows.map(mapMobileAdminRow) });
};

// POST /api/admin/mobile-admins — body { phone, displayName?, active? }
const createMobileAdmin = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const { phone, displayName, display_name, active } = req.body || {};

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'A valid 10-digit phone number is required' });
  }

  const [userRows] = await pool.query('SELECT id, name FROM users WHERE phone = ?', [normalized]);
  const userRow = userRows[0] || null;

  if (userRow) {
    const conflict = await checkRoleExclusivity(userRow.id);
    if (conflict) return res.status(409).json(conflict);
  }

  const name = String(displayName || display_name || userRow?.name || '').trim() || null;
  const isActive = active === undefined ? true : Boolean(active);

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO mobile_admins (area_id, phone, display_name, user_id, active)
       VALUES (?, ?, ?, ?, ?)`,
      [areaId, normalized, name, userRow?.id ?? null, isActive ? 1 : 0]
    );
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: 'ALREADY_MOBILE_ADMIN', message: 'That phone is already a mobile admin.' });
    }
    throw e;
  }

  const mobileAdmin = await fetchMobileAdminRow(result.insertId);
  res.status(201).json({ mobileAdmin, mobile_admin: mobileAdmin });
};

// PATCH /api/admin/mobile-admins/:id — body may contain displayName, active, phone
const updateMobileAdmin = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const { id } = req.params;
  const { displayName, display_name, active, phone } = req.body || {};

  const [existing] = await pool.query('SELECT * FROM mobile_admins WHERE id = ? AND area_id = ?', [id, areaId]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Mobile admin not found' });
  }
  const current = existing[0];

  const sets = [];
  const values = [];
  let nextUserId = current.user_id;

  if (phone !== undefined) {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'A valid 10-digit phone number is required' });
    }
    const [dupRows] = await pool.query(
      'SELECT id FROM mobile_admins WHERE phone = ? AND id != ? LIMIT 1',
      [normalized, id]
    );
    if (dupRows.length > 0) {
      return res.status(409).json({ code: 'ALREADY_MOBILE_ADMIN', message: 'That phone is already a mobile admin.' });
    }
    const [userRows] = await pool.query('SELECT id FROM users WHERE phone = ?', [normalized]);
    nextUserId = userRows[0]?.id ?? null;
    sets.push('phone = ?');
    values.push(normalized);
    sets.push('user_id = ?');
    values.push(nextUserId);
  }

  if (displayName !== undefined || display_name !== undefined) {
    const name = String(displayName ?? display_name ?? '').trim() || null;
    sets.push('display_name = ?');
    values.push(name);
  }

  if (active !== undefined) {
    sets.push('active = ?');
    values.push(active ? 1 : 0);
  }

  // Role exclusivity whenever the resulting row would be active and linked to
  // a user — covers reactivate AND phone reassignment while already active.
  const willBeActive = active !== undefined ? Boolean(active) : Boolean(current.active);
  const phoneChanging = phone !== undefined;
  const activating = active !== undefined && Boolean(active) && !current.active;
  if (willBeActive && nextUserId && (phoneChanging || activating)) {
    const conflict = await checkRoleExclusivity(nextUserId);
    if (conflict) return res.status(409).json(conflict);
  }

  if (sets.length > 0) {
    values.push(id, areaId);
    await pool.query(`UPDATE mobile_admins SET ${sets.join(', ')} WHERE id = ? AND area_id = ?`, values);
  }

  const mobileAdmin = await fetchMobileAdminRow(id);
  res.status(200).json({ mobileAdmin, mobile_admin: mobileAdmin, message: 'Mobile admin updated' });
};

// POST /api/admin/mobile-session — requireCustomer. OTP-logged-in phones that
// are active mobile admins mint an admin JWT here (dual-token design, §2 of
// plans/admin-mode-mobile.md) — no customer-JWT-on-admin-routes rewrite needed.
const mintMobileSession = async (req, res) => {
  const userId = req.user.id;

  const [rows] = await pool.query(
    'SELECT id, phone, user_id, active FROM mobile_admins WHERE user_id = ? AND active = 1 LIMIT 1',
    [userId]
  );
  let mobileAdmin = rows[0] || null;

  if (!mobileAdmin) {
    // Not yet backfilled: owner may have added this phone before it ever
    // logged in. Look up by phone and backfill user_id now.
    const [userRows] = await pool.query('SELECT phone FROM users WHERE id = ?', [userId]);
    const phone = userRows[0]?.phone;
    if (phone) {
      const [byPhone] = await pool.query(
        'SELECT id, phone, user_id, active FROM mobile_admins WHERE phone = ? AND active = 1 LIMIT 1',
        [phone]
      );
      mobileAdmin = byPhone[0] || null;
      if (mobileAdmin && !mobileAdmin.user_id) {
        await pool.query('UPDATE mobile_admins SET user_id = ? WHERE id = ?', [userId, mobileAdmin.id]);
      }
    }
  }

  if (!mobileAdmin) {
    return res.status(403).json({ code: 'NOT_MOBILE_ADMIN', message: 'This phone is not an active mobile admin.' });
  }

  const token = signAdminToken(`mobile:${mobileAdmin.id}`);
  res.status(200).json({
    token,
    user: { id: mobileAdmin.id, role: 'admin', mobileAdminId: mobileAdmin.id },
  });
};

module.exports = {
  listMobileAdmins,
  createMobileAdmin,
  updateMobileAdmin,
  mintMobileSession,
};
