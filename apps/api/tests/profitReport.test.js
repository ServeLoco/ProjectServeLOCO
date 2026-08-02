const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const token = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

// getProfitSummary issues 6 queries in this fixed order: delivered aggregate
// (sales/charges/discount/paid/payment-split), shop cost, warnings, per-shop
// breakdown, pipeline, cancelled.
const mockSummaryQueries = ({
  delivered = {
    delivered_orders: 10, app_sales: 5000, delivery_charge: 300, night_charge: 20,
    rain_charge: 40, fast_delivery_charge: 60, discount: 150, free_delivery_waiver: 50,
    customer_paid: 5270, cash_orders: 6, cash_amount: 3000, upi_orders: 4, upi_amount: 2270,
  },
  shopCost = { shop_cost: 3200 },
  warnings = { unpriced_items_count: 0, unpriced_items_app_total: 0, rejected_items_count: 0 },
  shopRows = [],
  pipeline = { orders: 2, value: 900 },
  cancelled = { orders: 1, value: 400 },
} = {}) => {
  pool.query
    .mockResolvedValueOnce([[delivered]])
    .mockResolvedValueOnce([[shopCost]])
    .mockResolvedValueOnce([[warnings]])
    .mockResolvedValueOnce([shopRows])
    .mockResolvedValueOnce([[pipeline]])
    .mockResolvedValueOnce([[cancelled]]);
};

describe('Profit & payout report API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /reports/profit/summary', () => {
    it('computes totals, applies the profit identity, and reports payment split', async () => {
      mockSummaryQueries();

      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      const t = res.body.totals;
      expect(t.deliveredOrders).toBe(10);
      expect(t.appSales).toBe(5000);
      expect(t.shopCost).toBe(3200);
      expect(t.productMargin).toBe(1800); // 5000 - 3200
      expect(t.chargesIncome).toBe(420); // 300+20+40+60
      expect(t.customerPaid).toBe(5270);
      expect(t.netProfit).toBe(2070); // 5270 - 3200

      // net_profit == product_margin + charges_income - discount
      expect(t.netProfit).toBeCloseTo(t.productMargin + t.chargesIncome - t.discount, 5);

      // both casings present
      expect(t.delivered_orders).toBe(10);
      expect(t.net_profit).toBe(2070);

      expect(res.body.paymentSplit.cash.orders).toBe(6);
      expect(res.body.paymentSplit.upi.amount).toBe(2270);
      expect(res.body.payment_split.cash.amount).toBe(3000);
    });

    it('excludes cancelled orders from profit and reports them separately', async () => {
      mockSummaryQueries({ cancelled: { orders: 3, value: 1200 } });

      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.cancelled).toEqual({ orders: 3, value: 1200 });
      // The Delivered-only aggregate query is untouched by cancelled-order counts.
      const deliveredQuerySql = pool.query.mock.calls[0][0];
      expect(deliveredQuerySql).toContain("status = 'Delivered'");
    });

    it('puts non-delivered, non-cancelled orders in pipeline, not in profit', async () => {
      mockSummaryQueries({ pipeline: { orders: 5, value: 2200 } });

      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.pipeline).toEqual({ orders: 5, value: 2200 });
      const pipelineQuerySql = pool.query.mock.calls[4][0];
      expect(pipelineQuerySql).toContain("NOT IN ('Delivered', 'Cancelled')");
    });

    it('flags unpriced shop items without letting them distort shop cost, and surfaces rejected items', async () => {
      mockSummaryQueries({
        warnings: { unpriced_items_count: 4, unpriced_items_app_total: 320, rejected_items_count: 2 },
      });

      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.warnings.unpricedItemsCount).toBe(4);
      expect(res.body.warnings.unpricedItemsAppTotal).toBe(320);
      expect(res.body.warnings.rejectedItemsCount).toBe(2);
      expect(res.body.warnings.unpriced_items_count).toBe(4);
      // shop_cost query explicitly requires a non-null, non-rejected snapshot
      const shopCostSql = pool.query.mock.calls[1][0];
      expect(shopCostSql).toContain('shop_rejected_at IS NULL');
      expect(shopCostSql).toContain('shop_line_total IS NOT NULL');
    });

    it('per-shop breakdown sums to totals.shopCost and includes the house row', async () => {
      mockSummaryQueries({
        shopCost: { shop_cost: 700 },
        shopRows: [
          { shop_id: 3, shop_name: 'Sharma Kirana', delivered_orders: 4, items_sold: 12, app_sales: 900, shop_cost: 600, unpriced_items: 0 },
          { shop_id: null, shop_name: null, delivered_orders: 1, items_sold: 2, app_sales: 150, shop_cost: 100, unpriced_items: 0 },
        ],
      });

      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.body.shops).toHaveLength(2);
      expect(res.body.shops[0].shopName).toBe('Sharma Kirana');
      expect(res.body.shops[1].shopName).toBe('House (No Shop)');
      const sumShopCost = res.body.shops.reduce((s, r) => s + r.shopCost, 0);
      expect(sumShopCost).toBe(res.body.totals.shopCost);
    });

    it('rejects an invalid period', async () => {
      const res = await request(app)
        .get('/api/admin/reports/profit/summary?period=next_week')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toEqual('VALIDATION_ERROR');
    });

    it('rejects requests without an admin token', async () => {
      const res = await request(app).get('/api/admin/reports/profit/summary?period=today');
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe('GET /reports/profit/orders', () => {
    it('paginates correctly and returns both casings on money fields', async () => {
      pool.query
        .mockResolvedValueOnce([[{ total: 42 }]]) // count
        .mockResolvedValueOnce([[
          {
            id: 101, order_number: 'VK-101', created_at: '2026-07-31T10:00:00Z', delivered_at: '2026-07-31T10:40:00Z',
            customer_name: 'Asha', payment_method: 'Cash', status: 'Delivered',
            app_items_total: 430, delivery_charge: 30, night_charge: 0, rain_charge: 0, fast_delivery_charge: 0,
            discount_amount: 20, customer_paid: 440, shop_cost: 310, has_unpriced_items: 0,
          },
        ]]) // page rows
        .mockResolvedValueOnce([[
          { order_id: 101, shop_id: 3, shop_name: 'Sharma Kirana', shop_cost: 310 },
        ]]); // per-order shop breakdown

      const res = await request(app)
        .get('/api/admin/reports/profit/orders?period=today&page=1&limit=20')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 42, totalPages: 3 });
      const row = res.body.data[0];
      expect(row.appItemsTotal).toBe(430);
      expect(row.app_items_total).toBe(430);
      expect(row.shopCost).toBe(310);
      expect(row.productMargin).toBe(120); // 430 - 310
      expect(row.netProfit).toBe(130); // 440 - 310
      expect(row.shops[0].shopName).toBe('Sharma Kirana');
    });

    it('page 2 is disjoint from page 1 (distinct offset passed to SQL)', async () => {
      pool.query
        .mockResolvedValueOnce([[{ total: 42 }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce(undefined); // shop breakdown query skipped when no rows

      const res = await request(app)
        .get('/api/admin/reports/profit/orders?period=today&page=2&limit=20')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      const pageQueryParams = pool.query.mock.calls[1][1];
      // LIMIT/OFFSET are the trailing two bound params; offset for page 2 @ limit 20 is 20.
      expect(pageQueryParams[pageQueryParams.length - 2]).toBe(20); // limit
      expect(pageQueryParams[pageQueryParams.length - 1]).toBe(20); // offset
    });

    it('rejects an invalid shopId filter', async () => {
      const res = await request(app)
        .get('/api/admin/reports/profit/orders?period=today&shopId=not-a-number')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toEqual('VALIDATION_ERROR');
    });

    it('rejects an invalid period', async () => {
      const res = await request(app)
        .get('/api/admin/reports/profit/orders?period=whenever')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(400);
    });
  });
});
