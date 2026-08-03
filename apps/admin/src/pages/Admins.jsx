import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AdminsApi, AreasApi } from '../api';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import './Shops.css';

const EMPTY_FORM = { username: '', password: '', role: 'area_admin', areaId: '', displayName: '' };

export default function Admins() {
  const [admins, setAdmins] = useState([]);
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [adminsRes, areasRes] = await Promise.all([AdminsApi.list(), AreasApi.list()]);
      setAdmins(readList(adminsRes));
      setAreas(readList(areasRes));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const initialFormRef = useRef(EMPTY_FORM);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    initialFormRef.current = EMPTY_FORM;
    setDrawerOpen(true);
  };

  const openEdit = (admin) => {
    const next = {
      username: admin.username,
      password: '',
      role: admin.role,
      areaId: admin.areaId ?? admin.area_id ?? '',
      displayName: admin.displayName || admin.display_name || '',
    };
    setEditingId(admin.id);
    setForm(next);
    setFormError(null);
    initialFormRef.current = next;
    setDrawerOpen(true);
  };

  const closeDrawerAttempt = () => {
    const isDirty = JSON.stringify(form) !== JSON.stringify(initialFormRef.current);
    if (isDirty && !window.confirm('Discard unsaved changes to this admin?')) return;
    setDrawerOpen(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setFormError(null);
      const payload = {
        role: form.role,
        areaId: form.role === 'super_admin' ? null : Number(form.areaId) || null,
        displayName: form.displayName.trim() || undefined,
      };
      if (editingId) {
        if (form.password) payload.password = form.password;
        await AdminsApi.update(editingId, payload);
      } else {
        await AdminsApi.create({ ...payload, username: form.username.trim(), password: form.password });
      }
      setDrawerOpen(false);
      fetchAll();
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
      await AdminsApi.update(admin.id, { active: !admin.active });
      fetchAll();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  return (
    <div className="shops-container">
      <header className="shops-header">
        <div>
          <h1 className="shops-title">Admins</h1>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            super_admin sees and manages every area. area_admin is bound to exactly one.
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={openCreate}>
          + Add Admin
        </button>
      </header>

      {error && <div className="error-container" style={{ marginBottom: '1.25rem' }}>{error}</div>}

      <section className="shops-table-wrapper">
        <table className="shops-table">
          <thead>
            <tr>
              <th>Username</th>
              <th>Display name</th>
              <th>Role</th>
              <th>Area</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && admins.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem' }}>Loading admins...</td></tr>
            ) : admins.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem' }}>No admins yet.</td></tr>
            ) : (
              admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.username}</td>
                  <td>{a.displayName || a.display_name || '—'}</td>
                  <td><span className="shop-name">{a.role}</span></td>
                  <td>{a.role === 'super_admin' ? 'All areas' : (a.areaCode || a.area_code || a.areaId || a.area_id || '—')}</td>
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
                    <button type="button" className="btn-secondary" onClick={() => openEdit(a)}>Edit</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {drawerOpen && (
        <div className="shop-drawer-overlay" onClick={closeDrawerAttempt} role="presentation">
          <div className="shop-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editingId ? 'Edit admin' : 'Add admin'}>
            <header className="shop-drawer-header">
              <h2>{editingId ? 'Edit admin' : 'Add admin'}</h2>
              <button type="button" className="btn-secondary" onClick={closeDrawerAttempt}>Close</button>
            </header>
            <form onSubmit={submit} className="shop-drawer-body">
              {formError && <div className="error-container" style={{ marginBottom: '0.75rem' }}>{formError}</div>}
              {!editingId && (
                <label className="form-label">
                  Username *
                  <input
                    className="form-input"
                    value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                    required
                  />
                </label>
              )}
              <label className="form-label">
                {editingId ? 'New password (leave blank to keep current)' : 'Password *'}
                <input
                  className="form-input"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="At least 8 characters"
                  required={!editingId}
                />
              </label>
              <label className="form-label">
                Role *
                <select
                  className="form-input"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value, areaId: e.target.value === 'super_admin' ? '' : f.areaId }))}
                >
                  <option value="area_admin">area_admin</option>
                  <option value="super_admin">super_admin</option>
                </select>
              </label>
              {form.role === 'area_admin' && (
                <label className="form-label">
                  Area *
                  <select
                    className="form-input"
                    value={form.areaId}
                    onChange={(e) => setForm((f) => ({ ...f, areaId: e.target.value }))}
                    required
                  >
                    <option value="" disabled>Select an area</option>
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.code})</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="form-label">
                Display name
                <input
                  className="form-input"
                  value={form.displayName}
                  onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                />
              </label>
              <button className="btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add admin'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
