const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn().mockResolvedValue({
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    })
  }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

describe('Dashboard Admin Filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should list packed sections and non-offer shared sections when store_type=packed is provided', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ id: 1, store_type: 'packed' }, { id: 2, store_type: 'all', section_type: 'category_grid' }]]);

    const res = await request(app)
      .get('/api/admin/dashboard-sections?store_type=packed')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(pool.query.mock.calls[1][0]).toContain('(store_type = ? OR (store_type = "all" AND section_type != "offer_banner"))');
    expect(pool.query.mock.calls[1][1]).toEqual([1, 'packed']);
  });
});
