/**
 * TASK 24 — super-admin area + admin-account endpoints, clone-area, the
 * areas_sweep_complete 409 gate (§2.12, §6.6, §6.8).
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
  listAreas: jest.fn(),
  getAreaById: jest.fn(),
  invalidateAreasCache: jest.fn(),
  seedSystemStoreModes: jest.fn().mockResolvedValue(undefined),
  bustAreaCaches: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/controllers/settingsController', () => ({
  createSettingsForArea: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
}));
// materializeToArea (§4.5) is the one shared writer of library-linked
// products/variants, already covered by its own tests/productLibrary.test.js
// — cloneArea's own test only needs to assert it's CALLED with the right
// remapped params, not re-verify its internals.
jest.mock('../src/utils/productLibrary', () => ({
  materializeToArea: jest.fn(),
}));

const areaScope = require('../src/utils/areaScope');
const { createSettingsForArea } = require('../src/controllers/settingsController');
const { materializeToArea } = require('../src/utils/productLibrary');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

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

const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, timezone: 'Asia/Kolkata' };
const AREA_2 = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0, timezone: 'Asia/Kolkata' };

describe('Area + admin management (TASK 24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('access control', () => {
    it('403s an area_admin on every /admin/areas and /admin/admins route', async () => {
      const getRes = await request(app).get('/api/admin/areas').set('Authorization', `Bearer ${areaAdminToken}`);
      expect(getRes.statusCode).toEqual(403);
      const postRes = await request(app).post('/api/admin/areas').set('Authorization', `Bearer ${areaAdminToken}`).send({ code: 'A2', name: 'Area 2' });
      expect(postRes.statusCode).toEqual(403);
      const adminsRes = await request(app).get('/api/admin/admins').set('Authorization', `Bearer ${areaAdminToken}`);
      expect(adminsRes.statusCode).toEqual(403);
    });
  });

  describe('GET /admin/areas', () => {
    it('returns every area shaped with dual-cased fields', async () => {
      areaScope.listAreas.mockResolvedValueOnce([AREA_1, AREA_2]);
      const res = await request(app).get('/api/admin/areas').set('Authorization', `Bearer ${superToken}`);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[1]).toMatchObject({ id: 2, code: 'A2', isDefault: false, is_default: false });
    });
  });

  describe('POST /admin/areas (§6.6 gate)', () => {
    it('409s with AREAS_SWEEP_INCOMPLETE when the flag is not set', async () => {
      pool.query.mockResolvedValueOnce([[{ areas_sweep_complete: 0 }]]);
      const res = await request(app)
        .post('/api/admin/areas')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ code: 'A2', name: 'Area 2' });
      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toEqual('AREAS_SWEEP_INCOMPLETE');
      expect(pool.getConnection).not.toHaveBeenCalled();
    });

    it('400s when code or name is missing, even with the flag set', async () => {
      pool.query.mockResolvedValueOnce([[{ areas_sweep_complete: 1 }]]);
      const res = await request(app)
        .post('/api/admin/areas')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'No code' });
      expect(res.statusCode).toEqual(400);
    });

    it('409s on a duplicate area code', async () => {
      pool.query.mockResolvedValueOnce([[{ areas_sweep_complete: 1 }]]);
      const conn = makeConn([
        [[{ id: 2 }]], // SELECT id FROM areas WHERE code = ?
      ]);
      pool.getConnection.mockResolvedValueOnce(conn);

      const res = await request(app)
        .post('/api/admin/areas')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ code: 'A2', name: 'Area 2' });

      expect(res.statusCode).toEqual(409);
      expect(conn.rollback).toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalled();
    });

    it('creates the area + settings row + system store modes in one transaction', async () => {
      pool.query.mockResolvedValueOnce([[{ areas_sweep_complete: 1 }]]);
      const conn = makeConn([
        [[]], // duplicate-code check -> none
        [{ insertId: 2 }], // INSERT INTO areas
      ]);
      pool.getConnection.mockResolvedValueOnce(conn);
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2);

      const res = await request(app)
        .post('/api/admin/areas')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ code: 'a2', name: 'Area 2' });

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.code).toEqual('A2');
      expect(createSettingsForArea).toHaveBeenCalledWith(2, conn);
      expect(areaScope.seedSystemStoreModes).toHaveBeenCalledWith(2, conn);
      expect(conn.commit).toHaveBeenCalled();
      expect(areaScope.invalidateAreasCache).toHaveBeenCalled();
    });

    it('rolls back and rethrows when the INSERT fails mid-transaction', async () => {
      pool.query.mockResolvedValueOnce([[{ areas_sweep_complete: 1 }]]);
      const conn = makeConn([[[]]]);
      conn.query.mockResolvedValueOnce([[]]).mockRejectedValueOnce(new Error('insert failed'));
      pool.getConnection.mockResolvedValueOnce(conn);

      const res = await request(app)
        .post('/api/admin/areas')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ code: 'A2', name: 'Area 2' });

      expect(res.statusCode).toEqual(500);
      expect(conn.rollback).toHaveBeenCalled();
    });
  });

  describe('PATCH /admin/areas/:id', () => {
    it('404s for an unknown area', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(null);
      const res = await request(app)
        .patch('/api/admin/areas/99')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'New name' });
      expect(res.statusCode).toEqual(404);
    });

    it('updates the provided fields', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2).mockResolvedValueOnce({ ...AREA_2, name: 'Renamed', active: 0 });
      pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
      const res = await request(app)
        .patch('/api/admin/areas/2')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'Renamed', active: false });
      expect(res.statusCode).toEqual(200);
      expect(res.body.data.name).toEqual('Renamed');
      expect(res.body.data.active).toBe(false);
      expect(areaScope.invalidateAreasCache).toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/areas/:id (§6.8)', () => {
    it('405s and explains deactivation is the supported path', async () => {
      const res = await request(app).delete('/api/admin/areas/2').set('Authorization', `Bearer ${superToken}`);
      expect(res.statusCode).toEqual(405);
      expect(res.body.message).toMatch(/deactivate/i);
    });
  });

  describe('POST /admin/areas/:id/clone-from/:sourceId', () => {
    it('400s when source and target are the same area', async () => {
      const res = await request(app)
        .post('/api/admin/areas/1/clone-from/1')
        .set('Authorization', `Bearer ${superToken}`)
        .send({});
      expect(res.statusCode).toEqual(400);
    });

    it('404s when either area is missing', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(null).mockResolvedValueOnce(AREA_1);
      const res = await request(app)
        .post('/api/admin/areas/2/clone-from/1')
        .set('Authorization', `Bearer ${superToken}`)
        .send({});
      expect(res.statusCode).toEqual(404);
    });

    it('409s when the target area already has categories or products (24.7)', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2).mockResolvedValueOnce(AREA_1);
      const conn = makeConn([
        [[{ cnt: 3 }]], // categories count
        [[{ cnt: 0 }]], // products count
      ]);
      pool.getConnection.mockResolvedValueOnce(conn);

      const res = await request(app)
        .post('/api/admin/areas/2/clone-from/1')
        .set('Authorization', `Bearer ${superToken}`)
        .send({});
      expect(res.statusCode).toEqual(409);
      expect(conn.rollback).toHaveBeenCalled();
    });

    it('clones categories, store modes, library-linked products + variants (via materializeToArea), offers + offer_products, and dashboard sections + items', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2).mockResolvedValueOnce(AREA_1);

      const sourceCategory = { id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, active: 1, display_order: 0, library_category_id: null };
      const sourceStoreMode = { id: 20, slug: 'custom_mode', label: 'Custom', display_order: 3, active: 1, is_system: 0, icon_image_id: null, library_store_mode_id: null };
      const sourceProduct = {
        id: 30, name: 'Apple', price: 50, category_id: 10, unit: 'kg', description: null, image_id: null,
        available: 1, is_combo: 0, featured: 0, display_order: 0, original_price: null, discount_label: null,
        library_product_id: 999, shop_price: null, variant_prompt: null,
      };
      const sourceVariant = { id: 40, product_id: 30, label: '1kg', price: 50, original_price: null, available: 1, is_default: 1, display_order: 0, shop_price: null, library_variant_id: 5 };
      const sourceOffer = { id: 50, title: 'Sale', description: null, image_id: null, active: 1, store_type: 'packed', is_clickable: 0 };
      const sourceOfferProduct = { id: 60, offer_id: 50, product_id: 30, display_order: 0, active: 1 };
      const sourceSection = {
        id: 70, title: 'Featured', slug: 'featured', section_type: 'product_block', store_type: 'all', active: 1,
        display_order: 0, max_visible_items: 6, show_see_all: 1, show_hot_badge: 0, section_icon: null,
        linked_category_id: null, linked_offer_id: null,
      };
      const sourceSectionItem = { id: 80, section_id: 70, item_type: 'product', item_id: 30, display_order: 0, active: 1 };

      materializeToArea.mockResolvedValueOnce({ productId: 130, alreadyLinked: false });

      const conn = makeConn([
        [[{ cnt: 0 }]], // categories count
        [[{ cnt: 0 }]], // products count
        [[sourceCategory]], // source categories
        [{ insertId: 110 }], // INSERT category
        [[sourceStoreMode]], // source store modes
        [{ affectedRows: 1 }], // INSERT IGNORE store mode
        [[sourceProduct]], // source library-linked products
        [[sourceVariant]], // SELECT variants for product 30 (feeds variantPrices)
        // materializeToArea itself is mocked — no raw connection.query call for the INSERT
        [[sourceOffer]], // source offers
        [{ insertId: 150 }], // INSERT offer
        [[sourceOfferProduct]], // SELECT offer_products for offer 50
        [{ affectedRows: 1 }], // INSERT IGNORE offer_product
        [[sourceSection]], // source dashboard sections
        [{ insertId: 170 }], // INSERT dashboard_section
        [[sourceSectionItem]], // SELECT items for section 70
        [{ affectedRows: 1 }], // INSERT IGNORE dashboard_section_item
      ]);
      pool.getConnection.mockResolvedValueOnce(conn);

      const res = await request(app)
        .post('/api/admin/areas/2/clone-from/1')
        .set('Authorization', `Bearer ${superToken}`)
        .send({});

      expect(res.statusCode).toEqual(201);
      expect(res.body).toMatchObject({
        categoriesCloned: 1,
        storeModesCloned: 1,
        productsCloned: 1,
        offersCloned: 1,
        dashboardSectionsCloned: 1,
      });
      expect(conn.commit).toHaveBeenCalled();
      expect(areaScope.bustAreaCaches).toHaveBeenCalledWith(2);

      // Category insert targets the new area, keeps identity fields.
      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO categories'),
        [2, 'Fruits', 'fruits', 'packed', null, 1, 0, null]
      );
      // materializeToArea is called with the remapped category_id (110), the
      // TARGET area, and the library id (never the source's own product id) —
      // identity fields (name/description/image/unit) are deliberately NOT
      // passed, since materializeToArea always pulls those fresh from the
      // current library row (§2.5), not a frozen snapshot of the source.
      expect(materializeToArea).toHaveBeenCalledWith(conn, expect.objectContaining({
        libraryProductId: 999,
        areaId: 2,
        categoryId: 110,
        price: 50,
        shopPrice: null,
        available: true,
        displayOrder: 0,
        variantPrices: { 5: 50 },
      }));
      // offer_products and dashboard_section_items both remap product_id/item_id
      // through materializeToArea's returned productId (130), not the source's (30).
      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT IGNORE INTO offer_products'),
        [150, 130, 0, 1]
      );
      expect(conn.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT IGNORE INTO dashboard_section_items'),
        [170, 'product', 130, 0, 1]
      );
    });

    it('applies a price multiplier to the price/shopPrice/variantPrices passed into materializeToArea, and flat-copies original_price/discount_label/featured afterward', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2).mockResolvedValueOnce(AREA_1);
      const sourceProduct = {
        id: 30, name: 'Apple', price: 50, category_id: 10, unit: 'kg', description: null, image_id: null,
        available: 1, is_combo: 0, featured: 1, display_order: 0, original_price: 60, discount_label: 'SALE',
        library_product_id: 999, shop_price: 40, variant_prompt: null,
      };
      const sourceVariant = { id: 40, product_id: 30, label: '1kg', price: 20, original_price: null, available: 1, is_default: 1, display_order: 0, shop_price: null, library_variant_id: 5 };
      const sourceCategory = { id: 10, name: 'Fruits', slug: 'fruits', type: 'packed', image_id: null, active: 1, display_order: 0, library_category_id: null };
      materializeToArea.mockResolvedValueOnce({ productId: 130, alreadyLinked: false });

      const conn = makeConn([
        [[{ cnt: 0 }]],
        [[{ cnt: 0 }]],
        [[sourceCategory]],
        [{ insertId: 110 }],
        [[]], // no store modes
        [[sourceProduct]],
        [[sourceVariant]], // variantPrices source
        [{ affectedRows: 1 }], // follow-up UPDATE (original_price/discount_label/featured)
        [[]], // no offers
        [[]], // no sections
      ]);
      pool.getConnection.mockResolvedValueOnce(conn);

      const res = await request(app)
        .post('/api/admin/areas/2/clone-from/1')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ priceMultiplier: 1.5 });

      expect(res.statusCode).toEqual(201);
      expect(materializeToArea).toHaveBeenCalledWith(conn, expect.objectContaining({
        price: 75, // 50 * 1.5
        shopPrice: 60, // 40 * 1.5
        variantPrices: { 5: 30 }, // 20 * 1.5
      }));
      expect(conn.query).toHaveBeenCalledWith(
        'UPDATE products SET original_price = ?, discount_label = ?, featured = ? WHERE id = ?',
        [90, 'SALE', true, 130] // 60 * 1.5
      );
    });
  });

  describe('GET /admin/admins', () => {
    it('returns admins with their area code joined', async () => {
      pool.query.mockResolvedValueOnce([[
        { id: 1, username: 'super', role: 'super_admin', area_id: null, area_code: null, display_name: 'Super', active: 1, created_at: '2026-01-01' },
        { id: 2, username: 'area1', role: 'area_admin', area_id: 1, area_code: 'A1', display_name: 'Area 1 Admin', active: 1, created_at: '2026-01-01' },
      ]]);
      const res = await request(app).get('/api/admin/admins').set('Authorization', `Bearer ${superToken}`);
      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[1]).toMatchObject({ areaCode: 'A1', role: 'area_admin' });
    });
  });

  describe('POST /admin/admins (§2.9 role/area invariant)', () => {
    it('rejects a super_admin payload that also sets areaId', async () => {
      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'bad', password: 'longenough1', role: 'super_admin', areaId: 2 });
      expect(res.statusCode).toEqual(400);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects an area_admin payload with no areaId', async () => {
      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'bad', password: 'longenough1', role: 'area_admin' });
      expect(res.statusCode).toEqual(400);
    });

    it('rejects an area_admin payload pointing at an area that does not exist', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'bad', password: 'longenough1', role: 'area_admin', areaId: 999 });
      expect(res.statusCode).toEqual(400);
    });

    it('400s on a password shorter than 8 characters', async () => {
      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'short', password: 'short', role: 'super_admin' });
      expect(res.statusCode).toEqual(400);
    });

    it('409s on a duplicate username', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 1 }]]);
      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'taken', password: 'longenough1', role: 'super_admin' });
      expect(res.statusCode).toEqual(409);
    });

    it('creates an area_admin bound to a real area, with a bcrypt-hashed password', async () => {
      areaScope.getAreaById.mockResolvedValueOnce(AREA_2);
      pool.query
        .mockResolvedValueOnce([[]]) // duplicate-username check
        .mockResolvedValueOnce([{ insertId: 5 }]) // INSERT
        .mockResolvedValueOnce([[{ id: 5, username: 'area2', role: 'area_admin', area_id: 2, area_code: 'A2', display_name: null, active: 1, created_at: '2026-01-01' }]]);

      const res = await request(app)
        .post('/api/admin/admins')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ username: 'area2', password: 'longenough1', role: 'area_admin', areaId: 2 });

      expect(res.statusCode).toEqual(201);
      expect(bcrypt.hash).toHaveBeenCalledWith('longenough1', 10);
      expect(res.body.data).toMatchObject({ id: 5, role: 'area_admin', areaId: 2, areaCode: 'A2' });
      expect(res.body.data.password_hash).toBeUndefined();
    });
  });

  describe('PATCH /admin/admins/:id', () => {
    it('404s for an unknown admin', async () => {
      pool.query.mockResolvedValueOnce([[]]);
      const res = await request(app)
        .patch('/api/admin/admins/99')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ active: false });
      expect(res.statusCode).toEqual(404);
    });

    it('deactivates an admin without touching their password', async () => {
      pool.query
        .mockResolvedValueOnce([[{ id: 5, username: 'area2', role: 'area_admin', area_id: 2, active: 1 }]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ id: 5, username: 'area2', role: 'area_admin', area_id: 2, area_code: 'A2', display_name: null, active: 0, created_at: '2026-01-01' }]]);

      const res = await request(app)
        .patch('/api/admin/admins/5')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ active: false });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.active).toBe(false);
      expect(bcrypt.hash).not.toHaveBeenCalled();
    });

    it('re-validates the role/area invariant when either changes', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 5, username: 'area2', role: 'area_admin', area_id: 2, active: 1 }]]);
      const res = await request(app)
        .patch('/api/admin/admins/5')
        .set('Authorization', `Bearer ${superToken}`)
        .send({ role: 'super_admin' }); // still carries area_id: 2 from the existing row
      expect(res.statusCode).toEqual(400);
    });
  });
});
