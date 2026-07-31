import { apiClient } from './httpClient';

const deliveryZonesApi = {
  // Public, geometry-only — used to shade active delivery zones on the
  // checkout map so the customer can see where to drop the pin.
  getActiveZones: () => apiClient.get('/delivery-zones'),
};

export { deliveryZonesApi };
