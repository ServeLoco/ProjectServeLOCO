/**
 * Tests for the route-level validation middleware on previously unvalidated
 * admin coupon / offer / dashboard-section routes (TASK-16, Chunk 2).
 *
 * Strategy:
 *  - For invalid bodies we don't need DB mocks: the validate() middleware
 *    short-circuits with 400 + VALIDATION_ERROR before any controller runs.
 *  - For valid bodies we mock just enough of the controller's downstream
 *    DB calls so the route can return its normal success response.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'secret'
);

// Helper: assert the request was rejected by the validate() middleware
// (NOT by a controller's own internal validation, which uses different
// messages).
const expectSchemaRejection = (res) => {
  expect(res.statusCode).toEqual(400);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(res.body.message).toBe('Invalid request data');
  expect(Array.isArray(res.body.details)).toBe(true);
  expect(res.body.details.length).toBeGreaterThan(0);
};

describe('Admin Validation — Dashboard Sections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /dashboard-sections rejects missing title', async () => {
    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ display_order: 1 });
    expectSchemaRejection(res);
  });

  it('POST /dashboard-sections rejects empty / whitespace title', async () => {
    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '   ' });
    expectSchemaRejection(res);
  });

  it('POST /dashboard-sections rejects negative display_order', async () => {
    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Featured', display_order: -1 });
    expectSchemaRejection(res);
  });

  it('POST /dashboard-sections accepts a valid title (normalizes and trims)', async () => {
    // Controller performs deeper validation (needs slug/section_type/store_type)
    // and runs INSERT + existence checks. We mock the DB calls so the route
    // returns its normal 201 response.
    pool.query
      .mockResolvedValueOnce([[]]) // slug uniqueness check
      .mockResolvedValueOnce([[]]) // display_order uniqueness check
      .mockResolvedValueOnce([{ insertId: 42 }]); // INSERT

    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: '  Featured Picks  ',
        slug: 'featured-picks',
        section_type: 'category_grid',
        store_type: 'packed',
        display_order: 2,
        active: true
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.message).toBe('Dashboard section created');
  });

  it('POST /dashboard-sections accepts a blank title for section_type category_grid', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // slug uniqueness check
      .mockResolvedValueOnce([[]]) // display_order uniqueness check
      .mockResolvedValueOnce([{ insertId: 43 }]); // INSERT

    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: '',
        slug: 'category-rail',
        section_type: 'category_grid',
        store_type: 'packed',
        display_order: 3,
        active: true
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.message).toBe('Dashboard section created');
  });

  it('POST /dashboard-sections still rejects a blank title for section_type product_block', async () => {
    const res = await request(app)
      .post('/api/admin/dashboard-sections')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '', slug: 'featured', section_type: 'product_block' });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/reorder rejects non-array sectionIds', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sectionIds: 'not-an-array' });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/reorder rejects negative ids', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sectionIds: [1, -2, 3] });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/:id rejects empty title on update', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '' });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/:id accepts empty title when section_type is category_grid', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '', section_type: 'category_grid' });
    expect(res.statusCode).not.toBe(400);
  });

  it('POST /dashboard-sections/:id/items rejects missing item_type/item_id', async () => {
    const res = await request(app)
      .post('/api/admin/dashboard-sections/1/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ display_order: 1 });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/:id/items/reorder rejects non-array itemIds', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/1/items/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ itemIds: 'nope' });
    expectSchemaRejection(res);
  });

  it('PATCH /dashboard-sections/:id/items/:itemId rejects negative display_order', async () => {
    const res = await request(app)
      .patch('/api/admin/dashboard-sections/1/items/2')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ display_order: -1 });
    expectSchemaRejection(res);
  });
});

describe('Admin Validation — Offers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /offers rejects missing title', async () => {
    const res = await request(app)
      .post('/api/admin/offers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ description: 'no title here' });
    expectSchemaRejection(res);
  });

  it('PATCH /offers/:id allows partial update without title', async () => {
    // PATCH shouldn't require title (only POST does) — controller will
    // determine its own outcome. The schema must accept the empty body.
    const res = await request(app)
      .patch('/api/admin/offers/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });

    if (res.statusCode === 400) {
      expect(res.body.message).not.toBe('Invalid request data');
    }
  });

  it('POST /offers/:id/products rejects missing productId', async () => {
    const res = await request(app)
      .post('/api/admin/offers/1/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expectSchemaRejection(res);
  });

  it('POST /offers/:id/products rejects non-positive productId', async () => {
    const res = await request(app)
      .post('/api/admin/offers/1/products')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productId: -5 });
    expectSchemaRejection(res);
  });

  it('PATCH /offers/:id/products/reorder rejects non-array productIds', async () => {
    const res = await request(app)
      .patch('/api/admin/offers/1/products/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productIds: { 0: 1 } });
    expectSchemaRejection(res);
  });

  it('PATCH /offers/:id/products/reorder accepts a valid array (success path)', async () => {
    // reorderOfferProducts runs N UPDATE queries and returns 200.
    pool.query.mockResolvedValue([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch('/api/admin/offers/1/products/reorder')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productIds: [10, 11, 12] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Products reordered');
  });
});

describe('Admin Validation — Coupons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /coupons rejects missing title', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SAVE10' });
    expectSchemaRejection(res);
  });

  it('POST /coupons rejects non-string code', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 123, title: 'Save 10' });
    expectSchemaRejection(res);
  });

  it('POST /coupons rejects invalid discount_type', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SAVE10', title: 'Save 10', discount_type: 'bogus' });
    expectSchemaRejection(res);
  });

  it('POST /coupons rejects non-numeric discount_value', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SAVE10', title: 'Save 10', discount_type: 'flat', discount_value: 'ten' });
    expectSchemaRejection(res);
  });

  it('POST /coupons rejects negative total_usage_limit', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SAVE10', title: 'Save 10', discount_type: 'flat', discount_value: 10, total_usage_limit: -3 });
    expectSchemaRejection(res);
  });

  it('POST /coupons rejects non-boolean auto_apply', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'SAVE10', title: 'Save 10', discount_type: 'flat', discount_value: 10, auto_apply: 'maybe' });
    expectSchemaRejection(res);
  });

  it('POST /coupons accepts a no-code auto-apply coupon (code: null passes the schema)', async () => {
    // The admin form sends code: null when requires_code is false — the
    // schema must not reject it; the controller enforces the real rule
    // (code required only when requires_code is true).
    pool.query.mockResolvedValue([[]]);
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: null, title: 'Auto offer', discount_type: 'percent', discount_value: 10, requires_code: false, auto_apply: true });

    if (res.statusCode === 400) {
      expect(res.body.message).not.toBe('Invalid request data');
    }
  });

  it('PATCH /coupons/:id allows update without code', async () => {
    // PATCH shouldn't require code or title — schema must accept a partial body.
    const res = await request(app)
      .patch('/api/admin/coupons/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount_value: 15 });

    if (res.statusCode === 400) {
      expect(res.body.message).not.toBe('Invalid request data');
    }
  });

  it('POST /coupons/:id/duplicate accepts empty body (success path)', async () => {
    // duplicateCoupon has its own internal logic — we only assert the
    // schema's empty-body no-op didn't reject the request with the
    // generic "Invalid request data" message.
    const res = await request(app)
      .post('/api/admin/coupons/1/duplicate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    if (res.statusCode === 400) {
      expect(res.body.message).not.toBe('Invalid request data');
    }
  });
});
