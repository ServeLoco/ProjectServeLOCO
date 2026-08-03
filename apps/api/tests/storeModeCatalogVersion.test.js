/**
 * TASK 27.1 — storeModeController.js's create/update never bumped
 * catalog_version (only invalidateStoreModeCache), even though a store
 * mode is catalog data (§2.4, gates which dashboard/products a customer
 * can reach) and every other catalog write already reaches
 * bustAreaCaches -> bumpCatalogVersion. Fixed by routing both through
 * bustAreaCaches instead of calling invalidateStoreModeCache directly.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('storeModeController catalog_version wiring (TASK 27.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('createStoreMode bumps catalog_version via bustAreaCaches', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // duplicate slug check
      .mockResolvedValueOnce([[{ activeCount: 1 }]]) // active mode count
      .mockResolvedValueOnce([[{ maxOrder: 2 }]]) // max display_order
      .mockResolvedValueOnce([{ insertId: 50 }]) // INSERT
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // bumpCatalogVersion's UPDATE areas

    const res = await request(app)
      .post('/api/admin/store-modes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'grab_go', label: 'Grab & Go' });

    expect(res.statusCode).toEqual(201);
    const catalogVersionCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE areas SET catalog_version'));
    expect(catalogVersionCall).toBeDefined();
    expect(catalogVersionCall[1]).toEqual([1]);
  });

  it('updateStoreMode bumps catalog_version via bustAreaCaches', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 50, area_id: 1, slug: 'grab_go', label: 'Grab & Go', active: 1, is_system: 0 }]]) // existing row
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE store_modes
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // bumpCatalogVersion's UPDATE areas

    const res = await request(app)
      .patch('/api/admin/store-modes/50')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ label: 'Grab & Go Fast' });

    expect(res.statusCode).toEqual(200);
    const catalogVersionCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE areas SET catalog_version'));
    expect(catalogVersionCall).toBeDefined();
    expect(catalogVersionCall[1]).toEqual([1]);
  });
});
