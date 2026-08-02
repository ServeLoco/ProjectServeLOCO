// Shared Mongo mock: each analytics store calls mongo.getDb().collection(name)
// and uses insertOne / updateOne / insertMany. We expose those fns so tests can
// assert call shapes and drive success/failure per test.
jest.mock('../src/db/mongodb', () => {
  const fns = {
    insertOne: jest.fn(),
    updateOne: jest.fn(),
    insertMany: jest.fn(),
    createIndex: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
    findOne: jest.fn(),
  };
  return {
    __mocks: fns,
    getDb: jest.fn(() => ({ collection: () => fns })),
  };
});

const mongo = require('../src/db/mongodb');
const { ensureAnalyticsIndexes } = require('../src/services/analytics/collections');
const { validateEvent, insertEvents } = require('../src/services/analytics/eventStore');
const { openSession, closeSession } = require('../src/services/analytics/sessionStore');

beforeEach(() => {
  mongo.__mocks.insertOne.mockReset();
  mongo.__mocks.updateOne.mockReset();
  mongo.__mocks.insertMany.mockReset();
  mongo.__mocks.createIndex.mockReset();
});

describe('ensureAnalyticsIndexes', () => {
  it('creates all specced indexes for the three collections, area-prefixed (TASK 17)', async () => {
    const calls = {};
    const db = {
      collection: jest.fn((name) => {
        if (!calls[name]) {
          calls[name] = {
            createIndex: jest.fn().mockResolvedValue(),
            dropIndex: jest.fn().mockResolvedValue(),
            updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
          };
        }
        return calls[name];
      }),
    };

    await ensureAnalyticsIndexes(db);

    const sessionCalls = calls.analytics_sessions.createIndex.mock.calls;
    expect(sessionCalls).toContainEqual([{ createdAt: 1 }, { expireAfterSeconds: 2592000 }]);
    expect(sessionCalls).toContainEqual([{ userId: 1, createdAt: -1 }]);
    expect(sessionCalls).toContainEqual([{ areaId: 1, createdAt: -1 }]);

    const eventCalls = calls.analytics_events.createIndex.mock.calls;
    expect(eventCalls).toContainEqual([{ createdAt: 1 }, { expireAfterSeconds: 2592000 }]);
    expect(eventCalls).toContainEqual([{ userId: 1, createdAt: -1 }]);
    expect(eventCalls).toContainEqual([{ areaId: 1, createdAt: -1 }]);
    expect(eventCalls).toContainEqual([{ areaId: 1, type: 1, createdAt: -1 }]);
    expect(eventCalls).toContainEqual([{ areaId: 1, productId: 1, type: 1, createdAt: -1 }]);
    expect(calls.analytics_events.dropIndex).toHaveBeenCalledWith('type_1_createdAt_-1');
    expect(calls.analytics_events.dropIndex).toHaveBeenCalledWith('productId_1_type_1_createdAt_-1');

    // Backfill runs before the new unique index is created.
    expect(calls.analytics_daily.updateMany).toHaveBeenCalledWith(
      { areaId: { $exists: false } },
      { $set: { areaId: 1 } }
    );
    expect(calls.analytics_daily.dropIndex).toHaveBeenCalledWith('date_1');
    const dailyCalls = calls.analytics_daily.createIndex.mock.calls;
    expect(dailyCalls).toContainEqual([{ areaId: 1, date: 1 }, { unique: true }]);
    expect(dailyCalls).toContainEqual([{ createdAt: 1 }, { expireAfterSeconds: 31536000 }]);

    const updateManyOrder = calls.analytics_daily.updateMany.mock.invocationCallOrder[0];
    const uniqueIndexOrder = calls.analytics_daily.createIndex.mock.invocationCallOrder[
      dailyCalls.findIndex((c) => c[1]?.unique)
    ];
    expect(updateManyOrder).toBeLessThan(uniqueIndexOrder);
  });

  it('swallows an already-dropped index without throwing', async () => {
    const err = new Error('index not found');
    err.codeName = 'IndexNotFound';
    const db = {
      collection: jest.fn(() => ({
        createIndex: jest.fn().mockResolvedValue(),
        dropIndex: jest.fn().mockRejectedValue(err),
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      })),
    };
    await expect(ensureAnalyticsIndexes(db)).resolves.toBeUndefined();
  });
});

describe('validateEvent', () => {
  it('accepts a valid cart_add with numeric ids', () => {
    expect(validateEvent({ type: 'cart_add', productId: 88, qty: 2, price: 45 })).toEqual({
      type: 'cart_add', productId: 88, qty: 2, price: 45,
    });
  });

  it('drops unknown event types', () => {
    expect(validateEvent({ type: 'search', productId: 1 })).toBeNull();
    expect(validateEvent({ type: 'cart_add_extra', productId: 1 })).toBeNull();
  });

  it('drops events with non-numeric productId', () => {
    expect(validateEvent({ type: 'cart_add', productId: 'abc' })).toBeNull();
  });

  it('drops events with non-numeric qty', () => {
    expect(validateEvent({ type: 'cart_add', productId: 1, qty: 'lots' })).toBeNull();
  });

  it('drops extra fields not in the whitelist (privacy guardrail)', () => {
    const out = validateEvent({ type: 'product_view', productId: 5, location: 'Mumbai', deviceId: 'x' });
    expect(out).toEqual({ type: 'product_view', productId: 5 });
    expect(out).not.toHaveProperty('location');
    expect(out).not.toHaveProperty('deviceId');
  });

  it('parses at timestamp into a Date and drops invalid dates', () => {
    expect(validateEvent({ type: 'checkout_start', at: '2026-07-09T10:00:00Z' }).at).toBeInstanceOf(Date);
    expect(validateEvent({ type: 'checkout_start', at: 'not-a-date' })).toBeNull();
  });

  it('drops null/non-object events', () => {
    expect(validateEvent(null)).toBeNull();
    expect(validateEvent('hello')).toBeNull();
    expect(validateEvent(undefined)).toBeNull();
  });

  it('accepts order_placed with orderId', () => {
    expect(validateEvent({ type: 'order_placed', orderId: 991 })).toEqual({ type: 'order_placed', orderId: 991 });
  });
});

describe('insertEvents', () => {
  it('inserts only valid events with userId and createdAt', async () => {
    mongo.__mocks.insertMany.mockResolvedValue({ insertedCount: 2 });
    const events = [
      { type: 'cart_add', productId: 1, qty: 2, price: 10 },
      { type: 'bogus' },
      { type: 'product_view', productId: 5, secret: 'x' },
    ];
    const n = await insertEvents(123, events);
    expect(n).toBe(2);
    const docs = mongo.__mocks.insertMany.mock.calls[0][0];
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ userId: 123, type: 'cart_add', productId: 1, qty: 2, price: 10 });
    expect(docs[1]).toMatchObject({ userId: 123, type: 'product_view', productId: 5 });
    expect(docs[1]).not.toHaveProperty('secret');
    expect(docs[0].createdAt).toBeInstanceOf(Date);
  });

  it('caps at 50 valid events per call', async () => {
    mongo.__mocks.insertMany.mockResolvedValue({ insertedCount: 50 });
    const many = Array.from({ length: 80 }, () => ({ type: 'product_view', productId: 1 }));
    const n = await insertEvents(1, many);
    expect(n).toBe(50);
    expect(mongo.__mocks.insertMany.mock.calls[0][0]).toHaveLength(50);
  });

  it('returns 0 and does not call Mongo when no valid events', async () => {
    const n = await insertEvents(1, [{ type: 'bogus' }, { type: 'cart_add', productId: 'x' }]);
    expect(n).toBe(0);
    expect(mongo.__mocks.insertMany).not.toHaveBeenCalled();
  });

  it('returns 0 and does not throw when Mongo is down (fire-and-forget)', async () => {
    mongo.__mocks.insertMany.mockRejectedValue(new Error('mongo down'));
    const n = await insertEvents(1, [{ type: 'product_view', productId: 1 }]);
    expect(n).toBe(0);
  });

  it('returns 0 for non-array input', async () => {
    expect(await insertEvents(1, 'nope')).toBe(0);
    expect(await insertEvents(1, null)).toBe(0);
  });
});

describe('sessionStore', () => {
  it('openSession inserts a session doc and returns its _id', async () => {
    const fakeId = 'abc123';
    mongo.__mocks.insertOne.mockResolvedValue({ insertedId: fakeId });
    const id = await openSession({ userId: 123, platform: 'android', appVersion: '1.4.2' });
    expect(id).toBe(fakeId);
    const doc = mongo.__mocks.insertOne.mock.calls[0][0];
    expect(doc.userId).toBe(123);
    expect(doc.platform).toBe('android');
    expect(doc.appVersion).toBe('1.4.2');
    expect(doc.screens).toEqual({});
    expect(doc.connectedAt).toBeInstanceOf(Date);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.disconnectedAt).toBeNull();
  });

  it('openSession returns null and does not throw when Mongo is down', async () => {
    mongo.__mocks.insertOne.mockRejectedValue(new Error('mongo down'));
    const id = await openSession({ userId: 1, platform: 'ios', appVersion: '1.0' });
    expect(id).toBeNull();
  });

  it('closeSession sets disconnectedAt, screens, and durationSec via updateOne', async () => {
    mongo.__mocks.updateOne.mockResolvedValue({ matchedCount: 1 });
    await closeSession('sess123', { Home: 3, Cart: 1 }, new Date(Date.now() - 60000));
    expect(mongo.__mocks.updateOne).toHaveBeenCalledTimes(1);
    const [filter, pipeline] = mongo.__mocks.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'sess123' });
    expect(Array.isArray(pipeline)).toBe(true);
    const setStage = pipeline[0].$set;
    expect(setStage.screens).toEqual({ Home: 3, Cart: 1 });
    expect(setStage.disconnectedAt).toBeInstanceOf(Date);
    expect(setStage.durationSec).toBeDefined();
  });

  it('closeSession is a no-op without a sessionId', async () => {
    await closeSession(null, { Home: 1 });
    expect(mongo.__mocks.updateOne).not.toHaveBeenCalled();
  });

  it('closeSession does not throw when Mongo is down', async () => {
    mongo.__mocks.updateOne.mockRejectedValue(new Error('mongo down'));
    await expect(closeSession('sess', { Home: 1 })).resolves.toBeUndefined();
  });
});
