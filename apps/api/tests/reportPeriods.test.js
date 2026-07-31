const { resolvePeriod, ReportPeriodError } = require('../src/utils/reportPeriods');

describe('resolvePeriod', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Fixed instant: 2026-07-31T20:00:00Z. In business tz (+05:30) that's
  // 2026-08-01T01:30:00 — a day later than the UTC calendar date. Picking a
  // moment that straddles midnight in UTC vs +05:30 is the whole point: it
  // proves "today" is computed in the business timezone, not bare UTC.
  const FIXED_NOW = Date.UTC(2026, 6, 31, 20, 0, 0);

  const freezeNow = () => jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);

  it('today resolves to the business-tz calendar day, not the UTC day', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'today' });
    expect(result.from).toBe('2026-08-01');
    expect(result.to).toBe('2026-08-01');
    expect(result.timezone).toBe('+05:30');
    expect(result.key).toBe('today');
  });

  it('defaults to today when period is omitted', () => {
    freezeNow();
    const result = resolvePeriod({});
    expect(result.key).toBe('today');
    expect(result.from).toBe('2026-08-01');
  });

  it('yesterday is one business day before today', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'yesterday' });
    expect(result.from).toBe('2026-07-31');
    expect(result.to).toBe('2026-07-31');
  });

  it('this_week spans Monday to today (Monday-start week)', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'this_week' });
    expect(result.from).toBe('2026-07-27'); // Monday
    expect(result.to).toBe('2026-08-01'); // today (Saturday)
  });

  it('last_week is the full prior Monday-Sunday range', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'last_week' });
    expect(result.from).toBe('2026-07-20');
    expect(result.to).toBe('2026-07-26');
  });

  it('this_month spans the 1st to today', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'this_month' });
    expect(result.from).toBe('2026-08-01');
    expect(result.to).toBe('2026-08-01');
  });

  it('last_month is the full prior calendar month', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'last_month' });
    expect(result.from).toBe('2026-07-01');
    expect(result.to).toBe('2026-07-31');
  });

  it('all has no date bounds', () => {
    freezeNow();
    const result = resolvePeriod({ period: 'all' });
    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
  });

  it('custom accepts a valid from/to range', () => {
    const result = resolvePeriod({ period: 'custom', from: '2026-01-01', to: '2026-01-31' });
    expect(result.from).toBe('2026-01-01');
    expect(result.to).toBe('2026-01-31');
  });

  it('custom rejects a missing from/to', () => {
    expect(() => resolvePeriod({ period: 'custom', from: '2026-01-01' })).toThrow(ReportPeriodError);
  });

  it('custom rejects a malformed date', () => {
    expect(() => resolvePeriod({ period: 'custom', from: '01-01-2026', to: '2026-01-31' })).toThrow(ReportPeriodError);
  });

  it('custom rejects from after to', () => {
    expect(() => resolvePeriod({ period: 'custom', from: '2026-02-01', to: '2026-01-01' })).toThrow(ReportPeriodError);
  });

  it('custom rejects a span over 366 days', () => {
    expect(() => resolvePeriod({ period: 'custom', from: '2020-01-01', to: '2022-01-01' })).toThrow(ReportPeriodError);
  });

  it('rejects an unknown period key', () => {
    expect(() => resolvePeriod({ period: 'next_week' })).toThrow(ReportPeriodError);
  });

  it('errors carry ValidationError shape for the express error handler', () => {
    try {
      resolvePeriod({ period: 'bogus' });
      throw new Error('expected resolvePeriod to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReportPeriodError);
      expect(err.name).toBe('ValidationError');
      expect(err.statusCode).toBe(400);
    }
  });
});
