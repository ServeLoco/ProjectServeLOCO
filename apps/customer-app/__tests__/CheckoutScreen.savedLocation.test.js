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

  // The bill falls back to savedDeliveryLocation, so the submitted order has
  // to as well. Without it, a customer who arrived with a saved location and
  // never re-confirmed a pin got a priced bill but an order posted with no
  // coordinates — which the server refuses as out of range once zone pricing
  // is on. Priced one way, submitted another.
  it('submits the order with the same saved location the bill was priced from', () => {
    expect(source).toMatch(
      /const pin = coordinatesRef\.current \|\| coordinates \|\| savedDeliveryLocation/,
    );
  });

  it('never commits the unconfirmed live map centre as the order location', () => {
    // previewCoordinates tracks the map as it drifts — preview only.
    expect(source).not.toMatch(/const pin = [^\n]*previewCoordinates/);
  });

  it('opens tightly focused on the saved pin and asks the picker to reveal zones when out of range', () => {
    expect(source).toMatch(/initialZoom=\{14\.5\}/);
    expect(source).toMatch(/showZoneOverlay=\{outOfRange\}/);
  });
});
