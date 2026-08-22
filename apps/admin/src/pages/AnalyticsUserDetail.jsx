import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AnalyticsApi } from '../api';
import './Analytics.css';

const fmtDuration = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
};

const eventLabel = (e) => {
  switch (e.type) {
    case 'cart_add': return `Added ${e.qty || 1}× ${e.productName || `#${e.productId}`}`;
    case 'cart_remove': return `Removed ${e.qty || 1}× ${e.productName || `#${e.productId}`}`;
    case 'product_view': return `Viewed ${e.productName || `#${e.productId}`}`;
    case 'category_view': return `Browsed category #${e.categoryId}`;
    case 'checkout_start': return 'Started checkout';
    case 'checkout_abandon': return 'Abandoned checkout';
    case 'order_placed': return `Placed order #${e.orderId}`;
    default: return e.type;
  }
};

export default function AnalyticsUserDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    AnalyticsApi.user(id, 30)
      .then(setData)
      .catch(e => setError(e.message || 'Failed to load user'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="analytics-container"><div className="analytics-empty">Loading…</div></div>;
  if (error) return <div className="analytics-container"><div className="analytics-error">{error}</div></div>;
  if (!data) return <div className="analytics-container"><div className="analytics-empty">User not found</div></div>;

  const { user, totals, sessions, timeline } = data;
  const initial = (user.name || '?').charAt(0).toUpperCase();

  return (
    <div className="analytics-container">
      <Link to="/analytics" className="analytics-back-link">← Back to Analytics</Link>

      <div className="analytics-user-header">
        <div className="avatar">{initial}</div>
        <div className="info">
          <h2>{user.name}</h2>
          <p>{user.phone} · Joined {user.joinedAt ? new Date(user.joinedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</p>
        </div>
      </div>

      <div className="analytics-section">
        <h2>Totals (30d)</h2>
        <div className="analytics-stats-grid">
          <div className="analytics-stat"><span className="num">{totals.sessions}</span><span className="label">Sessions</span></div>
          <div className="analytics-stat"><span className="num">{fmtDuration(totals.totalTimeSec)}</span><span className="label">Total time</span></div>
          <div className="analytics-stat"><span className="num">{totals.orders}</span><span className="label">Orders</span></div>
          <div className="analytics-stat"><span className="num">{totals.cartAdds}</span><span className="label">Cart adds</span></div>
          <div className="analytics-stat"><span className="num">{totals.cartRemoves}</span><span className="label">Cart removes</span></div>
        </div>
      </div>

      <div className="analytics-section">
        <h2>Sessions (latest 50)</h2>
        {sessions?.length > 0 ? (
          <table className="analytics-table">
            <thead><tr><th>When</th><th>Duration</th><th>Platform</th><th>Screens</th></tr></thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={i}>
                  <td>{s.connectedAt ? new Date(s.connectedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                  <td>{fmtDuration(s.durationSec)}</td>
                  <td>{s.platform || '—'}</td>
                  <td>{Object.entries(s.screens || {}).map(([k, v]) => `${k}(${v})`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="analytics-empty">No sessions recorded.</div>}
      </div>

      <div className="analytics-section">
        <h2>Event timeline (latest 200)</h2>
        {timeline?.length > 0 ? (
          timeline.map((e, i) => (
            <div key={i} className="analytics-timeline-item">
              <span className="time">{e.at ? new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</span>
              <span className="desc">{eventLabel(e)}</span>
            </div>
          ))
        ) : <div className="analytics-empty">No events recorded.</div>}
      </div>
    </div>
  );
}
