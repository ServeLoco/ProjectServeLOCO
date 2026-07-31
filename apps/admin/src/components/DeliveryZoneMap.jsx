import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import './DeliveryZoneMap.css';

const DEFAULT_CENTER = { lat: 29.5152, lng: 75.4548 };

// Top-level ("village") zones vs. nested ("sub-village") zones get distinct
// palettes so a child zone visually reads as a hole cut into its parent —
// children are drawn after (on top of) their ancestors with higher opacity.
const PARENT_COLORS = ['#2563eb', '#0891b2', '#4338ca'];
const CHILD_COLORS = ['#d97706', '#dc2626', '#c026d3', '#65a30d'];

// How many parent hops a zone is from the top of its nesting chain. Guards
// against a corrupt/cyclic parent_zone_id chain by bailing after one pass.
function zoneDepth(zone, byId) {
  let depth = 0;
  let current = zone;
  const guard = new Set();
  while (current?.parentZoneId != null && !guard.has(current.id)) {
    guard.add(current.id);
    const parent = byId.get(current.parentZoneId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function toLatLngs(boundary) {
  return (boundary || [])
    .map((p) => [Number(p.lat), Number(p.lng)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}

function zoneTooltip(zone) {
  const label = zone.name || `Zone #${zone.id}`;
  const charge = Number(zone.normalCharge ?? zone.normal_charge ?? 0);
  return `${label} — ₹${charge}`;
}

/**
 * Delivery-zone map: renders every zone as its own polygon, and — when
 * `editingZoneId` is set — turns one of them (or a brand new draft) into a
 * draggable-vertex shape via Leaflet.draw.
 *
 * zones: rows with { id, name, boundary: [{lat,lng}], parentZoneId, active,
 *   normalCharge }. editingZoneId: null | 'new' | <zone id>. editingBoundary:
 *   the vertex array for the zone currently being drawn/edited (controlled
 *   by the parent — this component only reports changes via onDraftChange).
 */
export default function DeliveryZoneMap({ zones, editingZoneId, editingBoundary, onDraftChange, mapCenterHint }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const staticLayerRef = useRef(null);
  const editableLayerRef = useRef(null);
  const drawHandlerRef = useRef(null);
  const activeLayerRef = useRef(null);
  const didFitBoundsRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // Init the map once.
  useEffect(() => {
    if (!mapRef.current) return undefined;

    try {
      const lat = mapCenterHint?.lat ?? DEFAULT_CENTER.lat;
      const lng = mapCenterHint?.lng ?? DEFAULT_CENTER.lng;

      const map = L.map(mapRef.current, { zoomControl: true }).setView([lat, lng], 13);
      mapInstanceRef.current = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      staticLayerRef.current = L.layerGroup().addTo(map);
      editableLayerRef.current = new L.FeatureGroup().addTo(map);

      setReady(true);
      // Container can measure 0x0 at init time when a parent is mid-transition.
      const invalidateTimer = setTimeout(() => map.invalidateSize(), 100);
      mapInstanceRef.current._invalidateTimer = invalidateTimer;

      // Leaflet caches container size internally; any later resize (layout
      // shift, CSS change, sidebar toggle) leaves it stale and clips vector
      // overlays drawn against the old bounds.
      const resizeObserver = new ResizeObserver(() => map.invalidateSize());
      resizeObserver.observe(mapRef.current);
      mapInstanceRef.current._resizeObserver = resizeObserver;
    } catch (err) {
      setError('Could not load map');
      console.error(err);
    }

    return () => {
      // Must be cleared before remove() — otherwise it fires invalidateSize()
      // on an already-destroyed map (throws in React 18 StrictMode, where the
      // effect is torn down within the 100ms window).
      if (mapInstanceRef.current?._invalidateTimer) clearTimeout(mapInstanceRef.current._invalidateTimer);
      mapInstanceRef.current?._resizeObserver?.disconnect();
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw the read-only zone polygons whenever the list changes. The zone
  // currently being edited is skipped here — it lives in the editable layer.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!ready || !map) return;
    staticLayerRef.current.clearLayers();

    const byId = new Map(zones.map((z) => [z.id, z]));
    const visible = zones.filter((z) => z.id !== editingZoneId);
    const sorted = [...visible].sort((a, b) => zoneDepth(a, byId) - zoneDepth(b, byId));

    const allPoints = [];
    sorted.forEach((zone) => {
      const latlngs = toLatLngs(zone.boundary);
      if (latlngs.length < 3) return;
      const depth = zoneDepth(zone, byId);
      const palette = depth === 0 ? PARENT_COLORS : CHILD_COLORS;
      const color = palette[zone.id % palette.length];
      const layer = L.polygon(latlngs, {
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: zone.active ? (depth === 0 ? 0.12 : 0.28) : 0.04,
        dashArray: zone.active ? null : '4 4',
      }).addTo(staticLayerRef.current);
      layer.bindTooltip(zoneTooltip(zone), { sticky: true });
      allPoints.push(...latlngs);
    });

    if (!didFitBoundsRef.current && allPoints.length > 0) {
      map.fitBounds(L.latLngBounds(allPoints), { padding: [24, 24] });
      didFitBoundsRef.current = true;
    }
  }, [ready, zones, editingZoneId]);

  // Whether this edit session reshapes an existing polygon or draws a new one
  // is decided per session rather than read fresh inside the effect below.
  //
  // The effect deliberately does NOT depend on `editingBoundary` — re-running
  // it on every vertex drag would tear down the layer being dragged. But that
  // meant a boundary arriving AFTER editingZoneId was set (zone list still
  // loading) left an existing zone stuck in "draw a new polygon" mode. So the
  // session may upgrade draw -> reshape, but only while nothing has been
  // drawn yet (activeLayerRef still null).
  const hasEditableBoundary = Array.isArray(editingBoundary) && editingBoundary.length >= 3;
  const editSessionRef = useRef({ zoneId: undefined, mode: null });
  if (editSessionRef.current.zoneId !== editingZoneId) {
    editSessionRef.current = {
      zoneId: editingZoneId,
      mode: hasEditableBoundary ? 'reshape' : 'draw',
    };
  } else if (
    editSessionRef.current.mode === 'draw'
    && hasEditableBoundary
    && activeLayerRef.current === null
  ) {
    editSessionRef.current = { zoneId: editingZoneId, mode: 'reshape' };
  }
  const editMode = editSessionRef.current.mode;

  // Wire the editable layer to whichever zone is currently being drawn/edited.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!ready || !map) return undefined;

    if (activeLayerRef.current?.editing) activeLayerRef.current.editing.disable();
    if (drawHandlerRef.current) drawHandlerRef.current.disable();
    drawHandlerRef.current = null;
    activeLayerRef.current = null;
    editableLayerRef.current.clearLayers();

    if (editingZoneId == null) return undefined;

    const reportVertices = (layer) => {
      const rings = layer.getLatLngs();
      const ring = Array.isArray(rings[0]) ? rings[0] : rings;
      onDraftChange?.(ring.map((ll) => ({ lat: ll.lat, lng: ll.lng })));
    };

    if (editMode === 'reshape') {
      // Reshaping an existing polygon: drag its vertices directly.
      const latlngs = toLatLngs(editingBoundary);
      const layer = L.polygon(latlngs, {
        color: '#16a34a', weight: 3, fillColor: '#16a34a', fillOpacity: 0.15,
      }).addTo(editableLayerRef.current);
      map.fitBounds(layer.getBounds(), { padding: [40, 40] });
      layer.editing.enable();
      layer.on('edit', () => reportVertices(layer));
      activeLayerRef.current = layer;
    } else {
      // Drawing a brand new zone from scratch.
      const drawHandler = new L.Draw.Polygon(map, {
        shapeOptions: { color: '#16a34a', weight: 3, fillColor: '#16a34a', fillOpacity: 0.15 },
        allowIntersection: false,
        showArea: true,
      });
      drawHandler.enable();
      drawHandlerRef.current = drawHandler;

      const onCreated = (e) => {
        editableLayerRef.current.addLayer(e.layer);
        e.layer.editing.enable();
        e.layer.on('edit', () => reportVertices(e.layer));
        activeLayerRef.current = e.layer;
        reportVertices(e.layer);
      };
      map.on(L.Draw.Event.CREATED, onCreated);
      return () => {
        map.off(L.Draw.Event.CREATED, onCreated);
        // Disable, not just detach the listener — React 18 StrictMode
        // double-invokes this effect in dev, and a left-enabled handler
        // keeps eating map clicks alongside the next one, corrupting the
        // vertex count of whichever polygon "wins" the click.
        drawHandler.disable();
        if (drawHandlerRef.current === drawHandler) drawHandlerRef.current = null;
      };
    }
    return undefined;
    // editingBoundary is read but intentionally not a dependency — see the
    // editSessionRef comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, editingZoneId, editMode]);

  return (
    <div className="delivery-zone-map-wrap">
      <div ref={mapRef} className="delivery-zone-map" role="application" aria-label="Delivery zones map" />
      {error ? <p className="delivery-zone-map-error">{error}</p> : null}
      {editingZoneId != null && (
        <p className="delivery-zone-map-hint">
          {editMode === 'reshape'
            ? 'Drag the dots to reshape the boundary.'
            : 'Click the map to place points, then click the first point again to close the shape.'}
        </p>
      )}
    </div>
  );
}
