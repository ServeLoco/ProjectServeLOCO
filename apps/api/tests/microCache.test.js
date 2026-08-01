const { get, set, bust, clearAll, MAX_ENTRIES } = require('../src/utils/microCache');

describe('microCache', () => {
  beforeEach(() => {
    clearAll();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('set/get roundtrip', () => {
    set('dashboard:1:a', { ok: 1 }, 30_000);
    expect(get('dashboard:1:a')).toEqual({ ok: 1 });
  });

  it('ttl expiry', () => {
    set('dashboard:1:a', 1, 1000);
    expect(get('dashboard:1:a')).toBe(1);
    jest.advanceTimersByTime(1001);
    expect(get('dashboard:1:a')).toBeUndefined();
  });

  it('bust-by-prefix with no areaId still busts every area (global fallback)', () => {
    set('dashboard:1:a', 1, 30_000);
    set('dashboard:2:b', 2, 30_000);
    set('categories:1:x', 3, 30_000);
    bust('dashboard');
    expect(get('dashboard:1:a')).toBeUndefined();
    expect(get('dashboard:2:b')).toBeUndefined();
    expect(get('categories:1:x')).toBe(3);
  });

  it('bust(namespace, areaId) clears only that area\'s slice', () => {
    set('dashboard:1:a', 'area1-a', 30_000);
    set('dashboard:1:b', 'area1-b', 30_000);
    set('dashboard:2:a', 'area2-a', 30_000);
    set('categories:1:x', 'cat1', 30_000);

    bust('dashboard', 1);

    expect(get('dashboard:1:a')).toBeUndefined();
    expect(get('dashboard:1:b')).toBeUndefined();
    expect(get('dashboard:2:a')).toBe('area2-a');
    expect(get('categories:1:x')).toBe('cat1');
  });

  it('bust(namespace, areaId) does not match a different area whose id is a numeric prefix (1 vs 10)', () => {
    set('dashboard:1:a', 'area1', 30_000);
    set('dashboard:10:a', 'area10', 30_000);

    bust('dashboard', 1);

    expect(get('dashboard:1:a')).toBeUndefined();
    expect(get('dashboard:10:a')).toBe('area10');
  });

  it('bust(namespace, areaId) also clears the bare namespace:areaId key (no rest segment)', () => {
    set('settings:1', { shopOpen: true }, 30_000);
    bust('settings', 1);
    expect(get('settings:1')).toBeUndefined();
  });

  it('set() throws on a key not shaped "<namespace>:<areaId>:<rest>" outside production', () => {
    expect(() => set('dashboard', { ok: 1 }, 30_000)).toThrow();
    expect(() => set('dashboard:not-numeric', { ok: 1 }, 30_000)).toThrow();
  });

  it('set() does not throw in production even on a malformed key', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => set('dashboard', { ok: 1 }, 30_000)).not.toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('get() on a malformed/missing key just misses rather than throwing', () => {
    expect(() => get('not-a-shaped-key')).not.toThrow();
    expect(get('not-a-shaped-key')).toBeUndefined();
  });

  it(`evicts oldest when exceeding MAX_ENTRIES (${MAX_ENTRIES})`, () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      set(`k:1:${i}`, i, 60_000);
    }
    expect(get('k:1:0')).toBe(0);
    set(`k:1:${MAX_ENTRIES}`, MAX_ENTRIES, 60_000);
    expect(get('k:1:0')).toBeUndefined();
    expect(get(`k:1:${MAX_ENTRIES}`)).toBe(MAX_ENTRIES);
  });
});

describe('microCache mutation bust (integration-style)', () => {
  beforeEach(() => {
    clearAll();
    jest.useRealTimers();
  });

  it('category create path busts categories + dashboard for that area only', () => {
    // Simulate what controllers do after a mutation.
    set('categories:1:public:fast_food', { data: [] }, 30_000);
    set('dashboard:1:fast_food:closed=1', { data: { sections: [] } }, 30_000);
    set('categories:2:public:fast_food', { data: ['area2 unaffected'] }, 30_000);
    bust('categories', 1);
    bust('dashboard', 1);
    expect(get('categories:1:public:fast_food')).toBeUndefined();
    expect(get('dashboard:1:fast_food:closed=1')).toBeUndefined();
    expect(get('categories:2:public:fast_food')).toEqual({ data: ['area2 unaffected'] });
  });
});
