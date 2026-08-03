import React, { useState, useEffect, useRef } from 'react';
import { OffersApi, ImagesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { getUploadedImage, normalizeImageUrl, FALLBACK_IMAGE, handleImageError } from '../utils/imageUrl';
import OfferProductsPanel from '../components/OfferProductsPanel';
import { IMAGE_GUIDANCE } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import { useStoreModes } from '../hooks/useStoreModes';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import './Offers.css';

import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';

export default function Offers() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const { modes } = useStoreModes();
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState(null);
  const [storeType, setStoreType] = useState('packed');

  // 25.4 — Offers can't be managed for "all" areas at once (the API 400s);
  // skip the doomed fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    fetchOffers();
  }, [storeType, isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchOffers = async () => {
    try {
      setLoading(true);
      const res = await OffersApi.list({ store_type: storeType });
      setOffers(readList(res, ['offers']));
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const openCreateDrawer = () => {
    setEditingOffer(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (offer) => {
    setEditingOffer(offer);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingOffer(null);
  };

  const toggleActive = async (offer) => {
    try {
      await OffersApi.update(offer.id, {
        ...offer,
        active: !offer.active,
        imageId: offer.image_id,
        image_id: offer.image_id,
      });
      fetchOffers();
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    }
  };

  if (isAllAreas) {
    return <div className="offers-container"><PickAreaNotice label="Offers" /></div>;
  }

  return (
    <div className="offers-container">
      <header className="offers-header">
        <h1 className="offers-title">Offers Management</h1>
        <button className="btn-primary" onClick={openCreateDrawer}>
          + New Offer
        </button>
      </header>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
        {modes.map(m => (
          <button
            key={m.slug}
            className={`btn-secondary ${storeType === m.slug ? 'active' : ''}`}
            style={storeType === m.slug ? { background: 'var(--primary-color)', color: 'white', borderColor: 'var(--primary-color)' } : {}}
            onClick={() => setStoreType(m.slug)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {error && <div className="error-container" style={{ marginBottom: '2rem' }}>{error}</div>}

      {loading && offers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading offers...</div>
      ) : offers.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', background: 'var(--surface-color)', borderRadius: 'var(--radius-lg)' }}>
          No offers found. Create one to feature it on the app!
        </div>
      ) : (
        <section className="offers-grid">
          {offers.map(o => (
            <div key={o.id} className="offer-card">
              <img src={normalizeImageUrl(o.imageUrl || o.image_url) || FALLBACK_IMAGE} onError={handleImageError} alt={o.title} className="offer-image" />
              <div className="offer-content">
                <h3 className="offer-title">{o.title}</h3>
                <p className="offer-description">{o.description}</p>
                <div className="offer-footer">
                  <span className={`offer-status ${o.active ? 'active' : 'inactive'}`}>
                    {o.active ? 'Active' : 'Inactive'}
                  </span>
                  <span className="offer-status" style={{ background: 'var(--surface-color)', color: 'var(--text-secondary)' }}>
                    {o.isClickable ? 'Clickable' : 'Image only'}
                  </span>
                  <div className="offer-actions">
                    <button className="btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }} onClick={() => toggleActive(o)}>
                      {o.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button className="btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }} onClick={() => openEditDrawer(o)}>
                      Edit
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {drawerOpen && (
        <OfferFormDrawer 
          offer={editingOffer} 
          currentMode={storeType}
          onClose={closeDrawer} 
          onSave={() => { closeDrawer(); fetchOffers(); }}
        />
      )}
    </div>
  );
}

function OfferFormDrawer({ offer, currentMode, onClose, onSave }) {
  const { modes } = useStoreModes();
  const isEdit = !!offer;
  const [formData, setFormData] = useState(offer || {
    title: '',
    description: '',
    image_id: '',
    image_url: '',
    active: false,
    is_clickable: Boolean(offer?.isClickable || offer?.is_clickable),
    store_type: offer?.store_type || currentMode || 'packed'
  });
  
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);
  const fileInputRef = useRef(null);

  // Snapshot the first render's formData so an accidental overlay click can
  // be told apart from a real "I'm done" close — don't silently drop edits.
  const initialFormDataRef = useRef(null);
  if (initialFormDataRef.current === null) {
    initialFormDataRef.current = formData;
  }
  const isDirty = JSON.stringify(formData) !== JSON.stringify(initialFormDataRef.current);
  const handleCloseAttempt = () => {
    if (isDirty && !window.confirm('Discard unsaved changes to this offer?')) return;
    onClose();
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) {
      setUploadMessage({ type: 'error', text: sizeError });
      return;
    }

    const data = new FormData();
    data.append('image', file);
    const previousPendingId = formData.image_id;

    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setFormData(prev => ({
        ...prev,
        image_id: image.id,
        image_url: image.url,
      }));
      // Discard the previous unsaved upload from this session so re-picking a
      // photo before hitting Save doesn't leak an orphaned S3 object.
      if (previousPendingId && previousPendingId !== offer?.image_id) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'Image uploaded. Save the offer to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'offer',
    defaultAspect: 2,
    onCropped: uploadImageFile,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setFormError(null);
      setSaving(true);
      const payload = {
        ...formData,
        imageId: formData.image_id,
        image_id: formData.image_id,
      };
      if (isEdit) {
        await OffersApi.update(offer.id, payload);
      } else {
        await OffersApi.create(payload);
      }
      onSave();
    } catch (err) {
      console.error(err);
      setFormError(GENERIC_ERROR);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this offer permanently?')) return;
    try {
      setFormError(null);
      setSaving(true);
      await OffersApi.delete(offer.id);
      onSave();
    } catch (err) {
      console.error(err);
      setFormError(GENERIC_ERROR);
      setSaving(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={handleCloseAttempt}>
      <div className="drawer-content" onClick={e => e.stopPropagation()}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="drawer-header">
            <h3 className="drawer-title">{isEdit ? 'Edit Offer' : 'New Offer'}</h3>
            <button type="button" className="drawer-close" onClick={handleCloseAttempt}>&times;</button>
          </div>
          
          <div className="drawer-body">
            {formError && <div className="error-container" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <div className="form-group">
              <label className="form-label">Offer Title</label>
              <input required type="text" name="title" className="form-input" value={formData.title} onChange={handleChange} />
            </div>

            <div className="form-group">
              <label className="form-label">Offer Mode</label>
              <select required name="store_type" className="form-select" value={formData.store_type} onChange={handleChange}>
                {modes.map(m => <option key={m.slug} value={m.slug}>{m.label}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <textarea name="description" className="form-textarea" value={formData.description || ''} onChange={handleChange} />
            </div>

            <div className="form-group">
              <label className="form-label">Offer Image / Banner</label>
              <p className="image-dimension-hint">{IMAGE_GUIDANCE.offerBanner.label}</p>
              {(formData.image_url || formData.imageUrl) && <img src={normalizeImageUrl(formData.image_url || formData.imageUrl)} alt="Preview" className="image-preview" />}
              <div className="image-upload-zone" onClick={() => fileInputRef.current?.click()}>
                <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
                {uploadingImage ? 'Uploading...' : 'Click to Upload Image'}
              </div>
              {uploadMessage && (
                <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>
              )}
            </div>

            <div className="form-group" style={{ marginTop: '1rem' }}>
              <label className="checkbox-label" style={{ padding: '1rem', background: 'var(--bg-color)', borderRadius: 'var(--radius-md)', marginBottom: '0.5rem' }}>
                <input type="checkbox" name="active" checked={Boolean(formData.active)} onChange={handleChange} />
                Activate this offer
              </label>
              <label className="checkbox-label" style={{ padding: '1rem', background: 'var(--bg-color)', borderRadius: 'var(--radius-md)' }}>
                <input type="checkbox" name="is_clickable" checked={Boolean(formData.is_clickable)} onChange={handleChange} />
                Banner is clickable
              </label>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                Multiple active offers can stay live in the same mode. Add them to the Mobile Dashboard offer banner section to rotate them on the customer app.
              </p>
            </div>

            {isEdit && (
              formData.is_clickable ? (
                <OfferProductsPanel offer={offer} />
              ) : (
                <div style={{ marginTop: '2rem', padding: '1rem', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Enable "Banner is clickable" to attach products to this offer.
                </div>
              )
            )}
          </div>

          <div className="drawer-footer">
            {isEdit && (
              <button type="button" className="action-link danger" onClick={handleDelete} disabled={saving} style={{ marginRight: 'auto' }}>
                Delete Offer
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving || uploadingImage}>
              {saving ? 'Saving...' : 'Save Offer'}
            </button>
          </div>
        </form>
      </div>
      <ImageCropper {...cropperProps} />
    </div>
  );
}
