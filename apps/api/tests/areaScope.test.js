const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const areaScope = require('../src/utils/areaScope');
const { resolveAdminArea, resolveCustomerArea } = require('../src/middleware/areaMiddleware');

const {
  getAreaById,
  listAreas,
  getDefaultArea,
  resolveAreaForPoint,
  requestAreaId,
  assertAreaAccess,
  bumpCatalogVersion,
  bustAreaCaches,
  catalogETag,
  _resetCachesForTests,
} = areaScope;

const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, min_lat: null, max_lat: null, min_lng: null, max_lng: null };
const AREA_2_BBOXED = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0, min_lat: 40, max_lat: 41, min_lng: -74, max_lng: -73 };

// A simple square around (29.45, 75.66) — matches the shape used elsewhere
// in the delivery-zone tests in this repo.
const PARENT_BOUNDARY = [
  { lat: 29.40, lng: 75.60 },
  { lat: 29.40, lng: 75.72 },
  { lat: 29.50, lng: 75.72 },
  { lat: 29.50, lng: 75.60 },
];
// A small square nested entirely inside the parent above.
const CHILD_BOUNDARY = [
  { lat: 29.44, lng: 75.64 },
  { lat: 29.44, lng: 75.68 },
  { lat: 29.46, lng: 75.68 },
  { lat: 29.46, lng: 75.64 },
];

const PARENT_ZONE = { id: 10, area_id: 1, parent_zone_id: null, boundary: PARENT_BOUNDARY, active: 1 };
const CHILD_ZONE = { id: 11, area_id: 1, parent_zone_id: 10, boundary: CHILD_BOUNDARY, active: 1 };

const POINT_IN_PARENT_ONLY = { lat: 29.41, lng: 75.61 };
const POINT_IN_CHILD = { lat: 29.45, lng: 75.66 };
const POINT_OUTSIDE_EVERYTHING = { lat: 10, lng: 10 };

beforeEach(() => {
  jest.clearAllMocks();
  _resetCachesForTests();
});

describe('resolveAreaForPoint', () => {
  it('resolves a point inside one zone to that zone/area', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // bbox candidate areas
      .mockResolvedValueOnce([[PARENT_ZONE]]); // area 1's zones

    const result = await resolveAreaForPoint(POINT_IN_PARENT_ONLY.lat, POINT_IN_PARENT_ONLY.lng);
    expect(result).toEqual({ areaId: 1, zoneId: 10, zone: expect.objectContaining({ id: 10 }) });
  });

  it('a nested child zone wins over its parent (matchZone is reused, not reimplemented)', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[PARENT_ZONE, CHILD_ZONE]]);

    const result = await resolveAreaForPoint(POINT_IN_CHILD.lat, POINT_IN_CHILD.lng);
    expect(result.zoneId).toBe(11);
    expect(result.areaId).toBe(1);
  });

  it('a point inside an exclusion square still resolves via the containing regular zone (exclusion is not consulted here)', async () => {
    // No exclusion-zone query is ever issued — resolveAreaForPoint only
    // ever looks at delivery_zones. Blocking delivery inside an exclusion
    // square is resolveDeliveryPricing's job, orthogonal to area
    // resolution (see the comment in areaScope.js).
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[PARENT_ZONE]]);

    const result = await resolveAreaForPoint(POINT_IN_PARENT_ONLY.lat, POINT_IN_PARENT_ONLY.lng);
    expect(result).not.toBeNull();
    expect(result.areaId).toBe(1);
    expect(pool.query).toHaveBeenCalledTimes(2); // areas + zones only, never exclusion zones
  });

  it('returns null (never the default area) for a point outside every zone', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[PARENT_ZONE, CHILD_ZONE]]);

    const result = await resolveAreaForPoint(POINT_OUTSIDE_EVERYTHING.lat, POINT_OUTSIDE_EVERYTHING.lng);
    expect(result).toBeNull();
  });

  it('returns null for missing/NaN coordinates without querying the DB', async () => {
    expect(await resolveAreaForPoint(undefined, undefined)).toBeNull();
    expect(await resolveAreaForPoint('not-a-number', 75)).toBeNull();
    expect(await resolveAreaForPoint(NaN, NaN)).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('an area with no zones yet never matches, but does not error', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[]]); // no zones for area 1

    const result = await resolveAreaForPoint(POINT_IN_PARENT_ONLY.lat, POINT_IN_PARENT_ONLY.lng);
    expect(result).toBeNull();
  });

  it('the bbox prefilter excludes an area whose bbox cannot contain the point', async () => {
    // Area 2 has a real bbox far from the test point; area 1 has no bbox
    // yet (always a candidate). Only area 1's zones should be queried.
    pool.query
      .mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]) // all active areas
      .mockResolvedValueOnce([[PARENT_ZONE]]); // area 1's zones only

    const result = await resolveAreaForPoint(POINT_IN_PARENT_ONLY.lat, POINT_IN_PARENT_ONLY.lng);
    expect(result.areaId).toBe(1);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});

describe('getAreaById / listAreas / getDefaultArea (60s cache)', () => {
  it('caches the areas list across repeated calls', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]);

    const first = await listAreas();
    const second = await listAreas();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(pool.query).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('listAreas({activeOnly}) filters without a second query', async () => {
    const inactiveArea = { ...AREA_2_BBOXED, id: 3, active: 0 };
    pool.query.mockResolvedValueOnce([[AREA_1, inactiveArea]]);

    const active = await listAreas({ activeOnly: true });
    expect(active.map((a) => a.id)).toEqual([1]);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('getAreaById finds the matching row from the cached list', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]);
    const area = await getAreaById(2);
    expect(area).toEqual(AREA_2_BBOXED);
  });

  it('getDefaultArea returns the is_default row', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]);
    const def = await getDefaultArea();
    expect(def.id).toBe(1);
  });
});

describe('requestAreaId', () => {
  it('throws when middleware never set req.areaId', () => {
    expect(() => requestAreaId({})).toThrow(/never ran|area-resolution/i);
  });

  it('returns null and \'all\' as valid resolved values, not errors', () => {
    expect(requestAreaId({ areaId: null })).toBeNull();
    expect(requestAreaId({ areaId: 'all' })).toBe('all');
    expect(requestAreaId({ areaId: 1 })).toBe(1);
  });
});

describe('assertAreaAccess', () => {
  it('allows a super_admin into any area', () => {
    expect(() => assertAreaAccess({ admin: { adminRole: 'super_admin' } }, 5)).not.toThrow();
  });

  it('allows an area_admin into their own area', () => {
    expect(() => assertAreaAccess({ admin: { adminRole: 'area_admin', areaId: 1 } }, 1)).not.toThrow();
  });

  it('403s an area_admin targeting a different area', () => {
    expect(() => assertAreaAccess({ admin: { adminRole: 'area_admin', areaId: 1 } }, 2))
      .toThrow(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
  });

  it('403s when there is no admin context at all', () => {
    expect(() => assertAreaAccess({}, 1)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('bumpCatalogVersion / bustAreaCaches', () => {
  it('bumpCatalogVersion issues the increment update and invalidates the areas cache', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    await bumpCatalogVersion(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('catalog_version = catalog_version + 1'),
      [1]
    );
  });

  it('bustAreaCaches does not throw even when settingsController/storeMode are not loaded', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // the internal bumpCatalogVersion call
    await expect(bustAreaCaches(1)).resolves.toBeUndefined();
  });
});

describe('areaMiddleware.resolveAdminArea', () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('area_admin gets their own area with no header', () => {
    const req = { admin: { adminRole: 'area_admin', areaId: 4 }, headers: {} };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(req.areaId).toBe(4);
    expect(next).toHaveBeenCalledWith();
  });

  it('area_admin sending X-Area-Id gets 403, never a silent override', () => {
    const req = { admin: { adminRole: 'area_admin', areaId: 4 }, headers: { 'x-area-id': '9' } };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(req.areaId).toBeUndefined();
  });

  it('area_admin sending X-Area-Id: all also gets 403', () => {
    const req = { admin: { adminRole: 'area_admin', areaId: 4 }, headers: { 'x-area-id': 'all' } };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('super_admin with no header resolves to null (must pick an area explicitly)', () => {
    const req = { admin: { adminRole: 'super_admin' }, headers: {} };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(req.areaId).toBeNull();
    expect(next).toHaveBeenCalledWith();
  });

  it('super_admin with X-Area-Id: all gets the literal string \'all\'', () => {
    const req = { admin: { adminRole: 'super_admin' }, headers: { 'x-area-id': 'all' } };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(req.areaId).toBe('all');
  });

  it('super_admin with a numeric X-Area-Id gets that area as a number', () => {
    const req = { admin: { adminRole: 'super_admin' }, headers: { 'x-area-id': '7' } };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(req.areaId).toBe(7);
  });

  it('super_admin with a garbage X-Area-Id gets 400', () => {
    const req = { admin: { adminRole: 'super_admin' }, headers: { 'x-area-id': 'not-a-number' } };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('no admin on the request is a no-op (leaves req.areaId unset)', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();
    resolveAdminArea(req, res, next);
    expect(req.areaId).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });
});

describe('areaMiddleware.resolveCustomerArea', () => {
  it('a pin on the request resolves via resolveAreaForPoint', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[PARENT_ZONE]]);
    const req = { body: { latitude: POINT_IN_PARENT_ONLY.lat, longitude: POINT_IN_PARENT_ONLY.lng }, query: {} };
    const next = jest.fn();
    await resolveCustomerArea(req, {}, next);
    expect(req.areaId).toBe(1);
    expect(req.zoneId).toBe(10);
    expect(next).toHaveBeenCalledWith();
  });

  it('a pin that resolves to no zone yields null, not the default area', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[PARENT_ZONE]]);
    const req = { body: { lat: POINT_OUTSIDE_EVERYTHING.lat, lng: POINT_OUTSIDE_EVERYTHING.lng }, query: {} };
    const next = jest.fn();
    await resolveCustomerArea(req, {}, next);
    expect(req.areaId).toBeNull();
    expect(req.zoneId).toBeNull();
  });

  it('no pin, but a logged-in user with a last_area_id, uses that', async () => {
    pool.query.mockResolvedValueOnce([[{ last_area_id: 3 }]]);
    const req = { body: {}, query: {}, user: { id: 42 } };
    const next = jest.fn();
    await resolveCustomerArea(req, {}, next);
    expect(req.areaId).toBe(3);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('last_area_id'), [42]);
  });

  it('no pin and no usable last_area_id falls back to the default area', async () => {
    pool.query
      .mockResolvedValueOnce([[{ last_area_id: null }]]) // user row, no last_area_id yet
      .mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]); // listAreas for getDefaultArea
    const req = { body: {}, query: {}, user: { id: 42 } };
    const next = jest.fn();
    await resolveCustomerArea(req, {}, next);
    expect(req.areaId).toBe(1);
  });

  it('no pin and no user at all falls back to the default area directly', async () => {
    pool.query.mockResolvedValueOnce([[AREA_1, AREA_2_BBOXED]]);
    const req = { body: {}, query: {} };
    const next = jest.fn();
    await resolveCustomerArea(req, {}, next);
    expect(req.areaId).toBe(1);
    expect(pool.query).toHaveBeenCalledTimes(1); // no users query for an anonymous request
  });
});

describe('catalogETag (TASK 27.2, §3.10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetCachesForTests();
  });

  const fakeRes = () => ({
    _headers: {},
    statusCode: null,
    set(key, value) { this._headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    end() { this.ended = true; },
  });

  it('sets ETag "<areaId>-<catalogVersion>" and calls next when If-None-Match is absent', async () => {
    pool.query.mockResolvedValueOnce([[{ ...AREA_1, catalog_version: 7 }]]);
    const req = { areaId: 1, headers: {} };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(res._headers.ETag).toBe('"1-7"');
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('returns a bare 304 when If-None-Match matches the current catalog_version', async () => {
    pool.query.mockResolvedValueOnce([[{ ...AREA_1, catalog_version: 7 }]]);
    const req = { areaId: 1, headers: { 'if-none-match': '"1-7"' } };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(res.statusCode).toBe(304);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('sends the full response (next) when If-None-Match is stale (catalog_version bumped since)', async () => {
    pool.query.mockResolvedValueOnce([[{ ...AREA_1, catalog_version: 8 }]]);
    const req = { areaId: 1, headers: { 'if-none-match': '"1-7"' } };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(res._headers.ETag).toBe('"1-8"');
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('skips ETag entirely (no header, straight to next) when req.areaId is null — a pin outside every zone', async () => {
    const req = { areaId: null, headers: {} };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(res._headers.ETag).toBeUndefined();
    expect(next).toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('skips ETag for areaId "all" (defensive — not a real customer-route value)', async () => {
    const req = { areaId: 'all', headers: {} };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('never blocks the real response if the area lookup throws', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const req = { areaId: 1, headers: {} };
    const res = fakeRes();
    const next = jest.fn();

    await catalogETag(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });
});
