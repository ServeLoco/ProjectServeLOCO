/**
 * Server-authoritative remaining time for a rider offer.
 * Always derive from expiresAt — never restart a fresh 120s on mount.
 */

/**
 * @param {string|Date|number|null|undefined} expiresAt
 * @param {number} [nowMs]
 * @returns {number} seconds remaining, floored, never negative
 */
export function remainingSecondsFromExpiresAt(expiresAt, nowMs = Date.now()) {
  if (expiresAt == null || expiresAt === '') return 0;
  const end = new Date(expiresAt).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - nowMs) / 1000));
}

/**
 * @param {number} totalSeconds
 * @returns {string} m:ss
 */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Seconds elapsed since a server-stamped start time (e.g. rider_assigned_at).
 * @param {string|Date|number|null|undefined} startAt
 * @param {number} [nowMs]
 * @returns {number} seconds elapsed, floored, never negative
 */
export function elapsedSecondsFromStart(startAt, nowMs = Date.now()) {
  if (startAt == null || startAt === '') return 0;
  const start = new Date(startAt).getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/**
 * @param {number} totalSeconds
 * @returns {string} m:ss, or h:mm:ss past one hour
 */
export function formatElapsed(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}
