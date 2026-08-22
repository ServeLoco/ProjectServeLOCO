import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DashboardApi,
  SettingsApi,
  subscribeAdminOrderEvents,
  subscribeRealtimeLifecycle,
} from '../api';
import { Link } from 'react-router-dom';
import { useAdminRefresh } from '../hooks/useAdminRefresh';
import { GENERIC_ERROR } from '../utils/constants';
import PickAreaNotice from '../components/PickAreaNotice';
import { useAreaStore } from '../stores/useAreaStore';
import './Dashboard.css';

const ORDER_STATUS_LABELS = {
  Pending: 'Order Placed',
  Accepted: 'Accepted',
  Preparing: 'Preparing/Packing',
  'Out for Delivery': 'Out for Delivery',
  Delivered: 'Delivered',
  Cancelled: 'Cancelled',
};
const getOrderStatusLabel = (status) => ORDER_STATUS_LABELS[status] || status || 'Unknown';

const IconTrendingUp = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M15.22 6.268a.75.75 0 01.968-.431l5.942 2.28a.75.75 0 01.431.97l-2.28 5.94a.75.75 0 11-1.4-.536l1.841-4.801-4.8 1.84a.75.75 0 01-.968-.43L12.5 6.52l-3.246 8.439a.75.75 0 01-.7.473H3a.75.75 0 010-1.5h4.8l3.6-9.357a.75.75 0 011.382-.055l2.438 6.268z" clipRule="evenodd" />
  </svg>
);

const IconShoppingBag = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M7.5 6v.75H5.513A1.5 1.5 0 004.01 8.233l-1.5 11.25a1.5 1.5 0 001.488 1.698h16.005a1.5 1.5 0 001.488-1.698l-1.5-11.25A1.5 1.5 0 0018.487 6.75H16.5V6a4.5 4.5 0 10-9 0zM9 6a3 3 0 116 0v.75H9V6zm-2.25 3.75a.75.75 0 000 1.5h.75v5.25a.75.75 0 001.5 0v-5.25h9v5.25a.75.75 0 001.5 0v-5.25h.75a.75.75 0 000-1.5H6.75z" clipRule="evenodd" />
  </svg>
);

const IconClock = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .379.214.725.553.895l3 1.5a.75.75 0 00.671-1.342l-2.724-1.362V6z" clipRule="evenodd" />
  </svg>
);

const IconCreditCard = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M4.5 3.75a3 3 0 00-3 3v10.5a3 3 0 003 3h15a3 3 0 003-3V6.75a3 3 0 00-3-3h-15zM6 9.75a.75.75 0 000 1.5h2.25a.75.75 0 000-1.5H6zm3.75 0a.75.75 0 000 1.5H12a.75.75 0 000-1.5H9.75z" />
    <path fillRule="evenodd" d="M1.5 6.75a3 3 0 013-3h15a3 3 0 013 3v.75H1.5v-.75z" clipRule="evenodd" />
  </svg>
);

const IconClipboardList = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M7.5 3.75A1.5 1.5 0 009 2.25h6a1.5 1.5 0 001.5 1.5v.75H7.5V3.75zM6 5.25v-.75A3 3 0 019 1.5h6a3 3 0 013 3v.75h1.5A2.25 2.25 0 0121.75 7.5v12A2.25 2.25 0 0119.5 21.75H4.5a2.25 2.25 0 01-2.25-2.25v-12A2.25 2.25 0 014.5 5.25H6zm3 6a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5H9.75A.75.75 0 019 11.25zM9.75 14.25a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z" clipRule="evenodd" />
  </svg>
);

const IconTrophy = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M5.166 2.621v.858c-1.035.148-2.059.33-3.071.543a.75.75 0 00-.584.859 6.753 6.753 0 006.138 5.84 5.75 5.75 0 005.671 4.905c.75 0 1.47-.144 2.135-.406a6.75 6.75 0 006.139-5.84.75.75 0 00-.584-.858c-1.012-.213-2.036-.395-3.071-.543v-.858A2.25 2.25 0 0018 6.75H6A2.25 2.25 0 003.75 9v.375c0 .621-.504 1.125-1.125 1.125H1.125A1.125 1.125 0 010 9.375v-.75C0 5.679 2.019 3.75 4.5 3.75h.166zm1.125 0v.858c-1.146.17-2.28.374-3.405.608a5.26 5.26 0 002.886 4.122 5.75 5.75 0 001.789-4.73zm10.418 0a5.75 5.75 0 001.79 4.73 5.26 5.26 0 002.885-4.122 41.185 41.185 0 00-3.405-.608V2.621zM15.75 18a.75.75 0 01-.75-.75v-1.5a.75.75 0 011.5 0v1.5a.75.75 0 01-.75.75z" clipRule="evenodd" />
  </svg>
);

const IconAlertCircle = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zM12 8.25a.75.75 0 01.75.75v3.75a.75.75 0 01-1.5 0V9a.75.75 0 01.75-.75zM12 15.75a.75.75 0 100-1.5.75.75 0 000 1.5z" clipRule="evenodd" />
  </svg>
);

const IconPackage = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3.375 3C2.339 3 1.5 3.84 1.5 4.875v11.25c0 1.035.84 1.875 1.875 1.875h9.75v-5.25a1.5 1.5 0 012.181-1.34l3.46 1.73v-7.29C18.75 3.839 17.91 3 16.875 3h-13.5z" />
    <path d="M12.75 18a.75.75 0 00-1.28-.531l-3.462 3.462a.75.75 0 00.53 1.28h7.424a.75.75 0 00.53-1.28l-3.462-3.462A.75.75 0 0012.75 18z" />
  </svg>
);

const IconChartBar = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M18.375 2.25c-1.035 0-1.875.84-1.875 1.875v15.75c0 1.035.84 1.875 1.875 1.875h.75c1.035 0 1.875-.84 1.875-1.875V4.125c0-1.036-.84-1.875-1.875-1.875h-.75zM9.75 8.625c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 01-1.875-1.875V8.625zM3 13.125c0-1.036.84-1.875 1.875-1.875h.75c1.036 0 1.875.84 1.875 1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 013 19.875v-6.75z" />
  </svg>
);

export default function Dashboard() {
  const { areaId } = useAreaStore() || {};
  const isAllAreas = areaId === 'all';
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [togglingDelivery, setTogglingDelivery] = useState(false);
  const [togglingRain, setTogglingRain] = useState(false);
  const refreshTimerRef = useRef(null);

  const fetchDashboardData = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      setError(null);
      const res = await DashboardApi.getMetrics();
      setMetrics(res.data);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  const queueDashboardRefresh = useCallback((delay = 350) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => fetchDashboardData(false), delay);
  }, [fetchDashboardData]);

  // 25.4 — the Dashboard mixes per-area KPIs with the same shop_open/
  // delivery_available toggles the Settings page owns, so the API requires
  // exactly one area (§2.10). Dashboard is also the DEFAULT landing route,
  // so without this a super_admin switching to "All areas" lands straight on
  // a dead-end "Failed to load dashboard / Try Again" that can never
  // succeed. Skip the doomed fetch and render the inline notice instead.
  useEffect(() => {
    if (isAllAreas) { setLoading(false); return; }
    fetchDashboardData();
  }, [fetchDashboardData, isAllAreas]);

  useAdminRefresh(() => { if (!isAllAreas) fetchDashboardData(); });

  useEffect(() => {
    const unsubscribeOrders = subscribeAdminOrderEvents(() => queueDashboardRefresh());
    const unsubscribeLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'visible') queueDashboardRefresh();
    });
    return () => {
      unsubscribeOrders();
      unsubscribeLifecycle();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [queueDashboardRefresh]);

  // Shop Status (settings.shop_open) is no longer manually toggled here —
  // the API auto-derives it from delivery_available + whether any shop is
  // open (see syncGlobalShopOpenState). This button only controls the
  // master gate; Shop Status below just reflects the outcome.
  const handleToggleDelivery = async () => {
    if (!metrics) return;
    setTogglingDelivery(true);
    const newStatus = !metrics.delivery_available;
    try {
      await SettingsApi.update({ delivery_available: newStatus });
      // The API re-derives shop_open server-side when delivery_available
      // changes — refetch metrics instead of guessing the new shop_open
      // value locally.
      await fetchDashboardData(false);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setTogglingDelivery(false);
    }
  };

  const handleToggleRain = async () => {
    if (!metrics) return;
    setTogglingRain(true);
    const newStatus = !metrics.rain_charge_enabled;
    try {
      await SettingsApi.update({ rain_charge_enabled: newStatus });
      await fetchDashboardData(false);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setTogglingRain(false);
    }
  };

  if (isAllAreas) {
    return <div className="dashboard-container"><PickAreaNotice label="The Dashboard" /></div>;
  }

  if (loading) {
    return (
      <div className="dashboard-container">
        <div className="loading-container">
          <div className="spinner" />
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container">
        <div className="error-state-wrapper">
          <div className="error-icon" aria-hidden="true">
            <IconAlertCircle />
          </div>
          <h3>Failed to load dashboard</h3>
          <p>{error}</p>
          <button className="btn-primary" onClick={fetchDashboardData}>Try Again</button>
        </div>
      </div>
    );
  }

  if (!metrics) return null;

  const { sales = {}, latest_orders = [], product_alerts = [], top_products = [], shop_open, delivery_available, rain_charge_enabled } = metrics;

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1 className="dashboard-title">Overview</h1>
          <p className="dashboard-subtitle">
            {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
        </div>

        <div className="shop-status-group">
          <div className="shop-status-card">
            <span className="status-label">Delivery Available</span>
            <button
              className={`status-toggle ${delivery_available ? 'open' : 'closed'}`}
              onClick={handleToggleDelivery}
              disabled={togglingDelivery}
              aria-label={delivery_available ? 'Delivery is available. Click to turn off.' : 'Delivery is off. Click to turn on.'}
            >
              <span className="status-dot" aria-hidden="true" />
              {togglingDelivery ? 'Updating...' : delivery_available ? 'Available' : 'Off'}
            </button>
          </div>

          <div className="shop-status-card">
            <span className="status-label">Shop Status</span>
            <span
              className={`status-toggle status-toggle-readonly ${shop_open ? 'open' : 'closed'}`}
              aria-label={shop_open ? 'Shop is open (automatic).' : 'Shop is closed (automatic).'}
              title="Auto-set from Delivery Available + whether any shop is open"
            >
              <span className="status-dot" aria-hidden="true" />
              {shop_open ? 'Open' : 'Closed'}
              <span className="status-auto-tag">Auto</span>
            </span>
          </div>

          <div className="shop-status-card">
            <span className="status-label">Rain Charge</span>
            <button
              className={`status-toggle ${rain_charge_enabled ? 'open' : 'closed'}`}
              onClick={handleToggleRain}
              disabled={togglingRain}
              aria-label={rain_charge_enabled ? 'Rain charge is on. Click to turn off.' : 'Rain charge is off. Click to turn on.'}
            >
              <span className="status-dot" aria-hidden="true" />
              {togglingRain ? 'Updating...' : rain_charge_enabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </header>

      <section className="metrics-grid">
        <div className="metric-card sales">
          <div className="metric-card-inner">
            <div className="metric-icon-wrap icon-sales">
              <IconTrendingUp />
            </div>
            <div className="metric-card-content">
              <span className="metric-title">Today's Sales</span>
              <span className="metric-value">₹{(sales.todaySales || 0).toLocaleString('en-IN')}</span>
            </div>
          </div>
        </div>
        <div className="metric-card orders">
          <div className="metric-card-inner">
            <div className="metric-icon-wrap icon-orders">
              <IconShoppingBag />
            </div>
            <div className="metric-card-content">
              <span className="metric-title">Today's Orders</span>
              <span className="metric-value">{sales.todayOrders || 0}</span>
            </div>
          </div>
        </div>
        <div className="metric-card pending">
          <div className="metric-card-inner">
            <div className="metric-icon-wrap icon-pending">
              <IconClock />
            </div>
            <div className="metric-card-content">
              <span className="metric-title">Pending Orders</span>
              <span className="metric-value">{sales.pendingOrders || 0}</span>
            </div>
          </div>
        </div>
        <div className="metric-card payments">
          <div className="metric-card-inner">
            <div className="metric-icon-wrap icon-payments">
              <IconCreditCard />
            </div>
            <div className="metric-card-content">
              <span className="metric-title">Pending Payments</span>
              <span className="metric-value">₹{(sales.pendingPaymentTotal || 0).toLocaleString('en-IN')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="dashboard-section-card latest-orders-section">
        <div className="section-header">
          <h2 className="section-title">
            <span className="section-icon" aria-hidden="true"><IconClipboardList /></span>
            Latest Orders
          </h2>
          <Link to="/orders" className="section-link">View All</Link>
        </div>
        {latest_orders.length > 0 ? (
          <div className="table-scroll-wrapper">
            <table className="latest-orders-table">
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {latest_orders.map(order => (
                  <tr key={order.id}>
                    <td className="order-number">#{order.order_number}</td>
                    <td>{order.customer_name}</td>
                    <td className="order-amount">₹{Number(order.total).toLocaleString('en-IN')}</td>
                    <td>
                      <span className={`status-badge ${(order.status || 'unknown').toLowerCase().replace(/ /g, '-')}`}>
                        {getOrderStatusLabel(order.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true"><IconPackage /></span>
            <span>No recent orders found</span>
          </div>
        )}
      </section>

      <div className="dashboard-bottom-widgets">
        <section className="dashboard-section-card">
          <div className="section-header">
            <h2 className="section-title">
              <span className="section-icon" aria-hidden="true"><IconTrophy /></span>
              Top Items
            </h2>
          </div>
          {top_products.length > 0 ? (
            <ul className="top-products-list">
              {top_products.map((prod, idx) => (
                <li key={`${prod.product_id}-${prod.item_type}`} className="top-product-item">
                  <div className={`top-product-rank rank-${idx + 1}`}>{idx + 1}</div>
                  <div className="top-product-info">
                    <span className="top-product-name">
                      {prod.product_name}
                      {prod.item_type === 'combo' && (
                        <span className="combo-tag">Combo</span>
                      )}
                    </span>
                    <span className="top-product-qty">{prod.total_quantity} sold</span>
                  </div>
                  <div className="top-product-sales">₹{Number(prod.total_sales).toLocaleString('en-IN')}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true"><IconChartBar /></span>
              <span>No sales data yet</span>
            </div>
          )}
        </section>

        {product_alerts.length > 0 && (
          <section className="dashboard-section-card dashboard-section-card--alert">
            <div className="section-header">
              <h2 className="section-title section-title--alert">
                <span className="section-icon" aria-hidden="true"><IconAlertCircle /></span>
                Out of Stock
                <span className="alert-count">{product_alerts.length}</span>
              </h2>
            </div>
            <div className="alerts-list">
              {product_alerts.map(prod => (
                <div key={prod.id} className="alert-item">
                  <span className="alert-icon" aria-hidden="true"><IconAlertCircle /></span>
                  <span className="alert-text">
                    <strong>{prod.name}</strong> is currently unavailable.
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
