/**
 * Weak-network shop-alert retries + no-response auto-reject.
 *
 * remindPendingShopOrders re-pushes the alarm to a shop that hasn't
 * confirmed/rejected yet, throttled so a flaky connection gets caught by a
 * later retry instead of only ever getting the one initial push.
 * timeoutRejectStaleShopOrders auto-rejects a shop's items once it has been
 * silent past SHOP_RESPONSE_TIMEOUT_MS, and alerts admins when that reject
 * does NOT resolve the order on its own (another shop is still active).
 */

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../src/utils/shops', () => ({
  remindShopOrderOwner: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/shopOrderActions', () => ({
  rejectShopOrder: jest.fn(),
}));

jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: {
    SHOP_TIMEOUT_PARTIAL: 'shop_timeout_partial',
  },
  createAdminNotification: jest.fn().mockResolvedValue({ id: 1 }),
}));

const { pool } = require('../src/db/mysql');
const { remindShopOrderOwner } = require('../src/utils/shops');
const { rejectShopOrder } = require('../src/services/shopOrderActions');
const adminInbox = require('../src/utils/adminNotifications');
const {
  remindPendingShopOrders,
  timeoutRejectStaleShopOrders,
  SHOP_ALERT_REMIND_MS,
  SHOP_ALERT_REMIND_ACKED_MS,
  SHOP_RESPONSE_TIMEOUT_MS,
} = require('../src/realtime/shopAlertSweeper');

describe('remindPendingShopOrders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // mockClear() (what clearAllMocks/clearMocks:true do) does not drain
    // queued mockResolvedValueOnce values — mockReset() does. Without this,
    // a test that skips an expected query call (e.g. the empty-rows case)
    // leaks its unconsumed queued value into the next test's calls.
    pool.query.mockReset();
  });

  // All elapsed-time filtering (still within the response window, due for a
  // reminder) happens in the SELECT's WHERE/HAVING now, not by parsing
  // accepted_at/shop_last_notified_at into a JS Date and comparing against
  // Date.now() — a real DB only ever returns rows that already passed those
  // conditions, so these tests assert the SQL text/params carry the correct
  // thresholds rather than feeding rows that "shouldn't" pass and checking
  // the JS side filters them back out (it no longer does, by design — see
  // shopAlertSweeper.js's comment on why mixing a server clock with a
  // driver-parsed client clock silently broke this pass before).

  it('claims a row (compare-and-set) before pushing, then reminds it', async () => {
    pool.query.mockResolvedValueOnce([[{
      order_id: 10, shop_id: 1, order_number: 'ORD-10', owner_user_id: 501, shop_name: 'Burger Point',
      last_notified_at: null,
    }]]);
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // claim UPDATE

    await remindPendingShopOrders();

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/UPDATE order_items SET shop_last_notified_at = NOW/),
      [10, 1, null]
    );
    // The push must happen only after the claim UPDATE resolves — asserted
    // via call order, not just "both happened".
    expect(pool.query.mock.invocationCallOrder[1]).toBeLessThan(
      remindShopOrderOwner.mock.invocationCallOrder[0]
    );
    expect(remindShopOrderOwner).toHaveBeenCalledWith(
      { id: 10, order_number: 'ORD-10' },
      1,
      501
    );
  });

  it('does not push when the claim UPDATE affects no rows (another instance already claimed it)', async () => {
    // Concurrent sweeper on a second API instance (module header: "safe
    // across... multiple API instances") claimed this row between our
    // SELECT and our UPDATE — the CAS's shop_last_notified_at <=> ? no
    // longer matches, affectedRows is 0. Must not ring the shop twice.
    pool.query.mockResolvedValueOnce([[{
      order_id: 11, shop_id: 2, order_number: 'ORD-11', owner_user_id: 502, shop_name: 'Tea Stall',
      last_notified_at: null,
    }]]);
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // lost the race

    await remindPendingShopOrders();

    expect(remindShopOrderOwner).not.toHaveBeenCalled();
  });

  it('CASes against the last_notified_at value the SELECT actually saw', async () => {
    const lastNotifiedAt = new Date('2026-08-18T10:00:00Z');
    pool.query.mockResolvedValueOnce([[{
      order_id: 12, shop_id: 3, order_number: 'ORD-12', owner_user_id: 503, shop_name: 'Grocer',
      last_notified_at: lastNotifiedAt,
    }]]);
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    await remindPendingShopOrders();

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [12, 3, lastNotifiedAt]
    );
  });

  it('does nothing when the query returns no due rows', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await remindPendingShopOrders();

    expect(remindShopOrderOwner).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // only the SELECT
  });

  it('scopes the SELECT to active, unconfirmed/unrejected items within the response window, due for a reminder', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await remindPendingShopOrders();

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('Accepted', 'Preparing'\)/);
    expect(sql).toMatch(/shop_confirmed_at IS NULL/);
    expect(sql).toMatch(/shop_rejected_at IS NULL/);
    expect(sql).toMatch(/o\.accepted_at > \(NOW\(\) - INTERVAL \? SECOND\)/);
    expect(sql).toMatch(/HAVING MIN\(oi\.shop_last_notified_at\) IS NULL/);
    expect(sql).toMatch(/CASE WHEN MIN\(oi\.shop_alert_acked_at\) IS NULL THEN \? ELSE \? END/);
    expect(params).toEqual([
      Math.ceil(SHOP_RESPONSE_TIMEOUT_MS / 1000),
      Math.ceil(SHOP_ALERT_REMIND_MS / 1000),
      Math.ceil(SHOP_ALERT_REMIND_ACKED_MS / 1000),
    ]);
  });

  it('reminds each shop independently on a multi-shop order', async () => {
    pool.query.mockResolvedValueOnce([[
      { order_id: 20, shop_id: 1, order_number: 'ORD-20', owner_user_id: 601, shop_name: 'Shop A', last_notified_at: null },
      { order_id: 20, shop_id: 2, order_number: 'ORD-20', owner_user_id: 602, shop_name: 'Shop B', last_notified_at: null },
    ]]);
    pool.query.mockResolvedValue([{ affectedRows: 1 }]);

    await remindPendingShopOrders();

    expect(remindShopOrderOwner).toHaveBeenCalledTimes(2);
    expect(remindShopOrderOwner).toHaveBeenCalledWith(expect.anything(), 1, 601);
    expect(remindShopOrderOwner).toHaveBeenCalledWith(expect.anything(), 2, 602);
  });

  it('continues to the next row when one claim throws and when one push fails', async () => {
    pool.query.mockResolvedValueOnce([[
      { order_id: 21, shop_id: 1, order_number: 'ORD-21', owner_user_id: 701, shop_name: 'Bad Claim Shop', last_notified_at: null },
      { order_id: 22, shop_id: 2, order_number: 'ORD-22', owner_user_id: 702, shop_name: 'Bad Push Shop', last_notified_at: null },
      { order_id: 23, shop_id: 3, order_number: 'ORD-23', owner_user_id: 703, shop_name: 'Good Shop', last_notified_at: null },
    ]]);
    pool.query.mockRejectedValueOnce(new Error('db blip')); // row 21's claim throws
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // row 22's claim succeeds
    remindShopOrderOwner.mockRejectedValueOnce(new Error('push failed')); // row 22's push fails
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // row 23's claim succeeds

    await remindPendingShopOrders();

    // Row 21 never reached remindShopOrderOwner (claim threw first); row 22
    // did but rejected; row 23 succeeded — net one successful reminder.
    expect(remindShopOrderOwner).toHaveBeenCalledTimes(2);
    expect(remindShopOrderOwner).toHaveBeenCalledWith(expect.anything(), 3, 703);
  });
});

describe('timeoutRejectStaleShopOrders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it('does nothing when no shop has timed out', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await timeoutRejectStaleShopOrders();

    expect(rejectShopOrder).not.toHaveBeenCalled();
  });

  it('auto-rejects a timed-out shop with source: timeout', async () => {
    pool.query.mockResolvedValueOnce([[{
      order_id: 30, shop_id: 1, order_number: 'ORD-30', area_id: 1, shop_name: 'Burger Point',
    }]]);
    rejectShopOrder.mockResolvedValueOnce({ ok: true, message: 'Order rejected' });
    // Order auto-cancelled by the reject cascade (single-shop order).
    pool.query.mockResolvedValueOnce([[{ status: 'Cancelled' }]]);

    await timeoutRejectStaleShopOrders();

    expect(rejectShopOrder).toHaveBeenCalledWith(1, 30, { shopName: 'Burger Point', source: 'timeout' });
  });

  it('does not raise an admin alert when the timeout-reject auto-cancelled the order', async () => {
    pool.query.mockResolvedValueOnce([[{
      order_id: 31, shop_id: 1, order_number: 'ORD-31', area_id: 1, shop_name: 'Solo Shop',
    }]]);
    rejectShopOrder.mockResolvedValueOnce({ ok: true, message: 'Order rejected' });
    pool.query.mockResolvedValueOnce([[{ status: 'Cancelled' }]]);

    await timeoutRejectStaleShopOrders();

    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('raises SHOP_TIMEOUT_PARTIAL when the order survives (another shop still active)', async () => {
    pool.query.mockResolvedValueOnce([[{
      order_id: 32, shop_id: 2, order_number: 'ORD-32', area_id: 3, shop_name: 'Slow Shop',
    }]]);
    rejectShopOrder.mockResolvedValueOnce({ ok: true, message: 'Order rejected' });
    pool.query.mockResolvedValueOnce([[{ status: 'Preparing' }]]);

    await timeoutRejectStaleShopOrders();

    expect(adminInbox.createAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'shop_timeout_partial',
        relatedId: '32-2',
        areaId: 3,
      })
    );
  });

  it('skips the admin alert when rejectShopOrder no-ops (already resolved by a race)', async () => {
    pool.query.mockResolvedValueOnce([[{
      order_id: 33, shop_id: 1, order_number: 'ORD-33', area_id: 1, shop_name: 'Raced Shop',
    }]]);
    rejectShopOrder.mockResolvedValueOnce({ ok: false, status: 404, code: 'NOT_FOUND' });

    await timeoutRejectStaleShopOrders();

    // Only the SELECT ran — no status re-check, no admin notification.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('scopes the SELECT to Accepted/Preparing orders past the timeout window with no shop response', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await timeoutRejectStaleShopOrders();

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status IN \('Accepted', 'Preparing'\)/);
    expect(sql).toMatch(/shop_confirmed_at IS NULL/);
    expect(sql).toMatch(/shop_rejected_at IS NULL/);
    expect(sql).toMatch(/accepted_at <= \(NOW\(\) - INTERVAL \? SECOND\)/);
    expect(params).toEqual([Math.ceil(SHOP_RESPONSE_TIMEOUT_MS / 1000)]);
  });

  it('continues to the next row when one shop fails', async () => {
    pool.query.mockResolvedValueOnce([[
      { order_id: 40, shop_id: 1, order_number: 'ORD-40', area_id: 1, shop_name: 'Bad Shop' },
      { order_id: 41, shop_id: 2, order_number: 'ORD-41', area_id: 1, shop_name: 'Good Shop' },
    ]]);
    rejectShopOrder.mockRejectedValueOnce(new Error('db blip'));
    rejectShopOrder.mockResolvedValueOnce({ ok: true, message: 'Order rejected' });
    pool.query.mockResolvedValueOnce([[{ status: 'Cancelled' }]]);

    await timeoutRejectStaleShopOrders();

    expect(rejectShopOrder).toHaveBeenCalledTimes(2);
  });
});
