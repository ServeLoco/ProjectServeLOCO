import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './DeliveryPinPicker.css';

const DEFAULT_CENTER = { lat: 29.451998, lng: 75.668669 };

function createPinIcon(L) {
  return L.divIcon({
    className: 'delivery-pin-marker-wrap',
    html: '<div class="delivery-pin-marker">📍</div>',
    iconSize: [34, 34],
    iconAnchor: [17, 32],
  });
}

/**
 * Click-to-place customer delivery pin (Leaflet/OSM), same pattern as
 * ShopLocationPicker but for a customer's delivery coordinates rather than
 * the shop's own pickup spot. Feeds latitude/longitude straight into the
 * same /admin/orders/calculate and /admin/orders bodies the customer app's
 * checkout sends, so an admin-placed order gets the same zone-based
 * delivery pricing / out-of-range checks instead of skipping them.
 * value: { latitude, longitude } | null
 */
export default function DeliveryPinPicker({ value, onChange }) {
  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!mapRef.current) return undefined;

    try {
      const lat = value?.latitude ?? DEFAULT_CENTER.lat;
      const lng = value?.longitude ?? DEFAULT_CENTER.lng;

      const map = L.map(mapRef.current, { zoomControl: true }).setView([lat, lng], 14);
      mapInstanceRef.current = map;
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);

      const placeMarker = (plat, plng) => {
        if (markerRef.current) {
          markerRef.current.setLatLng([plat, plng]);
        } else {
          markerRef.current = L.marker([plat, plng], {
            icon: createPinIcon(L),
            draggable: true,
          }).addTo(map);
          markerRef.current.on('dragend', () => {
            const pos = markerRef.current.getLatLng();
            onChange?.({ latitude: pos.lat, longitude: pos.lng });
          });
        }
      };

      if (value?.latitude != null && value?.longitude != null) {
        placeMarker(value.latitude, value.longitude);
      }

      map.on('click', (e) => {
        const { lat: clickLat, lng: clickLng } = e.latlng;
        placeMarker(clickLat, clickLng);
        onChange?.({ latitude: clickLat, longitude: clickLng });
      });

      setReady(true);
      // The modal can mount the map before its own open transition finishes
      // laying out, same 0x0-container gotcha ShopLocationPicker guards for.
      setTimeout(() => map.invalidateSize(), 100);
    } catch (err) {
      setError('Could not load map');
      console.error(err);
    }

    return () => {
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !markerRef.current || !value) return;
    if (value.latitude == null || value.longitude == null) return;
    markerRef.current.setLatLng([value.latitude, value.longitude]);
  }, [value?.latitude, value?.longitude, ready]);

  const lat = value?.latitude;
  const lng = value?.longitude;

  return (
    <div className="delivery-pin-picker">
      <div className="delivery-pin-picker-head">
        <span className="delivery-pin-picker-title">Delivery location (optional)</span>
        <span className="delivery-pin-picker-hint">
          Tap the map to drop the customer's pin. Drag to fine-tune. Sets the same
          zone pricing / delivery-range checks the customer app uses.
        </span>
      </div>
      <div ref={mapRef} className="delivery-pin-map" role="application" aria-label="Delivery location map" />
      {error ? <p className="delivery-pin-error">{error}</p> : null}
      <div className="delivery-pin-coords">
        <label>
          Latitude
          <input
            type="number"
            step="any"
            className="com-input"
            value={lat ?? ''}
            placeholder="29.451998"
            onChange={(e) => {
              const nextLat = e.target.value === '' ? null : Number(e.target.value);
              onChange?.(nextLat != null && lng != null ? { latitude: nextLat, longitude: lng } : null);
            }}
          />
        </label>
        <label>
          Longitude
          <input
            type="number"
            step="any"
            className="com-input"
            value={lng ?? ''}
            placeholder="75.668669"
            onChange={(e) => {
              const nextLng = e.target.value === '' ? null : Number(e.target.value);
              onChange?.(lat != null && nextLng != null ? { latitude: lat, longitude: nextLng } : null);
            }}
          />
        </label>
        <button
          type="button"
          className="btn-secondary delivery-pin-clear"
          onClick={() => onChange?.(null)}
        >
          Clear pin
        </button>
      </div>
    </div>
  );
}
