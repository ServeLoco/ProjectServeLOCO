import { apiClient } from './httpClient';

// Thin client over the shop-owner API (TASK 7). Uses the same apiClient +
// `auth: 'customer'` pattern as authApi.js — the JWT stays role: 'customer';
// the shop is derived server-side from the user.
const shopApi = {
  getMyShop: () => apiClient.get('/shop/me', { auth: 'customer' }),
  toggleShop: (isOpen) =>
    apiClient.patch('/shop/me/toggle', { is_open: isOpen, isOpen }, { auth: 'customer' }),
  // openTime/closeTime as 'HH:MM' strings, or both null to turn scheduling off.
  updateSchedule: (openTime, closeTime) =>
    apiClient.patch(
      '/shop/me/schedule',
      { openTime, open_time: openTime, closeTime, close_time: closeTime },
      { auth: 'customer' },
    ),
  getMyProducts: () => apiClient.get('/shop/products', { auth: 'customer' }),
  toggleProduct: (id, available) =>
    apiClient.patch(`/shop/products/${id}/toggle`, { available, isAvailable: available }, { auth: 'customer' }),
  toggleVariant: (productId, variantId, available) =>
    apiClient.patch(
      `/shop/products/${productId}/variants/${variantId}/toggle`,
      { available, isAvailable: available },
      { auth: 'customer' },
    ),
  getMyOrders: () => apiClient.get('/shop/orders', { auth: 'customer' }),
  getOrderHistory: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiClient.get(`/shop/orders/history${q ? `?${q}` : ''}`, { auth: 'customer' });
  },
  confirmOrder: (orderId) =>
    apiClient.patch(`/shop/orders/${orderId}/confirm`, {}, { auth: 'customer' }),
  rejectOrder: (orderId) =>
    apiClient.patch(`/shop/orders/${orderId}/reject`, {}, { auth: 'customer' }),
  readyOrder: (orderId) =>
    apiClient.patch(`/shop/orders/${orderId}/ready`, {}, { auth: 'customer' }),
  // Fire-and-forget proof-of-delivery: tells the server this device actually
  // displayed the new-order alarm, so the weak-network reminder sweeper can
  // ease off cadence instead of assuming the push never landed.
  ackOrderAlert: (orderId) =>
    apiClient.post(`/shop/orders/${orderId}/alert-ack`, {}, { auth: 'customer' }),
  getMyGroups: () => apiClient.get('/shop/groups', { auth: 'customer' }),
  createGroup: (name) => apiClient.post('/shop/groups', { name }, { auth: 'customer' }),
  updateGroup: (id, data) => apiClient.patch(`/shop/groups/${id}`, data, { auth: 'customer' }),
  deleteGroup: (id) => apiClient.delete(`/shop/groups/${id}`, { auth: 'customer' }),
  assignProductGroup: (productId, groupId) =>
    apiClient.patch(`/shop/products/${productId}/group`, { group_id: groupId, groupId }, { auth: 'customer' }),
};

export { shopApi };
