import { io } from 'socket.io-client';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getRealtimeBaseUrl } from './realtimeConfig';
import { invalidate } from '../utils/apiCache';

const ORDER_EVENTS = [
  'order.created',
  'order.cancelled',
  'order.status.updated',
  'order.payment.updated',
  'order.updated',
  'shop.order.assigned',
  'shop.order.cancelled',
  // Admin (or another device) confirmed / ready / rejected — shop dashboard refetches.
  'shop.order.updated',
  'shop.order.rider_assigned',
  'shop.order.rider_failed',
];

const RIDER_LOCATION_EVENTS = ['rider.location.updated'];

// Rider dispatch: offers, assignment steps, admin online toggle.
const RIDER_DISPATCH_EVENTS = [
  'rider.offer.created',
  'rider.offer.expired',
  'rider.offer.revoked',
  'rider.assignment.updated',
  'rider.status.updated',
];

const NOTIFICATION_EVENTS = [
  'notification.created',
  'notification.unread_count.updated',
];

const SHOP_EVENTS = [
  'shop.status.updated',
  'settings.shop_open.updated',
];

// Shop/admin toggles product available (OOS) — customers drop cart lines + UI.
const PRODUCT_AVAILABILITY_EVENTS = [
  'product.availability.updated',
];

// Admin deleted/deactivated shop or rider → phone becomes customer mode.
const AUTH_ROLE_EVENTS = [
  'auth.role.updated',
];

// Admin created/edited/deleted a delivery zone (boundary or pricing) —
// anyone mid-checkout should reprice against the new zone data immediately,
// not wait for their next pin move.
const DELIVERY_ZONE_EVENTS = [
  'delivery_zones.updated',
];

const LIFECYCLE_EVENTS = [
  'connected',
  'reconnected',
  'disconnected',
  'foreground',
];

let socket = null;
let activeToken = null;
let hasConnected = false;

const listeners = new Map();

function debugLog(...args) {
  if (__DEV__) {
    console.log('[realtime]', ...args);
  }
}

function getSet(eventName) {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set());
  }
  return listeners.get(eventName);
}

function emitLocal(eventName, payload) {
  const eventListeners = listeners.get(eventName);
  if (!eventListeners) return;

  eventListeners.forEach(handler => {
    try {
      handler(payload);
    } catch (error) {
      if (__DEV__) {
        console.warn('[realtime] listener failed', eventName, error);
      }
    }
  });
}

function subscribeRealtime(eventName, handler) {
  if (!eventName || typeof handler !== 'function') {
    return () => {};
  }

  const eventListeners = getSet(eventName);
  eventListeners.add(handler);

  return () => {
    eventListeners.delete(handler);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };
}

function subscribeOrderEvents(handler) {
  const unsubscribers = ORDER_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeRiderLocation(handler) {
  const unsubscribers = RIDER_LOCATION_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeNotificationEvents(handler) {
  const unsubscribers = NOTIFICATION_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeShopEvents(handler) {
  const unsubscribers = SHOP_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeProductAvailabilityEvents(handler) {
  const unsubscribers = PRODUCT_AVAILABILITY_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeAuthRoleEvents(handler) {
  const unsubscribers = AUTH_ROLE_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeDeliveryZoneEvents(handler) {
  const unsubscribers = DELIVERY_ZONE_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

// Module-level: any shop open/close event busts product/category SWR caches
// so the next screen paint revalidates. Invalidation also defeats the TASK-16
// freshness throttle (no entry = not fresh).
SHOP_EVENTS.forEach(eventName => {
  subscribeRealtime(eventName, () => {
    invalidate('products:');
    invalidate('product:');
    invalidate('categories:');
  });
});

PRODUCT_AVAILABILITY_EVENTS.forEach(eventName => {
  subscribeRealtime(eventName, () => {
    invalidate('products:');
    invalidate('product:');
    invalidate('categories:');
    invalidate('dashboard:');
  });
});

function subscribeRealtimeLifecycle(handler) {
  const unsubscribers = LIFECYCLE_EVENTS.map(eventName =>
    subscribeRealtime(`lifecycle.${eventName}`, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function bindSocketEvents(nextSocket) {
  ORDER_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  RIDER_LOCATION_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  RIDER_DISPATCH_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  NOTIFICATION_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  SHOP_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  PRODUCT_AVAILABILITY_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  AUTH_ROLE_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  DELIVERY_ZONE_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  nextSocket.on('connect', () => {
    const lifecycleEvent = hasConnected ? 'reconnected' : 'connected';
    hasConnected = true;
    emitLocal(`lifecycle.${lifecycleEvent}`, {
      socketId: nextSocket.id,
      connected: true,
    });
    debugLog(lifecycleEvent);
  });

  nextSocket.on('disconnect', reason => {
    emitLocal('lifecycle.disconnected', {
      reason,
      connected: false,
    });
    debugLog('disconnected', reason);
  });

  nextSocket.on('connect_error', error => {
    debugLog('connect_error', error?.message || error);
  });
}

function connectCustomerRealtime(token) {
  if (!token) return null;

  if (socket && activeToken === token) {
    if (!socket.connected) socket.connect();
    return socket;
  }

  disconnectCustomerRealtime();

  activeToken = token;
  hasConnected = false;
  // Extend the auth payload with platform + appVersion for the analytics
  // presence tracker (Task 2). Do not change anything else about connection
  // handling — the server's authenticateSocket only reads `token`.
  const appVersion = Constants.expoConfig?.version || Constants.manifest?.version || null;
  socket = io(getRealtimeBaseUrl(), {
    auth: { token, platform: Platform.OS, appVersion },
    reconnection: true,
    transports: ['websocket', 'polling'],
  });

  bindSocketEvents(socket);
  return socket;
}

function disconnectCustomerRealtime() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = null;
  activeToken = null;
  hasConnected = false;
}

function emitRealtimeForeground() {
  emitLocal('lifecycle.foreground', {
    connected: Boolean(socket?.connected),
  });
}

function getRealtimeConnectionState() {
  return {
    connected: Boolean(socket?.connected),
    hasSocket: Boolean(socket),
  };
}

// Emit an analytics screen-change event on the connected socket. Silently
// no-ops if the socket isn't connected — analytics is fire-and-forget.
function emitAnalyticsScreen(screen) {
  if (!socket || !socket.connected || !screen) return;
  try {
    socket.emit('analytics:screen', { screen });
  } catch (_) {
    // never throw from analytics
  }
}

// TASK 29.2 — the server resolves this socket's room from
// users.last_area_id only on the initial connect (apps/api/src/realtime/
// socket.js's joinAreaRoom); a pin that moves to a different area mid-
// session needs an explicit push so admin broadcasts (order updates,
// shop-closed, etc.) reach the room for the area the customer is actually
// in now. Server-side handler already exists: socket.js's
// `on('area:changed', ...)` calls rejoinAreaRoom. Silently no-ops if the
// socket isn't connected — the next real connect already joins the
// current area via users.last_area_id anyway.
function emitAreaChanged(areaId) {
  if (!socket || !socket.connected || areaId == null) return;
  try {
    socket.emit('area:changed', { areaId });
  } catch (_) {
    // best-effort — see comment above
  }
}

export {
  connectCustomerRealtime,
  disconnectCustomerRealtime,
  emitAnalyticsScreen,
  emitAreaChanged,
  emitRealtimeForeground,
  getRealtimeConnectionState,
  subscribeAuthRoleEvents,
  subscribeDeliveryZoneEvents,
  subscribeNotificationEvents,
  subscribeOrderEvents,
  subscribeRealtime,
  subscribeRealtimeLifecycle,
  subscribeRiderLocation,
  subscribeShopEvents,
  subscribeProductAvailabilityEvents,
};
