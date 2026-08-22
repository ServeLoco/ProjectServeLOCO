import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, typography, spacing, radius, shadows } from '../../theme';

function OrderCard({ order = {}, onViewDetails, onCancel, cancellable = false, style }) {
  const {
    orderNumber,
    status = 'Pending',
    paymentStatus = 'Pending',
    itemCount = 0,
    total = 0,
    createdAt,
  } = order;

  const statusColors = {
    Pending:            { bg: colors.warningLight, text: colors.warning },
    Accepted:           { bg: colors.infoLight, text: colors.info },
    Preparing:          { bg: colors.infoLight, text: colors.info },
    'Out for Delivery': { bg: colors.saffronLight, text: colors.saffron },
    Delivered:          { bg: colors.successLight, text: colors.success },
    Cancelled:          { bg: colors.errorLight, text: colors.error },
  };
  const statusLabels = {
    Pending: 'Order Placed',
    Accepted: 'Accepted',
    Preparing: 'Preparing/Packing',
  };

  const paymentColors = {
    Pending: colors.warning,
    Paid:    colors.success,
    Failed:  colors.error,
  };

  const statusColor = statusColors[status] || { bg: colors.bgDisabled, text: colors.textSecondary };

  const formattedDate = createdAt
    ? new Date(createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })
    : '';

  return (
    <View style={[styles.card, style]}>
      {/* Top row */}
      <View style={styles.topRow}>
        <View>
          <Text style={styles.orderNum}>#{orderNumber || order.id}</Text>
          {formattedDate ? (
            <Text style={styles.date}>{formattedDate}</Text>
          ) : null}
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor.bg }]}>
          <Text style={[styles.statusText, { color: statusColor.text }]}>
            {statusLabels[status] || status}
          </Text>
        </View>
      </View>

      {/* Mid row */}
      <View style={styles.midRow}>
        <Text style={styles.itemCount}>{itemCount} item{itemCount !== 1 ? 's' : ''}</Text>
        <View style={styles.paymentRow}>
          <View style={[styles.payDot, { backgroundColor: paymentColors[paymentStatus] || colors.textSecondary }]} />
          <Text style={styles.paymentText}>{paymentStatus}</Text>
        </View>
      </View>

      {/* Total */}
      <Text style={styles.total}>Rs. {Number(total).toFixed(0)}</Text>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          onPress={onViewDetails}
          style={styles.viewBtn}
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityLabel="View order details"
        >
          <Text style={styles.viewBtnText}>View Details</Text>
        </TouchableOpacity>

        {cancellable ? (
          <TouchableOpacity
            onPress={onCancel}
            style={styles.cancelBtn}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityLabel="Cancel order"
          >
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.cardPadding,
    ...shadows.card,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  orderNum: {
    ...typography.labelLarge,
    color: colors.textPrimary,
  },
  date: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  statusBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  statusText: {
    ...typography.captionMedium,
    fontWeight: '700',
    fontSize: 10,
    textTransform: 'uppercase',
  },
  midRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemCount: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  payDot: {
    width: 7,
    height: 7,
    borderRadius: radius.circle,
  },
  paymentText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  total: {
    ...typography.price,
    color: colors.textPrimary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  viewBtn: {
    flex: 1,
    height: 38,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.xs,
  },
  viewBtnText: {
    ...typography.buttonSmall,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  cancelBtn: {
    flex: 1,
    height: 38,
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.errorBorder,
  },
  cancelBtnText: {
    ...typography.buttonSmall,
    color: colors.error,
    fontWeight: '600',
  },
});

export default OrderCard;
