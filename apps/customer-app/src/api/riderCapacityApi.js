import { apiClient } from './httpClient';
import { buildQueryString } from './queryString';

// Polled every 45s by useRiderCapacity (CheckoutScreen) to show/hide the
// "riders are busy" banner ahead of an actual checkout attempt.
const riderCapacityApi = {
  getCapacityStatus: ({ latitude, longitude } = {}) => apiClient.get(
    `/rider-capacity${buildQueryString({ latitude, longitude })}`,
  ),
};

export { riderCapacityApi };
