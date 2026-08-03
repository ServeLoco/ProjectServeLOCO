// The one place X-Area-Id lives outside React (§4.4 — client.js is the only
// place the header is attached; this module is what it reads from, since
// client.js is a plain fetch wrapper with no access to React context).
// useAreaStore.js is the React-facing layer on top of this.
const AREA_ID_STORAGE_KEY = 'admin_area_id';

let currentAdminRole = null; // 'super_admin' | 'area_admin' | null (unknown/logged out)
let currentAreaId = localStorage.getItem(AREA_ID_STORAGE_KEY) || null; // string | 'all' | null

export const areaHeader = {
  // Called by AuthProvider the moment the logged-in admin's role becomes
  // known (login response, or /me on boot/reload) — gates whether
  // X-Area-Id is ever sent at all. An area_admin sending this header gets a
  // hard 403 server-side (areaMiddleware.js's resolveAdminArea: "rejected,
  // not silently overridden"), so this must never emit it for one — even if
  // a stale value is still sitting in localStorage from a previous
  // super_admin session on the same browser.
  setAdminRole(role) {
    currentAdminRole = role;
  },

  // What client.js actually sends. null/undefined means "omit the header".
  get() {
    return currentAdminRole === 'super_admin' ? currentAreaId : null;
  },

  // Read-only peek at the persisted value regardless of role — used by
  // useAreaStore's boot-time validation before it knows anything else.
  getPersisted() {
    return currentAreaId;
  },

  setAreaId(areaId) {
    currentAreaId = areaId != null ? String(areaId) : null;
    if (currentAreaId) {
      localStorage.setItem(AREA_ID_STORAGE_KEY, currentAreaId);
    } else {
      localStorage.removeItem(AREA_ID_STORAGE_KEY);
    }
  },

  reset() {
    currentAdminRole = null;
    currentAreaId = null;
    localStorage.removeItem(AREA_ID_STORAGE_KEY);
  },
};
