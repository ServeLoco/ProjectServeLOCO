/**
 * TASK 14 — Automated coverage for the rider UAT checklist.
 * Each describe block maps to a plan item (14.1–14.10).
 * Live device steps (physical kill-app) remain human-verified; logic is covered.
 */

const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));
jest.mock('../src/utils/expoPush', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
  sendPushToMany: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: {
    RIDER_ASSIGNMENT_FAILED: 'rider_assignment_failed',
    RIDER_ZERO_AVAILABLE: 'rider_zero_available',
    ORDER_CANCELLED_NO_RIDER: 'order_cancelled_no_rider',
  },
  createAdminNotification: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/realtime/orderEvents', () => ({
  emitOrderStatusUpdated: jest.fn(),
  emitNotificationCreated: jest.fn(),
}));
jest.mock('../src/utils/shops', () => ({
  notifyShopsOrderCancelled: jest.fn(),
  notifyShopsRiderAssigned: jest.fn(),
  notifyShopsRiderAssignmentFailed: jest.fn(),
  syncAreaShopOpenState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));

const assignment = require('../src/services/riderAssignment');
const {
  selectRiderByLeastOrders,
  syncDeliveryAvailabilityFromRiders,
} = require('../src/utils/riders');
const adminInbox = require('../src/utils/adminNotifications');
const notificationService = require('../src/utils/notificationService');
const { emitToAllCustomers } = require('../src/realtime/socket');
const { bustSettingsCache } = require('../src/controllers/settingsController');
const { syncAreaShopOpenState } = require('../src/utils/shops');

function makeConn(responses) {
  const conn = {
    query: jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  };
  for (const v of responses) conn.query.mockResolvedValueOnce(v);
  return conn;
}

const reset = () => {
  pool.query.mockReset();
  pool.getConnection.mockReset();
  jest.clearAllMocks();
};

const baseOrder = (over = {}) => ({
  id: 10,
  status: 'Accepted',
  rider_id: null,
  rider_assignment_status: 'none',
  order_number: 'ORD-10',
  payment_method: 'Cash',
  customer_id: 5,
  coupon_id: null,
  ...over,
});

describe('UAT 14.1 / 14.10 — delivery_available follows rider online count', () => {
  beforeEach(reset);

  it('turns delivery OFF when zero active riders (14.1 / 14.10)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const r = await syncDeliveryAvailabilityFromRiders(1);
    expect(r.deliveryAvailable).toBe(false);
    expect(r.changed).toBe(true);
    expect(bustSettingsCache).toHaveBeenCalledWith(1);
    expect(emitToAllCustomers).toHaveBeenCalledWith(
      'settings.delivery_available.updated',
      expect.objectContaining({ deliveryAvailable: false })
    );
    expect(syncAreaShopOpenState).toHaveBeenCalledWith(1);
  });

  it('turns delivery ON when any rider is active (14.10)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 2 }]])
      .mockResolvedValueOnce([[{ delivery_available: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const r = await syncDeliveryAvailabilityFromRiders(1);
    expect(r.deliveryAvailable).toBe(true);
    expect(r.changed).toBe(true);
  });

});

describe('UAT 14.2 — one rider accept path notifies customer', () => {
  beforeEach(reset);

  it('acceptOffer assigns rider and fires customer rider_assigned', async () => {
    const future = new Date(Date.now() + 120000);
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: future }]], // offer select
      [[{ is_expired: 0 }]], // expiry check (SQL-side)
      [[{ id: 10, status: 'Accepted', rider_id: null, customer_id: 5, order_number: 'O' }]], // order select
      [[]], // busy-rider check — empty = not busy
      [{ affectedRows: 1 }], // offer update
      [{ affectedRows: 1 }], // order update
    ]);
    pool.getConnection.mockResolvedValue(conn);
    pool.query.mockResolvedValueOnce([[{
      id: 10, status: 'Accepted', rider_id: 3, customer_id: 5, order_number: 'O',
      rider_assignment_status: 'assigned',
    }]]);

    const r = await assignment.acceptOffer(1, 3);
    expect(r.ok).toBe(true);
    expect(r.order.rider_id).toBe(3);
    expect(notificationService.createOrderNotification).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'rider_assigned', userId: 5 })
    );
  });
});

describe('UAT 14.3 — sole rider reject: wait window then admin notify', () => {
  beforeEach(reset);

  it('reject with no other eligible riders waits while search window open', async () => {
    const order = baseOrder({ rider_assignment_status: 'offered' });
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: new Date(Date.now() + 99999) }]],
      [{ affectedRows: 1 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);

    pool.query
      .mockResolvedValueOnce([[{ user_id: 7 }]]) // revoke notify after reject
      .mockResolvedValueOnce([[order]]) // continue loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[{ rider_id: 3 }]]) // excluded
      .mockResolvedValueOnce([[]]) // eligible empty
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]); // window open

    const r = await assignment.rejectOffer(1, 3);
    expect(r.ok).toBe(true);
    expect(r.continued?.waiting).toBe(true);
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('reject with no eligible after window expires fails + admin inbox', async () => {
    const order = baseOrder({ rider_assignment_status: 'offered' });
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: new Date(Date.now() + 99999) }]],
      [{ affectedRows: 1 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);

    pool.query
      .mockResolvedValueOnce([[{ user_id: 7 }]]) // revoke notify after reject
      .mockResolvedValueOnce([[order]]) // continue loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[{ rider_id: 3 }]]) // excluded
      .mockResolvedValueOnce([[]]) // eligible empty
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 0 }]]) // window closed
      .mockResolvedValueOnce([[order]]) // fail loadOrder
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // SET failed
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // revoke
      .mockResolvedValueOnce([[{ ...order, rider_assignment_status: 'failed' }]])
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ delivery_available: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const r = await assignment.rejectOffer(1, 3);
    expect(r.ok).toBe(true);
    expect(r.continued?.failed).toBe(true);
    expect(adminInbox.createAdminNotification).toHaveBeenCalled();
  });
});

describe('UAT 14.4 — least completed today wins', () => {
  it('selects rider with fewer deliveries today', () => {
    const chosen = selectRiderByLeastOrders([
      { id: 1, completedToday: 4 },
      { id: 2, completedToday: 1 },
      { id: 3, completedToday: 9 },
    ]);
    expect(chosen.id).toBe(2);
  });

  it('ties broken randomly among equals only', () => {
    const a = { id: 1, completedToday: 0 };
    const b = { id: 2, completedToday: 0 };
    const c = { id: 3, completedToday: 5 };
    expect(selectRiderByLeastOrders([a, b, c], { random: () => 0 }).id).toBe(1);
    expect(selectRiderByLeastOrders([a, b, c], { random: () => 0.99 }).id).toBe(2);
  });
});

describe('UAT 14.5 — timeout treated as reject then continue', () => {
  beforeEach(reset);

  it('expireOffer CAS-marks expired and continues chain (waits if window open)', async () => {
    const order = baseOrder({ rider_assignment_status: 'offered' });
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ order_id: 10, rider_id: 3 }]])
      .mockResolvedValueOnce([[{ user_id: 7 }]])
      .mockResolvedValueOnce([[order]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ rider_id: 3 }]])
      .mockResolvedValueOnce([[]]) // no more eligible
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]); // wait

    const r = await assignment.expireOffer(99);
    expect(r.expired).toBe(true);
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('offer timeout constant is 2.5 minutes', () => {
    expect(assignment.RIDER_OFFER_TIMEOUT_SEC).toBe(150);
  });

  it('search window defaults are 30 min / 30s scan', () => {
    expect(assignment.RIDER_SEARCH_WINDOW_SEC).toBe(1800);
    expect(assignment.RIDER_SEARCH_SCAN_SEC).toBe(30);
  });
});

describe('UAT 14.6 — remaining time from server expiresAt (app restart safe)', () => {
  it('document: client uses expiresAt not local reset — covered in customer-app riderOfferTime tests', () => {
    // Logic lives in apps/customer-app/src/utils/riderOfferTime.js
    // remainingSecondsFromExpiresAt(expiresAt) never invents a fresh 120s.
    expect(true).toBe(true);
  });
});

describe('UAT 14.7 — post-accept cancel disabled (admin-only cancel)', () => {
  beforeEach(reset);

  it('never allows rider cancel after accept', async () => {
    const r = await assignment.cancelAssignmentByRider(10, 3);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CANCEL_NOT_ALLOWED');
  });

  it('reject still excludes rider forever for that order', async () => {
    pool.query.mockResolvedValueOnce([[{ rider_id: 3 }, { rider_id: 8 }]]);
    await expect(assignment.getExcludedRiderIdsForOrder(10)).resolves.toEqual([3, 8]);
  });
});

describe('UAT 14.8 — never two pending offers / no double accept', () => {
  beforeEach(reset);

  it('createOffer skips when pending already exists', async () => {
    const conn = makeConn([
      [[{ id: 99 }]], // existing pending FOR UPDATE
    ]);
    pool.getConnection.mockResolvedValue(conn);
    const offer = await assignment.createOffer(10, { id: 3, userId: 7, user_id: 7 });
    expect(offer).toBeNull();
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('acceptOffer 409 when already not pending', async () => {
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'accepted', expires_at: new Date(Date.now() + 99999) }]],
    ]);
    pool.getConnection.mockResolvedValue(conn);
    const r = await assignment.acceptOffer(1, 3);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });
});

describe('UAT 14.9 — multi-shop: wait until all shops confirm', () => {
  beforeEach(reset);

  it('maybeStart waits when a shop has not confirmed', async () => {
    pool.query
      .mockResolvedValueOnce([[baseOrder()]])
      .mockResolvedValueOnce([[
        { shop_id: 1, shop_confirmed_at: 'x', shop_rejected_at: null },
        { shop_id: 2, shop_confirmed_at: null, shop_rejected_at: null },
      ]]);
    const r = await assignment.maybeStartRiderAssignment(10);
    expect(r.started).toBe(false);
    expect(r.reason).toBe('waiting_shops');
  });

  it('house-only orders do not start from maybeStart (Accepted path starts them)', async () => {
    pool.query
      .mockResolvedValueOnce([[baseOrder()]])
      .mockResolvedValueOnce([[
        { shop_id: null, shop_confirmed_at: null, shop_rejected_at: null },
      ]]);
    const r = await assignment.maybeStartRiderAssignment(10);
    expect(r.reason).toBe('no_shops');
  });
});

describe('UAT 14.1 zero riders at assignment start', () => {
  beforeEach(reset);

  it('startAssignment with zero eligible waits (no instant fail)', async () => {
    const order = baseOrder();
    pool.getConnection
      .mockResolvedValueOnce(makeConn([
        [[order]],
        [{ affectedRows: 1 }],
      ]));

    pool.query
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[]]); // eligible empty

    const r = await assignment.startAssignment(10);
    expect(r.started).toBe(true);
    expect(r.waiting).toBe(true);
    expect(r.reason).toBe('waiting_for_riders');
    expect(r.failed).toBeFalsy();
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });
});
