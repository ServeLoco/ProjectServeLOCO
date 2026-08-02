const { pool } = require('../db/mysql');

// Runs AFTER requireCustomer (so req.user.id exists). Fresh DB check per
// request — no caching, because an admin may revoke a shop at any time.
const requireShopOwner = async (req, res, next) => {
  const [rows] = await pool.query(
    'SELECT id, name, is_open, active, open_time, close_time, area_id FROM shops WHERE owner_user_id = ? AND active = 1 LIMIT 1',
    [req.user.id]
  );
  if (rows.length === 0) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not a shop owner' });
  }
  req.shop = rows[0];
  next();
};

module.exports = { requireShopOwner };
