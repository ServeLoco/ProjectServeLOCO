/**
 * TASK 17 — resolveAreaIdForSocketUser (src/realtime/socket.js), the
 * users.last_area_id -> default-area fallback used to stamp a customer
 * socket's presence entry + analytics session with an areaId (H7: no pin
 * exists at the socket layer, same §4.2/§9.5 chain as everywhere else).
 * Its one real call site is guarded to skip in NODE_ENV=test (see
 * realtime.test.js, which exercises real socket.io connections without a
 * db/mysql mock) — this file tests the function directly instead.
 */
jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../src/utils/areaScope', () => ({
  getDefaultArea: jest.fn(),
}));

const { pool } = require('../src/db/mysql');
const { getDefaultArea } = require('../src/utils/areaScope');
const { resolveAreaIdForSocketUser } = require('../src/realtime/socket');

describe('resolveAreaIdForSocketUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the user's last_area_id when set", async () => {
    pool.query.mockResolvedValueOnce([[{ last_area_id: 2 }]]);
    const areaId = await resolveAreaIdForSocketUser(42);
    expect(areaId).toBe(2);
    expect(getDefaultArea).not.toHaveBeenCalled();
  });

  it('falls back to the default area when last_area_id is null', async () => {
    pool.query.mockResolvedValueOnce([[{ last_area_id: null }]]);
    getDefaultArea.mockResolvedValueOnce({ id: 1, code: 'A1', is_default: 1 });
    const areaId = await resolveAreaIdForSocketUser(42);
    expect(areaId).toBe(1);
  });

  it('falls back to the default area when the user row is missing', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    getDefaultArea.mockResolvedValueOnce({ id: 1 });
    const areaId = await resolveAreaIdForSocketUser(999);
    expect(areaId).toBe(1);
  });

  it('returns null when even the default-area lookup fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    getDefaultArea.mockResolvedValueOnce(null);
    const areaId = await resolveAreaIdForSocketUser(42);
    expect(areaId).toBeNull();
  });

  it('never throws when both lookups fail', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    getDefaultArea.mockRejectedValueOnce(new Error('also down'));
    await expect(resolveAreaIdForSocketUser(42)).resolves.toBeNull();
  });
});
