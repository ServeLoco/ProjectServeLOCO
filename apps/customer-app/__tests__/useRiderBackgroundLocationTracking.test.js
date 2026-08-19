/**
 * useRiderBackgroundLocationTracking tests via a tiny probe component (no
 * @testing-library/react-native — see useCachedFetch.test.js for the same
 * pattern). Focus: the App/Play Store "prominent disclosure before the OS
 * Always-location prompt" flow, and its two bugs fixed alongside F-2 —
 * a decline used to still mark the disclosure "shown" (skipping it on the
 * next attempt, going straight to the OS dialog with no disclosure at all),
 * and the disclosure's pending promise leaked (never resolved) if the
 * component unmounted or isOnline/hasActiveAssignment changed while it was
 * still up.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// The hook reads Platform.OS once, at module scope, to decide whether
// background location is supported at all (Android only — iOS ships as a
// customer app and never runs rider mode). jest-expo defaults Platform.OS to
// 'ios', so the platform must be set BEFORE the module is loaded. Hence
// require() here rather than a hoisted import.
Platform.OS = 'android';
const {
  useRiderBackgroundLocationTracking,
} = require('../src/hooks/useRiderBackgroundLocationTracking');

const DISCLOSURE_SHOWN_KEY = 'serveloco-rider-bg-location-disclosure-shown';

function renderHook(isOnline, hasActiveAssignment) {
  const captured = { current: null };
  function Probe({ online, active }) {
    captured.current = useRiderBackgroundLocationTracking(online, active);
    return null;
  }
  let testRenderer;
  act(() => {
    testRenderer = ReactTestRenderer.create(
      <Probe online={isOnline} active={hasActiveAssignment} />
    );
  });
  return {
    captured,
    rerender: (nextOnline, nextActive) => {
      act(() => {
        testRenderer.update(<Probe online={nextOnline} active={nextActive} />);
      });
    },
    unmount: () => {
      act(() => {
        testRenderer.unmount();
      });
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRiderBackgroundLocationTracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AsyncStorage.getItem.mockReset();
    AsyncStorage.setItem.mockReset();
    AsyncStorage.getItem.mockResolvedValue(null);
    AsyncStorage.setItem.mockResolvedValue(undefined);
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false });
    Location.requestBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });
    Location.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    Location.startLocationUpdatesAsync.mockResolvedValue(undefined);
    Location.stopLocationUpdatesAsync.mockResolvedValue(undefined);
  });

  it('shows the disclosure before requesting background permission when never shown before', async () => {
    const { captured } = renderHook(true, false);
    await flush();

    expect(captured.current.disclosureVisible).toBe(true);
    // Must not request the OS permission until the rider responds.
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not show the disclosure again once already granted', async () => {
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true });

    const { captured } = renderHook(true, false);
    await flush();

    expect(captured.current.disclosureVisible).toBe(false);
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalled();
  });

  it('persists the disclosure-shown flag on Allow and proceeds to the OS prompt', async () => {
    const { captured } = renderHook(true, false);
    await flush();
    expect(captured.current.disclosureVisible).toBe(true);

    await act(async () => {
      captured.current.onDisclosureAllow();
    });
    await flush();

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(DISCLOSURE_SHOWN_KEY, '1');
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
    expect(captured.current.disclosureVisible).toBe(false);
  });

  it('does NOT persist the disclosure-shown flag on Decline, and never reaches the OS prompt', async () => {
    const { captured } = renderHook(true, false);
    await flush();
    expect(captured.current.disclosureVisible).toBe(true);

    await act(async () => {
      captured.current.onDisclosureDecline();
    });
    await flush();

    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(DISCLOSURE_SHOWN_KEY, '1');
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(captured.current.disclosureVisible).toBe(false);
  });

  it('shows the disclosure again on a later attempt after a decline (policy: must precede every OS prompt)', async () => {
    const { captured, rerender } = renderHook(true, false);
    await flush();
    await act(async () => {
      captured.current.onDisclosureDecline();
    });
    await flush();

    // Rider goes offline then online again — a fresh start() attempt.
    rerender(false, false);
    await flush();
    rerender(true, false);
    await flush();

    expect(captured.current.disclosureVisible).toBe(true);
  });

  it('does not show the disclosure again after a previous Allow', async () => {
    const { captured, rerender } = renderHook(true, false);
    await flush();
    await act(async () => {
      captured.current.onDisclosureAllow();
    });
    await flush();

    // Simulate the flag now being persisted (AsyncStorage mock is shared
    // in-memory across the getItem call this next attempt makes).
    AsyncStorage.getItem.mockResolvedValue('1');
    Location.getBackgroundPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false });

    rerender(false, false);
    await flush();
    rerender(true, false);
    await flush();

    expect(captured.current.disclosureVisible).toBe(false);
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
  });

  it('resolves the pending disclosure promise (does not hang) when the deps change while it is showing', async () => {
    const { captured, rerender } = renderHook(true, false);
    await flush();
    expect(captured.current.disclosureVisible).toBe(true);

    // Rider picks up a job while the disclosure is still up.
    rerender(true, true);
    await flush();

    expect(captured.current.disclosureVisible).toBe(false);
    expect(Location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    // Not persisted — this was an abandonment, not a real decline choice by
    // the rider, so a genuine future attempt must still show the disclosure.
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(DISCLOSURE_SHOWN_KEY, '1');
  });

  it('resolves the pending disclosure promise (does not hang) on unmount', async () => {
    const { captured, unmount } = renderHook(true, false);
    await flush();
    expect(captured.current.disclosureVisible).toBe(true);

    expect(() => unmount()).not.toThrow();
  });
});
