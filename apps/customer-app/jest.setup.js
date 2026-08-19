jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  getItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
}));

jest.mock('expo-location', () => ({
  Accuracy: {
    High: 4,
    Balanced: 3,
  },
  // Mirrors expo-location's LocationActivityType enum values — the rider
  // background-location task passes ActivityType.AutomotiveNavigation.
  ActivityType: {
    Other: 1,
    AutomotiveNavigation: 2,
    Fitness: 3,
    OtherNavigation: 4,
    Airborne: 5,
  },
  PermissionStatus: {
    GRANTED: 'granted',
  },
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(async () => []),
  getForegroundPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
    granted: true,
    android: { accuracy: 'fine' },
  })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
    granted: true,
    android: { accuracy: 'fine' },
  })),
  watchPositionAsync: jest.fn(async () => ({ remove: jest.fn() })),
  getBackgroundPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
    granted: true,
  })),
  requestBackgroundPermissionsAsync: jest.fn(async () => ({
    status: 'granted',
    granted: true,
  })),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  startLocationUpdatesAsync: jest.fn(async () => {}),
  stopLocationUpdatesAsync: jest.fn(async () => {}),
}));

// Mock expo-task-manager — native module; not available in Node/Jest.
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskDefined: jest.fn(() => false),
  isTaskRegisteredAsync: jest.fn(async () => false),
  unregisterTaskAsync: jest.fn(async () => {}),
}));

// Mock @rnmapbox/maps — native module; not available in Node/Jest.
jest.mock('@rnmapbox/maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = React.forwardRef((props, ref) => <View ref={ref} {...props} />);
  const api = {
    setAccessToken: jest.fn(),
    StyleURL: {
      Street: 'mapbox://styles/mapbox/streets-v12',
      SatelliteStreet: 'mapbox://styles/mapbox/satellite-streets-v12',
    },
    MapView: Mock,
    Camera: Mock,
    PointAnnotation: Mock,
    MarkerView: Mock,
    ShapeSource: Mock,
    LineLayer: Mock,
  };
  return { __esModule: true, default: api, ...api };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockSvg = React.forwardRef((props, ref) => <View ref={ref} {...props} />);

  return {
    __esModule: true,
    default: MockSvg,
    Circle: MockSvg,
    ClipPath: MockSvg,
    Defs: MockSvg,
    Ellipse: MockSvg,
    G: MockSvg,
    Line: MockSvg,
    LinearGradient: MockSvg,
    Path: MockSvg,
    Polygon: MockSvg,
    Polyline: MockSvg,
    Rect: MockSvg,
    Stop: MockSvg,
    Svg: MockSvg,
  };
});

// Mock SafeAreaContext
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

// Mock expo-notifications — not available in Node/Jest environment
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'mock-push-token' })),
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  scheduleNotificationAsync: jest.fn(async () => {}),
  dismissNotificationAsync: jest.fn(async () => {}),
  cancelAllScheduledNotificationsAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  deleteNotificationChannelAsync: jest.fn(async () => {}),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  AndroidImportance: { MAX: 7, HIGH: 6, DEFAULT: 5 },
  AndroidAudioUsage: { NOTIFICATION: 5 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

// Mock expo-audio — native module not available in Node/Jest environment
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() })),
  setAudioModeAsync: jest.fn(async () => {}),
}));

// Mock expo-linear-gradient
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: React.forwardRef((props, ref) => <View ref={ref} {...props} />),
  };
});

// Mock @react-native-firebase/auth — native module not available in Jest/Node.
// AuthScreen imports this, so any test that touches AuthScreen needs the mock.
// Modular API (v22+): getAuth() returns an instance; signInWithPhoneNumber and
// getIdToken are standalone functions taking that instance/user as first arg.
jest.mock('@react-native-firebase/auth', () => {
  const mockAuthInstance = { currentUser: null };
  return {
    __esModule: true,
    getAuth: jest.fn(() => mockAuthInstance),
    signInWithPhoneNumber: jest.fn(async () => ({
      confirm: jest.fn(async () => ({
        user: { getIdToken: jest.fn(async () => 'mock-id-token') },
      })),
    })),
    getIdToken: jest.fn(async (user) => (user?.getIdToken ? user.getIdToken() : 'mock-id-token')),
  };
});

jest.mock('@react-native-firebase/app', () => ({
  __esModule: true,
  default: {},
}));

// Mock @notifee/react-native — native module not available in Node/Jest.
jest.mock('@notifee/react-native', () => {
  const notifee = {
    createChannel: jest.fn(async () => 'mock-channel'),
    displayNotification: jest.fn(async () => 'mock-notif-id'),
    cancelNotification: jest.fn(async () => {}),
    cancelDisplayedNotification: jest.fn(async () => {}),
    stopForegroundService: jest.fn(async () => {}),
    registerForegroundService: jest.fn(),
    canUseFullScreenIntent: jest.fn(async () => true),
    openFullScreenIntentSettings: jest.fn(async () => {}),
    onForegroundEvent: jest.fn(() => jest.fn()),
    onBackgroundEvent: jest.fn(),
    getInitialNotification: jest.fn(async () => null),
  };
  return {
    __esModule: true,
    default: notifee,
    AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
    AndroidVisibility: { PUBLIC: 1, PRIVATE: 0, SECRET: -1 },
    AndroidCategory: { CALL: 'call', ALARM: 'alarm' },
    AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_SPECIAL_USE: 1024 },
    EventType: {
      DISMISS: 0,
      PRESS: 1,
      ACTION_PRESS: 2,
      DELIVERED: 3,
      APP_BLOCKED: 4,
      CHANNEL_BLOCKED: 5,
      CHANNEL_GROUP_BLOCKED: 6,
      TRIGGER_NOTIFICATION_CREATED: 7,
      FG_ALREADY_EXIST: 8,
    },
  };
});

// Mock @react-native-firebase/messaging — native module not available in Node/Jest.
// Supports modular API (getMessaging/getToken/onMessage/…) used in production code.
jest.mock('@react-native-firebase/messaging', () => {
  const messagingInstance = {
    setBackgroundMessageHandler: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
    getToken: jest.fn(async () => 'mock-fcm-token'),
    requestPermission: jest.fn(async () => 1),
  };
  return {
    __esModule: true,
    default: jest.fn(() => messagingInstance),
    getMessaging: jest.fn(() => messagingInstance),
    getToken: jest.fn(async () => 'mock-fcm-token'),
    setBackgroundMessageHandler: jest.fn(),
    onMessage: jest.fn(() => jest.fn()),
  };
});
