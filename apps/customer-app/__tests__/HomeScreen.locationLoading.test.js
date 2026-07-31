const fs = require('fs');
const path = require('path');

const homeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'HomeScreen', 'HomeScreen.js'),
  'utf8',
);
const storeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'stores', 'useDeliveryLocationStore.js'),
  'utf8',
);
const syncSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'hooks', 'useDeliveryLocationSync.js'),
  'utf8',
);

describe('Home location initialization loading', () => {
  it('keeps the existing shimmer visible until initial location resolution finishes', () => {
    expect(storeSource).toMatch(/isInitialSyncComplete: false/);
    expect(storeSource).toMatch(/markInitialSyncComplete/);
    expect(syncSource).toMatch(/finally \{[\s\S]*markInitialSyncComplete\(\);/);
    expect(homeSource).toMatch(/state => state\.isInitialSyncComplete/);
    expect(homeSource).toMatch(/const isHomeLoading = isLoading \|\| !isInitialLocationSyncComplete;/);
  });

  it('shows a slow-internet message without leaving the customer blocked indefinitely', () => {
    expect(homeSource).toMatch(/Slow internet — setting your delivery location…/);
    expect(syncSource).toMatch(/INITIAL_SYNC_TIMEOUT_MS/);
  });
});
