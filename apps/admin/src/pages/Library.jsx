import React, { useState, useEffect, useCallback, useRef } from 'react';
import { LibraryApi, CategoryLibraryApi, StoreModeLibraryApi, CategoriesApi, ImagesApi } from '../api';
import { readList } from '../utils/apiResponse';
import { getUploadedImage, normalizeImageUrl, handleImageError } from '../utils/imageUrl';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import { useStoreModes } from '../hooks/useStoreModes';
import { GENERIC_ERROR } from '../utils/constants';
import './Library.css';

const TABS = [
  { key: 'products', label: 'Products', api: LibraryApi, idField: 'id' },
  { key: 'categories', label: 'Categories', api: CategoryLibraryApi, idField: 'id' },
  { key: 'storeModes', label: 'Store Modes', api: StoreModeLibraryApi, idField: 'id' },
];

// §2.10/§4.7 — one page, three tabs, not three pages. Each tab's row shape
// differs (products carry variants + a suggested price; categories carry a
// type; store modes carry only a slug/label) so the grid renders a handful
// of tab-specific fields, but the create/edit/archive/add-to-area actions
// all funnel through the same three-button pattern.
export default function Library() {
  const { areaId, areas, isSuperAdmin } = useAreaStore() || {};
  const { modes } = useStoreModes();
  const isAllAreas = areaId === 'all';
  const [tab, setTab] = useState('products');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const requestIdRef = useRef(0);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);

  const [addToAreaRow, setAddToAreaRow] = useState(null);
  const [addToAreaMode, setAddToAreaMode] = useState('');
  const [addToAreaCategoryId, setAddToAreaCategoryId] = useState('');
  const [addToAreaPrice, setAddToAreaPrice] = useState('');
  const [addToAreaSaving, setAddToAreaSaving] = useState(false);
  const [addToAreaError, setAddToAreaError] = useState(null);
  const [localCategories, setLocalCategories] = useState([]);
  const addToAreaCategoriesForMode = localCategories.filter((c) => c.type === addToAreaMode);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRows, setBulkRows] = useState({}); // areaId -> { categoryId, price }
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState(null);

  const activeTab = TABS.find((t) => t.key === tab);

  const fetchRows = useCallback(async (requestId = ++requestIdRef.current) => {
    try {
      setLoading(true);
      setError(null);
      const res = await activeTab.api.list({ search });
      if (requestId !== requestIdRef.current) return;
      const nextRows = readList(res);
      setRows(nextRows);
      setSelectedIds((previous) => new Set(
        [...previous].filter((id) => nextRows.some((row) => row.id === id))
      ));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [activeTab, search, tab]);

  useEffect(() => {
    // Invalidate a previous in-flight response immediately, not after the
    // debounce delay, so it cannot repaint rows for an older query.
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => fetchRows(requestId), 250);
    return () => clearTimeout(timer);
  }, [fetchRows]);
  useEffect(() => { setSelectedIds(new Set()); }, [tab]);

  // Categories in the CURRENTLY selected area — needed so "Add to area" for
  // a product can offer a real categoryId. Only products need this.
  useEffect(() => {
    if (tab !== 'products' || isAllAreas) return;
    CategoriesApi.list().then((res) => setLocalCategories(readList(res))).catch(() => setLocalCategories([]));
  }, [tab, isAllAreas, areaId]);

  const rowLabel = (row) => row.name || row.label;
  const rowSlug = (row) => row.slug;

  const openCreate = () => {
    setEditingRow(null);
    setUploadMessage(null);
    if (tab === 'products') {
      setForm({ name: '', description: '', imageId: '', imageUrl: '', suggestedPrice: '', variantPrompt: '', variants: [{ label: '', isDefault: true }] });
    } else if (tab === 'categories') {
      setForm({ name: '', slug: '', type: 'packed', imageId: '', imageUrl: '' });
    } else {
      setForm({ label: '', slug: '', imageId: '', imageUrl: '' });
    }
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEdit = (row) => {
    setEditingRow(row);
    setUploadMessage(null);
    const existingImageId = row.imageId || row.image_id || row.iconImageId || row.icon_image_id || '';
    const existingImageUrl = existingImageId ? `/api/images/${existingImageId}` : '';
    if (tab === 'products') {
      setForm({
        name: row.name, description: row.description || '', imageId: row.imageId || row.image_id || '', imageUrl: existingImageUrl,
        suggestedPrice: row.suggestedPrice ?? row.suggested_price ?? '', variantPrompt: row.variantPrompt || row.variant_prompt || '',
        variants: row.variants || [],
      });
    } else if (tab === 'categories') {
      setForm({ name: row.name, slug: row.slug, type: row.type, imageId: row.imageId || row.image_id || '', imageUrl: existingImageUrl });
    } else {
      setForm({ label: row.label, slug: row.slug, imageId: row.iconImageId || row.icon_image_id || '', imageUrl: existingImageUrl });
    }
    setFormError(null);
    setDrawerOpen(true);
  };

  const uploadImageFile = async (file) => {
    const sizeError = getImageUploadError(file);
    if (sizeError) { setUploadMessage({ type: 'error', text: sizeError }); return; }
    const data = new FormData();
    data.append('image', file);
    try {
      setUploadingImage(true);
      setUploadMessage(null);
      const res = await ImagesApi.upload(data);
      const image = getUploadedImage(res);
      setForm((f) => ({ ...f, imageId: image.id, imageUrl: image.url }));
      setUploadMessage({ type: 'success', text: 'Image uploaded. Save to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: err.message || GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({ type: 'library', defaultAspect: 1, onCropped: uploadImageFile });

  const submit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setFormError(null);
      if (tab === 'products') {
        const payload = {
          name: form.name.trim(),
          description: form.description || null,
          imageId: form.imageId || null,
          suggestedPrice: form.suggestedPrice !== '' ? Number(form.suggestedPrice) : null,
          variantPrompt: form.variantPrompt || null,
          variants: (form.variants || []).filter((v) => v.label && v.label.trim()),
        };
        if (editingRow) await LibraryApi.update(editingRow.id, payload);
        else await LibraryApi.create({ ...payload, status: 'published' });
      } else if (tab === 'categories') {
        const payload = { name: form.name.trim(), slug: form.slug || undefined, type: form.type, imageId: form.imageId || null };
        if (editingRow) await CategoryLibraryApi.update(editingRow.id, payload);
        else await CategoryLibraryApi.create(payload);
      } else {
        const payload = { label: form.label.trim(), slug: form.slug || undefined, iconImageId: form.imageId || null };
        if (editingRow) await StoreModeLibraryApi.update(editingRow.id, payload);
        else await StoreModeLibraryApi.create(payload);
      }
      setDrawerOpen(false);
      fetchRows();
    } catch (err) {
      console.error(err);
      setFormError(err.message || GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const archiveRow = async (row) => {
    if (!window.confirm(`Archive "${rowLabel(row)}"? Areas that already carry it keep their own copy — this only hides it from future "add to area" actions.`)) return;
    try {
      await activeTab.api.archive(row.id);
      fetchRows();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const openAddToArea = (row) => {
    setAddToAreaRow(row);
    setAddToAreaMode(modes[0]?.slug || '');
    setAddToAreaCategoryId('');
    setAddToAreaPrice(row.suggestedPrice ?? row.suggested_price ?? '');
    setAddToAreaError(null);
  };

  const submitAddToArea = async (e) => {
    e.preventDefault();
    try {
      setAddToAreaSaving(true);
      setAddToAreaError(null);
      if (tab === 'products') {
        const categoryId = Number(addToAreaCategoryId);
        if (!Number.isInteger(categoryId) || categoryId <= 0) {
          setAddToAreaError('Pick a category in this area');
          setAddToAreaSaving(false);
          return;
        }
        await LibraryApi.addToArea(addToAreaRow.id, { categoryId, price: addToAreaPrice !== '' ? Number(addToAreaPrice) : undefined });
      } else if (tab === 'categories') {
        await CategoryLibraryApi.addToArea(addToAreaRow.id, {});
      } else {
        await StoreModeLibraryApi.addToArea(addToAreaRow.id, {});
      }
      setAddToAreaRow(null);
      fetchRows();
    } catch (err) {
      console.error(err);
      setAddToAreaError(err.message || GENERIC_ERROR);
    } finally {
      setAddToAreaSaving(false);
    }
  };

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openBulk = () => {
    setBulkRows({});
    setBulkError(null);
    setBulkOpen(true);
  };

  const submitBulk = async (e) => {
    e.preventDefault();
    const areaEntries = Object.entries(bulkRows).filter(([, v]) => v?.categoryId);
    if (areaEntries.length === 0) {
      setBulkError('Enter at least one area’s categoryId');
      return;
    }
    try {
      setBulkSaving(true);
      setBulkError(null);
      const areasPayload = Object.fromEntries(
        areaEntries.map(([areaIdKey, v]) => [areaIdKey, { categoryId: Number(v.categoryId), price: v.price !== '' && v.price != null ? Number(v.price) : undefined }])
      );
      const selectedRows = [...selectedIds].map((id) => ({
        id,
        label: rowLabel(rows.find((row) => row.id === id) || { name: `Product ${id}` }),
      }));
      const results = await Promise.allSettled(
        selectedRows.map(({ id }) => LibraryApi.addToAreas(id, { areas: areasPayload }))
      );
      const failures = results.filter((result) => result.status === 'rejected');
      const succeededIds = selectedRows.filter((_, index) => results[index].status === 'fulfilled');
      const failedSummary = selectedRows
        .filter((_, index) => results[index].status === 'rejected')
        .map(({ label }, index) => `${label}: ${results.filter((result) => result.status === 'rejected')[index].reason?.message || GENERIC_ERROR}`)
        .join('; ');
      setSelectedIds(new Set());
      if (failures.length > 0) {
        setBulkError(`${succeededIds.length} added; ${failures.length} failed. ${failedSummary}`);
        fetchRows();
        return;
      }
      setBulkOpen(false);
      setSelectedIds(new Set());
      fetchRows();
    } catch (err) {
      console.error(err);
      setBulkError(err.message || GENERIC_ERROR);
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <div className="library-container">
      <header className="library-header">
        <div>
          <h1 className="library-title">Library</h1>
          <p className="library-subtitle">
            Author once, add to any area. Editing identity here (name, image, description) updates every
            area that already carries it — price, availability and placement stay per-area.
          </p>
        </div>
        <div className="library-header-actions">
          {tab === 'products' && selectedIds.size > 0 && (
            <button className="btn-secondary" type="button" onClick={openBulk}>
              Add {selectedIds.size} to areas…
            </button>
          )}
          <button className="btn-primary" type="button" onClick={openCreate}>
            + New {activeTab.label.replace(/s$/, '')}
          </button>
        </div>
      </header>

      <div className="library-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`library-tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <input
          className="library-search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <div className="error-container" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div className="library-loading">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="library-loading">Nothing here yet.</div>
      ) : (
        <div className="library-grid">
          {rows.map((row) => {
            const imageUrl = row.imageId || row.image_id ? normalizeImageUrl(`/api/images/${row.imageId || row.image_id}`) : null;
            const iconUrl = row.iconImageId || row.icon_image_id ? normalizeImageUrl(`/api/images/${row.iconImageId || row.icon_image_id}`) : null;
            const areaIds = row.areaIds || row.area_ids || [];
            return (
              <div key={row.id} className={`library-card ${row.archived ? 'archived' : ''}`}>
                {tab === 'products' && (
                  <input
                    type="checkbox"
                    className="library-card-select"
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleSelected(row.id)}
                  />
                )}
                <div className="library-card-image">
                  {(imageUrl || iconUrl) ? (
                    <img src={imageUrl || iconUrl} onError={handleImageError} alt={rowLabel(row)} />
                  ) : (
                    <div className="library-card-image-placeholder">🗂️</div>
                  )}
                </div>
                <div className="library-card-body">
                  <div className="library-card-name">{rowLabel(row)}</div>
                  <div className="library-card-slug">{rowSlug(row)}</div>
                  {tab === 'products' && Array.isArray(row.variants) && row.variants.length > 0 && (
                    <div className="library-card-variants">{row.variants.length} variant{row.variants.length === 1 ? '' : 's'}</div>
                  )}
                  {row.archived && <span className="library-card-badge">Archived</span>}
                  <div className="library-card-areas">
                    {areaIds.length === 0 ? (
                      <span className="library-card-area-empty">Not in any area yet</span>
                    ) : (
                      areaIds.map((id) => {
                        const a = (areas || []).find((ar) => String(ar.id) === String(id));
                        return <span key={id} className="library-card-area-chip">{a ? a.code : `#${id}`}</span>;
                      })
                    )}
                  </div>
                </div>
                <div className="library-card-actions">
                  <button type="button" className="btn-secondary" onClick={() => openEdit(row)}>Edit</button>
                  {!row.archived && (
                    <button type="button" className="btn-secondary" onClick={() => archiveRow(row)}>Archive</button>
                  )}
                  {!row.archived && !isAllAreas && (
                    <button type="button" className="btn-primary" onClick={() => openAddToArea(row)}>
                      Add to area…
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAllAreas && (
        <div style={{ marginTop: '1rem' }}>
          <PickAreaNotice label="Add to area" />
        </div>
      )}

      {drawerOpen && (
        <div className="shop-drawer-overlay" onClick={() => setDrawerOpen(false)} role="presentation">
          <div className="shop-drawer" onClick={(e) => e.stopPropagation()} role="dialog">
            <header className="shop-drawer-header">
              <h2>{editingRow ? 'Edit' : 'New'} {activeTab.label.replace(/s$/, '')}</h2>
              <button type="button" className="btn-secondary" onClick={() => setDrawerOpen(false)}>Close</button>
            </header>
            <form onSubmit={submit} className="shop-drawer-body">
              {formError && <div className="error-container" style={{ marginBottom: '0.75rem' }}>{formError}</div>}

              {tab !== 'storeModes' && (
                <label className="form-label">
                  Name *
                  <input className="form-input" value={form.name || ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
                </label>
              )}
              {tab === 'storeModes' && (
                <label className="form-label">
                  Label *
                  <input className="form-input" value={form.label || ''} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} required />
                </label>
              )}
              {tab !== 'products' && (
                <label className="form-label">
                  Slug (optional — derived from name if blank)
                  <input className="form-input" value={form.slug || ''} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} />
                </label>
              )}
              {tab === 'categories' && (
                <label className="form-label">
                  Type *
                  <input className="form-input" value={form.type || ''} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} required />
                </label>
              )}
              {tab === 'products' && (
                <>
                  <label className="form-label">
                    Description
                    <textarea className="form-input" rows={2} value={form.description || ''} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                  </label>
                  <label className="form-label">
                    Suggested price
                    <input type="number" className="form-input" value={form.suggestedPrice ?? ''} onChange={(e) => setForm((f) => ({ ...f, suggestedPrice: e.target.value }))} />
                  </label>
                  <label className="form-label">
                    Variant prompt
                    <input className="form-input" value={form.variantPrompt || ''} onChange={(e) => setForm((f) => ({ ...f, variantPrompt: e.target.value }))} placeholder="e.g. Choose size" />
                  </label>
                  <div className="form-label">
                    Variants
                    {(form.variants || []).map((v, i) => (
                      <div key={i} className="library-variant-row">
                        <input
                          className="form-input"
                          value={v.label || ''}
                          placeholder="Label, e.g. 500ml"
                          onChange={(e) => setForm((f) => {
                            const variants = [...f.variants];
                            variants[i] = { ...variants[i], label: e.target.value };
                            return { ...f, variants };
                          })}
                        />
                        <button type="button" className="btn-secondary" onClick={() => setForm((f) => ({ ...f, variants: f.variants.filter((_, idx) => idx !== i) }))}>
                          Remove
                        </button>
                      </div>
                    ))}
                    <button type="button" className="btn-secondary" onClick={() => setForm((f) => ({ ...f, variants: [...(f.variants || []), { label: '' }] }))}>
                      + Add variant
                    </button>
                  </div>
                </>
              )}
              <label className="form-label">
                {tab === 'storeModes' ? 'Icon' : 'Image'}
                {form.imageUrl && (
                  <img src={normalizeImageUrl(form.imageUrl)} onError={handleImageError} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, marginBottom: 6 }} />
                )}
                <input type="file" accept="image/*" disabled={uploadingImage} {...fileInputProps} />
                {uploadMessage && <span style={{ fontSize: '0.85rem' }}>{uploadMessage.text}</span>}
              </label>
              <button className="btn-primary" type="submit" disabled={saving || uploadingImage}>
                {saving ? 'Saving…' : editingRow ? 'Save changes' : 'Create'}
              </button>
            </form>
          </div>
        </div>
      )}

      {addToAreaRow && (
        <div className="shop-drawer-overlay" onClick={() => setAddToAreaRow(null)} role="presentation">
          <div className="shop-drawer" onClick={(e) => e.stopPropagation()} role="dialog">
            <header className="shop-drawer-header">
              <h2>Add “{rowLabel(addToAreaRow)}” to the current area</h2>
              <button type="button" className="btn-secondary" onClick={() => setAddToAreaRow(null)}>Close</button>
            </header>
            <form onSubmit={submitAddToArea} className="shop-drawer-body">
              {addToAreaError && <div className="error-container" style={{ marginBottom: '0.75rem' }}>{addToAreaError}</div>}
              {tab === 'products' && (
                <>
                  <label className="form-label">
                    Shop mode *
                    <select
                      className="form-input"
                      value={addToAreaMode}
                      onChange={(e) => { setAddToAreaMode(e.target.value); setAddToAreaCategoryId(''); }}
                      required
                    >
                      <option value="" disabled>Select a shop mode</option>
                      {modes.map((m) => (
                        <option key={m.slug} value={m.slug}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="form-label">
                    Category in this area *
                    <select className="form-input" value={addToAreaCategoryId} onChange={(e) => setAddToAreaCategoryId(e.target.value)} required disabled={!addToAreaMode}>
                      <option value="" disabled>{addToAreaMode ? 'Select a category' : 'Pick a shop mode first'}</option>
                      {addToAreaCategoriesForMode.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    {addToAreaMode && addToAreaCategoriesForMode.length === 0 && (
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        No categories in this area for {modes.find((m) => m.slug === addToAreaMode)?.label || addToAreaMode} yet.
                      </span>
                    )}
                  </label>
                  <label className="form-label">
                    Price
                    <input type="number" className="form-input" value={addToAreaPrice} onChange={(e) => setAddToAreaPrice(e.target.value)} />
                  </label>
                </>
              )}
              {tab !== 'products' && <p>This will link it into the currently selected area.</p>}
              <button className="btn-primary" type="submit" disabled={addToAreaSaving}>
                {addToAreaSaving ? 'Adding…' : 'Add to area'}
              </button>
            </form>
          </div>
        </div>
      )}

      {bulkOpen && (
        <div className="shop-drawer-overlay" onClick={() => setBulkOpen(false)} role="presentation">
          <div className="shop-drawer" onClick={(e) => e.stopPropagation()} role="dialog">
            <header className="shop-drawer-header">
              <h2>Add {selectedIds.size} product{selectedIds.size === 1 ? '' : 's'} to areas…</h2>
              <button type="button" className="btn-secondary" onClick={() => setBulkOpen(false)}>Close</button>
            </header>
            <form onSubmit={submitBulk} className="shop-drawer-body">
              {bulkError && <div className="error-container" style={{ marginBottom: '0.75rem' }}>{bulkError}</div>}
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                Leave an area&apos;s categoryId blank to skip it. categoryId must belong to that area — check
                that area&apos;s Categories page for the id.
              </p>
              {(areas || []).map((a) => (
                <div key={a.id} className="library-bulk-row">
                  <span className="library-bulk-area-name">{a.name} ({a.code})</span>
                  <input
                    className="form-input"
                    type="number"
                    placeholder="categoryId"
                    value={bulkRows[a.id]?.categoryId ?? ''}
                    onChange={(e) => setBulkRows((prev) => ({ ...prev, [a.id]: { ...prev[a.id], categoryId: e.target.value } }))}
                  />
                  <input
                    className="form-input"
                    type="number"
                    placeholder="price"
                    value={bulkRows[a.id]?.price ?? ''}
                    onChange={(e) => setBulkRows((prev) => ({ ...prev, [a.id]: { ...prev[a.id], price: e.target.value } }))}
                  />
                </div>
              ))}
              <button className="btn-primary" type="submit" disabled={bulkSaving}>
                {bulkSaving ? 'Adding…' : 'Add to selected areas'}
              </button>
            </form>
          </div>
        </div>
      )}

      <ImageCropper {...cropperProps} />
    </div>
  );
}
