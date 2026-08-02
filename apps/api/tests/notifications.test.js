const request = require('supertest');

jest.mock('../src/db/mongodb', () => ({
  getDb: () => ({
    collection: () => ({
      insertOne: jest.fn().mockResolvedValue({})
    })
  })
}));

jest.mock('../src/db/mysql', () => {
  const state = {
    nextUserId: 1,
    nextBatchId: 1,
    nextNotificationId: 1,
    users: [],
    batches: [],
    notifications: []
  };

  const runQuery = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO users')) {
      const id = state.nextUserId++;
      state.users.push({ id, phone: params[0], name: params[1], password_hash: params[2], blocked: 0 });
      return [{ insertId: id, affectedRows: 1 }];
    }

    if (normalized.startsWith('DELETE FROM users')) {
      state.users = state.users.filter(user => user.id !== params[0]);
      return [{ affectedRows: 1 }];
    }

    if (normalized.startsWith('SELECT id FROM users WHERE blocked = 0')) {
      // Matches both the 'all areas' form and the per-area
      // "AND last_area_id = ?" form — this in-memory mock doesn't model
      // last_area_id, so every non-blocked user counts as a recipient
      // either way (real per-area filtering is covered by the controller's
      // own unit-level tests, not this integration-style fixture).
      return [state.users.filter(user => !user.blocked).map(user => ({ id: user.id }))];
    }

    if (normalized.startsWith('INSERT INTO notification_batches')) {
      const id = state.nextBatchId++;
      state.batches.push({
        id,
        area_id: params[0],
        title: params[1],
        body: params[2],
        type: params[3],
        target: params[4],
        recipient_count: params[5],
        created_by_admin_id: params[6],
        created_at: new Date(),
        deleted_at: null
      });
      return [{ insertId: id, affectedRows: 1 }];
    }

    if (normalized.startsWith('INSERT IGNORE INTO notifications')) {
      const rows = Array.isArray(params[0]) ? params[0] : [params];
      rows.forEach(row => {
        state.notifications.push({
          id: state.nextNotificationId++,
          user_id: row[0],
          title: row[1],
          body: row[2],
          type: row[3],
          source_type: row[4],
          source_id: row[5],
          event_key: row[6],
          batch_id: row[7],
          action_type: row[8],
          action_payload: row[9],
          created_by_admin_id: row[10],
          created_at: new Date(),
          read_at: null,
          deleted_at: null
        });
      });
      return [{ affectedRows: rows.length }];
    }

    if (normalized.startsWith('SELECT COUNT(*) as count FROM notifications')) {
      const userId = params[0];
      const count = state.notifications.filter(row => row.user_id === userId && !row.read_at && !row.deleted_at).length;
      return [[{ count }]];
    }

    if (normalized.startsWith('SELECT id, title, body, type, source_type, source_id, action_type, action_payload, read_at, created_at FROM notifications WHERE user_id = ?')) {
      const userId = params[0];
      return [state.notifications.filter(row => row.user_id === userId && !row.deleted_at)];
    }

    if (normalized.startsWith('SELECT COUNT(*) as total FROM notifications WHERE user_id = ?')) {
      const userId = params[0];
      const total = state.notifications.filter(row => row.user_id === userId && !row.deleted_at).length;
      return [[{ total }]];
    }

    if (normalized.startsWith('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE id = ?')) {
      const [id, userId] = params;
      const notification = state.notifications.find(row => row.id === Number(id) && row.user_id === userId && !row.read_at && !row.deleted_at);
      if (notification) {
        notification.read_at = new Date();
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }

    if (normalized.startsWith('SELECT id, read_at FROM notifications WHERE id = ?')) {
      const [id, userId] = params;
      return [state.notifications.filter(row => row.id === Number(id) && row.user_id === userId && !row.deleted_at)];
    }

    if (normalized.startsWith('UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ?')) {
      const userId = params[0];
      let affectedRows = 0;
      state.notifications.forEach(row => {
        if (row.user_id === userId && !row.read_at && !row.deleted_at) {
          row.read_at = new Date();
          affectedRows += 1;
        }
      });
      return [{ affectedRows }];
    }

    if (normalized.startsWith('UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')) {
      const [id, userId] = params;
      const notification = state.notifications.find(row => row.id === Number(id) && row.user_id === userId && !row.deleted_at);
      if (notification) {
        notification.deleted_at = new Date();
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    }

    if (normalized.startsWith('UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND deleted_at IS NULL')) {
      const userId = params[0];
      let affectedRows = 0;
      state.notifications.forEach(row => {
        if (row.user_id === userId && !row.deleted_at) {
          row.deleted_at = new Date();
          affectedRows += 1;
        }
      });
      return [{ affectedRows }];
    }

    if (normalized.startsWith('SELECT id FROM notifications WHERE id = ?')) {
      const [id, userId] = params;
      return [state.notifications.filter(row => row.id === Number(id) && row.user_id === userId)];
    }

    if (normalized.startsWith('SELECT * FROM notification_batches WHERE id = ?')) {
      const id = Number(params[0]);
      return [state.batches.filter(row => row.id === id && !row.deleted_at)];
    }

    if (normalized.startsWith('UPDATE notification_batches SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')) {
      const batch = state.batches.find(row => row.id === Number(params[0]));
      if (batch) batch.deleted_at = new Date();
      return [{ affectedRows: batch ? 1 : 0 }];
    }

    if (normalized.startsWith('UPDATE notifications SET deleted_at = CURRENT_TIMESTAMP WHERE batch_id = ?')) {
      const batchId = Number(params[0]);
      let affectedRows = 0;
      state.notifications.forEach(row => {
        if (row.batch_id === batchId && !row.deleted_at) {
          row.deleted_at = new Date();
          affectedRows += 1;
        }
      });
      return [{ affectedRows }];
    }

    return [[]];
  };

  const pool = {
    query: jest.fn(runQuery),
    getConnection: jest.fn(async () => ({
      query: jest.fn(runQuery),
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    })),
    end: jest.fn(),
    __state: state
  };

  return { pool };
});

const app = require('../src/app');
const { pool } = require('../src/db/mysql');
const { signCustomerToken, signAdminToken } = require('../src/utils/auth');

let userToken;
let adminToken;
let customerId;

beforeAll(async () => {
  // Create a test user
  const phone = '9999' + Math.floor(100000 + Math.random() * 900000);
  const [result] = await pool.query('INSERT INTO users (phone, name, password_hash) VALUES (?, ?, ?)', [phone, 'Test User', 'hash']);
  customerId = result.insertId;
  userToken = signCustomerToken(customerId);
  adminToken = signAdminToken(1, { adminRole: 'area_admin', areaId: 1 });
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE id = ?', [customerId]);
  await pool.end();
});

describe('Notifications API', () => {
  let batchId;
  let notificationId;

  it('Admin should be able to create a broadcast notification', async () => {
    const res = await request(app)
      .post('/api/admin/notifications')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Test Broadcast',
        body: 'This is a test broadcast',
        type: 'info',
        target: 'everyone'
      });
    
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('batchId');
    expect(res.body.data).toHaveProperty('pushEligibleCount');
    batchId = res.body.data.batchId;
  });

  it('Customer should be able to get unread count', async () => {
    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBeGreaterThan(0);
  });

  it('Customer should be able to get their notifications', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    
    notificationId = res.body.data[0].id;
  });

  it('Customer should be able to mark a notification as read', async () => {
    const res = await request(app)
      .patch(`/api/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('Customer should be able to mark all notifications as read', async () => {
    const res = await request(app)
      .patch('/api/notifications/read-all')
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('Unread count should be 0 after marking all as read', async () => {
    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('Customer should be able to delete a notification', async () => {
    const res = await request(app)
      .delete(`/api/notifications/${notificationId}`)
      .set('Authorization', `Bearer ${userToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('Customer should be able to clear all notifications', async () => {
    // Seed another notification for this user (simulate inbox with items left).
    await pool.query(
      'INSERT IGNORE INTO notifications (user_id, title, body, type, source_type, source_id, event_key, batch_id, action_type, action_payload, created_by_admin_id) VALUES ?',
      [[[customerId, 'Clear me', 'body', 'info', null, null, null, null, null, null, null]]]
    );

    const res = await request(app)
      .delete('/api/notifications/clear-all')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedCount).toBeGreaterThan(0);

    const list = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${userToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(0);
  });

  it('Admin should be able to delete a broadcast', async () => {
    const res = await request(app)
      .delete(`/api/admin/notifications/${batchId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
