/**
 * Tests for syncAreaShopOpenState (src/utils/shops.js) and its wiring:
 *   - PATCH /api/shop/me/toggle       (shopOwnerController.toggleMyShop)
 *   - PATCH /api/admin/shops/:id      (shopAdminController.updateShop)
 *   - PATCH /api/admin/settings       (settingsController.updateSettings)
 *
 * Rule (confirmed with the user): settings.delivery_available is the master
 * gate for the admin dashboard's "Shop Status" banner (settings.shop_open),
 * scoped per area since TASK 15.
 *   - delivery_available OFF  -> shop_open forced closed, no matter how many
 *     individual shops are open. Products still show in the customer app
 *     menu — only ordering is gated by shop_open elsewhere.
 *   - delivery_available ON   -> shop_open tracks whether ANY active shop is
 *     currently open: opening a shop can auto-turn it ON, closing the last
 *     open shop auto-turns it OFF. Bidirectional, unlike the shop_is_open
 *     per-product logic which has no such master gate.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/db/mysql');
const { emitToAllCustomers } = require('../src/realtime/socket');
const { syncAreaShopOpenState } = require('../src/utils/shops');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToAllCustomers: jest.fn(),
  emitToCustomer: jest.fn(),
}));

describe('syncAreaShopOpenState (unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forces shop_open closed when delivery_available is off, regardless of open shops', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 0 }]]) // settings lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]);         // UPDATE shop_open = 0

    await syncAreaShopOpenState(1);

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(2, 'UPDATE settings SET shop_open = 0 WHERE shop_open = 1 AND area_id = ?', [1]);
    expect(emitToAllCustomers).toHaveBeenCalledWith(
      'settings.shop_open.updated',
      expect.objectContaining({ shopOpen: false, shop_open: false })
    );
  });

  it('auto-opens shop_open when delivery is available and a shop is open', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])              // settings lookup
      .mockResolvedValueOnce([[{ total_active: 3, total_open: 1 }]])     // shops SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                     // UPDATE shop_open = 1

    await syncAreaShopOpenState(1);

    expect(pool.query).toHaveBeenNthCalledWith(3, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = ?', [1, 1, 1]);
    expect(emitToAllCustomers).toHaveBeenCalledWith(
      'settings.shop_open.updated',
      expect.objectContaining({ shopOpen: true, shop_open: true })
    );
  });

  it('auto-closes shop_open when delivery is available but zero shops are open', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([[{ total_active: 3, total_open: 0 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    await syncAreaShopOpenState(1);

    expect(pool.query).toHaveBeenNthCalledWith(3, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = ?', [0, 0, 1]);
    expect(emitToAllCustomers).toHaveBeenCalledWith(
      'settings.shop_open.updated',
      expect.objectContaining({ shopOpen: false, shop_open: false })
    );
  });

  it('does not emit when the value was already correct (no row changed)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([[{ total_active: 3, total_open: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // shop_open already 1

    await syncAreaShopOpenState(1);

    expect(emitToAllCustomers).not.toHaveBeenCalled();
  });

  it('no-ops in single-vendor deployments (no active shops at all)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([[{ total_active: 0, total_open: 0 }]]);

    await syncAreaShopOpenState(1);

    expect(pool.query).toHaveBeenCalledTimes(2); // settings + SUM only, no UPDATE
  });

  it('swallows DB errors without throwing', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(syncAreaShopOpenState(1)).resolves.toBeUndefined();
  });
});

describe('toggleMyShop wiring — PATCH /api/shop/me/toggle', () => {
  const shopRoutes = require('../src/routes/shopRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/shop', shopRoutes);

  const customerToken = jwt.sign(
    { id: 7, role: 'customer' },
    process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
  );
  const SHOP_ROW = [{ id: 1, name: 'Burger Point', is_open: 1, active: 1, area_id: 1 }];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opening the shop syncs the global banner on (delivery available)', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])                                    // requireShopOwner lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }])                         // UPDATE shops SET is_open = 1
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point', is_open: 1, active: 1 }]]) // re-select
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])                 // sync: settings lookup
      .mockResolvedValueOnce([[{ total_active: 1, total_open: 1 }]])        // sync: shops SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }])                         // sync: UPDATE settings shop_open = 1
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                        // bustAreaCaches: catalog_version bump

    const res = await request(app)
      .patch('/api/shop/me/toggle')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ is_open: true });

    expect(res.statusCode).toEqual(200);
    expect(pool.query).toHaveBeenNthCalledWith(6, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = ?', [1, 1, 1]);
    expect(pool.query).toHaveBeenLastCalledWith('UPDATE areas SET catalog_version = catalog_version + 1 WHERE id = ?', [1]);
  });

  it('closing the last open shop syncs the global banner off', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])              // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 0 }]])           // active-orders guard
      .mockResolvedValueOnce([{ affectedRows: 1 }])    // UPDATE shops SET is_open = 0
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point', is_open: 0, active: 1 }]]) // re-select
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])   // sync: settings lookup
      .mockResolvedValueOnce([[{ total_active: 1, total_open: 0 }]]) // sync: shops SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }])    // sync: UPDATE settings shop_open = 0
      .mockResolvedValueOnce([{ affectedRows: 1 }]);   // bustAreaCaches: catalog_version bump

    const res = await request(app)
      .patch('/api/shop/me/toggle')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ is_open: false });

    expect(res.statusCode).toEqual(200);
    expect(pool.query).toHaveBeenNthCalledWith(7, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = ?', [0, 0, 1]);
    expect(pool.query).toHaveBeenLastCalledWith('UPDATE areas SET catalog_version = catalog_version + 1 WHERE id = ?', [1]);
  });
});

describe('updateShop wiring — PATCH /api/admin/shops/:id', () => {
  const adminRoutes = require('../src/routes/adminRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);

  const adminToken = jwt.sign(
    { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
    process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('setting is_open=false triggers the sync', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])            // existence check
      .mockResolvedValueOnce([{ affectedRows: 1 }])    // UPDATE shops SET is_open = 0
      .mockResolvedValueOnce([[{                        // fetchShopRow re-query
        id: 1, name: 'Burger Point', is_open: 0, active: 1,
        owner_user_id: 7, owner_name: 'Reza', owner_phone: '9999999999',
        product_count: 0, created_at: '2026-07-09 00:00:00'
      }]])
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])          // sync: settings lookup
      .mockResolvedValueOnce([[{ total_active: 1, total_open: 0 }]]) // sync: shops SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }])                  // sync: UPDATE settings
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                 // bustAreaCaches: catalog_version bump

    const res = await request(app)
      .patch('/api/admin/shops/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ is_open: false });

    expect(res.statusCode).toEqual(200);
    expect(pool.query).toHaveBeenNthCalledWith(6, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = ?', [0, 0, 1]);
    expect(pool.query).toHaveBeenLastCalledWith('UPDATE areas SET catalog_version = catalog_version + 1 WHERE id = ?', [1]);
  });
});
