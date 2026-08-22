import React, { useState, useEffect } from 'react';
import { CustomersApi } from '../api';
import MessageBanner from '../components/MessageBanner';
import { GENERIC_ERROR } from '../utils/constants';
import './Customers.css';

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [filters, setFilters] = useState({
    search: '',
    trusted: '',
    blocked: ''
  });

  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => fetchCustomers(1), 500);
    return () => clearTimeout(timer);
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchCustomers = async (page = 1) => {
    try {
      setLoading(true);
      setError(null);
      const params = { page, limit: 20, ...filters };
      Object.keys(params).forEach(k => params[k] === '' && delete params[k]);

      const res = await CustomersApi.list(params);
      setCustomers(res.data || []);
      if (res.pagination) {
        setPagination(res.pagination);
      }
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const handleRowClick = async (id) => {
    try {
      setUpdating(true);
      const res = await CustomersApi.get(id);
      setSelectedCustomer(res.data);
      setDrawerOpen(true);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setUpdating(false);
    }
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedCustomer(null);
  };

  const handleToggleTrust = async () => {
    const newStatus = !selectedCustomer.trusted;
    const action = newStatus ? 'mark this customer as trusted' : 'revoke trusted status for this customer';
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;

    try {
      setUpdating(true);
      await CustomersApi.updateTrust(selectedCustomer.id, newStatus);
      setSelectedCustomer(prev => ({ ...prev, trusted: newStatus }));
      fetchCustomers(pagination.page);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setUpdating(false);
    }
  };

  const handleToggleBlock = async () => {
    const newStatus = !selectedCustomer.blocked;
    const action = newStatus
      ? 'block this customer? They will not be able to place orders.'
      : 'unblock this customer? They will be able to place orders again.';
    if (!window.confirm(`Are you sure you want to ${action}`)) return;
    try {
      setUpdating(true);
      await CustomersApi.updateBlock(selectedCustomer.id, newStatus);
      setSelectedCustomer(prev => ({ ...prev, blocked: newStatus }));
      fetchCustomers(pagination.page);
    } catch (err) {
      console.error(err);
      setError(GENERIC_ERROR);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="customers-container">
      <header className="customers-header">
        <div>
          <h1 className="customers-title">Customers</h1>
          <p className="customers-total-count">{pagination.total ?? 0} registered customers</p>
        </div>
        <MessageBanner
          type={actionMessage?.type || 'info'}
          message={actionMessage?.text}
          onDismiss={() => setActionMessage(null)}
        />
      </header>

      <section className="customers-filter-bar">
        <input
          type="text"
          name="search"
          placeholder="Search by Name, Phone, or WhatsApp..."
          className="filter-input filter-search"
          value={filters.search}
          onChange={handleFilterChange}
          style={{ flex: 1, minWidth: '250px' }}
        />
        <select name="trusted" className="filter-select" value={filters.trusted} onChange={handleFilterChange}>
          <option value="">All Trust Status</option>
          <option value="1">Trusted Only</option>
          <option value="0">Not Trusted</option>
        </select>
        <select name="blocked" className="filter-select" value={filters.blocked} onChange={handleFilterChange}>
          <option value="">All Block Status</option>
          <option value="1">Blocked Only</option>
          <option value="0">Active Only</option>
        </select>
      </section>

      {error && <div className="error-container" style={{ margin: '0 0 2rem 0' }}>{error}</div>}

      <section className="customers-table-wrapper">
        <table className="customers-table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th>Orders</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {loading && customers.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', padding: '2rem' }}>Loading customers...</td></tr>
            ) : customers.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', padding: '2rem' }}>No customers found.</td></tr>
            ) : (
              customers.map(c => (
                <tr key={c.id} onClick={() => handleRowClick(c.id)}>
                  <td>
                    <div className="customer-name">
                      {c.name}
                      {c.trusted ? <span className="badge-trusted">Trusted</span> : null}
                      {c.blocked ? <span className="badge-blocked">Blocked</span> : null}
                    </div>
                  </td>
                  <td>{c.phone}</td>
                  <td>{c.order_count || c.total_orders || 0}</td>
                  <td>{new Date(c.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="pagination-controls" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)' }}>
          <button className="btn-secondary" disabled={pagination.page <= 1 || loading} onClick={() => fetchCustomers(pagination.page - 1)}>Previous</button>
          <span>Page {pagination.page} of {pagination.totalPages}</span>
          <button className="btn-secondary" disabled={pagination.page >= pagination.totalPages || loading} onClick={() => fetchCustomers(pagination.page + 1)}>Next</button>
        </div>
      </section>

      {drawerOpen && selectedCustomer && (
        <div className="drawer-overlay" onClick={closeDrawer}>
          <div className="drawer-content" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <h3 className="drawer-title">Customer Details</h3>
              <button className="drawer-close" onClick={closeDrawer}>&times;</button>
            </div>

            <div className="drawer-body">
              <div className="customer-detail-header">
                <div className="customer-avatar">
                  {selectedCustomer.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h2 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>{selectedCustomer.name}</h2>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {selectedCustomer.trusted && <span className="badge-trusted">Trusted</span>}
                    {selectedCustomer.blocked && <span className="badge-blocked">Blocked</span>}
                  </div>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-card-label">Total Orders</div>
                  <div className="stat-card-value">{selectedCustomer.order_count || selectedCustomer.total_orders || 0}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-card-label">Joined</div>
                  <div className="stat-card-value" style={{ fontSize: '1.2rem', marginTop: '0.25rem' }}>
                    {new Date(selectedCustomer.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </div>
                </div>
              </div>

              <div className="detail-section" style={{ marginBottom: '2rem' }}>
                <h4 style={{ marginBottom: '1rem', color: 'var(--text-secondary)' }}>Contact Info</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span>Phone:</span>
                  <strong>{selectedCustomer.phone}</strong>
                </div>
                {selectedCustomer.whatsapp_number && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span>WhatsApp:</span>
                    <strong>{selectedCustomer.whatsapp_number}</strong>
                  </div>
                )}
                {(selectedCustomer.short_address || selectedCustomer.address) && (
                  <div style={{ marginTop: '1rem' }}>
                    <span style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Default Address:</span>
                    <p style={{ background: 'var(--bg-color)', padding: '0.75rem', borderRadius: '4px', fontSize: '0.9rem' }}>
                      {selectedCustomer.short_address || selectedCustomer.address}
                    </p>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                  <a href={`tel:${selectedCustomer.phone}`} className="btn-primary" style={{ flex: 1, justifyContent: 'center' }}>Call</a>
                  {selectedCustomer.whatsapp_number && (
                    <a href={`https://wa.me/${selectedCustomer.whatsapp_number.replace(/[^0-9]/g, '')}`} target="_blank" rel="noreferrer" className="btn-primary" style={{ flex: 1, justifyContent: 'center', background: 'var(--whatsapp)' }}>WhatsApp</a>
                  )}
                </div>
              </div>

              <div className="action-card">
                <h4>Trust Status</h4>
                <p>Trusted customers may bypass certain verifications.</p>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', borderColor: selectedCustomer.trusted ? 'var(--border-color)' : 'var(--success-color)', color: selectedCustomer.trusted ? 'inherit' : 'var(--success-color)' }}
                  onClick={handleToggleTrust}
                  disabled={updating}
                >
                  {selectedCustomer.trusted ? 'Revoke Trust' : 'Mark as Trusted'}
                </button>
              </div>

              <div className="action-card" style={{ borderColor: 'var(--danger-border)' }}>
                <h4 style={{ color: 'var(--danger-color)' }}>Block Customer</h4>
                <p>Blocked customers are immediately prevented from placing new orders.</p>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', borderColor: selectedCustomer.blocked ? 'var(--border-color)' : 'var(--danger-color)', color: selectedCustomer.blocked ? 'inherit' : 'var(--danger-color)' }}
                  onClick={handleToggleBlock}
                  disabled={updating}
                >
                  {selectedCustomer.blocked ? 'Unblock Customer' : 'Block Customer'}
                </button>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
