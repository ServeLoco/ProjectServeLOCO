const { getReorderEligibility } = require('../src/utils/reorderEligibility');

const DELIVERED_ORDER = { status: 'Delivered', area_id: 1, items: [{ product_id: 501, quantity: 2 }] };

describe('getReorderEligibility (TASK 29.6)', () => {
  it('is not shown for a non-delivered order', () => {
    const result = getReorderEligibility({ ...DELIVERED_ORDER, status: 'Pending' }, 1);
    expect(result).toEqual({ showReorder: false, canReorder: false, blockedReason: null });
  });

  it('is not shown for a delivered order with no items', () => {
    const result = getReorderEligibility({ ...DELIVERED_ORDER, items: [] }, 1);
    expect(result.showReorder).toBe(false);
  });

  it('is not shown when order is null', () => {
    expect(getReorderEligibility(null, 1)).toEqual({ showReorder: false, canReorder: false, blockedReason: null });
  });

  it('allows reorder when the order area matches the current area', () => {
    const result = getReorderEligibility(DELIVERED_ORDER, 1);
    expect(result).toEqual({ showReorder: true, canReorder: true, blockedReason: null });
  });

  it('allows reorder when the order uses the camelCase areaId field', () => {
    const result = getReorderEligibility({ ...DELIVERED_ORDER, area_id: undefined, areaId: 1 }, 1);
    expect(result.canReorder).toBe(true);
  });

  // §9.4 item 2 — never silently substitute another area's product.
  it('blocks reorder with an explanation when the order was placed in a different area', () => {
    const result = getReorderEligibility({ ...DELIVERED_ORDER, area_id: 1 }, 2);
    expect(result.showReorder).toBe(true);
    expect(result.canReorder).toBe(false);
    expect(result.blockedReason).toMatch(/different delivery area/);
  });

  it('blocks reorder when the customer has no resolved area yet', () => {
    const result = getReorderEligibility(DELIVERED_ORDER, null);
    expect(result.canReorder).toBe(false);
    expect(result.blockedReason).toMatch(/delivery location/);
  });

  it('does not block reorder when the order has no recorded area (legacy/missing data)', () => {
    const result = getReorderEligibility({ ...DELIVERED_ORDER, area_id: undefined, areaId: undefined }, 1);
    expect(result.canReorder).toBe(true);
  });
});
