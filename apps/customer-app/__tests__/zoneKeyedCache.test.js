const fs = require('fs');
const path = require('path');

const productListSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'ProductListScreen', 'ProductListScreen.js'),
  'utf8',
);
const categoriesSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'CategoriesScreen', 'CategoriesScreen.js'),
  'utf8',
);

// The catalog isn't zone-scoped server-side yet, but the client cache must
// already key on the active delivery zone — otherwise moving the pin from
// zone A to zone B instantly repaints zone A's cached products/categories
// (apiCache has no zone concept of its own; keys are opaque strings, so the
// caller has to build the zone into the key).
describe('API cache is keyed on the active delivery zone', () => {
  it('ProductListScreen reads zoneId from the delivery location store', () => {
    expect(productListSource).toMatch(
      /deliveryZoneId = useDeliveryLocationStore\(state => state\.zoneId\)/,
    );
  });

  it('ProductListScreen includes zoneId in the cache-key params for both the section and normal fetch paths', () => {
    const requestParamsBlocks = productListSource.match(/const requestParams = sectionSlug[\s\S]*?\};/g) || [];
    expect(requestParamsBlocks.length).toBeGreaterThanOrEqual(2);
    requestParamsBlocks.forEach((block) => {
      expect(block).toMatch(/zoneId: deliveryZoneId/);
    });
  });

  it('ProductListScreen refetches when the zone changes (effect + focus-effect deps)', () => {
    // Initial/category fetch effect
    expect(productListSource).toMatch(
      /\}, \[activeCategory, offerId, sectionSlug, sectionStoreType, mode, route\.params\?\.categoryId, isLocationGated, deliveryZoneId\]\);/,
    );
    // Debounced search effect
    expect(productListSource).toMatch(/\}, \[searchQuery, mode, isLocationGated, deliveryZoneId\]\);/);
    // Focus-effect freshness check
    expect(productListSource).toMatch(/initialCategory,\s*\n\s*deliveryZoneId,\s*\n\s*\]\),/);
  });

  it('CategoriesScreen folds zoneId into the categories cache key', () => {
    expect(categoriesSource).toMatch(
      /deliveryZoneId = useDeliveryLocationStore\(state => state\.zoneId\)/,
    );
    expect(categoriesSource).toMatch(
      /categoriesCacheKey = `categories:\$\{storeType\}:\$\{deliveryZoneId \?\? 'none'\}`/,
    );
  });
});
