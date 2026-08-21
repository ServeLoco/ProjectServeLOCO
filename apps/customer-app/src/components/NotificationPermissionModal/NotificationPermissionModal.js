import React, { useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Modal, Animated } from 'react-native';
import { colors, typography, spacing, radius, shadows } from '../../theme';
import AppIcon from '../AppIcon';
import Button from '../Button';

/**
 * NotificationPermissionModal
 *
 * Shows a friendly popup asking users to enable notifications
 * for order updates. Displayed after placing first order.
 */
function NotificationPermissionModal({ visible, onAllow, onDismiss }) {
  const modalOpacity = useRef(new Animated.Value(0)).current;
  const modalScale = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(modalOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.spring(modalScale, { toValue: 1, friction: 6, useNativeDriver: true })
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(modalOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(modalScale, { toValue: 0.8, duration: 200, useNativeDriver: true })
      ]).start();
    }
  }, [visible, modalOpacity, modalScale]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onDismiss}>
      <View style={styles.modalOverlay}>
        <Animated.View style={[styles.modalBackdrop, { opacity: modalOpacity }]} />
        <Animated.View style={[styles.modalContent, { opacity: modalOpacity, transform: [{ scale: modalScale }] }]}>
          <View style={styles.iconContainer}>
            <AppIcon name="bell" size={48} color={colors.primary} />
          </View>

          <Text style={styles.modalTitle}>Stay Updated!</Text>
          <Text style={styles.modalDesc}>
            Get notified time to time about your order status - from preparation to delivery. Never miss an update!
          </Text>

          <View style={styles.modalActions}>
            <Button
              label="Continue"
              onPress={onAllow}
              style={styles.modalBtn}
              variant="primary"
            />
            <Button
              label="Maybe Later"
              variant="ghost"
              onPress={onDismiss}
              style={styles.modalBtn}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: '85%',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    ...shadows.xl,
  },
  iconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    ...typography.h2,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  modalDesc: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 22,
  },
  modalActions: {
    width: '100%',
    gap: spacing.md,
  },
  modalBtn: {
    width: '100%',
  },
});

export default NotificationPermissionModal;
