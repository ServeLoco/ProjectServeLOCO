/**
 * TASK 26 — category/store-mode library create/browse/add-to-area. TASK 21
 * only ever built the edit-sync direction (propagateCategoryLibraryEdit /
 * propagateStoreModeLibraryEdit); this is the create/materialize side those
 * two never got, needed once the Library admin page (TASK 26) needed a real
 * "add to area" action for these two tabs, same as the product library
 * already had since TASK 19.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/utils/areaScope', () => ({
  bustAreaCaches: jest.fn().mockResolvedValue(undefined),
  // Real resolveAdminArea middleware (unmocked, from areaMiddleware.js)
  // already sets req.areaId correctly before libraryShared.js's
  // requireOneArea reads it — mirror the real requestAreaId's pass-through
  // shape rather than mocking the whole request-resolution chain.
  requestAreaId: jest.fn((req) => req.areaId),
}));

const { requestAreaId } = require('../src/utils/areaScope');
const { materializeCategoryToArea, materializeStoreModeToArea } = require('../src/utils/productLibrary');

const fakeConn = { query: (...args) => pool.query(...args) };

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// jest.resetAllMocks() in every describe block's beforeEach wipes even a
// jest.fn(impl) implementation passed at jest.mock() factory time, not just
// ones set via .mockImplementation() later — so this has to be
// re-established fresh before every single test, not just once at module
// load, or it silently degrades to a no-op stub after the first test runs.
const resetMocksForTest = () => {
  jest.resetAllMocks();
  requestAreaId.mockImplementation((req) => req.areaId);
};

const superToken = jwt.sign(
  { id: 'super', role: 'admin', adminRole: 'super_admin', areaId: null },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);
const areaAdminToken = jwt.sign(
  { id: 'area1admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

function makeConn(responses) {
  const conn = {
    query: jest.fn(),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
  };
  for (const v of responses) conn.query.mockResolvedValueOnce(v);
  return conn;
}

describe('materializeCategoryToArea', () => {
  beforeEach(resetMocksForTest);

  it('inserts a fresh per-area category linked to the library row', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: 5, archived: 0 }]])
      .mockResolvedValueOnce([[]]) // no existing area+slug row
      .mockResolvedValueOnce([{ insertId: 300 }]); // INSERT

    const result = await materializeCategoryToArea(fakeConn, { libraryCategoryId: 10, areaId: 2 });

    expect(result).toEqual({ categoryId: 300, alreadyLinked: false });
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO categories'),
      [2, 'Fruits', 'fruits', 'packed', 5, 1, 0, 10]
    );
  });

  it('is idempotent by (area_id, slug) and back-links a pre-existing unlinked row', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, archived: 0 }]])
      .mockResolvedValueOnce([[{ id: 55, library_category_id: null }]]) // pre-existing local-only category
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // back-link UPDATE

    const result = await materializeCategoryToArea(fakeConn, { libraryCategoryId: 10, areaId: 2 });

    expect(result).toEqual({ categoryId: 55, alreadyLinked: true });
    expect(pool.query).toHaveBeenLastCalledWith(
      'UPDATE categories SET library_category_id = ? WHERE id = ?',
      [10, 55]
    );
  });

  it('throws ARCHIVED for an archived library category', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 10, archived: 1 }]]);
    await expect(materializeCategoryToArea(fakeConn, { libraryCategoryId: 10, areaId: 2 }))
      .rejects.toMatchObject({ code: 'ARCHIVED' });
  });

  it('throws NOT_FOUND for an unknown library category', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await expect(materializeCategoryToArea(fakeConn, { libraryCategoryId: 999, areaId: 2 }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Bug fix (multi-area audit finding #11): uniq_categories_area_slug
  // (area_id, slug) has no `deleted` column, so a SOFT-deleted category
  // sharing this slug still occupies the unique key even though the
  // existence check only looks at deleted = 0 rows — the INSERT used to
  // throw an uncaught ER_DUP_ENTRY (opaque 500).
  it('surfaces a clear CONFLICT (not an uncaught 500) when a soft-deleted category already holds this slug', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, archived: 0 }]])
      .mockResolvedValueOnce([[]]) // existence check finds nothing (it's soft-deleted, excluded by deleted = 0)
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' })); // INSERT collides anyway

    await expect(materializeCategoryToArea(fakeConn, { libraryCategoryId: 10, areaId: 2 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('materializeStoreModeToArea', () => {
  beforeEach(resetMocksForTest);

  it('inserts a fresh per-area store mode linked to the library row', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, slug: 'custom_mode', label: 'Custom', icon_image_id: null, is_system: 0, archived: 0 }]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 400 }]);

    const result = await materializeStoreModeToArea(fakeConn, { libraryStoreModeId: 20, areaId: 2 });

    expect(result).toEqual({ storeModeId: 400, alreadyLinked: false });
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO store_modes'),
      [2, 'custom_mode', 'Custom', 0, 1, 0, null, 20]
    );
  });

  it('links an already-seeded is_system row instead of inserting a duplicate slug', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, slug: 'packed', label: 'Packed Items', icon_image_id: null, is_system: 1, archived: 0 }]])
      .mockResolvedValueOnce([[{ id: 77, library_store_mode_id: null }]]) // auto-seeded packed row for this area
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await materializeStoreModeToArea(fakeConn, { libraryStoreModeId: 1, areaId: 2 });

    expect(result).toEqual({ storeModeId: 77, alreadyLinked: true });
    expect(pool.query).toHaveBeenLastCalledWith(
      'UPDATE store_modes SET library_store_mode_id = ? WHERE id = ?',
      [1, 77]
    );
  });
});

describe('Category library admin endpoints (TASK 26)', () => {
  beforeEach(resetMocksForTest);

  it('403s an area_admin on write routes', async () => {
    const res = await request(app)
      .post('/api/admin/category-library')
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .send({ name: 'Snacks', type: 'packed' });
    expect(res.statusCode).toEqual(403);
  });

  it('GET annotates each row with the areas that already carry it', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, archived: 0, created_at: null, updated_at: null }]])
      .mockResolvedValueOnce([[{ library_category_id: 10, area_id: 1 }, { library_category_id: 10, area_id: 2 }]]);

    const res = await request(app).get('/api/admin/category-library').set('Authorization', `Bearer ${superToken}`);
    expect(res.statusCode).toEqual(200);
    expect(res.body.data[0]).toMatchObject({ id: 10, areaIds: [1, 2] });
  });

  it('POST 409s a duplicate slug', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 5 }]]);
    const res = await request(app)
      .post('/api/admin/category-library')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Fruits', slug: 'fruits', type: 'packed' });
    expect(res.statusCode).toEqual(409);
  });

  it('POST creates a library category, slugifying the name when slug is omitted', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 11 }])
      .mockResolvedValueOnce([[{ id: 11, name: 'Dairy Products', slug: 'dairy-products', type: 'packed', image_id: null, archived: 0, created_at: null, updated_at: null }]]);

    const res = await request(app)
      .post('/api/admin/category-library')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Dairy Products', type: 'packed' });

    expect(res.statusCode).toEqual(201);
    expect(res.body.data.slug).toEqual('dairy-products');
  });

  it('PATCH propagates an identity change to every area that carries it', async () => {
    const conn = makeConn([
      [[{ id: 10 }]], // FOR UPDATE existence check
      [{ affectedRows: 1 }], // UPDATE category_library
      [[{ id: 10, name: 'Renamed', slug: 'fruits', type: 'packed', image_id: null }]], // propagateCategoryLibraryEdit's own SELECT * FROM category_library
      [[{ area_id: 1 }, { area_id: 2 }]], // propagateCategoryLibraryEdit's SELECT DISTINCT area_id
      [{ affectedRows: 1 }], // propagateCategoryLibraryEdit's per-area UPDATE categories, area 1 (bug fix #10)
      [{ affectedRows: 1 }], // propagateCategoryLibraryEdit's per-area UPDATE categories, area 2
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);
    pool.query.mockResolvedValueOnce([[{ id: 10, name: 'Renamed', slug: 'fruits', type: 'packed', image_id: null, archived: 0, created_at: null, updated_at: null }]]);

    const res = await request(app)
      .patch('/api/admin/category-library/10')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ name: 'Renamed' });

    expect(res.statusCode).toEqual(200);
    expect(conn.commit).toHaveBeenCalled();
  });

  it('PATCH does not propagate when only archiving (not an identity field)', async () => {
    const conn = makeConn([
      [[{ id: 10 }]],
      [{ affectedRows: 1 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);
    pool.query.mockResolvedValueOnce([[{ id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, archived: 1, created_at: null, updated_at: null }]]);

    const res = await request(app)
      .patch('/api/admin/category-library/10')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ archived: true });

    expect(res.statusCode).toEqual(200);
    expect(conn.query).toHaveBeenCalledTimes(2); // existence check + UPDATE only, no propagation queries
  });

  it('archive 404s an unknown id', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(app)
      .post('/api/admin/category-library/999/archive')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.statusCode).toEqual(404);
  });

  it('add-to-area requires an area (400 with no X-Area-Id for a super_admin)', async () => {
    const res = await request(app)
      .post('/api/admin/category-library/10/add-to-area')
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.statusCode).toEqual(400);
  });

  it('add-to-area 400s on an archived library item', async () => {
    const conn = makeConn([[[{ id: 10, archived: 1 }]]]);
    pool.getConnection.mockResolvedValueOnce(conn);

    const res = await request(app)
      .post('/api/admin/category-library/10/add-to-area')
      .set('Authorization', `Bearer ${areaAdminToken}`);
    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toEqual('ARCHIVED');
  });
});

describe('Store-mode library admin endpoints (TASK 26)', () => {
  beforeEach(resetMocksForTest);

  it('403s an area_admin on write routes', async () => {
    const res = await request(app)
      .post('/api/admin/store-mode-library')
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .send({ label: 'Custom' });
    expect(res.statusCode).toEqual(403);
  });

  it('POST 409s a duplicate slug', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 5 }]]);
    const res = await request(app)
      .post('/api/admin/store-mode-library')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ label: 'Packed Items', slug: 'packed' });
    expect(res.statusCode).toEqual(409);
  });

  it('POST creates a library store mode, slugifying the label when slug is omitted', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 21 }])
      .mockResolvedValueOnce([[{ id: 21, slug: 'grab_go', label: 'Grab & Go', icon_image_id: null, is_system: 0, archived: 0, created_at: null, updated_at: null }]]);

    const res = await request(app)
      .post('/api/admin/store-mode-library')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ label: 'Grab & Go' });

    expect(res.statusCode).toEqual(201);
    expect(res.body.data.slug).toEqual('grab_go');
  });

  it('GET annotates each row with the areas that already carry it', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 20, slug: 'custom_mode', label: 'Custom', icon_image_id: null, is_system: 0, archived: 0, created_at: null, updated_at: null }]])
      .mockResolvedValueOnce([[{ library_store_mode_id: 20, area_id: 1 }]]);

    const res = await request(app).get('/api/admin/store-mode-library').set('Authorization', `Bearer ${superToken}`);
    expect(res.statusCode).toEqual(200);
    expect(res.body.data[0]).toMatchObject({ id: 20, areaIds: [1] });
  });

  it('add-to-area materializes into the area_admin\'s own area', async () => {
    const conn = makeConn([
      [[{ id: 20, slug: 'custom_mode', label: 'Custom', icon_image_id: null, is_system: 0, archived: 0 }]],
      [[]],
      [{ insertId: 88 }],
    ]);
    pool.getConnection.mockResolvedValueOnce(conn);
    pool.query.mockResolvedValueOnce([[{ id: 88, area_id: 1, slug: 'custom_mode' }]]);

    const res = await request(app)
      .post('/api/admin/store-mode-library/20/add-to-area')
      .set('Authorization', `Bearer ${areaAdminToken}`);

    expect(res.statusCode).toEqual(201);
    expect(res.body.alreadyLinked).toBe(false);
  });

  // Bug fix (multi-area audit finding #7): store_modes.slug IS the
  // canonical store_type value categories/combos/offers/coupons/
  // dashboard_sections reference by string in every area — renaming it via
  // the library used to fan out through propagateStoreModeLibraryEdit's
  // batched UPDATE with zero validation, silently orphaning that reference
  // everywhere. Unlike category_library.slug (still editable — categories
  // freely rewrite their own slug per-area), this one must never be
  // PATCHable after creation.
  it('PATCH rejects a slug change — slug is immutable after creation', async () => {
    const res = await request(app)
      .patch('/api/admin/store-mode-library/20')
      .set('Authorization', `Bearer ${superToken}`)
      .send({ slug: 'renamed_mode' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toEqual('VALIDATION_ERROR');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
