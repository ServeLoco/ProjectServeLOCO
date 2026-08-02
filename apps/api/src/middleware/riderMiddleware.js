const { pool } = require('../db/mysql');

// Runs AFTER requireCustomer (so req.user.id exists). Fresh DB check per
// request — no caching, because an admin may revoke a rider at any time.
const requireRider = async (req, res, next) => {
  const [rows] = await pool.query(
    `SELECT id, user_id, area_id, display_name, phone, active, is_online
     FROM riders
     WHERE user_id = ? AND active = 1
     LIMIT 1`,
    [req.user.id]
  );
  if (rows.length === 0) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not a rider' });
  }
  req.rider = rows[0];
  next();
};

module.exports = { requireRider };
