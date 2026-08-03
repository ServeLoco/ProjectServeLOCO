import React, { useState, useEffect, useRef } from 'react';
import {
  ShopsApi,
  subscribeRealtime,
  connectAdminRealtime,
} from '../api';
import ShopLocationPicker from '../components/ShopLocationPicker';
import ShopManageModal from './ShopManageModal';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Shops.css';

// Patches (or drops) a shop row from a live admin.shop.updated event —
// mirrors mergeRiderUpdate in Riders.jsx so another admin tab (or the
// shop-owner app itself) toggling a shop doesn't leave this table stale.
function mergeShopUpdate(list, payload) {
  if (!payload) return list;
  const id = Number(payload.shopId ?? payload.id);
  if (!Number.isFinite(id)) return list;
  if (payload.deleted) {
    return list.filter((s) => Number(s.id) !== id);
  }
  const idx = list.findIndex((s) => Number(s.id) === id);
  if (idx < 0) return list;
  const next = [...list];
  const prev = next[idx];
  next[idx] = {
    ...prev,
    is_open: payload.is_open !== undefined || payload.isOpen !== undefined
      ? Boolean(payload.is_open ?? payload.isOpen)
      : prev.is_open,
    active: payload.active !== undefined ? Boolean(payload.active) : prev.active,
  };
  return next;
}

export default function Shops() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Drawer state — create/edit shop
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingShop, setEditingShop] = useState(null);

  // Manage modal — status/schedule, orders, products & groups (shop-owner parity)
  const [manageShop, setManageShop] = useState(null);
  const [manageTab, setManageTab] = useState('overview');

  // 25.4 — Shops can't be managed for "all" areas at once (the API 400s);
  // skip the doomed fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    fetchShops();
  }, [isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connectAdminRealtime();
    const off = subscribeRealtime('admin.shop.updated', (payload) => {
      setShops((prev) => mergeShopUpdate(prev, payload));
    });
    const offVisible = subscribeRealtime('lifecycle.visible', () => fetchShops());
    const offReconn = subscribeRealtime('lifecycle.reconnected', () => fetchShops());
    return () => {
      off();
      offVisible();
      offReconn();
    };
  }, []);

  const fetchShops = async () => {
    try {
      setLoading(true);
      const res = await ShopsApi.list();
      setShops(readList(res, ['shops']));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const openCreateDrawer = () => {
    setEditingShop(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (shop) => {
    setEditingShop(shop);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingShop(null);
  };

  const openManageModal = (shop, tab = 'overview') => {
    setManageShop(shop);
    setManageTab(tab);
  };

  const closeManageModal = () => {
    setManageShop(null);
    // Overview's schedule edits (open_time/close_time) don't have a realtime
    // patch path like is_open/active do — refetch so the row (and a
    // reopened modal) reflect what was actually saved.
    fetchShops();
  };

  const toggleActive = async (shop) => {
    try {
      await ShopsApi.update(shop.id, { active: !shop.active });
      fetchShops();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const toggleOpen = async (shop) => {
    try {
      await ShopsApi.update(shop.id, { is_open: !shop.is_open });
      fetchShops();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  /** @returns {Promise<boolean>} true if deleted, false if cancelled or failed */
  const handleDeleteShop = async (shop) => {
    const label = shop?.name || `shop #${shop?.id}`;
    const ok = window.confirm(
      `Delete "${label}"?\n\nThis removes the shop. Its products move to the default home catalogue (not deleted). Active orders must be finished or cancelled first.`
    );
    if (!ok) return false;
    try {
      setError(null);
      await ShopsApi.delete(shop.id);
      if (editingShop?.id === shop.id) closeDrawer();
      if (manageShop?.id === shop.id) closeManageModal();
      fetchShops();
      return true;
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
      throw err;
    }
  };

  if (isAllAreas) {
    return <div className="shops-container"><PickAreaNotice label="Shops" /></div>;
  }

  return (
    <div className="shops-container">
      <header className="shops-header">
        <div>
          <h1 className="shops-title">Shops Management</h1>
          <p className="shops-subtitle">
            Manage shops, and confirm / ready / cancel orders on behalf of a shop owner
            (same actions as the shop-owner app popup).
          </p>
        </div>
        <button className="btn-primary" onClick={openCreateDrawer}>
          + New Shop
        </button>
      </header>

      {error && <div className="error-container" style={{ marginBottom: '2rem' }}>{error}</div>}

      <section className="shops-table-wrapper">
        <table className="shops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Products</th>
              <th>Active</th>
              <th>Open</th>
              <th>Location</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && shops.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>Loading shops...</td></tr>
            ) : shops.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>No shops found.</td></tr>
            ) : (
              shops.map(s => (
                <tr key={s.id} className="shop-row" onClick={() => openManageModal(s)}>
                  <td><span className="shop-name">{s.name}</span></td>
                  <td>
                    {s.owner_user_id ? (
                      <span className="shop-owner">{s.owner_name || 'Unnamed'} ({s.owner_phone})</span>
                    ) : (
                      <span className="shop-owner-empty">— unassigned —</span>
                    )}
                  </td>
                  <td>{s.product_count}</td>
                  <td>
                    <button
                      className={`availability-toggle ${s.active ? 'in-stock' : 'out-of-stock'}`}
                      onClick={(e) => { e.stopPropagation(); toggleActive(s); }}
                    >
                      {s.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td>
                    <button
                      className={`availability-toggle ${s.is_open ? 'in-stock' : 'out-of-stock'}`}
                      onClick={(e) => { e.stopPropagation(); toggleOpen(s); }}
                    >
                      {s.is_open ? 'Open' : 'Closed'}
                    </button>
                  </td>
                  <td>
                    {(s.latitude != null && s.longitude != null) ? (
                      <span className="shop-loc-set" title={`${s.latitude}, ${s.longitude}`}>🏪 Set</span>
                    ) : (
                      <span className="shop-loc-missing">Not set</span>
                    )}
                  </td>
                  <td className="shop-actions-cell" onClick={(e) => e.stopPropagation()}>
                    <button className="action-link action-link-orders" onClick={() => openManageModal(s, 'orders')}>
                      Orders
                    </button>
                    <button className="action-link" onClick={() => openEditDrawer(s)}>Edit</button>
                    <button
                      type="button"
                      className="action-link danger"
                      onClick={() => handleDeleteShop(s)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {drawerOpen && (
        <ShopFormDrawer
          shop={editingShop}
          onClose={closeDrawer}
          onSave={() => { closeDrawer(); fetchShops(); }}
          onDelete={handleDeleteShop}
        />
      )}

      {manageShop && (
        <ShopManageModal
          shop={manageShop}
          initialTab={manageTab}
          onClose={closeManageModal}
        />
      )}
    </div>
  );
}

function ShopFormDrawer({ shop, onClose, onSave, onDelete }) {
  const isEdit = !!shop;
  const [name, setName] = useState(shop?.name || '');
  const [ownerPhone, setOwnerPhone] = useState(shop?.owner_phone || '');
  const [location, setLocation] = useState(
    shop?.latitude != null && shop?.longitude != null
      ? { latitude: shop.latitude, longitude: shop.longitude }
      : null,
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // Snapshot the first render's fields so an accidental overlay click can be
  // told apart from a real "I'm done" close — don't silently drop edits.
  const initialSnapshotRef = useRef(null);
  if (initialSnapshotRef.current === null) {
    initialSnapshotRef.current = JSON.stringify({ name, ownerPhone, location });
  }
  const isDirty = JSON.stringify({ name, ownerPhone, location }) !== initialSnapshotRef.current;
  const handleCloseAttempt = () => {
    if (isDirty && !window.confirm('Discard unsaved changes to this shop?')) return;
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setFormError(null);
      setSaving(true);

      const locPayload = location
        ? { latitude: location.latitude, longitude: location.longitude }
        : { latitude: null, longitude: null };

      if (isEdit) {
        // PATCH only updates fields present in the payload — sending an
        // empty owner_phone here IS meaningful (clears the owner), so
        // always include it on edit.
        await ShopsApi.update(shop.id, {
          name,
          owner_phone: ownerPhone.trim() || null,
          ...locPayload,
        });
      } else {
        // On create, omit owner_phone entirely when blank rather than
        // sending '' — there's no existing owner to "clear" yet.
        const payload = { name, ...locPayload };
        if (ownerPhone.trim()) payload.owner_phone = ownerPhone.trim();
        await ShopsApi.create(payload);
      }
      onSave();
    } catch (err) {
      console.error(err);
      setFormError(err.message || GENERIC_ERROR);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!isEdit || !onDelete) return;
    try {
      setFormError(null);
      setSaving(true);
      const deleted = await onDelete(shop);
      if (!deleted) setSaving(false);
      // On success parent closes the drawer; keep saving if still open.
    } catch (err) {
      console.error(err);
      setFormError(err.message || GENERIC_ERROR);
      setSaving(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={handleCloseAttempt}>
      <div className="drawer-content" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="drawer-header">
            <h3 className="drawer-title">{isEdit ? 'Edit Shop' : 'New Shop'}</h3>
            <button type="button" className="drawer-close" onClick={handleCloseAttempt}>&times;</button>
          </div>

          <div className="drawer-body">
            {formError && <div className="error-container" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <div className="form-group">
              <label className="form-label">Shop Name</label>
              <input required type="text" className="form-input" value={name} onChange={e => setName(e.target.value)} />
            </div>

            {isEdit ? (
              <ShopLocationPicker
                shopName={name}
                value={location}
                onChange={setLocation}
              />
            ) : (
              <p className="form-hint" style={{ marginBottom: '0.5rem' }}>
                Save the shop first, then edit to set the pickup location on the map.
              </p>
            )}

            <div className="form-group">
              <label className="form-label">Owner Phone (Optional)</label>
              <input
                type="text"
                className="form-input"
                placeholder="+919876543210"
                value={ownerPhone}
                onChange={e => setOwnerPhone(e.target.value)}
              />
              <p className="form-hint">
                The owner must have logged into the customer app via OTP at least once before you can assign them here.
                {isEdit && ' Clear this field to remove the current owner.'}
              </p>
            </div>
          </div>

          <div className="drawer-footer">
            {isEdit ? (
              <button
                type="button"
                className="action-link danger"
                onClick={handleDelete}
                disabled={saving}
                style={{ marginRight: 'auto' }}
              >
                Delete
              </button>
            ) : null}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save Shop'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
