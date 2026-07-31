import React, { useState, useEffect, useCallback } from 'react';
import {
  ShopsApi,
  ProductsApi,
  subscribeAdminOrderEvents,
  subscribeRealtimeLifecycle,
} from '../api';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import { ADMIN_ORDER_STATUS_EVENT } from '../utils/realtimeOrder';
import './ShopManageModal.css';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'orders', label: 'Orders' },
  { id: 'products', label: 'Products & Groups' },
];

/**
 * ShopManageModal
 * Gives admin everything the shop-owner app gives the owner, for any shop:
 * open/closed + auto schedule (Overview), Confirm/Ready/Cancel active orders
 * (Orders — moved in from the old standalone ShopOrdersPanel), and product +
 * group management (Products & Groups).
 */
export default function ShopManageModal({ shop, initialTab = 'overview', onClose }) {
  const [tab, setTab] = useState(initialTab);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!shop) return null;

  return (
    <div className="smm-overlay" onClick={onClose}>
      <div className="smm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="smm-header">
          <div>
            <h2 className="smm-title">{shop.name}</h2>
            <p className="smm-subtitle">Status, schedule, orders, and products — same controls as the shop-owner app.</p>
          </div>
          <button type="button" className="smm-close" onClick={onClose}>&times;</button>
        </div>

        <div className="smm-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`smm-tab ${tab === t.id ? 'smm-tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="smm-body">
          {tab === 'overview' && <OverviewTab shop={shop} />}
          {tab === 'orders' && <OrdersTab shop={shop} />}
          {tab === 'products' && <ProductsGroupsTab shop={shop} />}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────── Overview tab ────────────────────────── */

function OverviewTab({ shop: initialShop }) {
  const [shop, setShop] = useState(initialShop);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [error, setError] = useState(null);

  const scheduleEnabled = Boolean(shop.openTime && shop.closeTime);

  const toggleOpen = async () => {
    const next = !shop.is_open;
    setError(null);
    setToggleBusy(true);
    setShop((s) => ({ ...s, is_open: next }));
    try {
      await ShopsApi.update(shop.id, { is_open: next });
    } catch (err) {
      setShop((s) => ({ ...s, is_open: !next }));
      setError(err.message || GENERIC_ERROR);
    } finally {
      setToggleBusy(false);
    }
  };

  const applySchedule = async (nextOpen, nextClose) => {
    const prev = shop;
    setError(null);
    setScheduleBusy(true);
    setShop((s) => ({ ...s, openTime: nextOpen, closeTime: nextClose }));
    try {
      await ShopsApi.updateSchedule(shop.id, nextOpen, nextClose);
    } catch (err) {
      setShop(prev);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setScheduleBusy(false);
    }
  };

  const toggleScheduleEnabled = () => {
    if (scheduleEnabled) {
      applySchedule(null, null);
    } else {
      applySchedule(shop.openTime || '09:00', shop.closeTime || '21:00');
    }
  };

  const handleTimeChange = (field, value) => {
    const nextOpen = field === 'open' ? value : shop.openTime;
    const nextClose = field === 'close' ? value : shop.closeTime;
    if (!nextOpen || !nextClose) return;
    if (nextOpen === nextClose) {
      setError('Opening and closing time cannot be the same.');
      return;
    }
    applySchedule(nextOpen, nextClose);
  };

  return (
    <div className="smm-overview">
      {error && <div className="error-container">{error}</div>}

      <section className="smm-status-row">
        <div>
          <h3 className="smm-section-title">Shop status</h3>
          <p className="smm-section-hint">
            {shop.is_open ? 'Open — taking new orders now.' : 'Closed — not accepting orders.'}
          </p>
        </div>
        <button
          type="button"
          className={`availability-toggle ${shop.is_open ? 'in-stock' : 'out-of-stock'}`}
          onClick={toggleOpen}
          disabled={toggleBusy}
        >
          {shop.is_open ? 'Open' : 'Closed'}
        </button>
      </section>

      <section className="smm-status-row">
        <div>
          <h3 className="smm-section-title">Auto schedule</h3>
          <p className="smm-section-hint">
            {scheduleEnabled ? 'Opens and closes on its own every day.' : 'Off — the toggle above stays fully manual.'}
          </p>
        </div>
        <button
          type="button"
          className={`availability-toggle ${scheduleEnabled ? 'in-stock' : 'out-of-stock'}`}
          onClick={toggleScheduleEnabled}
          disabled={scheduleBusy}
        >
          {scheduleEnabled ? 'On' : 'Off'}
        </button>
      </section>

      {scheduleEnabled && (
        <section className="smm-time-row">
          <label className="form-group">
            <span className="form-label">Opens</span>
            <input
              type="time"
              className="form-input"
              value={shop.openTime || ''}
              disabled={scheduleBusy}
              onChange={(e) => handleTimeChange('open', e.target.value)}
            />
          </label>
          <label className="form-group">
            <span className="form-label">Closes</span>
            <input
              type="time"
              className="form-input"
              value={shop.closeTime || ''}
              disabled={scheduleBusy}
              onChange={(e) => handleTimeChange('close', e.target.value)}
            />
          </label>
        </section>
      )}
    </div>
  );
}

/* ─────────────────────────── Orders tab ─────────────────────────── */
/* Moved from the old standalone ShopOrdersPanel — same fetch, realtime
 * subscriptions, and Confirm/Ready/Cancel actions, just living in a tab. */

function OrdersTab({ shop }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState({}); // { [orderId]: 'confirm' | 'ready' | 'reject' }

  const fetchOrders = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await ShopsApi.listOrders(shop.id);
      setOrders(res?.orders || []);
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, [shop.id]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    const dropOrder = (orderId) => {
      if (orderId == null) return;
      setOrders((prev) => prev.filter((o) => Number(o.id) !== Number(orderId)));
    };
    const patchOrder = (orderId, patch) => {
      if (orderId == null) return;
      setOrders((prev) => prev.map((o) => (
        Number(o.id) === Number(orderId) ? { ...o, ...patch } : o
      )));
    };

    const unsubOrders = subscribeAdminOrderEvents(({ eventName, payload }) => {
      const orderId = payload?.orderId ?? payload?.order_id ?? payload?.id;
      const status = payload?.status;
      const eventShopId = payload?.shopId ?? payload?.shop_id;
      const forThisShop = eventShopId == null || Number(eventShopId) === Number(shop.id);

      if (
        eventName === 'admin.order.updated'
        && orderId != null
        && (status === 'Cancelled' || status === 'Canceled')
      ) {
        dropOrder(orderId);
        return;
      }

      if (!forThisShop) return;

      if (eventName === 'admin.order.shop_confirmed' && orderId != null) {
        patchOrder(orderId, { confirmed: true, rejected: false });
        return;
      }
      if (eventName === 'admin.order.shop_ready' && orderId != null) {
        patchOrder(orderId, { ready: true, confirmed: true, rejected: false });
        return;
      }
      if (
        eventName === 'admin.order.updated'
        && orderId != null
        && (payload?.action === 'rejected' || payload?.rejected === true)
      ) {
        patchOrder(orderId, { rejected: true, confirmed: false, ready: false });
        return;
      }

      if (eventName === 'admin.order.created' || eventName === 'admin.order.updated') {
        fetchOrders({ silent: true });
      }
    });

    const onLocalStatus = (e) => {
      const { orderId, status } = e.detail || {};
      if (status === 'Cancelled' || status === 'Canceled') {
        dropOrder(orderId);
      }
    };
    window.addEventListener(ADMIN_ORDER_STATUS_EVENT, onLocalStatus);

    const unsubLife = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'visible') {
        fetchOrders({ silent: true });
      }
    });
    return () => {
      unsubOrders();
      unsubLife();
      window.removeEventListener(ADMIN_ORDER_STATUS_EVENT, onLocalStatus);
    };
  }, [fetchOrders, shop.id]);

  const runAction = async (orderId, action) => {
    setBusy((prev) => ({ ...prev, [orderId]: action }));
    setError(null);
    try {
      if (action === 'confirm') {
        setOrders((prev) => prev.map((o) => (
          Number(o.id) === Number(orderId) ? { ...o, confirmed: true, rejected: false } : o
        )));
        await ShopsApi.confirmOrder(shop.id, orderId);
      } else if (action === 'ready') {
        setOrders((prev) => prev.map((o) => (
          Number(o.id) === Number(orderId) ? { ...o, ready: true, confirmed: true } : o
        )));
        await ShopsApi.readyOrder(shop.id, orderId);
      } else if (action === 'reject') {
        const ok = window.confirm(
          "Cancel this shop's items on the order? The shop owner popup will update (same as shop-owner Cancel)."
        );
        if (!ok) return;
        setOrders((prev) => prev.map((o) => (
          Number(o.id) === Number(orderId) ? { ...o, rejected: true, confirmed: false, ready: false } : o
        )));
        await ShopsApi.rejectOrder(shop.id, orderId);
      }
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
      await fetchOrders({ silent: true });
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
    }
  };

  const live = orders.filter(
    (o) => o.status !== 'Cancelled' && o.status !== 'Canceled' && o.status !== 'Delivered'
  );
  const pending = live.filter((o) => !o.confirmed && !o.rejected);
  const active = live.filter((o) => o.confirmed && !o.rejected);
  const rejected = live.filter((o) => o.rejected);

  return (
    <div className="shop-orders-body">
      {error && <div className="error-container" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <p className="shop-orders-empty">Loading orders…</p>
      ) : orders.length === 0 ? (
        <p className="shop-orders-empty">No active orders for this shop (Accepted / Preparing only).</p>
      ) : (
        <>
          {pending.length > 0 && (
            <section className="shop-orders-section">
              <h4 className="shop-orders-section-title">
                Waiting to confirm
                <span className="shop-orders-count">{pending.length}</span>
              </h4>
              {pending.map((order) => (
                <ShopOrderCard
                  key={order.id}
                  order={order}
                  busy={busy[order.id]}
                  onConfirm={() => runAction(order.id, 'confirm')}
                  onReject={() => runAction(order.id, 'reject')}
                  mode="pending"
                />
              ))}
            </section>
          )}

          {active.length > 0 && (
            <section className="shop-orders-section">
              <h4 className="shop-orders-section-title">
                Preparing
                <span className="shop-orders-count">{active.length}</span>
              </h4>
              {active.map((order) => (
                <ShopOrderCard
                  key={order.id}
                  order={order}
                  busy={busy[order.id]}
                  onReady={() => runAction(order.id, 'ready')}
                  onReject={() => runAction(order.id, 'reject')}
                  mode="active"
                />
              ))}
            </section>
          )}

          {rejected.length > 0 && (
            <section className="shop-orders-section">
              <h4 className="shop-orders-section-title">Rejected (waiting on admin)</h4>
              {rejected.map((order) => (
                <ShopOrderCard key={order.id} order={order} mode="rejected" />
              ))}
            </section>
          )}
        </>
      )}

      <div className="smm-orders-footer">
        <button type="button" className="btn-secondary" onClick={() => fetchOrders()}>Refresh</button>
      </div>
    </div>
  );
}

function ShopOrderCard({ order, busy, onConfirm, onReady, onReject, mode }) {
  const items = order.items || [];
  const label = order.orderNumber || order.order_number || `#${order.id}`;
  const delivery = order.deliveryType || order.delivery_type;
  const minutes = order.expectedMinutes ?? order.expected_minutes;

  return (
    <article className={`shop-order-card shop-order-card--${mode}`}>
      <div className="shop-order-card-top">
        <div>
          <strong className="shop-order-num">{label}</strong>
          <span className="shop-order-meta">
            {order.status}
            {delivery ? ` · ${delivery}` : ''}
            {minutes != null ? ` · ~${minutes} min` : ''}
          </span>
        </div>
        {mode === 'active' && order.ready && (
          <span className="shop-order-pill shop-order-pill--ready">Ready for pickup</span>
        )}
        {mode === 'rejected' && (
          <span className="shop-order-pill shop-order-pill--reject">Rejected</span>
        )}
        {mode === 'pending' && (
          <span className="shop-order-pill shop-order-pill--wait">Needs confirm</span>
        )}
      </div>

      <ul className="shop-order-items">
        {items.map((it) => (
          <li key={it.id}>
            {it.quantity}× {it.productName || it.product_name}
            {(it.variantLabel || it.variant_label) ? ` (${it.variantLabel || it.variant_label})` : ''}
          </li>
        ))}
      </ul>

      {order.note && (
        <p className="shop-order-note">Note: {order.note}</p>
      )}

      {mode === 'pending' && (
        <div className="shop-order-actions">
          <button type="button" className="btn-primary shop-order-btn-confirm" disabled={!!busy} onClick={onConfirm}>
            {busy === 'confirm' ? 'Confirming…' : 'Confirm order'}
          </button>
          <button type="button" className="btn-secondary shop-order-btn-cancel" disabled={!!busy} onClick={onReject}>
            {busy === 'reject' ? '…' : 'Cancel'}
          </button>
        </div>
      )}

      {mode === 'active' && !order.ready && (
        <div className="shop-order-actions">
          <button type="button" className="btn-primary shop-order-btn-ready" disabled={!!busy} onClick={onReady}>
            {busy === 'ready' ? 'Marking…' : 'Ready'}
          </button>
          <button type="button" className="btn-secondary shop-order-btn-cancel" disabled={!!busy} onClick={onReject}>
            {busy === 'reject' ? '…' : 'Cancel'}
          </button>
        </div>
      )}
    </article>
  );
}

/* ───────────────────── Products & Groups tab ───────────────────── */

const UNGROUPED_KEY = 'ungrouped';

function ProductsGroupsTab({ shop }) {
  const [products, setProducts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [productsRes, groupsRes] = await Promise.all([
        ProductsApi.list({ shopId: shop.id, limit: 200 }),
        ShopsApi.listGroups(shop.id),
      ]);
      setProducts(readList(productsRes, ['products']));
      setGroups(readList(groupsRes, ['groups']));
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, [shop.id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const toggleProductAvailability = async (product, value) => {
    setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, available: value } : p)));
    try {
      await ProductsApi.updateAvailability(product.id, value);
    } catch (err) {
      setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, available: !value } : p)));
      setError(err.message || GENERIC_ERROR);
    }
  };

  const toggleVariantAvailability = async (product, variant, value) => {
    const patch = (list, avail) => list.map((v) => (v.id === variant.id ? { ...v, available: avail } : v));
    setProducts((prev) => prev.map((p) => (
      p.id === product.id ? { ...p, variants: patch(p.variants || [], value) } : p
    )));
    try {
      await ProductsApi.updateVariantAvailability(product.id, variant.id, value);
    } catch (err) {
      setProducts((prev) => prev.map((p) => (
        p.id === product.id ? { ...p, variants: patch(p.variants || [], !value) } : p
      )));
      setError(err.message || GENERIC_ERROR);
    }
  };

  const moveProductToGroup = async (product, rawGroupId) => {
    const groupId = rawGroupId === '' ? null : Number(rawGroupId);
    const prevGroupId = product.group_id ?? null;
    setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, group_id: groupId } : p)));
    try {
      await ShopsApi.assignProductGroup(shop.id, product.id, groupId);
    } catch (err) {
      setProducts((prev) => prev.map((p) => (p.id === product.id ? { ...p, group_id: prevGroupId } : p)));
      setError(err.message || GENERIC_ERROR);
    }
  };

  const toggleGroupActive = async (group, value) => {
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, active: value } : g)));
    try {
      await ShopsApi.updateGroup(shop.id, group.id, { active: value });
    } catch (err) {
      setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, active: !value } : g)));
      setError(err.message || GENERIC_ERROR);
    }
  };

  const renameGroup = async (group, name) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === group.name) return;
    const prevName = group.name;
    setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, name: trimmed } : g)));
    try {
      await ShopsApi.updateGroup(shop.id, group.id, { name: trimmed });
    } catch (err) {
      setGroups((prev) => prev.map((g) => (g.id === group.id ? { ...g, name: prevName } : g)));
      setError(err.message || GENERIC_ERROR);
    }
  };

  const removeGroup = async (group) => {
    const ok = window.confirm(`Delete "${group.name}"? Its products become ungrouped, not deleted.`);
    if (!ok) return;
    try {
      await ShopsApi.deleteGroup(shop.id, group.id);
      fetchAll();
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    }
  };

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      await ShopsApi.createGroup(shop.id, newGroupName.trim());
      setNewGroupName('');
      await fetchAll();
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      setCreatingGroup(false);
    }
  };

  if (loading) {
    return <p className="smm-empty">Loading products…</p>;
  }

  const byGroup = {};
  products.forEach((p) => {
    const key = p.group_id ?? UNGROUPED_KEY;
    if (!byGroup[key]) byGroup[key] = [];
    byGroup[key].push(p);
  });
  const ungrouped = byGroup[UNGROUPED_KEY] || [];

  return (
    <div className="smm-products">
      {error && <div className="error-container">{error}</div>}

      <form className="smm-new-group" onSubmit={handleCreateGroup}>
        <input
          type="text"
          className="form-input"
          placeholder="New group name"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
        />
        <button type="submit" className="btn-secondary" disabled={creatingGroup || !newGroupName.trim()}>
          {creatingGroup ? 'Adding…' : '+ Add group'}
        </button>
      </form>

      {products.length === 0 ? (
        <p className="smm-empty">No products assigned to this shop yet.</p>
      ) : (
        <>
          {groups.map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              products={byGroup[group.id] || []}
              groups={groups}
              onToggleActive={(v) => toggleGroupActive(group, v)}
              onRename={(name) => renameGroup(group, name)}
              onDelete={() => removeGroup(group)}
              onToggleProduct={toggleProductAvailability}
              onToggleVariant={toggleVariantAvailability}
              onMoveProduct={moveProductToGroup}
            />
          ))}

          {ungrouped.length > 0 && (
            <GroupSection
              group={null}
              products={ungrouped}
              groups={groups}
              onToggleProduct={toggleProductAvailability}
              onToggleVariant={toggleVariantAvailability}
              onMoveProduct={moveProductToGroup}
            />
          )}
        </>
      )}
    </div>
  );
}

function GroupSection({
  group, products, groups, onToggleActive, onRename, onDelete, onToggleProduct, onToggleVariant, onMoveProduct,
}) {
  const [nameDraft, setNameDraft] = useState(group?.name || '');
  useEffect(() => { setNameDraft(group?.name || ''); }, [group?.name]);

  return (
    <section className="smm-group">
      <header className="smm-group-header">
        {group ? (
          <>
            <input
              type="text"
              className="smm-group-name-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => onRename(nameDraft)}
            />
            <span className="smm-group-count">{products.length} item{products.length === 1 ? '' : 's'}</span>
            <button
              type="button"
              className={`availability-toggle ${group.active ? 'in-stock' : 'out-of-stock'}`}
              onClick={() => onToggleActive(!group.active)}
            >
              {group.active ? 'Active' : 'Inactive'}
            </button>
            <button type="button" className="action-link danger" onClick={onDelete}>Delete</button>
          </>
        ) : (
          <>
            <h4 className="smm-group-name">Ungrouped</h4>
            <span className="smm-group-count">{products.length} item{products.length === 1 ? '' : 's'}</span>
          </>
        )}
      </header>

      {products.length === 0 ? (
        <p className="smm-group-empty">No products in this group.</p>
      ) : (
        <ul className="smm-product-list">
          {products.map((product) => (
            <li key={product.id} className="smm-product-row">
              <span className={`smm-product-name ${!product.available ? 'smm-muted' : ''}`}>{product.name}</span>
              <select
                className="smm-group-select"
                value={product.group_id ?? ''}
                onChange={(e) => onMoveProduct(product, e.target.value)}
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button
                type="button"
                className={`availability-toggle ${product.available ? 'in-stock' : 'out-of-stock'}`}
                onClick={() => onToggleProduct(product, !product.available)}
              >
                {product.available ? 'Available' : 'Out of stock'}
              </button>

              {Array.isArray(product.variants) && product.variants.length > 0 && (
                <ul className="smm-variant-list">
                  {product.variants.map((v) => (
                    <li key={v.id} className="smm-variant-row">
                      <span className={!v.available ? 'smm-muted' : ''}>{v.label}</span>
                      <button
                        type="button"
                        className={`availability-toggle ${v.available ? 'in-stock' : 'out-of-stock'}`}
                        onClick={() => onToggleVariant(product, v, !v.available)}
                      >
                        {v.available ? 'Available' : 'Out of stock'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
