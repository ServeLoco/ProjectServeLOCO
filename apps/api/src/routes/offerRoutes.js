const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { getActiveOffer } = require('../controllers/settingsController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');

router.get('/active', resolveCustomerArea, asyncHandler(getActiveOffer));

module.exports = router;
