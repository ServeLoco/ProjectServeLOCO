import React, { useState, useEffect, useCallback } from 'react';
import { CouponsApi, CustomersApi, DeliveryZonesApi } from '../api';
import { Loading, ErrorState, EmptyState } from '../components/SharedUI';
import { useStoreModes } from '../hooks/useStoreModes';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Coupons.css';

const DISCOUNT_TYPES = [
  { value: 'flat', label: 'Flat Rs off' },
  { value: 'percent', label: 'Percentage % off' },
  { value: 'free_delivery', label: 'Free Delivery' },
];

const TARGET_AUDIENCE_OPTIONS = [
  { value: 'all', label: 'All Users' },
  { value: 'selected', label: 'Selected Users' },
];

const TARGET_ZONES_OPTIONS = [
  { value: 'all', label: 'All Zones' },
  { value: 'selected', label: 'Selected Zones' },
];

const zoneSizeLabel = (zone) => {
  const extent = Number(zone.extentKm ?? zone.extent_km);
  const size = Number.isFinite(extent) ? ` (~${extent}km)` : '';
  return `${zone.name || `Zone #${zone.id}`}${size}`;
};

// Future templates to consider (not yet shipped):
//   - Flash Sale: short window, percent off, very high priority
//   - Weekend Special: recurring Saturday/Sunday discount
//   - Win-back / Lapsed Customer: auto-apply for users with no orders in N days
//   - Happy Hour: specific time window per day with percent off
//   - Bulk / Bundle Unlock: item-count gating with capped value
//   - Referral Reward: targeted at users who referred a friend
//   - Store-Type Combo Deal: applies_to = packed+fast_food combo
//   - Loyalty / Repeat-Customer Reward: targeted, Nth-order milestone
const COUPON_TEMPLATES = [
  {
    id: 'welcome',
    label: 'Welcome Coupon',
    description: 'One-time automatic discount for new customers.',
    icon: '\uD83C\uDF89',
    fieldGroups: [
      'title', 'code', 'description',
      'discount_type', 'discount_value', 'max_discount_amount',
      'requires_code', 'auto_apply',
    ],
    buildDefaults: () => ({
      ...EMPTY_FORM,
      discount_type: 'flat',
      requires_code: false,
      auto_apply: true,
      first_order_only: true,
      per_user_usage_limit: '1',
      target_audience: 'all',
      applies_to: 'all',
      active: true,
    }),
  },
  {
    id: 'min_order',
    label: 'Minimum Order Coupon',
    description: 'Discount or free delivery when cart meets an amount or item count.',
    icon: '\uD83D\uDED2',
    fieldGroups: [
      'title', 'code', 'description',
      'min_order_amount', 'min_item_count',
      'discount_type', 'discount_value', 'max_discount_amount',
      'free_delivery_toggle',
      'requires_code', 'auto_apply',
      'limit_one_per_customer',
    ],
    buildDefaults: () => ({
      ...EMPTY_FORM,
      min_order_amount: '',
      min_item_count: '',
      first_order_only: false,
      target_audience: 'all',
      applies_to: 'all',
      active: true,
    }),
  },
  {
    id: 'custom',
    label: 'Custom Coupon',
    description: 'Full control over validity windows, targeting, and usage limits.',
    icon: '\u2699\uFE0F',
    fieldGroups: ['*'],
    buildDefaults: () => ({ ...EMPTY_FORM }),
  },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_COLORS = {
  Active: 'status-active',
  Scheduled: 'status-scheduled',
  Expired: 'status-expired',
  Inactive: 'status-inactive',
  Deleted: 'status-deleted',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'SERVE-';

const generateReadableCode = (length = 4) => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return `${CODE_PREFIX}${out}`;
};

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'expired', label: 'Expired' },
  { value: 'inactive', label: 'Inactive' },
];

const ACTIVE_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'true', label: 'Active only' },
  { value: 'false', label: 'Inactive only' },
];

const EMPTY_FILTERS = { status: '', target_audience: '', applies_to: '', active: '' };

const EMPTY_FORM = {
  code: '', title: '', description: '', discount_type: 'flat', also_free_delivery: false, discount_value: '',
  max_discount_amount: '', min_order_amount: '0', min_item_count: '', max_order_amount: '', applies_to: 'all',
  starts_at: '', ends_at: '', active_days_mask: null, active_time_start: '', active_time_end: '',
  total_usage_limit: '', per_user_usage_limit: '1', first_order_only: false, first_n_orders: '',
  target_audience: 'all', auto_apply: false, requires_code: true, priority: '0', active: true,
  targeted_user_ids: [],
  target_zones: 'all', targeted_zone_ids: [],
};

function CouponPreview({ form }) {
  const isAuto = Boolean(form.auto_apply);
  const requiresCode = form.requires_code !== false;
  const hasCode = Boolean(form.code && form.code.trim());
  const showCodeChip = !isAuto && requiresCode && hasCode;
  const showAutoBadge = isAuto;

  const alsoFreeDelivery = form.discount_type !== 'free_delivery' && Boolean(form.also_free_delivery);
  const freeDeliverySuffix = alsoFreeDelivery ? ' + Free Delivery' : '';

  const savingsText = (() => {
    if (form.discount_type === 'flat') {
      const v = Number(form.discount_value);
      if (!v) return 'Add a discount value';
      if (v > 1000) return `Save Rs.${v} (large discount)${freeDeliverySuffix}`;
      return `Save Rs.${v}${freeDeliverySuffix}`;
    }
    if (form.discount_type === 'percent') {
      const v = Number(form.discount_value);
      if (!v) return 'Add a discount value';
      const cap = Number(form.max_discount_amount);
      return `Save ${v}%${cap ? ` (up to Rs.${cap})` : ''}${freeDeliverySuffix}`;
    }
    if (form.discount_type === 'free_delivery') return 'Free delivery on your order';
    return '';
  })();

  const minOrder = Number(form.min_order_amount || 0);
  const minItemCount = Number(form.min_item_count || 0);
  const minOrderParts = [];
  if (minOrder > 0) minOrderParts.push(`orders above Rs.${minOrder}`);
  if (minItemCount > 0) minOrderParts.push(`${minItemCount}+ items`);
  const minOrderHint = minOrderParts.length > 0 ? `On ${minOrderParts.join(' and ')}` : 'No minimum order';

  const sampleTotal = Math.max(Number(form.min_order_amount || 0), 500);
  const exampleLine = (() => {
    if (form.discount_type === 'flat') {
      const discountedTotal = Math.max(0, sampleTotal - Number(form.discount_value || 0));
      const off = sampleTotal - discountedTotal;
      return `On a \u20B9${sampleTotal} order: customer pays \u20B9${discountedTotal} (\u20B9${off} off)${alsoFreeDelivery ? ' + standard delivery fee waived' : ''}`;
    }
    if (form.discount_type === 'percent') {
      const pct = Number(form.discount_value || 0);
      const maxDiscountAmount = form.max_discount_amount ? Number(form.max_discount_amount) : Infinity;
      const discount = Math.min(sampleTotal * pct / 100, maxDiscountAmount);
      const discountedTotal = Math.max(0, sampleTotal - discount);
      const off = sampleTotal - discountedTotal;
      return `On a \u20B9${sampleTotal} order: customer pays \u20B9${discountedTotal} (\u20B9${off} off)${alsoFreeDelivery ? ' + standard delivery fee waived' : ''}`;
    }
    if (form.discount_type === 'free_delivery') {
      if (minOrder > 0 && minItemCount > 0) {
        return `On orders above \u20B9${minOrder} with ${minItemCount}+ items: standard delivery fee waived`;
      }
      if (minItemCount > 0) {
        return `On orders with ${minItemCount}+ items: standard delivery fee waived`;
      }
      if (minOrder > 0) {
        return `On orders above \u20B9${minOrder}: standard delivery fee waived`;
      }
      return 'On any order: standard delivery fee waived';
    }
    return '';
  })();

  return (
    <div className="coupon-preview">
      <div className="coupon-preview-card">
        <div className="coupon-preview-badges">
          {showAutoBadge && <span className="coupon-preview-auto-badge">AUTO</span>}
          {!showAutoBadge && requiresCode && <span className="coupon-preview-exclusive-badge">EXCLUSIVE</span>}
          {showCodeChip && <span className="coupon-preview-code">{form.code}</span>}
          {!showCodeChip && !showAutoBadge && <span className="coupon-preview-code">NO CODE</span>}
        </div>
        <div className="coupon-preview-title">{form.title || 'Untitled coupon'}</div>
        <div className="coupon-preview-savings">{savingsText}</div>
        <div className="coupon-preview-hint">{minOrderHint}</div>
      </div>
      {exampleLine && <div className="coupon-preview-example">{exampleLine}</div>}
    </div>
  );
}

export default function Coupons() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const { modes } = useStoreModes();
  const appliesToOptions = [
    { value: 'all', label: 'All Orders' },
    ...modes.map(m => ({ value: m.slug, label: `${m.label} Only` })),
  ];
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [showRedemptions, setShowRedemptions] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [redemptionsLoading, setRedemptionsLoading] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [wizardStep, setWizardStep] = useState('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [zones, setZones] = useState([]);

  // 25.4 — Coupons can't be managed for "all" areas at once (the API 400s);
  // skip the doomed fetches and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) return;
    DeliveryZonesApi.list().then(res => setZones(res.data || [])).catch(() => setZones([]));
  }, [isAllAreas]);

  const fetchCoupons = useCallback(async (params = {}) => {
    setLoading(true); setError(null);
    try {
      const queryParams = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
      const res = await CouponsApi.list(queryParams);
      setCoupons(res.data || []);
    }
    catch (err) { setError(err.message || 'Failed to load coupons'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (isAllAreas) { setLoading(false); return; }
    fetchCoupons(filters);
  }, [fetchCoupons, filters, isAllAreas]);

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const handleFilterReset = () => {
    setFilters(EMPTY_FILTERS);
  };

  const handleEdit = async (id) => {
    try {
      const res = await CouponsApi.get(id);
      const c = res.data;
      setForm({
        code: c.code || '', title: c.title || '', description: c.description || '',
        discount_type: c.discount_type || 'flat',
        also_free_delivery: Boolean(c.also_free_delivery),
        discount_value: c.discount_value !== null ? String(c.discount_value) : '',
        max_discount_amount: c.max_discount_amount !== null ? String(c.max_discount_amount) : '',
        min_order_amount: c.min_order_amount !== null ? String(c.min_order_amount) : '0',
        min_item_count: c.min_item_count !== null ? String(c.min_item_count) : '',
        max_order_amount: c.max_order_amount !== null ? String(c.max_order_amount) : '',
        applies_to: c.applies_to || 'all',
        starts_at: c.starts_at ? c.starts_at.slice(0, 16) : '',
        ends_at: c.ends_at ? c.ends_at.slice(0, 16) : '',
        active_days_mask: c.active_days_mask, active_time_start: c.active_time_start || '',
        active_time_end: c.active_time_end || '',
        total_usage_limit: c.total_usage_limit !== null ? String(c.total_usage_limit) : '',
        per_user_usage_limit: c.per_user_usage_limit !== null ? String(c.per_user_usage_limit) : '1',
        first_order_only: Boolean(c.first_order_only),
        first_n_orders: c.first_n_orders !== null ? String(c.first_n_orders) : '',
        target_audience: c.target_audience || 'all', auto_apply: Boolean(c.auto_apply),
        requires_code: c.requires_code !== null ? Boolean(c.requires_code) : true,
        priority: c.priority !== null ? String(c.priority) : '0', active: Boolean(c.active),
        targeted_user_ids: (c.targetedUsers || []).map(u => u.user_id),
        target_zones: c.target_zones || 'all',
        targeted_zone_ids: (c.targetedZones || []).map(z => z.delivery_zone_id),
      });
      setEditingId(id); setShowForm(true); setFormError(null);
      setSelectedTemplateId('custom'); setWizardStep('form');
    } catch (err) { setError(err.message || 'Failed to load coupon'); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this coupon? Historical redemptions will be preserved.')) return;
    try { await CouponsApi.delete(id); fetchCoupons(); }
    catch (err) { setError(err.message || 'Failed to delete coupon'); }
  };

  const handleDuplicate = async (id) => {
    try { await CouponsApi.duplicate(id); fetchCoupons(); }
    catch (err) { setError(err.message || 'Failed to duplicate coupon'); }
  };

  const handleToggleActive = async (coupon) => {
    try { await CouponsApi.update(coupon.id, { active: !coupon.active }); fetchCoupons(); }
    catch (err) { setError(err.message || 'Failed to update coupon'); }
  };

  const handleFormChange = (field, value) => { setForm(prev => ({ ...prev, [field]: value })); };

  const closeForm = () => {
    setShowForm(false);
    setWizardStep('template');
    setSelectedTemplateId(null);
  };

  const handleCreateClick = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setWizardStep('template');
    setSelectedTemplateId(null);
    setShowForm(true);
    setFormError(null);
  };

  const template = COUPON_TEMPLATES.find(t => t.id === selectedTemplateId);
  const showField = (tag) => !template || template.fieldGroups.includes('*') || template.fieldGroups.includes(tag);
  const showAnyField = (...tags) => tags.some(showField);

  const handleAutoGenerateCode = () => {
    setForm(prev => ({ ...prev, code: generateReadableCode() }));
  };

  const handleDayToggle = (dayIndex) => {
    setForm(prev => {
      const current = prev.active_days_mask || 0;
      const bit = 1 << dayIndex;
      const newMask = current & bit ? current & ~bit : current | bit;
      return { ...prev, active_days_mask: newMask === 0 ? null : newMask };
    });
  };

  const handleUserSearch = async (query) => {
    setUserSearch(query);
    if (query.length < 2) { setUserSearchResults([]); return; }
    try { const res = await CustomersApi.list({ search: query, limit: 10 }); setUserSearchResults(res.data || []); }
    catch (_) { setUserSearchResults([]); }
  };

  const handleAddTargetedUser = (user) => {
    if (!form.targeted_user_ids.includes(user.id)) {
      setForm(prev => ({ ...prev, targeted_user_ids: [...prev.targeted_user_ids, user.id] }));
    }
    setUserSearch(''); setUserSearchResults([]);
  };

  const handleRemoveTargetedUser = (userId) => {
    setForm(prev => ({ ...prev, targeted_user_ids: prev.targeted_user_ids.filter(id => id !== userId) }));
  };

  const handleToggleTargetedZone = (zoneId) => {
    setForm(prev => ({
      ...prev,
      targeted_zone_ids: prev.targeted_zone_ids.includes(zoneId)
        ? prev.targeted_zone_ids.filter(id => id !== zoneId)
        : [...prev.targeted_zone_ids, zoneId],
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault(); setSaving(true); setFormError(null);
    try {
      const payload = { ...form };
      if (!payload.code) payload.code = null;
      if (!payload.max_discount_amount) payload.max_discount_amount = null;
      if (!payload.min_item_count) payload.min_item_count = null;
      if (!payload.max_order_amount) payload.max_order_amount = null;
      if (!payload.starts_at) payload.starts_at = null;
      if (!payload.ends_at) payload.ends_at = null;
      if (!payload.active_time_start) payload.active_time_start = null;
      if (!payload.active_time_end) payload.active_time_end = null;
      if (!payload.total_usage_limit) payload.total_usage_limit = null;
      if (!payload.per_user_usage_limit) payload.per_user_usage_limit = null;
      if (!payload.first_n_orders) payload.first_n_orders = null;
      if (payload.discount_type === 'free_delivery') { payload.discount_value = 0; payload.also_free_delivery = false; }

      // Client-side validation for percent discounts
      if (payload.discount_type === 'percent' && (Number(payload.discount_value) < 0 || Number(payload.discount_value) > 100)) {
        setFormError('Percent discount must be between 0 and 100');
        return;
      }
      
      // Warn for large flat discounts
      if (payload.discount_type === 'flat' && Number(payload.discount_value) > 1000) {
        if (!window.confirm(`This flat discount is ₹${payload.discount_value}. Confirm?`)) {
          return;
        }
      }
      
      if (editingId) { await CouponsApi.update(editingId, payload); }
      else { await CouponsApi.create(payload); }
      setShowForm(false); setEditingId(null); setForm(EMPTY_FORM);
      setWizardStep('template'); setSelectedTemplateId(null);
      fetchCoupons();
    } catch (err) { setFormError(err.message || 'Failed to save coupon'); }
    finally { setSaving(false); }
  };

  const handleShowRedemptions = async (id) => {
    setShowRedemptions(id); setRedemptionsLoading(true);
    try { const res = await CouponsApi.redemptions(id, { limit: 50 }); setRedemptions(res.data || []); }
    catch (err) { setRedemptions([]); }
    finally { setRedemptionsLoading(false); }
  };

  const formatDiscountValue = (c) => {
    const freeDeliverySuffix = c.also_free_delivery ? ' + Free Delivery' : '';
    if (c.discount_type === 'flat') return `Rs.${Number(c.discount_value)} off${freeDeliverySuffix}`;
    if (c.discount_type === 'percent') return `${Number(c.discount_value)}% off${c.max_discount_amount ? ` (max Rs.${Number(c.max_discount_amount)})` : ''}${freeDeliverySuffix}`;
    if (c.discount_type === 'free_delivery') return 'Free Delivery';
    return '—';
  };

  if (isAllAreas) return <PickAreaNotice label="Coupons" />;
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="coupons-page">
      <div className="coupons-header">
        <div>
          <h1>Coupons & Offers</h1>
          <p className="coupons-subtitle">Create discount codes and auto-apply offers for customers.</p>
        </div>
        <button className="btn-primary" onClick={handleCreateClick}>+ Create Coupon</button>
      </div>

      <div className="coupons-filters">
        <div className="coupons-filter"><label>Status</label><select value={filters.status} onChange={e => handleFilterChange('status', e.target.value)}>{STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div className="coupons-filter"><label>Target Audience</label><select value={filters.target_audience} onChange={e => handleFilterChange('target_audience', e.target.value)}>{[{ value: '', label: 'All audiences' }, ...TARGET_AUDIENCE_OPTIONS].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div className="coupons-filter"><label>Applies To</label><select value={filters.applies_to} onChange={e => handleFilterChange('applies_to', e.target.value)}>{[{ value: '', label: 'All categories' }, ...appliesToOptions].map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <div className="coupons-filter"><label>State</label><select value={filters.active} onChange={e => handleFilterChange('active', e.target.value)}>{ACTIVE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
        <button type="button" className="coupons-filter-reset" onClick={handleFilterReset}>Reset</button>
      </div>

      {coupons.length === 0 ? (
        <EmptyState message="No coupons yet. Create your first coupon to start offering discounts." />
      ) : (
        <div className="coupons-table-wrap">
          <table className="coupons-table">
            <thead><tr><th>Code / Title</th><th>Discount</th><th>Min Order</th><th>Auto-apply</th><th>Priority</th><th>Target</th><th>Zones</th><th>Usage</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {coupons.map(c => (
                <tr key={c.id}>
                  <td><div className="coupon-code-cell">
                    {c.code ? <span className="coupon-code-chip">{c.code}</span> : <span className="coupon-auto-badge">AUTO</span>}
                    <span className="coupon-title-text">{c.title}</span>
                  </div></td>
                  <td>{formatDiscountValue(c)}</td>
                  <td>Rs.{Number(c.min_order_amount)}{c.min_item_count ? ' / ' + c.min_item_count + ' items' : ''}</td>
                  <td>{c.auto_apply ? <span className="coupon-auto-tag">Yes</span> : 'No'}</td>
                  <td>{c.auto_apply ? Number(c.priority) || 0 : '—'}</td>
                  <td>{c.target_audience === 'selected' ? 'Selected' : 'All'}</td>
                  <td>{c.target_zones === 'selected' ? 'Selected' : 'All'}</td>
                  <td>
                    {c.totalRedemptions ?? 0}
                    {c.total_usage_limit ? ` / ${c.total_usage_limit} used` : ' used'}
                    {c.per_user_usage_limit ? ` \u00B7 per-user ${c.per_user_usage_limit}` : ''}
                  </td>
                  <td><span className={`coupon-status ${STATUS_COLORS[c.status] || ''}`}>{c.status}</span></td>
                  <td><div className="coupon-actions">
                    <button className="btn-icon" onClick={() => handleEdit(c.id)}>Edit</button>
                    <button className="btn-icon" onClick={() => handleDuplicate(c.id)}>Copy</button>
                    <button className="btn-icon" onClick={() => handleToggleActive(c)}>{c.active ? 'Disable' : 'Enable'}</button>
                    <button className="btn-icon" onClick={() => handleShowRedemptions(c.id)}>Stats</button>
                    <button className="btn-icon btn-icon-danger" onClick={() => handleDelete(c.id)}>Delete</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="coupon-form-overlay" onClick={closeForm}>
          <div className="coupon-form-modal" onClick={e => e.stopPropagation()}>
            <div className="coupon-form-header"><h2>{editingId ? 'Edit Coupon' : wizardStep === 'template' ? 'Create Coupon' : (template?.label || 'Create Coupon')}</h2><button className="btn-close" onClick={closeForm}>X</button></div>
            {wizardStep === 'template' ? (
              <div className="coupon-form-body">
                <div className="coupon-template-grid">
                  {COUPON_TEMPLATES.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      className={`coupon-template-card ${t.id === 'custom' ? 'coupon-template-card-custom' : ''}`}
                      onClick={() => { setSelectedTemplateId(t.id); setForm(t.buildDefaults()); setWizardStep('form'); }}
                    >
                      <span className="coupon-template-icon">{t.icon}</span>
                      <span className="coupon-template-label">{t.label}</span>
                      <span className="coupon-template-description">{t.description}</span>
                    </button>
                  ))}
                </div>
                <div className="coupon-form-actions">
                  <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="coupon-form-body">
                {formError && <div className="coupon-form-error">{formError}</div>}
                {!editingId && selectedTemplateId && selectedTemplateId !== 'custom' && (
                  <button type="button" className="coupon-template-back" onClick={() => { setWizardStep('template'); setSelectedTemplateId(null); setForm(EMPTY_FORM); }}>
                    &larr; Back to templates
                  </button>
                )}
                <fieldset><legend>Basics</legend>
                  {showField('title') && (
                    <div className="form-row"><label>Title *</label><input type="text" value={form.title} onChange={e => handleFormChange('title', e.target.value)} required placeholder="e.g. Welcome Offer" /></div>
                  )}
                  {showField('code') && (
                    <div className="form-row"><label>Code</label><div className="code-input-row"><input type="text" value={form.code} onChange={e => handleFormChange('code', e.target.value.toUpperCase())} placeholder="e.g. WELCOME50" disabled={form.auto_apply && !form.requires_code} /><button type="button" className="btn-auto-generate" onClick={handleAutoGenerateCode} disabled={form.auto_apply && !form.requires_code} title="Generate a readable code">Auto-generate</button></div></div>
                  )}
                  {showField('description') && (
                    <div className="form-row"><label>Description</label><textarea value={form.description} onChange={e => handleFormChange('description', e.target.value)} placeholder="Shown to customers" rows={2} /></div>
                  )}
                  {showField('applies_to') && (
                    <div className="form-row"><label>Applies To</label><select value={form.applies_to} onChange={e => handleFormChange('applies_to', e.target.value)}>{appliesToOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
                  )}
                </fieldset>
                {(showField('discount_type') || showField('free_delivery_toggle')) && (
                  <fieldset><legend>Discount</legend>
                    <div className="form-row"><label>Type *</label><select value={form.discount_type} onChange={e => handleFormChange('discount_type', e.target.value)}>{DISCOUNT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
                    {showField('discount_value') && form.discount_type !== 'free_delivery' && (
                      <div className="form-row"><label>Value {form.discount_type === 'flat' ? '(Rs.)' : '(%)'} *</label><input type="number" min="0" step="0.01" value={form.discount_value} onChange={e => handleFormChange('discount_value', e.target.value)} required /></div>
                    )}
                    {showField('max_discount_amount') && form.discount_type === 'percent' && (
                      <div className="form-row"><label>Max Discount (Rs.)</label><input type="number" min="0" step="0.01" value={form.max_discount_amount} onChange={e => handleFormChange('max_discount_amount', e.target.value)} placeholder="Cap" /></div>
                    )}
                    {form.discount_type !== 'free_delivery' && (
                      <div className="form-row-check"><label><input type="checkbox" checked={Boolean(form.also_free_delivery)} onChange={e => handleFormChange('also_free_delivery', e.target.checked)} /> Also give free delivery with this coupon</label></div>
                    )}
                  </fieldset>
                )}
                {showAnyField('min_order_amount', 'max_order_amount', 'min_item_count', 'per_user_usage_limit', 'total_usage_limit', 'first_order_only', 'first_n_orders') && (
                  <fieldset><legend>Eligibility</legend>
                    {(showField('min_order_amount') || showField('max_order_amount')) && (
                      <div className="form-row-2">
                        {showField('min_order_amount') && (
                          <div className="form-row">
                            <label>Min Order (Rs.)</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={form.min_order_amount}
                              onChange={e => handleFormChange('min_order_amount', e.target.value)}
                              required={selectedTemplateId === 'min_order'}
                            />
                          </div>
                        )}
                        {showField('max_order_amount') && (
                          <div className="form-row"><label>Max Order (Rs.)</label><input type="number" min="0" step="0.01" value={form.max_order_amount} onChange={e => handleFormChange('max_order_amount', e.target.value)} placeholder="No limit" /></div>
                        )}
                      </div>
                    )}
                    {showField('min_item_count') && (
                      <div className="form-row-2">
                        <div className="form-row"><label>Min Item Count</label><input type="number" min="0" step="1" value={form.min_item_count} onChange={e => handleFormChange('min_item_count', e.target.value)} placeholder="No minimum" /></div>
                      </div>
                    )}
                    {(showField('per_user_usage_limit') || showField('total_usage_limit')) && (
                      <div className="form-row-2">
                        {showField('per_user_usage_limit') && (
                          <div className="form-row"><label>Per-User Limit</label><input type="number" min="0" value={form.per_user_usage_limit} onChange={e => handleFormChange('per_user_usage_limit', e.target.value)} placeholder="1" /></div>
                        )}
                        {showField('total_usage_limit') && (
                          <div className="form-row"><label>Total Usage Limit</label><input type="number" min="0" value={form.total_usage_limit} onChange={e => handleFormChange('total_usage_limit', e.target.value)} placeholder="No limit" /></div>
                        )}
                      </div>
                    )}
                    {showField('first_order_only') && (
                      <div className="form-row-check"><label><input type="checkbox" checked={form.first_order_only} onChange={e => handleFormChange('first_order_only', e.target.checked)} /> First order only</label></div>
                    )}
                    {showField('first_n_orders') && (
                      <div className="form-row"><label>First N Orders</label><input type="number" min="0" value={form.first_n_orders} onChange={e => handleFormChange('first_n_orders', e.target.value)} placeholder="e.g. 3" /></div>
                    )}
                    {template && template.fieldGroups.includes('limit_one_per_customer') && (
                      <div className="form-row-check">
                        <label>
                          <input
                            type="checkbox"
                            checked={form.per_user_usage_limit === '1'}
                            onChange={e => handleFormChange('per_user_usage_limit', e.target.checked ? '1' : '')}
                          />
                          Limit to one use per customer
                        </label>
                      </div>
                    )}
                  </fieldset>
                )}
                {showField('target_audience') && (
                  <fieldset><legend>Target Audience</legend>
                    <div className="form-row"><label>Audience</label><select value={form.target_audience} onChange={e => handleFormChange('target_audience', e.target.value)}>{TARGET_AUDIENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
                    {form.target_audience === 'selected' && (
                      <div className="targeted-users-section">
                        <div className="form-row"><label>Search users</label><input type="text" value={userSearch} onChange={e => handleUserSearch(e.target.value)} placeholder="Type name or phone..." /></div>
                        {userSearchResults.length > 0 && (<div className="user-search-results">{userSearchResults.map(u => (<button type="button" key={u.id} className="user-search-item" onClick={() => handleAddTargetedUser(u)}>{u.name} — {u.phone}</button>))}</div>)}
                        {form.targeted_user_ids.length > 0 && (<div className="targeted-users-list">{form.targeted_user_ids.map(uid => (<span key={uid} className="targeted-user-chip">User #{uid}<button type="button" onClick={() => handleRemoveTargetedUser(uid)}>X</button></span>))}</div>)}
                      </div>
                    )}
                  </fieldset>
                )}
                {showField('target_audience') && (
                  <fieldset><legend>Target Delivery Zones</legend>
                    <div className="form-row"><label>Zones</label><select value={form.target_zones} onChange={e => handleFormChange('target_zones', e.target.value)}>{TARGET_ZONES_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
                    {form.target_zones === 'selected' && (
                      zones.length === 0 ? (
                        <p className="coupon-form-info">No delivery zones exist yet — create one on the Delivery Zones page first.</p>
                      ) : (
                        <div className="targeted-zones-list">
                          {zones.map(z => (
                            <label key={z.id} className="targeted-zone-item">
                              <input type="checkbox" checked={form.targeted_zone_ids.includes(z.id)} onChange={() => handleToggleTargetedZone(z.id)} />
                              {zoneSizeLabel(z)}
                            </label>
                          ))}
                        </div>
                      )
                    )}
                  </fieldset>
                )}
                {showAnyField('starts_at', 'ends_at', 'active_days_mask', 'active_time_start', 'active_time_end') && (
                  <fieldset><legend>Schedule</legend>
                    <div className="form-row-2">
                      {showField('starts_at') && (<div className="form-row"><label>Starts At</label><input type="datetime-local" value={form.starts_at} onChange={e => handleFormChange('starts_at', e.target.value)} /></div>)}
                      {showField('ends_at') && (<div className="form-row"><label>Ends At (Valid Till)</label><input type="datetime-local" value={form.ends_at} onChange={e => handleFormChange('ends_at', e.target.value)} /></div>)}
                    </div>
                    {showField('active_days_mask') && (
                      <div className="form-row"><label>Active Days</label><div className="days-chips">{DAYS.map((day, idx) => (<button type="button" key={idx} className={`day-chip ${form.active_days_mask && (form.active_days_mask & (1 << idx)) ? 'active' : ''}`} onClick={() => handleDayToggle(idx)}>{day}</button>))}</div></div>
                    )}
                    <div className="form-row-2">
                      {showField('active_time_start') && (<div className="form-row"><label>Active Time Start</label><input type="time" value={form.active_time_start} onChange={e => handleFormChange('active_time_start', e.target.value)} /></div>)}
                      {showField('active_time_end') && (<div className="form-row"><label>Active Time End</label><input type="time" value={form.active_time_end} onChange={e => handleFormChange('active_time_end', e.target.value)} /></div>)}
                    </div>
                  </fieldset>
                )}
                <fieldset><legend>Preview</legend>
                  <CouponPreview form={form} />
                </fieldset>
                {showAnyField('auto_apply', 'requires_code', 'active', 'priority') && (
                  <fieldset><legend>Behaviour</legend>
                    {showField('auto_apply') && (
                      <div className="form-row-check"><label><input type="checkbox" checked={form.auto_apply} onChange={e => handleFormChange('auto_apply', e.target.checked)} /> Auto-apply</label></div>
                    )}
                    {showField('requires_code') && (
                      <div className="form-row-check"><label><input type="checkbox" checked={form.requires_code} onChange={e => handleFormChange('requires_code', e.target.checked)} /> Requires code</label></div>
                    )}
                    {!form.auto_apply && !form.requires_code && (
                      <p className="coupon-form-info">
                        This coupon won&apos;t auto-apply and has no code — customers can only use it by tapping it in the offers list.
                      </p>
                    )}
                    {showField('active') && (
                      <div className="form-row-check"><label><input type="checkbox" checked={form.active} onChange={e => handleFormChange('active', e.target.checked)} /> Active</label></div>
                    )}
                    {showField('priority') && (
                      <div className="form-row"><label>Priority</label><input type="number" min="0" step="1" value={form.priority} onChange={e => handleFormChange('priority', e.target.value)} placeholder="0" /><span className="form-hint">When multiple auto-apply offers give the same discount, the higher priority wins.</span></div>
                    )}
                  </fieldset>
                )}
                <div className="coupon-form-actions">
                  <button type="button" className="btn-secondary" onClick={closeForm}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving...' : (editingId ? 'Update Coupon' : 'Create Coupon')}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {showRedemptions && (
        <div className="coupon-form-overlay" onClick={() => setShowRedemptions(null)}>
          <div className="coupon-form-modal" onClick={e => e.stopPropagation()}>
            <div className="coupon-form-header"><h2>Coupon Redemptions</h2><button className="btn-close" onClick={() => setShowRedemptions(null)}>X</button></div>
            <div className="coupon-form-body">
              {redemptionsLoading ? <Loading /> : redemptions.length === 0 ? <EmptyState message="No redemptions yet." /> : (
                <table className="coupons-table"><thead><tr><th>Order #</th><th>Customer</th><th>Discount</th><th>Order Total</th><th>Date</th></tr></thead><tbody>
                  {redemptions.map(r => (<tr key={r.id}><td>{r.order_number || r.order_id}</td><td>{r.user_name || '—'}{r.user_phone ? ` (${r.user_phone})` : ''}</td><td>Rs.{Number(r.discount_amount)}</td><td>Rs.{Number(r.order_total || 0)}</td><td>{new Date(r.redeemed_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>))}
                </tbody></table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}