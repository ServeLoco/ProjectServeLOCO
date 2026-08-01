const jwt = require('jsonwebtoken');
const config = require('../config/env');

const signCustomerToken = (userId) => {
  return jwt.sign(
    { sub: userId, role: 'customer' },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );
};

// adminRole/areaId are optional so existing callers (mobileAdminController's
// mobile-admin session mint) keep working unchanged — they don't carry a
// super_admin/area_admin role at all, that's a separate concept from the
// `admins` table. See plans/multi-area.md §2.9.
const signAdminToken = (adminId, { adminRole, areaId } = {}) => {
  const payload = { sub: adminId, role: 'admin' };
  if (adminRole !== undefined) payload.adminRole = adminRole;
  if (adminRole !== undefined) payload.areaId = areaId ?? null;
  return jwt.sign(
    payload,
    config.JWT_SECRET,
    { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h' }
  );
};

const verifyToken = (token) => {
  return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
};

module.exports = {
  signCustomerToken,
  signAdminToken,
  verifyToken
};
