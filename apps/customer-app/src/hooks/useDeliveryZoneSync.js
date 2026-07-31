import { useEffect } from 'react';
import { subscribeDeliveryZoneEvents } from '../api/realtimeClient';
import { useDeliveryZonesStore } from '../stores';

// Global, always-mounted listener for delivery_zones.updated. An admin
// editing a zone's boundary or price should reprice anyone already on the
// Cart/Checkout screen immediately — bumping this version number is picked
// up by their debounced bill-recalculation effects as a dependency change.
function useDeliveryZoneSync() {
  useEffect(() => {
    const unsubscribe = subscribeDeliveryZoneEvents(() => {
      useDeliveryZonesStore.getState().bumpVersion();
    });

    return unsubscribe;
  }, []);
}

export { useDeliveryZoneSync };
