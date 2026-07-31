const express = require('express');
const { requireCustomer } = require('../middleware/authMiddleware');
const { requireShopOwner } = require('../middleware/shopOwnerMiddleware');
const asyncHandler = require('../utils/asyncHandler');
const {
  getMyShop,
  toggleMyShop,
  updateMyShopSchedule,
  getMyProducts,
  toggleMyProduct,
  toggleMyProductVariant,
  getMyOrders,
  getMyOrderHistory,
  confirmMyOrder,
  rejectMyOrder,
  readyMyOrder,
  getMyGroups,
  createMyGroup,
  updateMyGroup,
  deleteMyGroup,
  assignMyProductGroup,
} = require('../controllers/shopOwnerController');

const router = express.Router();

// Every shop-owner route requires a valid customer JWT (role: 'customer') AND
// that the user owns an active shop. The shop is derived from the JWT — a
// client can never pass a shopId.
router.use(requireCustomer);
router.use(asyncHandler(requireShopOwner));

router.get('/me', asyncHandler(getMyShop));
router.patch('/me/toggle', asyncHandler(toggleMyShop));
router.patch('/me/schedule', asyncHandler(updateMyShopSchedule));
router.get('/products', asyncHandler(getMyProducts));
router.patch('/products/:id/toggle', asyncHandler(toggleMyProduct));
router.patch('/products/:id/variants/:variantId/toggle', asyncHandler(toggleMyProductVariant));
router.patch('/products/:id/group', asyncHandler(assignMyProductGroup));
router.get('/orders', asyncHandler(getMyOrders));
router.get('/orders/history', asyncHandler(getMyOrderHistory));
router.patch('/orders/:orderId/confirm', asyncHandler(confirmMyOrder));
router.patch('/orders/:orderId/reject', asyncHandler(rejectMyOrder));
router.patch('/orders/:orderId/ready', asyncHandler(readyMyOrder));
router.get('/groups', asyncHandler(getMyGroups));
router.post('/groups', asyncHandler(createMyGroup));
router.patch('/groups/:id', asyncHandler(updateMyGroup));
router.delete('/groups/:id', asyncHandler(deleteMyGroup));

module.exports = router;
