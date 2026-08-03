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
    // "milk+cheese" sanitizes to two words ("milk", "cheese") — a real
    // multi-word term, so it gets AND semantics (bug fix #14) below, not a
    // single trailing wildcard.
    expect(decideSearchMode('milk+cheese')).toEqual({ mode: 'fulltext', term: '+milk +cheese*' });
    expect(decideSearchMode('"amul"')).toEqual({ mode: 'fulltext', term: 'amul*' });
  });

  // Bug fix (multi-area audit finding #14): plain boolean mode with no
  // operators between words is an implicit OR, not the AND a substring LIKE
  // used to imply — "fresh milk" would otherwise match any product
  // containing just "fresh". Every earlier word gets a required `+`; only
  // the last (still-being-typed) word keeps the prefix wildcard.
  it('requires every word in a multi-word search (AND, not MySQL boolean mode\'s implicit OR)', () => {
    expect(decideSearchMode('fresh milk')).toEqual({ mode: 'fulltext', term: '+fresh +milk*' });
    expect(decideSearchMode('whole wheat bread')).toEqual({ mode: 'fulltext', term: '+whole +wheat +bread*' });
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
