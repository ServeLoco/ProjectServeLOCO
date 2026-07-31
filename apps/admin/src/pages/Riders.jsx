import React, { useState, useEffect, useCallback, useRef } from 'react';
import { RidersApi, subscribeRealtime, connectAdminRealtime } from '../api';
import { readList } from '../utils/apiResponse';
import { GENERIC_ERROR } from '../utils/constants';
import './Shops.css';

function mergeRiderUpdate(list, payload) {
  if (!payload || payload.id == null) return list;
  const id = Number(payload.id);
  const idx = list.findIndex((r) => Number(r.id) === id);
  if (idx < 0) {
    if (payload.displayName || payload.display_name) {
      return [...list, {
        ...payload,
        isOnline: Boolean(payload.isOnline ?? payload.is_online),
        is_online: Boolean(payload.isOnline ?? payload.is_online),
        active: payload.active !== undefined ? Boolean(payload.active) : true,
      }];
    }
    return list;
  }
  const next = [...list];
  const prev = next[idx];
  const isOnline = payload.isOnline !== undefined || payload.is_online !== undefined
    ? Boolean(payload.isOnline ?? payload.is_online)
    : Boolean(prev.isOnline ?? prev.is_online);
  next[idx] = {
    ...prev,
    ...payload,
    isOnline,
    is_online: isOnline,
    active: payload.active !== undefined ? Boolean(payload.active) : prev.active,
    displayName: payload.displayName || payload.display_name || prev.displayName || prev.display_name,
    display_name: payload.displayName || payload.display_name || prev.displayName || prev.display_name,
  };
  return next;
}

export default function Riders() {
  const [riders, setRiders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [liveHint, setLiveHint] = useState('');
  const [dispatchRider, setDispatchRider] = useState(null);
  const [onlineBusyId, setOnlineBusyId] = useState(null);

  const fetchRiders = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await RidersApi.list();
      setRiders(readList(res, ['riders']));
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRiders();
  }, [fetchRiders]);

  useEffect(() => {
    connectAdminRealtime();
    const off = subscribeRealtime('admin.rider.updated', (payload) => {
      setRiders((prev) => mergeRiderUpdate(prev, payload));
      const name = payload?.displayName || payload?.display_name || `Rider #${payload?.id}`;
      const online = Boolean(payload?.isOnline ?? payload?.is_online);
      if (payload?.reason === 'online' || payload?.reason === 'offline') {
        setLiveHint(`${name} went ${online ? 'online' : 'offline'}`);
      } else if (payload?.reason === 'deactivated' || payload?.reason === 'activated') {
        setLiveHint(`${name} ${payload.reason}`);
      }
    });
    const offRiderOrder = subscribeRealtime('admin.order.rider_updated', () => {
      // Dispatch panel refetches itself; list online state may be unchanged.
    });
    const offVisible = subscribeRealtime('lifecycle.visible', () => fetchRiders({ silent: true }));
    const offReconn = subscribeRealtime('lifecycle.reconnected', () => fetchRiders({ silent: true }));
    return () => {
      off();
      offRiderOrder();
      offVisible();
      offReconn();
    };
  }, [fetchRiders]);

  useEffect(() => {
    if (!liveHint) return undefined;
    const t = setTimeout(() => setLiveHint(''), 2500);
    return () => clearTimeout(t);
  }, [liveHint]);

  const openCreate = () => {
    setPhone('');
    setDisplayName('');
    setDrawerOpen(true);
  };

  const createRider = async (e) => {
    e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      await RidersApi.create({
        phone: phone.trim(),
        displayName: displayName.trim() || undefined,
      });
      setDrawerOpen(false);
      fetchRiders();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (rider) => {
    try {
      await RidersApi.update(rider.id, { active: !rider.active });
      fetchRiders();
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const handleDeleteRider = async (rider) => {
    const label = rider?.displayName || rider?.display_name || rider?.phone || `rider #${rider?.id}`;
    const ok = window.confirm(
      `Delete rider "${label}"?\n\nThis phone will open as a normal customer again. Active deliveries must be finished first.`
    );
    if (!ok) return;
    try {
      setError(null);
      await RidersApi.delete(rider.id);
      if (dispatchRider?.id === rider.id) setDispatchRider(null);
      setRiders((prev) => prev.filter((r) => Number(r.id) !== Number(rider.id)));
      setLiveHint(`${label} deleted · phone is customer again`);
    } catch (err) {
      console.error(err);
      setError(err.message || GENERIC_ERROR);
    }
  };

  const toggleOnline = async (rider) => {
    const next = !(rider.isOnline || rider.is_online);
    setOnlineBusyId(rider.id);
    setError(null);
    try {
      const res = await RidersApi.setOnline(rider.id, next);
      if (res?.rider) {
        setRiders((prev) => mergeRiderUpdate(prev, {
          ...res.rider,
          reason: next ? 'online' : 'offline',
        }));
      } else {
        await fetchRiders({ silent: true });
      }
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      setOnlineBusyId(null);
    }
  };

  const handleRiderPatched = useCallback((payload) => {
    setRiders((prev) => mergeRiderUpdate(prev, payload));
  }, []);

  return (
    <div className="shops-container">
      <header className="shops-header">
        <div>
          <h1 className="shops-title">Riders</h1>
          <p className="shops-subtitle">
            Set riders Online before shops confirm. Offers go to one rider at a time —
            open Dispatch on that rider to Accept / Reject, then pickup → OFD → delivered.
          </p>
        </div>
        <button className="btn-primary" type="button" onClick={openCreate}>
          + New Rider
        </button>
      </header>

      {error && (
        <div className="error-container" style={{ marginBottom: '1.25rem' }}>
          {error}
        </div>
      )}

      {liveHint ? (
        <div
          style={{
            marginBottom: '0.75rem',
            padding: '0.55rem 0.85rem',
            borderRadius: 10,
            background: 'rgba(255, 122, 58, 0.12)',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}
        >
          Live · {liveHint}
        </div>
      ) : null}

      <section className="shops-table-wrapper">
        <table className="shops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Online</th>
              <th>Active</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && riders.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ textAlign: 'center', padding: '2rem' }}>
                  Loading riders...
                </td>
              </tr>
            ) : riders.length === 0 ? (
              <tr>
                <td colSpan="5" style={{ textAlign: 'center', padding: '2rem' }}>
                  No riders yet. Create one with a customer phone number.
                </td>
              </tr>
            ) : (
              riders.map((r) => {
                const online = Boolean(r.isOnline || r.is_online);
                return (
                  <tr key={r.id}>
                    <td>
                      <span className="shop-name">{r.displayName || r.display_name}</span>
                    </td>
                    <td>{r.phone || r.userPhone || '—'}</td>
                    <td>
                      <button
                        type="button"
                        className={`availability-toggle ${online ? 'in-stock' : 'out-of-stock'}`}
                        disabled={onlineBusyId === r.id || !r.active}
                        onClick={() => toggleOnline(r)}
                        title={!r.active ? 'Activate rider first' : online ? 'Set offline' : 'Set online'}
                      >
                        {onlineBusyId === r.id ? '…' : online ? (
                          <>
                            <span
                              style={{
                                display: 'inline-block',
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: 'currentColor',
                                marginRight: 6,
                                boxShadow: '0 0 0 3px rgba(31, 181, 116, 0.25)',
                              }}
                            />
                            Online
                          </>
                        ) : (
                          'Offline'
                        )}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`availability-toggle ${r.active ? 'in-stock' : 'out-of-stock'}`}
                        onClick={() => toggleActive(r)}
                      >
                        {r.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="shop-actions-cell">
                      <button
                        type="button"
                        className="action-link action-link-orders"
                        onClick={() => setDispatchRider(r)}
                      >
                        Dispatch
                      </button>
                      <button
                        type="button"
                        className="action-link danger"
                        onClick={() => handleDeleteRider(r)}
                      >
                        Delete
                      </button>
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                        ID {r.id}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      {drawerOpen && (
        <div className="shop-drawer-overlay" onClick={() => setDrawerOpen(false)} role="presentation">
          <div
            className="shop-drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Create rider"
          >
            <header className="shop-drawer-header">
              <h2>Create rider</h2>
              <button type="button" className="btn-secondary" onClick={() => setDrawerOpen(false)}>
                Close
              </button>
            </header>
            <form onSubmit={createRider} className="shop-drawer-body">
              <label className="form-label">
                Customer phone *
                <input
                  className="form-input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Must already exist (OTP login once)"
                  required
                />
              </label>
              <label className="form-label">
                Display name
                <input
                  className="form-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional — defaults to user name"
                />
              </label>
              <button className="btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Create rider'}
              </button>
            </form>
          </div>
        </div>
      )}

      {dispatchRider && (
        <RiderDispatchPanel
          rider={dispatchRider}
          onClose={() => setDispatchRider(null)}
          onRiderPatched={handleRiderPatched}
        />
      )}
    </div>
  );
}

/**
 * Side panel: pending offer (Accept / Reject like the rider popup) + active
 * jobs (Out for Delivery → Delivered).
 */
function RiderDispatchPanel({ rider, onClose, onRiderPatched }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeOffer, setActiveOffer] = useState(null);
  const [orders, setOrders] = useState([]);
  const [dispatchRider, setDispatchRider] = useState(null);
  const [busy, setBusy] = useState(null); // string key
  const [secondsLeft, setSecondsLeft] = useState(0);
  const onRiderPatchedRef = useRef(onRiderPatched);
  const fetchInFlightRef = useRef(false);
  const refetchTimerRef = useRef(null);

  useEffect(() => {
    onRiderPatchedRef.current = onRiderPatched;
  }, [onRiderPatched]);

  // Stable fetch — only depends on rider.id. Do NOT call parent setState on
  // every poll (that recreated callbacks and caused a 429 request loop).
  const fetchDispatch = useCallback(async ({ silent = false } = {}) => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      if (!silent) setLoading(true);
      setError(null);
      const res = await RidersApi.getDispatch(rider.id);
      setDispatchRider(res?.rider || null);
      setActiveOffer(res?.activeOffer || res?.active_offer || null);
      setOrders(res?.orders || []);
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      fetchInFlightRef.current = false;
      setLoading(false);
    }
  }, [rider.id]);

  // Debounced silent refresh for realtime events (avoid burst → rate limit).
  const scheduleFetchDispatch = useCallback(() => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      fetchDispatch({ silent: true });
    }, 400);
  }, [fetchDispatch]);

  useEffect(() => {
    fetchDispatch();
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, [fetchDispatch]);

  useEffect(() => {
    const off = subscribeRealtime('admin.order.rider_updated', (payload) => {
      const rid = payload?.riderId ?? payload?.rider_id;
      // Events without riderId (e.g. assignment failed) still refresh open panel.
      if (rid != null && Number(rid) !== Number(rider.id)) return;
      scheduleFetchDispatch();
    });
    const offOffer = subscribeRealtime('admin.rider.offer.created', (payload) => {
      const rid = payload?.riderId ?? payload?.rider_id;
      if (rid != null && Number(rid) !== Number(rider.id)) return;
      scheduleFetchDispatch();
    });
    const offRider = subscribeRealtime('admin.rider.updated', (payload) => {
      if (payload?.id != null && Number(payload.id) === Number(rider.id)) {
        if (payload.isOnline !== undefined || payload.is_online !== undefined) {
          setDispatchRider((prev) => ({
            ...(prev || {}),
            ...payload,
            isOnline: Boolean(payload.isOnline ?? payload.is_online),
            is_online: Boolean(payload.isOnline ?? payload.is_online),
          }));
        }
        if (payload.reason) {
          scheduleFetchDispatch();
        }
      }
    });
    return () => {
      off();
      offOffer();
      offRider();
    };
  }, [scheduleFetchDispatch, rider.id]);

  // Offer countdown from server expiresAt
  useEffect(() => {
    if (!activeOffer) {
      setSecondsLeft(0);
      return undefined;
    }
    const expiresAt = activeOffer.expiresAt || activeOffer.expires_at;
    const tick = () => {
      const ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0;
      setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeOffer?.id, activeOffer?.offerId, activeOffer?.expiresAt, activeOffer?.expires_at]);

  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await fetchDispatch({ silent: true });
    } catch (err) {
      setError(err.message || GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  };

  const online = Boolean(
    (dispatchRider || rider).isOnline ?? (dispatchRider || rider).is_online
  );
  const name = (dispatchRider || rider).displayName || (dispatchRider || rider).display_name || `Rider #${rider.id}`;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-content shop-orders-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h3 className="drawer-title">{name} — Dispatch</h3>
            <p className="shop-orders-hint">
              Same as rider app: online toggle, accept/reject offer popup, then pickup → OFD → delivered.
              Accepting here closes the rider Accept popup.
            </p>
          </div>
          <button type="button" className="drawer-close" onClick={onClose}>&times;</button>
        </div>

        <div className="drawer-body shop-orders-body">
          {error && <div className="error-container" style={{ marginBottom: '1rem' }}>{error}</div>}

          <div className="shop-order-actions" style={{ marginBottom: '0.5rem' }}>
            <button
              type="button"
              className={`btn-primary ${online ? '' : ''}`}
              style={online ? undefined : { background: 'var(--text-secondary)' }}
              disabled={busy === 'online' || !(dispatchRider || rider).active}
              onClick={() => run('online', async () => {
                const res = await RidersApi.setOnline(rider.id, !online);
                if (res?.rider) {
                  setDispatchRider(res.rider);
                  onRiderPatchedRef.current?.({
                    ...res.rider,
                    reason: !online ? 'online' : 'offline',
                  });
                }
              })}
            >
              {busy === 'online' ? '…' : online ? 'Set offline' : 'Set online'}
            </button>
            <span className={`shop-order-pill ${online ? 'shop-order-pill--ready' : 'shop-order-pill--wait'}`}>
              {online ? 'Online' : 'Offline'}
            </span>
          </div>

          {loading ? (
            <p className="shop-orders-empty">Loading dispatch…</p>
          ) : (
            <>
              {activeOffer && (
                <section className="shop-orders-section">
                  <h4 className="shop-orders-section-title">
                    Pending offer
                    <span className="shop-orders-count">
                      {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                    </span>
                  </h4>
                  <article className="shop-order-card shop-order-card--pending">
                    <div className="shop-order-card-top">
                      <div>
                        <strong className="shop-order-num">
                          {activeOffer.orderNumber || activeOffer.order_number || `Order #${activeOffer.orderId || activeOffer.order_id}`}
                        </strong>
                        <span className="shop-order-meta">
                          Offer #{activeOffer.id || activeOffer.offerId}
                          {activeOffer.customerName || activeOffer.customer_name
                            ? ` · ${activeOffer.customerName || activeOffer.customer_name}`
                            : ''}
                        </span>
                      </div>
                      <span className="shop-order-pill shop-order-pill--wait">Needs accept</span>
                    </div>
                    {activeOffer.address && (
                      <p className="shop-order-note" style={{ background: 'transparent', color: 'var(--text-secondary)' }}>
                        {activeOffer.address}
                      </p>
                    )}
                    {Array.isArray(activeOffer.shops) && activeOffer.shops.length > 0 && (
                      <p className="shop-order-meta">
                        Pickup: {activeOffer.shops.map((s) => s.name).join(', ')}
                      </p>
                    )}
                    <div className="shop-order-actions">
                      <button
                        type="button"
                        className="btn-primary shop-order-btn-confirm"
                        disabled={!!busy}
                        onClick={() => run('accept', () => RidersApi.acceptOffer(
                          rider.id,
                          activeOffer.id || activeOffer.offerId
                        ))}
                      >
                        {busy === 'accept' ? 'Accepting…' : 'Accept ride'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary shop-order-btn-cancel"
                        disabled={!!busy}
                        onClick={() => {
                          if (!window.confirm('Reject this offer for the rider? Next eligible rider may be offered.')) return;
                          run('reject', () => RidersApi.rejectOffer(
                            rider.id,
                            activeOffer.id || activeOffer.offerId
                          ));
                        }}
                      >
                        {busy === 'reject' ? '…' : 'Reject'}
                      </button>
                    </div>
                  </article>
                </section>
              )}

              <section className="shop-orders-section">
                <h4 className="shop-orders-section-title">
                  Active jobs
                  {orders.length > 0 && <span className="shop-orders-count">{orders.length}</span>}
                </h4>
                {orders.length === 0 ? (
                  <p className="shop-orders-empty" style={{ padding: '0.75rem 0' }}>
                    No active assignments.
                  </p>
                ) : (
                  orders.map((order) => (
                    <RiderJobCard
                      key={order.id}
                      order={order}
                      busy={busy}
                      onOutForDelivery={() => run(`ofd-${order.id}`, () => RidersApi.updateAssignmentStatus(
                        rider.id,
                        order.id,
                        'Out for Delivery'
                      ))}
                      onDelivered={() => {
                        if (!window.confirm('Mark this order delivered?')) return;
                        run(`del-${order.id}`, () => RidersApi.updateAssignmentStatus(
                          rider.id,
                          order.id,
                          'Delivered'
                        ));
                      }}
                    />
                  ))
                )}
              </section>
            </>
          )}
        </div>

        <div className="drawer-footer">
          <button type="button" className="btn-secondary" onClick={() => fetchDispatch()}>
            Refresh
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function RiderJobCard({ order, busy, onOutForDelivery, onDelivered }) {
  const pickedUp = Boolean(order.riderPickedUpAt || order.rider_picked_up_at);
  const status = order.status;
  const terminal = status === 'Delivered' || status === 'Cancelled';
  const label = order.orderNumber || order.order_number || `#${order.id}`;
  const items = order.items || [];
  const shops = order.shops || [];

  return (
    <article className={`shop-order-card ${status === 'Out for Delivery' ? 'shop-order-card--active' : 'shop-order-card--pending'}`}>
      <div className="shop-order-card-top">
        <div>
          <strong className="shop-order-num">{label}</strong>
          <span className="shop-order-meta">
            {status}
            {order.customerName || order.customer_name
              ? ` · ${order.customerName || order.customer_name}`
              : ''}
            {order.phone ? ` · ${order.phone}` : ''}
          </span>
        </div>
        {pickedUp && status !== 'Delivered' && (
          <span className="shop-order-pill shop-order-pill--ready">Picked up</span>
        )}
      </div>

      {order.address && (
        <p className="shop-order-note" style={{ background: 'transparent', color: 'var(--text-secondary)' }}>
          {order.address}
        </p>
      )}

      {shops.length > 0 && (
        <p className="shop-order-meta">
          Shops: {shops.map((s) => {
            const shopTotal = s.shopTotal ?? s.shop_total;
            return shopTotal > 0 ? `${s.name} (₹${shopTotal} owed)` : s.name;
          }).join(', ')}
        </p>
      )}

      {items.length > 0 && (
        <ul className="shop-order-items">
          {items.slice(0, 6).map((it) => (
            <li key={it.id}>
              {it.quantity}× {it.productName || it.product_name}
            </li>
          ))}
          {items.length > 6 && <li>…+{items.length - 6} more</li>}
        </ul>
      )}

      {!terminal && (
        <div className="shop-order-actions">
          {status !== 'Out for Delivery' && status !== 'Delivered' && (
            <button
              type="button"
              className="btn-primary shop-order-btn-ready"
              disabled={!!busy}
              onClick={onOutForDelivery}
            >
              {busy === `ofd-${order.id}` ? '…' : 'Out for delivery'}
            </button>
          )}
          {status === 'Out for Delivery' && (
            <button
              type="button"
              className="btn-primary shop-order-btn-confirm"
              disabled={!!busy}
              onClick={onDelivered}
            >
              {busy === `del-${order.id}` ? '…' : 'Delivered'}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
