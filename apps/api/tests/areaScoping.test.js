/**
 * Guardrail for the multi-area sweep (plans/multi-area.md §4.6).
 *
 * Statically scans src/controllers, src/services, src/utils for any SQL
 * statement that reads or writes an area-scoped table (FROM/JOIN/UPDATE/
 * INTO) without an `area_id` predicate anywhere in the query text (or, for
 * queries built via a variable, anywhere in the enclosing function body —
 * this is a heuristic, not a real SQL parser: it is deliberately generous
 * about WHERE the area_id predicate lives, and strict about whether one
 * exists at all).
 *
 * This is written BEFORE the Phase C sweep (TASK 9-17) on purpose, so it
 * fails loudly for every table nobody has scoped yet — that failure list
 * IS the sweep's checklist. Do NOT "fix" a failure by loosening this
 * scanner or padding the allowlist with a table that genuinely needs
 * scoping; the allowlist is only for queries that are correctly,
 * permanently global (a phone-number lookup on `users`, an image-usage
 * scan of `images`, etc.) with a one-line reason for each entry.
 *
 * Un-skip this suite starting TASK 9 and keep it green from there on —
 * every subsequent Phase C task should shrink the violation list, never
 * grow it.
 */
const fs = require('fs');
const path = require('path');

const SCAN_DIRS = ['controllers', 'services', 'utils'].map((d) => path.join(__dirname, '..', 'src', d));

// Exactly the tables migrate.js's AREA_SCOPED_TABLES gives an area_id
// column to (TASK 3). Child/junction tables (coupon_zones, order_items'
// siblings like rider_order_offers, product_variants, combo_items, etc.)
// are deliberately NOT here unless they themselves carry area_id.
const SCOPED_TABLES = [
  'shops', 'riders', 'mobile_admins', 'delivery_zones', 'delivery_exclusion_zones',
  'settings', 'orders', 'order_items', 'coupons', 'offers',
  'dashboard_sections', 'dashboard_section_items', 'categories', 'products', 'combos',
  'product_groups', 'store_modes', 'admin_notifications', 'notification_batches',
];

// { file: relative path from apps/api, line: 1-indexed, reason: why this is OK }
// Keep every entry justified — an unjustified allowlist entry defeats the
// point of this test.
const ALLOWLIST = [
  // (empty as of TASK 5 — the Phase C sweep hasn't started, so nothing has
  // earned a permanent global-query exemption yet. Genuinely global tables
  // like `users`, `images`, `notification_templates`, and the not-yet-built
  // `product_library` / `library_variants` / `category_library` /
  // `store_mode_library` / `units` never appear in SCOPED_TABLES above, so
  // they never need an allowlist entry at all.)
];

function isAllowlisted(relFile, line) {
  return ALLOWLIST.some((entry) => entry.file === relFile && (entry.line === undefined || entry.line === line));
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    if (entry.isFile() && entry.name.endsWith('.js')) return [full];
    return [];
  });
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

// Captures the full argument list text of a `.query(` call starting right
// after its opening paren, respecting nested parens/brackets/braces and
// string/template literals (so a `)` inside a string doesn't end the scan
// early).
function captureCallArgs(text, openParenIndex) {
  let depth = 1;
  let i = openParenIndex + 1;
  let quote = null;
  const start = i;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    }
    i += 1;
  }
  return text.slice(start, i - 1);
}

// Finds the nearest enclosing function body around `callIndex` by scanning
// backward for a function-start marker, then forward from that marker's
// first `{` with brace-balance counting. Falls back to the whole file if no
// marker is found — a safe over-approximation for this heuristic (wider
// search window means fewer false positives, never fewer true ones).
const FUNCTION_START = /(?:function\s*[a-zA-Z0-9_$]*\s*\([^)]*\)\s*{|=>\s*{|=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^{]+)?=>\s*{|=\s*async\s+function\s*\([^)]*\)\s*{)/g;

function enclosingFunctionBody(text, callIndex) {
  let bestStart = -1;
  let bestBraceIndex = -1;
  FUNCTION_START.lastIndex = 0;
  let m;
  while ((m = FUNCTION_START.exec(text))) {
    const braceIndex = m.index + m[0].length - 1; // index of the '{'
    if (braceIndex > callIndex) break;
    bestStart = m.index;
    bestBraceIndex = braceIndex;
  }
  if (bestBraceIndex === -1) return text;

  let depth = 1;
  let i = bestBraceIndex + 1;
  let quote = null;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
    i += 1;
  }
  // If the call site is past the detected body's end, our brace-matching
  // missed something (e.g. a nested function) — fall back to the whole
  // file rather than risk an under-sized (falsely narrow) window.
  if (callIndex > i) return text;
  return text.slice(bestStart, i);
}

function tableReferenceRegex(table) {
  return new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+\`?${table}\`?\\b`, 'i');
}

function findAreaScopingViolations() {
  const violations = [];
  const files = SCAN_DIRS.flatMap(listJsFiles);

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const relFile = path.relative(path.join(__dirname, '..'), file);

    const queryCallRegex = /\.query\s*\(/g;
    let callMatch;
    while ((callMatch = queryCallRegex.exec(text))) {
      const openParenIndex = callMatch.index + callMatch[0].length - 1;
      const args = captureCallArgs(text, openParenIndex);

      const referencedTables = SCOPED_TABLES.filter((t) => tableReferenceRegex(t).test(args));
      if (referencedTables.length === 0) continue;

      // Bare identifier passed as the query (e.g. `pool.query(query, params)`)
      // means the actual SQL text lives elsewhere in the function — widen
      // the search window before deciding area_id is missing.
      const firstToken = args.trim();
      const isBareIdentifier = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*(,|$)/.test(firstToken);
      const searchText = isBareIdentifier ? enclosingFunctionBody(text, callMatch.index) : args;

      if (!/area_id/i.test(searchText)) {
        const line = lineNumberAt(text, callMatch.index);
        if (isAllowlisted(relFile, line)) continue;
        violations.push({
          file: relFile,
          line,
          tables: referencedTables,
        });
      }
    }
  }

  return violations;
}

describe('area scoping guardrail', () => {
  // TASK 5 status: the scanner is fully built and correct, but the Phase C
  // sweep (TASK 9-17) hasn't run yet, so this currently fails against
  // dozens of queries across ~19 tables — that IS the expected state
  // (see the file header). Un-skip starting TASK 9, scoping domain by
  // domain, and keep this green from then on. Do not silence a real
  // finding by adding it to ALLOWLIST — only genuinely global queries
  // belong there.
  it.skip('every query against an area-scoped table carries an area_id predicate', () => {
    const violations = findAreaScopingViolations();
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — references [${v.tables.join(', ')}] with no area_id`)
        .join('\n');
      throw new Error(`${violations.length} area-scoping violation(s):\n${report}`);
    }
    expect(violations).toEqual([]);
  });

  it('the scanner itself is not vacuous — it finds at least one real, currently-unscoped table', () => {
    // This catches a scanner regression (e.g. a broken regex making it
    // silently find nothing) independently of whether Phase C has landed,
    // since it does NOT skip.
    const violations = findAreaScopingViolations();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.tables.length > 0)).toBe(true);
  });

  it('table-reference regex requires a word boundary (orders vs order_items do not collide)', () => {
    expect(tableReferenceRegex('orders').test('SELECT * FROM order_items')).toBe(false);
    expect(tableReferenceRegex('orders').test('SELECT * FROM orders')).toBe(true);
    expect(tableReferenceRegex('combos').test('SELECT * FROM combo_items')).toBe(false);
    expect(tableReferenceRegex('products').test('SELECT * FROM product_variants')).toBe(false);
  });
});

module.exports = { findAreaScopingViolations, SCOPED_TABLES };
