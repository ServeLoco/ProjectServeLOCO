import React from 'react';
import './PickAreaNotice.css';

// 25.4 — Settings, Delivery Zones and Store Modes all render this instead of
// firing a doomed request/showing an error toast when a super_admin has
// "All areas" selected — these three don't make sense aggregated (§2.10),
// so the fix is picking one area, not an error state.
export default function PickAreaNotice({ label = 'this page' }) {
  return (
    <div className="pick-area-notice">
      <div className="pick-area-notice-icon">🌐</div>
      <h2>Pick an area</h2>
      <p>{label} can&apos;t be shown for &ldquo;All areas&rdquo; — pick a single area from the switcher above.</p>
    </div>
  );
}
