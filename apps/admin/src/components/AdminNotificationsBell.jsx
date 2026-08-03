import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminInboxApi } from '../api';
import { subscribeRealtime } from '../api/realtimeClient';
import { useAreaStore } from '../stores/useAreaStore';
import './AdminNotificationsBell.css';

const TYPE_ICONS = {
  new_order: '🛒',
  new_customer: '👤',
};

const TYPE_LABELS = {
  new_order: 'New order',
  new_customer: 'New customer',
};

const formatRelativeTime = (iso) => {
  if (!iso) return '';
  const then = new Date(iso);
  const diff = Date.now() - then.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export default function AdminNotificationsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  // autoMarked ref is declared below (next to its consumers). State kept for
  // any future render-time UI hint if needed.
  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);

  // Initial fetch. Gated on the area store being initialized: this bell lives
  // in Header, OUTSIDE the routed subtree AdminLayout gates on `initialized`,
  // so without this it fires before a super_admin's area is resolved (right
  // after login, where areaHeader.reset() has just cleared the persisted
  // pick) and the request 400s with no X-Area-Id. Re-runs the moment the area
  // lands, and on every later area switch so the bell shows THAT area's inbox.
  const { areaId, isSuperAdmin, initialized } = useAreaStore() || {};
  const areaPending = isSuperAdmin && !initialized;

  useEffect(() => {
    if (areaPending) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await AdminInboxApi.list({ limit: 20 });
        if (cancelled) return;
        setItems(res.data || []);
        setUnread(Number(res.unread_count) || 0);
      } catch (e) {
        // silent — bell is best-effort
      }
    })();
    return () => { cancelled = true; };
  }, [areaPending, areaId]);

  // Live push: new notification
  useEffect(() => {
    const off = subscribeRealtime('admin.notification.created', (notification) => {
      if (!notification) return;
      setItems(prev => {
        // dedupe by id, prepend
        const next = [notification, ...prev.filter(n => n.id !== notification.id)];
        return next.slice(0, 50);
      });
      setUnread(prev => prev + (notification.read_at ? 0 : 1));
    });
    return off;
  }, []);

  // Live push: badge count (e.g. after mark-all-read in another tab)
  useEffect(() => {
    const off = subscribeRealtime('admin.notification.unread_count', ({ count }) => {
      setUnread(Number(count) || 0);
    });
    return off;
  }, []);

  // Close on outside click + ESC
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reset the "marked" guard whenever the dropdown closes so the next open can
  // auto-mark again. Without this, a fresh notification arriving while the
  // bell was closed would never get marked as read until a manual reload.
  // Use a ref (not state) for the in-flight guard: a setAutoMarked(true)
  // inside the effect would re-render → the effect's cleanup fires
  // (cancelled = true) → the IIFE bails before updating state. State-as-guard
  // makes the auto-mark self-cancelling.
  const autoMarkedRef = useRef(false);

  useEffect(() => {
    if (!open) autoMarkedRef.current = false;
  }, [open]);

  // Auto-mark all as read when dropdown opens (per UX spec)
  useEffect(() => {
    if (!open || autoMarkedRef.current || unread === 0) return;
    autoMarkedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        await AdminInboxApi.markAllRead();
        if (cancelled) return;
        setUnread(0);
        setItems(prev => prev.map(n => n.read_at ? n : { ...n, read_at: new Date().toISOString() }));
      } catch (e) {
        // undo optimistic guard so next open retries
        autoMarkedRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [open, unread]);

  const handleOpen = () => {
    setOpen(prev => !prev);
  };

  const handleItemClick = useCallback(async (notification) => {
    if (!notification.related_url) return;
    setOpen(false);
    navigate(notification.related_url);
  }, [navigate]);

  const handleDismiss = useCallback(async (e, id) => {
    e.stopPropagation();
    try {
      await AdminInboxApi.dismiss(id);
      setItems(prev => prev.filter(n => n.id !== id));
    } catch (err) {
      // best-effort
    }
  }, []);

  return (
    <div className="admin-bell-wrapper" ref={wrapperRef}>
      <button
        ref={buttonRef}
        type="button"
        className="btn-header-icon admin-bell-button"
        onClick={handleOpen}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        title={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="admin-bell-badge" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="admin-bell-panel" role="dialog" aria-label="Admin notifications">
          <header className="admin-bell-panel-header">
            <h3>Notifications</h3>
            <span className="admin-bell-panel-count">
              {loading ? 'Loading…' : `${items.length} item${items.length === 1 ? '' : 's'}`}
            </span>
          </header>

          <div className="admin-bell-panel-body">
            {items.length === 0 ? (
              <div className="admin-bell-empty">
                <span className="admin-bell-empty-icon" aria-hidden="true">🔕</span>
                <p>You're all caught up.</p>
                <small>New password reset requests, orders, and customer signups will appear here.</small>
              </div>
            ) : (
              <ul className="admin-bell-list">
                {items.map((n) => {
                  const isUnread = !n.read_at;
                  return (
                    <li
                      key={n.id}
                      className={`admin-bell-item${isUnread ? ' unread' : ''}`}
                    >
                      <button
                        type="button"
                        className="admin-bell-item-main"
                        onClick={() => handleItemClick(n)}
                        disabled={!n.related_url}
                      >
                        <span className="admin-bell-item-icon" aria-hidden="true">
                          {TYPE_ICONS[n.type] || '🔔'}
                        </span>
                        <span className="admin-bell-item-body">
                          <span className="admin-bell-item-title">{n.title}</span>
                          <span className="admin-bell-item-text">{n.body}</span>
                          <span className="admin-bell-item-meta">
                            <span className="admin-bell-item-type">{TYPE_LABELS[n.type] || n.type}</span>
                            <span className="admin-bell-item-time">{formatRelativeTime(n.created_at)}</span>
                          </span>
                        </span>
                        {isUnread && <span className="admin-bell-item-dot" aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="admin-bell-item-dismiss"
                        onClick={(e) => handleDismiss(e, n.id)}
                        aria-label="Dismiss"
                        title="Dismiss"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
