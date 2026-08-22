import { io } from 'socket.io-client';
import { API_ORIGIN } from './client';
import { storage } from '../utils/storage';

const TOKEN_KEY = 'admin_token';
const ADMIN_ORDER_EVENTS = [
  'admin.order.created',
  'admin.order.updated',
  'admin.order.shop_confirmed',
  'admin.order.shop_ready',
  'admin.order.rider_updated',
  'admin.order.cancel_request',
  'admin.order.item_replaced',
];
const ADMIN_NOTIFICATION_EVENTS = ['admin.notification.created', 'admin.notification.unread_count', 'admin.order.auto_accepted', 'admin.order.snoozed'];
const ADMIN_ANALYTICS_EVENTS = ['analytics.live'];
const ADMIN_RIDER_EVENTS = ['admin.rider.updated'];
const LIFECYCLE_EVENTS = ['connected', 'reconnected', 'disconnected', 'visible'];

let socket = null;
let activeToken = null;
let hasConnected = false;
let storageListenerBound = false;
let visibilityListenerBound = false;
let storageHandler = null;
let visibilityHandler = null;

const listeners = new Map();

function debugLog(...args) {
  if (import.meta.env.DEV) {
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
      if (import.meta.env.DEV) {
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

function subscribeRealtimeLifecycle(handler) {
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
      connected: true,
      socketId: nextSocket.id,
    });
    debugLog(lifecycleEvent);
  });

  nextSocket.on('disconnect', reason => {
    emitLocal('lifecycle.disconnected', {
      connected: false,
      reason,
    });
    debugLog('disconnected', reason);
  });

  nextSocket.on('connect_error', error => {
    const msg = String(error?.message || error || '');
    debugLog('connect_error', msg);
    // If the server rejects the socket handshake because the token is dead
    // or revoked, the admin must know — the socket will keep retrying
    // forever otherwise. The HTTP layer dispatches `admin:unauthorized`
    // on 401s, but the WebSocket transport has no equivalent.
    if (/token|unauthorized|auth|invalid|expired/i.test(msg)) {
      try {
        storage.clearToken();
        window.dispatchEvent(new CustomEvent('admin:unauthorized'));
      } catch (_) { /* noop */ }
    }
  });
}

function bindBrowserLifecycle() {
  if (!storageListenerBound) {
    storageHandler = event => {
      if (event.key !== TOKEN_KEY) return;

      if (!event.newValue) {
        disconnectAdminRealtime();
        return;
      }

      connectAdminRealtime();
    };
    window.addEventListener('storage', storageHandler);
    storageListenerBound = true;
  }

  if (!visibilityListenerBound) {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        emitLocal('lifecycle.visible', {
          connected: Boolean(socket?.connected),
        });
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    visibilityListenerBound = true;
  }
}

function connectAdminRealtime() {
  const token = storage.getToken();
  if (!token) return null;

  if (socket && activeToken === token) {
    bindBrowserLifecycle();
    if (!socket.connected) socket.connect();
    return socket;
  }

  disconnectAdminRealtime();
  bindBrowserLifecycle();

  activeToken = token;
  hasConnected = false;
  socket = io(API_ORIGIN, {
    auth: { token },
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

  if (storageListenerBound && storageHandler) {
    window.removeEventListener('storage', storageHandler);
    storageHandler = null;
    storageListenerBound = false;
  }

  if (visibilityListenerBound && visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
    visibilityListenerBound = false;
  }
}

function getRealtimeConnectionState() {
  return {
    connected: Boolean(socket?.connected),
    hasSocket: Boolean(socket),
  };
}

export {
  connectAdminRealtime,
  disconnectAdminRealtime,
  getRealtimeConnectionState,
  subscribeAdminOrderEvents,
  subscribeRealtime,
  subscribeRealtimeLifecycle,
};
