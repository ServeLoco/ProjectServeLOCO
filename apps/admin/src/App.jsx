import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeProvider';
import { AuthProvider } from './components/AuthProvider';
import { AreaProvider } from './stores/useAreaStore';
import ProtectedRoute from './routes/ProtectedRoute';
import SuperAdminRoute from './routes/SuperAdminRoute';
import AdminLayout from './layout/AdminLayout';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import Products from './pages/Products';
import Combos from './pages/Combos';
import Categories from './pages/Categories';
import StoreModes from './pages/StoreModes';
import Shops from './pages/Shops';
import Riders from './pages/Riders';
import MobileAdmins from './pages/MobileAdmins';
import Offers from './pages/Offers';
import Coupons from './pages/Coupons';
import MobileDashboard from './pages/MobileDashboard';
import Customers from './pages/Customers';
import Notifications from './pages/Notifications';
import Settings from './pages/Settings';
import DeliveryZones from './pages/DeliveryZones';
import Images from './pages/Images';
import Reports from './pages/Reports';
import Health from './pages/Health';
import BulkImport from './pages/BulkImport';
import Analytics from './pages/Analytics';
import AnalyticsUserDetail from './pages/AnalyticsUserDetail';
import Areas from './pages/Areas';
import Admins from './pages/Admins';
import Library from './pages/Library';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[Admin ErrorBoundary]', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', maxWidth: '720px', margin: '4rem auto', color: 'var(--text-primary)' }}>
          <h1 style={{ marginBottom: '0.75rem' }}>Something went wrong</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            The admin page hit an unexpected rendering error. You can retry the page or go back to the dashboard.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn-primary" onClick={() => window.location.reload()}>Retry</button>
            <button className="btn-secondary" onClick={() => { window.location.href = '/'; }}>Go to Dashboard</button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AreaProvider>
          <ErrorBoundary>
            <Router>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route element={<ProtectedRoute />}>
                  <Route element={<AdminLayout />}>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/orders" element={<Orders />} />
                    <Route path="/products" element={<Products />} />
                    <Route path="/combos" element={<Combos />} />
                    <Route path="/categories" element={<Categories />} />
                    <Route path="/store-modes" element={<StoreModes />} />
                    <Route path="/shops" element={<Shops />} />
                    <Route path="/riders" element={<Riders />} />
                    <Route path="/mobile-admins" element={<MobileAdmins />} />
                    <Route path="/offers" element={<Offers />} />
                    <Route path="/coupons" element={<Coupons />} />
                    <Route path="/mobile-dashboard" element={<MobileDashboard />} />
                    <Route path="/customers" element={<Customers />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/delivery-zones" element={<DeliveryZones />} />
                    <Route path="/images" element={<Images />} />
                    <Route path="/reports" element={<Reports />} />
                    <Route path="/health" element={<Health />} />
                    <Route path="/bulk-import" element={<BulkImport />} />
                    <Route path="/analytics" element={<Analytics />} />
                    <Route path="/analytics/user/:id" element={<AnalyticsUserDetail />} />
                    <Route element={<SuperAdminRoute />}>
                      <Route path="/areas" element={<Areas />} />
                      <Route path="/admins" element={<Admins />} />
                      <Route path="/library" element={<Library />} />
                    </Route>
                  </Route>
                </Route>
              </Routes>
            </Router>
          </ErrorBoundary>
        </AreaProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
