import { apiClient } from './httpClient';
import { buildQueryString } from './queryString';

// TASK 28.1/28.5 — one call for area/zone/settings/storeModes/zoneGeometry/
// catalogVersion, keyed off the live pin. `ifNoneMatch` lets the caller send
// back the ETag from its last resolved fix so an unchanged area+zone comes
// back as a bare 304 (see apps/api/src/routes/bootstrapRoutes.js's
// bootstrapCatalogETag) instead of a full payload.
const bootstrapApi = {
  getBootstrap: ({ latitude, longitude, ifNoneMatch } = {}) => apiClient.get(
    `/bootstrap${buildQueryString({ latitude, longitude })}`,
    ifNoneMatch ? { headers: { 'If-None-Match': ifNoneMatch } } : undefined,
  ),
};

export { bootstrapApi };
