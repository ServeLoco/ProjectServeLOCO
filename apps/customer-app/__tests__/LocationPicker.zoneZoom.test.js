const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'LocationPicker', 'LocationPicker.js'),
  'utf8',
);

describe('LocationPicker zone-aware zoom', () => {
  it('uses a caller-supplied initial zoom and pulls back to show delivery zones', () => {
    expect(source).toMatch(/initialZoom = DEFAULT_ZOOM/);
    expect(source).toMatch(/zoomLevel: initialZoom/);
    expect(source).toMatch(/!showZoneOverlay/);
    expect(source).toMatch(/applyCamera\(center\.latitude, center\.longitude, \{\s*zoomLevel: DEFAULT_ZOOM/);
  });
});
