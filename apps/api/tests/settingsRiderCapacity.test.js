/**
 * settings.rider_capacity_multiplier — the per-area knob behind the checkout
 * capacity gate (orderController.js) and GET /api/rider-capacity.
 *
 * Two rules it has to keep:
 *   1. Admins can read and write it; customers must never receive it. It has
 *      no customer-facing meaning, and the public settings payload is served
 *      to anyone with a pin.
 *   2. It is bounded on both ends. Under 1 the gate closes an area to new
 *      checkouts on its first order; over the ceiling a typo (30 for 3)
 *      silently switches the gate off and orders pile up unassigned.
 */
const { getSettings, getAdminSettings, updateSettings, bustSettingsCache } = require('../src/controllers/settingsController');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('../src/utils/shops', () => ({
  syncAreaShopOpenState: jest.fn().mockResolvedValue(undefined),
}));

const { pool } = require('../src/db/mysql');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// Distinct area ids per test — settingsController owns a 15s TTL cache, so
// reusing one id would serve a warmed row and eat a mocked query.
beforeEach(() => {
  jest.clearAllMocks();
  [41, 42, 43].forEach(bustSettingsCache);
});

describe('rider_capacity_multiplier visibility', () => {
  it('is stripped from the PUBLIC settings payload', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 41, area_id: 41, shop_open: 1, upi_id: 'area41@upi', rider_capacity_multiplier: '4.00',
    }]]);

    const req = { areaId: 41 };
    const res = mockRes();
    await getSettings(req, res);

    const [[response]] = res.json.mock.calls;
    expect(response.data).not.toHaveProperty('rider_capacity_multiplier');
    // The fields customers legitimately need are untouched.
    expect(response.data.upi_id).toBe('area41@upi');
    expect(response.data.shop_open).toBe(1);
  });

  // Both reads share one 15s-TTL cached object. Stripping the field in place
  // rather than on a copy would blank it for the admin too — and only for
  // whichever area a customer happened to load first, so the Settings form
  // would lose the value intermittently and look like a save bug.
  it('a public read does not strip the field from the cached row the admin read shares', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 41, area_id: 41, shop_open: 1, rider_capacity_multiplier: '4.00',
    }]]);

    const publicRes = mockRes();
    await getSettings({ areaId: 41 }, publicRes);
    expect(publicRes.json.mock.calls[0][0].data).not.toHaveProperty('rider_capacity_multiplier');

    // Same area, served from cache — no second query is mocked on purpose.
    const adminRes = mockRes();
    await getAdminSettings({ areaId: 41 }, adminRes);
    expect(adminRes.json.mock.calls[0][0].data.rider_capacity_multiplier).toBe('4.00');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('is still returned to the ADMIN read, which is what edits it', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 42, area_id: 42, shop_open: 1, rider_capacity_multiplier: '4.00',
    }]]);

    const req = { areaId: 42 };
    const res = mockRes();
    await getAdminSettings(req, res);

    const [[response]] = res.json.mock.calls;
    expect(response.data.rider_capacity_multiplier).toBe('4.00');
  });
});

describe('rider_capacity_multiplier validation', () => {
  const patch = async (value) => {
    const req = { areaId: 43, body: { rider_capacity_multiplier: value } };
    const res = mockRes();
    await updateSettings(req, res);
    return res;
  };

  it.each([0, 0.5, -3])('rejects %p — the gate would close the area on its first order', async (value) => {
    const res = await patch(value);
    expect(res.status).toHaveBeenCalledWith(400);
    const [[body]] = res.json.mock.calls;
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toMatch(/between 1 and/);
  });

  it.each([21, 300])('rejects %p — a typo this size silently disables the gate', async (value) => {
    const res = await patch(value);
    expect(res.status).toHaveBeenCalledWith(400);
    const [[body]] = res.json.mock.calls;
    expect(body.message).toMatch(/between 1 and/);
  });

  it('accepts an in-range value and stores it as a number, not a string', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 43, upi_qr_image_id: null }]]) // existing row lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // the UPDATE
      .mockResolvedValueOnce([[{ id: 43, area_id: 43, rider_capacity_multiplier: '2.50' }]]); // re-read

    const res = await patch('2.5');

    expect(res.status).toHaveBeenCalledWith(200);
    const updateCall = pool.query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE settings SET'));
    expect(updateCall[0]).toContain('rider_capacity_multiplier = ?');
    // Coerced, so MySQL never has to cast a string into a DECIMAL column.
    expect(updateCall[1][0]).toBe(2.5);
  });
});
