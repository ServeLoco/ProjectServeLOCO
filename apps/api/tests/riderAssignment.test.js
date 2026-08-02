/**
 * Unit tests for the rider assignment engine (TASK 5).
 * Focused, isolated mocks — one scenario per test with full mock queues.
 */

const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
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

// Default: FCM "succeeds" so flow tests (which don't care about push
// delivery) don't fall through to the real fcmAlarmPush logic against an
// exhausted pool.query mock queue. Branch-specific behavior is asserted in
// the dedicated 'pushRiderOffer FCM/Expo branching' describe block below.
jest.mock('../src/utils/fcmAlarmPush', () => ({
  sendFcmDataOnlyToUser: jest.fn().mockResolvedValue({ sent: true }),
  sendFcmDataOnlyToMany: jest.fn().mockResolvedValue([]),
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
  syncAreaShopOpenState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));

const assignment = require('../src/services/riderAssignment');
const adminInbox = require('../src/utils/adminNotifications');
const { emitToCustomer } = require('../src/realtime/socket');
const { selectRiderByLeastOrders } = require('../src/utils/riders');

function makeConn(queryImpl) {
  const conn = {
    query: typeof queryImpl === 'function' ? jest.fn(queryImpl) : jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  };
  if (Array.isArray(queryImpl)) {
    for (const v of queryImpl) {
      conn.query.mockResolvedValueOnce(v);
    }
  }
  return conn;
}

describe('selectRiderByLeastOrders (engine rule)', () => {
  it('picks least and random on ties', () => {
    expect(selectRiderByLeastOrders([
      { id: 1, completedToday: 3 },
      { id: 2, completedToday: 0 },
    ]).id).toBe(2);
    expect(selectRiderByLeastOrders(
      [{ id: 1, completedToday: 0 }, { id: 2, completedToday: 0 }],
      { random: () => 0 }
    ).id).toBe(1);
  });
});

const resetPool = () => {
  pool.query.mockReset();
  pool.getConnection.mockReset();
  jest.clearAllMocks();
};

describe('startAssignment', () => {
  beforeEach(resetPool);

  it('returns already_in_progress when status is offered', async () => {
    const conn = makeConn([
      [[{ id: 1, status: 'Accepted', rider_id: null, rider_assignment_status: 'offered' }]],
    ]);
    pool.getConnection.mockResolvedValue(conn);

    const result = await assignment.startAssignment(1);
    expect(result).toEqual(expect.objectContaining({
      started: false,
      reason: 'already_in_progress',
    }));
    expect(conn.rollback).toHaveBeenCalled();
  });

  it('waits (does not fail) when no eligible riders — search window open', async () => {
    const order = {
      id: 10,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'none',
      order_number: 'ORD-10',
      payment_method: 'Cash',
      customer_id: 5,
      coupon_id: null,
      customer_name: 'C',
      phone: '9',
      address: 'A',
      total: 100,
      created_at: null,
    };

    const startConn = makeConn([
      [[order]],
      [{ affectedRows: 1 }], // mark searching + search_started_at
    ]);
    pool.getConnection.mockResolvedValueOnce(startConn);

    // excluded, eligible empty — no failAssignment while window is open
    pool.query
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[]]); // eligible empty

    const result = await assignment.startAssignment(10);
    expect(result.started).toBe(true);
    expect(result.waiting).toBe(true);
    expect(result.reason).toBe('waiting_for_riders');
    expect(result.failed).toBeFalsy();
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });
});

describe('continueAssignment search window', () => {
  beforeEach(resetPool);

  it('stays waiting when no eligible and window still open', async () => {
    const order = {
      id: 10,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'searching',
      rider_search_started_at: new Date(),
      order_number: 'O',
    };
    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[]]) // excluded empty
      .mockResolvedValueOnce([[]]) // eligible empty
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]);

    const r = await assignment.continueAssignment(10);
    expect(r.continued).toBe(false);
    expect(r.waiting).toBe(true);
    expect(r.failed).toBe(false);
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('fails after search window expires with no riders', async () => {
    const order = {
      id: 10,
      area_id: 1,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'searching',
      order_number: 'ORD-10',
      payment_method: 'Cash',
      customer_id: 5,
      coupon_id: null,
      customer_name: 'C',
      phone: '9',
      address: 'A',
      total: 100,
      created_at: null,
    };
    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[]]) // eligible empty
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 0 }]]) // window closed
      // failAssignment
      .mockResolvedValueOnce([[order]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ ...order, rider_assignment_status: 'failed' }]])
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const r = await assignment.continueAssignment(10);
    expect(r.continued).toBe(false);
    expect(r.failed).toBe(true);
    expect(adminInbox.createAdminNotification).toHaveBeenCalled();
    const { emitToAdmins } = require('../src/realtime/socket');
    expect(emitToAdmins).toHaveBeenCalledWith(
      1,
      'admin.order.cancel_request',
      expect.objectContaining({ orderId: 10 })
    );
  });

  it('offers a rider who becomes eligible during the wait', async () => {
    const order = {
      id: 10,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'searching',
      order_number: 'O',
      customer_id: 5,
    };
    const rider = {
      id: 7, user_id: 70, display_name: 'R', phone: null,
      active: true, is_online: true, last_heartbeat_at: new Date(),
    };
    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[rider]]) // eligible
      .mockResolvedValueOnce([[]]) // getOrderPickupPoints (no shop pins)
      .mockResolvedValueOnce([[]]) // countCompletedDeliveriesTodayBatch (none delivered)
      .mockResolvedValueOnce([[]]) // countActiveOrdersBatch (carrying nothing)
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // markSearching

    const offerConn = makeConn([
      [[]], // no pending FOR UPDATE
      [[order]], // order FOR UPDATE
      [[{ e: new Date(Date.now() + 300000) }]], // expires_at
      [{ insertId: 55, affectedRows: 1 }], // insert offer
      [{ affectedRows: 1 }], // order offered
    ]);
    pool.getConnection.mockResolvedValueOnce(offerConn);

    const r = await assignment.continueAssignment(10);
    expect(r.continued).toBe(true);
    expect(r.riderId).toBe(7);
    expect(r.offer?.id).toBe(55);
  });
});

describe('pushRiderOffer FCM/Expo branching', () => {
  // Same fixture as 'offers a rider who becomes eligible during the wait' —
  // the simplest real path that reaches pushRiderOffer via continueAssignment.
  const order = {
    id: 10,
    status: 'Accepted',
    rider_id: null,
    rider_assignment_status: 'searching',
    order_number: 'O-10',
    customer_id: 5,
  };
  const rider = {
    id: 7, user_id: 70, display_name: 'R', phone: null,
    active: true, is_online: true, last_heartbeat_at: new Date(),
  };

  function queueOfferFixture() {
    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[rider]]) // eligible
      .mockResolvedValueOnce([[]]) // getOrderPickupPoints
      .mockResolvedValueOnce([[]]) // countCompletedDeliveriesTodayBatch
      .mockResolvedValueOnce([[]]) // countActiveOrdersBatch
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // markSearching

    const offerConn = makeConn([
      [[]], // no pending FOR UPDATE
      [[order]], // order FOR UPDATE
      [[{ e: new Date(Date.now() + 300000) }]], // expires_at
      [{ insertId: 55, affectedRows: 1 }], // insert offer
      [{ affectedRows: 1 }], // order offered
    ]);
    pool.getConnection.mockResolvedValueOnce(offerConn);
  }

  it('does not fall back to Expo when native FCM reports sent', async () => {
    const fcmAlarm = require('../src/utils/fcmAlarmPush');
    const expoPush = require('../src/utils/expoPush');
    fcmAlarm.sendFcmDataOnlyToUser.mockResolvedValueOnce({ sent: true });
    queueOfferFixture();

    await assignment.continueAssignment(10);

    expect(fcmAlarm.sendFcmDataOnlyToUser).toHaveBeenCalledWith(
      pool, 70, expect.objectContaining({ alertType: 'rider_offer_alarm', offerId: '55' })
    );
    expect(expoPush.sendPushToUser).not.toHaveBeenCalled();
  });

  it('falls back to Expo with the alarm channel/sound when FCM does not report sent', async () => {
    const fcmAlarm = require('../src/utils/fcmAlarmPush');
    const expoPush = require('../src/utils/expoPush');
    fcmAlarm.sendFcmDataOnlyToUser.mockResolvedValueOnce({ sent: false, reason: 'no_fcm_token' });
    queueOfferFixture();

    await assignment.continueAssignment(10);

    expect(expoPush.sendPushToUser).toHaveBeenCalledWith(
      pool, 70,
      expect.objectContaining({
        channelId: 'serveloco-rider-offers-alarm-v5',
        sound: 'rider_alarm',
        data: expect.objectContaining({ alertType: 'rider_offer_alarm' }),
      })
    );
  });
});

describe('acceptOffer', () => {
  beforeEach(resetPool);

  it('409 when offer not pending', async () => {
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'rejected', expires_at: new Date(Date.now() + 99999) }]],
    ]);
    pool.getConnection.mockResolvedValue(conn);
    const r = await assignment.acceptOffer(1, 3);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
  });

  it('forbidden when wrong rider', async () => {
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: new Date(Date.now() + 99999) }]],
    ]);
    pool.getConnection.mockResolvedValue(conn);
    const r = await assignment.acceptOffer(1, 99);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });

  it('assigns on success (including when rider already has other jobs)', async () => {
    const future = new Date(Date.now() + 300000);
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: future }]], // offer select
      [[{ is_expired: 0 }]], // expiry check (SQL-side)
      [[{ id: 10, status: 'Accepted', rider_id: null, customer_id: 5, order_number: 'O' }]], // order select
      [{ affectedRows: 1 }], // offer update
      [{ affectedRows: 1 }], // order update
    ]);
    pool.getConnection.mockResolvedValue(conn);
    pool.query
      .mockResolvedValueOnce([[{
        id: 10, status: 'Accepted', rider_id: 3, customer_id: 5, order_number: 'O',
        rider_assignment_status: 'assigned',
      }]]) // loadOrder after commit
      .mockResolvedValueOnce([[{ user_id: 9 }]]); // notify rider after accept

    const r = await assignment.acceptOffer(1, 3);
    expect(r.ok).toBe(true);
    expect(r.order.rider_id).toBe(3);
  });
});

describe('rejectOffer', () => {
  beforeEach(resetPool);

  it('rejects pending offer and fails assignment without cancelling order', async () => {
    const conn = makeConn([
      [[{ id: 1, order_id: 10, rider_id: 3, status: 'pending', expires_at: new Date(Date.now() + 99999) }]],
      [{ affectedRows: 1 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);

    // continueAssignment → loadOrder; no pending; excluded; eligible empty →
    // window still open → wait (no fail)
    const order = {
      id: 10, status: 'Accepted', rider_id: null, payment_method: 'Cash',
      customer_id: 1, coupon_id: null, order_number: 'O', rider_assignment_status: 'offered',
      customer_name: 'C', phone: '9', address: 'A', total: 1, created_at: null,
    };
    pool.query
      .mockResolvedValueOnce([[{ user_id: 9 }]]) // notify rider after reject
      .mockResolvedValueOnce([[order]]) // continue loadOrder
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[{ rider_id: 3 }]]) // excluded
      .mockResolvedValueOnce([[]]) // eligible empty
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]); // window open → wait

    const r = await assignment.rejectOffer(1, 3);
    expect(r.ok).toBe(true);
    expect(r.continued?.waiting).toBe(true);
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });
});

describe('expireOffer', () => {
  beforeEach(resetPool);

  it('returns expired false when CAS misses', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const r = await assignment.expireOffer(1);
    expect(r.expired).toBe(false);
  });

  it('expires and notifies rider then waits if window open', async () => {
    const order = {
      id: 10, status: 'Accepted', rider_id: null, payment_method: 'Cash',
      customer_id: 1, coupon_id: null, order_number: 'O',
      customer_name: 'C', phone: '9', address: 'A', total: 1, created_at: null,
    };
    pool.query
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // CAS expire
      .mockResolvedValueOnce([[{ order_id: 10, rider_id: 3 }]])
      .mockResolvedValueOnce([[{ user_id: 7 }]])
      .mockResolvedValueOnce([[order]]) // continue load
      .mockResolvedValueOnce([[]]) // pending
      .mockResolvedValueOnce([[{ rider_id: 3 }]])
      .mockResolvedValueOnce([[]]) // eligible
      // isWithinSearchWindow reads first; already stamped → no markSearching UPDATE
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]); // window open

    const r = await assignment.expireOffer(99);
    expect(r.expired).toBe(true);
    expect(emitToCustomer).toHaveBeenCalledWith(7, 'rider.offer.expired', expect.any(Object));
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });
});

describe('cancelAssignmentByRider', () => {
  beforeEach(resetPool);

  it('is always disallowed after product change', async () => {
    const r = await assignment.cancelAssignmentByRider(10, 3);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CANCEL_NOT_ALLOWED');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('maybeStartRiderAssignment', () => {
  beforeEach(resetPool);

  it('waits for all shops', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, status: 'Accepted', rider_id: null }]])
      .mockResolvedValueOnce([[
        { shop_id: 1, shop_confirmed_at: 'x', shop_rejected_at: null },
        { shop_id: 2, shop_confirmed_at: null, shop_rejected_at: null },
      ]]);
    const r = await assignment.maybeStartRiderAssignment(10);
    expect(r.started).toBe(false);
    expect(r.reason).toBe('waiting_shops');
  });

  it('returns no_shops for house-only order', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, status: 'Accepted', rider_id: null }]])
      .mockResolvedValueOnce([[
        { shop_id: null, shop_confirmed_at: null, shop_rejected_at: null },
      ]]);
    const r = await assignment.maybeStartRiderAssignment(10);
    expect(r.reason).toBe('no_shops');
  });
});

describe('getExcludedRiderIdsForOrder', () => {
  beforeEach(resetPool);

  it('lists rider ids with any offer row', async () => {
    pool.query.mockResolvedValueOnce([[{ rider_id: 1 }, { rider_id: 2 }]]);
    await expect(assignment.getExcludedRiderIdsForOrder(10)).resolves.toEqual([1, 2]);
  });
});

describe('recoverStuckAssignments', () => {
  beforeEach(resetPool);

  it('returns [] without querying rider count when nothing is waiting', async () => {
    pool.query.mockResolvedValueOnce([[]]); // stuck-orders SELECT
    await expect(assignment.recoverStuckAssignments()).resolves.toEqual([]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('re-scans normally via continueAssignment when riders are online', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]]) // stuck-orders SELECT
      .mockResolvedValueOnce([[{ cnt: 1 }]]) // countActiveRiders — someone online
      // continueAssignment(10): loadOrder, pending check, excluded, eligible
      .mockResolvedValueOnce([[{ id: 10, status: 'Accepted', rider_id: null }]])
      .mockResolvedValueOnce([[]]) // no pending
      .mockResolvedValueOnce([[]]) // excluded
      .mockResolvedValueOnce([[]]) // eligible — none, so it waits
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]); // isWithinSearchWindow

    const [result] = await assignment.recoverStuckAssignments();
    expect(result.continued).toBe(false);
    expect(result.waiting).toBe(true);
  });

  it('skips the eligible-riders re-scan and only checks the window when nobody is online', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]]) // stuck-orders SELECT
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // countActiveRiders — nobody online
      .mockResolvedValueOnce([[{ rider_id: 4 }]]) // getExcludedRiderIdsForOrder
      // isWithinSearchWindow: stamped + still open
      .mockResolvedValueOnce([[{ stamped: 1, open: 1 }]]);

    const [result] = await assignment.recoverStuckAssignments();
    expect(result.continued).toBe(false);
    expect(result.waiting).toBe(true);
    // The expensive listEligibleRiders JOIN must not run in this branch.
    expect(pool.query).toHaveBeenCalledTimes(4);
  });

  it('still fails the order past its window with zero riders online', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10 }]]) // stuck-orders SELECT
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // countActiveRiders
      .mockResolvedValueOnce([[]]) // getExcludedRiderIdsForOrder — none ever offered
      .mockResolvedValueOnce([[{ stamped: 1, open: 0 }]]) // isWithinSearchWindow — expired
      // failAssignment: loadOrder, UPDATE orders, UPDATE offers, loadOrder (updated)
      .mockResolvedValueOnce([[{ id: 10, status: 'Accepted', rider_id: null, order_number: 'O-10' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ id: 10, status: 'Accepted', rider_id: null, order_number: 'O-10', rider_assignment_status: 'failed' }]])
      .mockResolvedValueOnce([[{ cnt: 0 }]]); // syncDeliveryAvailabilityFromRiders

    const [result] = await assignment.recoverStuckAssignments();
    expect(result.continued).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.reason).toBe('No riders available');
  });
});

describe('getOrderPickupPoints', () => {
  beforeEach(resetPool);

  it('returns a ring centre per pinned shop on a multi-shop order', async () => {
    pool.query.mockResolvedValueOnce([[
      { latitude: '12.9700000', longitude: '77.6000000' },
      { latitude: '12.9800000', longitude: '77.6100000' },
    ]]);
    await expect(assignment.getOrderPickupPoints(10)).resolves.toEqual([
      { lat: 12.97, lng: 77.6 },
      { lat: 12.98, lng: 77.61 },
    ]);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('s.latitude IS NOT NULL');
  });

  it('returns [] for a house-only order so selection stays distance-blind', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(assignment.getOrderPickupPoints(10)).resolves.toEqual([]);
  });

  it('drops unusable pins instead of placing a ring at 0,0', async () => {
    pool.query.mockResolvedValueOnce([[
      { latitude: null, longitude: null },
      { latitude: '12.9700000', longitude: '77.6000000' },
    ]]);
    await expect(assignment.getOrderPickupPoints(10)).resolves.toEqual([
      { lat: 12.97, lng: 77.6 },
    ]);
  });

  it('degrades to distance-blind rather than throwing when the lookup fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(assignment.getOrderPickupPoints(10)).resolves.toEqual([]);
  });
});

describe('revokeOffersForOrder', () => {
  beforeEach(resetPool);

  it('emits revoked for pending riders', async () => {
    pool.query
      .mockResolvedValueOnce([[{ offer_id: 5, rider_id: 3, user_id: 7 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    await assignment.revokeOffersForOrder(10);
    expect(emitToCustomer).toHaveBeenCalledWith(7, 'rider.offer.revoked', expect.objectContaining({
      offerId: 5,
      orderId: 10,
    }));
  });
});
