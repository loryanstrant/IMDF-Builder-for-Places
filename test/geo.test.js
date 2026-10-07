const test = require('node:test');
const assert = require('node:assert/strict');

const geo = require('../public/js/geo.js');
const { Georeference, toCounterClockwise, signedArea, boundingRing, bufferLine } = geo;

const SYDNEY = { lat: -33.8688, lon: 151.2093 };

test('anchor pixel maps exactly to the anchor coordinate', () => {
  const g = new Georeference({ ...SYDNEY, anchorX: 400, anchorY: 300, metresPerPixel: 0.05 });
  assert.deepEqual(g.toLonLat(400, 300), [SYDNEY.lon, SYDNEY.lat]);
});

test('moving right and down goes east and south', () => {
  const g = new Georeference({ ...SYDNEY, anchorX: 0, anchorY: 0, metresPerPixel: 1 });
  const [lon, lat] = g.toLonLat(100, 100);
  assert.ok(lon > SYDNEY.lon, 'east');
  assert.ok(lat < SYDNEY.lat, 'south');
});

test('scale is honoured: 20 px at 0.5 m/px is 10 m north', () => {
  const g = new Georeference({ ...SYDNEY, anchorX: 0, anchorY: 0, metresPerPixel: 0.5 });
  const { north, east } = g.toLocalMetres(0, -20);
  assert.ok(Math.abs(north - 10) < 1e-9);
  assert.ok(Math.abs(east) < 1e-9);
});

test('90 degree rotation turns plan-north into true east', () => {
  const g = new Georeference({ ...SYDNEY, anchorX: 0, anchorY: 0, metresPerPixel: 1, rotation: 90 });
  const { east, north } = g.toLocalMetres(0, -10); // 10 px "up" the page
  assert.ok(Math.abs(east - 10) < 1e-6, `east was ${east}`);
  assert.ok(Math.abs(north) < 1e-6, `north was ${north}`);
});

test('toCanvas round-trips toLonLat', () => {
  const g = new Georeference({ ...SYDNEY, anchorX: 120, anchorY: 80, metresPerPixel: 0.04, rotation: 17 });
  const [lon, lat] = g.toLonLat(523, 611);
  const back = g.toCanvas(lon, lat);
  assert.ok(Math.abs(back.x - 523) < 0.1, `x drifted to ${back.x}`);
  assert.ok(Math.abs(back.y - 611) < 0.1, `y drifted to ${back.y}`);
});

test('calibration derives metres per pixel from a known distance', () => {
  const g = new Georeference({ ...SYDNEY });
  g.calibrateFromPoints({ x: 0, y: 0 }, { x: 0, y: 200 }, 10);
  assert.equal(g.metresPerPixel, 0.05);
  assert.equal(g.calibrated, true);
});

test('calibration rejects a zero-length measurement', () => {
  const g = new Georeference({ ...SYDNEY });
  assert.throws(() => g.calibrateFromPoints({ x: 5, y: 5 }, { x: 5, y: 5 }, 10));
  assert.equal(g.calibrated, false);
});

test('rings are closed and wound counter-clockwise per RFC 7946', () => {
  const clockwise = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const ring = toCounterClockwise(clockwise);
  assert.deepEqual(ring[0], ring[ring.length - 1], 'ring is closed');
  assert.ok(signedArea(ring) > 0, 'exterior ring winds counter-clockwise');
});

test('an already counter-clockwise ring is left alone', () => {
  const ccw = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ring = toCounterClockwise(ccw);
  assert.deepEqual(ring.slice(0, 4), ccw);
});

test('boundingRing pads outwards and never collapses to a point', () => {
  const ring = boundingRing([[151.2, -33.8], [151.2, -33.8]], 5, -33.8);
  assert.equal(ring.length, 5);
  assert.ok(signedArea(ring) > 0);
  const lons = ring.map(p => p[0]);
  assert.ok(Math.max(...lons) > Math.min(...lons));
});

test('bufferLine turns a line into a valid closed polygon ring', () => {
  const ring = bufferLine([[151.2093, -33.8688], [151.2095, -33.8688]], 0.3, -33.8688);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.ok(signedArea(ring) > 0);
});
