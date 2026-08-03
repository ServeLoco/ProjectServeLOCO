import { useState, useEffect, useCallback, useRef } from 'react';
import { storeModesApi } from '../api';

// Matches the two system rows that always exist server-side, so the capsule
// still renders correctly if the store-modes fetch fails (offline first load, etc).
const FALLBACK_MODES = [
  { id: 'packed', slug: 'packed', label: 'Packed Items', display_order: 1 },
  { id: 'fast_food', slug: 'fast_food', label: 'Fast Food', display_order: 2 },
];

// TASK 28.3 — store modes key off the live pin, same as the catalog and
// dashboard, instead of the server's users.last_area_id/default fallback.
// `coords` is optional so every existing caller keeps working unchanged.
// Read via a ref rather than a `refetch` dependency: a raw GPS fix changes
// on nearly every fix (sub-meter jitter), and re-fetching store modes on
// every one of those would be a refetch storm. HomeScreen re-triggers
// `refetchModes()` itself on an actual zone change (deliveryZoneId), the
// same trigger it already uses for `refresh` — this hook only needs the
// latest coordinate at the moment a fetch actually happens.
export function useStoreModes(coords) {
  const [modes, setModes] = useState(FALLBACK_MODES);
  const mountedRef = useRef(true);
  const coordsRef = useRef(coords);
  coordsRef.current = coords;

  const refetch = useCallback(() => {
    return storeModesApi.list({ latitude: coordsRef.current?.lat, longitude: coordsRef.current?.lng })
      .then(res => {
        if (!mountedRef.current) return;
        const list = res?.data || res?.storeModes || [];
        if (Array.isArray(list) && list.length > 0) {
          setModes([...list].sort((a, b) => a.display_order - b.display_order));
        }
      })
      .catch(() => {
        // Keep whatever modes are already loaded — the capsule stays usable offline.
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refetch();
    return () => { mountedRef.current = false; };
  }, [refetch]);

  return { modes, refetchModes: refetch };
}
