import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ProductsApi, CategoriesApi, ImagesApi, ShopsApi, LibraryApi } from '../api';
import { readList } from '../utils/apiResponse';
import { getUploadedImage, normalizeImageUrl, FALLBACK_IMAGE, handleImageError } from '../utils/imageUrl';
import { useAdminRefresh } from '../hooks/useAdminRefresh';
import { IMAGE_GUIDANCE, isWithinTimeWindow, formatTimeWindow } from '../utils/imageGuidance';
import { getImageUploadError } from '../utils/fileValidation';
import { useImageCropper } from '../hooks/useImageCropper';
import { useStoreModes } from '../hooks/useStoreModes';
import ImageCropper from '../components/ImageCropper/ImageCropper';
import MessageBanner from '../components/MessageBanner';
import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Products.css';

export default function Products() {
  const navigate = useNavigate();
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const { modes } = useStoreModes();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [shops, setShops] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [filters, setFilters] = useState({
    search: '',
    category_id: '',
    shop_id: '',
    available: '',
    featured: '',
    is_combo: '0',
    type: 'packed'
  });

  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkCategoryId, setBulkCategoryId] = useState('');
  const [bulkShopId, setBulkShopId] = useState('');
  // Inline delete confirmation state
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);

  // 25.4 — Products can't be listed/managed for "all" areas at once (the
  // API 400s); skip the doomed fetches and render the inline notice instead
  // of a generic "something went wrong" error.
  useEffect(() => {
    if (isAllAreas) return;
    fetchCategories();
    fetchShops();
  }, [isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  const paginationRef = useRef({ page: 1 });
  useEffect(() => { paginationRef.current = pagination; }, [pagination]);
  useAdminRefresh(() => { if (!isAllAreas) fetchProducts(paginationRef.current.page); });

  useEffect(() => {
    if (isAllAreas) return;
    const timer = setTimeout(() => fetchProducts(1), 500);
    return () => clearTimeout(timer);
  }, [filters, isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCategories = async () => {
    try {
      const res = await CategoriesApi.list();
      setCategories(res.data || []);
    } catch (err) {
      console.error('Failed to load categories', err);
    }
  };

  const fetchShops = async () => {
    try {
      const res = await ShopsApi.list();
      setShops(res.shops || []);
    } catch (err) {
      console.error('Failed to load shops', err);
    }
  };

  const readProducts = (res) => readList(res, ['products']);

  const fetchProducts = async (page = 1) => {
    try {
      setLoading(true);
      setError(null);
      const params = { page, limit: 20, ...filters };
      Object.keys(params).forEach(k => !params[k] && params[k] !== false && delete params[k]);
      const res = await ProductsApi.list(params);
      setProducts(readProducts(res));
      if (res.pagination) setPagination(res.pagination);
      setSelectedIds([]);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const toggleSelection = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const selectAll = () => {
    if (selectedIds.length === products.length) setSelectedIds([]);
    else setSelectedIds(products.map(p => p.id));
  };

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    const t = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(t);
  };

  const toggleAvailability = async (product) => {
    const newStatus = !product.available;
    try {
      await ProductsApi.updateAvailability(product.id, newStatus);
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, available: newStatus } : p));
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    }
  };

  const toggleVariantAvailability = async (product, variant) => {
    const newStatus = !variant.available;
    try {
      await ProductsApi.updateVariantAvailability(product.id, variant.id, newStatus);
      setProducts(prev => prev.map(p => (
        p.id === product.id
          ? { ...p, variants: p.variants.map(v => v.id === variant.id ? { ...v, available: newStatus } : v) }
          : p
      )));
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    }
  };

  // Generic bulk action using the new batch APIs
  const runBulkUpdate = async (updates, successLabel) => {
    setBulkUpdating(true);
    setError(null);
    try {
      const res = await ProductsApi.bulkUpdate(selectedIds, updates);
      const msg = res.skipped > 0
        ? `${res.updated} products updated. ${res.skipped} skipped (already deleted).`
        : `${res.updated} products ${successLabel}.`;
      showSuccess(msg);
      fetchProducts(pagination.page);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleBulkAvailability = (available) =>
    runBulkUpdate({ available }, available ? 'marked in stock' : 'marked out of stock');

  const handleBulkFeatured = (featured) =>
    runBulkUpdate({ featured }, featured ? 'marked as featured' : 'removed from featured');

  const handleBulkMoveCategory = async () => {
    if (!bulkCategoryId) return;
    await runBulkUpdate({ category_id: Number(bulkCategoryId) }, 'moved to category');
    setBulkCategoryId('');
  };

  const handleBulkAssignShop = async () => {
    if (bulkShopId === '') return;
    const label = bulkShopId === '0' ? 'unassigned from shop' : 'assigned to shop';
    await runBulkUpdate({ shop_id: Number(bulkShopId) }, label);
    setBulkShopId('');
  };

  const handleBulkDelete = async () => {
    setBulkUpdating(true);
    setError(null);
    setConfirmDelete(false);
    try {
      const res = await ProductsApi.bulkDelete(selectedIds);
      const msg = res.skipped > 0
        ? `${res.deleted} products deleted. ${res.skipped} skipped (already removed).`
        : `${res.deleted} products deleted.`;
      showSuccess(msg);
      fetchProducts(1);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setBulkUpdating(false);
    }
  };

  // ── Pricing grid (App ₹ / Shop ₹ inline edit) ────────────────────────────
  // Variants are treated as separate rows/products here: a variant's key is
  // "productId:variantId", a plain product's key is just "productId". Edits
  // are staged locally and sent as one batched PATCH so a shop owner's whole
  // menu re-price doesn't fire one request per cell.
  const [priceEdits, setPriceEdits] = useState({});
  const [savingPrices, setSavingPrices] = useState(false);
  const priceRowKey = (productId, variantId) => (variantId ? `${productId}:${variantId}` : `${productId}`);
  const dirtyPriceCount = Object.keys(priceEdits).length;

  const handlePriceFieldChange = (key, field, value) => {
    setPriceEdits(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const discardPriceEdits = () => setPriceEdits({});

  const handleSavePrices = async () => {
    const rows = [];
    for (const [key, edit] of Object.entries(priceEdits)) {
      const [productIdStr, variantIdStr] = key.split(':');
      const row = { productId: Number(productIdStr) };
      if (variantIdStr) row.variantId = Number(variantIdStr);
      if (edit.price !== undefined && edit.price !== '') row.price = edit.price;
      if (edit.shopPrice !== undefined) row.shopPrice = edit.shopPrice === '' ? null : edit.shopPrice;
      if (row.price !== undefined || row.shopPrice !== undefined) rows.push(row);
    }
    if (rows.length === 0) { setPriceEdits({}); return; }

    setSavingPrices(true);
    setError(null);
    try {
      const res = await ProductsApi.updatePricing(rows);
      setPriceEdits({});
      if (res.errors && res.errors.length > 0) {
        setError(`${res.updated} row(s) saved, ${res.errors.length} failed: ${res.errors[0].message}`);
      } else {
        showSuccess(`Updated pricing for ${res.updated} item${res.updated === 1 ? '' : 's'}.`);
      }
      fetchProducts(pagination.page);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setSavingPrices(false);
    }
  };

  // Renders the App ₹ / Shop ₹ input pair for one pricing-grid row (a plain
  // product, or a single variant treated as its own row/product). Reads the
  // staged edit if there is one, otherwise the value the server sent.
  const renderPriceCells = (productId, variantId, currentPrice, currentShopPrice, originalPrice) => {
    const key = priceRowKey(productId, variantId);
    const edit = priceEdits[key];
    const priceValue = edit?.price !== undefined ? edit.price : (currentPrice ?? '');
    const shopPriceValue = edit?.shopPrice !== undefined
      ? edit.shopPrice
      : (currentShopPrice === null || currentShopPrice === undefined ? '' : currentShopPrice);
    const effectivePrice = Number(priceValue);
    const effectiveShopPrice = shopPriceValue === '' || shopPriceValue === null ? null : Number(shopPriceValue);
    const margin = Number.isFinite(effectivePrice) && effectiveShopPrice !== null && Number.isFinite(effectiveShopPrice)
      ? effectivePrice - effectiveShopPrice
      : null;
    return (
      <>
        <td>
          <input
            type="number" min="0" step="0.01"
            style={{ width: '5.5rem', padding: '0.3rem 0.4rem', border: '1px solid var(--border-color, #ddd)', borderRadius: 4 }}
            value={priceValue}
            onChange={(e) => handlePriceFieldChange(key, 'price', e.target.value)}
          />
          {originalPrice ? <div style={{ fontSize: '0.75rem', textDecoration: 'line-through', color: 'var(--text-secondary)' }}>₹{originalPrice}</div> : null}
        </td>
        <td>
          <input
            type="number" min="0" step="0.01"
            placeholder="—"
            style={{ width: '5.5rem', padding: '0.3rem 0.4rem', border: '1px solid var(--border-color, #ddd)', borderRadius: 4 }}
            value={shopPriceValue === null ? '' : shopPriceValue}
            onChange={(e) => handlePriceFieldChange(key, 'shopPrice', e.target.value)}
          />
          {margin !== null && (
            <div style={{ fontSize: '0.75rem', color: margin >= 0 ? 'var(--text-secondary)' : '#b91c1c' }}>
              Margin ₹{margin.toFixed(2)}
            </div>
          )}
        </td>
      </>
    );
  };

  const openCreateDrawer = () => { setEditingProduct(null); setDrawerOpen(true); };
  const openEditDrawer = (product) => { setEditingProduct(product); setDrawerOpen(true); };
  const closeDrawer = () => { setDrawerOpen(false); setEditingProduct(null); };

  // Categories filtered by current mode tab for the move-to-category dropdown
  const filteredCategoriesForBulk = categories.filter(c => c.type === filters.type && !c.deleted);

  if (isAllAreas) {
    return <div className="products-container"><PickAreaNotice label="Products" /></div>;
  }

  return (
    <div className="products-container">
      <header className="products-header">
        <h1 className="products-title">Products Management</h1>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="btn-secondary" onClick={() => navigate('/bulk-import')}>📦 Bulk Import</button>
          <button className="btn-secondary" onClick={() => setLibraryPickerOpen(true)}>📚 Add from Library</button>
          <button className="btn-primary" onClick={openCreateDrawer}>+ New Product</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {modes.map(m => (
          <button
            key={m.slug}
            className={`btn-secondary ${filters.type === m.slug ? 'active' : ''}`}
            style={filters.type === m.slug ? { background: 'var(--primary-color)', color: 'white', borderColor: 'var(--primary-color)' } : {}}
            onClick={() => setFilters(prev => ({ ...prev, type: m.slug, category_id: '' }))}
          >
            {m.label}
          </button>
        ))}
      </div>

      <section className="products-filter-bar">
        <input
          type="text" name="search" placeholder="Search product name..."
          className="filter-input filter-search" value={filters.search} onChange={handleFilterChange}
        />
        <select name="category_id" className="filter-select" value={filters.category_id} onChange={handleFilterChange}>
          <option value="">All Categories</option>
          {categories.filter(c => c.type === filters.type && !c.deleted).map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select name="shop_id" className="filter-select" value={filters.shop_id} onChange={handleFilterChange}>
          <option value="">All Shops</option>
          <option value="none">House (no shop)</option>
          {shops.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <select name="available" className="filter-select" value={filters.available} onChange={handleFilterChange}>
          <option value="">All Availability</option>
          <option value="1">In Stock</option>
          <option value="0">Out of Stock</option>
        </select>
        <select name="featured" className="filter-select" value={filters.featured} onChange={handleFilterChange}>
          <option value="">All Featured Status</option>
          <option value="1">Featured Only</option>
        </select>
      </section>

      {selectedIds.length > 0 && (
        <div className="bulk-actions-bar">
          <span className="bulk-actions-info">{selectedIds.length} item(s) selected</span>
          <div className="bulk-actions-buttons">
            <button className="btn-secondary" disabled={bulkUpdating} onClick={() => handleBulkAvailability(true)}>Mark In Stock</button>
            <button className="btn-secondary" disabled={bulkUpdating} onClick={() => handleBulkAvailability(false)}>Mark Out of Stock</button>
            <button className="btn-secondary" disabled={bulkUpdating} onClick={() => handleBulkFeatured(true)}>⭐ Mark Featured</button>
            <button className="btn-secondary" disabled={bulkUpdating} onClick={() => handleBulkFeatured(false)}>Remove Featured</button>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select
                className="filter-select"
                style={{ margin: 0 }}
                value={bulkCategoryId}
                onChange={e => setBulkCategoryId(e.target.value)}
              >
                <option value="">Move to Category...</option>
                {filteredCategoriesForBulk.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button className="btn-secondary" disabled={bulkUpdating || !bulkCategoryId} onClick={handleBulkMoveCategory}>Move</button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <select
                className="filter-select"
                style={{ margin: 0 }}
                value={bulkShopId}
                onChange={e => setBulkShopId(e.target.value)}
              >
                <option value="">Assign to Shop...</option>
                <option value="0">No shop (house item)</option>
                {shops.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button className="btn-secondary" disabled={bulkUpdating || bulkShopId === ''} onClick={handleBulkAssignShop}>Assign</button>
            </div>
            {!confirmDelete ? (
              <button
                className="btn-secondary"
                style={{ borderColor: 'var(--danger-color)', color: 'var(--danger-color)' }}
                disabled={bulkUpdating}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            ) : (
              <div className="bi-confirm-bar" style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '6px', padding: '0.35rem 0.75rem' }}>
                <span style={{ fontSize: '0.85rem', color: '#856404' }}>⚠️ Delete {selectedIds.length} products?</span>
                <button className="btn-secondary" style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem', borderColor: 'var(--danger-color)', color: 'var(--danger-color)' }} disabled={bulkUpdating} onClick={handleBulkDelete}>Yes, Delete</button>
                <button className="btn-secondary" style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }} onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}

      {dirtyPriceCount > 0 && (
        <div className="bulk-actions-bar">
          <span className="bulk-actions-info">{dirtyPriceCount} price edit{dirtyPriceCount === 1 ? '' : 's'} unsaved</span>
          <div className="bulk-actions-buttons">
            <button className="btn-secondary" disabled={savingPrices} onClick={discardPriceEdits}>Discard</button>
            <button className="btn-primary" disabled={savingPrices} onClick={handleSavePrices}>
              {savingPrices ? 'Saving…' : 'Save prices'}
            </button>
          </div>
        </div>
      )}

      {successMessage && (
        <MessageBanner type="success" message={successMessage} onDismiss={() => setSuccessMessage(null)} />
      )}
      {error && <MessageBanner type="error" message={error} onDismiss={() => setError(null)} />}

      <section className="products-table-wrapper">
        <table className="products-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>
                <input
                  type="checkbox"
                  checked={products.length > 0 && selectedIds.length === products.length}
                  onChange={selectAll}
                />
              </th>
              <th>Product</th>
              <th>App ₹</th>
              <th>Shop ₹</th>
              <th>Category</th>
              <th>Shop</th>
              <th>Order</th>
              <th>Availability</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && products.length === 0 ? (
              <tr><td colSpan="9" style={{ textAlign: 'center', padding: '2rem' }}>Loading products...</td></tr>
            ) : products.length === 0 ? (
              <tr><td colSpan="9" style={{ textAlign: 'center', padding: '2rem' }}>No products found.</td></tr>
            ) : (
              products.map(p => {
                const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
                return (
                  <React.Fragment key={p.id}>
                    <tr className={selectedIds.includes(p.id) ? 'selected' : ''}>
                      <td>
                        <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggleSelection(p.id)} />
                      </td>
                      <td>
                        <div className="product-info">
                          <img src={normalizeImageUrl(p.imageUrl || p.image_url) || FALLBACK_IMAGE} onError={handleImageError} alt={p.name} className="product-thumbnail" />
                          <div className="product-details">
                            <span className="product-name">{p.name}</span>
                            <span className="product-unit">
                              {p.unit || '1 plate'} {p.featured ? '• Featured' : ''} {hasVariants ? `• ${p.variants.length} option${p.variants.length === 1 ? '' : 's'} below` : ''}
                            </span>
                          </div>
                        </div>
                      </td>
                      {hasVariants ? (
                        // Variants are edited as their own rows right below —
                        // the parent product's price cells stay read-only so
                        // there's exactly one place to change each number.
                        <td colSpan={2} style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                          Priced per option ↓
                        </td>
                      ) : (
                        renderPriceCells(p.id, undefined, p.price, p.shop_price, p.original_price)
                      )}
                      <td>{p.category_name}</td>
                      <td>{p.shop_name || '—'}</td>
                      <td>{p.display_order || 0}</td>
                      <td>
                        <button
                          className={`availability-toggle ${p.available ? 'in-stock' : 'out-of-stock'}`}
                          onClick={() => toggleAvailability(p)}
                        >
                          {p.available ? 'In Stock' : 'Out of Stock'}
                        </button>
                        {(p.available_from_time || p.available_until_time) ? (
                          <div style={{ marginTop: '0.25rem' }}>
                            <span style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 10,
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              background: isWithinTimeWindow(p.available_from_time, p.available_until_time)
                                ? 'rgba(34, 197, 94, 0.15)'
                                : 'rgba(239, 68, 68, 0.15)',
                              color: isWithinTimeWindow(p.available_from_time, p.available_until_time)
                                ? '#15803d'
                                : '#b91c1c',
                              marginRight: 6,
                            }}>
                              {isWithinTimeWindow(p.available_from_time, p.available_until_time) ? '✓ Visible now' : '✗ Hidden now'}
                            </span>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                              ⏰ {formatTimeWindow(p.available_from_time, p.available_until_time)}
                            </span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <button className="action-link" onClick={() => openEditDrawer(p)}>Edit</button>
                      </td>
                    </tr>
                    {hasVariants && p.variants.map(v => (
                      // Variants are treated as their own products for pricing
                      // purposes — each gets its own App ₹ / Shop ₹ row, keyed
                      // "productId:variantId" so a save touches only that variant.
                      <tr key={`${p.id}-v${v.id}`} className="variant-price-row">
                        <td />
                        <td>
                          <div className="product-info" style={{ paddingLeft: '1.5rem' }}>
                            <div className="product-details">
                              <span className="product-name" style={{ fontSize: '0.85rem' }}>↳ {v.label}</span>
                              <span className="product-unit">{v.isDefault || v.is_default ? 'Default option' : ''}</span>
                            </div>
                          </div>
                        </td>
                        {renderPriceCells(p.id, v.id, v.price, v.shopPrice ?? v.shop_price, v.originalPrice ?? v.original_price)}
                        <td colSpan={2} style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Inherits from {p.name}</td>
                        <td>—</td>
                        <td>
                          <button
                            className={`availability-toggle ${v.available ? 'in-stock' : 'out-of-stock'}`}
                            onClick={() => toggleVariantAvailability(p, v)}
                          >
                            {v.available ? 'In Stock' : 'Out of Stock'}
                          </button>
                        </td>
                        <td>
                          <button className="action-link" onClick={() => openEditDrawer(p)}>Edit</button>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>

        <div className="pagination-controls">
          <button className="btn-secondary" disabled={pagination.page <= 1 || loading} onClick={() => fetchProducts(pagination.page - 1)}>Previous</button>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Page {pagination.page} of {pagination.totalPages}</span>
          <button className="btn-secondary" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => fetchProducts(pagination.page + 1)}>Next</button>
        </div>
      </section>

      {drawerOpen && (
        <ProductFormDrawer
          product={editingProduct}
          categories={categories}
          shops={shops}
          currentMode={filters.type}
          onClose={closeDrawer}
          onSave={() => { closeDrawer(); fetchProducts(pagination.page); }}
        />
      )}

      {libraryPickerOpen && (
        <LibraryPickerModal
          categories={categories}
          currentMode={filters.type}
          onClose={() => setLibraryPickerOpen(false)}
          onAdded={() => { setLibraryPickerOpen(false); fetchProducts(pagination.page); }}
        />
      )}
    </div>
  );
}

// 26.6 — "+ Add from Library": search the shared product library and
// materialize one into the currently selected area (same X-Area-Id the rest
// of this page already operates under — §4.4, no page ever picks its own area).
function LibraryPickerModal({ categories, currentMode, onClose, onAdded }) {
  const { modes } = useStoreModes();
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pickedRow, setPickedRow] = useState(null);
  const [mode, setMode] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);
  const categoriesForMode = categories.filter((c) => c.type === mode);

  useEffect(() => {
    let alive = true;
    // Advance the generation as soon as the query changes. Otherwise an old
    // request can finish during the debounce window and overwrite new input.
    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      LibraryApi.list({ search, archived: 'false' })
        .then((res) => { if (alive && requestId === requestIdRef.current) setRows(readList(res)); })
        .catch((err) => { if (alive && requestId === requestIdRef.current) setError(err.message || GENERIC_ERROR); })
        .finally(() => { if (alive && requestId === requestIdRef.current) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [search]);

  const pick = (row) => {
    setPickedRow(row);
    setMode((modes.some((m) => m.slug === currentMode) ? currentMode : modes[0]?.slug) || '');
    setCategoryId('');
    setPrice(row.suggestedPrice ?? row.suggested_price ?? '');
    setError(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0) {
      setError('Pick a category');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await LibraryApi.addToArea(pickedRow.id, { categoryId: Number(categoryId), price: price !== '' ? Number(price) : undefined });
      onAdded();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-content" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h3 className="drawer-title">Add from Library</h3>
          <button type="button" className="drawer-close" onClick={onClose}>&times;</button>
        </div>
        <div className="drawer-body">
          {error && <MessageBanner type="error" message={error} onDismiss={() => setError(null)} />}
          {!pickedRow ? (
            <>
              <input
                className="form-input"
                placeholder="Search the library…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ marginBottom: '1rem' }}
              />
              {loading ? (
                <p>Loading…</p>
              ) : rows.length === 0 ? (
                <p>No library products match.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="btn-secondary"
                      style={{ textAlign: 'left' }}
                      onClick={() => pick(row)}
                    >
                      {row.name} {row.suggestedPrice != null ? `— ₹${row.suggestedPrice}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <form onSubmit={submit}>
              <p>Adding <strong>{pickedRow.name}</strong> to this area.</p>
              <div className="form-group">
                <label className="form-label">Shop mode *</label>
                <select
                  className="form-select"
                  value={mode}
                  onChange={(e) => { setMode(e.target.value); setCategoryId(''); }}
                  required
                >
                  <option value="" disabled>Select a shop mode</option>
                  {modes.map((m) => (
                    <option key={m.slug} value={m.slug}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Category *</label>
                <select className="form-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required disabled={!mode}>
                  <option value="" disabled>{mode ? 'Select a category' : 'Pick a shop mode first'}</option>
                  {categoriesForMode.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {mode && categoriesForMode.length === 0 && (
                  <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    No categories in this area for {modes.find((m) => m.slug === mode)?.label || mode} yet — create one on the Categories page first.
                  </span>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Price (₹)</label>
                <input type="number" className="form-input" value={price} onChange={(e) => setPrice(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setPickedRow(null)}>Back</button>
                <button type="submit" className="btn-primary" disabled={saving}>
                  {saving ? 'Adding…' : 'Add to area'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Variant helpers ────────────────────────────────────────
// The API sends variants with both camelCase and snake_case keys. Normalize each
// variant into a single editable shape for the form.
const normalizeVariant = (v) => ({
  id: v?.id ?? v?.variant_id,
  label: v?.label ?? '',
  price: v?.price ?? '',
  original_price: v?.original_price ?? v?.originalPrice ?? null,
  available: v?.available ?? true,
  is_default: v?.is_default ?? v?.isDefault ?? false,
  display_order: v?.display_order ?? v?.displayOrder ?? 0,
});

const normalizeVariants = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const list = raw.map(normalizeVariant);
  // Ensure exactly one default so the radio group always has a selection.
  if (!list.some(v => v.is_default)) list[0].is_default = true;
  return list;
};

// Separate Component for the Drawer — unchanged from original
function ProductFormDrawer({ product, categories, shops, currentMode, onClose, onSave }) {
  const { modes } = useStoreModes();
  const isEdit = !!product;
  // §2.5/26.7 — identity fields (name, image, description, unit, variant
  // labels) are owned by the library once a product is linked; editing them
  // here would be silently overwritten by the next propagateLibraryEdit, so
  // they're read-only with a link to the one place they're actually editable.
  const isLibraryManaged = Boolean(product?.libraryProductId || product?.library_product_id);
  const initialMode = product?.category_type || categories.find(c => String(c.id) === String(product?.category_id))?.type || currentMode || 'packed';
  const [productMode, setProductMode] = useState(initialMode);
  const [formData, setFormData] = useState(() => {
    if (product) {
      // MySQL TIME fields come back as strings like '09:00:00' or as Date objects depending on driver config.
      // Normalize them to HH:MM so the <input type="time"> works correctly.
      const formatTime = (v) => {
        if (!v) return '';
        if (typeof v === 'string') return v.length >= 5 ? v.slice(0, 5) : v;
        if (v instanceof Date) {
          const hh = String(v.getHours()).padStart(2, '0');
          const mm = String(v.getMinutes()).padStart(2, '0');
          return `${hh}:${mm}`;
        }
        return '';
      };
      const variants = normalizeVariants(product.variants);
      return {
        ...product,
        variants,
        variant_prompt: product.variant_prompt || product.variantPrompt || '',
        hasVariants: variants.length > 0,
        available_from_time: formatTime(product.available_from_time),
        available_until_time: formatTime(product.available_until_time)
      };
    }
    return {
      name: '', description: '', price: '', original_price: '', unit: '',
      category_id: '', display_order: 0, available: true, featured: false,
      discount_label: '', image_id: '', image_url: '',
      available_from_time: '', available_until_time: '',
      variants: [],
      variant_prompt: '',
      shop_id: '',
      hasVariants: false
    };
  });

  const [initialHadVariants] = useState(() => isEdit && normalizeVariants(product?.variants).length > 0);
  // Snapshot the very first render's formData (before any edits) so an
  // accidental click on the overlay can be told apart from a real "I'm done"
  // close — losing a half-filled product form to a stray click was the bug.
  const initialFormDataRef = useRef(null);
  if (initialFormDataRef.current === null) {
    initialFormDataRef.current = formData;
  }
  const isDirty = JSON.stringify(formData) !== JSON.stringify(initialFormDataRef.current);
  const handleCloseAttempt = () => {
    if (isDirty && !window.confirm('Discard unsaved changes to this product?')) return;
    onClose();
  };
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadMessage, setUploadMessage] = useState(null);
  const fileInputRef = useRef(null);

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
      setFormData(prev => ({ ...prev, image_id: image.id, image_url: image.url }));
      // Discard the previous unsaved upload from this session so re-picking a
      // photo before hitting Save doesn't leak an orphaned S3 object.
      if (previousPendingId && previousPendingId !== product?.image_id) {
        ImagesApi.delete(previousPendingId).catch(() => {});
      }
      setUploadMessage({ type: 'success', text: 'Image uploaded. Save the product to apply it.' });
    } catch (err) {
      console.error(err);
      setUploadMessage({ type: 'error', text: GENERIC_ERROR });
    } finally {
      setUploadingImage(false);
    }
  };

  const { fileInputProps, cropperProps } = useImageCropper({
    type: 'product',
    defaultAspect: 0.78,
    onCropped: uploadImageFile,
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    setFieldErrors(prev => ({ ...prev, [name]: undefined }));
  };

  const handleModeChange = (e) => {
    const nextMode = e.target.value;
    setProductMode(nextMode);
    setFormData(prev => {
      const selectedCategory = categories.find(c => String(c.id) === String(prev.category_id));
      return { ...prev, category_id: selectedCategory?.type === nextMode ? prev.category_id : '' };
    });
    setFieldErrors(prev => ({ ...prev, category_id: undefined }));
  };

  const variantsOn = !!formData.hasVariants;
  const variantRows = Array.isArray(formData.variants) ? formData.variants : [];
  const defaultVariant = variantRows.find(v => v.is_default) || variantRows[0] || null;
  const basePriceDisplay = variantsOn ? (defaultVariant ? defaultVariant.price : '') : formData.price;
  const baseOriginalPriceDisplay = variantsOn
    ? (defaultVariant ? (defaultVariant.original_price ?? '') : '')
    : (formData.original_price || '');

  const handleToggleVariants = (e) => {
    const enabled = e.target.checked;
    setFormData(prev => {
      let variants = Array.isArray(prev.variants) ? prev.variants : [];
      if (enabled && variants.length === 0) {
        variants = [{ id: undefined, label: '', price: '', original_price: null, available: true, is_default: true, display_order: 0 }];
      }
      return { ...prev, hasVariants: enabled, variants };
    });
  };

  const handleVariantChange = (index, field, value) => {
    setFormData(prev => ({
      ...prev,
      variants: (Array.isArray(prev.variants) ? prev.variants : []).map((v, i) =>
        i === index ? { ...v, [field]: value } : v
      ),
    }));
  };

  const handleSetDefaultVariant = (index) => {
    setFormData(prev => ({
      ...prev,
      variants: (Array.isArray(prev.variants) ? prev.variants : []).map((v, i) => ({ ...v, is_default: i === index })),
    }));
  };

  const handleAddVariant = () => {
    setFormData(prev => {
      const variants = Array.isArray(prev.variants) ? [...prev.variants] : [];
      variants.push({ id: undefined, label: '', price: '', original_price: null, available: true, is_default: variants.length === 0, display_order: variants.length });
      return { ...prev, variants };
    });
  };

  const handleRemoveVariant = (index) => {
    setFormData(prev => {
      let variants = (Array.isArray(prev.variants) ? prev.variants : []).filter((_, i) => i !== index);
      if (variants.length > 0 && !variants.some(v => v.is_default)) {
        variants = variants.map((v, i) => ({ ...v, is_default: i === 0 }));
      }
      return { ...prev, variants };
    });
  };

  const focusFirstInvalid = () => {
    setTimeout(() => {
      const el = document.querySelector('[aria-invalid="true"]');
      el?.focus();
    }, 0);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setFormError(null);
      setFieldErrors({});
      let payloadPrice;
      let payloadOriginalPrice;
      let variantsPayload; // undefined => omit (don't touch), [] => clear, [...] => set
      let variantPromptPayload;

      if (variantsOn) {
        const variants = Array.isArray(formData.variants) ? formData.variants : [];
        if (variants.length === 0) {
          setFormError('Add at least one variant, or turn off the variants toggle.');
          setSaving(false);
          focusFirstInvalid();
          return;
        }
        if (!variants.some(v => v.is_default)) {
          setFormError('Mark one variant as the default.');
          setSaving(false);
          focusFirstInvalid();
          return;
        }
        const vErrors = {};
        variants.forEach((v, i) => {
          if (!String(v.label || '').trim()) vErrors[`variant_${i}_label`] = 'Variant label is required.';
          const vp = Number(v.price);
          if (!Number.isFinite(vp) || vp < 0) vErrors[`variant_${i}_price`] = 'Price must be a valid non-negative number.';
          if (v.original_price !== null && v.original_price !== '' && v.original_price !== undefined) {
            const op = Number(v.original_price);
            if (!Number.isFinite(op) || op < vp) vErrors[`variant_${i}_original_price`] = 'Original price must be valid and not lower than the price.';
          }
        });
        if (Object.keys(vErrors).length > 0) {
          setFieldErrors(vErrors);
          setFormError('Please fix the highlighted variant fields.');
          setSaving(false);
          focusFirstInvalid();
          return;
        }
        variantsPayload = variants.map((v, i) => {
          const obj = {
            label: String(v.label).trim(),
            price: Number(v.price),
            original_price: (v.original_price !== null && v.original_price !== '' && v.original_price !== undefined) ? Number(v.original_price) : null,
            available: v.available !== false,
            is_default: !!v.is_default,
            display_order: i,
          };
          if (v.id) obj.id = v.id; // preserve id so the backend upserts instead of recreating
          return obj;
        });
        const def = variantsPayload.find(v => v.is_default);
        payloadPrice = def.price;
        payloadOriginalPrice = def.original_price ?? null;
        variantPromptPayload = formData.variant_prompt || '';
      } else {
        const price = Number(formData.price);
        const originalPrice = formData.original_price ? Number(formData.original_price) : null;
        if (!Number.isFinite(price) || price < 0) {
          setFieldErrors({ price: 'Product price must be a valid non-negative number.' });
          setFormError('Product price must be a valid non-negative number.');
          setSaving(false);
          focusFirstInvalid();
          return;
        }
        if (originalPrice !== null && (!Number.isFinite(originalPrice) || originalPrice < price)) {
          setFieldErrors({ original_price: 'Original price must be a valid amount and cannot be lower than selling price.' });
          setFormError('Original price must be a valid amount and cannot be lower than selling price.');
          setSaving(false);
          focusFirstInvalid();
          return;
        }
        payloadPrice = price;
        payloadOriginalPrice = originalPrice;
        if (initialHadVariants) {
          // Turning variants off for a product that had them clears them. Confirm first —
          // live carts holding those variants will start failing calc.
          if (!window.confirm('Turning off variants will remove all existing variants for this product. Customers who have these variants in their carts may see errors. Are you sure?')) {
            setSaving(false);
            return;
          }
          variantsPayload = [];
          variantPromptPayload = '';
        } else {
          // Never had variants and the toggle is off — don't touch the field (partial update).
          variantsPayload = undefined;
          variantPromptPayload = undefined;
        }
      }

      const fromTime = formData.available_from_time || null;
      const untilTime = formData.available_until_time || null;
      const payload = {
        ...formData,
        price: payloadPrice,
        original_price: payloadOriginalPrice,
        display_order: Number(formData.display_order) || 0,
        imageId: formData.image_id,
        image_id: formData.image_id,
        available_from_time: fromTime,
        available_until_time: untilTime,
        availableFromTime: fromTime,
        availableUntilTime: untilTime,
        shop_id: formData.shop_id || null,
        shopId: formData.shop_id || null,
      };
      // Send the variants field only in the intended shape.
      if (variantsPayload === undefined) {
        delete payload.variants;
        delete payload.variant_prompt;
        delete payload.variantPrompt;
      } else {
        payload.variants = variantsPayload;
        payload.variant_prompt = variantPromptPayload;
        payload.variantPrompt = variantPromptPayload;
      }
      // Drop form-only / read-only flags so they are not written.
      delete payload.hasVariants;
      delete payload.has_variants;
      delete payload.minPrice;
      delete payload.min_price;
      const selectedCat = categories.find(c => c.id.toString() === formData.category_id.toString());
      if (!selectedCat) { setFieldErrors({ category_id: 'Please select a category for this product.' }); setFormError('Please select a category for this product.'); setSaving(false); focusFirstInvalid(); return; }
      if (selectedCat.type !== productMode) { setFieldErrors({ category_id: 'Selected category does not match the chosen product mode.' }); setFormError('Selected category does not match the chosen product mode.'); setSaving(false); focusFirstInvalid(); return; }
      if (isEdit) {
        if (product.category_id && formData.category_id && product.category_id.toString() !== formData.category_id.toString()) {
          const oldCat = categories.find(c => c.id.toString() === product.category_id.toString());
          const newCat = categories.find(c => c.id.toString() === formData.category_id.toString());
          if (oldCat && newCat && oldCat.type !== newCat.type) {
            if (!window.confirm(`Warning: You are moving this product from ${oldCat.type === 'fast_food' ? 'Fast Food' : 'Packed Items'} to ${newCat.type === 'fast_food' ? 'Fast Food' : 'Packed Items'}. Are you sure?`)) {
              setSaving(false);
              return;
            }
          }
        }
        await ProductsApi.update(product.id, payload);
        if (formData.image_id && formData.image_id !== product.image_id) {
          await ProductsApi.attachImage(product.id, formData.image_id);
        }
      } else {
        const created = await ProductsApi.create(payload);
        const productId = created.id || created.product?.id || created.data?.id;
        if (productId && formData.image_id) await ProductsApi.attachImage(productId, formData.image_id);
      }
      onSave();
    } catch (err) {
      console.error(err);
      setFormError(GENERIC_ERROR);
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this product?')) return;
    try {
      setSaving(true);
      await ProductsApi.delete(product.id);
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
            <h3 className="drawer-title">{isEdit ? 'Edit Product' : 'New Product'}</h3>
            <button type="button" className="drawer-close" onClick={handleCloseAttempt}>&times;</button>
          </div>
          <div className="drawer-body">
            <MessageBanner type="error" message={formError} onDismiss={() => setFormError(null)} />
            {isLibraryManaged && (
              <div
                style={{
                  background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning-text, #92400e)',
                  padding: '0.6rem 0.9rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem',
                }}
              >
                📚 Name, image, description, unit and variant labels are managed in the Library.{' '}
                <a href="/library" style={{ fontWeight: 700, textDecoration: 'underline' }}>Edit there</a> —
                price, availability, category and shop stay editable here.
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Product Name</label>
              <input required type="text" name="name" className="form-input" value={formData.name} onChange={handleChange} readOnly={isLibraryManaged} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Price (₹)</label>
                <input
                  required={!variantsOn}
                  type="number"
                  min="0"
                  step="0.01"
                  name="price"
                  className="form-input"
                  value={basePriceDisplay}
                  onChange={handleChange}
                  readOnly={variantsOn}
                  aria-invalid={Boolean(fieldErrors.price)}
                  aria-errormessage={fieldErrors.price ? 'price-error' : undefined}
                />
                {variantsOn && (
                  <span className="form-hint">Set by default variant</span>
                )}
                {fieldErrors.price && (
                  <span id="price-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                    {fieldErrors.price}
                  </span>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Original Price (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  name="original_price"
                  className="form-input"
                  placeholder="Optional"
                  value={baseOriginalPriceDisplay}
                  onChange={handleChange}
                  readOnly={variantsOn}
                  aria-invalid={Boolean(fieldErrors.original_price)}
                  aria-errormessage={fieldErrors.original_price ? 'original_price-error' : undefined}
                />
                {variantsOn && (
                  <span className="form-hint">Set by default variant</span>
                )}
                {fieldErrors.original_price && (
                  <span id="original_price-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                    {fieldErrors.original_price}
                  </span>
                )}
              </div>
            </div>
            <div className="form-group" style={{ marginTop: '1rem' }}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  name="hasVariants"
                  checked={variantsOn}
                  onChange={handleToggleVariants}
                />
                This product has variants (sizes / types)
              </label>
            </div>
            {variantsOn && (
              <div className="variant-editor">
                <div className="variant-editor-header">
                  <span className="form-label">Variants</span>
                  <button type="button" className="action-link" onClick={handleAddVariant}>+ Add Variant</button>
                </div>
                {variantRows.map((v, i) => (
                  <div className="variant-row" key={v.id ?? `new-${i}`}>
                    <div className="variant-row-top">
                      <input
                        type="text"
                        className="form-input variant-label-input"
                        placeholder="e.g. Small / Chicken / Half Plate"
                        value={v.label}
                        required
                        onChange={(e) => handleVariantChange(i, 'label', e.target.value)}
                        aria-invalid={Boolean(fieldErrors[`variant_${i}_label`])}
                        readOnly={isLibraryManaged}
                      />
                      <label className="variant-default-radio" title="Default variant">
                        <input
                          type="radio"
                          name="variant-default"
                          checked={!!v.is_default}
                          onChange={() => handleSetDefaultVariant(i)}
                        />
                        Default
                      </label>
                      <button
                        type="button"
                        className="action-link danger variant-remove"
                        onClick={() => handleRemoveVariant(i)}
                        title="Remove variant"
                      >✕</button>
                    </div>
                    <div className="variant-row-prices">
                      <div className="form-group">
                        <label className="form-label">Price (₹)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="form-input"
                          value={v.price}
                          required
                          onChange={(e) => handleVariantChange(i, 'price', e.target.value)}
                          aria-invalid={Boolean(fieldErrors[`variant_${i}_price`])}
                        />
                        {fieldErrors[`variant_${i}_price`] && (
                          <span className="field-error" style={{ fontSize: '0.78rem', color: 'var(--danger-color)' }}>
                            {fieldErrors[`variant_${i}_price`]}
                          </span>
                        )}
                      </div>
                      <div className="form-group">
                        <label className="form-label">Original Price (₹)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="form-input"
                          placeholder="Optional"
                          value={v.original_price ?? ''}
                          onChange={(e) => handleVariantChange(i, 'original_price', e.target.value || null)}
                        />
                        {fieldErrors[`variant_${i}_original_price`] && (
                          <span className="field-error" style={{ fontSize: '0.78rem', color: 'var(--danger-color)' }}>
                            {fieldErrors[`variant_${i}_original_price`]}
                          </span>
                        )}
                      </div>
                      <label className="checkbox-label variant-available-label">
                        <input
                          type="checkbox"
                          checked={v.available !== false}
                          onChange={(e) => handleVariantChange(i, 'available', e.target.checked)}
                        />
                        Available
                      </label>
                    </div>
                    {fieldErrors[`variant_${i}_label`] && (
                      <span className="field-error" style={{ fontSize: '0.78rem', color: 'var(--danger-color)' }}>
                        {fieldErrors[`variant_${i}_label`]}
                      </span>
                    )}
                  </div>
                ))}
                <div className="form-group" style={{ marginTop: '0.25rem' }}>
                  <label className="form-label">Choice prompt (shown to customer)</label>
                  <input
                    type="text"
                    name="variant_prompt"
                    className="form-input"
                    placeholder="e.g. Choose size"
                    value={formData.variant_prompt || ''}
                    onChange={handleChange}
                  />
                  <span className="form-hint">Combos always use a product&apos;s default variant.</span>
                </div>
              </div>
            )}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Product Mode</label>
                <select required name="product_mode" className="form-select" value={productMode} onChange={handleModeChange}>
                  {modes.map(m => <option key={m.slug} value={m.slug}>{m.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Category</label>
                <select
                  required
                  name="category_id"
                  className="form-select"
                  value={formData.category_id}
                  onChange={handleChange}
                  aria-invalid={Boolean(fieldErrors.category_id)}
                  aria-errormessage={fieldErrors.category_id ? 'category_id-error' : undefined}
                >
                  <option value="">Select {modes.find(m => m.slug === productMode)?.label || productMode} Category</option>
                  {categories.filter(c => c.type === productMode).map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({modes.find(m => m.slug === c.type)?.label || c.type})</option>
                  ))}
                </select>
                {fieldErrors.category_id && (
                  <span id="category_id-error" className="field-error" style={{ fontSize: '0.8rem', color: 'var(--danger-color)', marginTop: '4px' }}>
                    {fieldErrors.category_id}
                  </span>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Shop</label>
                <select
                  name="shop_id"
                  className="form-select"
                  value={formData.shop_id || ''}
                  onChange={handleChange}
                >
                  <option value="">No shop (house item)</option>
                  {shops.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Unit (e.g., 1 Plate)</label>
                <input type="text" name="unit" className="form-input" value={formData.unit || ''} onChange={handleChange} readOnly={isLibraryManaged} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea name="description" className="form-textarea" value={formData.description || ''} onChange={handleChange} readOnly={isLibraryManaged} />
            </div>
            <div className="form-group">
              <label className="form-label">Product Image</label>
              <p className="image-dimension-hint">{IMAGE_GUIDANCE.product.label}</p>
              {(formData.image_url || formData.imageUrl) && <img src={normalizeImageUrl(formData.image_url || formData.imageUrl)} alt="Preview" className="image-preview" />}
              <div className="image-upload-zone" onClick={() => { if (!isLibraryManaged) fileInputRef.current?.click(); }} style={isLibraryManaged ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
                <input type="file" hidden ref={fileInputRef} {...fileInputProps} accept="image/*" disabled={isLibraryManaged} />
                {isLibraryManaged ? 'Managed in Library' : uploadingImage ? 'Uploading...' : 'Click to Upload Image'}
              </div>
              {uploadMessage && <p className={`upload-message ${uploadMessage.type}`}>{uploadMessage.text}</p>}
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Display Order</label>
                <input type="number" min="0" step="1" name="display_order" className="form-input" value={formData.display_order} onChange={handleChange} />
              </div>
              <div className="form-group">
                <label className="form-label">Discount Label (Optional)</label>
                <input type="text" name="discount_label" className="form-input" placeholder="e.g. 20% OFF" value={formData.discount_label || ''} onChange={handleChange} />
              </div>
            </div>
            <div className="form-row" style={{ marginTop: '1rem', gap: '2rem' }}>
              <label className="checkbox-label">
                <input type="checkbox" name="available" checked={formData.available} onChange={handleChange} />
                In Stock (Available)
              </label>
              <label className="checkbox-label">
                <input type="checkbox" name="featured" checked={formData.featured} onChange={handleChange} />
                Featured Product
              </label>
            </div>
            <div className="form-group" style={{ marginTop: '1rem' }}>
              <label className="form-label">Daily availability window (optional)</label>
              <p className="form-hint" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 0.5rem 0' }}>
                Restrict this product to a specific time of day. Leave both empty to make it available all day.
              </p>
              {(formData.available_from_time || formData.available_until_time) && (
                <div style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  marginBottom: 8,
                  fontSize: '0.8rem',
                  background: isWithinTimeWindow(formData.available_from_time, formData.available_until_time)
                    ? 'rgba(34, 197, 94, 0.1)'
                    : 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid ' + (isWithinTimeWindow(formData.available_from_time, formData.available_until_time)
                    ? 'rgba(34, 197, 94, 0.3)'
                    : 'rgba(239, 68, 68, 0.3)'),
                  color: isWithinTimeWindow(formData.available_from_time, formData.available_until_time)
                    ? '#15803d'
                    : '#b91c1c',
                }}>
                  <strong>
                    {isWithinTimeWindow(formData.available_from_time, formData.available_until_time)
                      ? '✓ Customers can see this product right now'
                      : '✗ Customers cannot see this product right now'}
                  </strong>
                  <div style={{ marginTop: 2, opacity: 0.85 }}>
                    Window: {formatTimeWindow(formData.available_from_time, formData.available_until_time)}
                    {' · '}Server time: {new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })}
                  </div>
                </div>
              )}
              <div className="form-row" style={{ alignItems: 'flex-end' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label" style={{ fontSize: '0.85rem' }}>Available from</label>
                  <input
                    type="time"
                    name="available_from_time"
                    className="form-input"
                    value={formData.available_from_time || ''}
                    onChange={handleChange}
                  />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label" style={{ fontSize: '0.85rem' }}>Available until</label>
                  <input
                    type="time"
                    name="available_until_time"
                    className="form-input"
                    value={formData.available_until_time || ''}
                    onChange={handleChange}
                  />
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ alignSelf: 'flex-end' }}
                  onClick={() => setFormData(prev => ({ ...prev, available_from_time: '', available_until_time: '' }))}
                  disabled={!formData.available_from_time && !formData.available_until_time}
                >
                  Clear window
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-footer">
            {isEdit && (
              <button type="button" className="action-link danger" onClick={handleDelete} disabled={saving} style={{ marginRight: 'auto' }}>Delete Product</button>
            )}
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving || uploadingImage}>{saving ? 'Saving...' : 'Save Product'}</button>
          </div>
        </form>
      </div>
      <ImageCropper {...cropperProps} />
    </div>
  );
}
