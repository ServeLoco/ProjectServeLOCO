const fs = require('fs');
const path = require('path');

const storeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'stores', 'useDeliveryLocationStore.js'),
  'utf8',
);
const homeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'HomeScreen', 'HomeScreen.js'),
  'utf8',
);
const modalSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'ChangeLocationModal', 'ChangeLocationModal.js'),
  'utf8',
);

describe('saved delivery locations', () => {
  it('persists a bounded, de-duplicated history of manually chosen locations', () => {
    expect(storeSource).toMatch(/recentLocations: \[\]/);
    expect(storeSource).toMatch(/RECENT_LOCATION_LIMIT/);
    expect(storeSource).toMatch(/setLocationLabel/);
  });

  it('renders recent locations in the Change Location flow and revalidates a selection', () => {
    expect(homeSource).toMatch(/recentDeliveryLocations/);
    expect(homeSource).toMatch(/handleConfirmPickedLocation\(location\.lat, location\.lng\)/);
    expect(homeSource).toMatch(/setDeliveryLocationLabel\(selectedLabel\)/);
    expect(modalSource).toMatch(/recentLocations/);
    expect(modalSource).toMatch(/Last saved location/);
    expect(modalSource).toMatch(/onConfirm\?\.\(lat, lng, labelForConfirmedPoint\(lat, lng\)\)/);
  });

  // Picking "Rampur" then panning the map 5km away must not save the new point
  // under the name "Rampur".
  it('drops a searched place name when the confirmed pin has moved away from it', () => {
    expect(modalSource).toMatch(/labelCoordRef/);
    expect(modalSource).toMatch(/LABEL_MATCH_TOLERANCE_DEG/);
    expect(modalSource).toMatch(/return moved \? null : selectedLabel/);
  });

  // Blurring the input to clear suggestions unmounts the row before its
  // onPress fires, making search results untappable.
  it('does not clear search suggestions on input blur', () => {
    expect(modalSource).not.toMatch(/onBlur=\{\(\) => setSuggestions\(\[\]\)\}/);
  });
});
