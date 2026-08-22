const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

describe('PATCH /api/admin/orders/:id/remark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets the admin remark and returns it on the order', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001 }]]) // existence check
      .mockResolvedValueOnce([{}]) // UPDATE
      .mockResolvedValueOnce([[{ id: 1001, admin_remark: 'Delayed — rider shortage' }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/orders/1001/remark')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ remark: 'Delayed — rider shortage' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.order.admin_remark).toEqual('Delayed — rider shortage');

    const updateCall = pool.query.mock.calls.find(call => /UPDATE orders SET admin_remark/i.test(call[0]));
    expect(updateCall).toBeTruthy();
    expect(updateCall[1]).toEqual(['Delayed — rider shortage', '1001', 1]);
  });

  it('clears the remark to null on a blank body', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ id: 1001, admin_remark: null }]]);

    const res = await request(app)
      .patch('/api/admin/orders/1001/remark')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ remark: '   ' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.order.admin_remark).toBeNull();

    const updateCall = pool.query.mock.calls.find(call => /UPDATE orders SET admin_remark/i.test(call[0]));
    expect(updateCall[1]).toEqual([null, '1001', 1]);
  });

  it('404s for a non-existent order', async () => {
    pool.query.mockResolvedValueOnce([[]]); // existence check finds nothing

    const res = await request(app)
      .patch('/api/admin/orders/9999/remark')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ remark: 'test' });

    expect(res.statusCode).toEqual(404);
  });

  it('rejects a remark over the length cap', async () => {
    const res = await request(app)
      .patch('/api/admin/orders/1001/remark')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ remark: 'x'.repeat(1001) });

    expect(res.statusCode).toEqual(400);
    // No DB call should happen before validation fails.
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/orders/:id includes admin_remark dual-cased', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mirrors admin_remark into adminRemark on the order detail response', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, admin_remark: 'Delayed', status: 'Pending' }]]) // order select
      .mockResolvedValueOnce([[]]); // order_items select

    const res = await request(app)
      .get('/api/admin/orders/1001')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.admin_remark).toEqual('Delayed');
    expect(res.body.data.adminRemark).toEqual('Delayed');
  });
});
