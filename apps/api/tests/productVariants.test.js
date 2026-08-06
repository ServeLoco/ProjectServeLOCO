/**
 * Product Variants — API tests (VARIANTS TASK 5).
 *
 * Covers:
 *  1. Product read paths embed variants / hasVariants / minPrice.
 *  2. Admin validation: duplicate labels, multiple defaults, max 20.
 *  3. Admin upsert: products.price re-syncs to default variant; omitted ids
 *     get soft-deleted; variants: undefined leaves variants untouched.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const productRoutes = require('../src/routes/productRoutes');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'secret'
);

const readApp = express();
readApp.use(express.json());
readApp.use('/api/products', productRoutes);

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// Both GET /api/products and GET /api/products/:id carry resolveCustomerArea
// (TASK 11 / bug fix multi-area audit finding #4) — an unauthenticated,
// no-pin request resolves via its default-area fallback, one
// `SELECT * FROM areas` before the real query.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('Product Variants — read paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('getProducts embeds variants, hasVariants, has_variants, minPrice, min_price', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[
      { id: 1, name: 'Pizza', price: 349, is_combo: 0, available: 1, image_id: null, available_from_time: null, available_until_time: null },
      { id: 2, name: 'Burger', price: 99, is_combo: 0, available: 1, image_id: null, available_from_time: null, available_until_time: null },
    ]]);
    pool.query.mockResolvedValueOnce([[
      { id: 10, product_id: 1, label: 'Small', price: 149, original_price: null, available: 1, is_default: 1, display_order: 0 },
      { id: 11, product_id: 1, label: 'Large', price: 349, original_price: null, available: 1, is_default: 0, display_order: 1 },
    ]]);
    pool.query.mockResolvedValue([[]]);

    const res = await request(readApp).get('/api/products');

    expect(res.statusCode).toEqual(200);
    const products = res.body.products;
    expect(products).toHaveLength(2);

    const pizza = products.find(p => p.id === 1);
    expect(pizza.variants).toHaveLength(2);
    expect(pizza.hasVariants).toBe(true);
    expect(pizza.has_variants).toBe(true);
    expect(pizza.minPrice).toBe(149);
    expect(pizza.min_price).toBe(149);
    expect(pizza.variantPrompt).toBeNull();
    expect(pizza.variants[0]).toMatchObject({ id: 10, label: 'Small', price: 149, isDefault: true, is_default: true });
    expect(pizza.variants[1]).toMatchObject({ id: 11, label: 'Large', price: 349, isDefault: false });

    const burger = products.find(p => p.id === 2);
    expect(burger.variants).toEqual([]);
    expect(burger.hasVariants).toBe(false);
    expect(burger.has_variants).toBe(false);
    expect(burger.minPrice).toBe(99);
  });

  it('getProductById embeds variants and variantPrompt', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[
      { id: 1, name: 'Pizza', price: 349, is_combo: 0, available: 1, image_id: null, category_name: 'Food', category_type: 'fast_food', available_from_time: null, available_until_time: null, variant_prompt: 'Choose size' },
    ]]);
    pool.query.mockResolvedValueOnce([[
      { id: 10, product_id: 1, label: 'Small', price: 149, original_price: 199, available: 1, is_default: 1, display_order: 0 },
      { id: 11, product_id: 1, label: 'Large', price: 349, original_price: null, available: 1, is_default: 0, display_order: 1 },
    ]]);
    pool.query.mockResolvedValue([[]]);

    const res = await request(readApp).get('/api/products/1');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.variants).toHaveLength(2);
    expect(res.body.data.hasVariants).toBe(true);
    expect(res.body.data.minPrice).toBe(149);
    expect(res.body.data.variantPrompt).toBe('Choose size');
    expect(res.body.data.variants[0].originalPrice).toBe(199);
    expect(res.body.data.variants[0].original_price).toBe(199);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Admin product validation — variant rules
// ─────────────────────────────────────────────────────────────────────────

const adminApp = express();
adminApp.use(express.json());
adminApp.use('/api/admin', adminRoutes);

describe('Product Variants — admin validation', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('rejects duplicate variant labels (case-insensitive)', async () => {
    const res = await request(adminApp)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Pizza', price: 149, category_id: 1,
        variants: [
          { label: 'Small', price: 149, is_default: true },
          { label: 'small', price: 249, is_default: false },
        ],
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toHaveProperty('variants');
    expect(res.body.details.variants).toContain('duplicate label');
  });

  it('rejects more than one default variant', async () => {
    const res = await request(adminApp)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Pizza', price: 149, category_id: 1,
        variants: [
          { label: 'Small', price: 149, is_default: true },
          { label: 'Large', price: 349, is_default: true },
        ],
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.details.variants).toContain('Exactly one variant');
  });

  it('rejects more than 20 variants', async () => {
    const variants = Array.from({ length: 21 }, (_, i) => ({
      label: `V${i + 1}`, price: 100 + i, is_default: i === 0,
    }));
    const res = await request(adminApp)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Pizza', price: 100, category_id: 1, variants });

    expect(res.statusCode).toEqual(400);
    expect(res.body.details.variants).toContain('at most 20');
  });

  it('auto-marks the first variant as default when none is marked', async () => {
    // Product INSERT and variant sync now run on the same transaction connection.
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ insertId: 500 }]) // INSERT product
        .mockResolvedValueOnce([{ insertId: 601 }]) // INSERT variant 1
        .mockResolvedValueOnce([{ insertId: 602 }]) // INSERT variant 2
        .mockResolvedValueOnce([{ affectedRows: 0 }]) // soft-delete missing
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // price sync
        .mockResolvedValueOnce([[{ price: 149, shop_price: null }]]) // re-read default variant
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // shop_price mirror sync
        // auto-promote-to-library (createProduct now links every new
        // product into the library so other areas can reuse it):
        .mockResolvedValueOnce([[{ id: 500, name: 'Pizza', description: null, image_id: null, variant_prompt: null, price: 149, library_product_id: null }]]) // SELECT product FOR UPDATE
        .mockResolvedValueOnce([{ insertId: 900 }]) // INSERT product_library
        .mockResolvedValueOnce([[]]) // SELECT product_variants (mocked empty — promote's own variant fan-out is covered by tests/productLibrary.test.js)
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE products SET library_product_id
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Pizza', price: 149, category_id: 1, display_order: 0,
        variants: [
          { label: 'Small', price: 149 },
          { label: 'Large', price: 349 },
        ],
      });

    expect(res.statusCode).toEqual(201);
    const priceSyncCall = mockConn.query.mock.calls.find(
      c => c[0] === 'UPDATE products SET price = ? WHERE id = ?'
    );
    expect(priceSyncCall).toBeDefined();
    expect(priceSyncCall[1][0]).toBe(149); // auto-marked default = first variant
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Admin upsert — products.price sync and soft-delete semantics
// ─────────────────────────────────────────────────────────────────────────

describe('Product Variants — admin upsert', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('createProduct syncs products.price to the default variant', async () => {
    // Product INSERT and variant sync now run on the same transaction connection.
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ insertId: 500 }]) // INSERT INTO products
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE variant_prompt
        .mockResolvedValueOnce([{ insertId: 601 }]) // INSERT variant Small
        .mockResolvedValueOnce([{ insertId: 602 }]) // INSERT variant Medium
        .mockResolvedValueOnce([{ insertId: 603 }]) // INSERT variant Large
        .mockResolvedValueOnce([{ affectedRows: 0 }]) // soft-delete not-in-payload
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // price sync
        .mockResolvedValueOnce([[{ price: 149, shop_price: null }]]) // re-read default variant
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // shop_price mirror sync
        // auto-promote-to-library (createProduct now links every new
        // product into the library so other areas can reuse it):
        .mockResolvedValueOnce([[{ id: 500, name: 'Pizza', description: null, image_id: null, variant_prompt: 'Choose size', price: 149, library_product_id: null }]]) // SELECT product FOR UPDATE
        .mockResolvedValueOnce([{ insertId: 900 }]) // INSERT product_library
        .mockResolvedValueOnce([[]]) // SELECT product_variants (mocked empty — promote's own variant fan-out is covered by tests/productLibrary.test.js)
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE products SET library_product_id
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Pizza', price: 149, category_id: 1, display_order: 0,
        variant_prompt: 'Choose size',
        variants: [
          { label: 'Small', price: 149, is_default: true },
          { label: 'Medium', price: 249, is_default: false },
          { label: 'Large', price: 349, is_default: false },
        ],
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.id).toBe(500);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
    expect(mockConn.release).toHaveBeenCalledTimes(1);

    const priceSyncCall = mockConn.query.mock.calls.find(
      c => c[0] === 'UPDATE products SET price = ? WHERE id = ?'
    );
    expect(priceSyncCall).toBeDefined();
    expect(priceSyncCall[1][0]).toBe(149);
    expect(priceSyncCall[1][1]).toBe(500);
  });

  it('updateProduct soft-deletes omitted variant ids and keeps existing ids', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, image_id: null }]]); // SELECT existing
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE combo_items

    // UPDATE products and variant sync now run on the same transaction connection.
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE existing variant id=10
        .mockResolvedValueOnce([{ insertId: 601 }])   // INSERT new variant
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // soft-delete NOT IN (10, 601)
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // price sync
        .mockResolvedValueOnce([[{ price: 149, shop_price: null }]]) // re-read default variant
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // shop_price mirror sync
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .put('/api/admin/products/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Pizza', price: 149, category_id: 1, display_order: 0,
        variants: [
          { id: 10, label: 'Small', price: 149, is_default: true },
          { label: 'X-Large', price: 449, is_default: false },
        ],
      });

    expect(res.statusCode).toEqual(200);

    const updateByIdCall = mockConn.query.mock.calls.find(
      c => c[0].includes('UPDATE product_variants SET') && c[0].includes('WHERE id = ? AND product_id = ?')
    );
    expect(updateByIdCall).toBeDefined();
    expect(updateByIdCall[1][6]).toBe(10);
    expect(updateByIdCall[1][7]).toBe(1);

    const softDeleteCall = mockConn.query.mock.calls.find(
      c => c[0].includes('SET deleted = 1') && c[0].includes('NOT IN')
    );
    expect(softDeleteCall).toBeDefined();
    expect(softDeleteCall[1][0]).toBe(1);
    expect(softDeleteCall[1][1]).toEqual(expect.arrayContaining([10, 601]));
  });

  it('updateProduct with variants: undefined leaves variants untouched', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, image_id: null }]]); // SELECT existing
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE combo_items

    // The product UPDATE itself is transactional, so a connection is always
    // opened — but syncProductVariants must not run any variant queries.
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE products
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .put('/api/admin/products/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Pizza', price: 149, category_id: 1, display_order: 0 });

    expect(res.statusCode).toEqual(200);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
    expect(mockConn.query).toHaveBeenCalledTimes(1); // only the product UPDATE, no variant queries
  });

  it('updateProduct with variants: [] soft-deletes all variants', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, image_id: null }]]);
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // DELETE combo_items

    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products
        .mockResolvedValueOnce([{ affectedRows: 2 }]), // soft-delete ALL
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .put('/api/admin/products/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Pizza', price: 149, category_id: 1, display_order: 0, variants: [] });

    expect(res.statusCode).toEqual(200);
    const softDeleteCall = mockConn.query.mock.calls.find(
      c => c[0].includes('SET deleted = 1') && !c[0].includes('NOT IN')
    );
    expect(softDeleteCall).toBeDefined();
    const priceSyncCall = mockConn.query.mock.calls.find(
      c => c[0] === 'UPDATE products SET price = ? WHERE id = ?'
    );
    expect(priceSyncCall).toBeUndefined();
  });
});


