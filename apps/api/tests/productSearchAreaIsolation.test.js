/**
 * TASK 22.7 — a customer search in area 2 returns zero area 1 products.
 *
 * No real area 2 exists yet in this rollout (§6.6 gate), so this proves
 * isolation the same way TASK 12.4's dashboardAreaIsolation.test.js did:
 * two synthetic areaIds through the real resolveCustomerArea + getProducts
 * code path, asserting the actual SQL sent to MySQL is scoped to the
 * resolved area — not just that the mocked response happens to look right.
 * Also proves the LIKE '%term%' full scan (§3.11) was actually replaced by
 * a FULLTEXT MATCH ... AGAINST ... IN BOOLEAN MODE.
 */
const request = require('supertest');
const express = require('express');
const productRoutes = require('../src/routes/productRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), escape: jest.fn((value) => `'${value}'`) },
}));

const app = express();
app.use(express.json());
app.use('/api/products', productRoutes);

const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
const AREA_2 = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0 };

describe('Product search area isolation + fulltext (TASK 22.7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it("a pin resolving into area 2 searches products with area_id = 2 via MATCH ... AGAINST, never area 1", async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[]]); // area 1's zones — no match
    pool.query.mockResolvedValueOnce([[{ // area 2's own zone matches the pin
      id: 900, area_id: 2, name: 'A2 Zone', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null, active: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[]]); // product search — empty result

    const res = await request(app)
      .get('/api/products?search=milk&latitude=10.5&longitude=10.5');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.products).toEqual([]);

    const [productSql] = pool.query.mock.calls[3];
    expect(productSql).toContain('p.area_id = 2');
    expect(productSql).not.toContain('p.area_id = 1');
    expect(productSql).toContain('MATCH(p.name) AGAINST');
    expect(productSql).toContain('IN BOOLEAN MODE');
    expect(productSql).not.toMatch(/LIKE '%milk%'/);
  });

  it('a pin resolving into area 1 searches with area_id = 1, never area 2, even with both as bbox candidates', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]); // bbox candidates
    pool.query.mockResolvedValueOnce([[{ // area 1's own zone matches the pin
      id: 1, area_id: 1, name: 'A1 Zone', boundary: JSON.stringify([
        { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
      ]), parent_zone_id: null, active: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[]]); // product search

    const res = await request(app)
      .get('/api/products?search=milk&latitude=0.5&longitude=0.5');

    expect(res.statusCode).toEqual(200);
    const [productSql] = pool.query.mock.calls[2];
    expect(productSql).toContain('p.area_id = 1');
    expect(productSql).not.toContain('p.area_id = 2');
  });

  it('a short search term (below the fulltext min length) falls back to LIKE, still area-scoped', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2]]);
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[{
      id: 900, area_id: 2, name: 'A2 Zone', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null, active: 1,
    }]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/products?search=ab&latitude=10.5&longitude=10.5');

    expect(res.statusCode).toEqual(200);
    const [productSql] = pool.query.mock.calls[3];
    expect(productSql).toContain("p.name LIKE '%ab%'");
    expect(productSql).toContain('p.area_id = 2');
    expect(productSql).not.toContain('MATCH(p.name)');
  });
});
