// GET /api/rider-capacity?latitude=&longitude= — polled by the customer app
// (every 45s, see CheckoutScreen) to show/hide the "riders are busy" banner
// ahead of checkout, without waiting for an actual order submission to hit
// the createOrder capacity gate (orderController.js).
//
// Deliberately returns ONLY the verdict, never the counts behind it. This
// route is public and takes an arbitrary pin, so echoing online_riders /
// active_orders would let anyone poll live rider headcount and order volume
// for any area — competitor-grade operational intel, and nothing the client
// needs to render the banner.
const { requestAreaId, getAreaById } = require('../utils/areaScope');
const { getCapacityStatus } = require('../utils/riders');
const config = require('../config/env');

const noCoverageResponse = () => ({
  areaId: null,
  area_id: null,
  atCapacity: false,
  at_capacity: false,
  cooldownMinutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
  cooldown_minutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
});

const getRiderCapacityStatus = async (req, res) => {
  const areaId = requestAreaId(req);

  if (areaId === null) {
    return res.status(200).json(noCoverageResponse());
  }

  const area = await getAreaById(areaId);
  if (!area) {
    // Area deactivated/removed between resolution and this read — same
    // "nothing to report" shape, not a 500 for a timing edge case.
    return res.status(200).json(noCoverageResponse());
  }

  const { atCapacity } = await getCapacityStatus(areaId);

  res.status(200).json({
    areaId,
    area_id: areaId,
    atCapacity,
    at_capacity: atCapacity,
    cooldownMinutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
    cooldown_minutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
  });
};

module.exports = { getRiderCapacityStatus };
