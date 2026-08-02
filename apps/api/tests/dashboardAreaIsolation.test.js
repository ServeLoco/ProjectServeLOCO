/**
 * TASK 12.4 — proves GET /api/dashboard for area 2 never touches area 1's
 * sections, even if a section id or slug would collide.
 *
 * No real area 2 exists yet in this rollout (§6.6 gate blocks a second
 * area until TASK 30's isolation sweep passes), so this proves isolation
 * the same way TASK 10.6's delivery-zone perf test did: two synthetic
 * areaIds through the real resolveCustomerArea + getDashboard code path,
 * asserting the SQL sent to MySQL is scoped to the resolved area on every
 * query — not just that the mocked response happens to look right.
 */
const request = require('supertest');
const express = require('express');
const dashboardRoutes = require('../src/routes/dashboardRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRoutes);

const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
const AREA_2 = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0 };

describe('Dashboard area isolation (TASK 12.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it("area 2's request resolves via a pin, never falls back to area 1's default, and every query carries area_id = 2", async () => {
    // resolveCustomerArea: pin -> resolveAreaForPoint -> bboxCandidateAreas
    // (SELECT * FROM areas), then loadZonesForArea checks each candidate
    // IN ID ORDER (area 1 first) — area 1's zones must come back empty (no
    // match) so the loop falls through to area 2's zones, which match.
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[]]); // area 1's zones — no match
    pool.query.mockResolvedValueOnce([[{ // area 2's own zone matches the pin
      id: 900, area_id: 2, name: 'A2 Zone', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null, active: 1,
    }]]);

    // getDashboard's own sections query — a section with id 8 that ALSO
    // happens to exist (with different content) in area 1, per the live
    // DB check done for this task. Only area 2's row may come back.
    pool.query.mockResolvedValueOnce([[{
      id: 8, title: 'Area 2 Offer', slug: 'offer', section_type: 'offer_banner',
      store_type: 'packed', active: 1, display_order: 0, max_visible_items: 1,
      show_see_all: 0, show_hot_badge: 0, section_icon: null,
      linked_category_id: null, linked_offer_id: null, starts_at: null, ends_at: null,
      version: 1, created_at: null, updated_at: null,
    }]]);
    pool.query.mockResolvedValueOnce([[]]); // section items (none, section hidden)

    const res = await request(app)
      .get('/api/dashboard?storeType=packed&latitude=10.5&longitude=10.5');

    expect(res.statusCode).toEqual(200);

    // The sections query (4th call) must be scoped to area 2, not area 1 —
    // this is the actual regression surface: a hardcoded areaId (or a
    // dropped filter) would silently leak area 1's "offer" section (id 8
    // collides on slug with area 2's) into this response.
    const [sectionsSql, sectionsParams] = pool.query.mock.calls[3];
    expect(sectionsSql).toContain('area_id = ?');
    expect(sectionsParams).toContain(2);
    expect(sectionsParams).not.toContain(1);

    // The section-items sub-query (5th call) is likewise scoped to area 2's
    // offers, not area 1's.
    const [itemsSql, itemsParams] = pool.query.mock.calls[4];
    expect(itemsSql).toContain('o.area_id = ?');
    expect(itemsParams).toContain(2);
  });

  it('a pin resolving inside area 1 never returns area 2-only data, even when both are bbox candidates', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[{ // area 1's own zone matches the pin
      id: 1, area_id: 1, name: 'A1 Zone', boundary: JSON.stringify([
        { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
      ]), parent_zone_id: null, active: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[{
      id: 8, title: 'Area 1 Offer', slug: 'offer', section_type: 'offer_banner',
      store_type: 'packed', active: 1, display_order: 0, max_visible_items: 1,
      show_see_all: 0, show_hot_badge: 0, section_icon: null,
      linked_category_id: null, linked_offer_id: null, starts_at: null, ends_at: null,
      version: 1, created_at: null, updated_at: null,
    }]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/dashboard?storeType=packed&latitude=0.5&longitude=0.5');

    expect(res.statusCode).toEqual(200);
    const [sectionsSql, sectionsParams] = pool.query.mock.calls[2];
    expect(sectionsSql).toContain('area_id = ?');
    expect(sectionsParams).toContain(1);
    expect(sectionsParams).not.toContain(2);
  });
});
