import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { colors, typography, spacing, radius, shadows } from '../../theme';

/**
 * ConfirmModal
 * Confirmation dialog with backdrop, title, message, and two action buttons.
 *
 * Props:
 *   visible         - controls modal visibility
 *   title           - dialog heading
 *   message         - descriptive message
 *   confirmLabel    - confirm button label (default: 'Confirm')
 *   cancelLabel     - cancel button label (default: 'Cancel')
 *   onConfirm       - confirm press handler
 *   onCancel        - cancel/dismiss handler
 *   confirmVariant  - 'danger' | 'primary' (default: 'primary')
 *   confirmLoading  - disables confirm button when true
 *   dismissible     - backdrop tap / Android back close the modal (default: true).
 *                      Set false for modals that must be resolved via a button
 *                      (e.g. a mandatory permission gate).
 */
function ConfirmModal({
  visible = false,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  confirmVariant = 'primary',
  confirmLoading = false,
  dismissible = true,
  children,
}) {
  const confirmBg = confirmVariant === 'danger' ? colors.error : colors.primary;
  const requestClose = dismissible ? onCancel : () => {};

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={requestClose}
    >
      <TouchableWithoutFeedback onPress={dismissible ? onCancel : undefined}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.dialog}>
              {title ? (
                <Text style={styles.title} numberOfLines={2}>
                  {title}
                </Text>
              ) : null}
              {message ? (
                <Text style={styles.message}>{message}</Text>
              ) : null}

              {children}

              <View style={styles.actions}>
                {/* Cancel — pass null/false to hide (used for "Got it" modals). */}
                {cancelLabel !== null && cancelLabel !== false ? (
                  <TouchableOpacity
                    onPress={onCancel}
                    style={[styles.btn, styles.cancelBtn]}
                    activeOpacity={0.78}
                    accessibilityRole="button"
                    accessibilityLabel={cancelLabel}
                  >
                    <Text style={styles.cancelLabel}>{cancelLabel}</Text>
                  </TouchableOpacity>
                ) : null}

                {/* Confirm */}
                <TouchableOpacity
                  onPress={confirmLoading ? undefined : onConfirm}
                  style={[styles.btn, { backgroundColor: confirmBg }, confirmLoading && styles.btnDisabled]}
                  activeOpacity={0.78}
                  accessibilityRole="button"
                  accessibilityLabel={confirmLabel}
                  disabled={confirmLoading}
                >
                  <Text style={styles.confirmLabel}>{confirmLabel}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    ...shadows.modal,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  message: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  btn: {
    flex: 1,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtn: {
    backgroundColor: colors.bgDisabled,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  cancelLabel: {
    ...typography.button,
    color: colors.textSecondary,
  },
  confirmLabel: {
    ...typography.button,
    color: colors.textInverse,
  },
});

export default ConfirmModal;
