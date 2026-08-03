const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { getCategories } = require('../controllers/categoryController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');
const { catalogETag } = require('../utils/areaScope');

const getLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'GET'
});

router.use(getLimiter);

// 27.2 — catalogETag's ETag is keyed purely on <areaId>-<catalogVersion>,
// valid only for the unfiltered fetch. getCategories reads ?type/storeType
// to narrow the response without changing catalog_version, so skip ETag
// whenever that's present — same guard as productRoutes.js's version.
const categoriesCatalogETag = (req, res, next) => {
  const { type, storeType, store_type } = req.query;
  if (type || storeType || store_type) return next();
  return catalogETag(req, res, next);
};

router.get('/', resolveCustomerArea, categoriesCatalogETag, asyncHandler(getCategories));

module.exports = router;
