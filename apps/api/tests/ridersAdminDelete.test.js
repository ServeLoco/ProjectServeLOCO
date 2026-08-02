/**
 * DELETE /api/admin/riders/:id — frees phone for customer mode.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { getRiderForUser } = require('../src/utils/riders');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

jest.mock('../src/utils/riders', () => {
  const actual = jest.requireActual('../src/utils/riders');
  return {
    ...actual,
    syncDeliveryAvailabilityFromRiders: jest.fn().mockResolvedValue({ changed: false }),
  };
});

jest.mock('../src/realtime/socket', () => ({
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));

const { emitToCustomer, emitToAdmins } = require('../src/realtime/socket');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('DELETE /api/admin/riders/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes rider and signals customer mode for the phone', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        id: 3,
        user_id: 42,
        display_name: 'Ali',
        phone: '9876543210',
        user_phone: '9876543210',
        active: 1,
        is_online: 1,
      }]])
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // no active jobs
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // expire offers
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE rider

    const res = await request(app)
      .delete('/api/admin/riders/3')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Rider deleted');
    expect(res.body.becomesCustomer).toBe(true);
    expect(res.body.userId).toBe(42);
    expect(emitToCustomer).toHaveBeenCalledWith(
      42,
      'auth.role.updated',
      expect.objectContaining({ rider: null, reason: 'rider_deleted' })
    );
    expect(emitToAdmins).toHaveBeenCalledWith(
      'admin.rider.updated',
      expect.objectContaining({ id: 3, reason: 'deleted' })
    );
  });

  it('blocks delete when rider has active deliveries', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        id: 3, user_id: 42, display_name: 'Ali', phone: '9', active: 1, is_online: 0,
      }]])
      .mockResolvedValueOnce([[{ cnt: 1 }]]);

    const res = await request(app)
      .delete('/api/admin/riders/3')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/active deliveries/i);
  });

  it('404 when rider missing', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const res = await request(app)
      .delete('/api/admin/riders/99')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toEqual(404);
  });

  it('getRiderForUser returns null after hard delete (customer mode)', async () => {
    pool.query.mockResolvedValueOnce([[]]); // no active rider row
    const rider = await getRiderForUser(42);
    expect(rider).toBeNull();
  });
});
