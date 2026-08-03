import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAreaStore } from '../stores/useAreaStore';

// 26.8 — Areas/Admins/Library are super_admin only. Mounted inside
// ProtectedRoute + AdminLayout, so `user` is already known truthy here;
// only the role check is this component's job.
export default function SuperAdminRoute() {
  const { isSuperAdmin, initialized } = useAreaStore() || {};

  if (!initialized) return null;
  if (!isSuperAdmin) return <Navigate to="/" replace />;

  return <Outlet />;
}
