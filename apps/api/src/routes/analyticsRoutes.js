const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { requireCustomer, requireAdmin } = require('../middleware/authMiddleware');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');
const { postEvents, getSummary, getProducts, getWindowShoppers, getUserDrillDown, getHourly, getActiveUsers } = require('../controllers/analyticsController');

// Customer analytics router — mounted at /api/analytics
const router = express.Router();

// 6 req/min per user. requireCustomer runs BEFORE this limiter in the route
// stack, so req.user.id is always set for authenticated requests. We key on
// that (no req.ip fallback — avoids the express-rate-limit IPv6 validation).
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => String(req.user?.id || 'anon'),
  message: { code: 'TOO_MANY_REQUESTS', message: 'Too many analytics requests, please try again later.' },
});

router.post('/events', requireCustomer, resolveCustomerArea, eventsLimiter, asyncHandler(postEvents));

// Admin analytics router — mounted at /api/admin/analytics
const adminRouter = express.Router();
adminRouter.use(requireAdmin);
adminRouter.get('/summary', asyncHandler(getSummary));
adminRouter.get('/products', asyncHandler(getProducts));
adminRouter.get('/window-shoppers', asyncHandler(getWindowShoppers));
adminRouter.get('/user/:id', asyncHandler(getUserDrillDown));
adminRouter.get('/hourly', asyncHandler(getHourly));
adminRouter.get('/active-users', asyncHandler(getActiveUsers));

module.exports = router;
module.exports.adminRouter = adminRouter;
