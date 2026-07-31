/**
 * Dashboard product/combo rows must sink unavailable items (shop closed or
 * turned off) to the end, keeping the admin's arranged relative order within
 * each group (available-first, unavailable-last, stable). Recomputed on every
 * render so a live availability/shop-status patch reorders the row in the
 * same tick the card greys out.
 *
 * Static source assertions (no React render) so this runs fast and can't
 * silently regress when someone refactors the section-rendering block.
 */

const fs = require('fs');
const path = require('path');

const homeScreenPath = path.join(
  __dirname, '..', 'src', 'screens', 'customer', 'HomeScreen', 'HomeScreen.js'
);

describe('HomeScreen sorts product/combo block rows by availability', () => {
  const source = fs.readFileSync(homeScreenPath, 'utf8');

  it('derives an unavailable flag per item from both product and shop-level fields', () => {
    expect(source).toMatch(/!a\.available \|\| a\.shopIsOpen === false \|\| a\.shop_is_open === false/);
  });

  it('uses a stable sort (Array#sort) rather than an unstable partition/filter', () => {
    expect(source).toMatch(/const sortedItems = \[\.\.\.normalizedItems\]\.sort\(/);
  });

  it('keeps items within the same availability group in relative order (comparator returns 0 for same group)', () => {
    const sortBlock = source.match(/const sortedItems[\s\S]{0,400}?\}\);/);
    expect(sortBlock).not.toBeNull();
    expect(sortBlock[0]).toMatch(/aOut === bOut \? 0/);
  });

  it('sorts before slicing combo_block to its visible 2 cards, so unavailable combos are pushed out first', () => {
    expect(source).toMatch(/const visibleItems = isComboBlock \? sortedItems\.slice\(0, 2\) : sortedItems;/);
  });
});

// Pure re-implementation of the comparator to verify actual sort behavior,
// since HomeScreen.js only exposes it inline inside the render function.
function isRowItemUnavailable(item) {
  return !item.available || item.shopIsOpen === false || item.shop_is_open === false;
}

function sortRow(items) {
  return [...items].sort((a, b) => {
    const aOut = isRowItemUnavailable(a);
    const bOut = isRowItemUnavailable(b);
    return aOut === bOut ? 0 : aOut ? 1 : -1;
  });
}

describe('Row sort comparator behavior', () => {
  it('moves unavailable items to the end while keeping relative order within each group', () => {
    const items = [
      { id: 1, available: true },
      { id: 2, available: false },
      { id: 3, available: true },
      { id: 4, shopIsOpen: false, available: true },
      { id: 5, available: true },
    ];
    const result = sortRow(items).map((i) => i.id);
    // Available: 1, 3, 5 (original relative order). Unavailable: 2, 4 (original relative order).
    expect(result).toEqual([1, 3, 5, 2, 4]);
  });

  it('is a no-op when everything is available', () => {
    const items = [{ id: 1, available: true }, { id: 2, available: true }, { id: 3, available: true }];
    expect(sortRow(items).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('moves an item back to the front the instant it becomes available again', () => {
    const items = [
      { id: 1, available: false },
      { id: 2, available: true },
      { id: 3, available: true },
    ];
    // Item 1 flips available (as a live patch would do) — recompute should
    // put it back among the available group, at the end of that group.
    const patched = items.map((i) => (i.id === 1 ? { ...i, available: true } : i));
    expect(sortRow(patched).map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it('treats shop_is_open (snake_case) the same as shopIsOpen', () => {
    const items = [
      { id: 1, available: true },
      { id: 2, available: true, shop_is_open: false },
      { id: 3, available: true },
    ];
    expect(sortRow(items).map((i) => i.id)).toEqual([1, 3, 2]);
  });
});
