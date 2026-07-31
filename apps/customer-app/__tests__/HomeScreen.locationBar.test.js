const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'HomeScreen', 'HomeScreen.js'),
  'utf8',
);

describe('HomeScreen delivery location bar', () => {
  it('shows the admin-assigned delivery zone name, never coordinates', () => {
    expect(source).toMatch(/deliveryZoneName\s*$/m);
    expect(source).not.toMatch(/formatDeliveryCoordinates/);
    expect(source).not.toMatch(/Fetching your location…/);
  });

  // zoneName is only ever populated in zone-pricing mode, so on a flat-pricing
  // install the "finding" placeholder would otherwise be shown forever.
  it('drops the "finding" placeholder once the initial location sync completes', () => {
    expect(source).toMatch(/isInitialLocationSyncComplete \? 'Delivery location' : 'Finding your area…'/);
  });
});
