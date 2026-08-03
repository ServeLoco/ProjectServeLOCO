import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MobileAdminsApi } from '../api';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Shops.css';

export default function MobileAdmins() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const [mobileAdmins, setMobileAdmins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchMobileAdmins = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await MobileAdminsApi.list();
      setMobileAdmins(readList(res, ['mobileAdmins', 'mobile_admins']));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  // 25.4 — Mobile admins can't be managed for "all" areas at once (the API
  // 400s); skip the doomed fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    fetchMobileAdmins();
  }, [fetchMobileAdmins, isAllAreas]);

  // Snapshot what the form looked like when the drawer opened, so an
  // accidental overlay click can be told apart from a real "I'm done" close.
  const initialFormRef = useRef({ phone: '', displayName: '' });

  const openCreate = () => {
    setEditingId(null);
    setPhone('');
    setDisplayName('');
    setFormError(null);
    initialFormRef.current = { phone: '', displayName: '' };
    setDrawerOpen(true);
  };

  const openEdit = (admin) => {
    const initialPhone = admin.phone || '';
    const initialDisplayName = admin.displayName || admin.display_name || '';
    setEditingId(admin.id);
    setPhone(initialPhone);
    setDisplayName(initialDisplayName);
    setFormError(null);
    initialFormRef.current = { phone: initialPhone, displayName: initialDisplayName };
    setDrawerOpen(true);
  };

  const closeDrawerAttempt = () => {
    const isDirty = phone !== initialFormRef.current.phone || displayName !== initialFormRef.current.displayName;
    if (isDirty && !window.confirm('Discard unsaved changes to this mobile admin?')) return;
    setDrawerOpen(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setFormError(null);
      if (editingId) {
        await MobileAdminsApi.update(editingId, {
          phone: phone.trim(),
          displayName: displayName.trim() || undefined,
        });
      } else {
        await MobileAdminsApi.create({
          phone: phone.trim(),
          displayName: displayName.trim() || undefined,
        });
      }
      setDrawerOpen(false);
      fetchMobileAdmins();
    } catch (err) {
      console.error(err);
      setFormError(err.message || GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (admin) => {
    try {
      setError(null);
      await MobileAdminsApi.update(admin.id, { active: !admin.active });
      fetchMobileAdmins();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  if (isAllAreas) {
    return <div className="shops-container"><PickAreaNotice label="Mobile Admins" /></div>;
  }

  return (
    <div className="shops-container">
      <header className="shops-header">
        <div>
          <h1 className="shops-title">Mobile Admins</h1>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            These numbers open Admin Mode in the VillKro phone app after OTP. One number = one role
            (not shop/rider).
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={openCreate}>
          + Add Mobile Admin
        </button>
      </header>

      {error && (
        <div className="error-container" style={{ marginBottom: '1.25rem' }}>
          {error}
        </div>
      )}

      <section className="shops-table-wrapper">
        <table className="shops-table">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Name</th>
              <th>Active</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && mobileAdmins.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ textAlign: 'center', padding: '2rem' }}>
                  Loading mobile admins...
                </td>
              </tr>
            ) : mobileAdmins.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ textAlign: 'center', padding: '2rem' }}>
                  No mobile admins yet. Add a phone number to grant Admin Mode.
                </td>
              </tr>
            ) : (
              mobileAdmins.map((a) => (
                <tr key={a.id}>
                  <td>{a.phone}</td>
                  <td>
                    <span className="shop-name">{a.displayName || a.display_name || a.userName || a.user_name || '—'}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`availability-toggle ${a.active ? 'in-stock' : 'out-of-stock'}`}
                      onClick={() => toggleActive(a)}
                    >
                      {a.active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                      {a.createdAt || a.created_at
                        ? new Date(a.createdAt || a.created_at).toLocaleDateString()
                        : '—'}
                    </span>
                  </td>
                  <td>
                    <button type="button" className="btn-secondary" onClick={() => openEdit(a)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {drawerOpen && (
        <div className="shop-drawer-overlay" onClick={closeDrawerAttempt} role="presentation">
          <div
            className="shop-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={editingId ? 'Edit mobile admin' : 'Add mobile admin'}
          >
            <header className="shop-drawer-header">
              <h2>{editingId ? 'Edit mobile admin' : 'Add mobile admin'}</h2>
              <button type="button" className="btn-secondary" onClick={closeDrawerAttempt}>
                Close
              </button>
            </header>
            <form onSubmit={submit} className="shop-drawer-body">
              {formError && (
                <div className="error-container" style={{ marginBottom: '0.75rem' }}>
                  {formError}
                </div>
              )}
              <label className="form-label">
                Phone *
                <input
                  className="form-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="10-digit phone, e.g. 9876543210"
                  required
                />
              </label>
              <label className="form-label">
                Display name
                <input
                  className="form-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional — defaults to their user name"
                />
              </label>
              <button className="btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add mobile admin'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
