import { apiClient } from './client';
export {
  connectAdminRealtime,
  disconnectAdminRealtime,
  getRealtimeConnectionState,
  subscribeAdminOrderEvents,
  subscribeRealtime,
  subscribeRealtimeLifecycle,
} from './realtimeClient';

const withQuery = (path, params = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      qs.set(key, value);
    }
  });
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
};

export const AuthApi = {
  login: (credentials) => apiClient('/admin/login', { method: 'POST', body: credentials }),
  me: () => apiClient('/admin/me', { method: 'GET' }),
};

export const DashboardApi = {
  getMetrics: () => apiClient('/admin/dashboard', { method: 'GET' }),
};

export const OrdersApi = {
  list: (params) => apiClient(withQuery('/admin/orders', params), { method: 'GET' }),
  get: (id) => apiClient(`/admin/orders/${id}`, { method: 'GET' }),
  updateStatus: (id, status, cancel_reason) => apiClient(`/admin/orders/${id}/status`, {
    method: 'PATCH',
    body: cancel_reason ? { status, cancel_reason } : { status },
  }),
  updatePayment: (id, paymentStatus) => apiClient(
    `/admin/orders/${id}/payment`,
    { method: 'PATCH', body: { paymentStatus, payment_status: paymentStatus } }
  ),
  updateRemark: (id, remark) => apiClient(`/admin/orders/${id}/remark`, {
    method: 'PATCH',
    body: { remark, admin_remark: remark },
  }),
  extendAutoAccept: (id) => apiClient(`/admin/orders/${id}/extend-auto-accept`, { method: 'POST' }),
  calculateForCustomer: (data) => apiClient('/admin/orders/calculate', { method: 'POST', body: data }),
  createForCustomer: (data) => apiClient('/admin/orders', { method: 'POST', body: data }),
};

export const ProductsApi = {
  list: (params) => apiClient(withQuery('/admin/products', params), { method: 'GET' }),
  create: (data) => apiClient('/admin/products', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/products/${id}`, { method: 'PUT', body: data }),
  delete: (id) => apiClient(`/admin/products/${id}`, { method: 'DELETE' }),
  updateAvailability: (id, available) => apiClient(
    `/admin/products/${id}/availability`,
    { method: 'PATCH', body: { available, isAvailable: available } }
  ),
  updateVariantAvailability: (id, variantId, available) => apiClient(
    `/admin/products/${id}/variants/${variantId}/availability`,
    { method: 'PATCH', body: { available, isAvailable: available } }
  ),
  attachImage: (id, imageId) => apiClient(
    `/admin/products/${id}/image`,
    { method: 'PATCH', body: { imageId, image_id: imageId } }
  ),
  bulkPreview: (formData) => apiClient('/admin/products/bulk-import?preview=true', { method: 'POST', body: formData }),
  bulkImport: (formData) => apiClient('/admin/products/bulk-import', { method: 'POST', body: formData }),
  bulkUpdate: (ids, updates) => apiClient('/admin/products/bulk', { method: 'PATCH', body: { ids, updates } }),
  bulkDelete: (ids) => apiClient('/admin/products/bulk', { method: 'DELETE', body: { ids } }),
  // Grid price editing — App ₹ / Shop ₹ columns, one row per product OR variant.
  updatePricing: (rows) => apiClient('/admin/products/pricing', { method: 'PATCH', body: { rows } }),
};

export const CombosApi = {
  list: (params) => apiClient(withQuery('/admin/combos', params), { method: 'GET' }),
  create: (data) => apiClient('/admin/combos', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/combos/${id}`, { method: 'PUT', body: data }),
  delete: (id) => apiClient(`/admin/combos/${id}`, { method: 'DELETE' }),
  updateAvailability: (id, available) => apiClient(
    `/admin/combos/${id}/availability`,
    { method: 'PATCH', body: { available, isAvailable: available } }
  ),
};

export const CategoriesApi = {
  list: (params) => apiClient(withQuery('/admin/categories', params), { method: 'GET' }),
  create: (data) => apiClient('/admin/categories', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/categories/${id}`, { method: 'PUT', body: data }),
  delete: (id) => apiClient(`/admin/categories/${id}`, { method: 'DELETE' }),
};

export const StoreModesApi = {
  list: () => apiClient('/admin/store-modes', { method: 'GET' }),
  create: (data) => apiClient('/admin/store-modes', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/store-modes/${id}`, { method: 'PATCH', body: data }),
};

export const ShopsApi = {
  list: () => apiClient('/admin/shops', { method: 'GET' }),
  create: (data) => apiClient('/admin/shops', { method: 'POST', body: data }),
  // Backend route is PATCH, not PUT (unlike CategoriesApi.update) — the
  // shops endpoint only updates fields present in the payload.
  update: (id, data) => apiClient(`/admin/shops/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => apiClient(`/admin/shops/${id}`, { method: 'DELETE' }),
  // Per-shop order lifecycle (mirrors shop-owner Confirm / Ready / Cancel).
  listOrders: (id) => apiClient(`/admin/shops/${id}/orders`, { method: 'GET' }),
  confirmOrder: (shopId, orderId) => apiClient(
    `/admin/shops/${shopId}/orders/${orderId}/confirm`,
    { method: 'PATCH' }
  ),
  rejectOrder: (shopId, orderId) => apiClient(
    `/admin/shops/${shopId}/orders/${orderId}/reject`,
    { method: 'PATCH' }
  ),
  readyOrder: (shopId, orderId) => apiClient(
    `/admin/shops/${shopId}/orders/${orderId}/ready`,
    { method: 'PATCH' }
  ),
  // Auto open/close schedule — mirrors shop-owner's own PATCH /shop/me/schedule.
  updateSchedule: (id, openTime, closeTime) => apiClient(`/admin/shops/${id}/schedule`, {
    method: 'PATCH',
    body: { openTime, open_time: openTime, closeTime, close_time: closeTime },
  }),
  // Product groups — mirrors shop-owner's own GET/POST/PATCH/DELETE /shop/groups.
  listGroups: (id) => apiClient(`/admin/shops/${id}/groups`, { method: 'GET' }),
  createGroup: (id, name) => apiClient(`/admin/shops/${id}/groups`, { method: 'POST', body: { name } }),
  updateGroup: (id, groupId, data) => apiClient(
    `/admin/shops/${id}/groups/${groupId}`,
    { method: 'PATCH', body: data }
  ),
  deleteGroup: (id, groupId) => apiClient(`/admin/shops/${id}/groups/${groupId}`, { method: 'DELETE' }),
  assignProductGroup: (id, productId, groupId) => apiClient(
    `/admin/shops/${id}/products/${productId}/group`,
    { method: 'PATCH', body: { group_id: groupId, groupId } }
  ),
};

export const RidersApi = {
  list: () => apiClient('/admin/riders', { method: 'GET' }),
  create: (data) => apiClient('/admin/riders', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/riders/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => apiClient(`/admin/riders/${id}`, { method: 'DELETE' }),
  // Per-rider dispatch (mirrors rider app: online, accept/reject, pickup, OFD, delivered).
  getDispatch: (id) => apiClient(`/admin/riders/${id}/dispatch`, { method: 'GET' }),
  setOnline: (id, isOnline) => apiClient(`/admin/riders/${id}/online`, {
    method: 'PATCH',
    body: { isOnline, is_online: isOnline },
  }),
  acceptOffer: (riderId, offerId) => apiClient(
    `/admin/riders/${riderId}/offers/${offerId}/accept`,
    { method: 'POST' }
  ),
  rejectOffer: (riderId, offerId) => apiClient(
    `/admin/riders/${riderId}/offers/${offerId}/reject`,
    { method: 'POST' }
  ),
  markPickedUp: (riderId, orderId) => apiClient(
    `/admin/riders/${riderId}/assignments/${orderId}/picked-up`,
    { method: 'POST' }
  ),
  updateAssignmentStatus: (riderId, orderId, status) => apiClient(
    `/admin/riders/${riderId}/assignments/${orderId}/status`,
    { method: 'PATCH', body: { status } }
  ),
};

export const MobileAdminsApi = {
  list: () => apiClient('/admin/mobile-admins', { method: 'GET' }),
  create: (data) => apiClient('/admin/mobile-admins', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/mobile-admins/${id}`, { method: 'PATCH', body: data }),
};

export const OffersApi = {
  list: (params) => apiClient(withQuery('/admin/offers', params), { method: 'GET' }),
  create: (data) => apiClient('/admin/offers', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/offers/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => apiClient(`/admin/offers/${id}`, { method: 'DELETE' }),
  listProducts: (id) => apiClient(`/admin/offers/${id}/products`, { method: 'GET' }),
  addProduct: (id, productId) => apiClient(`/admin/offers/${id}/products`, { method: 'POST', body: { productId } }),
  removeProduct: (id, productId) => apiClient(`/admin/offers/${id}/products/${productId}`, { method: 'DELETE' }),
  reorderProducts: (id, productIds) => apiClient(`/admin/offers/${id}/products/reorder`, { method: 'PATCH', body: { productIds } }),
};

export const CustomersApi = {
  list: (params) => apiClient(withQuery('/admin/customers', params), { method: 'GET' }),
  get: (id) => apiClient(`/admin/customers/${id}`, { method: 'GET' }),
  updateBlock: (id, blocked) => apiClient(`/admin/customers/${id}/block`, { method: 'PATCH', body: { blocked } }),
  updateTrust: (id, trusted) => apiClient(`/admin/customers/${id}/trust`, { method: 'PATCH', body: { trusted } }),
};

export const SettingsApi = {
  get: () => apiClient('/admin/settings', { method: 'GET' }),
  update: (data) => apiClient('/admin/settings', { method: 'PATCH', body: data }),
};

export const DeliveryZonesApi = {
  list: () => apiClient('/admin/delivery-zones', { method: 'GET' }),
  create: (data) => apiClient('/admin/delivery-zones', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/delivery-zones/${id}`, { method: 'PATCH', body: data }),
  remove: (id) => apiClient(`/admin/delivery-zones/${id}`, { method: 'DELETE' }),
};

export const ImagesApi = {
  list: () => apiClient('/admin/images', { method: 'GET' }),
  upload: (formData) => apiClient('/admin/images', { method: 'POST', body: formData }),
  delete: (id) => apiClient(`/admin/images/${id}`, { method: 'DELETE' }),
};

export const ReportsApi = {
  getSales: (params) => apiClient(withQuery('/admin/reports/sales', params), { method: 'GET' }),
  getCustomers: (params) => apiClient(withQuery('/admin/reports/customers', params), { method: 'GET' }),
  getTopProducts: (params) => apiClient(withQuery('/admin/reports/top-products', params), { method: 'GET' }),
  getShops: (params) => apiClient(withQuery('/admin/reports/shops', params), { method: 'GET' }),
  getProfitSummary: (params) => apiClient(withQuery('/admin/reports/profit/summary', params), { method: 'GET' }),
  getProfitOrders: (params) => apiClient(withQuery('/admin/reports/profit/orders', params), { method: 'GET' }),
};

export const HealthApi = {
  check: () => apiClient('/health', { method: 'GET', root: true }),
};

export const MobileDashboardApi = {
  listSections: (params) => apiClient(withQuery('/admin/dashboard-sections', params), { method: 'GET' }),
  createSection: (data) => apiClient('/admin/dashboard-sections', { method: 'POST', body: data }),
  reorderSections: (sectionIds, params) => apiClient(withQuery('/admin/dashboard-sections/reorder', params), { method: 'PATCH', body: { sectionIds } }),
  getSection: (id) => apiClient(`/admin/dashboard-sections/${id}`, { method: 'GET' }),
  updateSection: (id, data) => apiClient(`/admin/dashboard-sections/${id}`, { method: 'PATCH', body: data }),
  deleteSection: (id) => apiClient(`/admin/dashboard-sections/${id}`, { method: 'DELETE' }),
  addSectionItem: (id, item) => apiClient(`/admin/dashboard-sections/${id}/items`, { method: 'POST', body: item }),
  reorderSectionItems: (id, itemIds) => apiClient(`/admin/dashboard-sections/${id}/items/reorder`, { method: 'PATCH', body: { itemIds } }),
  updateSectionItem: (id, itemId, data) => apiClient(`/admin/dashboard-sections/${id}/items/${itemId}`, { method: 'PATCH', body: data }),
  deleteSectionItem: (id, itemId) => apiClient(`/admin/dashboard-sections/${id}/items/${itemId}`, { method: 'DELETE' }),
};

export const NotificationsApi = {
  list: (params) => apiClient(withQuery('/admin/notifications', params), { method: 'GET' }),
  get: (id) => apiClient(`/admin/notifications/${id}`, { method: 'GET' }),
  create: (data) => apiClient('/admin/notifications', { method: 'POST', body: data }),
  delete: (id) => apiClient(`/admin/notifications/${id}`, { method: 'DELETE' }),
};

export const AdminInboxApi = {
  list: (params = {}) => apiClient(withQuery('/admin/inbox', params), { method: 'GET' }),
  unreadCount: () => apiClient('/admin/inbox/unread-count', { method: 'GET' }),
  markRead: (id) => apiClient(`/admin/inbox/${id}/read`, { method: 'PATCH' }),
  markAllRead: () => apiClient('/admin/inbox/read-all', { method: 'POST' }),
  dismiss: (id) => apiClient(`/admin/inbox/${id}`, { method: 'DELETE' }),
};

export const NotificationTemplatesApi = {
  list: () => apiClient('/admin/notification-templates', { method: 'GET' }),
  update: (id, data) => apiClient(`/admin/notification-templates/${id}`, { method: 'PATCH', body: data }),
  reset: (id) => apiClient(`/admin/notification-templates/${id}/reset`, { method: 'POST' }),
};

export const CouponsApi = {
  list: (params) => apiClient(withQuery('/admin/coupons', params), { method: 'GET' }),
  get: (id) => apiClient(`/admin/coupons/${id}`, { method: 'GET' }),
  create: (data) => apiClient('/admin/coupons', { method: 'POST', body: data }),
  update: (id, data) => apiClient(`/admin/coupons/${id}`, { method: 'PATCH', body: data }),
  delete: (id) => apiClient(`/admin/coupons/${id}`, { method: 'DELETE' }),
  duplicate: (id) => apiClient(`/admin/coupons/${id}/duplicate`, { method: 'POST' }),
  redemptions: (id, params) => apiClient(withQuery(`/admin/coupons/${id}/redemptions`, params), { method: 'GET' }),
};

export const AnalyticsApi = {
  summary: (days) => apiClient(withQuery('/admin/analytics/summary', { days }), { method: 'GET' }),
  products: (days) => apiClient(withQuery('/admin/analytics/products', { days }), { method: 'GET' }),
  windowShoppers: (days) => apiClient(withQuery('/admin/analytics/window-shoppers', { days }), { method: 'GET' }),
  user: (id, days) => apiClient(withQuery(`/admin/analytics/user/${id}`, { days }), { method: 'GET' }),
  hourly: (days) => apiClient(withQuery('/admin/analytics/hourly', { days }), { method: 'GET' }),
  activeUsers: (minutes, search) => apiClient(withQuery('/admin/analytics/active-users', { minutes, search }), { method: 'GET' }),
};
