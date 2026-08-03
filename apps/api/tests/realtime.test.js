const http = require('http');
const jwt = require('jsonwebtoken');
const { io: createClient } = require('socket.io-client');
const config = require('../src/config/env');
const {
  closeRealtime,
  emitToAdmins,
  emitToCustomer,
  getRealtimeStatus,
  initRealtime,
  joinNewAreaForConnectedSuperAdmins,
} = require('../src/realtime/socket');

const createToken = (payload) => jwt.sign(payload, config.JWT_SECRET);

const connectClient = (url, token) => new Promise((resolve, reject) => {
  const client = createClient(url, {
    auth: token ? { token } : {},
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });

  client.once('connect', () => resolve(client));
  client.once('connect_error', (error) => {
    client.close();
    reject(error);
  });
});

const connectClientBearer = (url, token) => new Promise((resolve, reject) => {
  const client = createClient(url, {
    extraHeaders: token ? { Authorization: `Bearer ${token}` } : {},
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });

  client.once('connect', () => resolve(client));
  client.once('connect_error', (error) => {
    client.close();
    reject(error);
  });
});

const expectConnectError = (url, token) => new Promise((resolve, reject) => {
  const client = createClient(url, {
    auth: token ? { token } : {},
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });

  client.once('connect', () => {
    client.close();
    reject(new Error('Expected socket connection to be rejected'));
  });
  client.once('connect_error', (error) => {
    client.close();
    resolve(error);
  });
});

const waitForEvent = (client, eventName) => new Promise((resolve) => {
  client.once(eventName, resolve);
});

const expectNoEvent = (client, eventName) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 75);
  client.once(eventName, (payload) => {
    clearTimeout(timer);
    reject(new Error(`Unexpected ${eventName}: ${JSON.stringify(payload)}`));
  });
});

describe('Realtime socket server', () => {
  let server;
  let url;
  const clients = [];

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    initRealtime(server);
    const { port } = server.address();
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    clients.forEach(client => client.close());
    clients.length = 0;
    await closeRealtime();
    await new Promise(resolve => server.close(resolve));
  });

  it('rejects missing socket tokens', async () => {
    await expect(expectConnectError(url)).resolves.toHaveProperty('message', 'AUTH_TOKEN_MISSING');
  });

  it('rejects invalid socket tokens', async () => {
    await expect(expectConnectError(url, 'not-a-token')).resolves.toHaveProperty('message', 'AUTH_TOKEN_INVALID');
  });

  it('accepts customer tokens and emits to the customer room', async () => {
    const token = createToken({ sub: 42, role: 'customer' });
    const client = await connectClient(url, token);
    clients.push(client);

    const eventPromise = waitForEvent(client, 'order.updated');
    const emitted = emitToCustomer(42, 'order.updated', { orderId: 1001 });

    await expect(eventPromise).resolves.toEqual({ orderId: 1001 });
    expect(emitted).toBe(true);
  });

  it('does not leak customer events to other customer rooms', async () => {
    const token = createToken({ sub: 43, role: 'customer' });
    const client = await connectClient(url, token);
    clients.push(client);

    const eventPromise = expectNoEvent(client, 'order.updated');
    const emitted = emitToCustomer(42, 'order.updated', { orderId: 1001 });

    await expect(eventPromise).resolves.toBeUndefined();
    expect(emitted).toBe(true);
  });

  it('accepts admin tokens and emits to the admin:<areaId> room', async () => {
    const token = createToken({ sub: '9350238504', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const client = await connectClient(url, token);
    clients.push(client);

    const eventPromise = waitForEvent(client, 'admin.order.updated');
    const emitted = emitToAdmins(1, 'admin.order.updated', { orderId: 1002 });

    await expect(eventPromise).resolves.toEqual({ orderId: 1002 });
    expect(emitted).toBe(true);
  });

  it('reports realtime status', async () => {
    const token = createToken({ sub: 43, role: 'customer' });
    const client = await connectClient(url, token);
    clients.push(client);

    expect(getRealtimeStatus()).toEqual({
      enabled: true,
      connectedSockets: 1,
    });
  });

  it('accepts tokens via Authorization Bearer header', async () => {
    const token = createToken({ sub: 50, role: 'customer' });
    const client = await connectClientBearer(url, token);
    clients.push(client);

    const eventPromise = waitForEvent(client, 'order.updated');
    emitToCustomer(50, 'order.updated', { orderId: 2000 });
    await expect(eventPromise).resolves.toEqual({ orderId: 2000 });
  });

  it('rejects tokens with unknown roles', async () => {
    const token = createToken({ sub: 60, role: 'superadmin' });
    await expect(expectConnectError(url, token)).resolves.toHaveProperty('message', 'FORBIDDEN_ROLE');
  });

  it('routes events to the correct customer only', async () => {
    const token1 = createToken({ sub: 71, role: 'customer' });
    const token2 = createToken({ sub: 72, role: 'customer' });
    const client1 = await connectClient(url, token1);
    const client2 = await connectClient(url, token2);
    clients.push(client1, client2);

    const received1 = waitForEvent(client1, 'order.created');
    const notReceived2 = expectNoEvent(client2, 'order.created');

    emitToCustomer(71, 'order.created', { orderId: 3001 });

    await expect(received1).resolves.toEqual({ orderId: 3001 });
    await expect(notReceived2).resolves.toBeUndefined();
  });

  it('delivers events to all connected admins in the same area', async () => {
    const token1 = createToken({ sub: 'admin_a', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const token2 = createToken({ sub: 'admin_b', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const admin1 = await connectClient(url, token1);
    const admin2 = await connectClient(url, token2);
    clients.push(admin1, admin2);

    const event1 = waitForEvent(admin1, 'admin.order.created');
    const event2 = waitForEvent(admin2, 'admin.order.created');

    emitToAdmins(1, 'admin.order.created', { orderId: 4001 });

    await expect(event1).resolves.toEqual({ orderId: 4001 });
    await expect(event2).resolves.toEqual({ orderId: 4001 });
  });

  it('does not leak admin events to customer rooms', async () => {
    const customerToken = createToken({ sub: 80, role: 'customer' });
    const adminToken = createToken({ sub: 'admin_c', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const customerClient = await connectClient(url, customerToken);
    const adminClient = await connectClient(url, adminToken);
    clients.push(customerClient, adminClient);

    const adminReceived = waitForEvent(adminClient, 'admin.order.updated');
    const customerNotReceived = expectNoEvent(customerClient, 'admin.order.updated');

    emitToAdmins(1, 'admin.order.updated', { orderId: 5001 });

    await expect(adminReceived).resolves.toEqual({ orderId: 5001 });
    await expect(customerNotReceived).resolves.toBeUndefined();
  });

  it("TASK 23.7 — an area 2 admin event never reaches an area 1 admin socket", async () => {
    const area1Token = createToken({ sub: 'admin_area1', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const area2Token = createToken({ sub: 'admin_area2', role: 'admin', adminRole: 'area_admin', areaId: 2 });
    const area1Client = await connectClient(url, area1Token);
    const area2Client = await connectClient(url, area2Token);
    clients.push(area1Client, area2Client);

    const area2Received = waitForEvent(area2Client, 'delivery_zones.updated');
    const area1NotReceived = expectNoEvent(area1Client, 'delivery_zones.updated');

    emitToAdmins(2, 'delivery_zones.updated', { reason: 'zone_updated', zoneId: 900 });

    await expect(area2Received).resolves.toEqual({ reason: 'zone_updated', zoneId: 900 });
    await expect(area1NotReceived).resolves.toBeUndefined();
  });

  // A super_admin joining every admin:<areaId> room needs areaScope.listAreas()
  // (a real DB read), which is guarded to skip under NODE_ENV=test the same
  // way resolveAreaIdForSocketUser is (this file intentionally runs without a
  // db/mysql mock, exercising real socket.io connections) — that branch is
  // unit-tested directly instead, see tests/socketAreaResolution.test.js.

  // Bug fix (multi-area audit finding #15): joinAreaRoom's super_admin
  // branch only ran at connect time — an already-connected super_admin
  // never picked up a NEW area's admin:<areaId> room until reconnecting.
  // socket.data.allAdminAreas is set unconditionally in joinAreaRoom
  // (independent of the NODE_ENV-guarded listAreas() call above), so this
  // works under NODE_ENV=test without a db/mysql mock, same as every other
  // test in this file.
  it('joinNewAreaForConnectedSuperAdmins reaches an already-connected super_admin immediately, without reconnecting', async () => {
    const superToken = createToken({ sub: 'super_1', role: 'admin', adminRole: 'super_admin' });
    const superClient = await connectClient(url, superToken);
    clients.push(superClient);

    const received = waitForEvent(superClient, 'admin.notification.created');
    joinNewAreaForConnectedSuperAdmins(7);
    emitToAdmins(7, 'admin.notification.created', { title: 'New area 7 order' });

    await expect(received).resolves.toEqual({ title: 'New area 7 order' });
  });

  it('does not join a plain area_admin into a newly created area', async () => {
    const areaAdminToken = createToken({ sub: 'admin_area1', role: 'admin', adminRole: 'area_admin', areaId: 1 });
    const areaAdminClient = await connectClient(url, areaAdminToken);
    clients.push(areaAdminClient);

    const notReceived = expectNoEvent(areaAdminClient, 'admin.notification.created');
    joinNewAreaForConnectedSuperAdmins(7);
    emitToAdmins(7, 'admin.notification.created', { title: 'New area 7 order' });

    await expect(notReceived).resolves.toBeUndefined();
  });

  it('returns false from emitToCustomer when customerId is falsy', async () => {
    expect(emitToCustomer(null, 'test', {})).toBe(false);
    expect(emitToCustomer(undefined, 'test', {})).toBe(false);
    expect(emitToCustomer(0, 'test', {})).toBe(false);
    expect(emitToCustomer('', 'test', {})).toBe(false);
  });

  it('returns false from emitToRoom when io is null after closeRealtime', async () => {
    await closeRealtime();
    const result = emitToAdmins(1, 'test.event', { data: 1 });
    expect(result).toBe(false);
  });

  it('initRealtime is idempotent - returns same io instance', async () => {
    const server2 = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));

    const io1 = initRealtime(server);
    const io2 = initRealtime(server2);
    expect(io1).toBe(io2);

    await new Promise(resolve => server2.close(resolve));
  });

  it('tracks connected socket count accurately', async () => {
    const t1 = createToken({ sub: 90, role: 'customer' });
    const t2 = createToken({ sub: 91, role: 'customer' });
    const c1 = await connectClient(url, t1);
    const c2 = await connectClient(url, t2);
    clients.push(c1, c2);

    expect(getRealtimeStatus().connectedSockets).toBe(2);

    c1.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(getRealtimeStatus().connectedSockets).toBe(1);
  });
});
