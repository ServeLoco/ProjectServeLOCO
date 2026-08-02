jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
}));

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../src/utils/notificationService', () => ({
  getUnreadCount: jest.fn(),
}));

const { pool } = require('../src/db/mysql');
const notificationService = require('../src/utils/notificationService');
const { emitToAdmins, emitToCustomer } = require('../src/realtime/socket');
const realtimeEvents = require('../src/realtime/orderEvents');

describe('Realtime order events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits order creation to the owning customer and admins', () => {
    const payload = realtimeEvents.emitOrderCreated({
      id: 77,
      area_id: 1,
      order_number: 'OD-20260529-0001',
      customer_id: 42,
      customer_name: 'Ravi Kumar',
      address: '12 MG Road, Bengaluru',
      payment_method: 'UPI',
      status: 'Pending',
      payment_status: 'Pending',
      total: 250,
      created_at: '2026-05-29T10:00:00.000Z',
      updated_at: '2026-05-29T10:00:00.000Z',
    });

    expect(payload).toEqual({
      orderId: 77,
      orderNumber: 'OD-20260529-0001',
      customerId: 42,
      customerName: 'Ravi Kumar',
      customerPhone: undefined,
      address: '12 MG Road, Bengaluru',
      latitude: undefined,
      longitude: undefined,
      mapUrl: null,
      map_url: null,
      paymentMethod: 'UPI',
      status: 'Pending',
      paymentStatus: 'Pending',
      cancelReason: null,
      cancel_reason: null,
      total: 250,
      items: undefined,
      createdAt: '2026-05-29T10:00:00.000Z',
      updatedAt: '2026-05-29T10:00:00.000Z',
    });
    expect(emitToCustomer).toHaveBeenCalledWith(42, 'order.created', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(42, 'order.updated', payload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.created', payload);
  });

  it('emits status updates to the owning customer and admins', () => {
    const payload = realtimeEvents.emitOrderStatusUpdated({
      orderId: 78,
      areaId: 1,
      orderNumber: 'OD-20260529-0002',
      customerId: 43,
      status: 'Out for Delivery',
      paymentStatus: 'Pending',
      total: 340,
      updatedAt: '2026-05-29T11:00:00.000Z',
    });

    expect(emitToCustomer).toHaveBeenCalledWith(43, 'order.status.updated', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(43, 'order.updated', payload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.updated', payload);
  });

  it('emits payment updates to the owning customer and admins', () => {
    const payload = realtimeEvents.emitOrderPaymentUpdated({
      id: 79,
      area_id: 1,
      order_number: 'OD-20260529-0003',
      customer_id: 44,
      status: 'Delivered',
      payment_status: 'Paid',
      total: 125,
      updated_at: '2026-05-29T12:00:00.000Z',
    });

    expect(emitToCustomer).toHaveBeenCalledWith(44, 'order.payment.updated', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(44, 'order.updated', payload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.updated', payload);
  });

  it('emits cancelled orders to the owning customer and admins', () => {
    const payload = realtimeEvents.emitOrderCancelled({
      id: 80,
      area_id: 1,
      order_number: 'OD-20260529-0004',
      customer_id: 45,
      status: 'Cancelled',
      payment_status: 'Pending',
      total: 199,
      updated_at: '2026-05-29T13:00:00.000Z',
    });

    expect(emitToCustomer).toHaveBeenCalledWith(45, 'order.cancelled', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(45, 'order.status.updated', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(45, 'order.updated', payload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.updated', payload);
  });

  it('emits created notifications and unread count updates', async () => {
    pool.query.mockResolvedValueOnce([[
      {
        id: 91,
        title: 'Order accepted',
        body: 'Your order has been accepted.',
        type: 'info',
        source_type: 'order',
        source_id: 77,
        action_type: 'open_order',
        action_payload: JSON.stringify({ orderId: 77 }),
        created_at: '2026-05-29T14:00:00.000Z',
      },
    ]]);
    notificationService.getUnreadCount.mockResolvedValueOnce(3);

    const payload = await realtimeEvents.emitNotificationCreated(42, { insertId: 91 });

    expect(payload).toEqual({
      id: 91,
      title: 'Order accepted',
      body: 'Your order has been accepted.',
      type: 'info',
      sourceType: 'order',
      sourceId: 77,
      actionType: 'open_order',
      actionPayload: { orderId: 77 },
      createdAt: '2026-05-29T14:00:00.000Z',
    });
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [91, 42]
    );
    expect(emitToCustomer).toHaveBeenCalledWith(42, 'notification.created', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(
      42,
      'notification.unread_count.updated',
      { unreadCount: 3 }
    );
  });

  it('toOrderEventPayload uses empty object default when order is undefined', () => {
    const payload = realtimeEvents.toOrderEventPayload(undefined);
    expect(payload).toEqual({
      orderId: undefined,
      orderNumber: undefined,
      customerId: undefined,
      customerName: undefined,
      customerPhone: undefined,
      address: undefined,
      latitude: undefined,
      longitude: undefined,
      mapUrl: null,
      map_url: null,
      paymentMethod: undefined,
      status: undefined,
      paymentStatus: undefined,
      cancelReason: null,
      cancel_reason: null,
      total: undefined,
      items: undefined,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('toOrderEventPayload throws when order is explicitly null', () => {
    expect(() => realtimeEvents.toOrderEventPayload(null)).toThrow();
  });

  it('toOrderEventPayload normalizes snake_case DB fields to camelCase', () => {
    const payload = realtimeEvents.toOrderEventPayload({
      id: 10,
      order_number: 'OD-100',
      customer_id: 55,
      status: 'Accepted',
      payment_status: 'Paid',
      total: 500,
      updated_at: '2026-05-29T15:00:00.000Z',
    });
    expect(payload.orderId).toBe(10);
    expect(payload.orderNumber).toBe('OD-100');
    expect(payload.customerId).toBe(55);
    expect(payload.paymentStatus).toBe('Paid');
    expect(payload.updatedAt).toBe('2026-05-29T15:00:00.000Z');
  });

  it('toOrderEventPayload also accepts pre-normalized camelCase fields', () => {
    const payload = realtimeEvents.toOrderEventPayload({
      orderId: 11,
      orderNumber: 'OD-101',
      customerId: 56,
      status: 'Pending',
      paymentStatus: 'Pending',
      total: 200,
      updatedAt: '2026-05-29T16:00:00.000Z',
    });
    expect(payload.orderId).toBe(11);
    expect(payload.orderNumber).toBe('OD-101');
    expect(payload.customerId).toBe(56);
  });

  it('emitNotificationCreated returns null when userId is missing', async () => {
    const result = await realtimeEvents.emitNotificationCreated(null, { insertId: 1 });
    expect(result).toBeNull();
    expect(emitToCustomer).not.toHaveBeenCalled();
  });

  it('emitNotificationCreated returns null when insertId is missing', async () => {
    const result = await realtimeEvents.emitNotificationCreated(42, {});
    expect(result).toBeNull();
    expect(emitToCustomer).not.toHaveBeenCalled();
  });

  it('emitNotificationCreated returns null when DB finds no matching row', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const result = await realtimeEvents.emitNotificationCreated(42, { insertId: 999 });
    expect(result).toBeNull();
    expect(emitToCustomer).not.toHaveBeenCalled();
  });

  it('emitNotificationCreated still emits notification even if getUnreadCount fails', async () => {
    pool.query.mockResolvedValueOnce([[
      {
        id: 92,
        title: 'Order delivered',
        body: 'Your order has been delivered.',
        type: 'success',
        source_type: 'order',
        source_id: 80,
        action_type: 'open_order',
        action_payload: '{"orderId":80}',
        created_at: '2026-05-29T17:00:00.000Z',
      },
    ]]);
    notificationService.getUnreadCount.mockRejectedValueOnce(new Error('DB read failure'));

    const payload = await realtimeEvents.emitNotificationCreated(42, { insertId: 92 });

    expect(payload).not.toBeNull();
    expect(emitToCustomer).toHaveBeenCalledWith(42, 'notification.created', expect.objectContaining({ id: 92 }));
    expect(emitToCustomer).not.toHaveBeenCalledWith(
      42,
      'notification.unread_count.updated',
      expect.anything()
    );
  });

  it('emitNotificationCreated parses action_payload from JSON string', async () => {
    pool.query.mockResolvedValueOnce([[
      {
        id: 93,
        title: 'Payment received',
        body: 'Payment confirmed.',
        type: 'success',
        source_type: 'order',
        source_id: 81,
        action_type: 'open_order',
        action_payload: '{"orderId":81}',
        created_at: '2026-05-29T18:00:00.000Z',
      },
    ]]);
    notificationService.getUnreadCount.mockResolvedValueOnce(1);

    const payload = await realtimeEvents.emitNotificationCreated(42, { insertId: 93 });
    expect(payload.actionPayload).toEqual({ orderId: 81 });
  });

  it('emitNotificationCreated handles action_payload as already-parsed object', async () => {
    pool.query.mockResolvedValueOnce([[
      {
        id: 94,
        title: 'Refund processed',
        body: 'Your payment was refunded.',
        type: 'info',
        source_type: 'order',
        source_id: 82,
        action_type: 'open_order',
        action_payload: { orderId: 82 },
        created_at: '2026-05-29T19:00:00.000Z',
      },
    ]]);
    notificationService.getUnreadCount.mockResolvedValueOnce(0);

    const payload = await realtimeEvents.emitNotificationCreated(42, { insertId: 94 });
    expect(payload.actionPayload).toEqual({ orderId: 82 });
  });

  it('emitNotificationCreated handles null action_payload gracefully', async () => {
    pool.query.mockResolvedValueOnce([[
      {
        id: 95,
        title: 'General alert',
        body: 'Something happened.',
        type: 'warning',
        source_type: null,
        source_id: null,
        action_type: null,
        action_payload: null,
        created_at: '2026-05-29T20:00:00.000Z',
      },
    ]]);
    notificationService.getUnreadCount.mockResolvedValueOnce(2);

    const payload = await realtimeEvents.emitNotificationCreated(42, { insertId: 95 });
    expect(payload.actionPayload).toBeNull();
    expect(payload.type).toBe('warning');
    expect(payload.title).toBe('General alert');
  });

  it('emitNotificationRow returns null when userId is falsy', async () => {
    const result = await realtimeEvents.emitNotificationRow(null, { id: 1 });
    expect(result).toBeNull();
  });

  it('emitNotificationRow returns null when notification is falsy', async () => {
    const result = await realtimeEvents.emitNotificationRow(42, null);
    expect(result).toBeNull();
  });

  it('emitNotificationRow uses camelCase fields from notification object', async () => {
    notificationService.getUnreadCount.mockResolvedValueOnce(5);

    const payload = await realtimeEvents.emitNotificationRow(42, {
      id: 96,
      title: 'Order placed',
      body: 'Order confirmed.',
      type: 'order',
      sourceType: 'order',
      sourceId: 90,
      actionType: 'open_order',
      actionPayload: { orderId: 90 },
      createdAt: '2026-05-29T21:00:00.000Z',
    });

    expect(payload).toEqual({
      id: 96,
      title: 'Order placed',
      body: 'Order confirmed.',
      type: 'order',
      sourceType: 'order',
      sourceId: 90,
      actionType: 'open_order',
      actionPayload: { orderId: 90 },
      createdAt: '2026-05-29T21:00:00.000Z',
    });
    expect(emitToCustomer).toHaveBeenCalledWith(42, 'notification.created', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(
      42,
      'notification.unread_count.updated',
      { unreadCount: 5 }
    );
  });

  it('emitOrderCancelled emits all expected events including order.updated', () => {
    const order = {
      id: 100,
      area_id: 1,
      order_number: 'OD-100',
      customer_id: 60,
      status: 'Cancelled',
      payment_status: 'Pending',
      total: 150,
      updated_at: '2026-05-29T22:00:00.000Z',
    };
    const payload = realtimeEvents.emitOrderCancelled(order);

    expect(emitToCustomer).toHaveBeenCalledWith(60, 'order.cancelled', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(60, 'order.status.updated', payload);
    expect(emitToCustomer).toHaveBeenCalledWith(60, 'order.updated', payload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.updated', payload);
  });

  it('emitOrderCreated and emitOrderStatusUpdated emit different event names', () => {
    realtimeEvents.emitOrderCreated({
      id: 110, area_id: 1, order_number: 'OD-110', customer_id: 70,
      status: 'Pending', payment_status: 'Pending', total: 100,
      updated_at: '2026-05-29T23:00:00.000Z',
    });
    jest.clearAllMocks();

    const statusPayload = realtimeEvents.emitOrderStatusUpdated({
      id: 110, areaId: 1, orderNumber: 'OD-110', customerId: 70,
      status: 'Accepted', paymentStatus: 'Pending', total: 100,
      updatedAt: '2026-05-29T23:05:00.000Z',
    });

    expect(emitToCustomer).toHaveBeenCalledWith(70, 'order.status.updated', statusPayload);
    expect(emitToAdmins).toHaveBeenCalledWith(1, 'admin.order.updated', statusPayload);
    expect(emitToCustomer).not.toHaveBeenCalledWith(70, 'order.created', expect.anything());
  });
});
