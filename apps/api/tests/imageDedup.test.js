/**
 * TASK 18 — image sha256 dedupe on upload (§2.6/18.5) and product_library
 * inclusion in getUsedImageIds (§6.5/18.7).
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() }
}));

const { pool } = require('../src/db/mysql');
const imageRoutes = require('../src/routes/imageRoutes');
const { cleanupOrphanedImage } = require('../src/controllers/imageController');

const app = express();
app.use(express.json());
app.use('/api/admin/images', imageRoutes);

const token = jwt.sign({ id: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'secret');

describe('Image upload dedupe (TASK 18.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses an existing row with the same sha256 instead of inserting a duplicate', async () => {
    const existingRow = {
      id: 42, filename: 'existing.jpg', original_name: 'existing.jpg', mime_type: 'image/jpeg',
      size: 12, storage_type: 'disk', url: 'http://x/existing.jpg', alt_text: '', thumb_url: null,
      created_at: new Date(), updated_at: new Date(),
    };
    pool.query.mockImplementation((sql) => {
      if (sql.startsWith('SELECT * FROM images WHERE sha256')) {
        return Promise.resolve([[existingRow]]);
      }
      return Promise.resolve([[]]);
    });

    const fakeJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const res = await request(app)
      .post('/api/admin/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', fakeJpg, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.statusCode).toBe(200);
    expect(res.body.deduplicated).toBe(true);
    expect(res.body.data.id).toBe('42');
    // No INSERT should have happened — the dedupe hit short-circuits before processing/storage.
    expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO images'))).toBe(false);
  });

  it('inserts normally (with a computed sha256) when no existing row matches', async () => {
    let insertedParams = null;
    pool.query.mockImplementation((sql, params = []) => {
      if (sql.startsWith('SELECT * FROM images WHERE sha256')) {
        return Promise.resolve([[]]);
      }
      if (sql.startsWith('INSERT INTO images')) {
        insertedParams = params;
        return Promise.resolve([{ insertId: 7 }]);
      }
      if (sql.startsWith('SELECT * FROM images WHERE id')) {
        return Promise.resolve([[{
          id: 7, filename: 'new.jpg', original_name: 'new.jpg', mime_type: 'image/jpeg',
          size: 12, storage_type: 'disk', url: 'http://x/new.jpg', alt_text: '', thumb_url: null,
          created_at: new Date(), updated_at: new Date(),
        }]]);
      }
      return Promise.resolve([[]]);
    });

    const fakeJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const res = await request(app)
      .post('/api/admin/images')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', fakeJpg, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.statusCode).toBe(201);
    expect(res.body.deduplicated).toBe(false);
    // sha256 is the last bound param on the INSERT.
    expect(insertedParams[insertedParams.length - 1]).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('getUsedImageIds includes product_library (TASK 18.7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats a library-only image as in-use and blocks cleanup', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM product_library')) {
        return Promise.resolve([[{ image_id: '99' }]]);
      }
      if (sql.startsWith('SELECT * FROM images WHERE id')) {
        return Promise.resolve([[{ id: 99, storage_type: 'disk', filename: 'lib.jpg', thumb_url: null }]]);
      }
      return Promise.resolve([[]]);
    });

    const result = await cleanupOrphanedImage('99');
    expect(result).toEqual({ deleted: false, reason: 'still-in-use' });
    expect(pool.query.mock.calls.some(([sql]) => sql.startsWith('DELETE FROM images'))).toBe(false);
  });
});
