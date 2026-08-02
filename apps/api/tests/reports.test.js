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

describe('Reports API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return sales report with period filtering', async () => {
    pool.query
      .mockResolvedValueOnce([[{ total_revenue: 1000, total_orders: 10 }]]) // salesRow
      .mockResolvedValueOnce([[{ status: 'Delivered', count: 10 }]]) // statusRows
      .mockResolvedValueOnce([[{ payment_method: 'upi', count: 8 }, { payment_method: 'cash', count: 2 }]]) // paymentBreakdownRows
      .mockResolvedValueOnce([[{ payment_status: 'Paid', count: 8 }, { payment_status: 'Pending', count: 2 }]]) // paymentStatusRows
      .mockResolvedValueOnce([[{ today_sales: 100, week_sales: 500, month_sales: 1000 }]]); // legacySalesRow

    const res = await request(app)
      .get('/api/admin/reports/sales?period=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.total_revenue).toEqual(1000);
    expect(res.body.status_breakdown.delivered).toEqual(10);
    expect(res.body.payment_breakdown.upi).toEqual(8);
    expect(res.body.payment_status.paid).toEqual(8);
    
    // Check if period filter was applied
    expect(pool.query.mock.calls[0][0]).toContain('CURDATE()');
  });

  it('should return top products report with period filtering', async () => {
    pool.query.mockResolvedValueOnce([[{ product_id: 1, product_name: 'Chips', total_quantity: 50, total_sales: 1000 }]]);

    const res = await request(app)
      .get('/api/admin/reports/top-products?period=week')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data[0].product_name).toEqual('Chips');
    expect(pool.query.mock.calls[0][0]).toContain('YEARWEEK');
  });

  it('should return customers report with period filtering', async () => {
    pool.query.mockResolvedValueOnce([[{ total_customers: 100, new_customers: 5, new_customers_30d: 20, trusted_customers: 80, blocked_customers: 2 }]]);

    const res = await request(app)
      .get('/api/admin/reports/customers?period=month')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.total_customers).toEqual(100);
    expect(res.body.data.new_customers).toEqual(5);
    expect(pool.query.mock.calls[0][0]).toContain('MONTH');
  });

  it('should return shop-wise report grouped with products, excluding cancelled orders', async () => {
    pool.query
      .mockResolvedValueOnce([[
        { shop_id: 1, shop_name: 'Green Mart', order_count: 3, total_amount: 450, total_items_sold: 9 },
        { shop_id: null, shop_name: null, order_count: 1, total_amount: 50, total_items_sold: 2 },
      ]]) // shopRows
      .mockResolvedValueOnce([[
        { shop_id: 1, product_id: 10, item_type: 'product', product_name: 'Milk', quantity: 6, total_sales: 300 },
        { shop_id: 1, product_id: 11, item_type: 'product', product_name: 'Bread', quantity: 3, total_sales: 150 },
        { shop_id: null, product_id: 12, item_type: 'product', product_name: 'Eggs', quantity: 2, total_sales: 50 },
      ]]); // productRows

    const res = await request(app)
      .get('/api/admin/reports/shops?period=today')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].shop_name).toEqual('Green Mart');
    expect(res.body.data[0].order_count).toEqual(3);
    expect(res.body.data[0].products).toHaveLength(2);
    expect(res.body.data[0].products[0].product_name).toEqual('Milk');
    expect(res.body.data[1].shop_name).toEqual('House (No Shop)');
    expect(res.body.data[1].products[0].product_name).toEqual('Eggs');

    expect(pool.query.mock.calls[0][0]).toContain("status != 'Cancelled'");
    expect(pool.query.mock.calls[0][0]).toContain('CURDATE()');
  });
});
