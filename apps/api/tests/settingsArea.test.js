/**
 * TASK 9.7 — settings is genuinely one row per area, not a global singleton.
 */
const { getSettings, getAdminSettings, updateSettings } = require('../src/controllers/settingsController');
const { getImages } = require('../src/controllers/imageController');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../src/db/mysql');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getSettings — per area', () => {
  it("area 1's read queries WHERE area_id = 1 and returns only area 1's row", async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, area_id: 1, shop_open: 1, upi_qr_image_id: null }]]);

    const req = { areaId: 1 };
    const res = mockRes();
    await getSettings(req, res);

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [1]);
    expect(res.json).toHaveBeenCalledWith({ data: expect.objectContaining({ area_id: 1, shop_open: 1 }) });
  });

  it("area 2's read queries WHERE area_id = 2 and never returns area 1's values", async () => {
    // A different shop_open value than area 1's above proves this isn't
    // just reading whatever the last query happened to cache.
    pool.query.mockResolvedValueOnce([[{ id: 2, area_id: 2, shop_open: 0, upi_qr_image_id: null }]]);

    const req = { areaId: 2 };
    const res = mockRes();
    await getSettings(req, res);

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [2]);
    const [[response]] = res.json.mock.calls;
    expect(response.data.area_id).toBe(2);
    expect(response.data.shop_open).toBe(0);
    expect(response.data.area_id).not.toBe(1);
  });

  it('a null areaId (pin outside every zone) falls back to the default area rather than erroring', async () => {
    // A distinct area id (5) so this test's cache entry (settings:5) can't
    // collide with the "area 1" test above, which already warmed settings:1
    // in the same 15s-TTL cache this controller module owns.
    pool.query
      .mockResolvedValueOnce([[{ id: 5, code: 'A5', name: 'Area 5', active: 1, is_default: 1 }]]) // listAreas
      .mockResolvedValueOnce([[{ id: 5, area_id: 5, shop_open: 1 }]]); // settings for the default area

    const req = { areaId: null };
    const res = mockRes();
    await getSettings(req, res);

    expect(pool.query).toHaveBeenLastCalledWith('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [5]);
  });
});

/**
 * Bug fix (found by live multi-area flow testing): GET /api/admin/settings
 * used to reuse the PUBLIC getSettings above, inheriting its deliberate
 * default-area fallback (§2.4). On the admin route that silently served the
 * DEFAULT area's row — including its `upi_id` — to a super_admin on "All
 * areas" or with no area picked, indistinguishable from having genuinely
 * selected area 1, while PATCH on the same screen correctly refused 'all'.
 * Reading the wrong area's payment target is exactly the money-routing
 * confusion §9.4 item 4 exists to prevent.
 */
describe('getAdminSettings — admin read refuses to guess an area', () => {
  it("400s on 'all' instead of silently serving the default area's row", async () => {
    const req = { areaId: 'all' };
    const res = mockRes();
    await getAdminSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('400s when no area is picked (super_admin, no X-Area-Id)', async () => {
    const req = { areaId: null };
    const res = mockRes();
    await getAdminSettings(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // A fresh area id: getSettingsForArea reads through a TTL cache, and
  // areas 1/2/5 are already warm from the getSettings tests above.
  it('serves the requested area normally when exactly one is picked', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 7, area_id: 7, shop_open: 0, upi_qr_image_id: null }]]);

    const req = { areaId: 7 };
    const res = mockRes();
    await getAdminSettings(req, res);

    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [7]);
    expect(res.json).toHaveBeenCalledWith({ data: expect.objectContaining({ area_id: 7 }) });
  });
});

describe('updateSettings — write targets exactly one area', () => {
  it('rejects with 400 when no area was selected (super_admin, no X-Area-Id)', async () => {
    const req = { areaId: null, body: { shop_open: true } };
    const res = mockRes();
    await updateSettings(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects with 400 for "all" areas — settings cannot be written cross-area', async () => {
    const req = { areaId: 'all', body: { shop_open: true } };
    const res = mockRes();
    await updateSettings(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("writes to area 2's row only when areaId is 2", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 2, upi_qr_image_id: null }]]) // existence check, area 2's row
      .mockResolvedValueOnce([{}]) // UPDATE
      .mockResolvedValueOnce([[{ id: 2, area_id: 2, shop_open: 0 }]]); // return updated

    const req = { areaId: 2, body: { shop_open: false } };
    const res = mockRes();
    await updateSettings(req, res);

    expect(pool.query).toHaveBeenCalledWith('SELECT id, upi_qr_image_id FROM settings WHERE area_id = ? LIMIT 1', [2]);
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toContain('AND area_id = ?');
    expect(updateCall[1]).toContain(2);
  });
});

describe('getUsedImageIds (via GET /admin/images) — both areas report their UPI image in use', () => {
  it('an image used as area 1\'s UPI QR and a different image used as area 2\'s both report in_use', async () => {
    // getImages queries `images` first, then getUsedImageIds' six queries.
    pool.query
      .mockResolvedValueOnce([[
        { id: 101, filename: 'area1-qr.png', created_at: new Date() },
        { id: 202, filename: 'area2-qr.png', created_at: new Date() },
        { id: 303, filename: 'unused.png', created_at: new Date() },
      ]]) // images
      .mockResolvedValueOnce([[]]) // products
      .mockResolvedValueOnce([[]]) // categories
      .mockResolvedValueOnce([[]]) // combos
      .mockResolvedValueOnce([[]]) // offers
      // BOTH areas' settings rows — the bug this fixes was a LIMIT 1 that
      // could only ever see one of them.
      .mockResolvedValueOnce([[{ upi_qr_image_id: 101 }, { upi_qr_image_id: 202 }]])
      .mockResolvedValueOnce([[]]) // store_modes
      .mockResolvedValueOnce([[]]) // product_library
      .mockResolvedValueOnce([[]]) // category_library
      .mockResolvedValueOnce([[]]); // store_mode_library

    const req = {};
    const res = mockRes();
    await getImages(req, res);

    const [[response]] = res.json.mock.calls;
    const byId = Object.fromEntries(response.data.map((img) => [img.id, img]));
    expect(byId['101'].in_use).toBe(true);
    expect(byId['101'].usage).toContain('Settings');
    expect(byId['202'].in_use).toBe(true);
    expect(byId['202'].usage).toContain('Settings');
    expect(byId['303'].in_use).toBe(false);
  });
});
