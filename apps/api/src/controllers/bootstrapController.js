// GET /api/bootstrap?lat=&lng= — TASK 27.3, §3.10/§9.4 item 4. One response
// carrying everything the customer app's cold start (or a pin change) needs
// instead of the separate settings + dashboard + store-modes + zones round
// trips it used to make. Purely additive (27.6) — every existing endpoint
// this reuses is untouched.
const { requestAreaId, getAreaById } = require('../utils/areaScope');
const { getSettingsForArea } = require('./settingsController');
const { getActiveStoreModesForArea } = require('./storeModeController');
const { getActiveZonesForArea } = require('./deliveryZonesController');

const shapeAreaForCustomer = (area) => ({
  id: area.id,
  code: area.code,
  name: area.name,
  timezone: area.timezone,
  brandColor: area.brand_color,
  brand_color: area.brand_color,
  logoImageId: area.logo_image_id,
  logo_image_id: area.logo_image_id,
});

const getBootstrap = async (req, res) => {
  // resolveCustomerArea (mounted on this route) already implements the full
  // §2.4 chain: pin -> zone -> area; else users.last_area_id; else the
  // default area, but ONLY when no pin was supplied at all. A pin that
  // resolves to no zone yields areaId === null here — the same "we don't
  // deliver here yet" signal every other public catalog endpoint already
  // uses, never a silent fall back to the default area (27.4).
  const areaId = requestAreaId(req);

  if (areaId === null) {
    return res.status(200).json({
      deliverable: false,
      area: null,
      zone: null,
      settings: null,
      storeModes: [],
      zoneGeometry: [],
      catalogVersion: null,
    });
  }

  const [area, zoneGeometry, settings, storeModes] = await Promise.all([
    getAreaById(areaId),
    getActiveZonesForArea(areaId),
    getSettingsForArea(areaId),
    getActiveStoreModesForArea(areaId),
  ]);

  if (!area) {
    // Area was deactivated/removed between resolution and this read — same
    // "can't deliver here" shape, not a 500 for a timing edge case.
    return res.status(200).json({
      deliverable: false,
      area: null,
      zone: null,
      settings: null,
      storeModes: [],
      zoneGeometry: [],
      catalogVersion: null,
    });
  }

  // The specific zone the pin matched, if any (a genuine pin match, not the
  // last_area_id/default-area fallback paths — those never set req.zoneId).
  let zone = null;
  if (req.zoneId != null) {
    const matched = zoneGeometry.find((z) => z.id === req.zoneId);
    zone = matched || null;
  }

  res.status(200).json({
    deliverable: true,
    area: shapeAreaForCustomer(area),
    zone,
    // 27.5 — the resolved area's own UPI/support contact, never a global
    // default. Getting this wrong routes real money to the wrong account.
    settings,
    storeModes,
    zoneGeometry,
    catalogVersion: area.catalog_version,
  });
};

module.exports = { getBootstrap };
