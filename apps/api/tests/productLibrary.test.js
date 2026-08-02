/**
 * TASK 19 — materializeToArea (src/utils/productLibrary.js) and the library
 * admin endpoints. materializeToArea is the ONLY writer of
 * products.library_product_id — everything (add-to-area, add-to-areas,
 * promote) either calls it directly or exercises the same insert/variant
 * path it shares with productController's syncProductVariants.
 */
jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/utils/areaScope', () => ({
  requestAreaId: jest.fn(),
  bustAreaCaches: jest.fn().mockResolvedValue(undefined),
}));

const { pool } = require('../src/db/mysql');
const { requestAreaId } = require('../src/utils/areaScope');
const { materializeToArea, LibraryError } = require('../src/utils/productLibrary');

// materializeToArea takes a "connection" — a fake whose .query delegates to
// the same jest.fn() as pool.query, so a single ordered mock queue drives
// both the direct calls and syncProductVariants' own queries underneath it.
const fakeConn = { query: (...args) => pool.query(...args) };

describe('materializeToArea', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is idempotent: an existing (libraryProductId, areaId) link returns alreadyLinked without inserting', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 501 }]]); // existing products row

    const result = await materializeToArea(fakeConn, {
      libraryProductId: 10, areaId: 1, categoryId: 3, price: 40,
    });

    expect(result).toEqual({ productId: 501, alreadyLinked: true });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('materializes a fresh product with copied identity and variant labels', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // no existing link
      .mockResolvedValueOnce([[{ // library row
        id: 10, name: 'Amul Milk', description: 'Fresh milk', image_id: '77',
        unit_id: null, variant_prompt: 'Choose size', suggested_price: 30, archived: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 3 }]]) // category exists in this area
      .mockResolvedValueOnce([[ // library_variants
        { id: 900, label: '500ml', display_order: 0, is_default: 1 },
        { id: 901, label: '1L', display_order: 1, is_default: 0 },
      ]])
      .mockResolvedValueOnce([{ insertId: 501 }]) // INSERT INTO products
      // syncProductVariants: variant_prompt write, 2 variant inserts, then the price-mirror UPDATE(s).
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products SET variant_prompt
      .mockResolvedValueOnce([{ insertId: 1001 }]) // variant 1 insert
      .mockResolvedValueOnce([{ insertId: 1002 }]) // variant 2 insert
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // soft-delete stale variants (none)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // products.price sync
      .mockResolvedValueOnce([[{ price: 40, shop_price: null }]]) // syncProductFromDefaultVariant read
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // syncProductFromDefaultVariant write

    const result = await materializeToArea(fakeConn, {
      libraryProductId: 10, areaId: 1, categoryId: 3, price: 40,
      variantPrices: { 900: 35, 901: 60 },
    });

    expect(result).toEqual({ productId: 501, alreadyLinked: false });

    const productInsertCall = pool.query.mock.calls[4];
    expect(productInsertCall[0]).toContain('INSERT INTO products');
    expect(productInsertCall[1]).toEqual(expect.arrayContaining(['Amul Milk', 'Fresh milk', '77', 10]));

    const variant1Insert = pool.query.mock.calls[6];
    expect(variant1Insert[0]).toContain('INSERT INTO product_variants');
    expect(variant1Insert[1]).toEqual(expect.arrayContaining([501, '500ml', 35, 900]));
    const variant2Insert = pool.query.mock.calls[7];
    expect(variant2Insert[1]).toEqual(expect.arrayContaining([501, '1L', 60, 901]));
  });

  it('rejects materializing an archived library item', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 10, name: 'X', archived: 1 }]]);

    await expect(materializeToArea(fakeConn, { libraryProductId: 10, areaId: 1, categoryId: 3 }))
      .rejects.toMatchObject({ code: 'ARCHIVED' });
  });

  it('rejects an unknown categoryId for the target area', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 10, name: 'X', archived: 0, suggested_price: 10 }]])
      .mockResolvedValueOnce([[]]); // no matching category row

    const err = await materializeToArea(fakeConn, { libraryProductId: 10, areaId: 1, categoryId: 999 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('19.8 — the same library item materialized into two areas keeps identical name/image/variant labels at different prices', async () => {
    const libRow = {
      id: 20, name: 'Maggi Noodles', description: 'Instant noodles', image_id: '55',
      unit_id: null, variant_prompt: null, suggested_price: 12, archived: 0,
    };
    const libVariants = [{ id: 950, label: 'Single Pack', display_order: 0, is_default: 1 }];

    // Area 1 @ price 12
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[libRow]])
      .mockResolvedValueOnce([[{ id: 3 }]])
      .mockResolvedValueOnce([libVariants])
      .mockResolvedValueOnce([{ insertId: 601 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products SET variant_prompt
      .mockResolvedValueOnce([{ insertId: 1101 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ price: 12, shop_price: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const area1 = await materializeToArea(fakeConn, { libraryProductId: 20, areaId: 1, categoryId: 3, price: 12 });

    // Area 2 @ price 15 (different price, same identity)
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[libRow]])
      .mockResolvedValueOnce([[{ id: 7 }]])
      .mockResolvedValueOnce([libVariants])
      .mockResolvedValueOnce([{ insertId: 602 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products SET variant_prompt
      .mockResolvedValueOnce([{ insertId: 1102 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ price: 15, shop_price: null }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);
    const area2 = await materializeToArea(fakeConn, { libraryProductId: 20, areaId: 2, categoryId: 7, price: 15 });

    expect(area1.productId).toBe(601);
    expect(area2.productId).toBe(602);

    // INSERT INTO products (area_id, name, price, shop_price, category_id, unit,
    //   description, image_id, available, is_combo, featured, display_order,
    //   shop_id, variant_prompt, library_product_id)
    const area1ProductInsert = pool.query.mock.calls[4][1];
    const area2ProductInsert = pool.query.mock.calls[15][1];
    expect(area1ProductInsert[0]).toBe(1); // area_id
    expect(area1ProductInsert.slice(2, 5)).toEqual([12, null, 3]); // price, shop_price, category_id
    expect(area2ProductInsert[0]).toBe(2);
    expect(area2ProductInsert.slice(2, 5)).toEqual([15, null, 7]);
    // name (1), description (6), image_id (7) identical across both areas.
    expect(area1ProductInsert[1]).toEqual(area2ProductInsert[1]);
    expect(area1ProductInsert[6]).toEqual(area2ProductInsert[6]);
    expect(area1ProductInsert[7]).toEqual(area2ProductInsert[7]);

    const area1VariantInsert = pool.query.mock.calls[6][1];
    const area2VariantInsert = pool.query.mock.calls[17][1];
    expect(area1VariantInsert[1]).toBe('Single Pack');
    expect(area2VariantInsert[1]).toBe('Single Pack');
  });
});

describe('Library controller — add-to-area / add-to-areas / promote (route-level)', () => {
  const request = require('supertest');
  const express = require('express');

  jest.mock('../src/middleware/authMiddleware', () => ({
    requireCustomer: (req, res, next) => next(),
    requireAdmin: (req, res, next) => {
      req.admin = { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 };
      req.areaId = 1;
      next();
    },
    requireSuperAdmin: (req, res, next) => next(),
  }));

  let app;
  let adminRoutes;

  beforeAll(() => {
    requestAreaId.mockImplementation(() => 1);
    adminRoutes = require('../src/routes/adminRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/admin', adminRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    requestAreaId.mockImplementation(() => 1);
    pool.getConnection.mockResolvedValue({
      query: (...args) => pool.query(...args),
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    });
  });

  it('POST /library/:id/add-to-area returns 200 + already_linked when the area already has it', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 501 }]]) // existing link
      .mockResolvedValueOnce([[{ id: 501, name: 'Amul Milk' }]]); // re-select for response

    const res = await request(app)
      .post('/api/admin/library/10/add-to-area')
      .send({ categoryId: 3, price: 40 });

    expect(res.statusCode).toBe(200);
    expect(res.body.alreadyLinked).toBe(true);
  });

  it('POST /library/:id/promote-to-library lifts a product into a new library item and links it back', async () => {
    pool.query
      .mockResolvedValueOnce([[{ // source product
        id: 501, name: 'Amul Milk', description: 'Fresh', image_id: '77',
        variant_prompt: null, price: 40, library_product_id: null,
      }]])
      .mockResolvedValueOnce([{ insertId: 20 }]) // INSERT product_library
      .mockResolvedValueOnce([[{ id: 1001, label: '500ml', display_order: 0, is_default: 1 }]]) // variants
      .mockResolvedValueOnce([{ insertId: 950 }]) // INSERT library_variants
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE product_variants.library_variant_id
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE products.library_product_id
      .mockResolvedValueOnce([[{ id: 20, name: 'Amul Milk', archived: 0 }]]); // re-select

    const res = await request(app).post('/api/admin/products/501/promote-to-library');

    expect(res.statusCode).toBe(201);
    expect(res.body.data.id).toBe(20);
    const libraryVariantInsert = pool.query.mock.calls[3];
    expect(libraryVariantInsert[0]).toContain('INSERT INTO library_variants');
    const linkBackCall = pool.query.mock.calls[5];
    expect(linkBackCall[0]).toContain('UPDATE products SET library_product_id');
  });

  it('promote-to-library rejects a product already linked to the library', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 501, library_product_id: 20 }]]);
    const res = await request(app).post('/api/admin/products/501/promote-to-library');
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ALREADY_LINKED');
  });
});
