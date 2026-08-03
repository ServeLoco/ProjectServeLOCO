import { useState, useEffect } from 'react';
import { StoreModesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { useAreaStore } from '../stores/useAreaStore';

// Fallback keeps pages functional if the store-modes endpoint is briefly
// unreachable — matches the two hardcoded modes that always exist as system rows.
const FALLBACK_MODES = [
  { id: 'packed', slug: 'packed', label: 'Packed Items', display_order: 1 },
  { id: 'fast_food', slug: 'fast_food', label: 'Fast Food', display_order: 2 },
];

export function useStoreModes() {
  const [modes, setModes] = useState(FALLBACK_MODES);
  const [loading, setLoading] = useState(true);

  // Store modes are strictly per-area: the endpoint 400s for "all areas" and
  // for a super_admin whose area hasn't resolved yet. This hook is called at
  // the TOP of many pages — before their own `isAllAreas` early return — so
  // without these guards every such page fired a doomed request (a burst of
  // 400s + console noise on each render of Products/Categories/Combos/
  // Coupons/Offers under "All areas"). FALLBACK_MODES already keeps callers
  // functional meanwhile, which is exactly what those pages render behind
  // their PickAreaNotice anyway.
  const { areaId, isSuperAdmin, initialized } = useAreaStore() || {};
  const skip = areaId === 'all' || (isSuperAdmin && !initialized);

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    StoreModesApi.list()
      .then(res => {
        if (cancelled) return;
        const list = readList(res, ['storeModes']);
        if (list.length > 0) {
          setModes([...list].sort((a, b) => a.display_order - b.display_order));
        }
      })
      .catch(err => console.error('Failed to load store modes:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [skip, areaId]);

  return { modes, loading };
}

export const modeLabel = (modes, slug) => modes.find(m => m.slug === slug)?.label || slug;
