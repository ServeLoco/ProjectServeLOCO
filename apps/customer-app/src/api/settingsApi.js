import { apiClient } from './httpClient';
import { buildQueryString } from './queryString';

const settingsApi = {
  // Optional { latitude, longitude } resolves the pin's own area instead of
  // the users.last_area_id/default fallback — omit to keep prior behavior.
  getSettings: (params) => apiClient.get(`/settings${buildQueryString(params)}`),
};

export { settingsApi };
