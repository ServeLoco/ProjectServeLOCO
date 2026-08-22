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
//
// envFallback marks a token minted via the legacy ADMIN_PASSWORD/
// ADMIN_PASSWORD_HASH env bootstrap (adminController.js login,
// usedEnvFallback branch) rather than a real `admins` table row.
// authMiddleware's live re-check must skip these explicitly — it used to
// infer "no admins row to re-check" from adminId being non-numeric, which
// silently breaks the one emergency recovery path whenever ADMIN_OWNER_ID
// happens to be a numeric value (nothing enforces it isn't).
const signAdminToken = (adminId, { adminRole, areaId, envFallback } = {}) => {
  const payload = { sub: adminId, role: 'admin' };
  if (adminRole !== undefined) payload.adminRole = adminRole;
  if (adminRole !== undefined) payload.areaId = areaId ?? null;
  if (envFallback) payload.envFallback = true;
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
