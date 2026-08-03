const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../utils/asyncHandler');
const { getProducts, getProductById } = require('../controllers/productController');
const { resolveCustomerArea } = require('../middleware/areaMiddleware');
const { catalogETag } = require('../utils/areaScope');

const getLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: (req) => req.method !== 'GET'
});

router.use(getLimiter);

// 27.2 — catalogETag's ETag is keyed purely on <areaId>-<catalogVersion>, so
// it's only valid for the unfiltered "whole catalog" fetch. search/category/
// type/etc. all narrow the response body without changing catalog_version —
// applying the same ETag to those would 304 a genuinely different result
// set. Skip straight to the real handler whenever any of those are present.
const productsCatalogETag = (req, res, next) => {
  const { categoryId, category_id, search, type, storeType, store_type, isCombo, is_combo, featured, offerId, offer_id } = req.query;
  if (categoryId || category_id || search || type || storeType || store_type ||
      isCombo !== undefined || is_combo !== undefined || featured !== undefined || offerId || offer_id) {
    return next();
  }
  return catalogETag(req, res, next);
};

router.get('/', resolveCustomerArea, productsCatalogETag, asyncHandler(getProducts));
// Bug fix (multi-area audit finding #4) — this had no area resolution at
// all, so any product/combo id was fetchable regardless of which area it
// belongs to: a public cross-area catalog leak. Same resolveCustomerArea
// pin -> zone -> area chain as every other customer catalog route; the
// controller itself now 404s a mismatched area_id.
router.get('/:id', resolveCustomerArea, asyncHandler(getProductById));

module.exports = router;
