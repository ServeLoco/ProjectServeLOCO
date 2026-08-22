/**
 * Checkout bug: "Please wait, checking delivery…" spun forever after
 * dragging the pin to a new spot, with ZERO network requests ever leaving
 * the device (confirmed live on a real Android device: reproduced, waited
 * 3+ minutes — well past httpClient's 20s timeout + 2 retries — logcat
 * showed no network activity the entire time, and curl confirmed the
 * server itself answers in ~60ms).
 *
 * Root cause: handleMapIdle called onLiveCenterChange unconditionally on
 * every idle event, with no dedupe — unlike the very next block, which
 * dedupes the same values (1e-8 epsilon) before writing them into
 * cameraTarget. A repeat/no-op idle (plausible from the controlled
 * centerCoordinate write itself echoing back through the native camera)
 * therefore created a brand-new {lat,lng} object on every firing.
 * CheckoutScreen's calculationPayload is useMemo'd on that object's
 * reference, so a fast-enough repeat loop cancelled the pending 80ms
 * pricing debounce before it ever fired — cartApi.calculate() never ran.
 *
 * Source assertions, matching this component's existing test style
 * (LocationPicker.zoneZoom.test.js) — it pulls in native map modules that
 * don't render under jest.
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'LocationPicker', 'LocationPicker.js'),
  'utf8',
);

describe('LocationPicker — onLiveCenterChange dedupe', () => {
  it('gates the parent notification behind a moved check, not an unconditional call', () => {
    // The bug, verbatim: no condition between setting lastMapCenterRef and
    // calling onLiveCenterChangeRef unconditionally.
    expect(source).not.toMatch(
      /lastMapCenterRef\.current = \{ latitude: lat, longitude: lng \};\s*\n\s*onLiveCenterChangeRef\.current\?\.\(lat, lng\);/,
    );
    expect(source).toMatch(/lastReportedCenterRef/);
    expect(source).toMatch(/if \(moved\) \{/);
  });

  it('uses an epsilon loose enough to absorb float round-trip noise but tight enough to catch a real drag', () => {
    expect(source).toMatch(/Math\.abs\(prevReported\.lat - lat\) >= 1e-6/);
    expect(source).toMatch(/Math\.abs\(prevReported\.lng - lng\) >= 1e-6/);
  });

  it('keeps lastMapCenterRef updated on every idle regardless of the dedupe', () => {
    // confirmLocation/readPinCoordinate need the freshest true center even
    // when it's not different enough to re-notify the parent.
    const idx = source.indexOf('const handleMapIdle');
    const body = source.slice(idx, idx + 1200);
    expect(body).toMatch(/lastMapCenterRef\.current = \{ latitude: lat, longitude: lng \};/);
  });
});
