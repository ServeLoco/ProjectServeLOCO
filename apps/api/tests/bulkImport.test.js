const request = require('supertest');
const express = require('express');
const AdmZip = require('adm-zip');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn()
  }
}));

jest.mock('../src/db/mongodb', () => ({
  getDb: jest.fn(() => ({
    collection: () => ({
      insertOne: jest.fn().mockResolvedValue({})
    })
  }))
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET
);

// Minimal JPG magic bytes — enough to satisfy the magic-byte sniff in the
// controller without producing a multi-kilobyte buffer per entry.
const JPG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const buildCsv = (rows) => {
  const header = 'name,price,unit,category,image_file\n';
  const body = rows.map(([name, imageFile]) =>
    `${name},10,piece,Snacks,${imageFile}`
  ).join('\n');
  return Buffer.from(header + (body ? body + '\n' : ''));
};

const buildZip = (entries) => {
  const zip = new AdmZip();
  for (const { name, content } of entries) {
    zip.addFile(name, content);
  }
  return zip.toBuffer();
};

describe('Bulk Import Hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects ZIPs with more than 500 entries', async () => {
    const zipBuffer = buildZip(
      Array.from({ length: 501 }, (_, i) => ({
        name: `image${i}.jpg`,
        content: Buffer.alloc(0),
      }))
    );
    const csvBuffer = buildCsv([['Chips', 'image0.jpg']]);

    const res = await request(app)
      .post('/api/admin/products/bulk-import?preview=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('imagesZip', zipBuffer, 'images.zip')
      .attach('csvFile', csvBuffer, 'products.csv');

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('ZIP file too large or contains too many files.');
  });

  it('rejects ZIPs whose uncompressed entries exceed 50 MB', async () => {
    // One entry with >50 MB uncompressed. Zeros compress extremely well, so
    // the ZIP buffer itself stays well under multer's 50 MB per-file cap.
    const zipBuffer = buildZip([
      { name: 'huge.jpg', content: Buffer.alloc(50 * 1024 * 1024 + 1024) },
    ]);
    const csvBuffer = buildCsv([['Chips', 'huge.jpg']]);

    const res = await request(app)
      .post('/api/admin/products/bulk-import?preview=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('imagesZip', zipBuffer, 'images.zip')
      .attach('csvFile', csvBuffer, 'products.csv');

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('ZIP file too large or contains too many files.');
  });

  it('silently skips path-traversal entries and only processes the safe one', async () => {
    const zipBuffer = buildZip([
      { name: '../etc/passwd.jpg', content: JPG_MAGIC },
      { name: 'normal.jpg', content: JPG_MAGIC },
    ]);
    const csvBuffer = buildCsv([['Chips', 'normal.jpg']]);

    // categories lookup
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Snacks', type: 'packed' }]]);
    // product existence check (no explicit id → name+category lookup, no match)
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/admin/products/bulk-import?preview=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('imagesZip', zipBuffer, 'images.zip')
      .attach('csvFile', csvBuffer, 'products.csv');

    expect(res.statusCode).toEqual(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].image_file).toBe('normal.jpg');
    expect(res.body.rows[0].name).toBe('Chips');
    expect(res.body.skipped).toEqual([]);
  });

  it('rejects CSVs with more than 1000 rows', async () => {
    const header = 'name,price,unit,category,image_file\n';
    const row = 'Chips,10,piece,Snacks,\n';
    const csvBuffer = Buffer.from(header + row.repeat(1001));
    const zipBuffer = buildZip([{ name: 'normal.jpg', content: JPG_MAGIC }]);

    const res = await request(app)
      .post('/api/admin/products/bulk-import?preview=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('imagesZip', zipBuffer, 'images.zip')
      .attach('csvFile', csvBuffer, 'products.csv');

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('CSV has too many rows (max 1000).');
  });
});
