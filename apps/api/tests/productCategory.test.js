const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const productRoutes = require('../src/routes/productRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
    escape: jest.fn(value => `'${value}'`)
  }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/products', productRoutes);

// Admin token for testing
const token = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// Unauthenticated/no-pin public routes resolve via resolveCustomerArea's
// default-area fallback — one `SELECT * FROM areas` before the real query.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('Product and Category Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    require('../src/utils/areaScope')._resetCachesForTests();
  });

  it('should create a category', async () => {
    pool.query.mockResolvedValueOnce([{ insertId: 1 }]); // insert category

    const res = await request(app)
      .post('/api/admin/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Snacks',
        slug: 'snacks',
        type: 'packed',
        active: true
      });

    expect(res.statusCode).toEqual(201);
    // 1: category INSERT. 2: bustAreaCaches' bumpCatalogVersion UPDATE.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('should create a product', async () => {
    // Product INSERT now runs on a transaction connection (variant sync
    // shares the same transaction), not directly on pool.query.
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ insertId: 1 }]) // insert product
        // auto-promote-to-library (createProduct now links every new
        // product into the library so other areas can reuse it):
        .mockResolvedValueOnce([[{ id: 1, name: 'Chips', description: 'Crispy chips', image_id: null, variant_prompt: null, price: 20, library_product_id: null }]]) // SELECT product FOR UPDATE
        .mockResolvedValueOnce([{ insertId: 900 }]) // INSERT product_library
        .mockResolvedValueOnce([[]]) // SELECT product_variants (none)
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE products SET library_product_id
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValueOnce(mockConn);

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Chips',
        price: 20,
        categoryId: 1,
        unit: 'packet',
        description: 'Crispy chips',
        available: true
      });

    expect(res.statusCode).toEqual(201);
    expect(mockConn.query).toHaveBeenCalledTimes(5);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
    // bustAreaCaches' bumpCatalogVersion runs a pool.query (not on the
    // transaction connection) after commit.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('should fetch products', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Chips' }]]); // select products
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Snacks' }]]); // select categories

    const res = await request(app).get('/api/products');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.products).toHaveLength(1);
  });

  it('should not include combos in default product/category lists', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Chips', is_combo: 0 }]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/products?categoryId=1');

    expect(res.statusCode).toEqual(200);
    expect(res.body.products).toHaveLength(1);
    expect(pool.query.mock.calls[1][0]).toContain('p.is_combo = 0');
    expect(pool.query.mock.calls[1][0]).not.toContain('UNION');
    expect(pool.query.mock.calls[1][0]).not.toContain('FROM combos');
  });

  it('should reject creating a combo with zero or negative item quantities', async () => {
    const res = await request(app)
      .post('/api/admin/combos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Bad Combo',
        price: 100,
        storeType: 'packed',
        available: true,
        comboItems: [
          { productId: 1, quantity: 0 }
        ]
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.details.combo_items).toContain('quantity must be a whole number');
  });
});
