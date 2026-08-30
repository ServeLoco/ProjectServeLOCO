/**
 * Helpers for the source-assertion tests — the ones that read a screen's
 * source as text instead of rendering it, because the screen pulls in native
 * modules jest can't mount (see CheckoutScreen.*.test.js,
 * LocationPicker.zoneZoom.test.js).
 *
 * Lives outside __tests__/ on purpose: jest-expo's testMatch treats anything
 * under __tests__/ as a suite, and a bare helper module there fails with
 * "your test suite must contain at least one test".
 *
 * These exist because slicing a fixed number of characters is a trap. Every
 * such window silently becomes wrong the moment the code it points at grows,
 * and it fails as though the PRODUCT were broken — which already happened
 * once here, when an added Alert pushed a `return undefined;` past a
 * hardcoded 900-char window and two green assertions turned red on correct
 * code.
 */

/**
 * Returns the source of the brace-delimited block opened by `header`,
 * balanced to its matching close brace, or null when `header` isn't found.
 *
 * @param {string} source Full file text.
 * @param {string} header Literal text that opens the block, e.g.
 *   `'if (checkoutItems.length === 0) {'` or `'const createOrder = async ('`.
 */
const blockAfter = (source, header) => {
  const start = source.indexOf(header);
  if (start === -1) return null;

  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
};

/**
 * Returns the source of the call expression starting at `header`, balanced to
 * its matching close paren. Use for callback-taking calls —
 * `useFocusEffect(...)`, `subscribeX(...)` — where the body is an argument
 * rather than a braced block.
 */
const callAfter = (source, header) => {
  const start = source.indexOf(header);
  if (start === -1) return null;

  const open = source.indexOf('(', start);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
};

module.exports = { blockAfter, callAfter };
