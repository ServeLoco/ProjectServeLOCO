/**
 * Tests for the ProductCard unified "unavailable" treatment.
 *
 * Shop-closed (shopIsOpen === false) and out-of-stock (available === false)
 * are collapsed into a single unavailable state: same desaturated photo,
 * same white wash, same "Item Unavailable" label, same locked buy control
 * and outer press — no per-cause distinction, removing the prior ambiguity
 * between "Shop closed" / "Temporarily Unavailable" / "Closed" / "Out".
 *
 * These tests use static source assertions (no React render) so they run
 * fast and cannot silently regress when someone refactors the card.
 */

const fs = require('fs');
const path = require('path');

const productCardPath = path.join(
  __dirname, '..', 'src', 'components', 'ProductCard', 'ProductCard.js'
);
const productImagePath = path.join(
  __dirname, '..', 'src', 'components', 'ProductImage', 'ProductImage.js'
);

describe('ProductCard renders a single unavailable state for closed shop or out-of-stock', () => {
  const source = fs.readFileSync(productCardPath, 'utf8');

  it('derives one isUnavailable flag from both shopIsOpen casings and availability', () => {
    expect(source).toMatch(/isUnavailable\s*=\s*!resolvedAvailable \|\| isShopClosed/);
    expect(source).toMatch(/shopIsOpen/);
    expect(source).toMatch(/shop_is_open/);
  });

  it('does not render separate "Closed" / "Out" / "Shop closed" / "Temporarily Unavailable" branches', () => {
    expect(source).not.toMatch(/key=["']closed["']/);
    expect(source).not.toMatch(/key=["']out["']/);
    expect(source).not.toMatch(/>Closed<\/Text>/);
    expect(source).not.toMatch(/>Out<\/Text>/);
    expect(source).not.toMatch(/Shop closed/);
    expect(source).not.toMatch(/Temporarily Unavailable/);
  });

  it('shows a single disabled "Unavailable" pill', () => {
    expect(source).toMatch(/key=["']unavailable["'][\s\S]{0,200}Unavailable/);
  });

  it('disables the outer TouchableOpacity whenever unavailable, regardless of cause', () => {
    expect(source).toMatch(/disabled=\{isUnavailable\}/);
  });

  it('strips press handlers when unavailable', () => {
    expect(source).toMatch(/onPress=\{isUnavailable \? null : onPress\}/);
    expect(source).toMatch(/onPressIn=\{isUnavailable \? null : handlePressIn\}/);
    expect(source).toMatch(/onPressOut=\{isUnavailable \? null : handlePressOut\}/);
  });

  it('passes a grayscale filter to the product image when unavailable', () => {
    expect(source).toMatch(/filter=\{isUnavailable \? \[\{ grayscale: 1 \}\] : undefined\}/);
  });

  it('overlays a semi-transparent white wash when unavailable', () => {
    expect(source).toMatch(/closedWash/);
    expect(source).toMatch(/rgba\(255,255,255,0\.45\)/);
    expect(source).toMatch(/\{isUnavailable \? \(/);
  });

  it('renders a single "Item Unavailable" label near the vertical center of the card', () => {
    expect(source).toMatch(/Item Unavailable/);
    expect(source).toMatch(/top:\s*['"]38%['"]/);
  });

  it('does not render a separate dark out-of-stock wash anymore', () => {
    expect(source).not.toMatch(/oosWash/);
  });

  it('hides the discount ribbon whenever unavailable', () => {
    expect(source).toMatch(/resolvedDiscountLabel && !isUnavailable/);
  });
});

describe('ProductImage forwards the filter prop to expo-image', () => {
  const source = fs.readFileSync(productImagePath, 'utf8');

  it('accepts a filter prop in the function signature', () => {
    expect(source).toMatch(/filter,?\s*\n?\}\s*\)\s*\{/);
    expect(source).toMatch(/function ProductImage\([\s\S]*?\bfilter\b/);
  });

  it('passes filter to both fallback and remote Image components', () => {
    const filterMatches = source.match(/filter=\{filter\}/g);
    expect(filterMatches).not.toBeNull();
    expect(filterMatches.length).toBeGreaterThanOrEqual(2);
  });
});
