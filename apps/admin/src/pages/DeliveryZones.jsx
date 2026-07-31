import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsApi, DeliveryZonesApi } from '../api';
import DeliveryZoneMap from '../components/DeliveryZoneMap';
import MessageBanner from '../components/MessageBanner';
import { GENERIC_ERROR } from '../utils/constants';
import './DeliveryZones.css';

const EMPTY_FORM = {
  name: '',
  parent_zone_id: '',
  normal_charge: '',
  fast_charge: '',
  normal_eta_minutes: '60',
  fast_eta_minutes: '30',
  night_charge: '0',
  cod_enabled: true,
  active: true,
};

const zoneToForm = (zone) => ({
  name: zone.name || '',
  parent_zone_id: zone.parentZoneId != null ? String(zone.parentZoneId) : '',
  normal_charge: String(zone.normalCharge),
  fast_charge: String(zone.fastCharge),
  normal_eta_minutes: String(zone.normalEtaMinutes),
  fast_eta_minutes: String(zone.fastEtaMinutes),
  night_charge: String(zone.nightCharge),
  cod_enabled: Boolean(zone.codEnabled),
  active: Boolean(zone.active),
});

// Explicit nulls are meaningful to the API: they mean "clear this field",
// as opposed to omitting the key, which means "leave it as it was". That is
// how "— none (top-level) —" detaches a zone from its parent.
const formToPayload = (form, boundary) => ({
  name: form.name || null,
  parent_zone_id: form.parent_zone_id === '' ? null : Number(form.parent_zone_id),
  normal_charge: Number(form.normal_charge || 0),
  fast_charge: Number(form.fast_charge || 0),
  normal_eta_minutes: Number.parseInt(form.normal_eta_minutes, 10) || 60,
  fast_eta_minutes: Number.parseInt(form.fast_eta_minutes, 10) || 30,
  night_charge: Number(form.night_charge || 0),
  cod_enabled: Boolean(form.cod_enabled),
  active: Boolean(form.active),
  ...(boundary ? { boundary } : {}),
});

const zoneLabel = (zone) => (zone ? (zone.name || `Zone #${zone.id}`) : '');

// Every zone nested (at any depth) under zoneId — used to keep the parent
// dropdown from offering a choice the server is guaranteed to reject as a
// nesting cycle.
const getDescendantIds = (zoneId, allZones) => {
  const children = allZones.filter((z) => z.parentZoneId === zoneId).map((z) => z.id);
  return children.reduce((acc, childId) => [...acc, childId, ...getDescendantIds(childId, allZones)], []);
};

const MAX_ETA_MINUTES = 24 * 60 - 1;
const MAX_NAME_LENGTH = 255;

// Mirrors deliveryZonesController.js's validateZoneValues so the admin sees
// mistakes immediately instead of after a round trip to the API.
const validateZoneFormClientSide = (form) => {
  const name = (form.name || '').trim();
  if (!name) return 'Zone name is required';
  if (name.length > MAX_NAME_LENGTH) return `Zone name must be ${MAX_NAME_LENGTH} characters or fewer`;

  const normal = Number(form.normal_charge);
  const fast = Number(form.fast_charge);
  const night = Number(form.night_charge);
  for (const [value, label] of [
    [normal, 'Normal delivery charge'],
    [fast, 'Fast delivery charge'],
    [night, 'Night surcharge'],
  ]) {
    if (!Number.isFinite(value) || value < 0) return `${label} cannot be negative`;
  }

  const normalEta = Number.parseInt(form.normal_eta_minutes, 10);
  const fastEta = Number.parseInt(form.fast_eta_minutes, 10);
  for (const [value, label] of [[normalEta, 'Normal delivery time'], [fastEta, 'Fast delivery time']]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_ETA_MINUTES) {
      return `${label} must be a whole number between 1 and ${MAX_ETA_MINUTES} minutes`;
    }
  }

  if (fast < normal) {
    return 'Fast delivery charge must be greater than or equal to the normal delivery charge';
  }
  return null;
};

export default function DeliveryZones() {
  const [loading, setLoading] = useState(true);
  const [zones, setZones] = useState([]);
  const [zoneForms, setZoneForms] = useState({});
  const [newZoneForm, setNewZoneForm] = useState(EMPTY_FORM);
  const [radiusPricingActive, setRadiusPricingActive] = useState(false);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);

  // Which zone's boundary is currently being drawn/reshaped on the map:
  // null (nothing), 'new' (drawing a brand new zone), or an existing zone id.
  const [editingZoneId, setEditingZoneId] = useState(null);
  const [draftBoundary, setDraftBoundary] = useState(null);

  const showError = (err) => {
    setBanner({ type: 'error', message: err?.message || GENERIC_ERROR });
  };
  const showSuccess = (message) => setBanner({ type: 'success', message });

  const fetchAll = async () => {
    try {
      setLoading(true);
      const [settingsRes, zonesRes] = await Promise.all([
        SettingsApi.get(),
        DeliveryZonesApi.list(),
      ]);
      const s = settingsRes.data || {};
      setRadiusPricingActive(Boolean(Number(s.radius_pricing_active)));
      const rows = zonesRes.data || [];
      setZones(rows);
      setZoneForms(Object.fromEntries(rows.map((z) => [z.id, zoneToForm(z)])));
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Descendants per zone, computed once per zone-list change instead of once
  // per rendered <option> (it was O(zones²) inside a filter, per row).
  const descendantIdsByZone = useMemo(() => {
    const map = new Map();
    zones.forEach((z) => map.set(z.id, new Set(getDescendantIds(z.id, zones))));
    return map;
  }, [zones]);

  // A zone can't parent itself or any of its own descendants — offering those
  // would only produce a nesting-cycle rejection from the server.
  const eligibleParentsFor = useCallback((zoneId) => {
    const descendants = descendantIdsByZone.get(zoneId);
    return zones.filter((z) => z.id !== zoneId && !(descendants && descendants.has(z.id)));
  }, [zones, descendantIdsByZone]);

  const activeZoneCount = zones.filter((z) => z.active).length;
  const missingPrereqs = [];
  if (activeZoneCount === 0) missingPrereqs.push('draw at least one active zone');

  const handleToggleRadiusPricing = async () => {
    const next = !radiusPricingActive;
    try {
      setBusy(true);
      setBanner(null);
      await SettingsApi.update({ radius_pricing_active: next });
      setRadiusPricingActive(next);
      showSuccess(next ? 'Zone pricing enabled' : 'Zone pricing disabled — flat charges apply');
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleZoneFormChange = (zoneId, field, value) => {
    setZoneForms((prev) => ({ ...prev, [zoneId]: { ...prev[zoneId], [field]: value } }));
  };

  const handleStartDrawNew = () => {
    setEditingZoneId('new');
    setDraftBoundary([]);
    setNewZoneForm(EMPTY_FORM);
  };

  const handleStartEditShape = (zoneId) => {
    const zone = zones.find((z) => z.id === zoneId);
    if (!zone) return;
    setEditingZoneId(zoneId);
    setDraftBoundary(zone.boundary || []);
  };

  const handleCancelShapeEdit = () => {
    setEditingZoneId(null);
    setDraftBoundary(null);
  };

  const handleSaveShape = async (zoneId) => {
    if (!Array.isArray(draftBoundary) || draftBoundary.length < 3) {
      setBanner({ type: 'error', message: 'Draw at least 3 points before saving the shape' });
      return;
    }
    try {
      setBusy(true);
      setBanner(null);
      const res = await DeliveryZonesApi.update(zoneId, { boundary: draftBoundary });
      const updated = res.data;
      setZones((prev) => prev.map((z) => (z.id === zoneId ? updated : z)).sort((a, b) => a.areaKm2 - b.areaKm2));
      showSuccess(`${zoneLabel(updated)} shape saved`);
      setEditingZoneId(null);
      setDraftBoundary(null);
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveZone = async (zoneId) => {
    const validationMessage = validateZoneFormClientSide(zoneForms[zoneId]);
    if (validationMessage) {
      setBanner({ type: 'error', message: validationMessage });
      return;
    }
    try {
      setBusy(true);
      setBanner(null);
      const res = await DeliveryZonesApi.update(zoneId, formToPayload(zoneForms[zoneId]));
      const updated = res.data;
      setZones((prev) => prev.map((z) => (z.id === zoneId ? updated : z)).sort((a, b) => a.areaKm2 - b.areaKm2));
      setZoneForms((prev) => ({ ...prev, [zoneId]: zoneToForm(updated) }));
      showSuccess(`${zoneLabel(updated)} saved`);
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteZone = async (zoneId) => {
    const zone = zones.find((z) => z.id === zoneId);
    if (!window.confirm(`Delete ${zoneLabel(zone)}? Any zones nested inside it become standalone. Placed orders keep their snapshots.`)) return;
    try {
      setBusy(true);
      setBanner(null);
      await DeliveryZonesApi.remove(zoneId);
      setZones((prev) => prev.map((z) => (z.parentZoneId === zoneId ? { ...z, parentZoneId: null, parent_zone_id: null } : z))
        .filter((z) => z.id !== zoneId));
      setZoneForms((prev) => {
        const next = { ...prev };
        delete next[zoneId];
        // Children of the deleted zone lose their parent server-side (ON
        // DELETE SET NULL) — mirror that here, otherwise their form still
        // holds the deleted id and the next Save fails with "Parent zone
        // not found" even though the dropdown looked blank/unselected.
        Object.keys(next).forEach((key) => {
          if (next[key].parent_zone_id === String(zoneId)) {
            next[key] = { ...next[key], parent_zone_id: '' };
          }
        });
        return next;
      });
      if (editingZoneId === zoneId) handleCancelShapeEdit();
      showSuccess('Zone deleted');
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateZone = async () => {
    if (!Array.isArray(draftBoundary) || draftBoundary.length < 3) {
      setBanner({ type: 'error', message: 'Draw the zone boundary on the map first' });
      return;
    }
    const validationMessage = validateZoneFormClientSide(newZoneForm);
    if (validationMessage) {
      setBanner({ type: 'error', message: validationMessage });
      return;
    }
    try {
      setBusy(true);
      setBanner(null);
      const res = await DeliveryZonesApi.create(formToPayload(newZoneForm, draftBoundary));
      const created = res.data;
      setZones((prev) => [...prev, created].sort((a, b) => a.areaKm2 - b.areaKm2));
      setZoneForms((prev) => ({ ...prev, [created.id]: zoneToForm(created) }));
      setNewZoneForm(EMPTY_FORM);
      setEditingZoneId(null);
      setDraftBoundary(null);
      showSuccess(`${zoneLabel(created)} added`);
    } catch (err) {
      console.error(err);
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const renderZoneFields = (zoneId, form, onChange) => (
    <>
      <td>
        <input type="text" className="form-input zone-input" value={form.name} required maxLength={MAX_NAME_LENGTH}
          onChange={(e) => onChange('name', e.target.value)} placeholder="e.g. Rampur village" />
      </td>
      <td>
        <select className="form-input zone-parent-select" value={form.parent_zone_id}
          onChange={(e) => onChange('parent_zone_id', e.target.value)}>
          <option value="">— none (top-level) —</option>
          {eligibleParentsFor(zoneId).map((z) => (
            <option key={z.id} value={z.id}>{zoneLabel(z)}</option>
          ))}
        </select>
      </td>
      <td>
        <input type="number" step="1" min="0" className="form-input zone-input" value={form.normal_charge}
          onChange={(e) => onChange('normal_charge', e.target.value)} placeholder="20" />
      </td>
      <td>
        <input type="number" step="1" min="0" className="form-input zone-input" value={form.fast_charge}
          onChange={(e) => onChange('fast_charge', e.target.value)} placeholder="40" />
      </td>
      <td>
        <input type="number" step="5" min="1" className="form-input zone-input" value={form.normal_eta_minutes}
          onChange={(e) => onChange('normal_eta_minutes', e.target.value)} placeholder="60" />
      </td>
      <td>
        <input type="number" step="5" min="1" className="form-input zone-input" value={form.fast_eta_minutes}
          onChange={(e) => onChange('fast_eta_minutes', e.target.value)} placeholder="30" />
      </td>
      <td>
        <input type="number" step="1" min="0" className="form-input zone-input" value={form.night_charge}
          onChange={(e) => onChange('night_charge', e.target.value)} placeholder="0" />
      </td>
      <td className="zone-checkbox-cell">
        <input type="checkbox" checked={form.cod_enabled}
          onChange={(e) => onChange('cod_enabled', e.target.checked)} />
      </td>
      <td className="zone-checkbox-cell">
        <input type="checkbox" checked={form.active}
          onChange={(e) => onChange('active', e.target.checked)} />
      </td>
    </>
  );

  if (loading) {
    return <div className="delivery-zones-page"><p>Loading delivery zones…</p></div>;
  }

  return (
    <div className="delivery-zones-page">
      <div className="page-header">
        <h1>Delivery Zones</h1>
        <p className="page-subtitle">
          Draw each zone as its own irregular boundary on the map — a big village zone, and
          smaller sub-village zones inside it. Give a sub-village zone a parent and it always
          wins over its parent&apos;s pricing wherever the two overlap, no matter how small it is.
          Each zone gets its own charges, delivery times, night surcharge and Cash-on-Delivery
          policy.
        </p>
      </div>

      {banner && (
        <MessageBanner type={banner.type} message={banner.message} onDismiss={() => setBanner(null)} />
      )}

      <div className="zone-card">
        <div className="zone-card-header">
          <div>
            <h2>Zone pricing</h2>
            <p className="zone-card-hint">
              When ON, zone prices replace the flat delivery charges from Settings. Orders pinned
              outside every zone are blocked. Customers without a map pin still get the flat
              charges as a fallback.
            </p>
          </div>
          <label className="zone-toggle">
            <input
              type="checkbox"
              checked={radiusPricingActive}
              disabled={busy}
              onChange={handleToggleRadiusPricing}
            />
            <span>{radiusPricingActive ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>
        {!radiusPricingActive && missingPrereqs.length > 0 && (
          <p className="zone-warning">
            Before enabling: {missingPrereqs.join(' and ')}.
          </p>
        )}
      </div>

      <div className="zone-card">
        <h2>Map</h2>
        <p className="zone-card-hint">
          {editingZoneId != null
            ? 'Editing a zone boundary — other zones are shown for reference only.'
            : 'All zones are shown here. Use "Edit shape" on a zone below, or "Draw new zone", to change a boundary.'}
        </p>
        <DeliveryZoneMap
          zones={zones}
          editingZoneId={editingZoneId}
          editingBoundary={draftBoundary}
          onDraftChange={setDraftBoundary}
        />
        {editingZoneId != null && (
          <div className="zone-center-controls">
            <span>{Array.isArray(draftBoundary) ? draftBoundary.length : 0} point(s) placed</span>
            {editingZoneId !== 'new' && (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => handleSaveShape(editingZoneId)}>
                {busy ? 'Saving…' : 'Save shape'}
              </button>
            )}
            <button type="button" className="btn-secondary" disabled={busy} onClick={handleCancelShapeEdit}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="zone-card">
        <h2>Zones</h2>
        <p className="zone-card-hint">
          When a customer&apos;s pin falls inside more than one zone, the most nested zone (the one
          with a parent among the matches) wins. If zones with no parent/child relationship
          overlap, the smaller-area one wins. Fast charge must be ≥ normal charge. Night
          surcharge uses the global night window from Settings with this zone&apos;s amount.
        </p>
        <div className="zone-table-wrap">
          <table className="zone-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Parent zone</th>
                <th>Normal ₹</th>
                <th>Fast ₹</th>
                <th>Normal ETA (min)</th>
                <th>Fast ETA (min)</th>
                <th>Night ₹</th>
                <th>COD</th>
                <th>Active</th>
                <th>Shape</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {zones.map((zone) => (
                <tr key={zone.id}>
                  {zoneForms[zone.id] && renderZoneFields(
                    zone.id,
                    zoneForms[zone.id],
                    (field, value) => handleZoneFormChange(zone.id, field, value)
                  )}
                  <td>
                    <button type="button" className="btn-secondary" disabled={busy || (editingZoneId != null && editingZoneId !== zone.id)}
                      onClick={() => handleStartEditShape(zone.id)}>
                      Edit shape ({(zone.boundary || []).length} pts, ~{zone.extentKm}km)
                    </button>
                  </td>
                  <td className="zone-actions-cell">
                    <button type="button" className="btn-secondary" disabled={busy} onClick={() => handleSaveZone(zone.id)}>{busy ? 'Saving…' : 'Save'}</button>
                    <button type="button" className="btn-danger" disabled={busy} onClick={() => handleDeleteZone(zone.id)}>{busy ? 'Deleting…' : 'Delete'}</button>
                  </td>
                </tr>
              ))}
              <tr className="zone-new-row">
                {editingZoneId === 'new' ? (
                  renderZoneFields('new', newZoneForm, (field, value) => setNewZoneForm((prev) => ({ ...prev, [field]: value })))
                ) : (
                  <td colSpan={9} className="zone-empty">Click &quot;Draw new zone&quot; to start a new zone.</td>
                )}
                <td>
                  {editingZoneId !== 'new' && (
                    <button type="button" className="btn-secondary" disabled={busy || editingZoneId != null} onClick={handleStartDrawNew}>
                      Draw new zone
                    </button>
                  )}
                </td>
                <td className="zone-actions-cell">
                  {editingZoneId === 'new' && (
                    <button type="button" className="btn-primary" disabled={busy || !Array.isArray(draftBoundary) || draftBoundary.length < 3}
                      onClick={handleCreateZone}>{busy ? 'Adding…' : 'Add zone'}</button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {zones.length === 0 && (
          <p className="zone-empty">No zones yet — draw your first one above (e.g. your main village).</p>
        )}
      </div>
    </div>
  );
}
