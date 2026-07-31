// Resolves a report period key into a concrete [from, to] date range in the
// business timezone (config.RIDER_TODAY_TZ), matching the calendar-day logic
// admin/rider "today" filters already use elsewhere (riders.js, shopOwnerController.js).
const config = require('../config/env');

const PERIOD_KEYS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'all', 'custom'];
const MAX_CUSTOM_SPAN_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class ReportPeriodError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

const parseOffsetMinutes = (tz) => {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '');
  if (!m) return 330; // fallback +05:30
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
};

const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (y, mo, d) => `${y}-${pad2(mo + 1)}-${pad2(d)}`;

// Adds offsetMinutes to the real UTC clock, then reads the UTC getters back
// off the shifted Date — the getters now report the business-tz wall clock.
const localPartsNow = (offsetMinutes) => {
  const shifted = new Date(Date.now() + offsetMinutes * 60000);
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate(), dow: shifted.getUTCDay() };
};

const addDays = (y, mo, d, delta) => {
  const dt = new Date(Date.UTC(y, mo, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate() };
};

const endOfMonth = (y, mo) => {
  const dt = new Date(Date.UTC(y, mo + 1, 0));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate() };
};

function resolvePeriod({ period, from, to } = {}) {
  const key = period || 'today';
  if (!PERIOD_KEYS.includes(key)) {
    throw new ReportPeriodError('Invalid period parameter');
  }

  const timezone = config.RIDER_TODAY_TZ || '+05:30';
  const offsetMinutes = parseOffsetMinutes(timezone);
  const now = localPartsNow(offsetMinutes);
  const todayStr = fmt(now.y, now.mo, now.d);

  if (key === 'all') {
    return { key, from: null, to: null, timezone };
  }

  if (key === 'today') {
    return { key, from: todayStr, to: todayStr, timezone };
  }

  if (key === 'yesterday') {
    const y = addDays(now.y, now.mo, now.d, -1);
    const s = fmt(y.y, y.mo, y.d);
    return { key, from: s, to: s, timezone };
  }

  if (key === 'this_week') {
    // Week starts Monday, matching YEARWEEK(..., 1) used elsewhere.
    const mondayOffset = (now.dow + 6) % 7;
    const monday = addDays(now.y, now.mo, now.d, -mondayOffset);
    return { key, from: fmt(monday.y, monday.mo, monday.d), to: todayStr, timezone };
  }

  if (key === 'last_week') {
    const mondayOffset = (now.dow + 6) % 7;
    const thisMonday = addDays(now.y, now.mo, now.d, -mondayOffset);
    const lastMonday = addDays(thisMonday.y, thisMonday.mo, thisMonday.d, -7);
    const lastSunday = addDays(lastMonday.y, lastMonday.mo, lastMonday.d, 6);
    return {
      key,
      from: fmt(lastMonday.y, lastMonday.mo, lastMonday.d),
      to: fmt(lastSunday.y, lastSunday.mo, lastSunday.d),
      timezone,
    };
  }

  if (key === 'this_month') {
    return { key, from: fmt(now.y, now.mo, 1), to: todayStr, timezone };
  }

  if (key === 'last_month') {
    const prevMonthDay = addDays(now.y, now.mo, 1, -1); // last day of previous month
    const last = endOfMonth(prevMonthDay.y, prevMonthDay.mo);
    return {
      key,
      from: fmt(prevMonthDay.y, prevMonthDay.mo, 1),
      to: fmt(last.y, last.mo, last.d),
      timezone,
    };
  }

  // custom
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new ReportPeriodError('period=custom requires from/to as YYYY-MM-DD');
  }
  if (from > to) {
    throw new ReportPeriodError('from must not be after to');
  }
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) {
    throw new ReportPeriodError(`custom range too large (max ${MAX_CUSTOM_SPAN_DAYS} days)`);
  }
  return { key, from, to, timezone };
}

module.exports = { resolvePeriod, ReportPeriodError, PERIOD_KEYS };
