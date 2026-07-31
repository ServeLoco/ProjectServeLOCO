import { create } from 'zustand';

// Bumped whenever the server pushes delivery_zones.updated (admin saved a
// zone's boundary or pricing). Screens with an active delivery-charge
// calculation include this in their recompute effect's deps so a save on
// the admin side reprices the customer's bill immediately, without waiting
// for the pin to move or the cart to change.
export const useDeliveryZonesStore = create((set) => ({
  version: 0,
  bumpVersion: () => set((state) => ({ version: state.version + 1 })),
}));

export default useDeliveryZonesStore;
