const request = require('supertest');
const express = require('express');
const dashboardRoutes = require('../src/routes/dashboardRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn()
  }
}));

jest.mock('../src/db/mongodb', () => ({
  getDb: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRoutes);

const { clearAll: clearMicroCache } = require('../src/utils/microCache');
const areaScope = require('../src/utils/areaScope');

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// GET /api/dashboard carries resolveCustomerArea (TASK 12) — unauthenticated,
// no-pin request resolves via its default-area fallback, one
// `SELECT * FROM areas` before the real sections query.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('Curated Category Grid', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    clearMicroCache();
    areaScope._resetCachesForTests();
    pool.query.mockResolvedValue([[]]); // Default fallback for un-mocked queries
  });

  it('should return curated categories when they exist in dashboard_section_items', async () => {
    mockDefaultAreaLookup();
    pool.query
      .mockResolvedValueOnce([[{ id: 1, slug: 'categories-grid', section_type: 'category_grid', store_type: 'packed' }]]) // getDashboard sections
      .mockResolvedValueOnce([[{ id: 101, name: 'Curated Category', type: 'packed', image_id: null }]]); // curated category grid query

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const gridSection = res.body.data.sections.find(s => s.sectionType === 'category_grid');
    expect(gridSection).toBeDefined();
    expect(gridSection.items).toHaveLength(1);
    expect(gridSection.items[0].name).toEqual('Curated Category');

    // Ensure it queried dashboard_section_items
    expect(pool.query.mock.calls[2][0]).toContain('dashboard_section_items');
  });

  it('should hide the category section when no curated items are assigned', async () => {
    mockDefaultAreaLookup();
    pool.query
      .mockResolvedValueOnce([[{ id: 1, slug: 'categories-grid', section_type: 'category_grid', store_type: 'packed' }]]) // getDashboard sections
      .mockResolvedValueOnce([[]]); // curated category grid query (returns empty)

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const gridSection = res.body.data.sections.find(s => s.sectionType === 'category_grid');
    expect(gridSection).toBeUndefined();

    // Only the curated dashboard_section_items query should have run — no fallback to all categories.
    expect(pool.query.mock.calls[2][0]).toContain('dashboard_section_items');
    expect(pool.query.mock.calls).toHaveLength(3);
  });

  it('embeds variants on a product_block section (dashboard cards must show the variant sheet)', async () => {
    mockDefaultAreaLookup();
    pool.query
      .mockResolvedValueOnce([[{ id: 1, slug: 'pizza-block', section_type: 'product_block', store_type: 'packed' }]]) // getDashboard sections
      .mockResolvedValueOnce([[{ id: 12, name: 'Margherita Pizza', price: 149, is_combo: 0, available: 1, category_type: 'packed' }]]) // product_block query
      .mockResolvedValueOnce([[
        { id: 10, product_id: 12, label: 'Small', price: 149, original_price: null, available: 1, is_default: 1, display_order: 0 },
        { id: 11, product_id: 12, label: 'Large', price: 349, original_price: null, available: 1, is_default: 0, display_order: 1 },
      ]]); // attachVariants query

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const productSection = res.body.data.sections.find(s => s.sectionType === 'product_block');
    expect(productSection).toBeDefined();
    const pizza = productSection.items[0];
    expect(pizza.variants).toHaveLength(2);
    expect(pizza.hasVariants).toBe(true);
    expect(pizza.minPrice).toBe(149);
  });
});
