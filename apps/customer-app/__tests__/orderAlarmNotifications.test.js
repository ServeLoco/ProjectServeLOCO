/**
 * Tests for src/utils/orderAlarmNotifications.js — the killed-app / background
 * full-screen alarm path for shop new orders and rider delivery offers.
 *
 * Scope: dedupe (no re-ring on server's ~15s reminder resend), display/cancel
 * wiring, accept/reject action routing, and handleBackgroundAlarmMessage's
 * OS-banner-present vs true-data-only branching. Notifee/expo-audio are the
 * shared jest.setup.js mocks; useLocalNotifications (heavy, many transitive
 * side effects) and the shop/rider API clients are mocked locally so this
 * suite isolates the module under test.
 */
import { Platform } from 'react-native';
import notifee, { EventType } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { shopApi } from '../src/api/shopApi';
import { riderApi } from '../src/api/riderApi';
import { useAuthStore } from '../src/stores';
import { playAlarmSound, stopAlarmSound } from '../src/utils/alarmSound';

jest.mock('../src/hooks/useLocalNotifications', () => ({
  ORDER_ALARM_CHANNEL_ID: 'serveloco-orders-alarm-v5',
  RIDER_OFFER_ALARM_CHANNEL_ID: 'serveloco-rider-offers-alarm-v5',
  createNotifeeAlarmChannels: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/api/shopApi', () => ({
  shopApi: {
    confirmOrder: jest.fn().mockResolvedValue({}),
    rejectOrder: jest.fn().mockResolvedValue({}),
    ackOrderAlert: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../src/api/riderApi', () => ({
  riderApi: { acceptOffer: jest.fn().mockResolvedValue({}), rejectOffer: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../src/api/sessionTokens', () => ({
  setCustomerTokenProvider: jest.fn(),
}));

jest.mock('../src/utils/alarmSound', () => ({
  playAlarmSound: jest.fn().mockResolvedValue(undefined),
  stopAlarmSound: jest.fn(),
}));

const {
  ALERT_TYPE_NEW_ORDER,
  ALERT_TYPE_RIDER_OFFER,
  ORDER_ALARM_NOTIFICATION_ID,
  RIDER_OFFER_ALARM_NOTIFICATION_ID,
  getRemoteAlarmData,
  isAlarmPayload,
  displayAlarmNotification,
  cancelOrderAlarm,
  cancelRiderOfferAlarm,
  cancelAllAlarmNotifications,
  handleAlarmActionEvent,
  handleBackgroundAlarmMessage,
} = require('../src/utils/orderAlarmNotifications');

describe('orderAlarmNotifications', () => {
  const originalOS = Platform.OS;

  beforeEach(async () => {
    Platform.OS = 'android';
    // Reset the module's internal dedupe singleton (activeAlarmKey/At) before
    // wiping mock call history, so no test's dedupe state leaks into the next.
    await cancelAllAlarmNotifications();
    jest.clearAllMocks();
    useAuthStore.setState({ shop: null, rider: null, token: null });
    AsyncStorage.getItem.mockResolvedValue(null);
  });

  afterAll(() => {
    Platform.OS = originalOS;
  });

  describe('getRemoteAlarmData / isAlarmPayload', () => {
    it('returns null when remoteMessage has no data object', () => {
      expect(getRemoteAlarmData({})).toBeNull();
      expect(getRemoteAlarmData({ data: 'not-an-object' })).toBeNull();
    });

    it('returns the data object as-is when present', () => {
      const data = { alertType: ALERT_TYPE_NEW_ORDER, orderId: '5' };
      expect(getRemoteAlarmData({ data })).toBe(data);
    });

    it('isAlarmPayload is true only for the two alarm alertTypes', () => {
      expect(isAlarmPayload({ alertType: ALERT_TYPE_NEW_ORDER })).toBe(true);
      expect(isAlarmPayload({ alertType: ALERT_TYPE_RIDER_OFFER })).toBe(true);
      expect(isAlarmPayload({ alertType: 'shop_order' })).toBe(false);
      expect(isAlarmPayload(null)).toBe(false);
    });
  });

  describe('displayAlarmNotification', () => {
    it('does nothing for a non-alarm alertType', async () => {
      useAuthStore.setState({ shop: { id: 1 } });
      await displayAlarmNotification({ alertType: 'shop_order' });
      expect(notifee.displayNotification).not.toHaveBeenCalled();
    });

    it('does nothing when the session is neither shop nor rider (customer/admin)', async () => {
      useAuthStore.setState({ shop: null, rider: null });
      await displayAlarmNotification({ alertType: ALERT_TYPE_NEW_ORDER, orderId: '5' });
      expect(notifee.displayNotification).not.toHaveBeenCalled();
    });

    it('displays a full-screen alarm for a shop new-order alert', async () => {
      useAuthStore.setState({ shop: { id: 1 }, rider: null });

      await displayAlarmNotification({
        alertType: ALERT_TYPE_NEW_ORDER, orderId: '10', orderNumber: 'O-10',
      });

      expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
      const [call] = notifee.displayNotification.mock.calls[0];
      expect(call.id).toBe(ORDER_ALARM_NOTIFICATION_ID);
      expect(call.android.channelId).toBe('serveloco-orders-alarm-v5');
      expect(call.android.sound).toBe('order_alarm');
      expect(playAlarmSound).toHaveBeenCalledWith('order', expect.any(Object));
      // Must be time-bounded (Play FGS policy: "runs only as long as necessary") —
      // capped at MAX_ORDER_ALARM_RING_MS since shop orders have no server expiry.
      expect(call.android.timeoutAfter).toBeGreaterThan(Date.now());
      expect(call.android.timeoutAfter).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
      // Proof-of-delivery: the alarm rang on this device, so the server's
      // weak-network reminder sweeper should hear about it and ease off.
      expect(shopApi.ackOrderAlert).toHaveBeenCalledWith('10');
    });

    it('displays a full-screen alarm for a rider offer alert', async () => {
      useAuthStore.setState({ shop: null, rider: { id: 7 } });

      await displayAlarmNotification({
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '99', orderId: '10',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });

      const [call] = notifee.displayNotification.mock.calls[0];
      expect(call.id).toBe(RIDER_OFFER_ALARM_NOTIFICATION_ID);
      expect(call.android.channelId).toBe('serveloco-rider-offers-alarm-v5');
      expect(call.android.sound).toBe('rider_alarm');
      expect(playAlarmSound).toHaveBeenCalledWith('rider', expect.any(Object));
      // Bounded by the offer's own expiresAt (~120s out here), not left open-ended.
      expect(call.android.timeoutAfter).toBeGreaterThan(Date.now());
      expect(call.android.timeoutAfter).toBeLessThanOrEqual(Date.now() + 121000);
      // Ack is a shop-alert-only concept — rider offers have their own
      // accept/expire flow and must not call it.
      expect(shopApi.ackOrderAlert).not.toHaveBeenCalled();
    });

    it('skips re-displaying the same offer within the dedupe window (server reminder resend)', async () => {
      useAuthStore.setState({ rider: { id: 7 } });
      const payload = {
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '99', orderId: '10',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      };

      await displayAlarmNotification(payload);
      await displayAlarmNotification(payload); // server's ~15s reminder resend

      expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
      expect(playAlarmSound).toHaveBeenCalledTimes(1);
    });

    it('does not dedupe a different offer arriving while one is already ringing', async () => {
      useAuthStore.setState({ rider: { id: 7 } });
      await displayAlarmNotification({
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '1', orderId: '10',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
      await displayAlarmNotification({
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '2', orderId: '11',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });

      expect(notifee.displayNotification).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancelOrderAlarm / cancelRiderOfferAlarm', () => {
    it('cancels the notifee notification, stops the foreground service, and stops media', async () => {
      await cancelOrderAlarm();
      expect(notifee.cancelNotification).toHaveBeenCalledWith(ORDER_ALARM_NOTIFICATION_ID);
      expect(notifee.stopForegroundService).toHaveBeenCalledTimes(1);
      expect(stopAlarmSound).toHaveBeenCalledTimes(1);
    });

    it('clearing the order alarm does not clear an unrelated active rider dedupe key', async () => {
      useAuthStore.setState({ rider: { id: 7 } });
      await displayAlarmNotification({
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '5', orderId: '1',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
      await cancelOrderAlarm();

      // Rider dedupe key should still be active — a repeat rider reminder is
      // still deduped, proving cancelOrderAlarm('order') didn't clear it.
      jest.clearAllMocks();
      await displayAlarmNotification({
        alertType: ALERT_TYPE_RIDER_OFFER, offerId: '5', orderId: '1',
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
      expect(notifee.displayNotification).not.toHaveBeenCalled();
    });

    it('cancelRiderOfferAlarm cancels the rider notification id', async () => {
      await cancelRiderOfferAlarm();
      expect(notifee.cancelNotification).toHaveBeenCalledWith(RIDER_OFFER_ALARM_NOTIFICATION_ID);
    });
  });

  describe('handleAlarmActionEvent', () => {
    beforeEach(() => {
      useAuthStore.setState({ token: 'jwt-token' });
    });

    it('ignores event types other than PRESS/ACTION_PRESS', async () => {
      await handleAlarmActionEvent({ type: EventType.DELIVERED, detail: {} });
      expect(shopApi.confirmOrder).not.toHaveBeenCalled();
      expect(notifee.cancelNotification).not.toHaveBeenCalled();
    });

    it('a plain tap (PRESS) opens the app but keeps the alarm ringing', async () => {
      await handleAlarmActionEvent({
        type: EventType.PRESS,
        detail: { notification: { data: { alertType: ALERT_TYPE_NEW_ORDER } } },
      });
      expect(shopApi.confirmOrder).not.toHaveBeenCalled();
      expect(notifee.cancelNotification).not.toHaveBeenCalled();
    });

    it('Accept on a shop new-order alarm calls shopApi.confirmOrder and cancels the alarm', async () => {
      await handleAlarmActionEvent({
        type: EventType.ACTION_PRESS,
        detail: {
          pressAction: { id: 'accept' },
          notification: { data: { alertType: ALERT_TYPE_NEW_ORDER, orderId: '10' } },
        },
      });
      expect(shopApi.confirmOrder).toHaveBeenCalledWith('10');
      expect(notifee.cancelNotification).toHaveBeenCalledWith(ORDER_ALARM_NOTIFICATION_ID);
    });

    it('Reject on a rider offer alarm calls riderApi.rejectOffer and cancels the alarm', async () => {
      await handleAlarmActionEvent({
        type: EventType.ACTION_PRESS,
        detail: {
          pressAction: { id: 'reject' },
          notification: { data: { alertType: ALERT_TYPE_RIDER_OFFER, offerId: '99' } },
        },
      });
      expect(riderApi.rejectOffer).toHaveBeenCalledWith('99');
      expect(notifee.cancelNotification).toHaveBeenCalledWith(RIDER_OFFER_ALARM_NOTIFICATION_ID);
    });

    it('silences the alarm instead of calling the API when no auth token is available', async () => {
      useAuthStore.setState({ token: null });
      AsyncStorage.getItem.mockResolvedValue(null);

      await handleAlarmActionEvent({
        type: EventType.ACTION_PRESS,
        detail: {
          pressAction: { id: 'accept' },
          notification: { data: { alertType: ALERT_TYPE_NEW_ORDER, orderId: '10' } },
        },
      });

      expect(shopApi.confirmOrder).not.toHaveBeenCalled();
      expect(notifee.cancelNotification).toHaveBeenCalledWith(ORDER_ALARM_NOTIFICATION_ID);
    });

    it('still silences the ring when the API call throws', async () => {
      shopApi.confirmOrder.mockRejectedValueOnce(new Error('network down'));

      await handleAlarmActionEvent({
        type: EventType.ACTION_PRESS,
        detail: {
          pressAction: { id: 'accept' },
          notification: { data: { alertType: ALERT_TYPE_NEW_ORDER, orderId: '10' } },
        },
      });

      expect(notifee.cancelNotification).toHaveBeenCalledWith(ORDER_ALARM_NOTIFICATION_ID);
    });
  });

  describe('handleBackgroundAlarmMessage', () => {
    beforeEach(() => {
      useAuthStore.setState({ shop: { id: 1 } });
    });

    it('no-ops for a non-alarm data message (customer/admin pushes)', async () => {
      await handleBackgroundAlarmMessage({ data: { type: 'new_customer' } });
      expect(notifee.displayNotification).not.toHaveBeenCalled();
      expect(playAlarmSound).not.toHaveBeenCalled();
    });

    it('true data-only FCM (no notification key) triggers the full-screen display', async () => {
      await handleBackgroundAlarmMessage({
        data: { alertType: ALERT_TYPE_NEW_ORDER, orderId: '10' },
      });
      expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
    });

    it('Expo-fallback delivery (title+body present) plays sound only, no second banner', async () => {
      await handleBackgroundAlarmMessage({
        data: { alertType: ALERT_TYPE_NEW_ORDER, orderId: '10' },
        notification: { title: 'New order to prepare', body: 'Order O-10...' },
      });
      expect(notifee.displayNotification).not.toHaveBeenCalled();
      expect(playAlarmSound).toHaveBeenCalledWith('order', expect.any(Object));
    });
  });
});
