/**
 * Tests for shop-closed product visibility in customer-facing lists.
 *
 * Default behaviour: closed-shop products are excluded server-side.
 * When `include_closed_shops=1` is passed, products from closed (but
 * still active) shops are included in the response with `shop_is_open: 0`
 * in both casings. Checkout guards in cartController.js stay unchanged.
 */

const request = require('supertest');
const express = require('express');
const productRoutes = require('../src/routes/productRoutes');
const dashboardRoutes = require('../src/routes/dashboardRoutes');
const cartRoutes = require('../src/routes/cartRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn().mockResolvedValue([[]]),
    getConnection: jest.fn(),
    escape: jest.fn(value => `'${value}'`)
  }
}));

const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };
// productRoutes carries resolveCustomerArea (TASK 11) — unauthenticated,
// no-pin requests resolve via its default-area fallback, one
// `SELECT * FROM areas` before the real query. dashboardRoutes/cartRoutes
// don't mount it yet (TASK 12/13), so only the "GET /api/products" tests
// below need this.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

const app = express();
app.use(express.json());
app.use('/api/products', productRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/cart', cartRoutes);

// Helpers to build realistic mocked rows with a shop_is_open value.
// A set of empty query results that the productController helpers issue after
// the main SELECT: images, product_variants.
const mockProductHelpers = () => {
  pool.query.mockResolvedValueOnce([[]]); // resolveImageUrls: images
  pool.query.mockResolvedValueOnce([[]]); // attachVariants: product_variants
};

const mockProductRow = (overrides = {}) => ({
  id: 1,
  name: 'Test Product',
  price: 100,
  unit: 'pc',
  description: 'A product',
  image_id: 10,
  available: 1,
  is_combo: 0,
  featured: 0,
  original_price: null,
  discount_label: null,
  available_from_time: null,
  available_until_time: null,
  category_id: 5,
  category_name: 'Snacks',
  category_type: 'packed',
  cat_display_order: 0,
  item_display_order: 0,
  variant_prompt: null,
  shop_id: 7,
  shop_is_open: 1,
  ...overrides
});

const mockSectionRow = (overrides = {}) => ({
  id: 1,
  title: 'Popular',
  slug: 'popular',
  section_type: 'product_block',
  store_type: 'packed',
  active: 1,
  display_order: 0,
  max_visible_items: 6,
  show_see_all: 0,
  ...overrides
});

describe('GET /api/products', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('excludes closed-shop products by default and projects shop_is_open', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockProductRow()]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products');

    expect(res.statusCode).toEqual(200);
    const firstSql = pool.query.mock.calls[1][0];
    expect(firstSql).toContain('shop_is_open');
    expect(firstSql).toContain('LEFT JOIN shops sh ON sh.id = p.shop_id');
    expect(firstSql).toContain('s.is_open = 1');
    expect(res.body.data.products[0]).toHaveProperty('shopIsOpen', 1);
    expect(res.body.data.products[0]).toHaveProperty('shop_is_open', 1);
  });

  it('includes closed-shop products with include_closed_shops=1 and surfaces shop_is_open: 0', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockProductRow({ shop_is_open: 0 })]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products?include_closed_shops=1');

    expect(res.statusCode).toEqual(200);
    const firstSql = pool.query.mock.calls[1][0];
    expect(firstSql).toContain('shop_is_open');
    expect(firstSql).not.toContain('s.is_open = 1');
    expect(firstSql).toContain('s.active = 1');
    expect(res.body.data.products[0]).toHaveProperty('shopIsOpen', 0);
    expect(res.body.data.products[0]).toHaveProperty('shop_is_open', 0);
  });

  it('honours camelCase alias in request: includeClosedShops=1', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockProductRow({ shop_is_open: 0 })]]);
    mockProductHelpers();

    const res = await request(app).get('/api/products?includeClosedShops=1');

    expect(res.statusCode).toEqual(200);
    const firstSql = pool.query.mock.calls[1][0];
    expect(firstSql).not.toContain('s.is_open = 1');
    expect(res.body.data.products[0]).toHaveProperty('shopIsOpen', 0);
  });

  it('applies the same shop-closed handling to offer product lists', async () => {
    mockDefaultAreaLookup();
    // 1) offer validation
    pool.query.mockResolvedValueOnce([[{ store_type: 'packed', active: 1, deleted: 0, is_clickable: 1 }]]);
    // 2) offer_products query with closed shop
    pool.query.mockResolvedValueOnce([[mockProductRow({ shop_is_open: 0 })]]);
    // 3) image / variant queries
    mockProductHelpers();

    const res = await request(app).get('/api/products?offerId=1&include_closed_shops=1');

    expect(res.statusCode).toEqual(200);
    // calls[0] is the area lookup, calls[1] is offer validation, calls[2] is offer_products.
    const offerProductSql = pool.query.mock.calls[2][0];
    expect(offerProductSql).toContain('shop_is_open');
    expect(offerProductSql).not.toContain('s.is_open = 1');
    expect(offerProductSql).toContain('s.active = 1');
    expect(res.body.data.products[0]).toHaveProperty('shopIsOpen', 0);
  });
});

describe('GET /api/dashboard and /api/dashboard/sections/:slug/items', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('excludes closed-shop products in dashboard product_block by default', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockSectionRow()]]);
    pool.query.mockResolvedValueOnce([[mockProductRow({ section_item_id: 101 })]]);
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/dashboard?storeType=packed');

    expect(res.statusCode).toEqual(200);
    const sectionSql = pool.query.mock.calls[2][0];
    expect(sectionSql).toContain('shop_is_open');
    expect(sectionSql).toContain('s.is_open = 1');
    expect(res.body.data.sections[0].items[0]).toHaveProperty('shopIsOpen', 1);
    expect(res.body.data.sections[0].items[0]).toHaveProperty('shop_is_open', 1);
  });

  it('includes closed-shop products in dashboard product_block with include_closed_shops=1', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockSectionRow()]]);
    pool.query.mockResolvedValueOnce([[mockProductRow({ section_item_id: 101, shop_is_open: 0 })]]);
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/dashboard?storeType=packed&include_closed_shops=1');

    expect(res.statusCode).toEqual(200);
    const sectionSql = pool.query.mock.calls[2][0];
    expect(sectionSql).toContain('shop_is_open');
    expect(sectionSql).not.toContain('s.is_open = 1');
    expect(sectionSql).toContain('s.active = 1');
    expect(res.body.data.sections[0].items[0]).toHaveProperty('shopIsOpen', 0);
    expect(res.body.data.sections[0].items[0]).toHaveProperty('shop_is_open', 0);
  });

  it('includes closed-shop products in section items with include_closed_shops=1', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[mockSectionRow()]]);
    pool.query.mockResolvedValueOnce([[mockProductRow({ section_item_id: 101, shop_is_open: 0 })]]);
    pool.query.mockResolvedValueOnce([[]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/dashboard/sections/popular/items?storeType=packed&include_closed_shops=1');

    expect(res.statusCode).toEqual(200);
    const sectionSql = pool.query.mock.calls[2][0];
    expect(sectionSql).toContain('shop_is_open');
    expect(sectionSql).not.toContain('s.is_open = 1');
    expect(res.body.data.items[0]).toHaveProperty('shopIsOpen', 0);
  });
});

describe('Cart checkout guard regression pin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('still refuses cart items from closed shops when products are surfaced elsewhere', async () => {
    // Cart add with a valid user token and a closed-shop product. The
    // controller first looks up the product with the is_open guard, so
    // the product map stays empty and the cart item is rejected.
    const userToken = jwt.sign({ id: 'customer-1', role: 'customer' }, process.env.JWT_SECRET || 'secret');

    // requireCustomer skips its own DB check under NODE_ENV=test (see
    // authMiddleware.js), so calculateCart's own queries start at call index 0.
    // 1) settings query
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1, delivery_charge: 0, night_charge: 0,
      standard_delivery_minutes: 60, fast_delivery_minutes: 30,
      fast_delivery_enabled: 0, night_charge_start: null, night_charge_end: null,
      delivery_radius_km: 10
    }]]);
    // 2) product lookup with is_open guard (returns nothing because shop is closed)
    pool.query.mockResolvedValueOnce([[]]);
    // 3) disambiguation query on the missing id — row exists, not deleted,
    // not unavailable, so the ONLY reason it's missing from (2) is the
    // shop-open/group-active gate. This is what tells calculateCart to hard
    // 400 SHOP_CLOSED instead of soft-dropping the item as OOS/nonexistent.
    pool.query.mockResolvedValueOnce([[{ id: 1, deleted: 0, available: 1 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ items: [{ productId: 1, quantity: 1 }] });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('SHOP_CLOSED');
    const productLookupSql = pool.query.mock.calls[1][0];
    expect(productLookupSql).toContain('s.is_open = 1');
  });

  it('soft-drops (does not hard-block) a productId that does not exist at all', async () => {
    // Same shop-closed-looking gap as above, but the disambiguation query
    // this time returns no row at all — the id never existed (stale/tampered
    // cart), not a shop-closed product. Must soft-drop, not hard 400.
    const userToken = jwt.sign({ id: 'customer-1', role: 'customer' }, process.env.JWT_SECRET || 'secret');

    pool.query.mockResolvedValueOnce([[{
      shop_open: 1, delivery_charge: 0, night_charge: 0,
      standard_delivery_minutes: 60, fast_delivery_minutes: 30,
      fast_delivery_enabled: 0, night_charge_start: null, night_charge_end: null,
      delivery_radius_km: 10
    }]]); // settings
    pool.query.mockResolvedValueOnce([[]]); // main product lookup — empty
    pool.query.mockResolvedValueOnce([[]]); // disambiguation — no row at all
    // Every requested line ends up soft-dropped (processedItems empty), but
    // calculateCart still runs auto-apply coupon lookup regardless of item
    // count (an empty items: [] cart was already a reachable case before this
    // branch, so this query already had to tolerate zero items in prod).
    pool.query.mockResolvedValueOnce([[]]); // pickBestAutoApply candidates

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ items: [{ productId: 999999, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.unavailableItems).toHaveLength(1);
    expect(res.body.data.unavailableItems[0]).toMatchObject({
      productId: 999999, reason: 'product_unavailable',
    });
  });
});
