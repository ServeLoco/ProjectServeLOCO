// Shared by categoryLibraryController.js and storeModeLibraryController.js
// (TASK 26) — same requireOneArea shape libraryController.js already had
// for product-library add-to-area, extracted here so it isn't triplicated.
const { requestAreaId } = require('../utils/areaScope');

// add-to-area targets exactly one area — an area_admin's own (resolveAdminArea
// already pins that), or a super_admin's explicit X-Area-Id. Never 'all': a
// single add-to-area call materializing into every area at once would be a
// bulk fan-out endpoint's job, not this one's.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'This action cannot target "all" areas at once' });
    return null;
  }
  return areaId;
};

module.exports = { requireOneArea };
