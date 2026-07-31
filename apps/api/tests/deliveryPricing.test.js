const {
  calculateDistance,
  isPointInPolygon,
  polygonAreaKm2,
  areaEquivalentRadiusKm,
  matchZone,
  polygonSelfIntersects,
  resolveDeliveryPricing,
} = require('../src/utils/deliveryPricing');

// Center: Fatehabad, Haryana. 1 deg longitude at this latitude ≈ 96.9 km, so
// offsets below give predictable distances well inside/outside zones.
const CENTER = { lat: 29.5152, lng: 75.4548 };
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_EQUATOR = 111.320;

function offsetPoint(lat, lng, dLatKm, dLngKm) {
  return {
    lat: lat + dLatKm / KM_PER_DEG_LAT,
    lng: lng + dLngKm / (KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(lat * Math.PI / 180)),
  };
}

// A point approximately `km` kilometers east of the center.
const pointAtKm = (km) => offsetPoint(CENTER.lat, CENTER.lng, 0, km);

// A square polygon (4 corners) of the given side length, centered on (lat,lng).
function squareBoundary(lat, lng, sideKm) {
  const half = sideKm / 2;
  return [
    offsetPoint(lat, lng, -half, -half),
    offsetPoint(lat, lng, -half, half),
    offsetPoint(lat, lng, half, half),
    offsetPoint(lat, lng, half, -half),
  ];
}

// Two concentric, unrelated (no parent/child) square zones — same spirit as
// the old concentric circle bands, used to exercise the smallest-area
// tie-break for overlapping siblings.
const zone5 = {
  id: 1, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 10),
  normal_charge: '10.00', fast_charge: '25.00',
  normal_eta_minutes: 45, fast_eta_minutes: 20, night_charge: '5.00',
  cod_enabled: 1, active: 1,
};
const zone10 = {
  id: 2, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 20),
  normal_charge: '30.00', fast_charge: '50.00',
  normal_eta_minutes: 90, fast_eta_minutes: 40, night_charge: '15.00',
  cod_enabled: 0, active: 1,
};

const baseSettings = {
  radius_pricing_active: 1,
  shop_latitude: String(CENTER.lat),
  shop_longitude: String(CENTER.lng),
  delivery_charge: '20.00',
  fast_delivery_enabled: 1,
  fast_delivery_charge: '40.00',
  standard_delivery_minutes: 60,
  fast_delivery_minutes: 30,
  night_charge: '8.00',
  night_charge_start: '21:00:00',
  night_charge_end: '07:00:00',
};

// Fixed instants relative to the Asia/Kolkata night window 21:00–07:00.
const DAYTIME = new Date('2026-07-19T07:30:00.000Z');  // 13:00 IST
const NIGHTTIME = new Date('2026-07-19T17:30:00.000Z'); // 23:00 IST

describe('calculateDistance', () => {
  it('is zero for identical coordinates', () => {
    expect(calculateDistance(12.9716, 77.5946, 12.9716, 77.5946)).toBe(0);
  });

  it('approximates the constructed east-offset distance', () => {
    const p = pointAtKm(5);
    const d = calculateDistance(p.lat, p.lng, CENTER.lat, CENTER.lng);
    expect(d).toBeGreaterThan(4.9);
    expect(d).toBeLessThan(5.1);
  });
});

describe('isPointInPolygon', () => {
  const square = squareBoundary(CENTER.lat, CENTER.lng, 10); // half-extent 5km

  it('is true for a point well inside', () => {
    const p = pointAtKm(2);
    expect(isPointInPolygon(p.lat, p.lng, square)).toBe(true);
  });

  it('is false for a point well outside', () => {
    const p = pointAtKm(8);
    expect(isPointInPolygon(p.lat, p.lng, square)).toBe(false);
  });

  it('is false for degenerate (<3 vertex) shapes', () => {
    expect(isPointInPolygon(CENTER.lat, CENTER.lng, [])).toBe(false);
    expect(isPointInPolygon(CENTER.lat, CENTER.lng, square.slice(0, 2))).toBe(false);
  });
});

describe('polygonAreaKm2 / areaEquivalentRadiusKm', () => {
  it('computes the area of a simple right triangle via the shoelace formula', () => {
    const p0 = { lat: CENTER.lat, lng: CENTER.lng };
    const p1 = offsetPoint(CENTER.lat, CENTER.lng, 6, 0);
    const p2 = offsetPoint(CENTER.lat, CENTER.lng, 0, 8);
    const area = polygonAreaKm2([p0, p1, p2]);
    expect(area).toBeCloseTo(24, 0); // 0.5 * base(6km) * height(8km)
  });

  it('equivalent radius grows with polygon area', () => {
    const smallArea = polygonAreaKm2(squareBoundary(CENTER.lat, CENTER.lng, 10));
    const bigArea = polygonAreaKm2(squareBoundary(CENTER.lat, CENTER.lng, 20));
    expect(bigArea).toBeGreaterThan(smallArea);
    expect(areaEquivalentRadiusKm(bigArea)).toBeGreaterThan(areaEquivalentRadiusKm(smallArea));
  });
});

// A bowtie breaks the even-odd ray-casting containment test — the crossed
// lobe reads as outside the zone — so the admin API rejects these on write.
describe('polygonSelfIntersects', () => {
  it('accepts a simple convex square', () => {
    expect(polygonSelfIntersects(squareBoundary(CENTER.lat, CENTER.lng, 10))).toBe(false);
  });

  it('accepts a concave (L-shaped) polygon', () => {
    const l = [
      offsetPoint(CENTER.lat, CENTER.lng, 0, 0),
      offsetPoint(CENTER.lat, CENTER.lng, 0, 6),
      offsetPoint(CENTER.lat, CENTER.lng, 3, 6),
      offsetPoint(CENTER.lat, CENTER.lng, 3, 3),
      offsetPoint(CENTER.lat, CENTER.lng, 6, 3),
      offsetPoint(CENTER.lat, CENTER.lng, 6, 0),
    ];
    expect(polygonSelfIntersects(l)).toBe(false);
  });

  it('flags a bowtie', () => {
    const bowtie = [
      offsetPoint(CENTER.lat, CENTER.lng, 0, 0),
      offsetPoint(CENTER.lat, CENTER.lng, 4, 4),
      offsetPoint(CENTER.lat, CENTER.lng, 0, 4),
      offsetPoint(CENTER.lat, CENTER.lng, 4, 0),
    ];
    expect(polygonSelfIntersects(bowtie)).toBe(true);
  });

  it('does not flag a triangle (adjacent edges always share a vertex)', () => {
    const triangle = [
      offsetPoint(CENTER.lat, CENTER.lng, 0, 0),
      offsetPoint(CENTER.lat, CENTER.lng, 5, 0),
      offsetPoint(CENTER.lat, CENTER.lng, 0, 5),
    ];
    expect(polygonSelfIntersects(triangle)).toBe(false);
  });
});

describe('matchZone — overlapping zones with no parent/child link', () => {
  it('matches the smallest-area zone containing the point', () => {
    const p3 = pointAtKm(3);
    expect(matchZone(p3.lat, p3.lng, [zone5, zone10])).toBe(zone5);
    const p7 = pointAtKm(7);
    expect(matchZone(p7.lat, p7.lng, [zone5, zone10])).toBe(zone10);
  });

  it('returns null outside every zone', () => {
    const p = pointAtKm(15);
    expect(matchZone(p.lat, p.lng, [zone5, zone10])).toBeNull();
  });

  it('is order-independent', () => {
    const p = pointAtKm(3);
    expect(matchZone(p.lat, p.lng, [zone10, zone5])).toBe(zone5);
  });

  it('handles empty/missing zone lists', () => {
    expect(matchZone(CENTER.lat, CENTER.lng, [])).toBeNull();
    expect(matchZone(CENTER.lat, CENTER.lng, undefined)).toBeNull();
  });
});

describe('matchZone — parent/child nesting (village + sub-village)', () => {
  const parentVillage = {
    id: 10, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 20),
    normal_charge: '20.00', fast_charge: '35.00', normal_eta_minutes: 60, fast_eta_minutes: 30,
    night_charge: '5.00', cod_enabled: 1, active: 1,
  };
  const childCenter = offsetPoint(CENTER.lat, CENTER.lng, 0, 6);
  const childSubVillage = {
    id: 11, parent_zone_id: 10, boundary: squareBoundary(childCenter.lat, childCenter.lng, 4),
    normal_charge: '35.00', fast_charge: '55.00', normal_eta_minutes: 40, fast_eta_minutes: 20,
    night_charge: '10.00', cod_enabled: 0, active: 1,
  };

  it('matches the parent when the point is outside every child', () => {
    const p = pointAtKm(-8);
    expect(matchZone(p.lat, p.lng, [parentVillage, childSubVillage])).toBe(parentVillage);
  });

  it('matches the child even though the point is also inside the parent', () => {
    const p = childCenter;
    expect(matchZone(p.lat, p.lng, [parentVillage, childSubVillage])).toBe(childSubVillage);
  });

  it('a grandchild wins over its parent which wins over the grandparent', () => {
    const grandparent = {
      id: 20, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 40),
      normal_charge: '10.00', fast_charge: '20.00', normal_eta_minutes: 90, fast_eta_minutes: 45,
      night_charge: '5.00', cod_enabled: 1, active: 1,
    };
    const parent = {
      id: 21, parent_zone_id: 20, boundary: squareBoundary(CENTER.lat, CENTER.lng, 20),
      normal_charge: '20.00', fast_charge: '35.00', normal_eta_minutes: 60, fast_eta_minutes: 30,
      night_charge: '5.00', cod_enabled: 1, active: 1,
    };
    const child = {
      id: 22, parent_zone_id: 21, boundary: squareBoundary(CENTER.lat, CENTER.lng, 10),
      normal_charge: '30.00', fast_charge: '50.00', normal_eta_minutes: 40, fast_eta_minutes: 20,
      night_charge: '5.00', cod_enabled: 1, active: 1,
    };
    const p = pointAtKm(2);
    expect(matchZone(p.lat, p.lng, [grandparent, parent, child])).toBe(child);
  });

  it('overlapping siblings with no parent/child link still fall back to smallest area', () => {
    const bigSibling = {
      id: 30, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 20),
      normal_charge: '20.00', fast_charge: '35.00', normal_eta_minutes: 60, fast_eta_minutes: 30,
      night_charge: '5.00', cod_enabled: 1, active: 1,
    };
    const smallSibling = {
      id: 31, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 8),
      normal_charge: '25.00', fast_charge: '45.00', normal_eta_minutes: 40, fast_eta_minutes: 20,
      night_charge: '5.00', cod_enabled: 1, active: 1,
    };
    const p = pointAtKm(2);
    expect(matchZone(p.lat, p.lng, [bigSibling, smallSibling])).toBe(smallSibling);
  });
});

describe('resolveDeliveryPricing — zone mode', () => {
  const zones = [zone5, zone10];

  it('prices a standard order from the matched zone', () => {
    const p = pointAtKm(3);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.mode).toBe('zone');
    expect(result.outOfRange).toBe(false);
    expect(result.zone.id).toBe(1);
    expect(result.deliveryCharge).toBe(10);
    expect(result.standardDeliveryCharge).toBe(10);
    expect(result.fastDeliveryCharge).toBe(25);
    expect(result.standardDeliveryMinutes).toBe(45);
    expect(result.fastDeliveryMinutes).toBe(20);
    expect(result.etaMinutes).toBe(45);
    expect(result.nightCharge).toBe(0);
    expect(result.codAllowed).toBe(true);
    expect(result.distanceKm).toBeGreaterThan(2.9);
    expect(result.distanceKm).toBeLessThan(3.1);
    expect(result.maxRadiusKm).toBeGreaterThan(0);
  });

  it('fast delivery uses the zone fast charge and ETA', () => {
    const p = pointAtKm(7);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'fast',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.zone.id).toBe(2);
    expect(result.deliveryCharge).toBe(50);
    expect(result.etaMinutes).toBe(40);
    expect(result.codAllowed).toBe(false);
  });

  it('fast request falls back to standard when fast delivery is disabled', () => {
    const p = pointAtKm(3);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'fast',
      settings: { ...baseSettings, fast_delivery_enabled: 0 }, zones, now: DAYTIME,
    });
    expect(result.deliveryCharge).toBe(10);
    expect(result.etaMinutes).toBe(45);
  });

  it('blocks out-of-range with zeroed charges', () => {
    const p = pointAtKm(15);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones, now: NIGHTTIME,
    });
    expect(result.mode).toBe('zone');
    expect(result.outOfRange).toBe(true);
    expect(result.zone).toBeNull();
    expect(result.deliveryCharge).toBe(0);
    expect(result.nightCharge).toBe(0);
    expect(result.codAllowed).toBe(false);
    expect(result.distanceKm).toBeGreaterThan(14);
  });

  it('applies the ZONE night amount inside the window even when global night_charge is 0', () => {
    const p = pointAtKm(7);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: { ...baseSettings, night_charge: '0.00' }, zones, now: NIGHTTIME,
    });
    expect(result.nightCharge).toBe(15);
  });

  it('applies no night charge outside the window', () => {
    const p = pointAtKm(7);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.nightCharge).toBe(0);
  });

  it('accepts DECIMAL-as-string inputs everywhere', () => {
    const p = pointAtKm(4);
    const result = resolveDeliveryPricing({
      customerLat: String(p.lat), customerLng: String(p.lng), deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.zone.id).toBe(1);
    expect(result.deliveryCharge).toBe(10);
  });

  it('still resolves a zone when the shop pin is unset — the cosmetic distance figure just goes null', () => {
    const p = pointAtKm(3);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: { ...baseSettings, shop_latitude: null, shop_longitude: null },
      zones, now: DAYTIME,
    });
    expect(result.mode).toBe('zone');
    expect(result.zone.id).toBe(1);
    expect(result.deliveryCharge).toBe(10);
    expect(result.distanceKm).toBeNull();
  });
});

describe('resolveDeliveryPricing — parent/child zone nesting', () => {
  const parentVillage = {
    id: 10, parent_zone_id: null, boundary: squareBoundary(CENTER.lat, CENTER.lng, 20),
    normal_charge: '20.00', fast_charge: '35.00', normal_eta_minutes: 60, fast_eta_minutes: 30,
    night_charge: '5.00', cod_enabled: 1, active: 1,
  };
  const childCenter = offsetPoint(CENTER.lat, CENTER.lng, 0, 6);
  const childSubVillage = {
    id: 11, parent_zone_id: 10, boundary: squareBoundary(childCenter.lat, childCenter.lng, 4),
    normal_charge: '35.00', fast_charge: '55.00', normal_eta_minutes: 40, fast_eta_minutes: 20,
    night_charge: '10.00', cod_enabled: 0, active: 1,
  };
  const zones = [parentVillage, childSubVillage];

  it('prices from the parent village when the point is outside every child', () => {
    const p = pointAtKm(-8);
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.zone.id).toBe(10);
    expect(result.deliveryCharge).toBe(20);
    expect(result.codAllowed).toBe(true);
  });

  it('prices from the nested sub-village zone even though it sits inside the parent', () => {
    const p = childCenter;
    const result = resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    });
    expect(result.zone.id).toBe(11);
    expect(result.deliveryCharge).toBe(35);
    expect(result.codAllowed).toBe(false);
  });
});

describe('resolveDeliveryPricing — flat fallback (zone pricing OFF)', () => {
  const zones = [zone5, zone10];
  // Zone pricing OFF is a legitimate operating mode: flat charges for
  // everyone, geography ignored. It is the ONLY route to flatResult().
  const flatSettings = { ...baseSettings, radius_pricing_active: 0 };

  const expectFlat = (result) => {
    expect(result.mode).toBe('flat');
    expect(result.outOfRange).toBe(false);
    expect(result.standardDeliveryCharge).toBe(20);
    expect(result.fastDeliveryCharge).toBe(40);
    expect(result.codAllowed).toBe(true);
    expect(result.zone).toBeNull();
  };

  it('falls back when the flag is off', () => {
    const p = pointAtKm(3);
    expectFlat(resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: flatSettings, zones, now: DAYTIME,
    }));
  });

  it('falls back when the flag is undefined (old mocked settings rows)', () => {
    const p = pointAtKm(3);
    const noFlag = { ...baseSettings };
    delete noFlag.radius_pricing_active;
    expectFlat(resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: noFlag, zones, now: DAYTIME,
    }));
  });

  it('serves a customer with no coordinates at all while the flag is off', () => {
    expectFlat(resolveDeliveryPricing({
      customerLat: null, customerLng: null, deliveryType: 'standard',
      settings: flatSettings, zones, now: DAYTIME,
    }));
  });

  it('fast flat order uses fast_delivery_charge and ETA', () => {
    const result = resolveDeliveryPricing({
      customerLat: null, customerLng: null, deliveryType: 'fast',
      settings: flatSettings, zones: [], now: DAYTIME,
    });
    expect(result.deliveryCharge).toBe(40);
    expect(result.etaMinutes).toBe(30);
  });

  it('applies the GLOBAL night amount in flat mode inside the window', () => {
    const result = resolveDeliveryPricing({
      customerLat: null, customerLng: null, deliveryType: 'standard',
      settings: flatSettings, zones: [], now: NIGHTTIME,
    });
    expect(result.nightCharge).toBe(8);
  });
});

// Zone pricing ON means the business operates BY zone. Any state where the
// zone cannot be determined has to block delivery — falling back to flat
// pricing here used to serve every location on earth at the flat charge,
// which made the customer app's location gate decorative and let an order
// posted with no coordinates through with a NULL zone.
describe('resolveDeliveryPricing — fails closed when zone pricing is ON', () => {
  const zones = [zone5, zone10];

  const expectBlocked = (result) => {
    expect(result.mode).toBe('zone');
    expect(result.outOfRange).toBe(true);
    expect(result.excluded).toBe(false);
    expect(result.zone).toBeNull();
    expect(result.deliveryCharge).toBe(0);
    expect(result.standardDeliveryCharge).toBe(0);
    expect(result.fastDeliveryCharge).toBe(0);
    expect(result.etaMinutes).toBeNull();
    expect(result.codAllowed).toBe(false);
  };

  it('blocks when coordinates are missing', () => {
    expectBlocked(resolveDeliveryPricing({
      customerLat: null, customerLng: null, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    }));
  });

  it('blocks when only one of the two coordinates is present', () => {
    expectBlocked(resolveDeliveryPricing({
      customerLat: pointAtKm(3).lat, customerLng: null, deliveryType: 'standard',
      settings: baseSettings, zones, now: DAYTIME,
    }));
  });

  it('blocks when no active zones exist', () => {
    const p = pointAtKm(3);
    expectBlocked(resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones: [], now: DAYTIME,
    }));
  });

  it('blocks when zones have no usable boundary', () => {
    const p = pointAtKm(3);
    expectBlocked(resolveDeliveryPricing({
      customerLat: p.lat, customerLng: p.lng, deliveryType: 'standard',
      settings: baseSettings, zones: [{ ...zone5, boundary: null }], now: DAYTIME,
    }));
  });

  it('charges nothing at night when it blocks — no night fee on a refused delivery', () => {
    const result = resolveDeliveryPricing({
      customerLat: null, customerLng: null, deliveryType: 'standard',
      settings: baseSettings, zones, now: NIGHTTIME,
    });
    expect(result.outOfRange).toBe(true);
    expect(result.nightCharge).toBe(0);
  });
});
