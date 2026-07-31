import { mapboxAccessToken, mapboxAvailable } from './mapbox';

/**
 * Forward-geocodes a free-text query (village/town/area name) into a list of
 * place suggestions, biased toward India and (optionally) a center point so
 * nearby matches rank first. Used by the delivery-location search box.
 *
 * @param {string} query
 * @param {{ proximity?: { lat: number, lng: number }, signal?: AbortSignal }} [opts]
 * @returns {Promise<Array<{ id: string, name: string, placeName: string, lat: number, lng: number }>>}
 */
async function searchPlaces(query, { proximity, signal } = {}) {
  const trimmed = String(query || '').trim();
  if (!mapboxAvailable || trimmed.length < 2) return [];

  const params = new URLSearchParams({
    access_token: mapboxAccessToken,
    autocomplete: 'true',
    limit: '6',
    language: 'en',
    country: 'in',
  });
  if (proximity && Number.isFinite(proximity.lat) && Number.isFinite(proximity.lng)) {
    params.set('proximity', `${proximity.lng},${proximity.lat}`);
  }

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(trimmed)}.json?${params.toString()}`;

  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const body = await res.json();
  const features = Array.isArray(body?.features) ? body.features : [];

  return features
    .filter((f) => Array.isArray(f?.center) && f.center.length >= 2)
    .map((f) => ({
      id: f.id,
      name: f.text,
      placeName: f.place_name,
      lng: Number(f.center[0]),
      lat: Number(f.center[1]),
    }));
}

/**
 * Reverse-geocodes a coordinate into a short "Village, City, State" label
 * (village/locality first, then place-level city, then region/state — each
 * only if present and distinct, capped at 3 parts). Used to label the
 * customer's current delivery location.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string|null>}
 */
async function reverseGeocode(lat, lng, { signal } = {}) {
  if (!mapboxAvailable || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Reverse geocoding defaults to limit=1, which — with multiple types
  // listed — returns only whichever single type Mapbox ranks best (often
  // "address"/"neighborhood"), silently dropping the actual village. Mapbox
  // requires limit to equal the number of types to get one feature per type.
  const types = ['locality', 'place', 'region'];
  const params = new URLSearchParams({
    access_token: mapboxAccessToken,
    language: 'en',
    types: types.join(','),
    limit: String(types.length),
  });

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?${params.toString()}`;

  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const body = await res.json();
  const features = Array.isArray(body?.features) ? body.features : [];
  if (!features.length) return null;

  const byType = (type) => features.find((f) => Array.isArray(f.place_type) && f.place_type.includes(type));
  const localityFeature = byType('locality');
  const placeFeature = byType('place');
  const regionFeature = byType('region');

  const contextOf = (feature) => (Array.isArray(feature?.context) ? feature.context : []);
  const city = placeFeature?.text
    || contextOf(localityFeature).find((c) => String(c.id).startsWith('place.'))?.text;
  const state = regionFeature?.text
    || contextOf(placeFeature).find((c) => String(c.id).startsWith('region.'))?.text
    || contextOf(localityFeature).find((c) => String(c.id).startsWith('region.'))?.text;

  const parts = [localityFeature?.text || city, city, state]
    .filter(Boolean)
    .filter((part, index, arr) => arr.indexOf(part) === index);

  return parts.slice(0, 3).join(', ') || localityFeature?.place_name || placeFeature?.place_name || null;
}

export { searchPlaces, reverseGeocode };
