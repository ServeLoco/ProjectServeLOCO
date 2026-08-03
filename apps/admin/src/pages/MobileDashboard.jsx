// MobileDashboard.jsx
import React, { useState, useEffect, useRef } from 'react';
import { MobileDashboardApi, ProductsApi, CategoriesApi, OffersApi, CombosApi, ShopsApi } from '../api';
import './MobileDashboard.css';
import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';

import { readList } from '../utils/apiResponse';
import { normalizeImageUrl, FALLBACK_IMAGE, handleImageError } from '../utils/imageUrl';
import { useStoreModes, modeLabel } from '../hooks/useStoreModes';

const DEFAULT_MAX_VISIBLE_BY_SECTION = {
  offer_banner: 5,
  category_grid: 8,
  product_block: 6,
  combo_block: 6
};


export default function MobileDashboard() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const { modes } = useStoreModes();
  const [sections, setSections] = useState([]);
  const [selectedSection, setSelectedSection] = useState(null);
  const [storeType, setStoreType] = useState('packed');
  
  // Loading states
  const [loadingSections, setLoadingSections] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingSection, setSavingSection] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [error, setError] = useState(null);
  const [successSection, setSuccessSection] = useState(null);

  // New section modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newSectionForm, setNewSectionForm] = useState({
    title: '',
    slug: '',
    section_type: 'product_block',
    store_type: storeType,
    active: 1,
    display_order: 0,
    max_visible_items: DEFAULT_MAX_VISIBLE_BY_SECTION.product_block,
    show_see_all: 1,
    show_hot_badge: 0,
    section_icon: '',
    linked_category_id: '',
    linked_offer_id: '',
    starts_at: '',
    ends_at: ''
  });

  // Edit section properties form
  const [editForm, setEditForm] = useState(null);

  // Item picker states
  const [candidates, setCandidates] = useState([]);
  const [allCategories, setAllCategories] = useState([]);
  const [allOffers, setAllOffers] = useState([]);
  const [allShops, setAllShops] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [addingItemId, setAddingItemId] = useState(null);
  const addingItemRef = useRef(false);
  const [isAssignOpen, setIsAssignOpen] = useState(false);

  // Load categories, offers and shops once for the linked_*_id selects and the
  // assign-item filters.
  // 25.4 — App Home sections are per-area (the API 400s for "all"); skip the
  // doomed preload + fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    (async () => {
      try {
        const [catRes, offRes, shopRes] = await Promise.all([
          CategoriesApi.list({}),
          OffersApi.list({}),
          ShopsApi.list(),
        ]);
        setAllCategories(readList(catRes, 'categories'));
        setAllOffers(readList(offRes, 'offers'));
        setAllShops(readList(shopRes, 'shops'));
      } catch (err) {
        console.warn('MobileDashboard: failed to preload categories/offers/shops', err);
      }
    })();
  }, [isAllAreas]);

  useEffect(() => {
    if (isAllAreas) return;
    fetchSections();
    setNewSectionForm(prev => ({ ...prev, store_type: storeType }));
  }, [storeType, isAllAreas]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedSection) {
      loadCandidates(selectedSection.section_type);
    } else {
      setCandidates([]);
    }
    setSearchQuery('');
    setShopFilter('');
    setCategoryFilter('');
    setIsAssignOpen(false);
  }, [selectedSection?.id, selectedSection?.section_type]);

  const fetchSections = async () => {
    try {
      setLoadingSections(true);
      setError(null);
      const res = await MobileDashboardApi.listSections({ store_type: storeType });
      setSections(res.data || []);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoadingSections(false);
    }
  };

  const fetchSectionDetail = async (id) => {
    try {
      setLoadingDetail(true);
      setError(null);
      const res = await MobileDashboardApi.getSection(id);
      const section = res.data;
      setSelectedSection(section);
      
      // Initialize edit form
      setEditForm({
        title: section.title,
        slug: section.slug,
        section_type: section.section_type,
        store_type: section.store_type || 'all',
        active: section.active === 1 || section.active === true ? 1 : 0,
        display_order: section.display_order || 0,
        max_visible_items: section.max_visible_items !== undefined ? section.max_visible_items : 6,
        show_see_all: section.show_see_all === 1 || section.show_see_all === true ? 1 : 0,
        show_hot_badge: section.show_hot_badge === 1 || section.show_hot_badge === true ? 1 : 0,
        section_icon: section.section_icon || '',
        linked_category_id: section.linked_category_id || '',
        linked_offer_id: section.linked_offer_id || '',
        starts_at: formatDateToLocalInput(section.starts_at),
        ends_at: formatDateToLocalInput(section.ends_at),
        version: section.version
      });
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoadingDetail(false);
    }
  };

  const loadCandidates = async (sectionType) => {
    try {
      setLoadingCandidates(true);
      setCandidates([]);
      if (sectionType === 'offer_banner') {
        const res = await OffersApi.list({ store_type: storeType });
        setCandidates(readList(res, 'offers'));
      } else if (sectionType === 'category_grid') {
        const res = await CategoriesApi.list({ type: storeType });
        setCandidates(readList(res, 'categories'));
      } else if (sectionType === 'product_block') {
        // Load only non-combos
        const res = await ProductsApi.list({ limit: 100, is_combo: '0', available: '1', type: storeType });
        setCandidates(readList(res, 'products'));
      } else if (sectionType === 'combo_block') {
        // Load only combos
        const res = await CombosApi.list({ limit: 100, available: '1', store_type: storeType });
        setCandidates(readList(res, ['products', 'combos']));
      }
    } catch (err) {
      console.error('Failed to load candidate items', err);
    } finally {
      setLoadingCandidates(false);
    }
  };

  // <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM" with no timezone info.
  // We store in UTC ISO so the backend (and the customer app's Date parsing)
  // see the same wall-clock instant regardless of admin timezone. Server is
  // assumed to be UTC (matches the rest of the app).
  const formatDateToLocalInput = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  // Convert the datetime-local string (admin local) to a UTC ISO string.
  const localInputToUtcIso = (local) => {
    if (!local) return null;
    const d = new Date(local);  // parsed as admin's local time
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  };

  const generateSlug = (name) => {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
  };

  const handleModalFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    setNewSectionForm(prev => {
      const val = type === 'checkbox' ? (checked ? 1 : 0) : value;
      const updates = { [name]: val };
      if (name === 'section_type') {
        updates.max_visible_items = DEFAULT_MAX_VISIBLE_BY_SECTION[value] || 6;
        if (value === 'offer_banner') {
          updates.show_see_all = 0;
        }
        // Reset the linkage fields — a category_grid that switches to
        // product_block must not carry a stale linked_category_id (the
        // backend would accept the value and attach a meaningless link).
        updates.linked_category_id = '';
        updates.linked_offer_id = '';
      }
      if (name === 'title' && !prev.slug_manually_edited) {
        updates.slug = generateSlug(value);
      }
      if (name === 'slug') {
        updates.slug_manually_edited = true;
      }
      return { ...prev, ...updates };
    });
  };

  const handleEditFormChange = (e) => {
    const { name, value, type, checked } = e.target;
    setEditForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (checked ? 1 : 0) : value
    }));
    // Clear stale success banner so a re-edit doesn't show "saved" for an
    // old state.
    setSuccessSection(null);
  };

  const handleCreateSection = async (e) => {
    e.preventDefault();
    try {
      setSavingSection(true);
      setError(null);

      const payload = {
        ...newSectionForm,
        active: Number(newSectionForm.active),
        display_order: Number(newSectionForm.display_order),
        max_visible_items: Number(newSectionForm.max_visible_items),
        show_see_all: Number(newSectionForm.show_see_all),
        show_hot_badge: Number(newSectionForm.show_hot_badge),
        section_icon: newSectionForm.section_icon || null,
        linked_category_id: newSectionForm.linked_category_id ? Number(newSectionForm.linked_category_id) : null,
        linked_offer_id: newSectionForm.linked_offer_id ? Number(newSectionForm.linked_offer_id) : null,
        starts_at: localInputToUtcIso(newSectionForm.starts_at),
        ends_at: localInputToUtcIso(newSectionForm.ends_at)
      };

      await MobileDashboardApi.createSection(payload);
      setIsModalOpen(false);

      // Reset form
      setNewSectionForm({
        title: '',
        slug: '',
        section_type: 'product_block',
        store_type: storeType,
        active: 1,
        display_order: 0,
        max_visible_items: DEFAULT_MAX_VISIBLE_BY_SECTION.product_block,
        show_see_all: 1,
        show_hot_badge: 0,
        section_icon: '',
        linked_category_id: '',
        linked_offer_id: '',
        starts_at: '',
        ends_at: ''
      });

      await fetchSections();
    } catch (err) {
      console.error(err);
      setError(err?.response?.data?.message || GENERIC_ERROR);
    } finally {
      setSavingSection(false);
    }
  };

  const handleUpdateSection = async (e) => {
    e.preventDefault();
    if (!selectedSection) return;
    try {
      setSavingSection(true);
      setError(null);

      if (selectedSection.section_type === 'offer_banner' && editForm.store_type === 'all') {
        setError('Please convert "all" store mode offer banners to specific "packed" or "fast_food" mode before saving.');
        setSavingSection(false);
        return;
      }

      const payload = {
        ...editForm,
        active: Number(editForm.active),
        display_order: Number(editForm.display_order),
        max_visible_items: Number(editForm.max_visible_items),
        show_see_all: Number(editForm.show_see_all),
        show_hot_badge: Number(editForm.show_hot_badge),
        section_icon: editForm.section_icon || null,
        linked_category_id: editForm.linked_category_id ? Number(editForm.linked_category_id) : null,
        linked_offer_id: editForm.linked_offer_id ? Number(editForm.linked_offer_id) : null,
        starts_at: localInputToUtcIso(editForm.starts_at),
        ends_at: localInputToUtcIso(editForm.ends_at)
      };

      const res = await MobileDashboardApi.updateSection(selectedSection.id, payload);
      setSuccessSection('Section updated successfully');

      // Refresh section detail to get next version
      await fetchSectionDetail(selectedSection.id);
      await fetchSections();
    } catch (err) {
      console.error(err);
      // Surface the backend's specific message — 409 version conflicts are
      // important to distinguish from generic failures.
      const code = err?.response?.data?.code;
      const msg = err?.response?.data?.message || err?.message;
      if (code === 'CONCURRENCY_CONFLICT') {
        setError('This section was updated by another admin. Reloading the latest version…');
        await fetchSectionDetail(selectedSection.id);
      } else {
        setError(msg || GENERIC_ERROR);
      }
    } finally {
      setSavingSection(false);
    }
  };

  const handleDeleteSection = async () => {
    if (!selectedSection) return;
    if (!window.confirm('Are you sure you want to delete this section? This will soft-delete the layout configuration.')) return;
    try {
      setSavingSection(true);
      setError(null);
      await MobileDashboardApi.deleteSection(selectedSection.id);
      setSelectedSection(null);
      setEditForm(null);
      await fetchSections();
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setSavingSection(false);
    }
  };

  // Optimistic reorder: update the UI immediately, then persist in the
  // background. Waiting on the network round-trip before repainting is what
  // made drag/reorder feel like a ~2s freeze; the backend call itself is fast.
  const applySectionOrder = (newSections) => {
    const withOrder = newSections.map((section, displayOrder) => ({
      ...section,
      display_order: displayOrder,
    }));
    setSections(withOrder);
    MobileDashboardApi
      .reorderSections(withOrder.map(s => s.id), { store_type: storeType })
      .catch(err => {
        console.error(err);
        setError(GENERIC_ERROR);
        fetchSections();
      });
  };

  const draggedSectionIndex = useRef(null);
  const [activeDragIndex, setActiveDragIndex] = useState(null);
  const [dragOverSectionIndex, setDragOverSectionIndex] = useState(null);

  const handleSectionDragStart = (index) => {
    draggedSectionIndex.current = index;
    setActiveDragIndex(index);
  };

  const handleSectionDragOver = (index, e) => {
    e.preventDefault();
    if (dragOverSectionIndex !== index) setDragOverSectionIndex(index);
  };

  const handleSectionDrop = (dropIndex) => {
    const fromIndex = draggedSectionIndex.current;
    draggedSectionIndex.current = null;
    setActiveDragIndex(null);
    setDragOverSectionIndex(null);
    if (fromIndex === null || fromIndex === dropIndex) return;

    const newSections = [...sections];
    const [moved] = newSections.splice(fromIndex, 1);
    newSections.splice(dropIndex, 0, moved);
    applySectionOrder(newSections);
  };

  const handleSectionDragEnd = () => {
    draggedSectionIndex.current = null;
    setActiveDragIndex(null);
    setDragOverSectionIndex(null);
  };

  const handleAddItem = async (itemId) => {
    if (!selectedSection || addingItemRef.current) return;
    addingItemRef.current = true;
    try {
      setSavingItem(true);
      setAddingItemId(itemId);
      setError(null);

      const sectionTypeToItemType = {
        offer_banner: 'offer',
        category_grid: 'category',
        product_block: 'product',
        combo_block: 'combo'
      };

      const itemType = sectionTypeToItemType[selectedSection.section_type];

      // Calculate display order as max + 1
      const currentItems = selectedSection.items || [];
      const nextOrder = currentItems.length > 0
        ? Math.max(...currentItems.map(item => item.display_order || 0)) + 1
        : 0;

      // The backend now returns the newly-created item already hydrated with
      // its product/category/combo/offer details, so we can append it locally
      // instead of paying for a second network round-trip (a full section
      // refetch that re-hydrates every existing item too). That second
      // round-trip was the real source of the multi-second "Add" lag,
      // especially on a production DB where each query carries real latency.
      const res = await MobileDashboardApi.addSectionItem(selectedSection.id, {
        item_type: itemType,
        item_id: itemId,
        display_order: nextOrder,
        active: 1
      });

      const newItem = res?.data;
      if (newItem) {
        setSelectedSection(prev => ({ ...prev, items: [...(prev.items || []), newItem] }));
      } else {
        // Fallback, e.g. against an older API build without the hydrated item.
        await fetchSectionDetail(selectedSection.id);
      }
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      addingItemRef.current = false;
      setSavingItem(false);
      setAddingItemId(null);
    }
  };

  const [removeConfirmItem, setRemoveConfirmItem] = useState(null);

  const confirmRemoveItem = async () => {
    if (!selectedSection || !removeConfirmItem) return;
    const sectionItemId = removeConfirmItem.id;
    setRemoveConfirmItem(null);

    // Optimistic: drop it from the list immediately, persist in the
    // background, restore (via a real refetch) only if the delete fails.
    const previousItems = selectedSection.items || [];
    setSelectedSection(prev => ({ ...prev, items: prev.items.filter(i => i.id !== sectionItemId) }));
    setSavingItem(true);
    try {
      await MobileDashboardApi.deleteSectionItem(selectedSection.id, sectionItemId);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
      setSelectedSection(prev => ({ ...prev, items: previousItems }));
    } finally {
      setSavingItem(false);
    }
  };

  // Optimistic: repaint immediately, persist in the background.
  const applyItemOrder = (newItems) => {
    setSelectedSection(prev => ({ ...prev, items: newItems }));
    MobileDashboardApi
      .reorderSectionItems(selectedSection.id, newItems.map(item => item.id))
      .catch(err => {
        console.error(err);
        setError(GENERIC_ERROR);
        fetchSectionDetail(selectedSection.id);
      });
  };

  const handleMoveItem = (index, direction) => {
    if (!selectedSection) return;
    const items = selectedSection.items || [];
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === items.length - 1) return;

    const newItems = [...items];
    const swapWith = direction === 'up' ? index - 1 : index + 1;

    const temp = newItems[index];
    newItems[index] = newItems[swapWith];
    newItems[swapWith] = temp;
    applyItemOrder(newItems);
  };

  // Item drag-and-drop (used inside the "Rearrange Items" modal, where there's
  // room to do it properly instead of the cramped inline arrow buttons).
  const [isRearrangeOpen, setIsRearrangeOpen] = useState(false);
  const draggedItemIndex = useRef(null);
  const [activeItemDragIndex, setActiveItemDragIndex] = useState(null);
  const [dragOverItemIndex, setDragOverItemIndex] = useState(null);

  const handleItemDragStart = (index) => {
    draggedItemIndex.current = index;
    setActiveItemDragIndex(index);
  };

  const handleItemDragOver = (index, e) => {
    e.preventDefault();
    if (dragOverItemIndex !== index) setDragOverItemIndex(index);
  };

  const handleItemDrop = (dropIndex) => {
    const fromIndex = draggedItemIndex.current;
    draggedItemIndex.current = null;
    setActiveItemDragIndex(null);
    setDragOverItemIndex(null);
    if (fromIndex === null || fromIndex === dropIndex) return;

    const items = selectedSection?.items || [];
    const newItems = [...items];
    const [moved] = newItems.splice(fromIndex, 1);
    newItems.splice(dropIndex, 0, moved);
    applyItemOrder(newItems);
  };

  const handleItemDragEnd = () => {
    draggedItemIndex.current = null;
    setActiveItemDragIndex(null);
    setDragOverItemIndex(null);
  };

  const getShopLabel = (details) => details?.shop_name || 'Home';

  const getFilteredCandidates = () => {
    let list = candidates;

    if (shopFilter === 'home') {
      list = list.filter(item => !item.shop_id);
    } else if (shopFilter) {
      list = list.filter(item => String(item.shop_id ?? '') === String(shopFilter));
    }

    if (categoryFilter) {
      list = list.filter(item => String(item.category_id ?? '') === String(categoryFilter));
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      list = list.filter(item => {
        const name = item.name || item.title || '';
        return name.toLowerCase().includes(query);
      });
    }

    return list;
  };

  // Shop/category filters only make sense for product_block — combos have no
  // shop_id, and category/offer sections' candidates ARE categories/offers.
  const showAssignFilters = selectedSection?.section_type === 'product_block';

  if (isAllAreas) {
    return <PickAreaNotice label="App Home" />;
  }

  return (
    <div>
      {/* Status banners */}
      {error && (
        <div className="error-container" style={{ marginBottom: '1rem' }}>{error}</div>
      )}
      {successSection && (
        <div
          role="status"
          style={{
            marginBottom: '1rem',
            padding: '10px 14px',
            background: 'rgba(34, 197, 94, 0.1)',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            color: '#15803d',
            borderRadius: 8,
            fontSize: '0.9rem',
            fontWeight: 600,
          }}
        >
          ✅ {successSection}
        </div>
      )}

    <div className="dashboard-workspace">
      {/* Left Panel: Section Selector */}
      <aside className="sections-panel">
        <header className="panel-header">
          <h2 className="panel-title">Layout Sections</h2>
          <button className="btn-add-section" onClick={() => setIsModalOpen(true)}>
            + Add Section
          </button>
        </header>

        <div style={{ display: 'flex', gap: '0.5rem', padding: '0 1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {modes.map(m => (
          <button
            key={m.slug}
            className={`btn-secondary ${storeType === m.slug ? 'active' : ''}`}
            style={storeType === m.slug ? { background: 'var(--primary-color)', color: 'white', borderColor: 'var(--primary-color)' } : {}}
            onClick={() => {
              setStoreType(m.slug);
              setSelectedSection(null);
              setEditForm(null);
            }}
          >
            {m.label} Layout
          </button>
        ))}
      </div>

        <div className="sections-list-container">
          {loadingSections && sections.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>Loading layout...</div>
          ) : sections.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
              No layout sections configured.
            </div>
          ) : (
            sections.map((sec, index) => (
              <div
                key={sec.id}
                className={`section-card ${selectedSection?.id === sec.id ? 'selected' : ''} ${dragOverSectionIndex === index ? 'drag-over' : ''} ${activeDragIndex === index ? 'dragging' : ''}`}
                draggable
                onDragStart={() => handleSectionDragStart(index)}
                onDragOver={(e) => handleSectionDragOver(index, e)}
                onDrop={() => handleSectionDrop(index)}
                onDragEnd={handleSectionDragEnd}
                onClick={() => fetchSectionDetail(sec.id)}
              >
                <span className="section-drag-handle" title="Drag to reorder" aria-hidden="true">
                  <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                    <circle cx="6" cy="4" r="1.5" /><circle cx="14" cy="4" r="1.5" />
                    <circle cx="6" cy="10" r="1.5" /><circle cx="14" cy="10" r="1.5" />
                    <circle cx="6" cy="16" r="1.5" /><circle cx="14" cy="16" r="1.5" />
                  </svg>
                </span>
                <div className="section-meta-info">
                  <span className="section-card-title">{sec.title}</span>
                  <div className="section-card-badges">
                    <span className="badge badge-type">{sec.section_type.replace('_', ' ')}</span>
                    <span className="badge badge-store">{sec.store_type}</span>
                    <span className={`badge ${sec.active ? 'badge-status-active' : 'badge-status-hidden'}`}>
                      {sec.active ? 'Active' : 'Hidden'}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Right Panel: Selected Section Details & Workspace */}
      <section className="detail-panel">
        {selectedSection && editForm ? (
          <>
            <header className="detail-header-bar">
              <h2 className="detail-title">{selectedSection.title} Details</h2>
              <button 
                className="btn-danger" 
                style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                onClick={handleDeleteSection}
                disabled={savingSection}
              >
                Delete Section
              </button>
            </header>

            <div className="detail-body-container">
              {/* Properties Form */}
              <form onSubmit={handleUpdateSection} className="form-section">
                <h3 style={{ fontSize: '1rem', fontWeight: 600, borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                  Section Properties
                </h3>
                
                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">
                      Section Title{editForm.section_type === 'category_grid' ? ' (optional)' : ''}
                    </label>
                    <input
                      type="text"
                      name="title"
                      required={editForm.section_type !== 'category_grid'}
                      placeholder={editForm.section_type === 'category_grid' ? 'Leave blank to hide the header' : ''}
                      className="form-input"
                      value={editForm.title}
                      onChange={handleEditFormChange}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Slug</label>
                    <input 
                      type="text" 
                      name="slug" 
                      required 
                      className="form-input" 
                      value={editForm.slug} 
                      onChange={handleEditFormChange} 
                    />
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">Store Visibility</label>
                    <select 
                      name="store_type" 
                      className="form-select" 
                      value={editForm.store_type} 
                      onChange={handleEditFormChange}
                    >
                      <option value="all">All Stores (legacy)</option>
                      {modes.map(m => <option key={m.slug} value={m.slug}>{m.label} Only</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      {selectedSection.section_type === 'offer_banner' ? 'Active Banners in Rotation' : 'Max Display Items'}
                    </label>
                    <input 
                      type="number" 
                      name="max_visible_items" 
                      min="1" 
                      className="form-input" 
                      value={editForm.max_visible_items} 
                      onChange={handleEditFormChange} 
                    />
                    {selectedSection.section_type === 'offer_banner' && (
                      <div className="form-hint">
                        Add multiple active offer banners below. The customer app rotates them every 4 seconds.
                      </div>
                    )}
                  </div>
                </div>

                <div className="form-grid-2">
                  {editForm.section_type === 'category_grid' && (
                    <div className="form-group">
                      <label className="form-label">Linked Category (optional)</label>
                      <select
                        name="linked_category_id"
                        className="form-select"
                        value={editForm.linked_category_id}
                        onChange={handleEditFormChange}
                      >
                        <option value="">— None —</option>
                        {allCategories.map(c => (
                          <option key={c.id} value={c.id}>{c.name} ({modeLabel(modes, c.type)})</option>
                        ))}
                      </select>
                      <div className="form-hint">When set, the customer app auto-pins this section to the chosen category and jumps straight to its products.</div>
                    </div>
                  )}
                  {editForm.section_type === 'offer_banner' && (
                    <div className="form-group">
                      <label className="form-label">Linked Offer (optional)</label>
                      <select
                        name="linked_offer_id"
                        className="form-select"
                        value={editForm.linked_offer_id}
                        onChange={handleEditFormChange}
                      >
                        <option value="">— None —</option>
                        {allOffers.map(o => (
                          <option key={o.id} value={o.id}>{o.title || `Offer #${o.id}`} ({o.store_type === 'all' ? 'All' : modeLabel(modes, o.store_type)})</option>
                        ))}
                      </select>
                      <div className="form-hint">When set, the banner is the dedicated rotation for this single offer instead of a multi-offer carousel.</div>
                    </div>
                  )}
                </div>

                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">Scheduled Start Time</label>
                    <input 
                      type="datetime-local" 
                      name="starts_at" 
                      className="form-input" 
                      value={editForm.starts_at} 
                      onChange={handleEditFormChange} 
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Scheduled End Time</label>
                    <input 
                      type="datetime-local" 
                      name="ends_at" 
                      className="form-input" 
                      value={editForm.ends_at} 
                      onChange={handleEditFormChange} 
                    />
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">Section Icon (shown before title in customer app)</label>
                    <select
                      name="section_icon"
                      className="form-select"
                      value={editForm.section_icon || ''}
                      onChange={handleEditFormChange}
                    >
                      <option value="">— Default (based on section type) —</option>
                      <option value="box">Box (categories)</option>
                      <option value="shoppingBag">Shopping Bag (products)</option>
                      <option value="star">Star (combos / special)</option>
                      <option value="ticket">Ticket (offers)</option>
                      <option value="home">Home</option>
                      <option value="heart">Heart (favourites)</option>
                      <option value="clock">Clock (timed)</option>
                      <option value="search">Search</option>
                      <option value="settings">Settings</option>
                    </select>
                    <div className="form-hint">Leave blank to use the section-type default icon.</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Display</label>
                    <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem' }}>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="active" 
                          checked={editForm.active === 1} 
                          onChange={e => handleEditFormChange({ target: { name: 'active', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        Active
                      </label>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="show_see_all" 
                          checked={editForm.show_see_all === 1} 
                          onChange={e => handleEditFormChange({ target: { name: 'show_see_all', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        "See All"
                      </label>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="show_hot_badge" 
                          checked={editForm.show_hot_badge === 1} 
                          onChange={e => handleEditFormChange({ target: { name: 'show_hot_badge', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        HOT badge
                      </label>
                    </div>
                  </div>
                </div>

                <div className="form-actions-row">
                  <button type="submit" className="btn-primary" disabled={savingSection}>
                    {savingSection ? 'Saving...' : 'Save Properties'}
                  </button>
                </div>
              </form>

              {/* Items Management */}
              <div className="section-items-workspace">
                <div className="items-workspace-header">
                  <h3 className="items-workspace-title">
                    Assigned Items ({selectedSection.items?.length || 0})
                  </h3>
                  <button
                    type="button"
                    className="btn-secondary btn-rearrange"
                    onClick={() => setIsRearrangeOpen(true)}
                    disabled={(selectedSection.items?.length || 0) < 2}
                  >
                    ⇅ Rearrange
                  </button>
                </div>

                <div className="items-list">
                  {selectedSection.items?.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                      No items currently assigned to this section. Use the selector below to add them.
                    </div>
                  ) : (
                    selectedSection.items?.map((item, idx) => {
                      const details = item.details || {};
                      const name = details.name || details.title || `Item #${item.item_id}`;
                      const img = normalizeImageUrl(details.imageUrl || details.image_url) || FALLBACK_IMAGE;
                      return (
                        <div key={item.id} className="item-row">
                          <img src={img} onError={handleImageError} alt={name} className="item-thumbnail" />
                          <div className="item-details">
                            <div className="item-title-name">
                              <span className="item-name-text">{name}</span>
                              <span className="item-shop-tag">{getShopLabel(details)}</span>
                            </div>
                            <div className="item-subtitle-meta">
                              {item.item_type} • ID: {item.item_id}
                              {details.price && ` • ₹${details.price}`}
                              {(details.store_type || details.type) && ` • ${modeLabel(modes, details.store_type || details.type)}`}
                              {item.item_type === 'offer' && ` • ${details.active ? 'Active' : 'Inactive'}`}
                            </div>
                          </div>
                          <div className="item-action-controls">
                            <button
                              className="btn-order-arrow"
                              disabled={idx === 0}
                              onClick={() => handleMoveItem(idx, 'up')}
                            >
                              ▲
                            </button>
                            <button
                              className="btn-order-arrow"
                              disabled={idx === selectedSection.items.length - 1}
                              onClick={() => handleMoveItem(idx, 'down')}
                            >
                              ▼
                            </button>
                            <button
                              className="btn-remove-item"
                              onClick={() => setRemoveConfirmItem({ id: item.id, name })}
                              disabled={savingItem}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Add Items trigger */}
              <div className="add-items-trigger">
                <button type="button" className="btn-primary btn-assign-open" onClick={() => setIsAssignOpen(true)}>
                  + Assign New Item
                </button>
              </div>

            </div>
          </>
        ) : (
          <div className="detail-empty-state">
            <span className="empty-state-icon">📱</span>
            <h2>Mobile Layout Editor</h2>
            <p>Select any section from the list to manage its visibility, timing, settings, and layout items.</p>
          </div>
        )}
      </section>

      {/* Add Section Modal */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <form onSubmit={handleCreateSection}>
              <header className="modal-header">
                <h3 className="modal-title">New Dashboard Section</h3>
                <button type="button" style={{ background: 'none', border: 'none', color: 'var(--text-on-primary)', fontSize: '1.5rem' }} onClick={() => setIsModalOpen(false)}>&times;</button>
              </header>

              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">
                    Section Title{newSectionForm.section_type === 'category_grid' ? ' (optional)' : ''}
                  </label>
                  <input
                    type="text"
                    name="title"
                    required={newSectionForm.section_type !== 'category_grid'}
                    placeholder={newSectionForm.section_type === 'category_grid' ? 'Leave blank to hide the header' : 'e.g. Milk Products, Daily Banners'}
                    className="form-input"
                    value={newSectionForm.title}
                    onChange={handleModalFormChange}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Slug (URL friendly)</label>
                  <input 
                    type="text" 
                    name="slug" 
                    required 
                    className="form-input" 
                    value={newSectionForm.slug} 
                    onChange={handleModalFormChange} 
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Section Type</label>
                  <select
                    name="section_type"
                    className="form-select"
                    value={newSectionForm.section_type}
                    onChange={handleModalFormChange}
                  >
                    <option value="offer_banner">Offer Banner</option>
                    <option value="category_grid">Category Grid</option>
                    <option value="product_block">Product Block</option>
                    <option value="combo_block">Combo Block</option>
                  </select>
                </div>

                {newSectionForm.section_type === 'category_grid' && (
                  <div className="form-group">
                    <label className="form-label">Linked Category (optional)</label>
                    <select
                      name="linked_category_id"
                      className="form-select"
                      value={newSectionForm.linked_category_id}
                      onChange={handleModalFormChange}
                    >
                      <option value="">— None —</option>
                      {allCategories.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({modeLabel(modes, c.type)})</option>
                      ))}
                    </select>
                    <div className="form-hint">When set, the customer app auto-pins this section to the chosen category and jumps straight to its products.</div>
                  </div>
                )}

                {newSectionForm.section_type === 'offer_banner' && (
                  <div className="form-group">
                    <label className="form-label">Linked Offer (optional)</label>
                    <select
                      name="linked_offer_id"
                      className="form-select"
                      value={newSectionForm.linked_offer_id}
                      onChange={handleModalFormChange}
                    >
                      <option value="">— None —</option>
                      {allOffers.map(o => (
                        <option key={o.id} value={o.id}>{o.title || `Offer #${o.id}`} ({o.store_type === 'all' ? 'All' : modeLabel(modes, o.store_type)})</option>
                      ))}
                    </select>
                    <div className="form-hint">When set, the banner is the dedicated rotation for this single offer instead of a multi-offer carousel.</div>
                  </div>
                )}

                <div className="form-group">
                  <label className="form-label">Store Visibility</label>
                  <select 
                    name="store_type" 
                    className="form-select" 
                    value={newSectionForm.store_type} 
                    onChange={handleModalFormChange}
                  >
                    {modes.map(m => <option key={m.slug} value={m.slug}>{m.label} Only</option>)}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">
                    {newSectionForm.section_type === 'offer_banner' ? 'Active Banners in Rotation' : 'Max Visible Items'}
                  </label>
                  <input 
                    type="number" 
                    name="max_visible_items" 
                    min="1" 
                    className="form-input" 
                    value={newSectionForm.max_visible_items} 
                    onChange={handleModalFormChange} 
                  />
                  {newSectionForm.section_type === 'offer_banner' && (
                    <div className="form-hint">
                      Add 2 or more active offer banners after creating this section. The customer app loops them every 4 seconds.
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label font-medium">Scheduled Visibility (Optional)</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.25rem' }}>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Starts At</span>
                      <input 
                        type="datetime-local" 
                        name="starts_at" 
                        className="form-input" 
                        value={newSectionForm.starts_at} 
                        onChange={handleModalFormChange} 
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Ends At</span>
                      <input 
                        type="datetime-local" 
                        name="ends_at" 
                        className="form-input" 
                        value={newSectionForm.ends_at} 
                        onChange={handleModalFormChange} 
                      />
                    </div>
                  </div>
                </div>

                <div className="form-grid-2">
                  <div className="form-group">
                    <label className="form-label">Section Icon</label>
                    <select
                      name="section_icon"
                      className="form-select"
                      value={newSectionForm.section_icon || ''}
                      onChange={handleModalFormChange}
                    >
                      <option value="">— Default (based on section type) —</option>
                      <option value="box">Box (categories)</option>
                      <option value="shoppingBag">Shopping Bag (products)</option>
                      <option value="star">Star (combos / special)</option>
                      <option value="ticket">Ticket (offers)</option>
                      <option value="home">Home</option>
                      <option value="heart">Heart (favourites)</option>
                      <option value="clock">Clock (timed)</option>
                      <option value="search">Search</option>
                      <option value="settings">Settings</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Display</label>
                    <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.5rem' }}>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="active" 
                          checked={newSectionForm.active === 1} 
                          onChange={e => handleModalFormChange({ target: { name: 'active', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        Active
                      </label>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="show_see_all" 
                          checked={newSectionForm.show_see_all === 1} 
                          onChange={e => handleModalFormChange({ target: { name: 'show_see_all', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        "See All"
                      </label>
                      <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input 
                          type="checkbox" 
                          name="show_hot_badge" 
                          checked={newSectionForm.show_hot_badge === 1} 
                          onChange={e => handleModalFormChange({ target: { name: 'show_hot_badge', checked: e.target.checked, type: 'checkbox' } })} 
                        />
                        HOT badge
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setIsModalOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={savingSection}>
                  {savingSection ? 'Creating...' : 'Create Section'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Remove Item Confirm */}
      {removeConfirmItem && (
        <div className="modal-overlay" onClick={() => setRemoveConfirmItem(null)}>
          <div className="modal-content confirm-modal" onClick={e => e.stopPropagation()}>
            <header className="modal-header modal-header-danger">
              <h3 className="modal-title">Remove Item</h3>
              <button type="button" style={{ background: 'none', border: 'none', color: 'var(--text-on-primary)', fontSize: '1.5rem' }} onClick={() => setRemoveConfirmItem(null)}>&times;</button>
            </header>
            <div className="modal-body">
              <p className="confirm-message">
                Remove <strong>{removeConfirmItem.name}</strong> from this section? It stays in the catalog — this only unassigns it from the layout.
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setRemoveConfirmItem(null)}>Cancel</button>
              <button type="button" className="btn-danger" onClick={confirmRemoveItem}>Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* Assign New Item Modal */}
      {isAssignOpen && selectedSection && (
        <div className="modal-overlay" onClick={() => setIsAssignOpen(false)}>
          <div className="modal-content assign-modal" onClick={e => e.stopPropagation()}>
            <header className="modal-header">
              <h3 className="modal-title">Assign Item — {selectedSection.title}</h3>
              <button type="button" style={{ background: 'none', border: 'none', color: 'var(--text-on-primary)', fontSize: '1.5rem' }} onClick={() => setIsAssignOpen(false)}>&times;</button>
            </header>

            <div className="modal-body">
              <div className="assign-filters-row">
                <input
                  type="text"
                  placeholder="Search available candidates..."
                  className="form-input assign-search-input"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {showAssignFilters && (
                  <>
                    <select className="form-select" value={shopFilter} onChange={e => setShopFilter(e.target.value)}>
                      <option value="">All Shops</option>
                      <option value="home">Home (No Shop)</option>
                      {allShops.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <select className="form-select" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
                      <option value="">All Categories</option>
                      {allCategories
                        .filter(c => !c.type || c.type === storeType)
                        .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </>
                )}
              </div>

              <div className="picker-results assign-results">
                {loadingCandidates ? (
                  <div style={{ padding: '1rem', textAlign: 'center' }}>Loading candidates...</div>
                ) : getFilteredCandidates().filter(cand => !selectedSection.items?.some(i => String(i.item_id) === String(cand.id))).length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No items found.
                  </div>
                ) : (
                  getFilteredCandidates()
                    .filter(cand => {
                      // Exclude items already in this section
                      return !selectedSection.items?.some(i => String(i.item_id) === String(cand.id));
                    })
                    .map(cand => {
                      const name = cand.name || cand.title || 'Unnamed';
                      const img = normalizeImageUrl(cand.imageUrl || cand.image_url);

                      const isOfferBanner = selectedSection.section_type === 'offer_banner';
                      const hasImage = !!img;
                      const isInactiveOffer = isOfferBanner && !(cand.active === 1 || cand.active === true);
                      const disabled = (isOfferBanner && (!hasImage || isInactiveOffer)) || addingItemId === cand.id;

                      return (
                        <div key={cand.id} className={`picker-result-row ${disabled ? 'disabled-item' : ''}`}>
                          <img src={img || FALLBACK_IMAGE} onError={handleImageError} alt={name} className="item-thumbnail" style={disabled ? { opacity: 0.5 } : {}} />
                          <div style={{ flex: 1, minWidth: 0, opacity: disabled ? 0.6 : 1 }}>
                            <div className="item-title-name">
                              <span className="item-name-text">{name}</span>
                              {!isOfferBanner && <span className="item-shop-tag">{getShopLabel(cand)}</span>}
                            </div>
                            <div className="item-subtitle-meta">
                              ID: {cand.id}
                              {cand.price && ` • ₹${cand.price}`}
                              {cand.store_type && ` • ${modeLabel(modes, cand.store_type)}`}
                              {cand.type && ` • ${modeLabel(modes, cand.type)}`}
                              {isOfferBanner && ` • ${cand.active ? 'Active' : 'Inactive'}`}
                              {isOfferBanner && ` • ${cand.isClickable || cand.is_clickable ? 'Clickable' : 'Image only'}`}
                              {isOfferBanner && !hasImage && <span style={{color: 'var(--danger-color)'}}> • Missing image</span>}
                              {isInactiveOffer && <span style={{color: 'var(--danger-color)'}}> • Activate offer first</span>}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn-primary btn-add-item-action"
                            onClick={() => handleAddItem(cand.id)}
                            disabled={savingItem || disabled}
                          >
                            {addingItemId === cand.id ? 'Adding...' : '+ Add'}
                          </button>
                        </div>
                      );
                    })
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={() => setIsAssignOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Rearrange Items Modal */}
      {isRearrangeOpen && selectedSection && (
        <div className="modal-overlay" onClick={() => setIsRearrangeOpen(false)}>
          <div className="modal-content rearrange-modal" onClick={e => e.stopPropagation()}>
            <header className="modal-header">
              <h3 className="modal-title">Rearrange Items — {selectedSection.title}</h3>
              <button type="button" style={{ background: 'none', border: 'none', color: 'var(--text-on-primary)', fontSize: '1.5rem' }} onClick={() => setIsRearrangeOpen(false)}>&times;</button>
            </header>

            <div className="modal-body">
              <p className="rearrange-hint">Drag items into the order they should appear in the customer app.</p>
              <div className="rearrange-list">
                {(selectedSection.items || []).map((item, idx) => {
                  const details = item.details || {};
                  const name = details.name || details.title || `Item #${item.item_id}`;
                  const img = normalizeImageUrl(details.imageUrl || details.image_url) || FALLBACK_IMAGE;
                  return (
                    <div
                      key={item.id}
                      className={`rearrange-row ${dragOverItemIndex === idx ? 'drag-over' : ''} ${activeItemDragIndex === idx ? 'dragging' : ''}`}
                      draggable
                      onDragStart={() => handleItemDragStart(idx)}
                      onDragOver={(e) => handleItemDragOver(idx, e)}
                      onDrop={() => handleItemDrop(idx)}
                      onDragEnd={handleItemDragEnd}
                    >
                      <span className="section-drag-handle" aria-hidden="true">
                        <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
                          <circle cx="6" cy="4" r="1.5" /><circle cx="14" cy="4" r="1.5" />
                          <circle cx="6" cy="10" r="1.5" /><circle cx="14" cy="10" r="1.5" />
                          <circle cx="6" cy="16" r="1.5" /><circle cx="14" cy="16" r="1.5" />
                        </svg>
                      </span>
                      <span className="rearrange-position">{idx + 1}</span>
                      <img src={img} onError={handleImageError} alt={name} className="item-thumbnail" />
                      <div className="item-details">
                        <div className="item-title-name">
                          <span className="item-name-text">{name}</span>
                          <span className="item-shop-tag">{getShopLabel(details)}</span>
                        </div>
                        <div className="item-subtitle-meta">{item.item_type} • ID: {item.item_id}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={() => setIsRearrangeOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
