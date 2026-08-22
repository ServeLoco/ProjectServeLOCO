import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnalyticsApi, CustomersApi, subscribeRealtime, getRealtimeConnectionState, subscribeRealtimeLifecycle } from '../api';
import './Analytics.css';

const STUCK_CHECKOUT_MIN = 5;

const fmtMin = (s) => {
  const m = Math.round(s / 60);
  if (m < 1) return '<1 min';
  return `${m} min`;
};

const fmtAgo = (iso) => {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
};

const heatColor = (val, max) => {
  if (!max || val === 0) return 'var(--bg-secondary)';
  const ratio = Math.min(val / max, 1);
  const alpha = 0.15 + ratio * 0.85;
  return `rgba(59, 130, 246, ${alpha})`;
};

// Quick presets for "who opened the app in the last ___". Value is minutes.
const WINDOW_PRESETS = [
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 6 * 60 },
  { label: '24h', minutes: 24 * 60 },
  { label: '2d', minutes: 2 * 24 * 60 },
  { label: '7d', minutes: 7 * 24 * 60 },
  { label: '30d', minutes: 30 * 24 * 60 },
];

export default function Analytics() {
  const navigate = useNavigate();
  const [days, setDays] = useState(7);
  const [live, setLive] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [summary, setSummary] = useState(null);
  const [products, setProducts] = useState(null);
  const [windowShoppers, setWindowShoppers] = useState(null);
  const [hourly, setHourly] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const nameCacheRef = useRef({});

  // ── Find users panel state ────────────────────────────────────────────
  const [findSearch, setFindSearch] = useState('');
  const [findMinutes, setFindMinutes] = useState(60);
  const [findCustomValue, setFindCustomValue] = useState('');
  const [findCustomUnit, setFindCustomUnit] = useState('hours');
  const [findResults, setFindResults] = useState(null);
  const [findLoading, setFindLoading] = useState(false);
  const findDebounceRef = useRef(null);

  const runFindUsers = useCallback((minutes, search) => {
    setFindLoading(true);
    AnalyticsApi.activeUsers(minutes, search || undefined)
      .then(res => setFindResults(res?.data || []))
      .catch(() => setFindResults([]))
      .finally(() => setFindLoading(false));
  }, []);

  // Debounced fetch whenever search text or window changes.
  useEffect(() => {
    if (findDebounceRef.current) clearTimeout(findDebounceRef.current);
    findDebounceRef.current = setTimeout(() => {
      runFindUsers(findMinutes, findSearch);
    }, 300);
    return () => clearTimeout(findDebounceRef.current);
  }, [findMinutes, findSearch, runFindUsers]);

  const applyCustomWindow = () => {
    const n = parseInt(findCustomValue, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const unitToMinutes = { minutes: 1, hours: 60, days: 1440 };
    setFindMinutes(n * unitToMinutes[findCustomUnit]);
  };

  // Subscribe to analytics.live socket pushes.
  useEffect(() => {
    const unsub = subscribeRealtime('analytics.live', (payload) => setLive(payload));
    const unsubLife = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'connected' || eventName === 'reconnected') setSocketConnected(true);
      if (eventName === 'disconnected') setSocketConnected(false);
    });
    setSocketConnected(getRealtimeConnectionState().connected);
    return () => { unsub(); unsubLife(); };
  }, []);

  // Fetch history data when days changes.
  const fetchData = useCallback(async (d) => {
    setLoading(true); setError('');
    try {
      const [s, p, w, h] = await Promise.all([
        AnalyticsApi.summary(d),
        AnalyticsApi.products(d),
        AnalyticsApi.windowShoppers(7),
        AnalyticsApi.hourly(14),
      ]);
      setSummary(s);
      setProducts(p);
      setWindowShoppers(w);
      setHourly(h);
    } catch (e) { setError(e.message || 'Failed to load analytics'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(days); }, [days, fetchData]);

  // Fetch customer names for unknown userIds in live data — once per id, with
  // a negative cache so a lookup failure (or an id outside any single page)
  // doesn't retry every 5s on each live push.
  useEffect(() => {
    if (!live?.users) return;
    const unknown = [...new Set(live.users.map(u => u.userId))]
      .filter(id => id != null && !(id in nameCacheRef.current));
    if (unknown.length === 0) return;
    unknown.forEach(id => {
      nameCacheRef.current[id] = null; // mark as in-flight/attempted immediately
      CustomersApi.get(id).then(res => {
        const c = res?.data;
        nameCacheRef.current[id] = { name: c?.name, phone: c?.phone };
        setLive(prev => (prev ? { ...prev } : prev)); // trigger re-render with resolved name
      }).catch(() => {});
    });
  }, [live]);

  const today = summary?.today || {};
  const dailyDocs = summary?.daily || [];
  const maxVisitors = Math.max(1, ...dailyDocs.map(d => d.visitors || 0));
  const heatDays = hourly?.days || [];
  const maxHourly = Math.max(1, ...heatDays.flatMap(d => d.hourlyActive || []));

  const activePreset = WINDOW_PRESETS.find(p => p.minutes === findMinutes);
  const windowLabel = activePreset ? activePreset.label : `${findMinutes}m`;

  return (
    <div className="analytics-container">
      <div className="analytics-header">
        <div>
          <h1>Analytics</h1>
          <p>Live presence, visitor behavior, and product analytics</p>
        </div>
        <div className="analytics-day-selector">
          {[7, 14, 30].map(d => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
      </div>

      {/* Find users — search by name/phone, or filter by "opened app in last ___" */}
      <div className="analytics-card analytics-find">
        <div className="analytics-card-head">
          <h2>Find users</h2>
          <span className="analytics-card-hint">Search by name or number, or browse who opened the app recently</span>
        </div>

        <div className="analytics-find-controls">
          <div className="analytics-find-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search name or phone number…"
              value={findSearch}
              onChange={e => setFindSearch(e.target.value)}
            />
          </div>

          <div className="analytics-find-window">
            {WINDOW_PRESETS.map(p => (
              <button
                key={p.label}
                className={`analytics-pill ${findMinutes === p.minutes ? 'active' : ''}`}
                onClick={() => { setFindMinutes(p.minutes); setFindCustomValue(''); }}
              >
                {p.label}
              </button>
            ))}
            <div className="analytics-find-custom">
              <input
                type="number"
                min="1"
                placeholder="Custom"
                value={findCustomValue}
                onChange={e => setFindCustomValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') applyCustomWindow(); }}
              />
              <select value={findCustomUnit} onChange={e => setFindCustomUnit(e.target.value)}>
                <option value="minutes">min</option>
                <option value="hours">hrs</option>
                <option value="days">days</option>
              </select>
              <button className="analytics-pill" onClick={applyCustomWindow}>Go</button>
            </div>
          </div>
        </div>

        <div className="analytics-find-subhead">
          {findSearch
            ? <span>Results for "<strong>{findSearch}</strong>" — active in last {windowLabel}</span>
            : <span>Opened the app in the last <strong>{windowLabel}</strong></span>}
        </div>

        {findLoading ? (
          <div className="analytics-empty">Searching…</div>
        ) : (findResults && findResults.length > 0) ? (
          <table className="analytics-table analytics-find-table">
            <thead><tr><th>User</th><th>Phone</th><th>Sessions</th><th>Platform</th><th>Last active</th></tr></thead>
            <tbody>
              {findResults.map(u => (
                <tr key={u.userId} onClick={() => navigate(`/analytics/user/${u.userId}`)} className="analytics-row-clickable">
                  <td><span className="analytics-user-cell"><span className="analytics-avatar-sm">{(u.name || '?').charAt(0).toUpperCase()}</span>{u.name || `User ${u.userId}`}</span></td>
                  <td>{u.phone || '—'}</td>
                  <td>{u.sessions}</td>
                  <td>{u.platform || '—'}</td>
                  <td>{fmtAgo(u.lastActiveAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="analytics-empty">No users found for this window{findSearch ? ' and search' : ''}.</div>
        )}
      </div>

      {/* Live panel */}
      <div className="analytics-card analytics-live">
        <div className="analytics-live-top">
          <div className="analytics-live-big">
            <span className="num">{live?.online ?? '—'}</span>
            <span className="label">Online now</span>
          </div>
          <div className="analytics-live-peak">Peak today: <strong>{live?.peakToday ?? '—'}</strong></div>
          <div className="analytics-chips">
            {live && Object.entries(live.byScreen || {}).map(([screen, count]) => (
              <span key={screen} className="analytics-chip">{screen}: <strong>{count}</strong></span>
            ))}
            {live && <span className="analytics-chip">Android: <strong>{live.byPlatform?.android || 0}</strong></span>}
            {live && <span className="analytics-chip">iOS: <strong>{live.byPlatform?.ios || 0}</strong></span>}
          </div>
          <span className="analytics-socket-status">
            <span className={`analytics-socket-dot ${socketConnected ? 'connected' : 'disconnected'}`} />
            {socketConnected ? 'Live' : 'Disconnected'}
          </span>
        </div>
        {live?.users?.length > 0 ? (
          <table className="analytics-table">
            <thead><tr><th>User</th><th>Screen</th><th>Platform</th><th>Connected</th></tr></thead>
            <tbody>
              {live.users.map(u => {
                const stuck = u.screen === 'Checkout' && u.connectedMin >= STUCK_CHECKOUT_MIN;
                const cached = nameCacheRef.current[u.userId];
                return (
                  <tr key={u.userId} className={stuck ? 'stuck-checkout' : ''}>
                    <td><Link to={`/analytics/user/${u.userId}`}>{cached?.name || `User ${u.userId}`}</Link></td>
                    <td>{u.screen || '—'}{stuck && <span className="stuck-badge"> STUCK</span>}</td>
                    <td>{u.platform || '—'}</td>
                    <td>{fmtMin(u.connectedMin * 60)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <div className="analytics-empty">{socketConnected ? 'No customers online right now.' : 'Connect to see live data.'}</div>}
      </div>

      {error && <div className="analytics-error">{error}</div>}

      {/* Today so far */}
      <div className="analytics-card analytics-section">
        <h2>Today so far</h2>
        {loading && !summary ? <div className="analytics-empty">Loading…</div> : (
          <div className="analytics-stats-grid">
            <div className="analytics-stat"><span className="num">{today.visitors || 0}</span><span className="label">Visitors</span></div>
            <div className="analytics-stat"><span className="num">{today.sessions || 0}</span><span className="label">Sessions</span></div>
            <div className="analytics-stat"><span className="num">{today.orders || 0}</span><span className="label">Orders</span></div>
            <div className="analytics-stat"><span className="num">{today.conversionPct || 0}%</span><span className="label">Conversion</span></div>
            <div className="analytics-stat"><span className="num">{today.cartAdds || 0}</span><span className="label">Cart adds</span></div>
            <div className="analytics-stat"><span className="num">{today.cartRemoves || 0}</span><span className="label">Cart removes</span></div>
          </div>
        )}
      </div>

      {/* Daily visitors chart (CSS bars) */}
      <div className="analytics-card analytics-section">
        <h2>Daily visitors ({days}d)</h2>
        {dailyDocs.length > 0 ? (
          <div className="analytics-bar-chart">
            {dailyDocs.map(d => (
              <div key={d.date} className="analytics-bar" style={{ height: `${(d.visitors / maxVisitors) * 100}%` }} data-label={`${d.date}: ${d.visitors} visitors, ${d.orders || 0} orders`} />
            ))}
          </div>
        ) : <div className="analytics-empty">No data for this range.</div>}
      </div>

      {/* Active-hours heatmap */}
      <div className="analytics-card analytics-section">
        <h2>Active hours (14d)</h2>
        {heatDays.length > 0 ? (
          <div className="analytics-heatmap">
            {heatDays.flatMap(day => (day.hourlyActive || []).map((val, h) => (
              <div key={`${day.date}-${h}`} className="analytics-heat-cell"
                style={{ background: heatColor(val, maxHourly) }}
                data-label={`${day.date} ${h}:00 — ${val} users`} />
            )))}
          </div>
        ) : <div className="analytics-empty">No heatmap data.</div>}
      </div>

      {/* Product behavior tables */}
      <div className="analytics-card analytics-section">
        <h2>Product behavior</h2>
        <div className="analytics-product-tables">
          <div>
            <h3 className="analytics-subhead">Most removed</h3>
            <table className="analytics-table"><tbody>
              {(products?.topRemoved || []).map(p => (
                <tr key={p.productId}><td>{p.name || `#${p.productId}`}</td><td className="analytics-num-cell"><strong>{p.count}</strong></td></tr>
              ))}
              {(products?.topRemoved || []).length === 0 && <tr><td colSpan="2" className="analytics-muted">No data</td></tr>}
            </tbody></table>
          </div>
          <div>
            <h3 className="analytics-subhead">Most added</h3>
            <table className="analytics-table"><tbody>
              {(products?.topAdded || []).map(p => (
                <tr key={p.productId}><td>{p.name || `#${p.productId}`}</td><td className="analytics-num-cell"><strong>{p.count}</strong></td></tr>
              ))}
              {(products?.topAdded || []).length === 0 && <tr><td colSpan="2" className="analytics-muted">No data</td></tr>}
            </tbody></table>
          </div>
          <div>
            <h3 className="analytics-subhead">Most viewed</h3>
            <table className="analytics-table"><tbody>
              {(products?.topViewed || []).map(p => (
                <tr key={p.productId}><td>{p.name || `#${p.productId}`}</td><td className="analytics-num-cell"><strong>{p.count}</strong></td></tr>
              ))}
              {(products?.topViewed || []).length === 0 && <tr><td colSpan="2" className="analytics-muted">No data</td></tr>}
            </tbody></table>
          </div>
        </div>
      </div>

      {/* Window shoppers */}
      <div className="analytics-card analytics-section">
        <h2>Window shoppers (added to cart, never ordered — 7d)</h2>
        {(windowShoppers?.data || []).length > 0 ? (
          <table className="analytics-table">
            <thead><tr><th>Name</th><th>Phone</th><th>Cart adds</th><th>Cart removes</th><th>Last active</th></tr></thead>
            <tbody>
              {windowShoppers.data.map(w => (
                <tr key={w.userId}>
                  <td><Link to={`/analytics/user/${w.userId}`}>{w.name || `User ${w.userId}`}</Link></td>
                  <td>{w.phone || '—'}</td>
                  <td>{w.cartAdds}</td>
                  <td>{w.cartRemoves}</td>
                  <td>{w.lastActiveAt ? new Date(w.lastActiveAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="analytics-empty">No window shoppers in this period.</div>}
      </div>
    </div>
  );
}
