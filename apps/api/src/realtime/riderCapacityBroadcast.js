/**
 * Pushes "this area's riders are (no longer) at capacity" to customer apps.
 *
 * The checkout screen also polls GET /api/rider-capacity, but a poll alone
 * leaves a customer staring at a disabled Place Order button for up to a full
 * period after riders actually free up — and the thing that frees them (an
 * order being delivered) is already a realtime event everywhere else in the
 * app. The poll stays as the reconciler: it's the only thing that catches an
 * order simply ageing out of RIDER_CAPACITY_LOOKBACK_MIN, which fires no
 * event at all.
 *
 * Emits ONLY on a transition, so the common case (order events in an area
 * nowhere near capacity) costs one cheap query and no socket traffic.
 *
 * Like the HTTP endpoint, the payload carries the verdict and nothing else —
 * never online_riders / active_orders. `customers:<areaId>` is a room any
 * customer can end up in, so the counts would be just as public there as they
 * would be on the public route (see riderCapacityController.js).
 */

// areaId -> last broadcast atCapacity. Process-local and deliberately not
// persisted: on boot it's empty, so the first order event per area emits once
// and seeds every connected client with the current truth.
const lastBroadcast = new Map();

/**
 * Fire-and-forget. Never throws and never rejects — every caller is on a
 * realtime emit path where a capacity check failing must not break the event
 * that triggered it.
 */
const broadcastCapacityIfChanged = async (areaId) => {
  const key = Number(areaId);
  if (!Number.isFinite(key) || key <= 0) return;

  try {
    // Lazy requires: utils/riders is what this module reads capacity from,
    // and realtime/orderEvents (a caller) is already in socket.js's require
    // graph — resolving either at module load would close a cycle.
    const { getCapacityStatus } = require('../utils/riders');
    const { emitToAllCustomers } = require('./socket');
    const config = require('../config/env');

    const { atCapacity } = await getCapacityStatus(key);
    if (lastBroadcast.get(key) === atCapacity) return;
    lastBroadcast.set(key, atCapacity);

    emitToAllCustomers(key, 'settings.rider_capacity.updated', {
      // Which area this verdict is about. A customer's socket room follows
      // the area their delivery-location store last resolved, which is NOT
      // necessarily the area the pin they're checking out with sits in — so
      // the client checks this against the area its own capacity read
      // resolved and drops the event if they disagree, rather than trusting
      // room membership alone.
      areaId: key,
      area_id: key,
      atCapacity,
      at_capacity: atCapacity,
      cooldownMinutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
      cooldown_minutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
    });
  } catch (_) {
    // Best-effort: the 45s poll reconciles whatever this missed.
  }
};

/** Test seam — clears the per-area transition memory. */
const _resetCapacityBroadcastForTests = () => lastBroadcast.clear();

module.exports = { broadcastCapacityIfChanged, _resetCapacityBroadcastForTests };
