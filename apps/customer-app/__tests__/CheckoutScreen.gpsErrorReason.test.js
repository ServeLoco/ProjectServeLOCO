/**
 * iPhone-only checkout bug: after "Confirm location" the sheet showed
 * "Location permission denied" and kept showing it no matter how many times
 * the user granted permission.
 *
 * Cause was two independent faults stacking:
 *   1. LocationPicker capped the live fix at GPS_TIMEOUT_MS. iOS keeps
 *      refining until it actually reaches Accuracy.High, so a cold indoor fix
 *      routinely blew past the cap — while Android's fused provider returned a
 *      cached fix immediately, which is why only iPhone saw it.
 *   2. CheckoutScreen mapped EVERY onLocateStatus('error') to GPS_ERROR_DENIED,
 *      so that timeout was reported as a permission problem. Granting
 *      permission could never fix it, and each retry hit the same timeout.
 *
 * GPS_ERROR_TIMEOUT's copy existed but was never assigned anywhere — the dead
 * branch is what proved the timeout path had never been wired up.
 *
 * These are source assertions to match the existing LocationPicker test style
 * (the component pulls in native map modules that don't render under jest).
 */

const fs = require('fs');
const path = require('path');

const read = (...segments) => fs.readFileSync(path.join(__dirname, '..', 'src', ...segments), 'utf8');

const picker = read('components', 'LocationPicker', 'LocationPicker.js');
const checkout = read('screens', 'customer', 'CheckoutScreen', 'CheckoutScreen.js');

describe('LocationPicker — live fix failure handling', () => {
  it('falls back to a cached fix instead of failing when the live one times out', () => {
    expect(picker).toMatch(/getLastKnownPositionAsync\(\{\s*maxAge: LAST_KNOWN_MAX_AGE_MS\s*\}\)/);
    // Must be reached from the timeout/failure path, not the happy path.
    expect(picker).toMatch(/catch \(err\)[\s\S]{0,600}getLastKnownPositionAsync/);
    // Only surface a hard failure when the cache is empty too.
    expect(picker).toMatch(/if \(lastKnown\?\.coords\) return lastKnown;\s*\n\s*throw err;/);
  });

  it('reports a fix failure as unavailable, never as a permission problem', () => {
    expect(picker).toMatch(/onLocateStatusRef\.current\?\.\('error', 'unavailable'\)/);
  });

  it('still distinguishes a real permission denial from one needing Settings', () => {
    expect(picker).toMatch(
      /onLocateStatusRef\.current\?\.\('error', perm\.needsSettings \? 'settings' : 'permission'\)/,
    );
  });
});

describe('CheckoutScreen — GPS error attribution', () => {
  it('only claims permission denied when the picker reported a permission problem', () => {
    expect(checkout).toMatch(/reason === 'permission' \? GPS_ERROR_DENIED/);
    expect(checkout).toMatch(/reason === 'settings' \? GPS_ERROR_SETTINGS/);
  });

  it('never unconditionally sets DENIED on a locate error again', () => {
    // The original bug, verbatim: setGpsStatus('error') immediately followed
    // by an unconditional setGpsError(GPS_ERROR_DENIED).
    expect(checkout).not.toMatch(/setGpsStatus\('error'\);\s*\n\s*setGpsError\(GPS_ERROR_DENIED\);/);
  });

  it('accepts the reason argument from onLocateStatus', () => {
    expect(checkout).toMatch(/handleLocateStatus = useCallback\(\(status, reason\)/);
  });

  it('gives the timeout copy a way forward rather than a dead end', () => {
    // GPS_ERROR_TIMEOUT is now reachable, so its copy has to tell the user
    // what to do next instead of just stating "GPS timed out."
    expect(checkout).toMatch(/GPS didn\\'t respond in time\. Drag the map to pin your address instead\./);
  });
});
