import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AreasApi, ImagesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { getUploadedImage, normalizeImageUrl, handleImageError } from '../utils/imageUrl';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import { GENERIC_ERROR } from '../utils/constants';
import './Shops.css';

const EMPTY_FORM = { code: '', name: '', timezone: 'Asia/Kolkata', brandColor: '#4f46e5', logoImageId: '', logoUrl: '', features: '{}' };

export default function Areas() {
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await AreasApi.list();
      setAreas(readList(res));
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
    setUploadMessage(null);
    initialFormRef.current = EMPTY_FORM;
    setDrawerOpen(true);
  };

  const openEdit = (area) => {
    const next = {
      code: area.code,
      name: area.name,
      timezone: area.timezone || 'Asia/Kolkata',
      brandColor: area.brandColor || area.brand_color || '#4f46e5',
      logoImageId: area.logoImageId || area.logo_image_id || '',
      logoUrl: (area.logoImageId || area.logo_image_id) ? `/api/images/${area.logoImageId || area.logo_image_id}` : '',
      features: JSON.stringify(area.features || {}, null, 2),
    };
    setEditingId(area.id);
    setForm(next);
    setFormError(null);
    setUploadMessage(null);
    initialFormRef.current = next;
    setDrawerOpen(true);
  };

  const closeDrawerAttempt = () => {
    const isDirty = JSON.stringify(form) !== JSON.stringify(initialFormRef.current);
    if (isDirty && !window.confirm('Discard unsaved changes to this area?')) return;
    setDrawerOpen(false);
  };

  const uploadLogoFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }
    const data = new FormData();
    data.append('image', file);
    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setForm((f) => ({ ...f, logoImageId: image.id, logoUrl: image.url }));
      setUploadMessage({ type: 'success', text: 'Logo uploaded. Save the area to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err.message || GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'area-logo',
    defaultAspect: 1,
    onCropped: uploadLogoFile,
  });

  const submit = async (e) => {
    e.preventDefault();
    let features;
    try {
      features = form.features.trim() ? JSON.parse(form.features) : null;
    } catch (_) {
      setFormError('Feature toggles must be valid JSON, e.g. {"betaCheckout": true}');
      return;
    }
    try {
      setSaving(true);
      setFormError(null);
      const payload = {
        name: form.name.trim(),
        timezone: form.timezone,
        brandColor: form.brandColor,
        logoImageId: form.logoImageId || null,
        features,
      };
      if (editingId) {
        await AreasApi.update(editingId, payload);
      } else {
        await AreasApi.create({ ...payload, code: form.code.trim() });
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

  const toggleActive = async (area) => {
    try {
      setError(null);
      await AreasApi.update(area.id, { active: !area.active });
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
          <h1 className="shops-title">Areas</h1>
          <p style={{ margin: '0.35rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Each area runs its own shops, riders, catalog and settings. Deactivate instead of deleting —
            area deletion is never supported.
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={openCreate}>
          + New Area
        </button>
      </header>

      {error && <div className="error-container" style={{ marginBottom: '1.25rem' }}>{error}</div>}

      <section className="shops-table-wrapper">
        <table className="shops-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Brand</th>
              <th>Default</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && areas.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem' }}>Loading areas...</td></tr>
            ) : areas.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: '2rem' }}>No areas yet.</td></tr>
            ) : (
              areas.map((a) => (
                <tr key={a.id}>
                  <td><span className="shop-name">{a.code}</span></td>
                  <td>{a.name}</td>
                  <td>
                    <span
                      style={{
                        display: 'inline-block', width: 18, height: 18, borderRadius: 4,
                        background: a.brandColor || a.brand_color || '#ccc', border: '1px solid var(--border-color)',
                        verticalAlign: 'middle', marginRight: 6,
                      }}
                    />
                    {a.brandColor || a.brand_color || '—'}
                  </td>
                  <td>{a.isDefault || a.is_default ? '✓' : ''}</td>
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
          <div className="shop-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={editingId ? 'Edit area' : 'New area'}>
            <header className="shop-drawer-header">
              <h2>{editingId ? 'Edit area' : 'New area'}</h2>
              <button type="button" className="btn-secondary" onClick={closeDrawerAttempt}>Close</button>
            </header>
            <form onSubmit={submit} className="shop-drawer-body">
              {formError && <div className="error-container" style={{ marginBottom: '0.75rem' }}>{formError}</div>}
              {!editingId && (
                <label className="form-label">
                  Code *
                  <input
                    className="form-input"
                    value={form.code}
                    onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                    placeholder="e.g. A2"
                    required
                  />
                </label>
              )}
              <label className="form-label">
                Name *
                <input
                  className="form-input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                />
              </label>
              <label className="form-label">
                Timezone
                <input
                  className="form-input"
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                />
              </label>
              <label className="form-label">
                Brand colour
                <input
                  type="color"
                  className="form-input"
                  style={{ height: 42, padding: 4 }}
                  value={form.brandColor}
                  onChange={(e) => setForm((f) => ({ ...f, brandColor: e.target.value }))}
                />
              </label>
              <label className="form-label">
                Logo
                {(form.logoUrl) && (
                  <img
                    src={normalizeImageUrl(form.logoUrl)}
                    onError={handleImageError}
                    alt="Area logo"
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, marginBottom: 6 }}
                  />
                )}
                <input type="file" accept="image/*" disabled={uploadingImage} {...fileInputProps} />
                {uploadMessage && (
                  <span style={{ color: uploadMessage.type === 'error' ? 'var(--danger-color, red)' : 'var(--success-color, green)', fontSize: '0.85rem' }}>
                    {uploadMessage.text}
                  </span>
                )}
              </label>
              <label className="form-label">
                Feature toggles (JSON)
                <textarea
                  className="form-input"
                  rows={4}
                  value={form.features}
                  onChange={(e) => setForm((f) => ({ ...f, features: e.target.value }))}
                  placeholder={'{\n  "betaCheckout": true\n}'}
                />
              </label>
              <button className="btn-primary" type="submit" disabled={saving || uploadingImage}>
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create area'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ImageCropper {...cropperProps} />
    </div>
  );
}
