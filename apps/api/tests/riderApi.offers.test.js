/**
 * TASK 7 — rider offer/assignment HTTP API tests.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));
jest.mock('../src/utils/shops', () => ({
  syncGlobalShopOpenState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));
jest.mock('../src/services/riderAssignment', () => ({
  acceptOffer: jest.fn(),
  rejectOffer: jest.fn(),
  cancelAssignmentByRider: jest.fn(),
}));
jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/realtime/orderEvents', () => ({
  emitOrderStatusUpdated: jest.fn(),
  emitOrderPaymentUpdated: jest.fn(),
  emitNotificationCreated: jest.fn(),
}));

const riderRoutes = require('../src/routes/riderRoutes');
const { pool } = require('../src/db/mysql');
const assignment = require('../src/services/riderAssignment');

const app = express();
app.use(express.json());
app.use('/api/rider', riderRoutes);

const token = (id = 7) => jwt.sign(
  { id, role: 'customer' },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

const RIDER = {
  id: 3, user_id: 7, display_name: 'Ravi', phone: '999',
  active: 1, is_online: 1, last_heartbeat_at: new Date(),
};

describe('Rider offers & assignments API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it('GET /offers/active returns null when none', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]]) // requireRider
      .mockResolvedValueOnce([[]]); // offer query

    const res = await request(app)
      .get('/api/rider/offers/active')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.offer).toBeNull();
  });

  it('GET /offers/active returns offer with shops and items', async () => {
    const expires = new Date(Date.now() + 60000);
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[{
        id: 9, order_id: 10, status: 'pending', expires_at: expires,
        order_number: 'ORD-1', address: 'Street 1', phone: '111', customer_name: 'C',
      }]])
      .mockResolvedValueOnce([[{ id: 1, name: 'Shop A' }]])
      .mockResolvedValueOnce([[{
        id: 5, order_id: 10, product_name: 'Milk', quantity: 2, variant_label: '1L', shop_id: 1,
      }]]);

    const res = await request(app)
      .get('/api/rider/offers/active')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.offer.id).toBe(9);
    expect(res.body.offer.secondsRemaining).toBeGreaterThan(0);
    expect(res.body.offer.shops).toEqual([{ id: 1, name: 'Shop A' }]);
    expect(res.body.offer.items).toHaveLength(1);
    expect(res.body.offer.items[0].productName).toBe('Milk');
  });

  it('POST accept delegates to engine', async () => {
    pool.query.mockResolvedValueOnce([[RIDER]]);
    assignment.acceptOffer.mockResolvedValueOnce({
      ok: true,
      order: { id: 10, order_number: 'O', status: 'Accepted', rider_id: 3 },
    });

    const res = await request(app)
      .post('/api/rider/offers/9/accept')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(assignment.acceptOffer).toHaveBeenCalledWith(9, 3);
    expect(res.body.order.rider_id).toBe(3);
  });

  it('POST accept returns 409 on conflict', async () => {
    pool.query.mockResolvedValueOnce([[RIDER]]);
    assignment.acceptOffer.mockResolvedValueOnce({
      ok: false, code: 'CONFLICT', message: 'Offer expired', status: 409,
    });

    const res = await request(app)
      .post('/api/rider/offers/9/accept')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(409);
  });

  it('POST reject delegates to engine', async () => {
    pool.query.mockResolvedValueOnce([[RIDER]]);
    assignment.rejectOffer.mockResolvedValueOnce({ ok: true, continued: { failed: true } });

    const res = await request(app)
      .post('/api/rider/offers/9/reject')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(assignment.rejectOffer).toHaveBeenCalledWith(9, 3, 'manual');
  });

  it('GET assignments/current returns null when free', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/rider/assignments/current')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.order).toBeNull();
  });

  it('POST cancel assignment is not allowed', async () => {
    pool.query.mockResolvedValueOnce([[RIDER]]);
    assignment.cancelAssignmentByRider.mockResolvedValueOnce({
      ok: false,
      code: 'CANCEL_NOT_ALLOWED',
      message: 'Cannot cancel after accepting. Contact admin if needed.',
      status: 400,
    });

    const res = await request(app)
      .post('/api/rider/assignments/10/cancel')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('CANCEL_NOT_ALLOWED');
    expect(assignment.cancelAssignmentByRider).toHaveBeenCalledWith(10, 3);
  });

  it('POST picked-up sets timestamp', async () => {
    const order = {
      id: 10, rider_id: 3, status: 'Accepted', customer_id: 5,
      order_number: 'O', rider_picked_up_at: null,
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[order]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ ...order, rider_picked_up_at: '2026-07-12' }]]);

    const res = await request(app)
      .post('/api/rider/assignments/10/picked-up')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.order.rider_picked_up_at).toBeTruthy();
  });

  it('PATCH status to Out for Delivery', async () => {
    const order = {
      id: 10, rider_id: 3, status: 'Preparing', customer_id: 5,
      order_number: 'O', rider_picked_up_at: '2026-07-12',
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[order]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ ...order, status: 'Out for Delivery' }]]);

    const res = await request(app)
      .patch('/api/rider/assignments/10/status')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'Out for Delivery' });

    expect(res.statusCode).toBe(200);
    expect(res.body.order.status).toBe('Out for Delivery');
  });

  it('POST mark-paid sets payment_status from Pending', async () => {
    const order = {
      id: 10, rider_id: 3, status: 'Accepted', customer_id: 5,
      order_number: 'O', payment_status: 'Pending',
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[order]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ ...order, payment_status: 'Paid' }]]);

    const res = await request(app)
      .post('/api/rider/assignments/10/mark-paid')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.order.paymentStatus).toBe('Paid');
  });

  it('POST mark-paid forbidden for other rider', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[{
        id: 10, rider_id: 99, status: 'Accepted', payment_status: 'Pending',
      }]]);

    const res = await request(app)
      .post('/api/rider/assignments/10/mark-paid')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(403);
  });

  it('POST mark-paid no-ops when already paid', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[{
        id: 10, rider_id: 3, status: 'Accepted', payment_status: 'Success',
      }]]);

    const res = await request(app)
      .post('/api/rider/assignments/10/mark-paid')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/already recorded/i);
  });

  it('PATCH status forbidden for other rider', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[{
        id: 10, rider_id: 99, status: 'Preparing', customer_id: 5, order_number: 'O',
      }]]);

    const res = await request(app)
      .patch('/api/rider/assignments/10/status')
      .set('Authorization', `Bearer ${token()}`)
      .send({ status: 'Delivered' });

    expect(res.statusCode).toBe(403);
  });

  it('GET history paginates', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[{ cnt: 1 }]])
      .mockResolvedValueOnce([[{
        id: 10, order_number: 'O', status: 'Delivered', address: 'A', total: 100,
        rider_assigned_at: null, rider_picked_up_at: null, created_at: null, updated_at: null,
      }]]);

    const res = await request(app)
      .get('/api/rider/assignments/history?page=1&limit=10')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  it('GET assignments/:orderId returns map payload (coords + shops + items)', async () => {
    const order = {
      id: 10,
      rider_id: 3,
      status: 'Accepted',
      order_number: 'VK-10',
      address: 'Fatehabad',
      latitude: 29.52,
      longitude: 75.45,
      phone: '999',
      customer_name: 'Asha',
      payment_method: 'COD',
      total: 200,
      note: null,
      rider_assigned_at: '2026-07-14',
      rider_picked_up_at: null,
      rider_assignment_status: 'assigned',
      created_at: '2026-07-14',
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]]) // requireRider
      .mockResolvedValueOnce([[order]]) // order by id + rider
      .mockResolvedValueOnce([[{
        order_id: 10, id: 2, name: 'Kirana', latitude: 29.45, longitude: 75.66,
      }]]) // shops (batched loader — rows carry order_id)
      .mockResolvedValueOnce([[{
        id: 1, order_id: 10, product_name: 'Milk', quantity: 2, variant_label: '1L', shop_id: 2,
      }]]); // items

    const res = await request(app)
      .get('/api/rider/assignments/10')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.order).toEqual(expect.objectContaining({
      id: 10,
      latitude: 29.52,
      longitude: 75.45,
      lat: 29.52,
      lng: 75.45,
    }));
    expect(res.body.order.shops).toHaveLength(1);
    expect(res.body.order.shops[0]).toEqual(expect.objectContaining({
      id: 2,
      name: 'Kirana',
      latitude: 29.45,
      longitude: 75.66,
      lat: 29.45,
      lng: 75.66,
    }));
    expect(res.body.order.items).toHaveLength(1);
    expect(res.body.order.items[0].productName).toBe('Milk');
  });

  it('GET assignments/:orderId shows a per-shop accepted/rejected breakdown on a mixed-decision order', async () => {
    const order = {
      id: 10, rider_id: 3, status: 'Preparing', order_number: 'VK-10', address: 'Fatehabad',
      latitude: 29.52, longitude: 75.45, phone: '999', customer_name: 'Asha',
      payment_method: 'COD', total: 200, note: null, rider_assigned_at: '2026-07-14',
      rider_picked_up_at: null, rider_assignment_status: 'assigned', created_at: '2026-07-14',
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]]) // requireRider
      .mockResolvedValueOnce([[order]]) // order by id + rider
      .mockResolvedValueOnce([[
        { order_id: 10, id: 1, name: 'Kirana', latitude: 29.45, longitude: 75.66 },
        { order_id: 10, id: 2, name: 'Bakery', latitude: 29.46, longitude: 75.67 },
      ]]) // shops
      .mockResolvedValueOnce([[
        {
          id: 1, order_id: 10, product_name: 'Milk', quantity: 2, variant_label: null, shop_id: 1,
          shop_confirmed_at: '2026-07-14T10:00:00Z', shop_rejected_at: null,
        },
        {
          id: 2, order_id: 10, product_name: 'Bread', quantity: 1, variant_label: null, shop_id: 2,
          shop_confirmed_at: null, shop_rejected_at: '2026-07-14T10:01:00Z',
        },
      ]]); // items

    const res = await request(app)
      .get('/api/rider/assignments/10')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    const shops = res.body.order.shops;
    expect(shops).toHaveLength(2);

    const kirana = shops.find((s) => s.id === 1);
    expect(kirana.status).toBe('accepted');
    expect(kirana.accepted).toBe(true);
    expect(kirana.rejected).toBe(false);
    expect(kirana.items).toHaveLength(1);
    expect(kirana.items[0].productName).toBe('Milk');
    expect(kirana.items[0].accepted).toBe(true);
    expect(kirana.items[0].rejected).toBe(false);

    const bakery = shops.find((s) => s.id === 2);
    expect(bakery.status).toBe('rejected');
    expect(bakery.accepted).toBe(false);
    expect(bakery.rejected).toBe(true);
    expect(bakery.items).toHaveLength(1);
    expect(bakery.items[0].productName).toBe('Bread');
    expect(bakery.items[0].accepted).toBe(false);
    expect(bakery.items[0].rejected).toBe(true);
  });

  it('GET assignments/:orderId returns 404 for other rider', async () => {
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[]]); // no matching assignment

    const res = await request(app)
      .get('/api/rider/assignments/99')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('GET assignments/current includes shop coordinates', async () => {
    const order = {
      id: 10,
      rider_id: 3,
      status: 'Accepted',
      order_number: 'VK-10',
      address: 'A',
      latitude: 29.5,
      longitude: 75.5,
      phone: '1',
      customer_name: 'B',
      payment_method: 'COD',
      total: 1,
      note: null,
      rider_assigned_at: null,
      rider_picked_up_at: null,
      rider_assignment_status: null,
      created_at: null,
    };
    pool.query
      .mockResolvedValueOnce([[RIDER]])
      .mockResolvedValueOnce([[order]])
      // batched loader — shop rows carry order_id
      .mockResolvedValueOnce([[{ order_id: 10, id: 1, name: 'Shop', latitude: 29.4, longitude: 75.6 }]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/rider/assignments/current')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.order.shops[0].latitude).toBe(29.4);
    expect(res.body.order.shops[0].lng).toBe(75.6);
    expect(res.body.order.lat).toBe(29.5);
  });
});
