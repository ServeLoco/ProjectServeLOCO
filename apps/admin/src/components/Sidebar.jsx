import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Sidebar.css';

const NAV_GROUPS = [
  {
    label: 'Operations',
    items: [
      { path: '/', label: 'Dashboard', icon: '⚡' },
      { path: '/orders', label: 'Orders', icon: '📦' },
      { path: '/delivery-zones', label: 'Delivery Zones', icon: '📍' },
      { path: '/riders', label: 'Riders', icon: '🛵' },
      { path: '/mobile-admins', label: 'Mobile Admins', icon: '📲' },
    ],
  },
  {
    label: 'Catalogue',
    items: [
      { path: '/products', label: 'Products', icon: '🏷️' },
      { path: '/combos', label: 'Combos', icon: '🍱' },
      { path: '/categories', label: 'Categories', icon: '🗂️' },
      { path: '/store-modes', label: 'Store Modes', icon: '🔀' },
      { path: '/shops', label: 'Shops', icon: '🏪' },
      { path: '/offers', label: 'Offers', icon: '🎁' },
      { path: '/coupons', label: 'Coupons', icon: '🎟️' },
    ],
  },
  {
    label: 'Engagement',
    items: [
      { path: '/mobile-dashboard', label: 'App Home', icon: '📱' },
      { path: '/customers', label: 'Customers', icon: '👥' },
      { path: '/notifications', label: 'Notifications', icon: '🔔' },
    ],
  },
  {
    label: 'System',
    items: [
      { path: '/images', label: 'Images', icon: '🖼️' },
      { path: '/settings', label: 'Settings', icon: '⚙️' },
      { path: '/reports', label: 'Reports', icon: '📊' },
      { path: '/analytics', label: 'Analytics', icon: '📈' },
      { path: '/health', label: 'System Health', icon: '💚' },
    ],
  },
];

export default function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger */}
      <button
        className="sidebar-mobile-toggle"
        onClick={() => setMobileOpen(o => !o)}
        aria-label="Toggle navigation"
      >
        {mobileOpen ? '✕' : '☰'}
      </button>

      <aside className={`admin-sidebar${mobileOpen ? ' mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <span className="sidebar-logo-text">VK</span>
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">VillKro</span>
            <span className="sidebar-brand-subtitle">Admin Panel</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="sidebar-group">
              <span className="sidebar-group-label">{group.label}</span>
              <ul className="sidebar-list">
                {group.items.map(item => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) =>
                        `sidebar-item-link${isActive ? ' active' : ''}`
                      }
                      onClick={() => setMobileOpen(false)}
                      end={item.path === '/'}
                    >
                      <span className="sidebar-icon">{item.icon}</span>
                      <span className="sidebar-label">{item.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-badge">
            <span className="sidebar-footer-dot" />
            <span>VillKro Admin</span>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="sidebar-mobile-backdrop" onClick={() => setMobileOpen(false)} />
      )}
    </>
  );
}
