const request = require('supertest');
const express = require('express');

// --- Mock MongoDB --------------------------------------------------------
// The real MongoDB driver returns cursors from aggregate()/find(), not
// Promises. We model that with a tiny cursor helper so the controller's
// .toArray() / .sort().limit().toArray() chains work naturally.
const makeCursor = (data) => ({
  toArray: jest.fn().mockResolvedValue(data),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
});

const mockMongoFns = {
  insertMany: jest.fn(),
  aggregate: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn(),
  insertOne: jest.fn(),
  countDocuments: jest.fn(),
};
jest.mock('../src/db/mongodb', () => ({
  __mocks: mockMongoFns,
  getDb: jest.fn(() => ({ collection: () => mockMongoFns })),
}));

// --- Mock MySQL ----------------------------------------------------------
const mockMysqlPool = { query: jest.fn() };
jest.mock('../src/db/mysql', () => ({ pool: mockMysqlPool }));

process.env.NODE_ENV = 'test';

const analyticsRoutes = require('../src/routes/analyticsRoutes');
const { signCustomerToken, signAdminToken } = require('../src/utils/auth');

const customerToken = signCustomerToken(123);
const adminToken = signAdminToken(1, { adminRole: 'area_admin', areaId: 1 });

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRoutes);
  const adminAnalyticsRoutes = require('../src/routes/analyticsRoutes').adminRouter;
  app.use('/api/admin/analytics', adminAnalyticsRoutes);
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMongoFns.insertMany.mockResolvedValue({ insertedCount: 2 });
  mockMongoFns.aggregate.mockReturnValue(makeCursor([]));
  mockMongoFns.find.mockReturnValue(makeCursor([]));
  mockMongoFns.countDocuments.mockResolvedValue(0);
  mockMysqlPool.query.mockResolvedValue([[]]);
});

// --- Customer: POST /api/analytics/events --------------------------------
describe('POST /api/analytics/events (customer)', () => {
  it('responds 202 with accepted count for valid events', async () => {
    mockMongoFns.insertMany.mockResolvedValue({ insertedCount: 1 });
    const app = buildApp();
    const res = await request(app)
      .post('/api/analytics/events')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ events: [{ type: 'cart_add', productId: 1, qty: 2, price: 10 }] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
  });

  it('responds 202 with 0 when all events are invalid', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/analytics/events')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ events: [{ type: 'bogus' }] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(0);
  });

  it('responds 202 even when Mongo is down (fire-and-forget)', async () => {
    mockMongoFns.insertMany.mockRejectedValue(new Error('mongo down'));
    const app = buildApp();
    const res = await request(app)
      .post('/api/analytics/events')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ events: [{ type: 'product_view', productId: 1 }] });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(0);
  });

  it('rejects without a customer token (401)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/analytics/events').send({ events: [] });
    expect(res.status).toBe(401);
  });

  it('rejects an admin token (403 — customer-only)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/analytics/events')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ events: [] });
    expect(res.status).toBe(403);
  });
});

// --- Admin: window-shoppers ----------------------------------------------
describe('GET /api/admin/analytics/window-shoppers (admin)', () => {
  it('returns enriched window-shopper rows with MySQL name/phone joins', async () => {
    mockMongoFns.aggregate.mockReturnValue(makeCursor([
      { _id: 123, cartAdds: 5, cartRemoves: 1, lastActiveAt: new Date('2026-07-09T10:00:00Z') },
      { _id: 456, cartAdds: 2, cartRemoves: 0, lastActiveAt: new Date('2026-07-09T11:00:00Z') },
    ]));
    mockMysqlPool.query.mockResolvedValueOnce([
      [{ id: 123, name: 'Alice', phone: '9999000011' }, { id: 456, name: 'Bob', phone: '9999000022' }],
    ]);

    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/window-shoppers?days=7')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ userId: 123, name: 'Alice', phone: '9999000011', cartAdds: 5, cartRemoves: 1 });
    expect(res.body.data[1]).toMatchObject({ userId: 456, name: 'Bob', phone: '9999000022', cartAdds: 2 });
  });

  it('rejects a customer token (403)', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/window-shoppers')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });
});

// --- Admin: per-user drill-down ------------------------------------------
describe('GET /api/admin/analytics/user/:id (admin)', () => {
  it('returns user header, totals, sessions, and timeline', async () => {
    // MySQL: user info
    mockMysqlPool.query.mockResolvedValueOnce([
      [{ id: 123, name: 'Alice', phone: '9999000011', joinedAt: new Date('2026-01-01') }],
    ]);
    // MySQL: order count
    mockMysqlPool.query.mockResolvedValueOnce([[{ orderCount: 3 }]]);
    // MySQL: product name lookup (3rd call)
    mockMysqlPool.query.mockResolvedValueOnce([[{ id: 88, name: 'Amul Butter' }]]);

    // Mongo: sessions count
    mockMongoFns.countDocuments.mockResolvedValue(7);
    // Mongo: sessions cursor + events cursor — find is called twice.
    // We use a queue so the 1st find() returns sessions, 2nd returns events.
    const sessionsCursor = makeCursor([
      { connectedAt: new Date('2026-07-09T10:00:00Z'), durationSec: 600, platform: 'android', screens: { Home: 3, Cart: 1 } },
    ]);
    const eventsCursor = makeCursor([
      { at: new Date('2026-07-09T10:10:00Z'), type: 'order_placed', orderId: 991 },
      { at: new Date('2026-07-09T10:05:00Z'), type: 'cart_add', productId: 88, qty: 2 },
    ]);
    const findQueue = [sessionsCursor, eventsCursor];
    mockMongoFns.find.mockImplementation(() => findQueue.shift());

    // Mongo: events totals aggregate
    mockMongoFns.aggregate.mockReturnValue(makeCursor([{ _id: 'cart_add', count: 5 }, { _id: 'cart_remove', count: 1 }]));

    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/user/123?days=30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 123, name: 'Alice', phone: '9999000011' });
    expect(res.body.totals.sessions).toBe(7);
    expect(res.body.totals.orders).toBe(3);
    expect(res.body.totals.cartAdds).toBe(5);
    expect(res.body.totals.cartRemoves).toBe(1);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0]).toMatchObject({ platform: 'android', durationSec: 600 });
    expect(res.body.timeline).toHaveLength(2);
    expect(res.body.timeline[0]).toMatchObject({ type: 'order_placed', orderId: 991 });
    expect(res.body.timeline[1]).toMatchObject({ type: 'cart_add', productId: 88, productName: 'Amul Butter', qty: 2 });
  });

  it('returns 404 when the user does not exist in MySQL', async () => {
    mockMysqlPool.query.mockResolvedValueOnce([[]]); // no user found
    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/user/99999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// --- Admin: summary -------------------------------------------------------
describe('GET /api/admin/analytics/summary (admin)', () => {
  it('returns daily docs + today-so-far computed live', async () => {
    // The controller calls: daily find, sessions aggregate, events aggregate.
    // find returns a cursor; aggregate returns a cursor.
    const dailyCursor = makeCursor([
      { date: '2026-07-08', visitors: 100, sessions: 200, orders: 20, conversionPct: 20 },
    ]);
    const sessionsAggCursor = makeCursor([{ _id: null, sessions: 5, users: [1, 2, 3] }]);
    const eventsAggCursor = makeCursor([{ _id: 'cart_add', count: 10 }, { _id: 'order_placed', count: 1 }]);

    mockMongoFns.find.mockReturnValue(dailyCursor);
    const aggQueue = [sessionsAggCursor, eventsAggCursor];
    mockMongoFns.aggregate.mockImplementation(() => aggQueue.shift());

    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/summary?days=7')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('daily');
    expect(res.body.daily).toHaveLength(1);
    expect(res.body).toHaveProperty('today');
    expect(res.body.today.sessions).toBe(5);
    expect(res.body.today.visitors).toBe(3);
    expect(res.body.today.cartAdds).toBe(10);
    expect(res.body.today.orders).toBe(1);
  });
});

// --- Admin: products ------------------------------------------------------
describe('GET /api/admin/analytics/products (admin)', () => {
  it('returns top added/removed/viewed with product names', async () => {
    mockMongoFns.aggregate.mockReturnValue(makeCursor([
      { _id: { productId: 88, type: 'cart_add' }, count: 10 },
      { _id: { productId: 88, type: 'cart_remove' }, count: 3 },
      { _id: { productId: 88, type: 'product_view' }, count: 50 },
    ]));
    mockMysqlPool.query.mockResolvedValueOnce([[{ id: 88, name: 'Amul Butter' }]]);

    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/products?days=30')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.topAdded).toHaveLength(1);
    expect(res.body.topAdded[0]).toMatchObject({ productId: 88, name: 'Amul Butter', count: 10 });
    expect(res.body.topRemoved[0]).toMatchObject({ count: 3 });
    expect(res.body.topViewed[0]).toMatchObject({ count: 50 });
  });
});

// --- Admin: hourly --------------------------------------------------------
describe('GET /api/admin/analytics/hourly (admin)', () => {
  it('returns hourlyActive arrays for heatmap', async () => {
    mockMongoFns.find.mockReturnValue(makeCursor([
      { date: '2026-07-08', hourlyActive: [0,0,0,1,2,3,5,8,10,12,11,9,7,5,4,3,6,8,10,7,5,3,1,0] },
    ]));

    const app = buildApp();
    const res = await request(app)
      .get('/api/admin/analytics/hourly?days=14')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0].hourlyActive).toHaveLength(24);
  });
});
