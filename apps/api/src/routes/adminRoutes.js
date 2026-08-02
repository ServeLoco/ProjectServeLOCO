const express = require('express');
const multer = require('multer');
const { login, me, revokeSessions, getAdminCustomers, getAdminCustomerById, setBlockStatus, setTrustStatus, getDashboard, getSalesReport, getTopProductsReport, getCustomersReport, getShopsReport, getProfitSummary, getProfitOrders, getAdminOrders, getAdminOrderById, updateOrderStatus, updateOrderPayment, updateOrderRemark, extendAutoAccept, adminCalculateOrder, adminCreateOrder, getAdminNotifications, createAdminNotification, getAdminNotificationById, deleteAdminNotification, getInbox, getInboxUnreadCount, markInboxRead, markAllInboxRead, dismissInbox } = require('../controllers/adminController');
const { createOrderSchema, expressValidatorChecks: orderExpressValidatorChecks, validateExpress: validateOrderExpress } = require('./orderRoutes');
const { getSettings, updateSettings, getActiveOffer, createOffer, updateOffer, getAdminOffers, deleteOffer, getOfferProducts, addOfferProduct, removeOfferProduct, reorderOfferProducts } = require('../controllers/settingsController');
const { listZones, createZone, updateZone, deleteZone } = require('../controllers/deliveryZonesController');
const { createCategory, deleteCategory, getAdminCategories, updateCategory } = require('../controllers/categoryController');
const { getAdminStoreModes, createStoreMode, updateStoreMode } = require('../controllers/storeModeController');
const { createProduct, updateProduct, getAdminProducts, getAdminProductById, deleteProduct, updateProductAvailability, updateVariantAvailability, updateProductImage, bulkUpdateProducts, bulkDeleteProducts, updateProductPricing } = require('../controllers/productController');
const { createCombo, updateCombo, getAdminCombos, getAdminComboById, deleteCombo, updateComboAvailability } = require('../controllers/comboController');
const {
  listShops,
  createShop,
  updateShop,
  updateShopSchedule,
  deleteShop,
  listShopOrders,
  adminConfirmShopOrder,
  adminRejectShopOrder,
  adminReadyShopOrder,
  listShopGroups,
  createShopGroup,
  updateShopGroup,
  deleteShopGroup,
  assignShopProductGroup,
} = require('../controllers/shopAdminController');
const {
  listRiders,
  createRider,
  updateRider,
  deleteRider,
  getRiderDispatch,
  adminSetRiderOnline,
  adminAcceptOffer,
  adminRejectOffer,
  adminMarkPickedUp,
  adminUpdateAssignmentStatus,
} = require('../controllers/adminRiderController');
const { listMobileAdmins, createMobileAdmin, updateMobileAdmin, mintMobileSession } = require('../controllers/mobileAdminController');
const { getNotificationTemplates, updateNotificationTemplate, resetNotificationTemplate } = require('../controllers/notificationTemplateController');
const { previewBulkImport, commitBulkImport } = require('../controllers/bulkImportController');
const {
  getAdminCoupons,
  getAdminCouponById,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  duplicateCoupon,
  getCouponRedemptions,
} = require('../controllers/couponController');
const {
  getAdminSections,
  getAdminSectionById,
  createAdminSection,
  updateAdminSection,
  deleteAdminSection,
  addAdminSectionItem,
  updateAdminSectionItem,
  deleteAdminSectionItem,
  reorderAdminSections,
  reorderAdminSectionItems
} = require('../controllers/dashboardController');
const { requireAdmin, requireCustomer, requireSuperAdmin } = require('../middleware/authMiddleware');
const {
  getLibrary,
  createLibraryProduct,
  updateLibraryProduct,
  archiveLibraryProduct,
  addLibraryProductToArea,
  addLibraryProductToAreas,
  promoteProductToLibrary,
} = require('../controllers/libraryController');
const {
  getAdminAreas,
  createArea,
  updateArea,
  deleteArea,
  cloneArea,
  getAdminAdmins,
  createAdmin,
  updateAdmin,
} = require('../controllers/areaController');
const { validate, isString, isId, isBoolean, isNumericAmount, isPositiveInteger, isNonNegativeInteger, validatePagination, normalizeField } = require('../validators');
const asyncHandler = require('../utils/asyncHandler');
const rateLimit = require('express-rate-limit');


const router = express.Router();

// Bulk import multer — in-memory, no rate limiting (admin-only route)
// CSV/XLSX: max 10 MB | ZIP: max 50 MB
const BULK_CSV_MAX_BYTES = parseInt(process.env.MAX_BULK_CSV_SIZE_MB || '10') * 1024 * 1024;
const BULK_ZIP_MAX_BYTES = parseInt(process.env.MAX_BULK_IMPORT_SIZE_MB || '50') * 1024 * 1024;

const bulkUpload = (req, res, next) => {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: BULK_ZIP_MAX_BYTES }, // largest single file allowed
  }).fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'imagesZip', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return next(err);
    // Secondary check: CSV/XLSX should not be > 10 MB
    const csv = req.files?.csvFile?.[0];
    if (csv && csv.size > BULK_CSV_MAX_BYTES) {
      return res.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: `Spreadsheet file exceeds the ${process.env.MAX_BULK_CSV_SIZE_MB || 10} MB limit.`,
      });
    }
    next();
  });
};

// Login brute-force guard. Was 5/15min — too easy to lock yourself out after
// a legitimate retry storm (or a buggy client burning the global limit first).
// 30/15min still slows password spraying; success clears UX via session.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many login attempts. Wait a few minutes and try again.',
  },
});

const mobileSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // higher than password login — legitimate re-mints happen every ~12h per admin JWT expiry
  message: { code: 'TOO_MANY_REQUESTS', message: 'Too many session requests, please try again later.' }
});

const loginSchema = (req) => {
  const errors = {};
  const data = {
    id: normalizeField(req, 'ownerId', 'owner_id'),
    password: normalizeField(req, 'password', 'password')
  };

  if (!isString(data.id)) errors.id = 'Admin ID is required';
  if (!isString(data.password)) errors.password = 'Password is required';

  return { errors, data };
};

const paginationSchema = (req) => {
  const page = normalizeField(req, 'page', 'page');
  const limit = normalizeField(req, 'limit', 'limit');
  return { errors: {}, data: validatePagination(page, limit) };
};

const blockSchema = (req) => {
  const errors = {};
  const data = {
    id: req.params.id,
    blocked: normalizeField(req, 'blocked', 'blocked')
  };

  if (!isId(data.id)) errors.id = 'Valid User ID is required in URL';
  if (!isBoolean(data.blocked)) errors.blocked = 'Blocked status must be a boolean';

  // Normalize boolean
  data.blocked = data.blocked === true || data.blocked === 'true' || data.blocked === 1;

  return { errors, data };
};

const trustSchema = (req) => {
  const errors = {};
  const data = {
    id: req.params.id,
    trusted: normalizeField(req, 'trusted', 'trusted')
  };

  if (!isId(data.id)) errors.id = 'Valid User ID is required in URL';
  if (!isBoolean(data.trusted)) errors.trusted = 'Trusted status must be a boolean';

  data.trusted = data.trusted === true || data.trusted === 'true' || data.trusted === 1;

  return { errors, data };
};

const categorySchema = (req) => {
  const data = {
    name: normalizeField(req, 'name', 'name'),
    slug: normalizeField(req, 'slug', 'slug'),
    type: normalizeField(req, 'type', 'type'),
    image_id: normalizeField(req, 'imageId', 'image_id'),
    active: normalizeField(req, 'active', 'active'),
    display_order: normalizeField(req, 'displayOrder', 'display_order')
  };
  const errors = {};
  if (!isString(data.name)) errors.name = 'Name is required';
  if (!isString(data.type)) errors.type = 'Type is required';
  if (data.active !== undefined && !isBoolean(data.active)) errors.active = 'Active must be boolean';
  if (data.display_order !== undefined && !isNonNegativeInteger(data.display_order)) {
    errors.display_order = 'Display order must be a whole number greater than or equal to 0';
  }
  
  if (data.active !== undefined) {
    data.active = data.active === true || data.active === 'true' || data.active === 1;
  }
  if (data.display_order !== undefined) {
    data.display_order = Number(data.display_order);
  }
  return { errors, data };
};

const productSchema = (req) => {
  const rawComboItems = normalizeField(req, 'comboItems', 'combo_items');
  const rawVariants = normalizeField(req, 'variants', 'variants');
  const data = {
    name: normalizeField(req, 'name', 'name'),
    price: normalizeField(req, 'price', 'price'),
    shop_price: normalizeField(req, 'shopPrice', 'shop_price'),
    category_id: normalizeField(req, 'categoryId', 'category_id'),
    unit: normalizeField(req, 'unit', 'unit'),
    description: normalizeField(req, 'description', 'description'),
    image_id: normalizeField(req, 'imageId', 'image_id'),
    available: normalizeField(req, 'available', 'available'),
    is_combo: normalizeField(req, 'isCombo', 'is_combo'),
    featured: normalizeField(req, 'featured', 'featured'),
    display_order: normalizeField(req, 'displayOrder', 'display_order'),
    original_price: normalizeField(req, 'originalPrice', 'original_price'),
    discount_label: normalizeField(req, 'discountLabel', 'discount_label'),
    available_from_time: normalizeField(req, 'availableFromTime', 'available_from_time'),
    available_until_time: normalizeField(req, 'availableUntilTime', 'available_until_time'),
    combo_items: Array.isArray(rawComboItems) ? rawComboItems.map((item, index) => ({
      product_id: item.productId || item.product_id || item.id,
      quantity: item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 1),
      display_order: item.displayOrder || item.display_order || index,
    })) : undefined,
    variants: Array.isArray(rawVariants) ? rawVariants.map((v, i) => ({
      id: v.id || null,
      label: v.label,
      price: v.price,
      // undefined (key absent) preserves the stored value on update; null
      // clears it explicitly — see syncProductVariants's sendsShopPrice guard.
      shop_price: v.shopPrice !== undefined ? v.shopPrice : v.shop_price,
      original_price: v.originalPrice ?? v.original_price ?? null,
      available: v.available !== undefined ? Boolean(v.available) : true,
      is_default: Boolean(v.isDefault ?? v.is_default),
      display_order: v.displayOrder ?? v.display_order ?? i,
    })) : undefined,
    variant_prompt: normalizeField(req, 'variantPrompt', 'variant_prompt'),
    shop_id: normalizeField(req, 'shopId', 'shop_id'),
  };
  const errors = {};
  if (!isString(data.name)) errors.name = 'Name is required';
  if (!isNumericAmount(data.price)) errors.price = 'Valid price is required';
  if (!isId(data.category_id)) errors.category_id = 'Category ID is required';
  const isTimeString = (v) => typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v);
  if (data.available_from_time !== undefined && data.available_from_time !== null && data.available_from_time !== '' && !isTimeString(data.available_from_time)) {
    errors.available_from_time = 'Available from time must be in HH:MM or HH:MM:SS format';
  }
  if (data.available_until_time !== undefined && data.available_until_time !== null && data.available_until_time !== '' && !isTimeString(data.available_until_time)) {
    errors.available_until_time = 'Available until time must be in HH:MM or HH:MM:SS format';
  }
  if (data.available_from_time === '' || data.available_from_time === null) data.available_from_time = null;
  if (data.available_until_time === '' || data.available_until_time === null) data.available_until_time = null;
  if (data.original_price !== undefined && data.original_price !== null && data.original_price !== '') {
    if (!isNumericAmount(data.original_price)) {
      errors.original_price = 'Original price must be a valid amount';
    } else if (isNumericAmount(data.price) && Number(data.original_price) < Number(data.price)) {
      errors.original_price = 'Original price cannot be lower than selling price';
    } else {
      data.original_price = Number(data.original_price);
    }
  }
  // shop_price: what we owe the shop for this item. Optional, no default
  // (NULL = "not configured yet"). Deliberately NOT compared against price —
  // margin can be negative if the admin is temporarily eating a loss, and
  // that's a business call, not a validation error.
  if (data.shop_price !== undefined && data.shop_price !== null && data.shop_price !== '') {
    if (!isNumericAmount(data.shop_price)) {
      errors.shop_price = 'Shop price must be a valid amount';
    } else {
      data.shop_price = Number(data.shop_price);
    }
  } else if (data.shop_price === '') {
    data.shop_price = null;
  }

  if (data.available !== undefined && !isBoolean(data.available)) errors.available = 'Available must be boolean';
  if (data.is_combo !== undefined && !isBoolean(data.is_combo)) errors.is_combo = 'is_combo must be boolean';
  if (data.featured !== undefined && !isBoolean(data.featured)) errors.featured = 'featured must be boolean';
  // shop_id: optional positive integer or null (null/'' = house product, no shop).
  if (data.shop_id !== undefined && data.shop_id !== null && data.shop_id !== '') {
    if (!isPositiveInteger(data.shop_id)) {
      errors.shop_id = 'shop_id must be a positive integer or null';
    } else {
      data.shop_id = Number(data.shop_id);
    }
  }
  if (data.shop_id === '' || data.shop_id === null) data.shop_id = null;
  if (data.combo_items !== undefined) {
    for (let i = 0; i < data.combo_items.length; i++) {
      const item = data.combo_items[i];
      if (!isId(item.product_id)) errors.combo_items = `Combo item ${i + 1}: valid product is required`;
      if (!isPositiveInteger(item.quantity)) {
        errors.combo_items = `Combo item ${i + 1}: quantity must be a whole number between 1 and 999`;
      }
      item.quantity = Number(item.quantity) || 1;
      item.display_order = isNonNegativeInteger(item.display_order) ? Number(item.display_order) : i;
    }
  }
  // Variant validation: labels non-empty ≤ 100 chars, unique (case-insensitive),
  // numeric price per row, exactly one is_default (auto-mark index 0 if none),
  // max 20 variants, variant_prompt ≤ 100 chars if present.
  if (data.variants !== undefined) {
    if (data.variants.length > 20) {
      errors.variants = 'A product can have at most 20 variants';
    }
    const labels = new Set();
    for (let i = 0; i < data.variants.length; i++) {
      const v = data.variants[i];
      // A truthy id must be a valid numeric id — otherwise the upsert's
      // UPDATE ... WHERE id = ? silently matches zero rows and the row the
      // caller thought they were editing vanishes with no error surfaced.
      if (v.id && !isId(v.id)) {
        errors.variants = `Variant ${i + 1}: id must be a valid numeric id`;
      } else if (v.id) {
        v.id = Number(v.id);
      }
      if (!isString(v.label) || String(v.label).trim() === '' || String(v.label).length > 100) {
        errors.variants = `Variant ${i + 1}: label must be a non-empty string of at most 100 characters`;
      }
      const lowerLabel = String(v.label || '').toLowerCase().trim();
      if (labels.has(lowerLabel)) {
        errors.variants = `Variant ${i + 1}: duplicate label "${v.label}"`;
      }
      labels.add(lowerLabel);
      if (!isNumericAmount(v.price)) {
        errors.variants = `Variant ${i + 1}: valid price is required`;
      } else {
        v.price = Number(v.price);
      }
      if (v.shop_price !== null && v.shop_price !== undefined && v.shop_price !== '') {
        if (!isNumericAmount(v.shop_price)) {
          errors.variants = `Variant ${i + 1}: shop price must be a valid amount`;
        } else {
          v.shop_price = Number(v.shop_price);
        }
      } else if (v.shop_price === '') {
        v.shop_price = null;
      }
      if (v.original_price !== null && v.original_price !== undefined && v.original_price !== '') {
        if (!isNumericAmount(v.original_price)) {
          errors.variants = `Variant ${i + 1}: original price must be a valid amount`;
        } else {
          v.original_price = Number(v.original_price);
        }
      } else {
        v.original_price = null;
      }
    }
    if (data.variants.length > 0) {
      const defaultCount = data.variants.filter(v => v.is_default).length;
      if (defaultCount === 0) {
        data.variants[0].is_default = true;
      } else if (defaultCount > 1) {
        errors.variants = 'Exactly one variant must be marked as default';
      }
    }
  }
  if (data.variant_prompt !== undefined && data.variant_prompt !== null && data.variant_prompt !== '') {
    if (!isString(data.variant_prompt) || String(data.variant_prompt).length > 100) {
      errors.variant_prompt = 'Choice prompt must be a string of at most 100 characters';
    }
  } else if (data.variant_prompt === '') {
    data.variant_prompt = null;
  }
  
  if (data.available !== undefined) {
    data.available = data.available === true || data.available === 'true' || data.available === 1;
  }
  if (data.is_combo !== undefined) {
    data.is_combo = data.is_combo === true || data.is_combo === 'true' || data.is_combo === 1;
  }
  if (data.featured !== undefined) {
    data.featured = data.featured === true || data.featured === 'true' || data.featured === 1;
  }
  if (data.display_order !== undefined && !isNonNegativeInteger(data.display_order)) {
    errors.display_order = 'Display order must be a whole number greater than or equal to 0';
  }
  if (data.display_order !== undefined) {
    data.display_order = Number(data.display_order) || 0;
  }
  if (isNumericAmount(data.price)) {
    data.price = Number(data.price);
  }
  return { errors, data };
};

const comboSchema = (req) => {
  const rawComboItems = normalizeField(req, 'comboItems', 'combo_items');
  const data = {
    name: normalizeField(req, 'name', 'name'),
    price: normalizeField(req, 'price', 'price'),
    unit: normalizeField(req, 'unit', 'unit'),
    description: normalizeField(req, 'description', 'description'),
    image_id: normalizeField(req, 'imageId', 'image_id'),
    available: normalizeField(req, 'available', 'available'),
    featured: normalizeField(req, 'featured', 'featured'),
    display_order: normalizeField(req, 'displayOrder', 'display_order'),
    original_price: normalizeField(req, 'originalPrice', 'original_price'),
    discount_label: normalizeField(req, 'discountLabel', 'discount_label'),
    combo_items: Array.isArray(rawComboItems) ? rawComboItems.map((item, index) => ({
      product_id: item.productId || item.product_id || item.id,
      quantity: item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 1),
      display_order: item.displayOrder || item.display_order || index,
    })) : undefined,
    store_type: normalizeField(req, 'storeType', 'store_type'),
  };
  const errors = {};
  if (!isString(data.name)) errors.name = 'Name is required';
  if (!isNumericAmount(data.price)) errors.price = 'Valid price is required';
  if (data.original_price !== undefined && data.original_price !== null && data.original_price !== '') {
    if (!isNumericAmount(data.original_price)) {
      errors.original_price = 'Original price must be a valid amount';
    } else if (isNumericAmount(data.price) && Number(data.original_price) < Number(data.price)) {
      errors.original_price = 'Original price cannot be lower than selling price';
    } else {
      data.original_price = Number(data.original_price);
    }
  }
  
  if (data.available !== undefined && !isBoolean(data.available)) errors.available = 'Available must be boolean';
  // Format check only — the controller validates the slug against the
  // store_modes table (this schema fn is sync, so no DB access here).
  if (!data.store_type || !/^[a-z][a-z0-9_]{1,30}$/.test(String(data.store_type))) {
    errors.store_type = 'Store type is required and must be a valid store mode slug';
  }
  if (data.featured !== undefined && !isBoolean(data.featured)) errors.featured = 'featured must be boolean';
  if (data.combo_items !== undefined) {
    for (let i = 0; i < data.combo_items.length; i++) {
      const item = data.combo_items[i];
      if (!isId(item.product_id)) errors.combo_items = `Combo item ${i + 1}: valid product is required`;
      if (!isPositiveInteger(item.quantity)) {
        errors.combo_items = `Combo item ${i + 1}: quantity must be a whole number between 1 and 999`;
      }
      item.quantity = Number(item.quantity) || 1;
      item.display_order = isNonNegativeInteger(item.display_order) ? Number(item.display_order) : i;
    }
  }
  
  if (data.available !== undefined) {
    data.available = data.available === true || data.available === 'true' || data.available === 1;
  }
  if (data.featured !== undefined) {
    data.featured = data.featured === true || data.featured === 'true' || data.featured === 1;
  }
  if (data.display_order !== undefined && !isNonNegativeInteger(data.display_order)) {
    errors.display_order = 'Display order must be a whole number greater than or equal to 0';
  }
  if (data.display_order !== undefined) {
    data.display_order = Number(data.display_order) || 0;
  }
  if (isNumericAmount(data.price)) {
    data.price = Number(data.price);
  }
  return { errors, data };
};

const productAvailabilitySchema = (req) => {
  const available = normalizeField(req, 'available', 'available');
  const isAvailable = normalizeField(req, 'isAvailable', 'is_available');
  const finalAvailable = available !== undefined ? available : isAvailable;
  const errors = {};

  if (!isId(req.params.id)) errors.id = 'Valid Product ID is required in URL';
  if (!isBoolean(finalAvailable)) errors.available = 'Availability status must be a boolean';

  return { errors, data: { id: req.params.id, available: finalAvailable } };
};

const variantAvailabilitySchema = (req) => {
  const available = normalizeField(req, 'available', 'available');
  const isAvailable = normalizeField(req, 'isAvailable', 'is_available');
  const finalAvailable = available !== undefined ? available : isAvailable;
  const errors = {};

  if (!isId(req.params.id)) errors.id = 'Valid Product ID is required in URL';
  if (!isId(req.params.variantId)) errors.variantId = 'Valid Variant ID is required in URL';
  if (!isBoolean(finalAvailable)) errors.available = 'Availability status must be a boolean';

  return { errors, data: { id: req.params.id, variantId: req.params.variantId, available: finalAvailable } };
};

const comboAvailabilitySchema = (req) => {
  const available = normalizeField(req, 'available', 'available');
  const isAvailable = normalizeField(req, 'isAvailable', 'is_available');
  const finalAvailable = available !== undefined ? available : isAvailable;
  const errors = {};

  if (!isId(req.params.id)) errors.id = 'Valid Combo ID is required in URL';
  if (!isBoolean(finalAvailable)) errors.available = 'Availability status must be a boolean';

  return { errors, data: { id: req.params.id, available: finalAvailable } };
};

const productImageSchema = (req) => {
  const imageId = normalizeField(req, 'imageId', 'image_id');
  const errors = {};

  if (!isId(req.params.id)) errors.id = 'Valid Product ID is required in URL';
  if (!isString(imageId)) errors.image_id = 'Image ID is required';

  return { errors, data: { id: req.params.id, image_id: imageId } };
};

const dashboardSectionSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  // Category grid cards already show their own names — the section title
  // above the grid is the only block type where it's optional.
  const titleOptional = body.section_type === 'category_grid';
  const titleBlank = !body.title || typeof body.title !== 'string' || body.title.trim() === '';
  if (titleBlank && !titleOptional) {
    errors.push('title is required');
  } else {
    data.title = titleBlank ? '' : body.title.trim();
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) errors.push('display_order must be a non-negative integer');
    else data.display_order = n;
  }
  if (body.active !== undefined) {
    data.active = (body.active === true || body.active === 'true' || body.active === 1 || body.active === '1') ? 1 : 0;
  }
  return { errors, data };
};

const dashboardSectionReorderSchema = (req) => {
  const errors = [];
  const data = {};
  const ids = req.body?.sectionIds;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(Number(id)) || Number(id) < 0)) {
    errors.push('sectionIds must be an array of non-negative integers');
  } else {
    data.sectionIds = ids.map(Number);
  }
  return { errors, data };
};

const dashboardSectionUpdateSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  if (body.title !== undefined) {
    const titleBlank = typeof body.title !== 'string' || body.title.trim() === '';
    // Same category_grid exemption as create — an admin clearing the title
    // on an existing category grid section must not be blocked.
    if (titleBlank && body.section_type !== 'category_grid') {
      errors.push('title must be a non-empty string');
    } else {
      data.title = titleBlank ? '' : body.title.trim();
    }
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) errors.push('display_order must be a non-negative integer');
    else data.display_order = n;
  }
  if (body.active !== undefined) {
    data.active = (body.active === true || body.active === 'true' || body.active === 1 || body.active === '1') ? 1 : 0;
  }
  return { errors, data };
};

const dashboardSectionItemSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  const validItemTypes = ['offer', 'category', 'product', 'combo'];
  if (!body.item_type || typeof body.item_type !== 'string' || !validItemTypes.includes(body.item_type)) {
    errors.push('item_type is required and must be one of: offer, category, product, combo');
  } else {
    data.item_type = body.item_type;
  }
  if (body.item_id === undefined || body.item_id === null || !Number.isInteger(Number(body.item_id)) || Number(body.item_id) < 1) {
    errors.push('item_id is required and must be a positive integer');
  } else {
    data.item_id = Number(body.item_id);
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) errors.push('display_order must be a non-negative integer');
    else data.display_order = n;
  }
  return { errors, data };
};

const dashboardSectionItemReorderSchema = (req) => {
  const errors = [];
  const data = {};
  const ids = req.body?.itemIds;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(Number(id)) || Number(id) < 0)) {
    errors.push('itemIds must be an array of non-negative integers');
  } else {
    data.itemIds = ids.map(Number);
  }
  return { errors, data };
};

const dashboardSectionItemUpdateSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  const validItemTypes = ['offer', 'category', 'product', 'combo'];
  if (body.item_type !== undefined) {
    if (typeof body.item_type !== 'string' || !validItemTypes.includes(body.item_type)) {
      errors.push('item_type must be one of: offer, category, product, combo');
    } else {
      data.item_type = body.item_type;
    }
  }
  if (body.item_id !== undefined) {
    if (!Number.isInteger(Number(body.item_id)) || Number(body.item_id) < 1) errors.push('item_id must be a positive integer');
    else data.item_id = Number(body.item_id);
  }
  if (body.display_order !== undefined) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0) errors.push('display_order must be a non-negative integer');
    else data.display_order = n;
  }
  return { errors, data };
};

const offerSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  if (req.method === 'POST' && (!body.title || typeof body.title !== 'string' || body.title.trim() === '')) {
    errors.push('title is required');
  } else if (body.title !== undefined) {
    data.title = body.title.trim();
  }
  if (body.description !== undefined) data.description = body.description;
  if (body.active !== undefined) {
    data.active = (body.active === true || body.active === 'true' || body.active === 1 || body.active === '1') ? 1 : 0;
  }
  if (body.image_id !== undefined) data.image_id = body.image_id;
  if (body.imageId !== undefined) data.imageId = body.imageId;
  if (body.store_type !== undefined) data.store_type = body.store_type;
  if (body.storeType !== undefined) data.storeType = body.storeType;
  if (body.is_clickable !== undefined) {
    data.is_clickable = (body.is_clickable === true || body.is_clickable === 'true' || body.is_clickable === 1 || body.is_clickable === '1') ? 1 : 0;
  }
  if (body.isClickable !== undefined) {
    data.isClickable = (body.isClickable === true || body.isClickable === 'true' || body.isClickable === 1 || body.isClickable === '1') ? 1 : 0;
  }
  return { errors, data };
};

const offerProductSchema = (req) => {
  const errors = [];
  const data = {};
  const body = req.body || {};
  const productId = body.productId !== undefined ? body.productId : body.product_id;
  if (!productId || !Number.isInteger(Number(productId)) || Number(productId) < 1) {
    errors.push('productId is required');
  } else {
    data.productId = Number(productId);
    data.product_id = Number(productId);
  }
  return { errors, data };
};

const offerProductReorderSchema = (req) => {
  const errors = [];
  const data = {};
  const ids = req.body?.productIds;
  if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(Number(id)) || Number(id) < 0)) {
    errors.push('productIds must be an array of non-negative integers');
  } else {
    data.productIds = ids.map(Number);
  }
  return { errors, data };
};

// Type-gates the fields couponController actually reads from req.body.
// Business rules (code required when requires_code, percent ∈ [0,100], flat
// cap, duplicate codes) stay in the controller — this only rejects garbage
// types. Empty string / null mean "clear the field" for the nullable ones,
// matching the controller's toNullIfEmpty/toIntOrNull handling.
const couponSchema = (req) => {
  const errors = [];
  const body = req.body || {};
  const isEmptyish = (v) => v === undefined || v === null || v === '';
  const isBoolish = (v) => [true, false, 'true', 'false', 0, 1, '0', '1'].includes(v);

  if (!isEmptyish(body.code) && typeof body.code !== 'string') errors.push('code must be a string');
  if (req.method === 'POST' && (!body.title || typeof body.title !== 'string' || body.title.trim() === '')) {
    errors.push('title is required');
  } else if (body.title !== undefined && typeof body.title !== 'string') {
    errors.push('title must be a string');
  }
  if (body.discount_type !== undefined && !['flat', 'percent', 'free_delivery'].includes(body.discount_type)) {
    errors.push('discount_type must be one of: flat, percent, free_delivery');
  }
  for (const field of ['discount_value', 'min_order_amount', 'priority']) {
    if (!isEmptyish(body[field]) && !Number.isFinite(Number(body[field]))) {
      errors.push(`${field} must be a number`);
    }
  }
  for (const field of ['max_discount_amount', 'max_order_amount']) {
    if (!isEmptyish(body[field]) && !Number.isFinite(Number(body[field]))) {
      errors.push(`${field} must be a number or null`);
    }
  }
  for (const field of ['total_usage_limit', 'per_user_usage_limit', 'first_n_orders', 'min_item_count']) {
    if (!isEmptyish(body[field]) && (!Number.isInteger(Number(body[field])) || Number(body[field]) < 0)) {
      errors.push(`${field} must be a non-negative integer or null`);
    }
  }
  for (const field of ['active', 'auto_apply', 'requires_code', 'first_order_only']) {
    if (body[field] !== undefined && !isBoolish(body[field])) {
      errors.push(`${field} must be a boolean`);
    }
  }
  if (body.target_audience !== undefined && !['all', 'selected'].includes(body.target_audience)) {
    errors.push('target_audience must be all or selected');
  }
  if (body.targeted_user_ids !== undefined && !Array.isArray(body.targeted_user_ids)) {
    errors.push('targeted_user_ids must be an array');
  }
  // Controller reads req.body directly — pass it through untouched so the
  // camelCase/snake_case duplicates and nullable clears survive.
  return { errors, data: body };
};

const couponDuplicateSchema = () => ({ errors: [], data: {} });

// Routes
router.post('/login', loginLimiter, validate(loginSchema), asyncHandler(login));
router.get('/me', requireAdmin, me);
router.post('/revoke-sessions', requireAdmin, asyncHandler(revokeSessions));

// Customers
router.get('/customers', requireAdmin, validate(paginationSchema), asyncHandler(getAdminCustomers));
router.get('/customers/:id', requireAdmin, asyncHandler(getAdminCustomerById));
router.put('/customers/:id/block', requireAdmin, validate(blockSchema), asyncHandler(setBlockStatus));
router.patch('/customers/:id/block', requireAdmin, validate(blockSchema), asyncHandler(setBlockStatus));
router.put('/customers/:id/trust', requireAdmin, validate(trustSchema), asyncHandler(setTrustStatus));
router.patch('/customers/:id/trust', requireAdmin, validate(trustSchema), asyncHandler(setTrustStatus));

router.get('/categories', requireAdmin, asyncHandler(getAdminCategories));
router.post('/categories', requireAdmin, validate(categorySchema), asyncHandler(createCategory));
router.put('/categories/:id', requireAdmin, validate(categorySchema), asyncHandler(updateCategory));
router.delete('/categories/:id', requireAdmin, asyncHandler(deleteCategory));

// Store Modes — admin-configurable list replacing the hardcoded packed/fast_food pair.
router.get('/store-modes', requireAdmin, asyncHandler(getAdminStoreModes));
router.post('/store-modes', requireAdmin, asyncHandler(createStoreMode));
router.patch('/store-modes/:id', requireAdmin, asyncHandler(updateStoreMode));

// Shops — admin shop CRUD (multi-shop / shop-owner feature).
router.get('/shops', requireAdmin, asyncHandler(listShops));
router.post('/shops', requireAdmin, asyncHandler(createShop));
router.patch('/shops/:id', requireAdmin, asyncHandler(updateShop));
router.patch('/shops/:id/schedule', requireAdmin, asyncHandler(updateShopSchedule));
router.delete('/shops/:id', requireAdmin, asyncHandler(deleteShop));
// Per-shop order actions (same lifecycle as shop-owner Confirm / Ready / Cancel).
router.get('/shops/:id/orders', requireAdmin, asyncHandler(listShopOrders));
router.patch('/shops/:id/orders/:orderId/confirm', requireAdmin, asyncHandler(adminConfirmShopOrder));
router.patch('/shops/:id/orders/:orderId/reject', requireAdmin, asyncHandler(adminRejectShopOrder));
router.patch('/shops/:id/orders/:orderId/ready', requireAdmin, asyncHandler(adminReadyShopOrder));
// Per-shop product groups (same as shop-owner's own group management).
router.get('/shops/:id/groups', requireAdmin, asyncHandler(listShopGroups));
router.post('/shops/:id/groups', requireAdmin, asyncHandler(createShopGroup));
router.patch('/shops/:id/groups/:groupId', requireAdmin, asyncHandler(updateShopGroup));
router.delete('/shops/:id/groups/:groupId', requireAdmin, asyncHandler(deleteShopGroup));
router.patch('/shops/:id/products/:productId/group', requireAdmin, asyncHandler(assignShopProductGroup));

router.get('/riders', requireAdmin, asyncHandler(listRiders));
router.post('/riders', requireAdmin, asyncHandler(createRider));
router.patch('/riders/:id', requireAdmin, asyncHandler(updateRider));
router.delete('/riders/:id', requireAdmin, asyncHandler(deleteRider));
// Admin dispatch — same lifecycle as rider app (online, offer accept/reject, delivery).
router.get('/riders/:id/dispatch', requireAdmin, asyncHandler(getRiderDispatch));
router.patch('/riders/:id/online', requireAdmin, asyncHandler(adminSetRiderOnline));
router.post('/riders/:id/offers/:offerId/accept', requireAdmin, asyncHandler(adminAcceptOffer));
router.post('/riders/:id/offers/:offerId/reject', requireAdmin, asyncHandler(adminRejectOffer));
router.post('/riders/:id/assignments/:orderId/picked-up', requireAdmin, asyncHandler(adminMarkPickedUp));
router.patch('/riders/:id/assignments/:orderId/status', requireAdmin, asyncHandler(adminUpdateAssignmentStatus));

// Mobile Admins — phones granted Admin Mode in the phone app (ADMIN TASK 2).
router.get('/mobile-admins', requireAdmin, asyncHandler(listMobileAdmins));
router.post('/mobile-admins', requireAdmin, asyncHandler(createMobileAdmin));
router.patch('/mobile-admins/:id', requireAdmin, asyncHandler(updateMobileAdmin));

// Mints an admin JWT for an OTP-logged-in phone that is an active mobile
// admin (ADMIN TASK 3). Bearer = customer JWT, not admin JWT.
router.post('/mobile-session', mobileSessionLimiter, requireCustomer, asyncHandler(mintMobileSession));

router.get('/products', requireAdmin, asyncHandler(getAdminProducts));
router.post('/products', requireAdmin, validate(productSchema), asyncHandler(createProduct));

// Bulk action routes — MUST be registered before /:id routes to prevent Express
// matching the literal string "bulk" as a product ID parameter.
router.patch('/products/bulk', requireAdmin, asyncHandler(bulkUpdateProducts));
router.delete('/products/bulk', requireAdmin, asyncHandler(bulkDeleteProducts));
// Grid-style price editing (App ₹ / Shop ₹ columns), one row per product OR
// variant. Must be registered before '/products/:id' so 'pricing' isn't
// swallowed as an :id param.
router.patch('/products/pricing', requireAdmin, asyncHandler(updateProductPricing));

router.get('/products/:id', requireAdmin, asyncHandler(getAdminProductById));
router.put('/products/:id', requireAdmin, validate(productSchema), asyncHandler(updateProduct));
router.delete('/products/:id', requireAdmin, asyncHandler(deleteProduct));
router.patch('/products/:id/availability', requireAdmin, validate(productAvailabilitySchema), asyncHandler(updateProductAvailability));
router.patch('/products/:id/variants/:variantId/availability', requireAdmin, validate(variantAvailabilitySchema), asyncHandler(updateVariantAvailability));
router.patch('/products/:id/image', requireAdmin, validate(productImageSchema), asyncHandler(updateProductImage));
// requireSuperAdmin: creating a library item (whether via POST /library or
// by lifting an existing product into one) is a global-authorship action.
router.post('/products/:id/promote-to-library', requireAdmin, requireSuperAdmin, asyncHandler(promoteProductToLibrary));

// Product library (TASK 19, §4.5) — identity is global, commerce is per-area.
// GET is any admin (browse-only); writes to the library itself are
// requireSuperAdmin; add-to-area is any admin for their OWN area only.
router.get('/library', requireAdmin, asyncHandler(getLibrary));
router.post('/library', requireAdmin, requireSuperAdmin, asyncHandler(createLibraryProduct));
router.patch('/library/:id', requireAdmin, requireSuperAdmin, asyncHandler(updateLibraryProduct));
router.post('/library/:id/archive', requireAdmin, requireSuperAdmin, asyncHandler(archiveLibraryProduct));
router.post('/library/:id/add-to-area', requireAdmin, asyncHandler(addLibraryProductToArea));
router.post('/library/:id/add-to-areas', requireAdmin, requireSuperAdmin, asyncHandler(addLibraryProductToAreas));

// Super-admin only (TASK 24, §2.9/§2.12): area + admin-account management,
// and clone-area. requireSuperAdmin everywhere here — an area_admin has no
// reason to create areas, other admins, or clone a catalog.
router.get('/areas', requireAdmin, requireSuperAdmin, asyncHandler(getAdminAreas));
router.post('/areas', requireAdmin, requireSuperAdmin, asyncHandler(createArea));
router.patch('/areas/:id', requireAdmin, requireSuperAdmin, asyncHandler(updateArea));
router.delete('/areas/:id', requireAdmin, requireSuperAdmin, asyncHandler(deleteArea));
router.post('/areas/:id/clone-from/:sourceId', requireAdmin, requireSuperAdmin, asyncHandler(cloneArea));

router.get('/admins', requireAdmin, requireSuperAdmin, asyncHandler(getAdminAdmins));
router.post('/admins', requireAdmin, requireSuperAdmin, asyncHandler(createAdmin));
router.patch('/admins/:id', requireAdmin, requireSuperAdmin, asyncHandler(updateAdmin));
// Bulk import: ?preview=true for dry-run, no query param for commit
router.post('/products/bulk-import', requireAdmin, bulkUpload, asyncHandler(async (req, res) => {
  if (req.query.preview === 'true') {
    return previewBulkImport(req, res);
  }
  return commitBulkImport(req, res);
}));

router.get('/combos', requireAdmin, asyncHandler(getAdminCombos));
router.get('/combos/:id', requireAdmin, asyncHandler(getAdminComboById));
router.post('/combos', requireAdmin, validate(comboSchema), asyncHandler(createCombo));
router.put('/combos/:id', requireAdmin, validate(comboSchema), asyncHandler(updateCombo));
router.delete('/combos/:id', requireAdmin, asyncHandler(deleteCombo));
router.patch('/combos/:id/availability', requireAdmin, validate(comboAvailabilitySchema), asyncHandler(updateComboAvailability));

router.get('/dashboard', requireAdmin, asyncHandler(getDashboard));

// Admin Dashboard Sections CRUD
router.get('/dashboard-sections', requireAdmin, asyncHandler(getAdminSections));
router.post('/dashboard-sections', requireAdmin, validate(dashboardSectionSchema), asyncHandler(createAdminSection));
router.patch('/dashboard-sections/reorder', requireAdmin, validate(dashboardSectionReorderSchema), asyncHandler(reorderAdminSections));
router.get('/dashboard-sections/:id', requireAdmin, asyncHandler(getAdminSectionById));
router.patch('/dashboard-sections/:id', requireAdmin, validate(dashboardSectionUpdateSchema), asyncHandler(updateAdminSection));
router.delete('/dashboard-sections/:id', requireAdmin, asyncHandler(deleteAdminSection));

// Section Items
router.post('/dashboard-sections/:id/items', requireAdmin, validate(dashboardSectionItemSchema), asyncHandler(addAdminSectionItem));
router.patch('/dashboard-sections/:id/items/reorder', requireAdmin, validate(dashboardSectionItemReorderSchema), asyncHandler(reorderAdminSectionItems));
router.patch('/dashboard-sections/:id/items/:itemId', requireAdmin, validate(dashboardSectionItemUpdateSchema), asyncHandler(updateAdminSectionItem));
router.delete('/dashboard-sections/:id/items/:itemId', requireAdmin, asyncHandler(deleteAdminSectionItem));

router.get('/reports/sales', requireAdmin, asyncHandler(getSalesReport));
router.get('/reports/customers', requireAdmin, asyncHandler(getCustomersReport));
router.get('/reports/shops', requireAdmin, asyncHandler(getShopsReport));
router.get('/reports/top-products', requireAdmin, asyncHandler(getTopProductsReport));
router.get('/reports/profit/summary', requireAdmin, asyncHandler(getProfitSummary));
router.get('/reports/profit/orders', requireAdmin, asyncHandler(getProfitOrders));

router.get('/orders', requireAdmin, asyncHandler(getAdminOrders));
router.get('/orders/:id', requireAdmin, asyncHandler(getAdminOrderById));
router.patch('/orders/:id/status', requireAdmin, asyncHandler(updateOrderStatus));
router.patch('/orders/:id/payment', requireAdmin, asyncHandler(updateOrderPayment));
router.patch('/orders/:id/remark', requireAdmin, asyncHandler(updateOrderRemark));
router.post('/orders/:id/extend-auto-accept', requireAdmin, asyncHandler(extendAutoAccept));

// Admin places an order on behalf of an existing customer (e.g. phone order)
// — reuses the exact customer-facing validation + money-calculation code
// (see adminCalculateOrder/adminCreateOrder), just targeting customer_id.
router.post('/orders/calculate', requireAdmin, asyncHandler(adminCalculateOrder));
router.post('/orders', requireAdmin, ...orderExpressValidatorChecks, validateOrderExpress, validate(createOrderSchema), asyncHandler(adminCreateOrder));

// Settings
router.get('/settings', requireAdmin, asyncHandler(getSettings));
router.patch('/settings', requireAdmin, asyncHandler(updateSettings));

// Delivery zones — radius-pricing bands around the settings shop pin.
router.get('/delivery-zones', requireAdmin, asyncHandler(listZones));
router.post('/delivery-zones', requireAdmin, asyncHandler(createZone));
router.patch('/delivery-zones/:id', requireAdmin, asyncHandler(updateZone));
router.delete('/delivery-zones/:id', requireAdmin, asyncHandler(deleteZone));
router.get('/offers/active', requireAdmin, asyncHandler(getActiveOffer));
router.get('/offers', requireAdmin, asyncHandler(getAdminOffers));
router.post('/offers', requireAdmin, validate(offerSchema), asyncHandler(createOffer));
router.patch('/offers/:id', requireAdmin, validate(offerSchema), asyncHandler(updateOffer));
router.delete('/offers/:id', requireAdmin, asyncHandler(deleteOffer));
router.get('/offers/:id/products', requireAdmin, asyncHandler(getOfferProducts));
router.post('/offers/:id/products', requireAdmin, validate(offerProductSchema), asyncHandler(addOfferProduct));
router.delete('/offers/:id/products/:productId', requireAdmin, asyncHandler(removeOfferProduct));
router.patch('/offers/:id/products/reorder', requireAdmin, validate(offerProductReorderSchema), asyncHandler(reorderOfferProducts));

// Coupons — admin-managed discount codes & auto-apply offers.
router.get('/coupons', requireAdmin, asyncHandler(getAdminCoupons));
router.get('/coupons/:id', requireAdmin, asyncHandler(getAdminCouponById));
router.post('/coupons', requireAdmin, validate(couponSchema), asyncHandler(createCoupon));
router.put('/coupons/:id', requireAdmin, validate(couponSchema), asyncHandler(updateCoupon));
router.patch('/coupons/:id', requireAdmin, validate(couponSchema), asyncHandler(updateCoupon));
router.delete('/coupons/:id', requireAdmin, asyncHandler(deleteCoupon));
router.post('/coupons/:id/duplicate', requireAdmin, validate(couponDuplicateSchema), asyncHandler(duplicateCoupon));
router.get('/coupons/:id/redemptions', requireAdmin, asyncHandler(getCouponRedemptions));

// Notifications
router.get('/notifications', requireAdmin, asyncHandler(getAdminNotifications));
router.post('/notifications', requireAdmin, asyncHandler(createAdminNotification));
  router.get('/notifications/:id', requireAdmin, asyncHandler(getAdminNotificationById));
  router.delete('/notifications/:id', requireAdmin, asyncHandler(deleteAdminNotification));

  // Admin inbox (bell icon). Distinct from the broadcast composer above.
  router.get('/inbox', requireAdmin, asyncHandler(getInbox));
  router.get('/inbox/unread-count', requireAdmin, asyncHandler(getInboxUnreadCount));
  router.patch('/inbox/:id/read', requireAdmin, asyncHandler(markInboxRead));
  router.post('/inbox/read-all', requireAdmin, asyncHandler(markAllInboxRead));
  router.delete('/inbox/:id', requireAdmin, asyncHandler(dismissInbox));

// Notification Templates
router.get('/notification-templates', requireAdmin, asyncHandler(getNotificationTemplates));
router.patch('/notification-templates/:id', requireAdmin, asyncHandler(updateNotificationTemplate));
router.post('/notification-templates/:id/reset', requireAdmin, asyncHandler(resetNotificationTemplate));

// Analytics (admin) — sub-router from analyticsRoutes; already wraps requireAdmin.
const { adminRouter: analyticsAdminRouter } = require('./analyticsRoutes');
router.use('/analytics', analyticsAdminRouter);

module.exports = router;
