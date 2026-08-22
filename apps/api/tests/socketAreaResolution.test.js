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
  listAreas: jest.fn(),
  getAreaById: jest.fn(),
}));

const { pool } = require('../src/db/mysql');
const { getDefaultArea, listAreas, getAreaById } = require('../src/utils/areaScope');
const { resolveAreaIdForSocketUser, joinAreaRoom, rejoinAreaRoom } = require('../src/realtime/socket');

const fakeSocket = (auth) => ({ data: { auth }, join: jest.fn() });

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

/**
 * TASK 23 — joinAreaRoom (src/realtime/socket.js). Its customer and
 * super_admin branches call resolveAreaIdForSocketUser/listAreas — both real
 * DB reads — guarded to skip under NODE_ENV=test at the same call sites
 * (realtime.test.js exercises real socket.io connections with no db/mysql
 * mock), so exercising those branches here requires temporarily forcing
 * NODE_ENV away from 'test'. The area_admin branch has no DB dependency and
 * is covered directly by realtime.test.js's real socket connections instead.
 */
describe('joinAreaRoom', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("joins customers:<areaId> using the user's resolved area", async () => {
    process.env.NODE_ENV = 'production';
    pool.query.mockResolvedValueOnce([[{ last_area_id: 2 }]]);
    const socket = fakeSocket({ id: 42, role: 'customer' });

    await joinAreaRoom(socket);

    expect(socket.join).toHaveBeenCalledWith('customers:2');
    expect(socket.data.areaId).toBe(2);
  });

  it('joins no customers room when area resolution comes up empty (H7 cold start)', async () => {
    process.env.NODE_ENV = 'production';
    pool.query.mockResolvedValueOnce([[]]);
    getDefaultArea.mockResolvedValueOnce(null);
    const socket = fakeSocket({ id: 999, role: 'customer' });

    await joinAreaRoom(socket);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.data.areaId).toBeUndefined();
  });

  it('joins admin:<areaId> directly for an area_admin using the JWT claim, no DB call', async () => {
    const socket = fakeSocket({ role: 'admin', adminRole: 'area_admin', areaId: 5 });

    await joinAreaRoom(socket);

    expect(socket.join).toHaveBeenCalledWith('admin:5');
    expect(pool.query).not.toHaveBeenCalled();
    expect(listAreas).not.toHaveBeenCalled();
  });

  it('joins every admin:<areaId> room for a super_admin', async () => {
    process.env.NODE_ENV = 'production';
    listAreas.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const socket = fakeSocket({ role: 'admin', adminRole: 'super_admin' });

    await joinAreaRoom(socket);

    expect(socket.join).toHaveBeenCalledWith('admin:1');
    expect(socket.join).toHaveBeenCalledWith('admin:2');
    expect(socket.join).toHaveBeenCalledWith('admin:3');
    expect(socket.data.allAdminAreas).toBe(true);
  });

  it('is a no-op when the socket has no auth', async () => {
    const socket = fakeSocket(undefined);
    await expect(joinAreaRoom(socket)).resolves.toBeUndefined();
    expect(socket.join).not.toHaveBeenCalled();
  });
});

/**
 * Bug fix (multi-area audit finding #13) — rejoinAreaRoom used to trust the
 * client-supplied areaId outright, letting any connected customer join
 * ANY area's `customers:<areaId>` room by just emitting a spoofed id,
 * regardless of where they actually are. Now validates it against a real,
 * active area first.
 */
describe('rejoinAreaRoom', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const fakeSocketWithLeave = (auth, currentAreaId) => ({
    data: { auth, areaId: currentAreaId },
    join: jest.fn(),
    leave: jest.fn(),
  });

  it('joins the new room when the areaId is real and active', async () => {
    getAreaById.mockResolvedValueOnce({ id: 2, active: 1 });
    const socket = fakeSocketWithLeave({ role: 'customer', id: 42 }, 1);

    await rejoinAreaRoom(socket, 2);

    expect(socket.leave).toHaveBeenCalledWith('customers:1');
    expect(socket.join).toHaveBeenCalledWith('customers:2');
    expect(socket.data.areaId).toBe(2);
  });

  it('rejects a spoofed/nonexistent areaId — no join, no leave', async () => {
    getAreaById.mockResolvedValueOnce(null);
    const socket = fakeSocketWithLeave({ role: 'customer', id: 42 }, 1);

    await rejoinAreaRoom(socket, 999);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.leave).not.toHaveBeenCalled();
    expect(socket.data.areaId).toBe(1);
  });

  it('rejects a real but deactivated area', async () => {
    getAreaById.mockResolvedValueOnce({ id: 2, active: 0 });
    const socket = fakeSocketWithLeave({ role: 'customer', id: 42 }, 1);

    await rejoinAreaRoom(socket, 2);

    expect(socket.join).not.toHaveBeenCalled();
  });

  it('is a no-op for an admin socket', async () => {
    const socket = fakeSocketWithLeave({ role: 'admin', adminRole: 'area_admin', areaId: 1 }, undefined);

    await rejoinAreaRoom(socket, 2);

    expect(getAreaById).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  // Defense in depth (multi-area audit finding #5): every customers:<areaId>
  // broadcast is non-PII, so this is not a confidentiality control — it just
  // stops a modified client from spamming rejoins to enumerate active areas
  // or thrash room membership. See the comment above rejoinAreaRoom.
  it('stops honoring rejoins past the per-window cap, without erroring', async () => {
    getAreaById.mockResolvedValue({ id: 2, active: 1 });
    const socket = fakeSocketWithLeave({ role: 'customer', id: 42 }, 1);

    for (let i = 0; i < 10; i++) {
      await rejoinAreaRoom(socket, 2);
    }
    expect(socket.join).toHaveBeenCalledTimes(10);

    await rejoinAreaRoom(socket, 2);
    expect(socket.join).toHaveBeenCalledTimes(10); // 11th call in the window is dropped
  });
});
