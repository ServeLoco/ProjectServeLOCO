const jwt = require('jsonwebtoken');
const config = require('../config/env');

const signCustomerToken = (userId) => {
  return jwt.sign(
    { sub: userId, role: 'customer' },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );
};

// adminRole/areaId are optional so any caller that genuinely has neither
// (there are none left in this codebase as of the multi-area audit fix —
// mobileAdminController's mint now passes adminRole: 'area_admin' too, since
// every requireAdmin-gated route reads req.areaId via requestAreaId(), which
// throws if area resolution never ran) still gets a token that verifies.
// See plans/multi-area.md §2.9.
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
