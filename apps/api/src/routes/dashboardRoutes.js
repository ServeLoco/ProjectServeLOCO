const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { getDashboard, getSectionItems } = require('../controllers/dashboardController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');

router.get('/', resolveCustomerArea, asyncHandler(getDashboard));
router.get('/sections/:slug/items', resolveCustomerArea, asyncHandler(getSectionItems));

module.exports = router;
