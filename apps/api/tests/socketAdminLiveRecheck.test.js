/**
 * Bug fix (multi-area audit finding #4): authenticateSocket (src/realtime/
 * socket.js) mirrored requireAdmin's admin_auth_state revocation check but
 * not its live re-check against the `admins` table. A deactivated or
 * reassigned admin who was already connected (or who connects with a
 * still-valid JWT before their next HTTP request re-validates) kept
 * receiving that OTHER area's live order broadcasts — customer name,
 * phone, address — for the rest of the socket's life, up to
 * ADMIN_JWT_EXPIRES_IN (12h).
 *
 * Same NODE_ENV!=='test' gate as the pre-existing revocation check, so this
 * needs a non-'test' NODE_ENV to exercise at all — 'staging' avoids both
 * the jest default skip and config/env.js's production-only validation.
 */
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'staging';

const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../src/db/mysql');
const { authenticateSocket } = require('../src/realtime/socket');

const JWT_SECRET = process.env.JWT_SECRET;

const fakeSocket = (token) => ({
  handshake: { auth: { token }, headers: {} },
  data: {},
});

describe('authenticateSocket — live re-check against admins table', () => {
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('rejects the connection for a deactivated admin even with a still-valid JWT', async () => {
    const token = jwt.sign({ sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state — no revocation
      .mockResolvedValueOnce([[{ role: 'area_admin', area_id: 1, active: 0 }]]); // deactivated

    const next = jest.fn();
    await authenticateSocket(fakeSocket(token), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('AUTH_TOKEN_INVALID');
  });

  it("connects with the live role/area, not the JWT's stale claim, after a reassignment", async () => {
    const token = jwt.sign({ sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state
      .mockResolvedValueOnce([[{ role: 'area_admin', area_id: 7, active: 1 }]]); // reassigned to area 7

    const socket = fakeSocket(token);
    const next = jest.fn();
    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.auth.areaId).toBe(7);
  });

  it('rejects the connection for an admin id removed from the admins table entirely', async () => {
    const token = jwt.sign({ sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state
      .mockResolvedValueOnce([[]]); // admins row — gone

    const next = jest.fn();
    await authenticateSocket(fakeSocket(token), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('does not attempt the admins-table re-check for a mobile-admin session (sub is not numeric)', async () => {
    const token = jwt.sign({ sub: 'mobile:9', role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query.mockResolvedValueOnce([[]]); // admin_auth_state only

    const socket = fakeSocket(token);
    const next = jest.fn();
    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(socket.data.auth.areaId).toBe(1);
  });

  it('does not attempt the admins-table re-check for an envFallback bootstrap session', async () => {
    const token = jwt.sign({ sub: 'owner', role: 'admin', adminRole: 'super_admin', areaId: null, envFallback: true }, JWT_SECRET);
    pool.query.mockResolvedValueOnce([[]]); // admin_auth_state only

    const socket = fakeSocket(token);
    const next = jest.fn();
    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  // A DB blip during the live re-check is not the same failure as a bad or
  // revoked token — collapsing both to AUTH_TOKEN_INVALID (what this used to
  // do) makes a transient infra hiccup indistinguishable from a genuinely
  // dead session in logs/telemetry. Still rejects the connection either way
  // (fail-closed is correct — the live-recheck can't be skipped just
  // because the DB is unreachable), only the error code differs.
  it('rejects with a distinct error when the revocation-check query itself fails (DB unavailable)', async () => {
    const token = jwt.sign({ sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const next = jest.fn();
    await authenticateSocket(fakeSocket(token), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('AUTH_SERVICE_UNAVAILABLE');
  });

  it('rejects with a distinct error when the live re-check query itself fails (DB unavailable)', async () => {
    const token = jwt.sign({ sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 }, JWT_SECRET);
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state — fine
      .mockRejectedValueOnce(new Error('ECONNREFUSED')); // admins table lookup — DB down

    const next = jest.fn();
    await authenticateSocket(fakeSocket(token), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('AUTH_SERVICE_UNAVAILABLE');
  });

  it('still rejects a genuinely malformed token as AUTH_TOKEN_INVALID, not AUTH_SERVICE_UNAVAILABLE', async () => {
    const next = jest.fn();
    await authenticateSocket(fakeSocket('not-a-real-jwt'), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toBe('AUTH_TOKEN_INVALID');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
