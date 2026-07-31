import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, typography, spacing } from '../../theme';
import Button from '../Button';

/**
 * EmptyState
 * Shows a message and optional action button when content is empty.
 *
 * Props:
 *   title       - main empty message
 *   subtitle    - secondary descriptive line
 *   actionLabel - button text
 *   onAction    - button press handler
 *   icon          - optional ReactNode icon above title
 *   style         - container style
 *   actionVariant - Button variant for the action (default 'primary')
 */
function EmptyState({ title, subtitle, actionLabel, onAction, icon, style, actionVariant = 'primary' }) {
  return (
    <View style={[styles.container, style]}>
      {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
      <Text style={styles.title}>{title}</Text>
      {subtitle ? (
        <Text style={styles.subtitle}>{subtitle}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant={actionVariant}
          size="md"
          fullWidth={false}
          style={styles.btn}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
  },
  iconWrap: {
    marginBottom: spacing.md,
    opacity: 0.5,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  btn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
});

export default EmptyState;
