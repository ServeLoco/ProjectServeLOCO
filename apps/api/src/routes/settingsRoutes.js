const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { getSettings } = require('../controllers/settingsController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');
const { catalogETag } = require('../utils/areaScope');

const getLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'GET'
});

router.use(getLimiter);

router.get('/', resolveCustomerArea, catalogETag, asyncHandler(getSettings));

module.exports = router;
