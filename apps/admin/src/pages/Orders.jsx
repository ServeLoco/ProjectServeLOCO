import React, { useCallback, useEffect, useRef, useState } from 'react';
import { OrdersApi, subscribeAdminOrderEvents, subscribeRealtimeLifecycle } from '../api';
import MessageBanner from '../components/MessageBanner';
import LiveOrderMap from '../components/LiveOrderMap';
import CreateOrderModal from '../components/CreateOrderModal';
import { GENERIC_ERROR } from '../utils/constants';
import { readList } from '../utils/apiResponse';
import { useAdminRefresh } from '../hooks/useAdminRefresh';
import {
  getRealtimeOrderId,
  getRealtimeOrderKey,
  isRecentRealtimeEvent,
  mergeAdminOrderPatch,
  broadcastAdminOrderStatus,
} from '../utils/realtimeOrder';
import './Orders.css';

const ORDER_STATUS_OPTIONS = [
  { value: 'Pending', label: 'Order Placed' },
  { value: 'Accepted', label: 'Order Accepted' },
  { value: 'Preparing', label: 'Preparing/Packing' },
  { value: 'Out for Delivery', label: 'Out for Delivery' },
  { value: 'Delivered', label: 'Delivered' },
  { value: 'Cancelled', label: 'Cancelled' },
];
const ORDER_STATUS_LABELS = ORDER_STATUS_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {});
const getOrderStatusLabel = (status) => ORDER_STATUS_LABELS[status] || status || 'Unknown';
const formatMoney = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
};
const escapeCsvCell = (value) => {
  let s = String(value ?? '');
  // Prevent formula injection: neutralize leading =,+,-,@ that spreadsheet
  // apps (Excel/LibreOffice) evaluate as formulas when a CSV is opened.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');
const EMPTY_FILTERS = {
  status: '',
  paymentStatus: '',
  paymentMethod: '',
  search: '',
  dateFrom: '',
  dateTo: '',
};
const formatDateTime = (value) => {
  if (!value) return 'Not captured';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
const statusClassName = (status) => String(status || 'unknown').toLowerCase().replace(/\s+/g, '-');
// Local YYYY-MM-DD (not toISOString, which shifts to UTC and can land on the
// wrong day near midnight for IST users).
const todayStr = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export default function Orders() {
  const [orders, setOrders] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // Default view is "today only". History mode lets the admin pick any date
  // range to browse older orders; leaving history mode snaps back to today.
  const [historyMode, setHistoryMode] = useState(false);

  const [selectedOrder, setSelectedOrder] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [remarkDraft, setRemarkDraft] = useState('');
  const [remarkSaving, setRemarkSaving] = useState(false);
  const [pageMessage, setPageMessage] = useState(null);
  const [showCreateOrder, setShowCreateOrder] = useState(false);
  const filtersRef = useRef(filters);
  const historyModeRef = useRef(historyMode);
  const paginationRef = useRef(pagination);
  const selectedOrderRef = useRef(selectedOrder);
  const refreshTimerRef = useRef(null);
  const selectedRefreshTimerRef = useRef(null);
  const recentRealtimeEvents = useRef({});

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    historyModeRef.current = historyMode;
  }, [historyMode]);

  useEffect(() => {
    paginationRef.current = pagination;
  }, [pagination]);

  useEffect(() => {
    selectedOrderRef.current = selectedOrder;
  }, [selectedOrder]);

  const fetchOrders = useCallback(async (page = 1) => {
    try {
      setLoading(true);
      setError(null);
      
      const params = { page, limit: 20, ...filtersRef.current };
      if (!historyModeRef.current) {
        // Default view: today only, regardless of any stale date filter state.
        params.dateFrom = todayStr();
        params.dateTo = todayStr();
      }
      Object.keys(params).forEach(k => !params[k] && delete params[k]);

      const res = await OrdersApi.list(params);
      setOrders(readList(res, ['orders']));
      if (res.pagination) {
        setPagination(res.pagination);
      }
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSelectedOrder = useCallback(async (id) => {
    if (!id) return;

    try {
      const res = await OrdersApi.get(id);
      setSelectedOrder(res.data);
    } catch (err) {
      setSelectedOrder(null);
      fetchOrders(paginationRef.current.page || 1);
    }
  }, [fetchOrders]);

  const queueOrdersRefresh = useCallback((page = paginationRef.current.page || 1, delay = 350) => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = setTimeout(() => {
      fetchOrders(page);
    }, delay);
  }, [fetchOrders]);

  const queueSelectedRefresh = useCallback((id, delay = 350) => {
    if (selectedRefreshTimerRef.current) {
      clearTimeout(selectedRefreshTimerRef.current);
    }

    selectedRefreshTimerRef.current = setTimeout(() => {
      fetchSelectedOrder(id);
    }, delay);
  }, [fetchSelectedOrder]);

  useEffect(() => {
    // Debounce so typing in the search box doesn't fire a request per keystroke.
    const timer = setTimeout(() => fetchOrders(1), 300);
    return () => clearTimeout(timer);
  }, [filters, historyMode]);

  useAdminRefresh(() => fetchOrders(paginationRef.current.page || 1));

  useEffect(() => {
    // Close the drawer when the new-order popup in GlobalOrderAlert accepts
    // or cancels an order — otherwise the drawer would stay open on the
    // previous order and hide the new one in the list behind it.
    const onCloseDrawer = () => setSelectedOrder(null);
    window.addEventListener('admin:close-order-drawer', onCloseDrawer);
    return () => window.removeEventListener('admin:close-order-drawer', onCloseDrawer);
  }, []);

  // Reset the remark draft whenever the drawer switches to a different order
  // (or closes) so a half-typed note doesn't leak onto the next order.
  useEffect(() => {
    setRemarkDraft(selectedOrder?.admin_remark || '');
  }, [selectedOrder?.id]);

  useEffect(() => {
    const unsubscribeOrders = subscribeAdminOrderEvents(({ eventName, payload }) => {
      const eventKey = getRealtimeOrderKey(eventName, payload);
      if (isRecentRealtimeEvent(recentRealtimeEvents, eventKey)) return;

      const page = paginationRef.current.page || 1;
      const activeFilters = filtersRef.current;

      if (eventName === 'admin.order.created') {
        queueOrdersRefresh(Object.values(activeFilters).some(Boolean) ? page : 1);
        return;
      }

      if (eventName === 'admin.order.shop_confirmed' || eventName === 'admin.order.shop_ready') {
        const eventOrderId = getRealtimeOrderId(payload);
        if (eventOrderId && selectedOrderRef.current && String(selectedOrderRef.current.id) === eventOrderId) {
          // Optimistic badge update — no HTTP wait for confirm/ready.
          const action = eventName === 'admin.order.shop_confirmed' ? 'confirmed' : 'ready';
          setSelectedOrder((prev) => {
            if (!prev || String(prev.id) !== eventOrderId) return prev;
            return mergeAdminOrderPatch(prev, { ...payload, action });
          });
        }
        return;
      }

      if (eventName === 'admin.order.rider_updated') {
        // Dispatch-lifecycle metadata for the Riders.jsx dispatch panel — its
        // `status` field is a rider-offer label ('offered'/'assigned'/
        // 'picked_up'/'failed'), not an orders.status value. Real order
        // status transitions (Out for Delivery/Delivered/etc.) are already
        // emitted separately as 'admin.order.updated' before this event, so
        // ignoring it here avoids clobbering the list/drawer status chip.
        return;
      }

      const eventOrderId = getRealtimeOrderId(payload);
      if (!eventOrderId) return;

      setOrders(prevOrders => {
        let found = false;
        const patchedOrders = prevOrders.map(order => {
          if (String(order.id) !== eventOrderId) return order;
          found = true;
          return mergeAdminOrderPatch(order, payload);
        });

        if (!found) {
          queueOrdersRefresh(page);
        }

        return patchedOrders;
      });

      // Pure realtime: patch list + open drawer (status, cancel badges) from
      // the socket payload — no forced HTTP refetch for status changes.
      setSelectedOrder(prevSelected => {
        if (!prevSelected || String(prevSelected.id) !== eventOrderId) {
          return prevSelected;
        }
        return mergeAdminOrderPatch(prevSelected, payload);
      });

      if (activeFilters.status || activeFilters.paymentStatus) {
        queueOrdersRefresh(page);
      }
    });

    const unsubscribeLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'visible') {
        const page = paginationRef.current.page || 1;
        queueOrdersRefresh(page);
        if (selectedOrderRef.current?.id) {
          queueSelectedRefresh(selectedOrderRef.current.id);
        }
      }
    });

    return () => {
      unsubscribeOrders();
      unsubscribeLifecycle();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (selectedRefreshTimerRef.current) clearTimeout(selectedRefreshTimerRef.current);
    };
  }, [queueOrdersRefresh, queueSelectedRefresh]);

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const handleQuickFilter = (status) => {
    setFilters(prev => ({ ...prev, status }));
  };

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  const openHistory = () => {
    setFilters(EMPTY_FILTERS);
    setHistoryMode(true);
  };
  const backToToday = () => {
    setFilters(EMPTY_FILTERS);
    setHistoryMode(false);
  };

  const handleRowClick = async (id) => {
    try {
      setUpdating(true);
      const res = await OrdersApi.get(id);
      setSelectedOrder(res.data);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setUpdating(false);
    }
  };

  const closeDrawer = () => setSelectedOrder(null);

  const handleStatusChange = async (e) => {
    const newStatus = e.target.value;
    if (!selectedOrder) return;

    // Cancellation needs a reason so audit logs and customer notifications
    // explain what happened. Surface a small prompt before the confirm.
    let cancelReason = null;
    if (newStatus === 'Cancelled') {
      const reason = window.prompt(
        'Reason for cancellation (shown to the customer on Track Order). Leave blank for a default store message:',
        ''
      );
      if (reason === null) return; // user pressed cancel
      cancelReason = reason.trim() || null;
    }

    if (!window.confirm(`Change order status to ${getOrderStatusLabel(newStatus)}?`)) return;

    // Disable the dropdowns immediately so the admin can't race against
    // the GET-then-PATCH sequence below.
    setUpdating(true);

    // Refetch the latest order from the server BEFORE submitting so we
    // never overwrite a concurrent change (e.g. the customer cancelled via
    // the app while the confirm dialog was open). The previous closure-based
    // snapshot check was guaranteed to compare against itself and so always
    // passed.
    let latest;
    try {
      const res = await OrdersApi.get(selectedOrder.id);
      latest = res?.data || res;
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || GENERIC_ERROR);
      setUpdating(false);
      return;
    }
    if (!latest || latest.status !== selectedOrder.status) {
      setError(`Order was updated by someone else (current status: ${getOrderStatusLabel(latest?.status)}). Please review.`);
      // Don't re-open the drawer if the admin closed it during the await.
      setSelectedOrder(prev => prev && prev.id === latest?.id ? latest : prev);
      fetchOrders(paginationRef.current.page || 1);
      setUpdating(false);
      return;
    }

    try {
      const patchRes = await OrdersApi.updateStatus(selectedOrder.id, newStatus, cancelReason);
      // Merge server fields into the open drawer — do not replace wholesale
      // (PATCH body has no shopConfirmations/items; replacing wiped badges).
      const serverOrder = patchRes?.order;
      if (serverOrder) {
        setSelectedOrder((prev) => {
          if (!prev || prev.id !== serverOrder.id) return prev;
          return mergeAdminOrderPatch(
            { ...prev, ...serverOrder, shopConfirmations: prev.shopConfirmations, items: prev.items || serverOrder.items },
            { status: serverOrder.status, paymentStatus: serverOrder.payment_status, cancel_reason: serverOrder.cancel_reason }
          );
        });
      }
      // Same-tab realtime for Shops panel (socket also fires; this is instant).
      broadcastAdminOrderStatus({
        orderId: selectedOrder.id,
        status: newStatus,
        cancelReason,
      });
      // Patch list row optimistically (status + payment chip) without full page reload.
      setOrders((prev) => prev.map((o) => (
        o.id === selectedOrder.id
          ? mergeAdminOrderPatch(o, {
              status: newStatus,
              cancel_reason: cancelReason,
              paymentStatus: serverOrder?.payment_status,
            })
          : o
      )));
    } catch (err) {
      console.error(err);
      const apiMsg = err?.response?.data?.message;
      if (err?.response?.status === 409) {
        setError(apiMsg || 'This order was updated by someone else.');
        await fetchSelectedOrder(selectedOrder.id);
      } else {
        setError(apiMsg || GENERIC_ERROR);
      }
    } finally {
      setUpdating(false);
    }
  };

  const handlePaymentChange = async (e) => {
    const newPayment = e.target.value;
    if (!selectedOrder) return;
    if (!window.confirm(`Change payment status to ${newPayment}?`)) return;

    setUpdating(true);

    // Same race-condition fix as handleStatusChange — refetch the latest
    // server state before mutating.
    let latest;
    try {
      const res = await OrdersApi.get(selectedOrder.id);
      latest = res?.data || res;
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || GENERIC_ERROR);
      setUpdating(false);
      return;
    }
    if (!latest || latest.payment_status !== selectedOrder.payment_status) {
      setError(`Order payment status was updated by someone else (current: ${latest?.payment_status}). Please review.`);
      setSelectedOrder(prev => prev && prev.id === latest?.id ? latest : prev);
      fetchOrders(paginationRef.current.page || 1);
      setUpdating(false);
      return;
    }

    try {
      const patchRes = await OrdersApi.updatePayment(selectedOrder.id, newPayment);
      const serverOrder = patchRes?.order;
      if (serverOrder) {
        setSelectedOrder(prev => prev && prev.id === serverOrder.id ? serverOrder : prev);
      }
      fetchOrders(paginationRef.current.page || 1);
    } catch (err) {
      console.error(err);
      const apiMsg = err?.response?.data?.message;
      if (err?.response?.status === 409) {
        setError(apiMsg || 'This order was updated by someone else.');
        await fetchSelectedOrder(selectedOrder.id);
      } else {
        setError(apiMsg || GENERIC_ERROR);
      }
    } finally {
      setUpdating(false);
    }
  };

  const handleSaveRemark = async () => {
    if (!selectedOrder) return;
    const trimmed = remarkDraft.trim();
    setRemarkSaving(true);
    try {
      const patchRes = await OrdersApi.updateRemark(selectedOrder.id, trimmed);
      const serverOrder = patchRes?.order;
      const nextRemark = serverOrder ? serverOrder.admin_remark : (trimmed || null);
      setSelectedOrder((prev) => (
        prev ? { ...prev, admin_remark: nextRemark, adminRemark: nextRemark } : prev
      ));
      setOrders((prev) => prev.map((o) => (
        o.id === selectedOrder.id
          ? mergeAdminOrderPatch(o, { admin_remark: nextRemark })
          : o
      )));
      setRemarkDraft(nextRemark || '');
    } catch (err) {
      console.error(err);
      setError(err?.response?.data?.message || err?.message || GENERIC_ERROR);
    } finally {
      setRemarkSaving(false);
    }
  };

  const handleExportCSV = async () => {
    try {
      setLoading(true);
      const params = { page: 1, limit: 1000, ...filters };
      Object.keys(params).forEach(k => !params[k] && delete params[k]);
      
      const res = await OrdersApi.list(params);
      const allFilteredOrders = readList(res, ['orders']);
      
      if (allFilteredOrders.length === 0) {
        setPageMessage({ type: 'warning', text: 'No orders found to export' });
        setLoading(false);
        return;
      }

      const headers = [
        'Order #',
        'Date',
        'Customer Name',
        'Phone',
        'WhatsApp',
        'Subtotal',
        'Delivery Charge',
        'Night Charge',
        'Rain Charge',
        'Fast Delivery Add-on',
        'Total',
        'Payment Method',
        'Payment Status',
        'Fulfillment Status',
        'Note'
      ];

      const rows = allFilteredOrders.map(o => [
        `#${o.order_number}`,
        new Date(o.created_at).toLocaleString(),
        o.customer_name || '',
        o.phone || '',
        o.whatsapp_number || '',
        `₹${formatMoney(o.subtotal)}`,
        `₹${formatMoney(o.delivery_charge)}`,
        `₹${formatMoney(o.night_charge || 0)}`,
        `₹${formatMoney(o.rain_charge || 0)}`,
        `₹${formatMoney(o.fast_delivery_charge || 0)}`,
        `₹${formatMoney(o.total)}`,
        o.payment_method || '',
        o.payment_status || '',
        o.status || '',
        o.note || ''
      ]);

      const csvContent = "data:text/csv;charset=utf-8," 
        + [headers.map(escapeCsvCell).join(",")]
          .concat(rows.map(r => r.map(escapeCsvCell).join(",")))
          .join("\n");

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `serveloco_orders_${new Date().getTime()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const handlePrintInvoice = () => {
    if (!selectedOrder) return;
    const itemsHtml = (selectedOrder.items || []).map(item => `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td style="text-align: center;">${escapeHtml(item.quantity)}</td>
        <td style="text-align: right;">Rs. ${formatMoney(item.unit_price)}</td>
        <td style="text-align: right;">Rs. ${formatMoney(item.line_total)}</td>
      </tr>
    `).join('');

    const invoiceHtml = `
      <html>
      <head>
        <title>Invoice - #${escapeHtml(selectedOrder.order_number)}</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; color: #333; }
          .header { display: flex; justify-content: space-between; border-bottom: 2px solid #eee; padding-bottom: 20px; margin-bottom: 20px; }
          .title { font-size: 24px; font-weight: bold; }
          .details { margin-bottom: 30px; line-height: 1.6; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
          th, td { padding: 10px; border-bottom: 1px solid #eee; text-align: left; }
          th { background: #f8fafc; }
          .totals { text-align: right; line-height: 1.8; }
          .totals strong { font-size: 18px; color: #0E1116; }
          @media print {
            body { padding: 0; }
            .no-print { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
             <div class="title">ServeLoco</div>
             <div>Quick Commerce & Grocery Delivery</div>
          </div>
          <div style="text-align: right;">
             <div style="font-weight: bold; font-size: 18px;">INVOICE</div>
             <div>Order #${escapeHtml(selectedOrder.order_number)}</div>
             <div>Date: ${new Date(selectedOrder.created_at).toLocaleString()}</div>
          </div>
        </div>
        <div class="details">
          <strong>Customer Details:</strong><br/>
          Name: ${escapeHtml(selectedOrder.customer_name)}<br/>
          Phone: ${escapeHtml(selectedOrder.phone)}<br/>
          Address: ${escapeHtml(selectedOrder.address)}<br/>
          ${selectedOrder.note ? `Note: ${escapeHtml(selectedOrder.note)}` : ''}
        </div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Price</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
        <div class="totals">
          <div>Subtotal: Rs. ${formatMoney(selectedOrder.subtotal)}</div>
          <div>Delivery Charge: Rs. ${formatMoney(selectedOrder.delivery_charge)}</div>
          ${selectedOrder.night_charge > 0 ? `<div>Night Charge: Rs. ${formatMoney(selectedOrder.night_charge)}</div>` : ''}
          ${selectedOrder.rain_charge > 0 ? `<div>Rain Charge: Rs. ${formatMoney(selectedOrder.rain_charge)}</div>` : ''}
          ${selectedOrder.fast_delivery_charge > 0 ? `<div>Fast Delivery Add-on: Rs. ${formatMoney(selectedOrder.fast_delivery_charge)}</div>` : ''}
          <div style="margin-top: 10px;"><strong>Grand Total: Rs. ${formatMoney(selectedOrder.total)}</strong></div>
        </div>
        <div style="margin-top: 40px; text-align: center; color: #888; font-size: 12px;">
          Thank you for shopping with ServeLoco!
        </div>
      </body>
      </html>
    `;

    const previousFrame = document.getElementById('invoice-print-frame');
    if (previousFrame) previousFrame.remove();

    const printFrame = document.createElement('iframe');
    printFrame.id = 'invoice-print-frame';
    printFrame.title = 'Invoice print frame';
    printFrame.style.position = 'fixed';
    printFrame.style.right = '0';
    printFrame.style.bottom = '0';
    printFrame.style.width = '0';
    printFrame.style.height = '0';
    printFrame.style.border = '0';
    document.body.appendChild(printFrame);

    printFrame.onload = () => {
      const frameWindow = printFrame.contentWindow;
      if (!frameWindow) {
        setPageMessage({ type: 'error', text: 'Unable to open print preview. Please try again.' });
        printFrame.remove();
        return;
      }

      frameWindow.focus();
      frameWindow.print();
      setTimeout(() => printFrame.remove(), 1000);
    };

    printFrame.srcdoc = invoiceHtml;
  };

  const isTerminalState = (status) => ['Delivered', 'Cancelled'].includes(status);
  const formatKm = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric.toFixed(2)} km` : 'Not captured';
  };
  const isFreeDeliverySnapshot = (value) => value === true || value === 1 || value === '1' || value === 'true';
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const totalOrders = pagination.total || orders.length;
  const visibleTotal = orders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
  const liveOrderCount = orders.filter(order => !['Delivered', 'Cancelled'].includes(order.status)).length;

  return (
    <div className="orders-container">
      <header className="orders-header">
        <div>
          <h1 className="orders-title">Orders Management</h1>
          <p className="orders-subtitle">Newest orders are shown first. Open any row to update status, payment, invoice, or delivery details.</p>
        </div>
        <div className="orders-header-actions">
          <button className="btn-primary" onClick={() => setShowCreateOrder(true)}>
            + Create Order
          </button>
          <button className="btn-secondary" onClick={() => fetchOrders(pagination.page)} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          {historyMode ? (
            <button className="btn-secondary" onClick={backToToday}>
              ← Back to Today
            </button>
          ) : (
            <button className="btn-secondary" onClick={openHistory}>
              Order History
            </button>
          )}
          <button
            className="btn-export"
            onClick={handleExportCSV}
            disabled={loading || orders.length === 0}
          >
            Export CSV
          </button>
        </div>
      </header>

      {showCreateOrder && (
        <CreateOrderModal
          onClose={() => setShowCreateOrder(false)}
          onCreated={(order) => {
            setShowCreateOrder(false);
            setPageMessage({
              type: 'success',
              text: `Order #${order?.orderNumber || order?.order_number || ''} placed for the customer.`,
            });
            fetchOrders(1);
          }}
        />
      )}

      <MessageBanner
        type={pageMessage?.type || 'info'}
        message={pageMessage?.text}
        onDismiss={() => setPageMessage(null)}
      />

      <section className="orders-summary-grid" aria-label="Orders summary">
        <div className="orders-summary-card">
          <span className="summary-label">Total Matching</span>
          <strong>{totalOrders}</strong>
        </div>
        <div className="orders-summary-card">
          <span className="summary-label">Live Orders</span>
          <strong>{liveOrderCount}</strong>
        </div>
        <div className="orders-summary-card">
          <span className="summary-label">Visible Value</span>
          <strong>₹{formatMoney(visibleTotal)}</strong>
        </div>
        <div className="orders-summary-card">
          <span className="summary-label">Sort</span>
          <strong>Recent first</strong>
        </div>
      </section>

      <section className="orders-filter-bar">
        <div className="filter-row">
          <input
            type="text"
            name="search"
            placeholder="Search Order #, Name, Phone..."
            className="filter-input filter-search"
            value={filters.search}
            onChange={handleFilterChange}
          />
          <select name="status" className="filter-select" value={filters.status} onChange={handleFilterChange}>
            <option value="">All Statuses</option>
            {ORDER_STATUS_OPTIONS.map(status => (
              <option key={status.value} value={status.value}>{status.label}</option>
            ))}
          </select>
          <select name="paymentStatus" className="filter-select" value={filters.paymentStatus} onChange={handleFilterChange}>
            <option value="">All Payment Status</option>
            <option value="Pending">Pending</option>
            <option value="Paid">Paid</option>
            <option value="Success">Success</option>
            <option value="Failed">Failed</option>
            <option value="Refunded">Refunded</option>
          </select>
          <select name="paymentMethod" className="filter-select" value={filters.paymentMethod} onChange={handleFilterChange}>
            <option value="">All Payment Methods</option>
            <option value="Cash">Cash</option>
            <option value="UPI">UPI</option>
          </select>
          <div className="date-filters">
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>From:</span>
            <input
              type="date"
              name="dateFrom"
              className="filter-input"
              value={filters.dateFrom}
              onChange={handleFilterChange}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>To:</span>
            <input
              type="date"
              name="dateTo"
              className="filter-input"
              value={filters.dateTo}
              onChange={handleFilterChange}
            />
            {activeFilterCount > 0 && (
              <button type="button" className="btn-reset-filters" onClick={clearFilters}>
                Clear filters ({activeFilterCount})
              </button>
            )}
          </div>
        </div>
        <div className="filter-chips">
          <span className={`filter-chip ${!filters.status ? 'active' : ''}`} onClick={() => handleQuickFilter('')}>All</span>
          <span className={`filter-chip ${filters.status === 'Pending' ? 'active' : ''}`} onClick={() => handleQuickFilter('Pending')}>Order Placed</span>
          <span className={`filter-chip ${filters.status === 'Accepted' ? 'active' : ''}`} onClick={() => handleQuickFilter('Accepted')}>Accepted</span>
          <span className={`filter-chip ${filters.status === 'Preparing' ? 'active' : ''}`} onClick={() => handleQuickFilter('Preparing')}>Preparing/Packing</span>
          <span className={`filter-chip ${filters.status === 'Out for Delivery' ? 'active' : ''}`} onClick={() => handleQuickFilter('Out for Delivery')}>Out for Delivery</span>
          <span className={`filter-chip ${filters.status === 'Delivered' ? 'active' : ''}`} onClick={() => handleQuickFilter('Delivered')}>Delivered</span>
          <span className={`filter-chip ${filters.status === 'Cancelled' ? 'active' : ''}`} onClick={() => handleQuickFilter('Cancelled')}>Cancelled</span>
        </div>
      </section>

      {error && <div className="error-container" style={{ margin: '0 0 2rem 0' }}>{error}</div>}

      <section className="orders-table-wrapper">
        {loading && orders.length > 0 && <div className="table-refresh-bar">Refreshing latest orders...</div>}
        <table className="orders-table">
          <thead>
            <tr>
              <th>Order #</th>
              <th>Date</th>
              <th>Customer</th>
              <th>Items Ordered</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Payment</th>
            </tr>
          </thead>
          <tbody>
            {loading && orders.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>Loading orders...</td></tr>
            ) : orders.length === 0 ? (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '2rem' }}>No orders found.</td></tr>
            ) : (
              orders.map(order => (
                <tr key={order.id} onClick={() => handleRowClick(order.id)}>
                  <td className="order-id">
                    #{order.order_number}
                    {(order.deliveryType || order.delivery_type) === 'fast' && (
                      <span className="fast-delivery-tag">⚡ Fast</span>
                    )}
                    {(order.adminRemark || order.admin_remark) && (
                      <span className="admin-remark-tag" title={order.adminRemark || order.admin_remark}>📝 Note</span>
                    )}
                    <span className="row-hint">Open details</span>
                  </td>
                  <td className="date-cell">{formatDateTime(order.created_at)}</td>
                  <td>
                    <span className="customer-name">{order.customer_name}</span>
                    <span className="customer-phone">{order.phone}</span>
                  </td>
                  <td className="items-cell">
                    {(order.items || []).length === 0 ? (
                      <span className="row-hint">No items</span>
                    ) : (
                      order.items.map((item, idx) => (
                        <div className="item-line" key={idx}>
                          <span className="item-line-name">
                            {item.quantity}x {item.product_name}
                            {item.variant_label ? ` (${item.variant_label})` : ''}
                          </span>
                          <span className="item-line-price">₹{formatMoney(item.line_total)}</span>
                        </div>
                      ))
                    )}
                  </td>
                  <td className="amount-cell">₹{formatMoney(order.total)}</td>
                  <td>
                    <span className={`status-badge ${statusClassName(order.status)}`}>
                      {getOrderStatusLabel(order.status)}
                    </span>
                  </td>
                  <td>
                    <span className={`payment-pill ${statusClassName(order.payment_status)}`}>{order.payment_status}</span>
                    <span className="payment-method">{order.payment_method}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        
        <div className="pagination-controls">
          <button 
            className="pagination-btn" 
            disabled={pagination.page <= 1 || loading}
            onClick={() => fetchOrders(pagination.page - 1)}
          >
            Previous
          </button>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button 
            className="pagination-btn" 
            disabled={pagination.page >= pagination.totalPages || loading}
            onClick={() => fetchOrders(pagination.page + 1)}
          >
            Next
          </button>
        </div>
      </section>

      {selectedOrder && (
        <div className="drawer-overlay" onClick={closeDrawer}>
          <div className="drawer-content" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <h3 className="drawer-title">Order #{selectedOrder.order_number}</h3>
                <p className="drawer-subtitle">{formatDateTime(selectedOrder.created_at)} • ₹{formatMoney(selectedOrder.total)}</p>
              </div>
              <span className={`status-badge ${statusClassName(selectedOrder.status)}`}>
                {getOrderStatusLabel(selectedOrder.status)}
              </span>
              {(selectedOrder.deliveryType || selectedOrder.delivery_type) === 'fast' && (
                <span className="status-badge" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#b45309' }}>
                  ⚡ Fast Delivery
                </span>
              )}
              <button className="drawer-close" onClick={closeDrawer}>&times;</button>
            </div>
            
            <div className="drawer-body">
              {selectedOrder.status !== 'Cancelled' ? (
                <LiveOrderMap order={selectedOrder} />
              ) : null}

              <div className="detail-section">
                <h4>Customer Details</h4>
                <div className="detail-row">
                  <span>Name:</span>
                  <strong>
                    {selectedOrder.customer_name}
                    {selectedOrder.customer_trusted && <span className="badge-trusted-inline">✓ Trusted</span>}
                  </strong>
                </div>
                <div className="detail-row"><span>Phone:</span> <strong>{selectedOrder.phone}</strong></div>
                <div className="detail-row"><span>Address:</span> <strong>{selectedOrder.address}</strong></div>
                <div className="action-buttons" style={{ flexWrap: 'wrap' }}>
                  {selectedOrder.phone && (
                    <a href={`https://wa.me/${selectedOrder.phone.replace(/[^0-9]/g, '')}`} target="_blank" rel="noreferrer" className="btn-whatsapp">
                      WhatsApp
                    </a>
                  )}
                  {selectedOrder.map_url && (
                    <a href={selectedOrder.map_url} target="_blank" rel="noreferrer" className="btn-map">
                      View Map
                    </a>
                  )}
                  <button onClick={handlePrintInvoice} className="btn-print">
                    Print Invoice
                  </button>
                </div>
              </div>

              <div className="detail-section">
                <h4>Delivery Pricing</h4>
                <div className="detail-row">
                  <span>Distance:</span>
                  <strong>{formatKm(selectedOrder.delivery_distance_km)}</strong>
                </div>
                <div className="detail-row">
                  <span>Zone extent:</span>
                  <strong>{formatKm(selectedOrder.delivery_radius_km_snapshot)}</strong>
                </div>
                <div className="detail-row">
                  <span>Cost per km:</span>
                  <strong>
                    {selectedOrder.delivery_cost_per_km_snapshot !== null && selectedOrder.delivery_cost_per_km_snapshot !== undefined
                      ? `₹${selectedOrder.delivery_cost_per_km_snapshot}`
                      : 'Not captured'}
                  </strong>
                </div>
                <div className="detail-row">
                  <span>Free delivery offer:</span>
                  <strong>{isFreeDeliverySnapshot(selectedOrder.free_delivery_offer_snapshot) ? 'Applied' : 'Not applied'}</strong>
                </div>
              </div>

              {(selectedOrder.riderId || selectedOrder.rider_id || selectedOrder.riderAssignmentStatus === 'searching' || selectedOrder.riderAssignmentStatus === 'offered' || selectedOrder.riderAssignmentStatus === 'failed') && (
                <div className="detail-section">
                  <h4>Delivery / Rider</h4>
                  {selectedOrder.riderId || selectedOrder.rider_id ? (
                    <>
                      <div className="detail-row"><span>Rider:</span> <strong>{selectedOrder.riderName || `#${selectedOrder.riderId || selectedOrder.rider_id}`}</strong></div>
                      <div className="detail-row"><span>Assigned:</span> <strong>{formatDateTime(selectedOrder.rider_assigned_at)}</strong></div>
                      {selectedOrder.rider_picked_up_at && (
                        <div className="detail-row"><span>Picked up:</span> <strong>{formatDateTime(selectedOrder.rider_picked_up_at)}</strong></div>
                      )}
                    </>
                  ) : (
                    <div className="detail-row">
                      <span>Assignment:</span>
                      <strong style={{ color: selectedOrder.riderAssignmentStatus === 'failed' ? '#b91c1c' : 'inherit' }}>
                        {selectedOrder.riderAssignmentStatus === 'searching' ? 'Searching for a rider…'
                          : selectedOrder.riderAssignmentStatus === 'offered' ? 'Offer sent — awaiting rider response'
                          : selectedOrder.riderAssignmentStatus === 'failed' ? 'No rider accepted — order cancelled'
                          : 'Not started'}
                      </strong>
                    </div>
                  )}
                  {selectedOrder.status === 'Cancelled' && selectedOrder.cancel_reason && (
                    <div className="detail-row"><span>Cancel reason:</span> <strong>{selectedOrder.cancel_reason}</strong></div>
                  )}
                </div>
              )}

              <div className="detail-section">
                <h4>Order Status Management</h4>
                <div className="status-update-row">
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Fulfillment Status</label>
                  <select 
                    value={selectedOrder.status} 
                    onChange={handleStatusChange}
                    disabled={updating || isTerminalState(selectedOrder.status)}
                  >
                    {ORDER_STATUS_OPTIONS.map(status => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </div>

                <div className="status-update-row">
                  <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Payment Status</label>
                  <select 
                    value={selectedOrder.payment_status} 
                    onChange={handlePaymentChange}
                    disabled={updating || isTerminalState(selectedOrder.status)}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Paid">Paid</option>
                    <option value="Success">Success</option>
                    <option value="Failed">Failed</option>
                    <option value="Refunded">Refunded</option>
                  </select>
                </div>
              </div>

              <div className="detail-section">
                <h4>Admin Remark</h4>
                <p className="admin-remark-caption">Visible to the shop owner in their order history.</p>
                <textarea
                  className="admin-remark-textarea"
                  value={remarkDraft}
                  onChange={(e) => setRemarkDraft(e.target.value)}
                  placeholder="e.g. Delayed — rider shortage in this area"
                  disabled={remarkSaving}
                  rows={3}
                  maxLength={1000}
                />
                <button
                  type="button"
                  className="admin-remark-save-btn"
                  onClick={handleSaveRemark}
                  disabled={remarkSaving || remarkDraft.trim() === (selectedOrder.admin_remark || '').trim()}
                >
                  {remarkSaving ? 'Saving…' : 'Save Note'}
                </button>
              </div>

              <div className="detail-section">
                <h4>Items</h4>
                {selectedOrder.shopConfirmations && selectedOrder.shopConfirmations.length > 0 && (
                  <div style={{ marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {selectedOrder.shopConfirmations.map(sc => {
                      // Whole-order cancel wins over item-level flags (incl. live socket patch).
                      const orderCancelled = selectedOrder.status === 'Cancelled'
                        || sc.orderCancelled
                        || sc.order_cancelled;
                      const label = orderCancelled
                        ? '✕ Order cancelled'
                        : sc.rejected ? '✕ Shop cancelled'
                        : sc.ready ? '✓ Ready'
                        : sc.confirmed ? '✓ Confirmed'
                        : '⏳ Waiting';
                      const background = (orderCancelled || sc.rejected)
                        ? 'rgba(239, 68, 68, 0.15)'
                        : sc.ready ? 'rgba(59, 130, 246, 0.15)'
                        : sc.confirmed ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)';
                      const color = (orderCancelled || sc.rejected) ? '#b91c1c' : sc.ready ? '#1d4ed8' : sc.confirmed ? '#15803d' : '#b45309';
                      return (
                        <span key={sc.shopId} style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                          padding: '4px 10px', borderRadius: 12, fontSize: '0.8rem', fontWeight: 600,
                          background, color,
                        }}>
                          {sc.shopName} {label}
                          {(sc.shopTotal ?? sc.shop_total) > 0 ? ` · ₹${sc.shopTotal ?? sc.shop_total} owed` : ''}
                        </span>
                      );
                    })}
                  </div>
                )}
                {(selectedOrder.items || []).map((item, idx) => (
                  <div key={idx} className="item-row">
                    <span>{item.quantity}x {item.product_name}</span>
                    <strong>₹{formatMoney(item.line_total)}</strong>
                  </div>
                ))}
                
                <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                  <div className="detail-row"><span>Subtotal:</span> <strong>₹{formatMoney(selectedOrder.subtotal)}</strong></div>
                  <div className="detail-row"><span>Delivery:</span> <strong>₹{formatMoney(selectedOrder.delivery_charge)}</strong></div>
                  {selectedOrder.night_charge > 0 && (
                    <div className="detail-row"><span>Night Charge:</span> <strong>₹{formatMoney(selectedOrder.night_charge)}</strong></div>
                  )}
                  {selectedOrder.rain_charge > 0 && (
                    <div className="detail-row"><span>Rain Charge:</span> <strong>₹{formatMoney(selectedOrder.rain_charge)}</strong></div>
                  )}
                  {selectedOrder.fast_delivery_charge > 0 && (
                    <div className="detail-row"><span>Fast Delivery Add-on:</span> <strong>₹{formatMoney(selectedOrder.fast_delivery_charge)}</strong></div>
                  )}
                  <div className="detail-row">
                    <span>Coupon applied:</span>
                    <strong>
                      {(selectedOrder.couponCode || selectedOrder.coupon_code)
                        ? `${selectedOrder.couponCode || selectedOrder.coupon_code}${(selectedOrder.couponTitle || selectedOrder.coupon_title) ? ` — ${selectedOrder.couponTitle || selectedOrder.coupon_title}` : ''}`
                        : 'None'}
                    </strong>
                  </div>
                  {Number(selectedOrder.discountAmount ?? selectedOrder.discount_amount) > 0 && (
                    <div className="detail-row"><span>Discount:</span> <strong>- ₹{formatMoney(selectedOrder.discountAmount ?? selectedOrder.discount_amount)}</strong></div>
                  )}
                  {Number(selectedOrder.freeDeliveryWaiverAmount ?? selectedOrder.free_delivery_waiver_amount) > 0 && (
                    <div className="detail-row"><span>Free delivery waiver:</span> <strong style={{ color: '#15803d' }}>−₹{formatMoney(selectedOrder.freeDeliveryWaiverAmount ?? selectedOrder.free_delivery_waiver_amount)}</strong></div>
                  )}
                  <div className="detail-row" style={{ fontSize: '1.2rem', marginTop: '0.5rem' }}>
                    <span>Total:</span> <strong style={{ color: 'var(--primary-color)' }}>₹{formatMoney(selectedOrder.total)}</strong>
                  </div>
                </div>
              </div>

              {selectedOrder.note && (
                <div className="detail-section" style={{ background: 'var(--badge-pending-bg)', borderColor: 'var(--warning-color)' }}>
                  <h4>Customer Note</h4>
                  <p style={{ fontSize: '0.95rem' }}>{selectedOrder.note}</p>
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
