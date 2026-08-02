const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { getProducts, getProductById } = require('../controllers/productController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');

const getLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'GET'
});

router.use(getLimiter);

router.get('/', resolveCustomerArea, asyncHandler(getProducts));
router.get('/:id', asyncHandler(getProductById));

module.exports = router;
