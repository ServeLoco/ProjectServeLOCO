/**
 * iOS ships as a customer-facing app; rider mode is Android-only.
 *
 * Rider screens are gated by ACCOUNT ROLE rather than platform, so an iOS
 * rider-role login would otherwise reach this hook — prompting for "Always"
 * location and starting a background task for a role never used on that
 * platform. It also forces UIBackgroundModes:location into the iOS build,
 * which App Review rejects when the app's iOS functionality never exercises
 * it (Guideline 2.5.4), and this app already carries an App Store rejection
 * history.
 *
 * Separate file from the Android suite on purpose: the hook reads Platform.OS
 * once at module scope, and jest gives each test file its own module registry,
 * so this is the only clean way to load it under a different platform.
 * (jest.isolateModules re-instantiates React and breaks its hook dispatcher.)
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

// jest-expo already defaults Platform.OS to 'ios'; set it explicitly so this
// file's intent does not depend on that default. Must precede the require.
Platform.OS = 'ios';
const {
  useRiderBackgroundLocationTracking,
} = require('../src/hooks/useRiderBackgroundLocationTracking');

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRiderBackgroundLocationTracking on iOS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false });
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  });

  const renderOnlineRider = () => {
    const captured = { current: null };
    function Probe() {
      captured.current = useRiderBackgroundLocationTracking(true, false);
      return null;
    }
    let renderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    return { captured, unmount: () => act(() => renderer.unmount()) };
  };

  it('never touches background location permission, even for an online rider', async () => {
    const { captured } = renderOnlineRider();
    await flush();

    expect(Location.getBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(captured.current.disclosureVisible).toBe(false);
  });

  it('never starts the background location task', async () => {
    renderOnlineRider();
    await flush();

    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('unmounts cleanly without trying to stop a task it never started', async () => {
    const { unmount } = renderOnlineRider();
    await flush();

    expect(() => unmount()).not.toThrow();
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});
