const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { listActiveZonesPublic } = require('../controllers/deliveryZonesController');

const getLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'GET'
});

router.use(getLimiter);

// Returns every active zone across every area — a customer can be anywhere
// on the map, not just inside the area they last ordered from. No area
// resolution needed for a global listing.
router.get('/', asyncHandler(listActiveZonesPublic));

module.exports = router;
