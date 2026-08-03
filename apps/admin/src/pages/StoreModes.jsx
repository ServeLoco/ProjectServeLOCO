import React, { useState, useEffect, useRef } from 'react';
import { StoreModesApi, ImagesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import { getUploadedImage, normalizeImageUrl, handleImageError } from '../utils/imageUrl';
import { IMAGE_GUIDANCE } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Categories.css';
import './StoreModes.css';

const MODE_ICONS = {
  packed: '📦',
  fast_food: '🍔',
  sweets: '🍬',
  house: '🏠',
};

function modeIcon(slug) {
  return MODE_ICONS[slug] || '🔀';
}

export default function StoreModes() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';

  const [modes, setModes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    // 25.4 — Store Modes can't be shown/managed for "all" areas at once
    // (§2.10); skip the doomed 400 fetch and render the inline notice instead.
    if (isAllAreas) return;
    fetchModes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAllAreas]);

  const fetchModes = async () => {
    try {
      setLoading(true);
      const res = await StoreModesApi.list();
      setModes(readList(res, ['storeModes']));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const setDefault = async (mode) => {
    try {
      setError(null);
      await StoreModesApi.update(mode.id, { is_default: true });
      fetchModes();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const toggleActive = async (mode) => {
    try {
      setError(null);
      await StoreModesApi.update(mode.id, { active: !mode.active });
      fetchModes();
    } catch (err) {
      if (mode.active && /force=true/i.test(err.message || '')) {
        const proceed = window.confirm(
          `${err.message}\n\nHide "${mode.label}" anyway? Items assigned to it will disappear from the customer apps until the mode is re-activated.`
        );
        if (proceed) {
          try {
            await StoreModesApi.update(mode.id, { active: false, force: true });
            fetchModes();
            return;
          } catch (err2) {
            console.error(err2);
            setError(err2.message || GENERIC_ERROR);
            return;
          }
        }
        return;
      }
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const move = async (mode, direction) => {
    const sorted = [...modes].sort((a, b) => a.display_order - b.display_order);
    const idx = sorted.findIndex(m => m.id === mode.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    try {
      setError(null);
      await Promise.all([
        StoreModesApi.update(mode.id, { display_order: other.display_order }),
        StoreModesApi.update(other.id, { display_order: mode.display_order }),
      ]);
      fetchModes();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const sortedModes = [...modes].sort((a, b) => a.display_order - b.display_order);

  if (isAllAreas) {
    return <div className="categories-container"><PickAreaNotice label="Store Modes" /></div>;
  }

  return (
    <div className="categories-container">
      <header className="categories-header">
        <h1 className="categories-title">Store Modes</h1>
        <button type="button" className="btn-primary" onClick={() => setDrawerOpen(true)}>
          + New Mode
        </button>
      </header>

      <p className="store-modes-intro">
        Modes power the <strong>mode-switcher capsule</strong> on the customer app home screen
        (e.g. Packed Items, Fast Food). Add a mode here, then assign categories, products,
        and offers to it from their respective pages.
      </p>

      {error && <div className="error-container" style={{ marginBottom: '2rem' }}>{error}</div>}

      <section className="categories-grid-wrapper">
        {loading && modes.length === 0 ? (
          <div className="categories-state">Loading store modes...</div>
        ) : sortedModes.length === 0 ? (
          <div className="categories-state categories-state-empty">
            <p>No store modes yet.</p>
            <button type="button" className="btn-primary" onClick={() => setDrawerOpen(true)}>
              Create your first mode
            </button>
          </div>
        ) : (
          <div className="store-modes-grid">
            {sortedModes.map((m, idx) => (
              <article
                key={m.id}
                className={`store-mode-card ${m.active ? 'store-mode-card--active' : 'store-mode-card--hidden'}`}
              >
                <div className="store-mode-card-header">
                  <div className="store-mode-card-icon-wrap">
                    {(m.icon_image_url || m.iconImageUrl) ? (
                      <img
                        src={normalizeImageUrl(m.icon_image_url || m.iconImageUrl)}
                        onError={handleImageError}
                        alt=""
                        className="store-mode-card-icon-image"
                      />
                    ) : (
                      <span className="store-mode-card-icon" aria-hidden="true">
                        {modeIcon(m.slug)}
                      </span>
                    )}
                    <div>
                      <span className="store-mode-card-order-badge">#{m.display_order ?? idx + 1}</span>
                      <div className="store-mode-reorder">
                        <button
                          type="button"
                          className="btn-table-action"
                          disabled={idx === 0}
                          onClick={() => move(m, -1)}
                          aria-label={`Move ${m.label} up`}
                          title="Move up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-table-action"
                          disabled={idx === sortedModes.length - 1}
                          onClick={() => move(m, 1)}
                          aria-label={`Move ${m.label} down`}
                          title="Move down"
                        >
                          ↓
                        </button>
                      </div>
                    </div>
                  </div>
                  <span className={`store-mode-card-status ${m.active ? 'is-active' : 'is-hidden'}`}>
                    {m.active ? 'Active' : 'Hidden'}
                  </span>
                </div>

                <div className="store-mode-card-body">
                  <h2 className="store-mode-card-name">{m.label}</h2>
                  <p className="store-mode-card-slug">{m.slug}</p>
                  <div className="store-mode-card-meta">
                    {m.is_system ? (
                      <span className="store-mode-system-badge">System mode</span>
                    ) : (
                      <span className="store-mode-system-badge">Custom mode</span>
                    )}
                    <span className="category-card-order">Display order {m.display_order ?? 0}</span>
                    {(m.is_default || m.isDefault) ? (
                      <span className="store-mode-default-badge">Opens by default</span>
                    ) : null}
                  </div>
                  {m.is_system && m.active ? (
                    <p className="store-mode-card-hint">Built-in mode — cannot be hidden while active.</p>
                  ) : null}
                </div>

                <StoreModeCardFooter
                  mode={m}
                  onToggle={() => toggleActive(m)}
                  onSetDefault={() => setDefault(m)}
                  onSaved={fetchModes}
                />
              </article>
            ))}
          </div>
        )}
      </section>

      {drawerOpen && (
        <NewModeDrawer onClose={() => setDrawerOpen(false)} onSave={() => { setDrawerOpen(false); fetchModes(); }} />
      )}
    </div>
  );
}

function StoreModeCardFooter({ mode, onToggle, onSetDefault, onSaved }) {
  const [editing, setEditing] = useState(false);
  const isDefault = mode.is_default || mode.isDefault;

  return (
    <div className={`store-mode-card-footer ${editing ? 'is-editing' : ''}`}>
      {!editing ? (
        <>
          <button
            type="button"
            className={`availability-toggle ${mode.active ? 'in-stock' : 'out-of-stock'}`}
            onClick={onToggle}
            disabled={mode.is_system && mode.active}
            title={mode.is_system && mode.active ? 'System modes cannot be deactivated' : ''}
          >
            {mode.active ? 'Active' : 'Hidden'}
          </button>
          {mode.active && !isDefault ? (
            <button type="button" className="action-link" onClick={onSetDefault}>
              Set as default
            </button>
          ) : null}
          <button type="button" className="action-link" onClick={() => setEditing(true)}>
            Edit
          </button>
        </>
      ) : (
        <EditModeForm
          mode={mode}
          onSaved={() => { setEditing(false); onSaved(); }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function EditModeForm({ mode, onSaved, onCancel }) {
  const [label, setLabel] = useState(mode.label);
  const [iconImageId, setIconImageId] = useState(mode.icon_image_id || '');
  const [iconImageUrl, setIconImageUrl] = useState(mode.icon_image_url || mode.iconImageUrl || '');
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }
    const data = new FormData();
    data.append('image', file);
    const previousPendingId = iconImageId;

    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setIconImageId(image.id);
      setIconImageUrl(image.url);
      if (previousPendingId && previousPendingId !== mode.icon_image_id) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'Image uploaded. Save to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err.message || GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'storeMode',
    defaultAspect: 1,
    onCropped: uploadImageFile,
  });

  const save = async () => {
    try {
      setSaving(true);
      setError(null);
      await StoreModesApi.update(mode.id, { label, icon_image_id: iconImageId || null });
      onSaved();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
      setSaving(false);
    }
  };

  return (
    <div className="store-mode-edit-form">
      <p className="image-dimension-hint">{IMAGE_GUIDANCE.storeMode.label}</p>
      <div className="store-mode-edit-image-row">
        {iconImageUrl ? (
          <img
            src={normalizeImageUrl(iconImageUrl)}
            onError={handleImageError}
            alt=""
            className="store-mode-edit-image-preview"
          />
        ) : null}
        <div
          className="image-upload-zone store-mode-edit-image-upload"
          onClick={() => fileInputRef.current?.click()}
        >
          <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
          {uploadingImage ? 'Uploading...' : iconImageUrl ? 'Change icon' : 'Upload icon'}
        </div>
      </div>
      {uploadMessage && (
        <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>
      )}

      <div className="store-mode-rename-form">
        <input
          className="form-input"
          value={label}
          onChange={e => setLabel(e.target.value)}
          disabled={saving}
          aria-label={`Rename ${mode.label}`}
        />
        <button type="button" className="action-link" onClick={save} disabled={saving || uploadingImage}>Save</button>
        <button type="button" className="action-link" onClick={() => { onCancel(); setError(null); }} disabled={saving}>
          Cancel
        </button>
        {error && <span className="store-mode-rename-error">{error}</span>}
      </div>

      <ImageCropper {...cropperProps} />
    </div>
  );
}

function NewModeDrawer({ onClose, onSave }) {
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [iconImageId, setIconImageId] = useState('');
  const [iconImageUrl, setIconImageUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);
  const [formError, setFormError] = useState(null);
  const fileInputRef = useRef(null);

  // Always starts blank (new mode only) — dirty means the admin typed
  // something. Don't silently drop it on an accidental overlay click.
  const isDirty = Boolean(slug || label || iconImageId);
  const handleCloseAttempt = () => {
    if (isDirty && !window.confirm('Discard this new store mode?')) return;
    onClose();
  };

  const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  const handleLabelChange = (value) => {
    setLabel(value);
    setSlug(prev => (prev === slugify(label) || prev === '' ? slugify(value) : prev));
  };

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }
    const data = new FormData();
    data.append('image', file);
    const previousPendingId = iconImageId;

    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setIconImageId(image.id);
      setIconImageUrl(image.url);
      if (previousPendingId) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'Image uploaded. Create the mode to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err.message || GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'storeMode',
    defaultAspect: 1,
    onCropped: uploadImageFile,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setFormError(null);
      setSaving(true);
      await StoreModesApi.create({ slug, label, icon_image_id: iconImageId || null });
      onSave();
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
            <h3 className="drawer-title">New Store Mode</h3>
            <button type="button" className="drawer-close" onClick={handleCloseAttempt}>&times;</button>
          </div>

          <div className="drawer-body">
            {formError && <div className="error-container" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <div className="form-group">
              <label className="form-label">Label (shown to customers)</label>
              <input required type="text" className="form-input" value={label} onChange={e => handleLabelChange(e.target.value)} placeholder="e.g. Bakery" />
            </div>
            <div className="form-group">
              <label className="form-label">Slug (internal, permanent)</label>
              <input required type="text" className="form-input" value={slug} onChange={e => setSlug(slugify(e.target.value))} placeholder="e.g. bakery" />
              <p className="image-dimension-hint">Lowercase letters, numbers, underscores only. Cannot be changed after creation.</p>
            </div>
            <div className="form-group">
              <label className="form-label">Mode Icon (optional)</label>
              <p className="image-dimension-hint">{IMAGE_GUIDANCE.storeMode.label} Leave empty to use a built-in icon.</p>
              <div className="store-mode-edit-image-row">
                {iconImageUrl ? (
                  <img
                    src={normalizeImageUrl(iconImageUrl)}
                    onError={handleImageError}
                    alt=""
                    className="store-mode-edit-image-preview"
                  />
                ) : null}
                <div
                  className="image-upload-zone store-mode-edit-image-upload"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
                  {uploadingImage ? 'Uploading...' : iconImageUrl ? 'Change icon' : 'Click to Upload Icon'}
                </div>
              </div>
              {uploadMessage && (
                <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>
              )}
            </div>
          </div>

          <div className="drawer-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving || uploadingImage}>
              {saving ? 'Saving...' : 'Create Mode'}
            </button>
          </div>
        </form>
        <ImageCropper {...cropperProps} />
      </div>
    </div>
  );
}