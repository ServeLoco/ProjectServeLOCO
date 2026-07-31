# Checkout Saved Delivery Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mobile checkout start from the shared saved delivery location and calculate live delivery pricing from a moved map pin before confirmation.

**Architecture:** `CheckoutScreen` subscribes to `useDeliveryLocationStore.coords`, updated by app-start background sync and Home changes. The map receives that location as its initial center and no longer starts a GPS lookup. The existing preview-pin coordinates continue feeding `cartApi.calculate`; confirmation remains the only action that commits coordinates for the order.

**Tech Stack:** React Native, Expo Location, Zustand, Jest.

## Global Constraints

- Change only `apps/customer-app` mobile checkout behavior.
- Do not trigger device GPS on checkout mount.
- Preserve live pin-movement pricing before confirmation.
- Preserve unrelated working-tree changes.

---

## File Structure

- Modify `apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js`: subscribe to the saved delivery location, initialize the map with it, and disable mount-time GPS lookup.
- Create `apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`: source-level regression coverage for the checkout location contract.

### Task 1: Add the failing checkout-location regression test

**Files:**
- Create: `apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`
- Test: `apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`

**Interfaces:**
- Consumes: CheckoutScreen source.
- Produces: a test that verifies the shared saved location is read, passed to `LocationPicker`, GPS auto-location is disabled, and preview coordinates remain part of pricing.

- [ ] **Step 1: Write the failing test**

```js
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'CheckoutScreen', 'CheckoutScreen.js'),
  'utf8',
);

describe('CheckoutScreen saved delivery location', () => {
  it('uses the shared saved location instead of auto-locating the device', () => {
    expect(source).toMatch(/useDeliveryLocationStore\(state => state\.coords\)/);
    expect(source).toMatch(/initialCenter=\{savedDeliveryLocation/);
    expect(source).toMatch(/autoLocateOnMount=\{false\}/);
  });

  it('uses the moved pin for live pricing before confirmation', () => {
    expect(source).toMatch(/latitude: coordinates\?\.lat \?\? previewCoordinates\?\.lat/);
    expect(source).toMatch(/longitude: coordinates\?\.lng \?\? previewCoordinates\?\.lng/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand __tests__/CheckoutScreen.savedLocation.test.js`

Expected: FAIL because CheckoutScreen does not yet read the delivery-location store, pass an initial center, or disable auto-location.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js
git commit -m "test: cover checkout saved location source"
```

### Task 2: Use saved coordinates in checkout

**Files:**
- Modify: `apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js:29, 183-218, 1156-1174`
- Test: `apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`

**Interfaces:**
- Consumes: `useDeliveryLocationStore(state => state.coords)`, shaped `{ lat, lng } | null`.
- Produces: `LocationPicker` initial center and disabled auto-location. Confirmed coordinates win; otherwise moved-pin preview coordinates win; otherwise saved coordinates are priced.

- [ ] **Step 1: Add the minimal implementation**

```js
import { useCartStore, useSettingsStore, useAuthStore, useDeliveryLocationStore, useDeliveryZonesStore } from '../../../stores';

const savedDeliveryLocation = useDeliveryLocationStore(state => state.coords);

const calculationPayload = useMemo(() => ({
  latitude: coordinates?.lat ?? previewCoordinates?.lat ?? savedDeliveryLocation?.lat,
  longitude: coordinates?.lng ?? previewCoordinates?.lng ?? savedDeliveryLocation?.lng,
}), [coordinates, previewCoordinates, savedDeliveryLocation]);

// inside LocationPicker
autoLocateOnMount={false}
initialCenter={savedDeliveryLocation
  ? { latitude: savedDeliveryLocation.lat, longitude: savedDeliveryLocation.lng }
  : undefined}
```

- [ ] **Step 2: Run focused test to verify it passes**

Run: `npm test -- --runInBand __tests__/CheckoutScreen.savedLocation.test.js`

Expected: PASS (2 tests, 0 failures).

- [ ] **Step 3: Lint changed files**

Run: `npx eslint src/screens/customer/CheckoutScreen/CheckoutScreen.js __tests__/CheckoutScreen.savedLocation.test.js`

Expected: exit code 0.

- [ ] **Step 4: Commit implementation**

```bash
git add apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js
git commit -m "fix: use saved location in checkout"
```

### Task 3: Verify integration

**Files:**
- Verify: `apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js`
- Verify: `apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`

- [ ] **Step 1: Run all customer-app tests**

Run: `npm test -- --runInBand`

Expected: exit code 0 with no failures.

- [ ] **Step 2: Review final diff**

Run: `git diff HEAD~1 -- apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js apps/customer-app/__tests__/CheckoutScreen.savedLocation.test.js`

Expected: only saved-location initialization, preview-pricing fallback, and regression coverage.

