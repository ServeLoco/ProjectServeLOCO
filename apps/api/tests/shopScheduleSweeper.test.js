/**
 * Shop auto-open/auto-close sweeper.
 *
 * Two things this guards, both of which silently misfire in production
 * otherwise: the wall clock must be read in the schedule's own timezone (the
 * API container runs on UTC), and a close blocked by an in-flight order must
 * still happen once that order clears — the exact close minute is long gone
 * by then.
 */

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../src/realtime/socket', () => ({
  emitToAllCustomers: jest.fn(),
  emitToAdmins: jest.fn(),
}));

jest.mock('../src/utils/shops', () => ({
  syncGlobalShopOpenState: jest.fn().mockResolvedValue(undefined),
}));

const { pool } = require('../src/db/mysql');
const {
  tick,
  currentHHMM,
  pendingCloses,
  stopShopScheduleSweeper,
} = require('../src/realtime/shopScheduleSweeper');

// Every tick issues: the open-boundary SELECT, the close SELECT, then one
// active-order COUNT per shop due to close, then the UPDATE + follow-up
// SELECT inside applyScheduledChange.
const queueQueries = (responses) => {
  pool.query.mockReset();
  let i = 0;
  pool.query.mockImplementation(() => {
    const next = responses[i] !== undefined ? responses[i] : [[]];
    i += 1;
    return Promise.resolve(next);
  });
};

const noneToOpen = [[]];
const dueToClose = (ids) => [ids.map((id) => ({ id }))];
const activeOrderCount = (cnt) => [[{ cnt }]];
const shopRow = (id) => [[{ id, active: 1 }]];

describe('currentHHMM', () => {
  afterEach(() => {
    delete process.env.TZ;
  });

  it('reads the clock in Asia/Kolkata, not the server timezone', () => {
    // 12:00 UTC is 17:30 IST. A server-local read on a UTC container would
    // return "12:00" and fire every schedule 5h30m early.
    const noonUtc = new Date('2026-07-31T12:00:00Z');
    expect(currentHHMM(noonUtc)).toBe('17:30');
  });

  it('formats midnight IST as 00:00, never 24:00', () => {
    const midnightIst = new Date('2026-07-31T18:30:00Z');
    expect(currentHHMM(midnightIst)).toBe('00:00');
  });
});

describe('shop schedule sweeper close retry', () => {
  beforeEach(() => {
    stopShopScheduleSweeper(); // clears pendingCloses between tests
    jest.clearAllMocks();
  });

  it('queues a blocked close and retries it after the close minute passes', async () => {
    // Tick 1 — shop 7 is due to close but is still preparing an order.
    queueQueries([noneToOpen, dueToClose([7]), activeOrderCount(1)]);
    await tick();
    expect(pendingCloses.has(7)).toBe(true);

    // Tick 2 — the close minute has passed, so the boundary no longer
    // matches; shop 7 comes back only because it is queued. Order cleared.
    queueQueries([noneToOpen, dueToClose([7]), activeOrderCount(0), [{}], shopRow(7)]);
    await tick();

    const update = pool.query.mock.calls.find(([sql]) => /UPDATE shops SET is_open/.test(sql));
    expect(update).toBeDefined();
    expect(update[1]).toEqual([0, 7]);
    expect(pendingCloses.has(7)).toBe(false);
  });

  it('includes queued shop ids in the close query once the boundary passes', async () => {
    queueQueries([noneToOpen, dueToClose([7]), activeOrderCount(1)]);
    await tick();

    queueQueries([noneToOpen, dueToClose([]), activeOrderCount(0)]);
    await tick();

    const closeQuery = pool.query.mock.calls.find(([sql]) => /close_time IS NOT NULL/.test(sql));
    expect(closeQuery[0]).toMatch(/id IN \(\?\)/);
    expect(closeQuery[1]).toContain(7);
  });

  it('drops a queued close when the shop closed by some other route', async () => {
    queueQueries([noneToOpen, dueToClose([7]), activeOrderCount(1)]);
    await tick();
    expect(pendingCloses.has(7)).toBe(true);

    // Shop no longer matches (is_open = 0 already) — nothing left to retry.
    queueQueries([noneToOpen, dueToClose([])]);
    await tick();
    expect(pendingCloses.has(7)).toBe(false);
  });

  it('cancels a queued close when the shop reaches its next open boundary', async () => {
    queueQueries([noneToOpen, dueToClose([7]), activeOrderCount(1)]);
    await tick();
    expect(pendingCloses.has(7)).toBe(true);

    // Next morning: shop 7 hits open_time. The stale close must not fire.
    queueQueries([[[{ id: 7 }]], [{}], shopRow(7), dueToClose([])]);
    await tick();
    expect(pendingCloses.has(7)).toBe(false);
  });
});
