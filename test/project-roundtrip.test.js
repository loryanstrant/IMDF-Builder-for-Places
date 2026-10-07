// Issue #12: "Place Items Are Lost After Saving and Reloading a Project".
//
// The save payload used to contain only projected IMDF coordinates, and the
// load path rebuilt every unit as a 100x100 rectangle at (100, 100) while
// dropping fixtures and openings entirely. These tests drive the real
// IMDFBuilder methods against a Fabric stub and assert that what goes in comes
// back out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { fabric, makeCanvas } = require('./helpers/fabric-stub.js');

// ── Load app.js into a sandbox ─────────────────────────────────────

function loadBuilderClass() {
  const sandbox = {
    fabric,
    console,
    setTimeout,
    clearTimeout,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
      documentElement: { setAttribute() {}, getAttribute: () => 'light' }
    },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: false, text: async () => '{}' })
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const geoSrc = fs.readFileSync(path.join(__dirname, '../public/js/geo.js'), 'utf8');
  vm.runInContext(geoSrc, sandbox);
  // In a browser self === window; in the sandbox they are separate objects.
  sandbox.window.geoUtils = sandbox.geoUtils;
  sandbox.window.Georeference = sandbox.Georeference;

  const appSrc = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  vm.runInContext(appSrc, sandbox);

  return {
    IMDFBuilder: vm.runInContext('IMDFBuilder', sandbox),
    Georeference: sandbox.Georeference,
    sandbox
  };
}

const { IMDFBuilder, Georeference, sandbox } = loadBuilderClass();

// Build an instance without running init() (which needs a real DOM).
function makeApp() {
  const app = Object.create(IMDFBuilder.prototype);
  app.canvas = makeCanvas();
  app.levels = [];
  app.units = [];
  app.amenities = [];
  app.fixtures = [];
  app.openings = [];
  app.currentLevel = null;
  app.selectedObject = null;
  app.projectId = null;
  app.floorplanImage = null;
  app.geo = new Georeference({
    lat: -33.8688, lon: 151.2093,
    anchorX: 400, anchorY: 300,
    metresPerPixel: 0.05, calibrated: true
  });
  app.showToast = () => {};
  app.updateCounts = () => {};
  app.renderLevelsList = () => {};
  app.clearSelection = () => {};
  app.removeVertexHandles = () => {};
  app.applyLevelVisibility = () => {};
  app.generateUUID = (() => { let n = 0; return () => `id-${++n}`; })();
  return app;
}

// A project with one of every item type, drawn at known canvas positions.
function populate(app) {
  const level = { id: 'lvl-0', name: 'Ground Floor', ordinal: 0, short_name: '0' };
  app.levels.push(level);
  app.currentLevel = level;

  // An L-shaped room — the shape issue #13 asked about.
  const poly = new fabric.Polygon(
    [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 200 },
     { x: 200, y: 200 }, { x: 200, y: 300 }, { x: 100, y: 300 }],
    { objectCaching: false }
  );
  const unit = {
    id: 'u-1', type: 'unit', name: 'L-shaped Room', category: 'room',
    restriction: 'restricted', exchangeId: 'room1@contoso.com',
    levelId: level.id, fabricObject: poly
  };
  poly.imdfData = unit;
  app.units.push(unit);
  app.canvas.add(poly);

  const rect = new fabric.Rect({ left: 420, top: 120, width: 80, height: 60 });
  const unit2 = {
    id: 'u-2', type: 'unit', name: 'Hot Desk Zone', category: 'room',
    restriction: 'restricted', exchangeId: '', levelId: level.id, fabricObject: rect
  };
  rect.imdfData = unit2;
  app.units.push(unit2);
  app.canvas.add(rect);

  const circle = new fabric.Circle({ left: 250, top: 150, radius: 15 });
  const amenity = { id: 'a-1', type: 'amenity', name: 'Desk 1', category: 'seating', levelId: level.id, fabricObject: circle };
  circle.imdfData = amenity;
  app.amenities.push(amenity);
  app.canvas.add(circle);

  const wall = new fabric.Line([100, 100, 300, 100], {});
  const fixture = { id: 'f-1', type: 'fixture', category: 'wall', levelId: level.id, fabricObject: wall };
  wall.imdfData = fixture;
  app.fixtures.push(fixture);
  app.canvas.add(wall);

  const door = new fabric.Line([150, 300, 180, 300], {});
  const opening = { id: 'o-1', type: 'opening', category: 'door', levelId: level.id, fabricObject: door };
  door.imdfData = opening;
  app.openings.push(opening);
  app.canvas.add(door);

  return app;
}

// collectProjectData() reads the DOM for the name fields. app.js was compiled
// inside the sandbox, so the document it sees is the sandbox's one.
function collect(app) {
  const values = { projectName: 'Trial Floor', buildingName: 'Building A' };
  app.syncGeoFromInputs = () => {};
  const previous = sandbox.document.getElementById;
  sandbox.document.getElementById = (id) =>
    (values[id] !== undefined ? { value: values[id] } : null);
  try {
    return app.collectProjectData();
  } finally {
    sandbox.document.getElementById = previous;
  }
}

// Replay a saved payload through the real restore path.
function restore(saved) {
  const app = makeApp();
  app.geo = new Georeference(saved.georeference);
  app.levels = (saved.levels || []).map(l => ({ ...l }));
  app.restoreCollection(saved.units, 'unit', app.units);
  app.restoreCollection(saved.amenities, 'amenity', app.amenities);
  app.restoreCollection(saved.fixtures, 'fixture', app.fixtures);
  app.restoreCollection(saved.openings, 'opening', app.openings);
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────

test('save captures canvas geometry for every item type', () => {
  const saved = collect(populate(makeApp()));
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.units.every(u => u.canvas), 'units have canvas state');
  assert.ok(saved.amenities.every(a => a.canvas), 'amenities have canvas state');
  assert.ok(saved.fixtures.every(f => f.canvas), 'fixtures have canvas state');
  assert.ok(saved.openings.every(o => o.canvas), 'openings have canvas state');
  assert.equal(saved.units[0].canvas.points.length, 6, 'polygon vertices preserved');
});

test('issue #12: fixtures and openings are restored, not dropped', () => {
  const app = restore(collect(populate(makeApp())));
  assert.equal(app.units.length, 2);
  assert.equal(app.amenities.length, 1);
  assert.equal(app.fixtures.length, 1, 'fixtures restored');
  assert.equal(app.openings.length, 1, 'openings restored');
  assert.equal(app.canvas.getObjects().length, 5, 'every item is back on the canvas');
});

test('issue #12: a polygon room keeps its shape, not a 100x100 box', () => {
  const saved = collect(populate(makeApp()));
  const app = restore(saved);
  const poly = app.units[0].fabricObject;
  assert.equal(poly.type, 'polygon');
  assert.equal(poly.points.length, 6);
  assert.notEqual(poly.width, 100, 'not the old placeholder rectangle');

  const again = collect(app);
  assert.deepEqual(again.units[0].canvas.points, saved.units[0].canvas.points);
});

test('geometry survives a save/load/save round trip unchanged', () => {
  const first = collect(populate(makeApp()));
  const second = collect(restore(first));

  const strip = (p) => p.units.concat(p.amenities, p.fixtures, p.openings)
    .map(i => ({ id: i.id, coordinates: i.coordinates }));

  assert.deepEqual(strip(second), strip(first));
});

test('item metadata survives the round trip', () => {
  const app = restore(collect(populate(makeApp())));
  assert.equal(app.units[0].name, 'L-shaped Room');
  assert.equal(app.units[0].exchangeId, 'room1@contoso.com');
  assert.equal(app.units[0].levelId, 'lvl-0');
  assert.equal(app.fixtures[0].category, 'wall');
  assert.equal(app.openings[0].category, 'door');
});

test('restored objects are wired back to their imdfData', () => {
  const app = restore(collect(populate(makeApp())));
  app.canvas.getObjects().forEach(obj => {
    assert.ok(obj.imdfData, 'object has imdfData');
    assert.ok(obj.imdfData.id, 'imdfData has an id');
    assert.equal(obj.imdfData.fabricObject, obj, 'back-reference is correct');
  });
});

test('the restored canvas state is not carried as a duplicate field', () => {
  const app = restore(collect(populate(makeApp())));
  assert.equal(app.units[0].canvas, undefined);
});

test('a pre-v2 project is rebuilt by re-projecting its IMDF coordinates', () => {
  const saved = collect(populate(makeApp()));
  // Simulate a project saved by v1.1.0: coordinates but no canvas block.
  const legacy = JSON.parse(JSON.stringify(saved));
  [legacy.units, legacy.amenities, legacy.fixtures, legacy.openings]
    .forEach(list => list.forEach(i => { delete i.canvas; }));
  delete legacy.schemaVersion;

  const app = restore(legacy);
  assert.equal(app.units.length, 2);
  assert.equal(app.fixtures.length, 1);
  assert.equal(app.openings.length, 1);

  const poly = app.units[0].fabricObject;
  assert.equal(poly.type, 'polygon', 'the L-shape is still a polygon');
  assert.equal(poly.points.length, 6);

  // And the geometry lands back where it started, not at (100, 100).
  const again = collect(app);
  again.units[0].coordinates[0].forEach((pos, i) => {
    assert.ok(Math.abs(pos[0] - saved.units[0].coordinates[0][i][0]) < 1e-5);
    assert.ok(Math.abs(pos[1] - saved.units[0].coordinates[0][i][1]) < 1e-5);
  });
});

// ── Georeferencing of exported coordinates ─────────────────────────

test('exported coordinates land on the real site, not near [0, 0]', () => {
  const saved = collect(populate(makeApp()));
  saved.units[0].coordinates[0].forEach(([lon, lat]) => {
    assert.ok(Math.abs(lon - 151.2093) < 0.01, `lon ${lon} is near the venue`);
    assert.ok(Math.abs(lat + 33.8688) < 0.01, `lat ${lat} is near the venue`);
  });
});

test('a 200 px wall at 0.05 m/px measures about 10 m', () => {
  const saved = collect(populate(makeApp()));
  const [a, b] = saved.fixtures[0].coordinates;
  const metresPerDegLat = 111320;
  const dx = (b[0] - a[0]) * metresPerDegLat * Math.cos(-33.8688 * Math.PI / 180);
  const dy = (b[1] - a[1]) * metresPerDegLat;
  const length = Math.sqrt(dx * dx + dy * dy);
  assert.ok(Math.abs(length - 10) < 0.05, `wall measured ${length.toFixed(3)} m`);
});

test('exported unit rings are closed and counter-clockwise', () => {
  const { signedArea } = require('../public/js/geo.js');
  const saved = collect(populate(makeApp()));
  saved.units.forEach(u => {
    const ring = u.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.ok(signedArea(ring) > 0);
  });
});

test('export warnings flag an uncalibrated or unanchored project', () => {
  const app = populate(makeApp());
  app.geo.calibrated = false;
  const warnings = app.exportWarnings();
  assert.ok(warnings.some(w => w.includes('calibrated')));

  app.geo.calibrated = true;
  app.geo.lat = 0; app.geo.lon = 0;
  assert.ok(app.exportWarnings().some(w => w.includes('anchor')));

  app.geo.lat = -33.8688; app.geo.lon = 151.2093;
  // Cross-realm arrays are not reference-equal, so compare the length.
  assert.equal(app.exportWarnings().length, 0);
});

test('export warnings catch units orphaned by a deleted level', () => {
  const app = populate(makeApp());
  app.levels = [];
  assert.ok(app.exportWarnings().some(w => w.includes('no longer exists')));
});
