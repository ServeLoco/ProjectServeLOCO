const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'HomeScreen', 'HomeScreen.js'),
  'utf8',
);

describe('HomeScreen delivery location bar', () => {
  it('shows the admin-assigned delivery zone name, never coordinates', () => {
    expect(source).toMatch(/deliveryZoneName \|\| 'Delivery location'/);
    expect(source).not.toMatch(/formatDeliveryCoordinates/);
    expect(source).not.toMatch(/Fetching your location…/);
  });

  // The initial GPS fix can silently fail or time out (see
  // syncDeliveryLocation's best-effort catch) — deliveryCoords then stays
  // null forever with nothing to retry it automatically. "Change"/"Set"
  // normally lives inside the deliveryCoords-gated bar, so without this
  // fallback branch the customer would be stuck on the dashboard with no
  // way to set a location at all.
  it('offers a manual "Set" action when the initial sync completes without a GPS fix', () => {
    expect(source).toMatch(
      /\(deliveryCoords \? insideDeliveryZone !== false : isInitialLocationSyncComplete\)/
    );
    expect(source).toMatch(/deliveryCoords \? 'Change' : 'Set'/);
  });
});
