const request = require('supertest');
const express = require('express');
const productRoutes = require('../src/routes/productRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() }
}));

const app = express();
app.use(express.json());
app.use('/api/products', productRoutes);

const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };

describe('Product Combo Fallback', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — a failed assertion after a test's
    // request already resolved can leave queued mockResolvedValueOnce
    // values undrained, which clearAllMocks does not clear, silently
    // corrupting the next test's mock sequence.
    jest.resetAllMocks();
    areaScope._resetCachesForTests();
  });

  it('should return 404 when product is not found and type=combo is not specified', async () => {
    // Route now resolves an area first (bug fix, multi-area audit finding
    // #4 — GET /products/:id used to have no area scoping at all). No pin
    // on this request -> resolveCustomerArea falls back to the default area.
    pool.query.mockResolvedValueOnce([[AREA_1]]); // getDefaultArea's areas lookup
    pool.query.mockResolvedValueOnce([[]]); // product lookup — empty

    const res = await request(app).get('/api/products/1');
    expect(res.statusCode).toEqual(404);
    expect(res.body.message).toEqual('Product not found');
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('FROM products');
  });

  it('should load combo when type=combo is specified', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1]]); // getDefaultArea's areas lookup
    // Return combo for combo
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'My Combo' }]]);
    // Resolve images and items mock
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/products/1?type=combo');
    expect(res.statusCode).toEqual(200);
    expect(res.body.data.name).toEqual('My Combo');
    expect(pool.query.mock.calls[1][0]).toContain('FROM combos');
  });

  // Bug fix (multi-area audit finding #4): this route used to have zero
  // area scoping — a pin resolving into area 2 must never fetch a product
  // that only exists in area 1, even by id.
  it('scopes the product query to the pin-resolved area, never another area', async () => {
    const AREA_2 = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0 };
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[]]); // area 1's zones — no match
    pool.query.mockResolvedValueOnce([[{ // area 2's own zone matches the pin
      id: 900, area_id: 2, name: 'A2 Zone', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null, active: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[]]); // product lookup — empty (area 1's product, wrong area)

    const res = await request(app).get('/api/products/1?latitude=10.5&longitude=10.5');
    expect(res.statusCode).toEqual(404);
    const [productSql, params] = pool.query.mock.calls[3];
    expect(productSql).toContain('p.area_id = ?');
    expect(params).toEqual(['1', 2]);
  });

  it('a pin outside every zone (undeliverable) 404s rather than leaking any area\'s product', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[]]); // area 1's zones — no match

    const res = await request(app).get('/api/products/1?latitude=50&longitude=50');
    expect(res.statusCode).toEqual(404);
    // Only the bbox/zone queries ran — never a product query, since areaId
    // resolved to null.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
