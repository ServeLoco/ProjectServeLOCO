/**
 * GET /api/products limit+offset + hasMore (SQL page size, not post time-window length).
 */
const request = require('supertest');
const express = require('express');
const productRoutes = require('../src/routes/productRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
    escape: jest.fn(value => `'${value}'`),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/products', productRoutes);

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };

// This route is unauthenticated and carries no pin in these tests, so
// resolveCustomerArea (TASK 11) resolves via the default-area fallback —
// one `SELECT * FROM areas` before the products query itself.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

// image_id null → resolveImageUrls no-ops; is_combo 0 → attachComboItems no-ops;
// attachVariants always issues one product_variants query when products present.
const mockProductHelpers = () => {
  pool.query.mockResolvedValueOnce([[]]); // attachVariants
};

const mockRow = (id, overrides = {}) => ({
  id,
  name: `Product ${id}`,
  price: 100,
  unit: 'pc',
  description: '',
  image_id: null,
  available: 1,
  is_combo: 0,
  featured: 0,
  original_price: null,
  discount_label: null,
  available_from_time: null,
  available_until_time: null,
  category_id: 1,
  category_name: 'Cat',
  category_type: 'fast_food',
  cat_display_order: 0,
  item_display_order: id,
  variant_prompt: null,
  shop_id: null,
  shop_is_open: 1,
  ...overrides,
});

describe('GET /api/products pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('no limit returns hasMore false and does not LIMIT', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockRow(1), mockRow(2)]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products');

    expect(res.statusCode).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.has_more).toBe(false);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.has_more).toBe(false);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.data.products).toHaveLength(2);
    const sql = pool.query.mock.calls[1][0];
    expect(sql).not.toMatch(/LIMIT\s+\?/i);
  });

  it('limit+offset windows and hasMore true when SQL returns limit+1 rows', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockRow(1), mockRow(2), mockRow(3)]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products?limit=2&offset=0');

    expect(res.statusCode).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.has_more).toBe(true);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.has_more).toBe(true);
    expect(res.body.products.map(p => p.id)).toEqual([1, 2]);
    expect(res.body.data.products.map(p => p.id)).toEqual([1, 2]);

    const [sql, params] = pool.query.mock.calls[1];
    expect(sql).toMatch(/LIMIT\s+\?\s+OFFSET\s+\?/i);
    expect(params).toEqual([3, 0]);
  });

  it('hasMore false when SQL returns fewer than limit+1 rows', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockRow(3), mockRow(4)]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products?limit=2&offset=2');

    expect(res.statusCode).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.products.map(p => p.id)).toEqual([3, 4]);
    const params = pool.query.mock.calls[1][1];
    expect(params).toEqual([3, 2]);
  });

  it('hasMore is from SQL page size (limit+1 peek), not product count alone', async () => {
    // Exactly limit rows after drop would be ambiguous if hasMore used filtered length.
    // Returning limit+1 SQL rows guarantees hasMore=true even when client sees only `limit` items.
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockRow(10), mockRow(11), mockRow(12)]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products?limit=2&offset=4');

    expect(res.statusCode).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    expect(pool.query.mock.calls[1][1]).toEqual([3, 4]);
  });
});
