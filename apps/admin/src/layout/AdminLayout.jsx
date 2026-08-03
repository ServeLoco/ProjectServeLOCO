import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import Header from '../components/Header';
import GlobalOrderAlert from '../components/GlobalOrderAlert';
import { useAreaStore } from '../stores/useAreaStore';
import './AdminLayout.css';

export default function AdminLayout() {
  // 25.3 — no react-query layer here; every page fetches its own data in a
  // plain useEffect(() => {...}, []). Keying the routed subtree on areaId
  // forces React to unmount + remount the current page on every switch, so
  // its effects rerun from scratch against the new area instead of showing
  // stale data from the one just left.
  const { areaId, isSuperAdmin, initialized } = useAreaStore() || {};

  // A super_admin's areaId resolves asynchronously (GET /admin/areas + boot
  // validation) — without this gate, a page mounted before that resolves
  // fires its first fetch with no X-Area-Id at all and 400s (most admin
  // endpoints require one area picked), immediately followed by a second,
  // successful mount once the real area lands. Waiting here means every
  // page's very first fetch already has the right area.
  const areaPending = isSuperAdmin && !initialized;

  return (
    <div className="admin-shell">
      <Sidebar />
      <div className="admin-workspace">
        <Header />
        <main className="admin-main">
          {areaPending ? (
            <div className="admin-area-pending">Loading your areas…</div>
          ) : (
            <Outlet key={areaId ?? 'none'} />
          )}
        </main>
        <GlobalOrderAlert />
      </div>
    </div>
  );
}
