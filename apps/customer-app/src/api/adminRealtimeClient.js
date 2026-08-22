import { io } from 'socket.io-client';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { getRealtimeBaseUrl } from './realtimeConfig';

// Separate socket instance from the customer one — Admin Mode uses its own
// JWT (role: 'admin') to join the `admin` room server-side; the customer
// socket (role: 'customer') never receives these events. Event names mirror
// apps/admin/src/api/realtimeClient.js (web) so both clients stay in sync.
const ADMIN_ORDER_EVENTS = ['admin.order.created', 'admin.order.updated', 'admin.order.shop_confirmed', 'admin.order.shop_ready', 'admin.order.item_replaced'];
const ADMIN_NOTIFICATION_EVENTS = [
  'admin.notification.created',
  'admin.notification.unread_count',
  'admin.order.auto_accepted',
  'admin.order.cancel_request',
  'admin.order.rider_updated',
];
const ADMIN_ANALYTICS_EVENTS = ['analytics.live'];
const ADMIN_RIDER_EVENTS = ['admin.rider.updated'];
const LIFECYCLE_EVENTS = ['connected', 'reconnected', 'disconnected', 'foreground'];

let socket = null;
let activeToken = null;
let hasConnected = false;

const listeners = new Map();

function debugLog(...args) {
  if (__DEV__) {
    console.log('[admin realtime]', ...args);
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
        console.warn('[admin realtime] listener failed', eventName, error);
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

function subscribeAdminOrderEvents(handler) {
  const unsubscribers = ADMIN_ORDER_EVENTS.map(eventName =>
    subscribeRealtime(eventName, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function subscribeAdminRealtimeLifecycle(handler) {
  const unsubscribers = LIFECYCLE_EVENTS.map(eventName =>
    subscribeRealtime(`lifecycle.${eventName}`, payload => handler({ eventName, payload }))
  );

  return () => unsubscribers.forEach(unsubscribe => unsubscribe());
}

function bindSocketEvents(nextSocket) {
  ADMIN_ORDER_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  ADMIN_NOTIFICATION_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  ADMIN_ANALYTICS_EVENTS.forEach(eventName => {
    nextSocket.on(eventName, payload => emitLocal(eventName, payload));
  });

  ADMIN_RIDER_EVENTS.forEach(eventName => {
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

function connectAdminRealtime(token) {
  if (!token) return null;

  if (socket && activeToken === token) {
    if (!socket.connected) socket.connect();
    return socket;
  }

  disconnectAdminRealtime();

  activeToken = token;
  hasConnected = false;
  const appVersion = Constants.expoConfig?.version || Constants.manifest?.version || null;
  socket = io(getRealtimeBaseUrl(), {
    auth: { token, platform: Platform.OS, appVersion },
    reconnection: true,
    transports: ['websocket', 'polling'],
  });

  bindSocketEvents(socket);
  return socket;
}

function disconnectAdminRealtime() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  socket = null;
  activeToken = null;
  hasConnected = false;
}

function emitAdminRealtimeForeground() {
  emitLocal('lifecycle.foreground', {
    connected: Boolean(socket?.connected),
  });
}

function getAdminRealtimeConnectionState() {
  return {
    connected: Boolean(socket?.connected),
    hasSocket: Boolean(socket),
  };
}

export {
  connectAdminRealtime,
  disconnectAdminRealtime,
  emitAdminRealtimeForeground,
  getAdminRealtimeConnectionState,
  subscribeAdminOrderEvents,
  subscribeRealtime as subscribeAdminRealtime,
  subscribeAdminRealtimeLifecycle,
};
