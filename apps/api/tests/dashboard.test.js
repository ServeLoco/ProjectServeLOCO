const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const dashboardRoutes = require('../src/routes/dashboardRoutes');
const { pool } = require('../src/db/mysql');
const { getDb } = require('../src/db/mongodb');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn()
  }
}));

jest.mock('../src/db/mongodb', () => ({
  getDb: jest.fn()
}));

const mockDb = {
  collection: () => ({
    find: () => ({
      toArray: jest.fn().mockResolvedValue([])
    })
  })
};
getDb.mockReturnValue(mockDb);

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');
const { clearAll: clearMicroCache } = require('../src/utils/microCache');
const areaScope = require('../src/utils/areaScope');

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// GET /api/dashboard carries resolveCustomerArea (TASK 12) — unauthenticated,
// no-pin request resolves via its default-area fallback, one
// `SELECT * FROM areas` before the real sections query.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('Dashboard Public and Admin API Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearMicroCache();
    areaScope._resetCachesForTests();
  });

  describe('Public API: GET /api/dashboard', () => {
    it('should return dynamic dashboard sections', async () => {
      mockDefaultAreaLookup();
      pool.query.mockResolvedValueOnce([[
        {
          id: 1,
          title: 'Popular Combos',
          slug: 'popular-combos',
          section_type: 'combo_block',
          store_type: 'fast_food',
          active: 1,
          display_order: 0,
          max_visible_items: 6,
          show_see_all: 1
        }
      ]]);

      pool.query.mockResolvedValueOnce([[
        {
          id: 10,
          name: 'Burger & Fries Combo',
          price: 150,
          is_combo: 1,
          available: 1,
          deleted: 0,
          category_type: 'fast_food',
          section_item_id: 100
        }
      ]]);

      pool.query.mockResolvedValueOnce([[
        {
          combo_product_id: 10,
          product_id: 20,
          quantity: 1,
          display_order: 0,
          id: 20,
          name: 'Burger',
          price: 100,
          available: 1,
          is_combo: 0
        }
      ]]);

      const res = await request(app).get('/api/dashboard?storeType=fast_food');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.sections).toHaveLength(1);
      expect(res.body.data.sections[0].title).toEqual('Popular Combos');
      expect(res.body.data.sections[0].items[0].name).toEqual('Burger & Fries Combo');
      expect(res.body.data.sections[0].items[0].comboItems).toHaveLength(1);
    });

    it('product_block: relaxes the available filter and still returns a toggled-off product when include_closed_shops=1', async () => {
      mockDefaultAreaLookup();
      pool.query.mockResolvedValueOnce([[
        {
          id: 3,
          title: 'Fresh Picks',
          slug: 'fresh-picks',
          section_type: 'product_block',
          store_type: 'packed',
          active: 1,
          display_order: 0,
          max_visible_items: 8,
          show_see_all: 1
        }
      ]]);

      pool.query.mockResolvedValueOnce([[
        {
          id: 30,
          name: 'Toggled-off Product',
          price: 40,
          available: 0, // shop owner turned this off — must still come back
          deleted: 0,
          category_type: 'packed',
          section_item_id: 300,
          shop_is_open: 1
        }
      ]]);

      pool.query.mockResolvedValueOnce([[]]); // attachVariants query for product id 30

      const res = await request(app).get('/api/dashboard?storeType=packed&include_closed_shops=1');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.sections).toHaveLength(1);
      expect(res.body.data.sections[0].items).toHaveLength(1);
      expect(res.body.data.sections[0].items[0].available).toEqual(0);

      // The relaxed clause must actually be sent to MySQL — the query-string
      // is the real regression surface here (mocked DB can't filter for us).
      const productQueryCall = pool.query.mock.calls.find(call => /FROM dashboard_section_items dsi\s+JOIN products p/.test(call[0]));
      expect(productQueryCall[0]).toMatch(/1=1 AND p\.deleted = 0/);
      expect(productQueryCall[0]).not.toMatch(/p\.available = 1/);
    });

    it('product_block: keeps the strict available filter when include_closed_shops is not set', async () => {
      mockDefaultAreaLookup();
      pool.query.mockResolvedValueOnce([[
        {
          id: 4,
          title: 'Fresh Picks',
          slug: 'fresh-picks-2',
          section_type: 'product_block',
          store_type: 'packed',
          active: 1,
          display_order: 0,
          max_visible_items: 8,
          show_see_all: 1
        }
      ]]);
      pool.query.mockResolvedValueOnce([[]]);

      const res = await request(app).get('/api/dashboard?storeType=packed');

      expect(res.statusCode).toEqual(200);
      const productQueryCall = pool.query.mock.calls.find(call => /FROM dashboard_section_items dsi\s+JOIN products p/.test(call[0]));
      expect(productQueryCall[0]).toMatch(/p\.available = 1 AND p\.deleted = 0/);
    });

    it('should hide the category section when no items are explicitly assigned', async () => {
      mockDefaultAreaLookup();
      pool.query.mockResolvedValueOnce([[
        {
          id: 2,
          title: 'Shop by Category',
          slug: 'categories-grid',
          section_type: 'category_grid',
          store_type: 'packed',
          active: 1,
          display_order: 1,
          max_visible_items: 8,
          show_see_all: 0
        }
      ]]);

      // No dashboard_section_items rows linked to this section.
      pool.query.mockResolvedValueOnce([[]]);

      const res = await request(app).get('/api/dashboard?storeType=packed');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.sections).toHaveLength(0);
    });

    it('should hide the offer banner section when linked items are stale or inactive', async () => {
      mockDefaultAreaLookup();
      pool.query.mockResolvedValueOnce([[
        {
          id: 5,
          title: 'Special Offers',
          slug: 'hero-offers',
          section_type: 'offer_banner',
          store_type: 'fast_food',
          active: 1,
          display_order: 0,
          max_visible_items: 1,
          show_see_all: 0
        }
      ]]);

      // Linked dashboard rows are stale, inactive, or missing for this section.
      pool.query.mockResolvedValueOnce([[]]);

      const res = await request(app).get('/api/dashboard?storeType=fast_food');

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.sections).toHaveLength(0);
    });
  });

  describe('Admin Section Management', () => {
    it('should list all sections for admin', async () => {
      pool.query.mockResolvedValueOnce([[
        { id: 1, title: 'Hero Banners', slug: 'hero-banners', section_type: 'offer_banner', display_order: 0 }
      ]]);

      const res = await request(app)
        .get('/api/admin/dashboard-sections')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toEqual('Hero Banners');
    });

    it('should create a dashboard section', async () => {
      // Mock existing slug query (returns none)
      pool.query.mockResolvedValueOnce([[]]);
      // Mock insert query
      pool.query.mockResolvedValueOnce([{ insertId: 2 }]);

      const res = await request(app)
        .post('/api/admin/dashboard-sections')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Daily Essentials',
          slug: 'daily-essentials',
          section_type: 'product_block',
          store_type: 'packed',
          active: 1,
          max_visible_items: 6,
          show_see_all: 1
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.id).toEqual(2);
    });

    it('should reject creating a section with duplicate slug', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 1 }]]); // existing slug found

      const res = await request(app)
        .post('/api/admin/dashboard-sections')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Daily Essentials',
          slug: 'daily-essentials',
          section_type: 'product_block',
          store_type: 'packed'
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toEqual('VALIDATION_ERROR');
    });

    it('should update section properties with version verification', async () => {
      // Mock get section
      pool.query.mockResolvedValueOnce([[
        { id: 1, title: 'Old Title', slug: 'old-title', store_type: 'packed', version: 5 }
      ]]);
      // Mock update section
      pool.query.mockResolvedValueOnce([{}]);

      const res = await request(app)
        .patch('/api/admin/dashboard-sections/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'New Title',
          version: 5
        });

      expect(res.statusCode).toEqual(200);
      expect(res.body.version).toEqual(6);
    });

    it('should reject updating section properties on version conflict', async () => {
      // Mock get section
      pool.query.mockResolvedValueOnce([[
        { id: 1, title: 'Old Title', slug: 'old-title', store_type: 'packed', version: 5 }
      ]]);

      const res = await request(app)
        .patch('/api/admin/dashboard-sections/1')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'New Title',
          version: 4 // stale version
        });

      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toEqual('CONCURRENCY_CONFLICT');
    });

    it('should delete a section', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 1 }]]); // exists
      pool.query.mockResolvedValueOnce([{}]); // soft-delete section
      pool.query.mockResolvedValueOnce([{}]); // soft-delete its items

      const res = await request(app)
        .delete('/api/admin/dashboard-sections/1')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toEqual(200);
    });
  });

  describe('Section Items Assignment', () => {
    it('should add item to section after validation', async () => {
      // Mock get section
      pool.query.mockResolvedValueOnce([[
        { id: 1, section_type: 'product_block', store_type: 'packed' }
      ]]);
      // Mock product validation (exists, not combo)
      pool.query.mockResolvedValueOnce([[
        { id: 50, is_combo: 0, type: 'packed' }
      ]]);
      // Mock duplicate check (returns none)
      pool.query.mockResolvedValueOnce([[]]);
      // Mock display order duplicate check (returns none)
      pool.query.mockResolvedValueOnce([[]]);
      // Mock insert item
      pool.query.mockResolvedValueOnce([{ insertId: 500 }]);
      // bustAreaCaches' bumpCatalogVersion UPDATE
      pool.query.mockResolvedValueOnce([{}]);
      // Mock hydration fetch of the newly-added product (returned inline so the
      // admin UI can show it without a full section refetch)
      pool.query.mockResolvedValueOnce([[{ id: 50, name: 'Milk', is_combo: 0 }]]);

      const res = await request(app)
        .post('/api/admin/dashboard-sections/1/items')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          item_type: 'product',
          item_id: 50,
          display_order: 1
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.id).toEqual(500);
      expect(res.body.data.details.name).toEqual('Milk');
    });

    it('should reject duplicate item in same section', async () => {
      // Mock get section
      pool.query.mockResolvedValueOnce([[
        { id: 1, section_type: 'product_block', store_type: 'packed' }
      ]]);
      // Mock product validation
      pool.query.mockResolvedValueOnce([[
        { id: 50, is_combo: 0, type: 'packed' }
      ]]);
      // Mock duplicate check (finds duplicate)
      pool.query.mockResolvedValueOnce([[{ id: 500 }]]);

      const res = await request(app)
        .post('/api/admin/dashboard-sections/1/items')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          item_type: 'product',
          item_id: 50
        });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toEqual('VALIDATION_ERROR');
    });

    it('should remove item from section', async () => {
      // Mock existing check
      pool.query.mockResolvedValueOnce([[{ id: 500 }]]);
      // Mock update soft delete
      pool.query.mockResolvedValueOnce([{}]);

      const res = await request(app)
        .delete('/api/admin/dashboard-sections/1/items/500')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toEqual(200);
    });
  });
});
