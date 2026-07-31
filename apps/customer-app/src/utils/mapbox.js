import Mapbox from '@rnmapbox/maps';

/** Default checkout map center (updated 2026-07-13). */
export const DEFAULT_MAP_CENTER = {
  latitude: 29.452142,
  longitude: 75.671967,
};

const token =
  typeof process !== 'undefined' && process.env
    ? process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN
    : '';

export const mapboxAvailable = Boolean(token && String(token).trim());
export const mapboxAccessToken = mapboxAvailable ? String(token).trim() : '';

if (mapboxAvailable) {
  Mapbox.setAccessToken(String(token).trim());
}

export { Mapbox };
export default Mapbox;
