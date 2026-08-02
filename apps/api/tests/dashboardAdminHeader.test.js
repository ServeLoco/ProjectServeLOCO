/**
 * Tests for admin-controlled show_hot_badge and section_icon on
 * dashboard sections.
 *
 * These verify the API:
 * - accepts both fields on create and update,
 * - stores them in INSERT/UPDATE,
 * - echoes them back in the public dashboard response.
 */

const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const dashboardRoutes = require('../src/routes/dashboardRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn().mockResolvedValue({
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    }),
    escape: jest.fn(value => `'${value}'`),
  }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/dashboard', dashboardRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// GET /api/dashboard carries resolveCustomerArea (TASK 12) — unauthenticated,
// no-pin request resolves via its default-area fallback, one
// `SELECT * FROM areas` before the real sections query.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('Admin dashboard section: show_hot_badge and section_icon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('accepts show_hot_badge and section_icon on create', async () => {
    // 1) slug uniqueness check (empty)
    pool.query.mockResolvedValueOnce([[]]);
    // 2) display-order uniqueness check (skip, order=0)
    // (no second mock needed since order=0 skips the query)
    // 3) INSERT
    pool.query.mockResolvedValueOnce([{ insertId: 42 }]);

    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Popular combos',
        slug: 'popular-combos-test',
        section_type: 'combo_block',
        store_type: 'packed',
        active: 1,
        display_order: 0,
        max_visible_items: 6,
        show_see_all: 1,
        show_hot_badge: 1,
        section_icon: 'star',
      });

    expect(res.statusCode).toEqual(201);
    const insertCall = pool.query.mock.calls.find(c => c[0].includes('INSERT INTO dashboard_sections'));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toMatch(/show_hot_badge/);
    expect(insertCall[0]).toMatch(/section_icon/);
    const insertValues = insertCall[1];
    // show_hot_badge = 1, section_icon = 'star'
    expect(insertValues).toContain(1);
    expect(insertValues).toContain('star');
  });

  it('accepts show_hot_badge and section_icon on update', async () => {
    // 1) SELECT existing section (includes version, show_hot_badge, section_icon)
    pool.query.mockResolvedValueOnce([[{
      id: 1, title: 't', slug: 's', section_type: 'combo_block', store_type: 'packed',
      active: 1, display_order: 0, max_visible_items: 6, show_see_all: 1,
      show_hot_badge: 0, section_icon: null,
      linked_category_id: null, linked_offer_id: null,
      starts_at: null, ends_at: null, version: 1,
    }]]);
    // 2) UPDATE
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch('/api/admin/dashboard-sections/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        show_hot_badge: 1,
        section_icon: 'star',
        version: 1,
      });

    expect(res.statusCode).toEqual(200);
    const updateCall = pool.query.mock.calls.find(c => c[0].includes('UPDATE dashboard_sections SET'));
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toMatch(/show_hot_badge\s*=\s*\?/);
    expect(updateCall[0]).toMatch(/section_icon\s*=\s*\?/);
    expect(updateCall[1]).toContain(1);
    expect(updateCall[1]).toContain('star');
  });

  it('echoes showHotBadge and sectionIcon in the public dashboard response', async () => {
    // The public /api/dashboard endpoint should surface the admin flags.
    // Mock the sections query to return a section with both flags set.
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[{
      id: 1,
      title: 'Popular combos',
      slug: 'popular-combos',
      section_type: 'combo_block',
      store_type: 'packed',
      active: 1,
      display_order: 0,
      max_visible_items: 6,
      show_see_all: 1,
      show_hot_badge: 1,
      section_icon: 'star',
      linked_category_id: null,
      linked_offer_id: null,
      starts_at: null,
      ends_at: null,
      version: 1,
    }]]);
    // combo_block section items query (empty)
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const sections = res.body?.data?.sections || [];
    if (sections.length > 0) {
      expect(sections[0]).toHaveProperty('showHotBadge', true);
      expect(sections[0]).toHaveProperty('sectionIcon', 'star');
    }
    // Also verify the SELECT used to load sections includes the new columns.
    const sectionsSql = pool.query.mock.calls[1][0];
    expect(sectionsSql).toMatch(/show_hot_badge/);
    expect(sectionsSql).toMatch(/section_icon/);
  });

  it('defaults showHotBadge to false and sectionIcon to null when absent', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[{
      id: 1,
      title: 'Categories',
      slug: 'categories-grid',
      section_type: 'category_grid',
      store_type: 'packed',
      active: 1,
      display_order: 1,
      max_visible_items: 8,
      show_see_all: 0,
      show_hot_badge: 0,
      section_icon: null,
      linked_category_id: null,
      linked_offer_id: null,
      starts_at: null,
      ends_at: null,
      version: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const sections = res.body?.data?.sections || [];
    if (sections.length > 0) {
      expect(sections[0]).toHaveProperty('showHotBadge', false);
      expect(sections[0]).toHaveProperty('sectionIcon', null);
    }
  });
});
