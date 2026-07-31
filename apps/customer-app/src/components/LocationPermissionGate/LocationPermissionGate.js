import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import AppScreen from '../AppScreen';
import AppIcon from '../AppIcon';
import Button from '../Button';
import LocationSettingsGuide from './LocationSettingsGuide';
import { colors, typography, spacing, radius } from '../../theme';
import {
  requestPreciseLocationPermission,
  openAppLocationSettings,
} from '../../hooks/usePreciseLocationPermissionOnStart';
import { syncDeliveryLocation } from '../../hooks/useDeliveryLocationSync';

/**
 * Full-screen gate shown before the dashboard for any customer who hasn't
 * granted location permission yet — replaces the old Cart-page popup so the
 * ask happens once, up front, instead of blocking the cart every visit.
 * Rendered as a Stack.Screen by CustomerNavigator; calls onGranted() once
 * permission is confirmed, which swaps the stack over to the real screens.
 */
function LocationPermissionGate({ checking = false, onGranted }) {
  const [requesting, setRequesting] = useState(false);
  const [needsSettingsHelp, setNeedsSettingsHelp] = useState(false);

  // Returning from device Settings backgrounds/foregrounds the app —
  // re-check so the gate clears itself the moment permission is granted.
  // Deliberately does NOT auto-switch to the Settings guide here: a plain
  // app resume (user reopens from recents) also fires this, and jumping
  // straight to "Open Settings" would skip the Allow Location screen the
  // user hasn't even tapped yet this session. Only handleAllow (an actual
  // tap) decides between the OS dialog and the guide.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      try {
        const existing = await Location.getForegroundPermissionsAsync();
        if (existing?.granted) {
          syncDeliveryLocation();
          onGranted?.();
        }
      } catch (_) { /* ignore */ }
    });
    return () => sub.remove();
  }, [onGranted]);

  const handleAllow = useCallback(async () => {
    setRequesting(true);
    try {
      const result = await requestPreciseLocationPermission();
      if (result.granted) {
        syncDeliveryLocation();
        onGranted?.();
        return;
      }
      if (result.needsSettings) {
        // Show the step-by-step guide first — only navigate to Settings once
        // the user taps "Open Settings" on that screen (LocationSettingsGuide).
        setNeedsSettingsHelp(true);
      }
    } finally {
      setRequesting(false);
    }
  }, [onGranted]);

  if (checking) {
    return (
      <AppScreen style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={colors.primary} />
      </AppScreen>
    );
  }

  // OS won't show the permission dialog again — hand off to the
  // step-by-step Settings guide instead of a dead "Allow Location" button.
  if (needsSettingsHelp) {
    return (
      <LocationSettingsGuide
        onBack={() => setNeedsSettingsHelp(false)}
        onOpenSettings={openAppLocationSettings}
      />
    );
  }

  return (
    <AppScreen style={styles.container}>
      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <AppIcon name="location" size={40} color={colors.saffron} strokeWidth={2.2} />
        </View>

        <Text style={styles.title}>Enable Location</Text>
        <Text style={styles.subtitle}>
          Allow location access to discover shops and delivery services available in your area.
        </Text>

        <Button
          label="Allow Location"
          onPress={handleAllow}
          loading={requesting}
          variant="highlight"
          style={styles.button}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  content: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  iconWrap: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    backgroundColor: colors.saffronLight || colors.primaryLight || '#FFF2EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    color: colors.textPrimary,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  button: {
    marginTop: spacing.sm,
  },
});

export default LocationPermissionGate;
