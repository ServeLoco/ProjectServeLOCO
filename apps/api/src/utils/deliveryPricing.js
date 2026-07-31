/**
 * Polygon-zone delivery pricing.
 *
 * Each delivery_zones row owns its own irregular boundary (`boundary`, an
 * array of {lat,lng} vertices) — there is no shared center pin. A zone may
 * also carry a `parent_zone_id` pointing at another zone: this models a big
 * "village" zone with small "sub-village" zones nested inside it. When a
 * customer's point falls inside more than one matched zone, the most deeply
 * nested zone wins (a child always outranks its own parent, however many
 * levels deep), so the child effectively carves a differently-priced hole
 * out of the parent's coverage. Overlapping zones with no parent/child
 * relationship fall back to smallest-area-wins.
 *
 * Each zone also carries its own charges, ETAs, night surcharge amount and
 * COD policy.
 *
 * Zone mode requires ALL of: settings.radius_pricing_active truthy, valid
 * customer coordinates, and >= 1 active zone with a boundary. Anything
 * missing falls back to flat pricing (legacy behavior).
 *
 * Used by BOTH cart preview (cartController) and order creation
 * (orderController) so the two can never diverge.
 */
const { isInNightWindow } = require('./nightDelivery');

// Degrees-to-km conversion, used only for (a) the optional shop-distance
// display figure and (b) turning a polygon's vertex list into a km-scale
// area. Latitude is ~constant; longitude shrinks with cos(latitude). Fine at
// the few-km scale delivery zones operate at — not meant for long distances.
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_EQUATOR = 111.320;

/**
 * Calculates geodetic distance between two coordinates using the Haversine formula.
 * @param {number} lat1 Latitude of point 1
 * @param {number} lon1 Longitude of point 1
 * @param {number} lat2 Latitude of point 2
 * @param {number} lon2 Longitude of point 2
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Signed north/south and east/west offsets from center, in km. Still used by
 * the independent no-delivery exclusion squares (matchExclusionZone below),
 * which keep their own simple center+side shape.
 */
function calculateAxisOffsetsKm(centerLat, centerLng, pointLat, pointLng) {
  const dLatKm = (pointLat - centerLat) * KM_PER_DEG_LAT;
  const dLngKm = (pointLng - centerLng) * KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(centerLat * Math.PI / 180);
  return { dLatKm, dLngKm };
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isBlank(v) {
  return v === undefined || v === null || v === '';
}

/**
 * Parses a zone's `boundary` column into an array of {lat,lng} vertices.
 * mysql2 sometimes hands back JSON columns already parsed, sometimes as a
 * raw string — handle both. Returns [] for anything unusable so callers can
 * treat it as "matches nothing" rather than throwing.
 */
function parseBoundary(boundary) {
  let value = boundary;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/**
 * Ray-casting point-in-polygon test (even-odd rule). Works directly on raw
 * lat/lng degrees — containment via ray crossings is unaffected by the
 * lat/lng axes having different real-world scale, so no km projection is
 * needed here (only for area, below).
 */
function isPointInPolygon(lat, lng, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const yi = vertices[i].lat, xi = vertices[i].lng;
    const yj = vertices[j].lat, xj = vertices[j].lng;
    const intersects = (yi > lat) !== (yj > lat)
      && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Polygon area in km², via the shoelace formula on vertices projected to a
 * local flat km grid (anchored at the polygon's own first vertex — plenty
 * accurate at delivery-zone scale).
 */
function polygonAreaKm2(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) return 0;
  const refLat = vertices[0].lat;
  const pts = vertices.map((v) => ({
    x: v.lng * KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(refLat * Math.PI / 180),
    y: v.lat * KM_PER_DEG_LAT,
  }));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Radius of the circle with the same area — used purely as a single
 * human-readable "km" figure for a polygon zone (order snapshots, the admin
 * zone list's "~X km"). NOT a delivery radius: an L-shaped zone and a compact
 * one with the same area report the same number. Never present it to a
 * customer as "we deliver within X km".
 */
function areaEquivalentRadiusKm(areaKm2) {
  return Math.sqrt(areaKm2 / Math.PI);
}

/**
 * True when two line segments properly cross (shared endpoints and collinear
 * touching don't count — adjacent polygon edges always share a vertex).
 */
function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const cross = (ax, ay, bx, by) => ax * by - ay * bx;
  const d1 = cross(p4.lng - p3.lng, p4.lat - p3.lat, p1.lng - p3.lng, p1.lat - p3.lat);
  const d2 = cross(p4.lng - p3.lng, p4.lat - p3.lat, p2.lng - p3.lng, p2.lat - p3.lat);
  const d3 = cross(p2.lng - p1.lng, p2.lat - p1.lat, p3.lng - p1.lng, p3.lat - p1.lat);
  const d4 = cross(p2.lng - p1.lng, p2.lat - p1.lat, p4.lng - p1.lng, p4.lat - p1.lat);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * True when a polygon's own edges cross each other (a "bowtie"). Such a shape
 * breaks the even-odd containment test in isPointInPolygon, so the admin API
 * rejects it on write. O(n²) over at most MAX_VERTICES points — write path
 * only, never called during pricing.
 */
function polygonSelfIntersects(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 4) return false;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a1 = vertices[i];
    const a2 = vertices[(i + 1) % n];
    // Start at i + 2: edge i always shares a vertex with edge i + 1.
    for (let j = i + 2; j < n; j++) {
      // The last edge wraps back to vertex 0, so it is adjacent to edge 0.
      if (i === 0 && j === n - 1) continue;
      if (segmentsProperlyIntersect(a1, a2, vertices[j], vertices[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Picks the zone a customer's point falls into.
 *
 * A point may fall inside several zones at once (a parent village polygon
 * and a sub-village polygon nested inside it). Among the matches, any zone
 * that another match declares as ITS parent is superseded — this lets a
 * child zone win over its parent regardless of relative size, at any
 * nesting depth. If more than one candidate remains (siblings overlapping
 * with no parent/child relationship), the smallest-area one wins.
 *
 * @param {number} lat customer latitude
 * @param {number} lng customer longitude
 * @param {Array<object>} zones delivery_zones rows (active ones)
 * @returns {object|null} matched zone row, or null when outside every zone
 */
/**
 * Parses each zone's boundary JSON and computes its area ONCE, so a single
 * pricing call doesn't re-parse the same column four or five times across
 * matching, area ranking and the response payload. Zones without a usable
 * polygon are dropped — they can never match anything.
 * @returns {Array<{zone: object, vertices: Array<{lat:number,lng:number}>, areaKm2: number}>}
 */
function prepareZones(zones) {
  if (!Array.isArray(zones)) return [];
  const prepared = [];
  for (const zone of zones) {
    const vertices = parseBoundary(zone.boundary);
    if (vertices.length < 3) continue;
    prepared.push({ zone, vertices, areaKm2: polygonAreaKm2(vertices) });
  }
  return prepared;
}

/** matchZone's body, operating on already-parsed zones. */
function matchPreparedZone(lat, lng, prepared) {
  const matches = prepared.filter((p) => isPointInPolygon(lat, lng, p.vertices));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const notSuperseded = matches.filter(
    (p) => !matches.some((other) => other.zone.id !== p.zone.id && other.zone.parent_zone_id === p.zone.id)
  );
  const candidates = notSuperseded.length > 0 ? notSuperseded : matches;

  return candidates.reduce((smallest, p) => (p.areaKm2 < smallest.areaKm2 ? p : smallest));
}

function matchZone(lat, lng, zones) {
  if (!Array.isArray(zones) || zones.length === 0) return null;
  const match = matchPreparedZone(lat, lng, prepareZones(zones));
  return match ? match.zone : null;
}

/**
 * Shortest distance (km) from a point to a line segment, via projection onto
 * a local flat km plane anchored at the segment's own first vertex — same
 * projection trick as polygonAreaKm2, accurate enough at delivery-zone scale.
 */
function pointToSegmentDistanceKm(lat, lng, aLat, aLng, bLat, bLng) {
  const toXY = (plat, plng) => ({
    x: (plng - aLng) * KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(aLat * Math.PI / 180),
    y: (plat - aLat) * KM_PER_DEG_LAT,
  });
  const p = toXY(lat, lng);
  const b = toXY(bLat, bLng);
  const abLenSq = b.x * b.x + b.y * b.y;
  const t = abLenSq > 0 ? Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / abLenSq)) : 0;
  const dx = p.x - b.x * t;
  const dy = p.y - b.y * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Shortest distance (km) from a point to a polygon's edges. */
function distanceToPolygonKm(lat, lng, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const d = pointToSegmentDistanceKm(lat, lng, a.lat, a.lng, b.lat, b.lng);
    if (d < min) min = d;
  }
  return min;
}

/**
 * When a point falls outside every zone, finds the closest one (by edge
 * distance) so the customer can be pointed at it — "move inside X to order".
 * @returns {{zone: object, distanceKm: number}|null}
 */
function findNearestPreparedZone(lat, lng, prepared) {
  let nearest = null;
  let minDist = Infinity;
  for (const p of prepared) {
    const d = distanceToPolygonKm(lat, lng, p.vertices);
    if (d < minDist) {
      minDist = d;
      nearest = p.zone;
    }
  }
  return nearest ? { zone: nearest, distanceKm: roundTo(minDist, 2) } : null;
}

function findNearestZone(lat, lng, zones) {
  return findNearestPreparedZone(lat, lng, prepareZones(zones));
}

/**
 * Loads active zones. Accepts the pool or a transaction connection — both
 * expose .query().
 */
async function loadActiveZones(db) {
  const [rows] = await db.query(
    'SELECT * FROM delivery_zones WHERE active = 1'
  );
  return rows;
}

/**
 * Loads active no-delivery exclusion squares. Accepts the pool or a
 * transaction connection — both expose .query().
 *
 * Deliberately NOT micro-cached: order creation calls this on a transaction
 * connection, and serving a process-wide cached value inside a transaction
 * would make the read non-repeatable with respect to the rest of the
 * transaction. The table is small and indexed; the query is cheap.
 */
async function loadActiveExclusionZones(db) {
  const [rows] = await db.query(
    'SELECT * FROM delivery_exclusion_zones WHERE active = 1'
  );
  return rows;
}

/**
 * Finds the exclusion square (if any) containing a point. Each exclusion
 * zone has its OWN center pin (unrelated to pricing-zone polygons). Smallest
 * side first, same "most specific wins" spirit as matchZone.
 */
function matchExclusionZone(exclusionZones, pointLat, pointLng) {
  if (!Array.isArray(exclusionZones) || exclusionZones.length === 0) return null;
  const sorted = [...exclusionZones].sort((a, b) => Number(a.side_km) - Number(b.side_km));
  for (const ex of sorted) {
    const { dLatKm, dLngKm } = calculateAxisOffsetsKm(
      Number(ex.center_lat), Number(ex.center_lng), pointLat, pointLng
    );
    const half = Number(ex.side_km) / 2;
    if (Math.abs(dLatKm) <= half && Math.abs(dLngKm) <= half) return ex;
  }
  return null;
}

/**
 * Resolves delivery pricing for a cart/order.
 *
 * @param {object} params
 * @param {number|string|null} params.customerLat
 * @param {number|string|null} params.customerLng
 * @param {string} params.deliveryType 'standard' | 'fast'
 * @param {object} params.settings settings row (needs radius_pricing_active,
 *   delivery_charge, fast_delivery_enabled, fast_delivery_charge,
 *   standard_delivery_minutes, fast_delivery_minutes, night_charge,
 *   night_charge_start, night_charge_end; shop_latitude/shop_longitude are
 *   optional and, if set, only used for the cosmetic "distance from shop"
 *   figure below — zone matching no longer depends on them)
 * @param {Array<object>} params.zones active delivery_zones rows
 * @param {Array<object>} [params.exclusionZones] active delivery_exclusion_zones
 *   rows — no-delivery squares checked BEFORE zone matching, independent of
 *   radius_pricing_active (a govt-building exclusion blocks delivery whether
 *   the shop is on zone or flat pricing).
 * @param {Date} [params.now]
 * @returns {object} see fields below; in zone mode with outOfRange=true all
 *   charges are 0 and zone/eta fields are null. excluded=true (customer
 *   inside a no-delivery square) similarly zeroes charges and sets
 *   exclusionMessage instead.
 */
function resolveDeliveryPricing({ customerLat, customerLng, deliveryType, settings, zones, exclusionZones = [], now = new Date() }) {
  const isFastRequested = deliveryType === 'fast';
  const fastDeliveryEnabled = Boolean(settings.fast_delivery_enabled);
  const isFast = isFastRequested && fastDeliveryEnabled;

  const nightWindowOpen = isInNightWindow(settings.night_charge_start, settings.night_charge_end, now);

  const radiusPricingActive = settings.radius_pricing_active === true
    || settings.radius_pricing_active === 1
    || settings.radius_pricing_active === '1'
    || settings.radius_pricing_active === 'true';

  const parsedLat = Number(customerLat);
  const parsedLng = Number(customerLng);
  const hasValidCustomerCoords = !isBlank(customerLat) && !isBlank(customerLng)
    && Number.isFinite(parsedLat) && Number.isFinite(parsedLng);

  if (hasValidCustomerCoords && Array.isArray(exclusionZones) && exclusionZones.length > 0) {
    const excludedZone = matchExclusionZone(exclusionZones, parsedLat, parsedLng);
    if (excludedZone) {
      return {
        mode: radiusPricingActive ? 'zone' : 'flat',
        outOfRange: false,
        excluded: true,
        exclusionMessage: excludedZone.message || 'Delivery is not available at this location.',
        distanceKm: null,
        zone: null,
        zoneExtentKm: null,
        maxRadiusKm: null,
        deliveryCharge: 0,
        standardDeliveryCharge: 0,
        fastDeliveryCharge: 0,
        standardDeliveryMinutes: null,
        fastDeliveryMinutes: null,
        etaMinutes: null,
        nightCharge: 0,
        codAllowed: false,
      };
    }
  }

  // Cosmetic-only "distance from shop" figure for display (e.g. checkout's
  // "Delivery distance: X km"). Purely informational — zone matching never
  // uses this, since each zone is now a self-contained polygon.
  const shopLat = Number(settings.shop_latitude);
  const shopLng = Number(settings.shop_longitude);
  const hasShopPin = !isBlank(settings.shop_latitude) && !isBlank(settings.shop_longitude)
    && Number.isFinite(shopLat) && Number.isFinite(shopLng);
  const distanceKm = (hasShopPin && hasValidCustomerCoords)
    ? roundTo(calculateDistance(parsedLat, parsedLng, shopLat, shopLng), 4)
    : null;

  const flatResult = () => {
    let standardDeliveryCharge = roundTo(Number(settings.delivery_charge) || 0, 2);
    const fastDeliveryCharge = roundTo(Number(settings.fast_delivery_charge) || 0, 2);
    const standardDeliveryMinutes = Number.isInteger(Number(settings.standard_delivery_minutes))
      ? Number(settings.standard_delivery_minutes)
      : 60;
    const fastDeliveryMinutes = Number.isInteger(Number(settings.fast_delivery_minutes))
      ? Number(settings.fast_delivery_minutes)
      : 30;
    const globalNight = Number(settings.night_charge);
    const nightCharge = nightWindowOpen && Number.isFinite(globalNight) && globalNight > 0
      ? roundTo(globalNight, 2)
      : 0;
    return {
      mode: 'flat',
      outOfRange: false,
      excluded: false,
      exclusionMessage: null,
      distanceKm,
      zone: null,
      zoneExtentKm: null,
      maxRadiusKm: null,
      deliveryCharge: isFast ? fastDeliveryCharge : standardDeliveryCharge,
      standardDeliveryCharge,
      fastDeliveryCharge,
      standardDeliveryMinutes,
      fastDeliveryMinutes,
      etaMinutes: isFast ? fastDeliveryMinutes : standardDeliveryMinutes,
      nightCharge,
      codAllowed: true,
    };
  };

  // Zone pricing OFF is a legitimate operating mode — flat charges for
  // everyone, no geography involved. Only this case may fall back.
  if (!radiusPricingActive) {
    return flatResult();
  }

  // Parsed once here and threaded through matching, ranking and the extent
  // figure below — the boundary JSON used to be re-parsed several times per
  // request per zone.
  const preparedZones = hasValidCustomerCoords ? prepareZones(zones) : [];

  // Zone pricing ON means the business operates BY zone, so any state where
  // the zone cannot be determined — no customer coords, no active zones, no
  // usable boundary on any zone — must fail closed. Falling back to flat
  // pricing here served every location on earth and made the customer app's
  // location gate decorative; it also let an order posted with no
  // coordinates through with a NULL zone (createOrder rejects outOfRange,
  // so blocking here blocks that too).
  if (!hasValidCustomerCoords || preparedZones.length === 0) {
    return {
      mode: 'zone',
      outOfRange: true,
      excluded: false,
      exclusionMessage: null,
      distanceKm,
      zone: null,
      nearestZoneName: null,
      nearestZoneDistanceKm: null,
      zoneExtentKm: null,
      maxRadiusKm: null,
      deliveryCharge: 0,
      standardDeliveryCharge: 0,
      fastDeliveryCharge: 0,
      standardDeliveryMinutes: null,
      fastDeliveryMinutes: null,
      etaMinutes: null,
      nightCharge: 0,
      codAllowed: false,
    };
  }

  // NOT a delivery radius — see areaEquivalentRadiusKm. Retained only because
  // max_delivery_radius_km is part of the published response shape.
  const maxRadiusKm = preparedZones.reduce(
    (max, p) => Math.max(max, areaEquivalentRadiusKm(p.areaKm2)),
    0
  );
  const matched = matchPreparedZone(parsedLat, parsedLng, preparedZones);
  const zone = matched ? matched.zone : null;

  if (!zone) {
    const nearest = findNearestPreparedZone(parsedLat, parsedLng, preparedZones);
    return {
      mode: 'zone',
      outOfRange: true,
      excluded: false,
      exclusionMessage: null,
      distanceKm,
      zone: null,
      nearestZoneName: nearest ? (nearest.zone.name || null) : null,
      nearestZoneDistanceKm: nearest ? nearest.distanceKm : null,
      zoneExtentKm: null,
      maxRadiusKm,
      deliveryCharge: 0,
      standardDeliveryCharge: 0,
      fastDeliveryCharge: 0,
      standardDeliveryMinutes: null,
      fastDeliveryMinutes: null,
      etaMinutes: null,
      nightCharge: 0,
      codAllowed: false,
    };
  }

  const standardDeliveryCharge = roundTo(Number(zone.normal_charge) || 0, 2);
  const fastDeliveryCharge = roundTo(Number(zone.fast_charge) || 0, 2);
  const standardDeliveryMinutes = Number.isInteger(Number(zone.normal_eta_minutes))
    ? Number(zone.normal_eta_minutes)
    : 60;
  const fastDeliveryMinutes = Number.isInteger(Number(zone.fast_eta_minutes))
    ? Number(zone.fast_eta_minutes)
    : 30;
  // Per-zone night amount uses the GLOBAL window (night_charge_start/end) but
  // the zone's own amount — deliberately not calculateNightCharge, which would
  // suppress a zone amount whenever the global settings.night_charge is 0.
  const zoneNight = Number(zone.night_charge);
  const nightCharge = nightWindowOpen && Number.isFinite(zoneNight) && zoneNight > 0
    ? roundTo(zoneNight, 2)
    : 0;

  return {
    mode: 'zone',
    outOfRange: false,
    excluded: false,
    exclusionMessage: null,
    distanceKm,
    zone,
    zoneExtentKm: roundTo(areaEquivalentRadiusKm(matched.areaKm2), 2),
    maxRadiusKm,
    deliveryCharge: isFast ? fastDeliveryCharge : standardDeliveryCharge,
    standardDeliveryCharge,
    fastDeliveryCharge,
    standardDeliveryMinutes,
    fastDeliveryMinutes,
    etaMinutes: isFast ? fastDeliveryMinutes : standardDeliveryMinutes,
    nightCharge,
    codAllowed: Boolean(Number(zone.cod_enabled)),
  };
}

module.exports = {
  calculateDistance,
  calculateAxisOffsetsKm,
  parseBoundary,
  isPointInPolygon,
  polygonAreaKm2,
  areaEquivalentRadiusKm,
  polygonSelfIntersects,
  matchZone,
  findNearestZone,
  matchExclusionZone,
  loadActiveZones,
  loadActiveExclusionZones,
  resolveDeliveryPricing,
};
