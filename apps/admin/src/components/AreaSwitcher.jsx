import React from 'react';
import { useAreaStore } from '../stores/useAreaStore';
import './AreaSwitcher.css';

// §2.10/§25.2 — visible only to super_admin (AdminLayout only renders this
// when useAreaStore().isSuperAdmin is true). Switching areaId itself
// (25.3) is handled by keying the routed page subtree on it in
// AdminLayout.jsx — a plain remount, since there's no react-query layer to
// invalidate.
export default function AreaSwitcher() {
  const { areas, areaId, setAreaId, loading, isSuperAdmin } = useAreaStore();

  if (!isSuperAdmin) return null;

  return (
    <select
      className="area-switcher"
      value={areaId ?? ''}
      onChange={(e) => setAreaId(e.target.value)}
      disabled={loading || areas.length === 0}
      aria-label="Select area"
      title="Select area"
    >
      {areas.map((area) => (
        <option key={area.id} value={area.id}>
          {area.name} ({area.code})
        </option>
      ))}
      <option value="all">All areas</option>
    </select>
  );
}
