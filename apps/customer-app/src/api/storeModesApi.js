import { apiClient } from './httpClient';
import { buildQueryString } from './queryString';

const storeModesApi = {
  // Optional { latitude, longitude } resolves the pin's own area instead of
  // the users.last_area_id/default fallback — omit to keep prior behavior.
  list: (params) => apiClient.get(`/store-modes${buildQueryString(params)}`),
};

export { storeModesApi };
