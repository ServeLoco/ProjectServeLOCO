import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import {
  connectCustomerRealtime,
  disconnectCustomerRealtime,
  emitRealtimeForeground,
} from '../api/realtimeClient';
import { useAuthStore } from '../stores';

// Backgrounded sockets otherwise never disconnect (Android can keep the JS
// process — and the websocket answering pings — alive for a long time),
// which leaves the analytics "online now" list full of idle sessions and
// makes the server keep pinging/tracking them for no reason. Push
// notifications already cover order/rider alerts while backgrounded
// (useNewOrderAlert, useRiderOfferAlert), so the realtime socket isn't
// needed there. Grace delay avoids disconnect/reconnect thrash on a quick
// screen-off/on or a transient app-switcher swipe.
const BACKGROUND_DISCONNECT_DELAY_MS = 15000;

function useCustomerRealtime() {
  const hasHydrated = useAuthStore(state => state.hasHydrated);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const token = useAuthStore(state => state.token);
  const backgroundTimerRef = useRef(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    if (!hasHydrated) return undefined;

    if (isAuthenticated && token) {
      connectCustomerRealtime(token);
    } else {
      disconnectCustomerRealtime();
    }

    return undefined;
  }, [hasHydrated, isAuthenticated, token]);

  useEffect(() => {
    const clearBackgroundTimer = () => {
      if (backgroundTimerRef.current) {
        clearTimeout(backgroundTimerRef.current);
        backgroundTimerRef.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        clearBackgroundTimer();
        if (isAuthenticated && tokenRef.current) {
          connectCustomerRealtime(tokenRef.current);
        }
        emitRealtimeForeground();
      } else {
        clearBackgroundTimer();
        backgroundTimerRef.current = setTimeout(() => {
          backgroundTimerRef.current = null;
          disconnectCustomerRealtime();
        }, BACKGROUND_DISCONNECT_DELAY_MS);
      }
    });

    return () => {
      clearBackgroundTimer();
      subscription.remove();
    };
  }, [isAuthenticated]);
}

export { useCustomerRealtime };
