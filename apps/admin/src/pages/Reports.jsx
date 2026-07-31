import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ReportsApi, subscribeAdminOrderEvents, subscribeRealtimeLifecycle } from '../api';
import { useAdminRefresh } from '../hooks/useAdminRefresh';
import './Reports.css';

import { GENERIC_ERROR } from '../utils/constants';
const escapeCsvCell = (value) => {
  let s = String(value ?? '');
  // Prevent formula injection: neutralize leading =,+,-,@ that spreadsheet
  // apps (Excel/LibreOffice) evaluate as formulas when a CSV is opened.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

const downloadCsv = (filename, headers, rows) => {
  const csvContent = "data:text/csv;charset=utf-8,"
    + headers.map(escapeCsvCell).join(",") + "\n"
    + rows.map(row => row.map(escapeCsvCell).join(",")).join("\n");
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const formatMoney = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
};

const formatINR = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.00';
  return numeric.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatDateLabel = (dateStr) => {
  if (!dateStr) return '';
  try {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
};

const formatPeriodLabel = (period) => {
  if (!period) return '';
  if (period.key === 'all') return 'All time';
  if (!period.from || !period.to) return '';
  if (period.from === period.to) return formatDateLabel(period.from);
  return `${formatDateLabel(period.from)} – ${formatDateLabel(period.to)}`;
};

const formatOrderTime = (isoStr) => {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
};

const PROFIT_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This Week' },
  { key: 'last_week', label: 'Last Week' },
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'all', label: 'All Time' },
];

const EMPTY_TOTALS = {
  deliveredOrders: 0, appSales: 0, shopCost: 0, productMargin: 0,
  deliveryCharge: 0, nightCharge: 0, rainCharge: 0, fastDeliveryCharge: 0,
  chargesIncome: 0, discount: 0, freeDeliveryWaiver: 0, customerPaid: 0,
  netProfit: 0, avgOrderValue: 0, avgProfitPerOrder: 0, marginPercent: 0,
};

const ORDERS_EXPORT_PAGE_LIMIT = 100;
const ORDERS_EXPORT_ROW_CAP = 5000;

export default function Reports() {
  const [activeTab, setActiveTab] = useState('profit'); // profit, overview

  // ---- Overview tab state (unchanged behavior, moved from the old single view) ----
  const [overviewPeriod, setOverviewPeriod] = useState('today'); // today, week, month, all
  const [salesData, setSalesData] = useState(null);
  const [topProducts, setTopProducts] = useState([]);
  const [customerData, setCustomerData] = useState(null);
  const [shopsData, setShopsData] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState(null);
  const overviewPeriodRef = useRef(overviewPeriod);
  useEffect(() => { overviewPeriodRef.current = overviewPeriod; }, [overviewPeriod]);

  const fetchOverview = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setOverviewLoading(true);
      setOverviewError(null);
      const params = { period: overviewPeriodRef.current };

      const [salesRes, productsRes, custRes, shopsRes] = await Promise.all([
        ReportsApi.getSales(params).catch(() => ({ data: {} })),
        ReportsApi.getTopProducts(params).catch(() => ({ data: [] })),
        ReportsApi.getCustomers(params).catch(() => ({ data: {} })),
        ReportsApi.getShops(params).catch(() => ({ data: [] })),
      ]);

      const rawSales = salesRes.data || salesRes || {};
      const revenueByPeriod = {
        today: rawSales.today ?? rawSales.today_sales,
        week: rawSales.week ?? rawSales.week_sales,
        month: rawSales.month ?? rawSales.month_sales,
        all: rawSales.total_revenue ?? rawSales.month ?? rawSales.month_sales
      };
      setSalesData({
        ...rawSales,
        total_revenue: rawSales.total_revenue ?? revenueByPeriod[overviewPeriodRef.current] ?? 0,
        total_orders: rawSales.total_orders ?? 0,
        status_breakdown: rawSales.status_breakdown || {},
        payment_breakdown: rawSales.payment_breakdown || {},
        payment_status: rawSales.payment_status || {},
      });
      setTopProducts(productsRes.data || []);
      const rawCustomers = custRes.data || {};
      setCustomerData({
        ...rawCustomers,
        new_customers: rawCustomers.new_customers ?? rawCustomers.new_customers_30d ?? 0,
        trusted_total: rawCustomers.trusted_total ?? rawCustomers.trusted_customers ?? 0,
        blocked_total: rawCustomers.blocked_total ?? rawCustomers.blocked_customers ?? 0,
        total_users: rawCustomers.total_users ?? rawCustomers.total_customers ?? 0,
      });
      setShopsData(shopsRes.data || []);
    } catch (err) {
      console.error(err);
      setOverviewError(GENERIC_ERROR);
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'overview') fetchOverview();
  }, [overviewPeriod, activeTab, fetchOverview]);

  // ---- Profit & Payouts tab state ----
  const [profitPeriodKey, setProfitPeriodKey] = useState('today');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [showCustomRange, setShowCustomRange] = useState(false);

  const [profitSummary, setProfitSummary] = useState(null);
  const [profitLoading, setProfitLoading] = useState(false);
  const [profitError, setProfitError] = useState(null);

  const [ordersRows, setOrdersRows] = useState([]);
  const [ordersPagination, setOrdersPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState(null);
  const [ordersSort, setOrdersSort] = useState('time');
  const [ordersShopId, setOrdersShopId] = useState('');

  const [exportingOrders, setExportingOrders] = useState(false);

  const profitParamsRef = useRef({ periodKey: profitPeriodKey, customFrom, customTo });
  useEffect(() => {
    profitParamsRef.current = { periodKey: profitPeriodKey, customFrom, customTo };
  }, [profitPeriodKey, customFrom, customTo]);

  const buildPeriodParams = useCallback(() => {
    const { periodKey, customFrom: from, customTo: to } = profitParamsRef.current;
    if (periodKey === 'custom') return { period: 'custom', from, to };
    return { period: periodKey };
  }, []);

  const fetchProfitSummary = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setProfitLoading(true);
      setProfitError(null);
      const res = await ReportsApi.getProfitSummary(buildPeriodParams());
      setProfitSummary(res.data || res || null);
    } catch (err) {
      console.error(err);
      setProfitError(GENERIC_ERROR);
    } finally {
      setProfitLoading(false);
    }
  }, [buildPeriodParams]);

  const fetchProfitOrders = useCallback(async (page = 1, showLoading = true) => {
    try {
      if (showLoading) setOrdersLoading(true);
      setOrdersError(null);
      const params = {
        ...buildPeriodParams(),
        page,
        limit: 20,
        sort: ordersSort,
        shopId: ordersShopId || undefined,
      };
      const res = await ReportsApi.getProfitOrders(params);
      setOrdersRows(res.data || []);
      setOrdersPagination(res.pagination || { page: 1, limit: 20, total: 0, totalPages: 1 });
    } catch (err) {
      console.error(err);
      setOrdersError(GENERIC_ERROR);
    } finally {
      setOrdersLoading(false);
    }
  }, [buildPeriodParams, ordersSort, ordersShopId]);

  const refreshProfitTab = useCallback((showLoading = true) => {
    fetchProfitSummary(showLoading);
    fetchProfitOrders(ordersPagination.page || 1, showLoading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProfitSummary, fetchProfitOrders]);

  // Period (or custom range) changed -> reload summary + reset to page 1
  useEffect(() => {
    if (activeTab !== 'profit') return;
    if (profitPeriodKey === 'custom' && (!customFrom || !customTo)) return;
    fetchProfitSummary();
    fetchProfitOrders(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, profitPeriodKey, customFrom, customTo, fetchProfitSummary]);

  // Sort or shop filter changed -> reload orders from page 1 (summary untouched)
  useEffect(() => {
    if (activeTab !== 'profit') return;
    if (profitPeriodKey === 'custom' && (!customFrom || !customTo)) return;
    fetchProfitOrders(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersSort, ordersShopId]);

  const goToOrdersPage = (page) => {
    if (page < 1 || page > ordersPagination.totalPages) return;
    fetchProfitOrders(page);
  };

  useAdminRefresh(() => {
    if (activeTab === 'overview') fetchOverview(false);
    else refreshProfitTab(false);
  });

  const refreshTimerRef = useRef(null);
  const queueReportsRefresh = useCallback((delay = 350) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      if (activeTab === 'overview') fetchOverview(false);
      else refreshProfitTab(false);
    }, delay);
  }, [activeTab, fetchOverview, refreshProfitTab]);

  useEffect(() => {
    const unsubscribeOrders = subscribeAdminOrderEvents(() => queueReportsRefresh());
    const unsubscribeLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'visible') queueReportsRefresh();
    });
    return () => {
      unsubscribeOrders();
      unsubscribeLifecycle();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [queueReportsRefresh]);

  const handlePeriodPreset = (key) => {
    setShowCustomRange(false);
    setProfitPeriodKey(key);
  };

  const handleApplyCustomRange = () => {
    if (!customFrom || !customTo) return;
    setProfitPeriodKey('custom');
  };

  const handleExportOverviewCsv = () => {
    const headers = ['Metric', 'Value'];
    const rows = [
      ['Total Revenue', salesData?.total_revenue || 0],
      ['Total Orders', salesData?.total_orders || 0],
      ['Delivered', salesData?.status_breakdown?.delivered || 0],
      ['Cancelled', salesData?.status_breakdown?.cancelled || 0],
      ['Paid via UPI', salesData?.payment_breakdown?.upi || 0],
      ['Paid via Cash', salesData?.payment_breakdown?.cash || 0],
    ];
    downloadCsv(`serveloco_report_${overviewPeriod}_${Date.now()}.csv`, headers, rows);
  };

  const handleExportProfitSummary = () => {
    if (!profitSummary) return;
    const t = profitSummary.totals || EMPTY_TOTALS;
    const headers = ['Metric', 'Value'];
    const rows = [
      ['Period', formatPeriodLabel(profitSummary.period)],
      ['Delivered Orders', t.deliveredOrders],
      ['App Sales', formatMoney(t.appSales)],
      ['Shop Cost (Payout Due)', formatMoney(t.shopCost)],
      ['Product Margin', formatMoney(t.productMargin)],
      ['Delivery Charge', formatMoney(t.deliveryCharge)],
      ['Night Charge', formatMoney(t.nightCharge)],
      ['Rain Charge', formatMoney(t.rainCharge)],
      ['Fast Delivery Charge', formatMoney(t.fastDeliveryCharge)],
      ['Discount Given', formatMoney(t.discount)],
      ['Customer Paid', formatMoney(t.customerPaid)],
      ['Net Profit (before rider payouts)', formatMoney(t.netProfit)],
      ['Margin %', t.marginPercent],
      [],
      ['Shop', 'Delivered Orders', 'Items Sold', 'App Sales', 'Shop Cost', 'Margin'],
      ...(profitSummary.shops || []).map(s => [
        s.shopName, s.deliveredOrders, s.itemsSold, formatMoney(s.appSales), formatMoney(s.shopCost), formatMoney(s.margin)
      ]),
    ];
    downloadCsv(`villkro_profit_summary_${profitSummary.period?.key || 'range'}_${profitSummary.period?.from || ''}_${profitSummary.period?.to || ''}.csv`, headers, rows);
  };

  const handleExportOrdersCsv = async () => {
    if (exportingOrders) return;
    setExportingOrders(true);
    try {
      const rows = [];
      let page = 1;
      let totalPages = 1;
      do {
        const params = {
          ...buildPeriodParams(),
          page,
          limit: ORDERS_EXPORT_PAGE_LIMIT,
          sort: ordersSort,
          shopId: ordersShopId || undefined,
        };
        const res = await ReportsApi.getProfitOrders(params);
        const data = res.data || [];
        totalPages = res.pagination?.totalPages || 1;
        for (const o of data) {
          rows.push([
            o.orderNumber, formatOrderTime(o.createdAt), o.customerName, o.paymentMethod,
            formatMoney(o.appItemsTotal), formatMoney(o.shopCost), formatMoney(o.productMargin),
            formatMoney(o.chargesIncome), formatMoney(o.discount), formatMoney(o.customerPaid), formatMoney(o.netProfit),
          ]);
        }
        page += 1;
      } while (page <= totalPages && rows.length < ORDERS_EXPORT_ROW_CAP);

      const headers = ['Order #', 'Time', 'Customer', 'Payment', 'App', 'Shop Cost', 'Margin', 'Charges', 'Discount', 'Paid', 'Profit'];
      downloadCsv(`villkro_profit_orders_${profitSummary?.period?.key || 'range'}_${profitSummary?.period?.from || ''}_${profitSummary?.period?.to || ''}.csv`, headers, rows);
    } catch (err) {
      console.error(err);
    } finally {
      setExportingOrders(false);
    }
  };

  const totals = profitSummary?.totals || EMPTY_TOTALS;
  const warnings = profitSummary?.warnings || { unpricedItemsCount: 0, unpricedItemsAppTotal: 0, rejectedItemsCount: 0 };
  const shops = profitSummary?.shops || [];
  const pipeline = profitSummary?.pipeline || { orders: 0, value: 0 };
  const cancelled = profitSummary?.cancelled || { orders: 0, value: 0 };

  return (
    <div className="reports-container">
      <header className="reports-header">
        <h1 className="reports-title">Reports & Analytics</h1>
        <div className="reports-tabs">
          <button className={`reports-tab ${activeTab === 'profit' ? 'active' : ''}`} onClick={() => setActiveTab('profit')}>
            Profit &amp; Payouts
          </button>
          <button className={`reports-tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
        </div>
      </header>

      {activeTab === 'profit' ? (
        <>
          <section className="profit-filter-bar">
            <div className="profit-filter-presets">
              {PROFIT_PERIODS.map(p => (
                <button
                  key={p.key}
                  className={`profit-filter-btn ${profitPeriodKey === p.key && !showCustomRange ? 'active' : ''}`}
                  onClick={() => handlePeriodPreset(p.key)}
                  disabled={profitLoading}
                >
                  {p.label}
                </button>
              ))}
              <button
                className={`profit-filter-btn ${profitPeriodKey === 'custom' ? 'active' : ''}`}
                onClick={() => setShowCustomRange(v => !v)}
                disabled={profitLoading}
              >
                Custom Range
              </button>
            </div>
            {showCustomRange && (
              <div className="profit-custom-range">
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} max={customTo || undefined} />
                <span>to</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} min={customFrom || undefined} />
                <button className="btn-primary" onClick={handleApplyCustomRange} disabled={!customFrom || !customTo}>Apply</button>
              </div>
            )}
            <div className="profit-period-label">
              {profitSummary ? formatPeriodLabel(profitSummary.period) : ''}
            </div>
            <div className="profit-export-actions">
              <button className="btn-secondary" onClick={handleExportProfitSummary} disabled={profitLoading || !profitSummary}>
                Export Summary CSV
              </button>
              <button className="btn-secondary" onClick={handleExportOrdersCsv} disabled={ordersLoading || exportingOrders}>
                {exportingOrders ? 'Exporting…' : 'Export Orders CSV'}
              </button>
            </div>
          </section>

          {profitError && <div className="error-container" style={{ marginBottom: '1.25rem' }}>{profitError}</div>}

          {profitLoading && !profitSummary ? (
            <div style={{ textAlign: 'center', padding: '4rem' }}>Crunching the numbers…</div>
          ) : (
            <>
              <section className="profit-kpi-grid">
                <div className="profit-kpi-card highlight">
                  <div className="profit-kpi-label">Net Profit <span className="profit-kpi-note">before rider payouts</span></div>
                  <div className={`profit-kpi-value ${totals.netProfit >= 0 ? 'positive' : 'negative'}`}>
                    ₹{formatINR(totals.netProfit)}
                  </div>
                  <div className="profit-kpi-subtext">Avg ₹{formatINR(totals.avgProfitPerOrder)} / order</div>
                </div>
                <div className="profit-kpi-card">
                  <div className="profit-kpi-label">App Sales</div>
                  <div className="profit-kpi-value">₹{formatINR(totals.appSales)}</div>
                  <div className="profit-kpi-subtext">Customer paid ₹{formatINR(totals.customerPaid)}</div>
                </div>
                <div className="profit-kpi-card">
                  <div className="profit-kpi-label">Shop Payout Due</div>
                  <div className="profit-kpi-value">₹{formatINR(totals.shopCost)}</div>
                  <div className="profit-kpi-subtext">What we owe shops today</div>
                </div>
                <div className="profit-kpi-card">
                  <div className="profit-kpi-label">Delivered Orders</div>
                  <div className="profit-kpi-value">{totals.deliveredOrders}</div>
                  <div className="profit-kpi-subtext">Avg ₹{formatINR(totals.avgOrderValue)} / order</div>
                </div>
                <div className="profit-kpi-card">
                  <div className="profit-kpi-label">Margin %</div>
                  <div className="profit-kpi-value">{formatMoney(totals.marginPercent)}%</div>
                  <div className="profit-kpi-subtext">Net profit / customer paid</div>
                </div>
              </section>

              <section className="profit-pipeline-strip">
                <div className="profit-pipeline-item">
                  <span className="profit-pipeline-dot pending"></span>
                  In Progress: <strong>{pipeline.orders}</strong> orders (₹{formatINR(pipeline.value)}) &mdash; not counted yet
                </div>
                <div className="profit-pipeline-item">
                  <span className="profit-pipeline-dot cancelled"></span>
                  Cancelled: <strong>{cancelled.orders}</strong> orders (₹{formatINR(cancelled.value)}) &mdash; excluded
                </div>
              </section>

              {(warnings.unpricedItemsCount > 0 || warnings.rejectedItemsCount > 0) && (
                <section className="profit-warning-note">
                  {warnings.unpricedItemsCount > 0 && (
                    <div>
                      ⚠ {warnings.unpricedItemsCount} item{warnings.unpricedItemsCount === 1 ? '' : 's'} (₹{formatINR(warnings.unpricedItemsAppTotal)}) had no shop price set — counted as zero cost, so margin may read higher than actual.
                    </div>
                  )}
                  {warnings.rejectedItemsCount > 0 && (
                    <div>
                      ⚠ {warnings.rejectedItemsCount} item{warnings.rejectedItemsCount === 1 ? '' : 's'} were rejected by their shop after ordering — excluded from shop cost, but the customer still paid for them.
                    </div>
                  )}
                </section>
              )}

              <div className="profit-main-grid">
                <section className="profit-breakdown-card">
                  <h3 className="report-section-title">Profit Breakdown</h3>
                  <ul className="waterfall-list">
                    <li className="waterfall-row">
                      <span>App Sales</span>
                      <span className="waterfall-amount positive">+₹{formatINR(totals.appSales)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Shop Cost</span>
                      <span className="waterfall-amount negative">−₹{formatINR(totals.shopCost)}</span>
                    </li>
                    <li className="waterfall-row subtotal">
                      <span>= Product Margin</span>
                      <span className="waterfall-amount">₹{formatINR(totals.productMargin)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Delivery Charge</span>
                      <span className="waterfall-amount positive">+₹{formatINR(totals.deliveryCharge)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Night Charge</span>
                      <span className="waterfall-amount positive">+₹{formatINR(totals.nightCharge)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Rain Charge</span>
                      <span className="waterfall-amount positive">+₹{formatINR(totals.rainCharge)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Fast Delivery Charge</span>
                      <span className="waterfall-amount positive">+₹{formatINR(totals.fastDeliveryCharge)}</span>
                    </li>
                    <li className="waterfall-row">
                      <span>Discounts Given</span>
                      <span className="waterfall-amount negative">−₹{formatINR(totals.discount)}</span>
                    </li>
                    <li className={`waterfall-row total ${totals.netProfit >= 0 ? 'positive' : 'negative'}`}>
                      <span>= Net Profit</span>
                      <span className="waterfall-amount">₹{formatINR(totals.netProfit)}</span>
                    </li>
                  </ul>
                </section>

                <section className="profit-shops-card">
                  <h3 className="report-section-title">Shop Payout Table</h3>
                  {shops.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)' }}>No shop activity for this period.</p>
                  ) : (
                    <div className="table-scroll">
                      <table className="profit-shops-table">
                        <thead>
                          <tr>
                            <th>Shop</th>
                            <th className="num">Orders</th>
                            <th className="num">Items</th>
                            <th className="num">App ₹</th>
                            <th className="num">Shop ₹ (Payable)</th>
                            <th className="num">Margin ₹</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shops.map(s => (
                            <tr key={s.shopId ?? 'house'}>
                              <td>{s.shopName}{s.unpricedItems > 0 && <span className="unpriced-badge" title="Some items had no shop price set">!</span>}</td>
                              <td className="num">{s.deliveredOrders}</td>
                              <td className="num">{s.itemsSold}</td>
                              <td className="num">{formatMoney(s.appSales)}</td>
                              <td className="num strong">{formatMoney(s.shopCost)}</td>
                              <td className="num">{formatMoney(s.margin)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td>Total</td>
                            <td className="num">—</td>
                            <td className="num">—</td>
                            <td className="num">{formatMoney(totals.appSales)}</td>
                            <td className="num strong">{formatMoney(totals.shopCost)}</td>
                            <td className="num">{formatMoney(totals.productMargin)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </section>
              </div>

              <section className="profit-orders-card">
                <div className="profit-orders-header">
                  <h3 className="report-section-title" style={{ marginBottom: 0, paddingBottom: 0, border: 'none' }}>
                    Delivered Orders
                  </h3>
                  <div className="profit-orders-controls">
                    <select value={ordersShopId} onChange={(e) => setOrdersShopId(e.target.value)} disabled={ordersLoading}>
                      <option value="">All shops</option>
                      {shops.filter(s => s.shopId).map(s => (
                        <option key={s.shopId} value={s.shopId}>{s.shopName}</option>
                      ))}
                    </select>
                    <select value={ordersSort} onChange={(e) => setOrdersSort(e.target.value)} disabled={ordersLoading}>
                      <option value="time">Newest first</option>
                      <option value="profit">Highest profit</option>
                      <option value="value">Highest value</option>
                    </select>
                  </div>
                </div>

                {ordersError && <div className="error-container" style={{ marginBottom: '1rem' }}>{ordersError}</div>}

                {ordersRows.length === 0 && !ordersLoading ? (
                  <p style={{ color: 'var(--text-secondary)' }}>No delivered orders for this period{ordersShopId ? ' / shop' : ''}.</p>
                ) : (
                  <div className="table-scroll">
                    <table className="profit-orders-table">
                      <thead>
                        <tr>
                          <th>Order #</th>
                          <th>Time</th>
                          <th>Customer</th>
                          <th>Payment</th>
                          <th className="num">App ₹</th>
                          <th className="num">Shop ₹</th>
                          <th className="num">Margin ₹</th>
                          <th className="num">Charges ₹</th>
                          <th className="num">Discount ₹</th>
                          <th className="num">Paid ₹</th>
                          <th className="num">Profit ₹</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ordersRows.map(o => (
                          <tr key={o.id}>
                            <td>{o.orderNumber}{o.hasUnpricedItems && <span className="unpriced-badge" title="Some items had no shop price set">!</span>}</td>
                            <td>{formatOrderTime(o.createdAt)}</td>
                            <td className="truncate">{o.customerName}</td>
                            <td>{o.paymentMethod}</td>
                            <td className="num">{formatMoney(o.appItemsTotal)}</td>
                            <td className="num">{formatMoney(o.shopCost)}</td>
                            <td className="num">{formatMoney(o.productMargin)}</td>
                            <td className="num">{formatMoney(o.chargesIncome)}</td>
                            <td className="num">{formatMoney(o.discount)}</td>
                            <td className="num">{formatMoney(o.customerPaid)}</td>
                            <td className={`num strong ${o.netProfit >= 0 ? 'positive' : 'negative'}`}>{formatMoney(o.netProfit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="pagination-controls">
                  <button
                    className="pagination-btn"
                    disabled={ordersPagination.page <= 1 || ordersLoading}
                    onClick={() => goToOrdersPage(ordersPagination.page - 1)}
                  >
                    Previous
                  </button>
                  <span className="pagination-info">
                    Page {ordersPagination.page} of {ordersPagination.totalPages} &middot; {ordersPagination.total} order{ordersPagination.total === 1 ? '' : 's'}
                  </span>
                  <button
                    className="pagination-btn"
                    disabled={ordersPagination.page >= ordersPagination.totalPages || ordersLoading}
                    onClick={() => goToOrdersPage(ordersPagination.page + 1)}
                  >
                    Next
                  </button>
                </div>
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <div className="overview-controls">
            <select className="date-filter" value={overviewPeriod} onChange={(e) => setOverviewPeriod(e.target.value)} disabled={overviewLoading}>
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Time</option>
            </select>
            <button className="btn-secondary" onClick={handleExportOverviewCsv} disabled={overviewLoading || !salesData}>
              Export CSV
            </button>
          </div>

          {overviewError && <div className="error-container" style={{ marginBottom: '2rem' }}>{overviewError}</div>}

          {overviewLoading ? (
            <div style={{ textAlign: 'center', padding: '4rem' }}>Generating reports...</div>
          ) : (
            <>
              <section className="summary-grid">
                <div className="summary-card">
                  <div className="summary-label">Total Revenue</div>
                  <div className="summary-value">₹{salesData?.total_revenue?.toLocaleString() || 0}</div>
                  <div className="summary-subtext">Across {salesData?.total_orders || 0} total orders</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Delivered Orders</div>
                  <div className="summary-value">{salesData?.status_breakdown?.delivered || 0}</div>
                  <div className="summary-subtext">Successful completions</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">New Customers</div>
                  <div className="summary-value">{customerData?.new_customers || 0}</div>
                  <div className="summary-subtext">Registered in this period</div>
                </div>
              </section>

              <div className="reports-grid">
                <div className="report-section">
                  <h3 className="report-section-title">Payment Methods</h3>
                  <ul className="breakdown-list">
                    <li className="breakdown-item">
                      <span className="breakdown-name">UPI Payments</span>
                      <span className="breakdown-stat">{salesData?.payment_breakdown?.upi || 0} orders</span>
                    </li>
                    <li className="breakdown-item">
                      <span className="breakdown-name">Cash on Delivery</span>
                      <span className="breakdown-stat">{salesData?.payment_breakdown?.cash || 0} orders</span>
                    </li>
                  </ul>
                </div>

                <div className="report-section">
                  <h3 className="report-section-title">Payment Status</h3>
                  <ul className="breakdown-list">
                    <li className="breakdown-item">
                      <span className="breakdown-name">Paid (Completed)</span>
                      <span className="breakdown-stat">{(salesData?.payment_status?.paid || 0) + (salesData?.payment_status?.success || 0)}</span>
                    </li>
                    <li className="breakdown-item">
                      <span className="breakdown-name">Pending</span>
                      <span className="breakdown-stat">{salesData?.payment_status?.pending || 0}</span>
                    </li>
                    <li className="breakdown-item">
                      <span className="breakdown-name">Failed / Refunded</span>
                      <span className="breakdown-stat">{(salesData?.payment_status?.failed || 0) + (salesData?.payment_status?.refunded || 0)}</span>
                    </li>
                  </ul>
                </div>

                <div className="report-section">
                  <h3 className="report-section-title">Top Items</h3>
                  {topProducts.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)' }}>No item data available for this period.</p>
                  ) : (
                    <div className="top-items-table">
                      <div className="top-items-row top-items-head">
                        <span>Item</span>
                        <span>Units Sold</span>
                        <span>Price</span>
                      </div>
                      {topProducts.map((p) => (
                        <div key={`${p.product_id}-${p.item_type}`} className="top-items-row">
                          <span className="top-items-name">
                            {p.product_name}
                            {p.item_type === 'combo' && <span className="top-items-combo-tag">Combo</span>}
                          </span>
                          <span className="top-items-units">{p.total_quantity}</span>
                          <span className="top-items-price">₹{p.total_sales}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="report-section">
                  <h3 className="report-section-title">Customer Trust Metrics</h3>
                  <ul className="breakdown-list">
                    <li className="breakdown-item">
                      <span className="breakdown-name">Trusted Customers</span>
                      <span className="breakdown-stat" style={{ color: 'var(--success-color)' }}>{customerData?.trusted_total || 0}</span>
                    </li>
                    <li className="breakdown-item">
                      <span className="breakdown-name">Blocked Customers</span>
                      <span className="breakdown-stat" style={{ color: 'var(--danger-color)' }}>{customerData?.blocked_total || 0}</span>
                    </li>
                    <li className="breakdown-item">
                      <span className="breakdown-name">Total Platform Users</span>
                      <span className="breakdown-stat">{customerData?.total_users || 0}</span>
                    </li>
                  </ul>
                </div>
              </div>

              <section className="shops-report-section">
                <h3 className="report-section-title">Shop-wise Performance</h3>
                {shopsData.length === 0 ? (
                  <p style={{ color: 'var(--text-secondary)' }}>No shop activity for this period.</p>
                ) : (
                  <div className="shops-report-grid">
                    {shopsData.map((shop) => {
                      const orderCount = Number(shop.order_count) || 0;
                      const itemsSold = Number(shop.total_items_sold) || 0;
                      return (
                      <div className="shop-report-card" key={shop.shop_id ?? 'house'}>
                        <div className="shop-report-header">
                          <span className="shop-report-name">{shop.shop_name}</span>
                          <span className="shop-report-amount">₹{formatMoney(shop.total_amount)}</span>
                        </div>
                        <div className="shop-report-subtext">
                          {orderCount} order{orderCount === 1 ? '' : 's'} • {itemsSold} item{itemsSold === 1 ? '' : 's'} sold
                        </div>
                        <ul className="shop-report-products">
                          {shop.products.map((p) => (
                            <li key={`${p.product_id}-${p.item_type}`} className="shop-report-product-row">
                              <span className="shop-report-product-name">
                                {p.product_name}
                                {p.item_type === 'combo' && <span className="shop-report-combo-tag">Combo</span>}
                              </span>
                              <span className="shop-report-product-qty">x{p.quantity}</span>
                              <span className="shop-report-product-price">₹{formatMoney(p.total_sales)}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="shop-report-footer">
                          <span>Total products sold</span>
                          <strong>{itemsSold}</strong>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
