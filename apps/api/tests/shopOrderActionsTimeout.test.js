/**
 * rejectShopOrder's source param (owner vs shopAlertSweeper timeout) —
 * verifies the admin-notification copy differs so the inbox can tell a real
 * owner rejection apart from an auto-reject after 10 minutes of silence,
 * and that the DB writes / customer-visible behavior are otherwise identical.
 */

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../src/utils/shops', () => ({
  maybeAutoCancelOrderWhenAllShopsRejected: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
}));

jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue({ insertId: 1 }),
}));

jest.mock('../src/realtime/orderEvents', () => ({
  emitNotificationCreated: jest.fn(),
  emitOrderStatusUpdated: jest.fn(),
}));

jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: { SHOP_REJECTED: 'shop_rejected' },
  createAdminNotification: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../src/services/riderAssignment', () => ({
  maybeStartRiderAssignment: jest.fn().mockResolvedValue({ started: false }),
}));

const { pool } = require('../src/db/mysql');
const adminInbox = require('../src/utils/adminNotifications');
const { maybeStartRiderAssignment } = require('../src/services/riderAssignment');
const { rejectShopOrder } = require('../src/services/shopOrderActions');

const queueRejectCalls = () => {
  pool.query.mockReset();
  pool.query
    .mockResolvedValueOnce([[{ cnt: 1, area_id: 7 }]]) // guard SELECT
    .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE shop_rejected_at
    .mockResolvedValueOnce([[{ owner_user_id: 999 }]]); // notifyShopOwnerOrderUpdated lookup
};

describe('rejectShopOrder source copy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to owner-rejected copy when source is omitted (existing shop/admin routes)', async () => {
    queueRejectCalls();

    const result = await rejectShopOrder(1, 50, { shopName: 'Burger Point' });

    expect(result.ok).toBe(true);
    expect(adminInbox.createAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Burger Point can't fulfill order #50",
        body: expect.stringContaining('rejected their items'),
      })
    );
  });

  it('uses timeout copy when the sweeper auto-rejects on the shop\'s behalf', async () => {
    queueRejectCalls();

    const result = await rejectShopOrder(1, 51, { shopName: 'Tea Stall', source: 'timeout' });

    expect(result.ok).toBe(true);
    expect(adminInbox.createAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tea Stall did not respond to order #51',
        body: expect.stringContaining('auto-rejected on their behalf'),
      })
    );
  });

  it('still writes shop_rejected_at the same way regardless of source', async () => {
    queueRejectCalls();

    await rejectShopOrder(1, 52, { shopName: 'X', source: 'timeout' });

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE order_items SET shop_rejected_at = NOW() WHERE order_id = ? AND shop_id = ? AND shop_rejected_at IS NULL',
      [52, 1]
    );
  });

  // A reject can be the LAST decision on a multi-shop order whose other shops
  // already confirmed. Without this re-drive the order stalls forever at
  // rider_assignment_status = 'none': auto-cancel only fires when EVERY shop
  // rejected, and recoverStuckAssignments only re-scans 'searching'/'offered'.
  it('re-drives rider assignment after a reject, in case it was the last shop to decide', async () => {
    queueRejectCalls();

    await rejectShopOrder(1, 53, { shopName: 'X' });

    expect(maybeStartRiderAssignment).toHaveBeenCalledWith(53);
  });

  it('does not fail the reject when the assignment re-drive throws', async () => {
    queueRejectCalls();
    maybeStartRiderAssignment.mockRejectedValueOnce(new Error('engine down'));

    const result = await rejectShopOrder(1, 54, { shopName: 'X' });

    expect(result.ok).toBe(true);
  });
});
