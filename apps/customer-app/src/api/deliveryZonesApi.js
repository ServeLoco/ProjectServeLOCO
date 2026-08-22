import { apiClient } from './httpClient';

const deliveryZonesApi = {
  // Public, geometry-only — used to shade every active delivery zone across
  // every area on the checkout map. Not scoped to "the customer's area":
  // the customer can be physically anywhere (GPS pin, saved address, or
  // wherever they drag the map), independent of the area they last ordered
  // from, so the backend returns all zones rather than guessing one.
  getActiveZones: () => apiClient.get('/delivery-zones'),
};

export { deliveryZonesApi };
