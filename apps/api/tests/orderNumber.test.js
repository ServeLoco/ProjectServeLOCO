// TASK 3 — race-safe order numbers: generateOrderNumber must use the
// INSERT ... ON DUPLICATE KEY UPDATE / LAST_INSERT_ID() pattern (no more
// COUNT(*)+1) and produce consecutive, distinct numbers.
//
// The TEST shortcut inside generateOrderNumber is bypassed by temporarily
// unsetting NODE_ENV=test / JEST_WORKER_ID so the real SQL path executes
// against a mock connection.

jest.mock('../src/db/mysql', () => ({ pool: { query: jest.fn(), getConnection: jest.fn() } }));
jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/realtime/orderEvents', () => ({
  emitNotificationCreated: jest.fn(),
  emitOrderCancelled: jest.fn(),
  emitOrderStatusUpdated: jest.fn(),
  emitOrderPaymentUpdated: jest.fn(),
}));
jest.mock('../src/utils/adminNotifications', () => ({
  createAdminNotification: jest.fn(),
  TYPES: {},
}));
jest.mock('../src/realtime/orderAutoAccept', () => ({ cancel: jest.fn(), schedule: jest.fn() }));
jest.mock('../src/utils/money', () => ({ roundMoney: jest.fn(x => x), toMoney: jest.fn(x => x) }));
jest.mock('../src/utils/nightDelivery', () => ({
  calculateNightCharge: jest.fn(() => 0),
  isCodBlockedDuringNight: jest.fn(() => false),
}));
jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn(),
  validateCouponById: jest.fn(),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
}));

const { generateOrderNumber } = require('../src/controllers/orderController');

describe('Race-safe order numbers (TASK 3)', () => {
  let savedNodeEnv;
  let savedWorkerId;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedWorkerId = process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'development';
    delete process.env.JEST_WORKER_ID;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedWorkerId !== undefined) process.env.JEST_WORKER_ID = savedWorkerId;
    else delete process.env.JEST_WORKER_ID;
  });

  it('returns consecutive, distinct order numbers for two sequential calls', async () => {
    let lastInsertId = 0;
    const mockConnection = {
      query: jest.fn(async (sql) => {
        if (/INSERT INTO daily_order_counters/i.test(sql)) {
          lastInsertId += 1;
          return [{ affectedRows: 1 }];
        }
        if (/SELECT LAST_INSERT_ID/i.test(sql)) {
          return [[{ seq: lastInsertId }]];
        }
        return [[]];
      }),
    };

    const num1 = await generateOrderNumber(mockConnection, 1, 'A1');
    const num2 = await generateOrderNumber(mockConnection, 1, 'A1');

    // Format is OD-YYYYMMDD-AREACODE-NNNN (TASK 13, §6.3) — the extra
    // segment makes collision with the legacy OD-YYYYMMDD-NNNN structurally
    // impossible.
    expect(num1).toMatch(/^OD-\d{8}-A1-\d{4}$/);
    expect(num2).toMatch(/^OD-\d{8}-A1-\d{4}$/);
    expect(num1).not.toEqual(num2);

    // Sequence numbers must be consecutive
    const seq1 = parseInt(num1.slice(-4), 10);
    const seq2 = parseInt(num2.slice(-4), 10);
    expect(seq2).toEqual(seq1 + 1);
  });

  it('uses the INSERT ... ON DUPLICATE KEY UPDATE / LAST_INSERT_ID pattern (no COUNT FOR UPDATE)', async () => {
    const mockConnection = {
      query: jest.fn().mockResolvedValue([[{ seq: 1 }]]),
    };

    await generateOrderNumber(mockConnection, 1, 'A1');

    const calls = mockConnection.query.mock.calls.map(c => String(c[0]));
    expect(calls.some(sql => /INSERT INTO daily_order_counters.*ON DUPLICATE KEY UPDATE/i.test(sql))).toBe(true);
    expect(calls.some(sql => /SELECT LAST_INSERT_ID/i.test(sql))).toBe(true);
    // The old race-prone COUNT(*) ... FOR UPDATE query must be gone.
    expect(calls.some(sql => /COUNT\(\*\).*FOR UPDATE/i.test(sql))).toBe(false);
  });
});
