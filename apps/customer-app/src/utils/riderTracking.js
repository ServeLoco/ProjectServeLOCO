import * as Location from 'expo-location';

// Rider GPS sampling — shared by useRiderLocationTracking.js and
// RiderDeliveryMap.js so both watchers agree on the same thresholds.
//
// distanceInterval is 0 (no native distance filter) on purpose: the OS
// would otherwise swallow the callback entirely until the distance
// threshold is hit, which makes a heading-based "sharp turn" trigger
// impossible to evaluate in JS. Instead we sample on a plain time
// interval and decide whether to actually send the ping ourselves via
// shouldSendPing() — first fix always, then every ~150 m (or sharp turn).
export const RIDER_WATCH_OPTIONS = {
  accuracy: Location.Accuracy.High,
  timeInterval: 3000,
  distanceInterval: 0,
};

// Product rule: show current location on assign, then update about every 150 m.
export const PING_DISTANCE_METERS = 150;
export const HEADING_CHANGE_DEGREES = 45;
/** Soft heartbeat only (stuck GPS / no move) — not the main update cadence. */
export const PING_MAX_INTERVAL_MS = 60_000;

// Idle presence pings — used by useRiderIdleLocationPing while the rider is
// online with no active job. The server ranks offers by distance from the
// pickup shop, so a free rider who never reports a position can only ever be
// reached by the distance-blind fallback ring.
//
// Deliberately NOT a watchPositionAsync: a one-shot Balanced fix every 90 s
// lets the GPS chip sleep in between, unlike the High-accuracy 3 s watch that
// runs during an actual delivery. Must stay under the server's
// RIDER_LOCATION_MAX_AGE_SEC (600 s) with room for missed pings.
export const IDLE_PING_INTERVAL_MS = 90_000;
export const IDLE_PING_ACCURACY = Location.Accuracy.Balanced;
/** Give up on a fix well before the next tick so attempts can never pile up. */
export const IDLE_PING_TIMEOUT_MS = 30_000;

/** Haversine distance in meters. */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Shortest angular distance between two compass headings (0-360), wraparound-safe. */
function headingDelta(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * First GPS fix always (so customer sees rider immediately on assign).
 * After that: every ~150 m moved, sharp turn, or 60 s idle heartbeat.
 */
export function shouldSendPing(lastSent, next, nowMs = Date.now()) {
  if (!lastSent) return true;
  const lastAt = lastSent.at || lastSent.sentAt || 0;
  if (lastAt && nowMs - lastAt >= PING_MAX_INTERVAL_MS) return true;
  const moved = distanceMeters(lastSent.latitude, lastSent.longitude, next.latitude, next.longitude);
  if (moved >= PING_DISTANCE_METERS) return true;
  if (
    Number.isFinite(next.heading) &&
    Number.isFinite(lastSent.heading) &&
    headingDelta(lastSent.heading, next.heading) > HEADING_CHANGE_DEGREES
  ) {
    return true;
  }
  return false;
}
