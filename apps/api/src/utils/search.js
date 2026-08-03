// Shared fulltext-vs-LIKE decision (TASK 22, §3.11). A leading '%term%' LIKE
// cannot use any index — full table scan on every search request, worse the
// more areas share one `products` table. FULLTEXT + boolean-mode prefix
// match replaces it wherever an index exists (products.name,
// product_library.name); LIKE stays only as the fallback for terms shorter
// than innodb_ft_min_token_size (MySQL default: 3), which InnoDB fulltext
// silently never indexes at all.
const FULLTEXT_MIN_TERM_LENGTH = 3;

// Boolean-mode operators (+ - < > ( ) ~ * " @) are meaningful to MySQL's
// parser — strip them from user input so a search for e.g. "2+2" or a
// stray quote doesn't get misread as fulltext syntax or unbalance the
// expression. What's left is prefixed with `*` for a right-hand wildcard
// match (the boolean-mode equivalent of the old '%term%', minus the
// unindexable leading wildcard).
const sanitizeFulltextTerm = (raw) => String(raw).trim().replace(/[+\-<>()~*"@]+/g, ' ').trim();

/**
 * Decide how a search term should be matched.
 * @param {string} rawTerm
 * @returns {{ mode: 'fulltext', term: string } | { mode: 'like', term: string } | { mode: 'none' }}
 *   'none' means the term sanitized down to nothing (e.g. pure punctuation)
 *   and the caller should match zero rows rather than run an unfiltered scan.
 */
const decideSearchMode = (rawTerm) => {
  const trimmed = String(rawTerm ?? '').trim();
  if (trimmed.length === 0) return { mode: 'none' };
  if (trimmed.length < FULLTEXT_MIN_TERM_LENGTH) {
    return { mode: 'like', term: trimmed };
  }
  const sanitized = sanitizeFulltextTerm(trimmed);
  if (!sanitized) return { mode: 'none' };

  const tokens = sanitized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return { mode: 'fulltext', term: `${sanitized}*` };
  }
  // Multi-word terms require EVERY word (bug fix, multi-area audit finding
  // #14): MySQL boolean mode with no operators between words is an implicit
  // OR ("any word matches, ranked higher when more do") — silently
  // broadening a search like "fresh milk" to match anything containing just
  // "fresh", a real regression from the old '%term%' substring LIKE this
  // code replaced (§3.11). `+` requires each earlier word to appear; only
  // the LAST word keeps the trailing `*` prefix-wildcard, for the term the
  // user is still mid-typing.
  const term = tokens.map((tok, i) => (i === tokens.length - 1 ? `+${tok}*` : `+${tok}`)).join(' ');
  return { mode: 'fulltext', term };
};

module.exports = { decideSearchMode, FULLTEXT_MIN_TERM_LENGTH, sanitizeFulltextTerm };
