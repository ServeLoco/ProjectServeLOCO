import React, { useState, useEffect, useRef, useMemo } from 'react';
import { CategoriesApi, ImagesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { getUploadedImage, normalizeImageUrl, FALLBACK_IMAGE, handleImageError } from '../utils/imageUrl';
import { IMAGE_GUIDANCE } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import { useStoreModes, modeLabel } from '../hooks/useStoreModes';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import './Categories.css';

import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';

export default function Categories() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const { modes } = useStoreModes();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);

  // 25.4 — Categories can't be managed for "all" areas at once (the API
  // 400s); skip the doomed fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    fetchCategories();
  }, [isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCategories = async () => {
    try {
      setLoading(true);
      const res = await CategoriesApi.list();
      setCategories(readList(res, ['categories']));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const openCreateDrawer = () => {
    setEditingCategory(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (category) => {
    setEditingCategory(category);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingCategory(null);
  };

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)),
    [categories],
  );

  const toggleActive = async (category) => {
    try {
      // Send the full category payload — backend uses PUT semantics, so omitting
      // fields (description in particular) would wipe them on every toggle.
      await CategoriesApi.update(category.id, {
        name: category.name,
        slug: category.slug,
        type: category.type,
        description: category.description ?? '',
        imageId: category.image_id,
        image_id: category.image_id,
        active: !category.active,
        displayOrder: category.display_order,
        display_order: category.display_order,
      });
      fetchCategories();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  if (isAllAreas) {
    return <div className="categories-container"><PickAreaNotice label="Categories" /></div>;
  }

  return (
    <div className="categories-container">
      <header className="categories-header">
        <h1 className="categories-title">Categories Management</h1>
        <button className="btn-primary" onClick={openCreateDrawer}>
          + New Category
        </button>
      </header>

      {error && <div className="error-container" style={{ marginBottom: '2rem' }}>{error}</div>}

      <section className="categories-grid-wrapper">
        {loading && categories.length === 0 ? (
          <div className="categories-state">Loading categories...</div>
        ) : categories.length === 0 ? (
          <div className="categories-state categories-state-empty">
            <p>No categories yet.</p>
            <button type="button" className="btn-primary" onClick={openCreateDrawer}>
              Create your first category
            </button>
          </div>
        ) : (
          <div className="categories-grid">
            {sortedCategories.map((c) => (
              <article
                key={c.id}
                className={`category-card ${c.active ? 'category-card--active' : 'category-card--hidden'}`}
              >
                <div className="category-card-media">
                  <img
                    src={normalizeImageUrl(c.imageUrl || c.image_url) || FALLBACK_IMAGE}
                    onError={handleImageError}
                    alt={c.name}
                    className="category-card-image"
                    loading="lazy"
                  />
                  <span className={`category-card-status ${c.active ? 'is-active' : 'is-hidden'}`}>
                    {c.active ? 'Active' : 'Hidden'}
                  </span>
                </div>

                <div className="category-card-body">
                  <h2 className="category-card-name">{c.name}</h2>
                  <p className="category-card-slug">/{c.slug}</p>
                  {c.description ? (
                    <p className="category-card-desc">{c.description}</p>
                  ) : null}
                  <div className="category-card-meta">
                    <span className="category-type">{modeLabel(modes, c.type)}</span>
                    <span className="category-card-order">Order {c.display_order ?? 0}</span>
                  </div>
                </div>

                <div className="category-card-footer">
                  <button
                    type="button"
                    className={`availability-toggle ${c.active ? 'in-stock' : 'out-of-stock'}`}
                    onClick={() => toggleActive(c)}
                  >
                    {c.active ? 'Active' : 'Hidden'}
                  </button>
                  <button type="button" className="action-link" onClick={() => openEditDrawer(c)}>
                    Edit
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {drawerOpen && (
        <CategoryFormDrawer 
          category={editingCategory} 
          onClose={closeDrawer} 
          onSave={() => { closeDrawer(); fetchCategories(); }}
        />
      )}
    </div>
  );
}

function CategoryFormDrawer({ category, onClose, onSave }) {
  const { modes } = useStoreModes();
  const isEdit = !!category;
  const [formData, setFormData] = useState(category || {
    name: '',
    slug: '',
    description: '',
    type: 'packed',
    display_order: 0,
    active: true,
    image_id: '',
    image_url: ''
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
    if (isDirty && !window.confirm('Discard unsaved changes to this category?')) return;
    onClose();
  };

  const generateSlug = (name) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => {
      const updates = { [name]: type === 'checkbox' ? checked : value };
      if (name === 'name' && !isEdit && !prev.slug_manually_edited) {
        updates.slug = generateSlug(value);
      }
      if (name === 'slug') {
        updates.slug_manually_edited = true;
      }
      return { ...prev, ...updates };
    });
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
      if (previousPendingId && previousPendingId !== category?.image_id) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'Image uploaded. Save the category to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err.message || GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'category',
    defaultAspect: 0.9,
    onCropped: uploadImageFile,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isEdit && category.type && formData.type !== category.type) {
      const fromLabel = modes.find(m => m.slug === category.type)?.label || category.type;
      const toLabel = modes.find(m => m.slug === formData.type)?.label || formData.type;
      const proceed = window.confirm(
        `Changing "${category.name}" from ${fromLabel} to ${toLabel} moves EVERY product in this category to ${toLabel} too. Continue?`
      );
      if (!proceed) return;
    }
    try {
      setFormError(null);
      setSaving(true);
      const payload = {
        ...formData,
        display_order: Number(formData.display_order) || 0,
        displayOrder: Number(formData.display_order) || 0,
        imageId: formData.image_id,
        image_id: formData.image_id,
      };

      if (isEdit) {
        await CategoriesApi.update(category.id, payload);
      } else {
        await CategoriesApi.create(payload);
      }
      onSave();
    } catch (err) {
      console.error(err);
      setFormError(err.message || GENERIC_ERROR);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this category? This will fail if products are still assigned to it.')) return;
    try {
      setFormError(null);
      setSaving(true);
      await CategoriesApi.delete(category.id);
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
            <h3 className="drawer-title">{isEdit ? 'Edit Category' : 'New Category'}</h3>
            <button type="button" className="drawer-close" onClick={handleCloseAttempt}>&times;</button>
          </div>
          
          <div className="drawer-body">
            {formError && <div className="error-container" style={{ marginBottom: '1rem' }}>{formError}</div>}
            <div className="form-group">
              <label className="form-label">Category Name</label>
              <input required type="text" name="name" className="form-input" value={formData.name} onChange={handleChange} />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Slug (URL friendly)</label>
                <input required type="text" name="slug" className="form-input" value={formData.slug} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label className="form-label">Type</label>
                <select required name="type" className="form-select" value={formData.type} onChange={handleChange}>
                  {modes.map(m => <option key={m.slug} value={m.slug}>{m.label}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <textarea name="description" className="form-textarea" value={formData.description || ''} onChange={handleChange} />
            </div>

            <div className="form-group">
              <label className="form-label">Category Image</label>
              <p className="image-dimension-hint">{IMAGE_GUIDANCE.category.label}</p>
              {(formData.image_url || formData.imageUrl) && <img src={normalizeImageUrl(formData.image_url || formData.imageUrl)} alt="Preview" className="image-preview" />}
              <div className="image-upload-zone" onClick={() => fileInputRef.current?.click()}>
                <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" />
                {uploadingImage ? 'Uploading...' : 'Click to Upload Image'}
              </div>
              {uploadMessage && (
                <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>
              )}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Display Order</label>
                <input type="number" min="0" step="1" name="display_order" className="form-input" value={formData.display_order} onChange={handleChange} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: '0.75rem' }}>
                <label className="checkbox-label">
                  <input type="checkbox" name="active" checked={formData.active} onChange={handleChange} />
                  Active / Visible
                </label>
              </div>
            </div>
          </div>

          <div className="drawer-footer">
            {isEdit && (
              <button type="button" className="action-link danger" onClick={handleDelete} disabled={saving} style={{ marginRight: 'auto' }}>
                Delete
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving || uploadingImage}>
              {saving ? 'Saving...' : 'Save Category'}
            </button>
          </div>
        </form>
      </div>
      <ImageCropper {...cropperProps} />
    </div>
  );
}
