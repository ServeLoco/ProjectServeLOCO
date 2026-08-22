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
 * Un-skipped starting TASK 9 (per §5.4) — but Phase C sweeps one domain at
 * a time, and un-skipping a single all-19-tables assertion on day one of a
 * 9-task sweep would just fail solid until TASK 17. So the enforcement is
 * per-table: SWEPT_TABLES lists which of SCOPED_TABLES have actually been
 * fully swept so far, and the active (non-skipped) test only fails on
 * violations against a table in that list. Every Phase C task appends its
 * table(s) to SWEPT_TABLES in the same commit that sweeps them — never
 * shrinks it, never removes a table without having actually fixed every
 * site. A second, informational (non-failing) assertion reports the total
 * remaining count across not-yet-swept tables, so the "437 baseline
 * shrinking over time" story stays visible without blocking earlier tasks
 * on later ones.
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

// Tables where EVERY current .query() site has been verified to carry an
// area_id predicate (or is explicitly allowlisted below). Append to this,
// never remove from it, one Phase C task at a time.
const SWEPT_TABLES = [
  'settings', // TASK 9
  'delivery_zones', // TASK 10
  'delivery_exclusion_zones', // TASK 10
  // categories/products/combos/store_modes/product_groups are NOT here yet
  // even though TASK 11 fully scoped its own file list — cartController.js,
  // orderController.js, dashboardController.js, analyticsController.js and
  // settingsController.js's radius-pricing product/category reads (all
  // owned by TASK 12/13/17) still reference these tables unscoped. Unlike
  // settings/delivery_zones (single-owner tables TASK 9/10 swept
  // completely), these five are referenced across many files owned by
  // different future tasks — add them here only once every remaining site
  // across the whole codebase is done, not just this task's own files.
];

// { file: relative path from apps/api, line: 1-indexed, reason: why this is OK }
// Keep every entry justified — an unjustified allowlist entry defeats the
// point of this test. Genuinely global tables like `users`, `images`,
// `notification_templates`, and the not-yet-built `product_library` /
// `library_variants` / `category_library` / `store_mode_library` / `units`
// never appear in SCOPED_TABLES above, so they never need an entry at all —
// this list is only for a SCOPED table queried in a deliberately
// cross-area way.
const ALLOWLIST = [
  {
    file: 'src/controllers/imageController.js',
    line: 34,
    reason:
      "getUsedImageIds' settings query — images are global (§2.5/§2.6), so " +
      '"is this image used anywhere" is deliberately a cross-area scan of ' +
      'every area\'s upi_qr_image_id, not just one area\'s.',
  },
  {
    file: 'src/controllers/deliveryZonesController.js',
    line: 148,
    reason:
      "resolveParentZoneId's ancestor-walk (ancestor lookup by parent_zone_id, " +
      'not the initial parent fetch, which IS area-scoped a few lines above). ' +
      "A zone's parent_zone_id can only ever point at a zone in the SAME area " +
      '— every write in this file enforces that — so once the immediate parent ' +
      'is confirmed same-area, walking further ancestors by id alone cannot ' +
      'cross into another area.',
  },
  {
    file: 'src/utils/coupons.js',
    line: 240,
    reason:
      "getZoneAndAncestorIds' ancestor-walk — same reasoning as the " +
      'deliveryZonesController.js entry above (parent_zone_id never crosses ' +
      'areas). Also: this file is the coupon rule engine, which the spec ' +
      'explicitly says to scope only at its inputs, never inside its logic.',
  },
  {
    file: 'src/controllers/deliveryZonesController.js',
    line: 224,
    reason:
      "getAllActiveZones, backing the public GET /delivery-zones map overlay " +
      '— deliberately cross-area. A customer can be physically anywhere ' +
      '(GPS pin, saved address, wherever they drag the map), independent of ' +
      'the area they last ordered from, so this shape-only listing (no ' +
      'pricing/ETA/COD fields) shows every active zone from every area ' +
      "instead of guessing one. Delivery eligibility itself is unaffected — " +
      "it still comes from cart-calculate, which stays correctly area-scoped.",
  },
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
  // Active (not skipped) since TASK 9. Fails only on violations touching a
  // SWEPT table — an unswept table's violations are real but expected,
  // and are reported by the informational test below instead of failing
  // the build. Do not silence a real finding by adding it to ALLOWLIST or
  // removing a table from SWEPT_TABLES — only genuinely global queries
  // belong in the former, and the latter only ever grows.
  it('every query against a SWEPT area-scoped table carries an area_id predicate', () => {
    const violations = findAreaScopingViolations()
      .filter((v) => v.tables.some((t) => SWEPT_TABLES.includes(t)));
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — references [${v.tables.join(', ')}] with no area_id`)
        .join('\n');
      throw new Error(`${violations.length} area-scoping violation(s) on swept table(s):\n${report}`);
    }
    expect(violations).toEqual([]);
  });

  it('the scanner itself is not vacuous — it finds at least one real, currently-unscoped table', () => {
    // This catches a scanner regression (e.g. a broken regex making it
    // silently find nothing) independently of Phase C's progress, since it
    // does NOT skip and does NOT filter by SWEPT_TABLES.
    const violations = findAreaScopingViolations();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.tables.length > 0)).toBe(true);
  });

  it('reports remaining violations on not-yet-swept tables (informational, never fails)', () => {
    const violations = findAreaScopingViolations()
      .filter((v) => !v.tables.some((t) => SWEPT_TABLES.includes(t)));
    console.log(`[areaScoping] ${violations.length} violation(s) remain on tables not yet in SWEPT_TABLES (${SCOPED_TABLES.filter((t) => !SWEPT_TABLES.includes(t)).join(', ')}).`);
    expect(violations.length).toBeGreaterThanOrEqual(0); // always true — this test only exists to log
  });

  it('table-reference regex requires a word boundary (orders vs order_items do not collide)', () => {
    expect(tableReferenceRegex('orders').test('SELECT * FROM order_items')).toBe(false);
    expect(tableReferenceRegex('orders').test('SELECT * FROM orders')).toBe(true);
    expect(tableReferenceRegex('combos').test('SELECT * FROM combo_items')).toBe(false);
    expect(tableReferenceRegex('products').test('SELECT * FROM product_variants')).toBe(false);
  });
});

module.exports = { findAreaScopingViolations, SCOPED_TABLES };
