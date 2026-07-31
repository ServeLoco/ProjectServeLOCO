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

router.get('/', asyncHandler(listActiveZonesPublic));

module.exports = router;
