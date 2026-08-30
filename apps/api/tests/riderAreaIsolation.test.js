/**
 * TASK 15.8 — proves an order never offers to a rider outside its own area.
 *
 * No real area 2 exists yet in this rollout (same §6.6 gate noted in
 * dashboardAreaIsolation.test.js), so this proves isolation the same way:
 * driving the real continueAssignment/listEligibleRiders code path with a
 * synthetic area-2 order and asserting the actual SQL/params sent to MySQL
 * carry area_id = 2, never area 1 — not just that the mocked response
 * happens to look right. Live-verified separately against real MySQL with
 * a temp area/rider pair (see TASK 15 checklist notes).
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

const resetPool = () => {
  pool.query.mockReset();
  pool.getConnection.mockReset();
  jest.clearAllMocks();
};

describe('Rider assignment area isolation (TASK 15.8)', () => {
  beforeEach(resetPool);

  it('an area 2 order queries listEligibleRiders with area_id = 2, never area 1', async () => {
    const order = {
      id: 20,
      area_id: 2,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'searching',
      order_number: 'OD-A2-1',
      customer_id: 9,
    };
    const area2Rider = {
      id: 77, user_id: 770, display_name: 'Area 2 Rider', phone: null,
      active: true, is_online: true, last_heartbeat_at: new Date(),
    };

    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending offer
      .mockResolvedValueOnce([[]]) // excluded rider ids
      .mockResolvedValueOnce([[area2Rider]]) // listEligibleRiders — only area 2 riders returned
      .mockResolvedValueOnce([[]]) // getOrderPickupPoints (no shop pins)
      .mockResolvedValueOnce([[]]) // countCompletedDeliveriesTodayBatch
      .mockResolvedValueOnce([[]]) // countActiveOrdersBatch
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // markSearching

    const offerConn = makeConn([
      [[order]], // order FOR UPDATE
      [[{ e: new Date(Date.now() + 300000) }]], // expires_at
      [{ insertId: 501, affectedRows: 1 }], // insert offer
      [{ affectedRows: 1 }], // order offered
    ]);
    pool.getConnection.mockResolvedValueOnce(offerConn);

    const r = await assignment.continueAssignment(20);

    expect(r.continued).toBe(true);
    expect(r.riderId).toBe(77);

    // The listEligibleRiders call is the 4th real pool.query — its SQL
    // filters on r.area_id and the bound area value must be the order's
    // OWN area (2), never a hardcoded/default area 1.
    const [eligibleSql, eligibleParams] = pool.query.mock.calls[3];
    expect(eligibleSql).toContain('r.area_id = ?');
    expect(eligibleParams).toContain(2);
    expect(eligibleParams).not.toContain(1);
  });

  it('an area 1 order queries listEligibleRiders with area_id = 1, never area 2', async () => {
    const order = {
      id: 21,
      area_id: 1,
      status: 'Accepted',
      rider_id: null,
      rider_assignment_status: 'searching',
      order_number: 'OD-A1-1',
      customer_id: 5,
    };
    const area1Rider = {
      id: 3, user_id: 30, display_name: 'Area 1 Rider', phone: null,
      active: true, is_online: true, last_heartbeat_at: new Date(),
    };

    pool.query
      .mockResolvedValueOnce([[order]]) // loadOrder
      .mockResolvedValueOnce([[]]) // no pending offer
      .mockResolvedValueOnce([[]]) // excluded rider ids
      .mockResolvedValueOnce([[area1Rider]]) // listEligibleRiders — only area 1 riders returned
      .mockResolvedValueOnce([[]]) // getOrderPickupPoints
      .mockResolvedValueOnce([[]]) // countCompletedDeliveriesTodayBatch
      .mockResolvedValueOnce([[]]) // countActiveOrdersBatch
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // markSearching

    const offerConn = makeConn([
      [[order]],
      [[{ e: new Date(Date.now() + 300000) }]],
      [{ insertId: 502, affectedRows: 1 }],
      [{ affectedRows: 1 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(offerConn);

    const r = await assignment.continueAssignment(21);

    expect(r.continued).toBe(true);
    expect(r.riderId).toBe(3);

    const [eligibleSql, eligibleParams] = pool.query.mock.calls[3];
    expect(eligibleSql).toContain('r.area_id = ?');
    // Param order: [locationMaxAge, areaId, maxActiveOrdersCap, ...excludeIds] —
    // index into the areaId slot rather than a blanket "not contain 2", since
    // the active-orders cap value can itself legitimately be 2.
    expect(eligibleParams[1]).toBe(1);
  });
});
