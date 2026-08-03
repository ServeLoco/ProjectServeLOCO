/**
 * TASK 29.6 — areas are operationally independent (§9.4 item 2). An old
 * order's product ids belong to whichever area it was placed in; area 2's
 * `products` table has entirely different ids even for a library-linked
 * "same" item. Rather than a per-product existence probe (no bulk-check
 * endpoint exists), compare the order's own area to the customer's CURRENT
 * resolved area directly — a mismatch means the order's product ids are
 * certain not to resolve here. Never silently substitute another area's
 * product: show the order, disable Reorder, explain why.
 */

/**
 * @param {{status?: string, items?: Array, area_id?: number, areaId?: number}|null} order
 * @param {number|null} currentAreaId - useDeliveryLocationStore's areaId
 * @returns {{ showReorder: boolean, canReorder: boolean, blockedReason: string|null }}
 */
export function getReorderEligibility(order, currentAreaId) {
  const showReorder = Boolean(order)
    && order.status === 'Delivered'
    && Array.isArray(order.items)
    && order.items.length > 0;

  if (!showReorder) {
    return { showReorder: false, canReorder: false, blockedReason: null };
  }

  if (currentAreaId == null) {
    return { showReorder: true, canReorder: false, blockedReason: 'Set your delivery location to reorder' };
  }

  const orderAreaId = Number(order.area_id ?? order.areaId);
  if (Number.isFinite(orderAreaId) && orderAreaId !== Number(currentAreaId)) {
    return {
      showReorder: true,
      canReorder: false,
      blockedReason: "This order was placed in a different delivery area and can't be reordered here",
    };
  }

  return { showReorder: true, canReorder: true, blockedReason: null };
}
