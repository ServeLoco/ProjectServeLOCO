/**
 * TASK 22 — decideSearchMode (src/utils/search.js), the shared
 * fulltext-vs-LIKE decision used by customer/admin product search and the
 * library search (§3.11).
 */
const { decideSearchMode, FULLTEXT_MIN_TERM_LENGTH } = require('../src/utils/search');

describe('decideSearchMode', () => {
  it('falls back to LIKE for terms shorter than the fulltext min token size (22.3)', () => {
    expect(FULLTEXT_MIN_TERM_LENGTH).toBe(3);
    expect(decideSearchMode('a')).toEqual({ mode: 'like', term: 'a' });
    expect(decideSearchMode('ab')).toEqual({ mode: 'like', term: 'ab' });
  });

  it('uses fulltext with a boolean-mode prefix for terms at/above the min length', () => {
    expect(decideSearchMode('milk')).toEqual({ mode: 'fulltext', term: 'milk*' });
    expect(decideSearchMode('abc')).toEqual({ mode: 'fulltext', term: 'abc*' });
  });

  it('strips boolean-mode operators before prefixing', () => {
    expect(decideSearchMode('milk+cheese')).toEqual({ mode: 'fulltext', term: 'milk cheese*' });
    expect(decideSearchMode('"amul"')).toEqual({ mode: 'fulltext', term: 'amul*' });
  });

  it('returns none for empty or pure-operator input, never an unfiltered scan', () => {
    expect(decideSearchMode('')).toEqual({ mode: 'none' });
    expect(decideSearchMode('   ')).toEqual({ mode: 'none' });
    expect(decideSearchMode('+++')).toEqual({ mode: 'none' });
  });

  it('trims surrounding whitespace', () => {
    expect(decideSearchMode('  milk  ')).toEqual({ mode: 'fulltext', term: 'milk*' });
  });
});
