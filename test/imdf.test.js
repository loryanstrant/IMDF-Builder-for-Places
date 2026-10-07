const test = require('node:test');
const assert = require('node:assert/strict');

const { generateIMDFFiles, labels, polygonGeometry } = require('../imdf.js');
const { signedArea } = require('../public/js/geo.js');

// A small, realistic project: one building, one level, two rooms, a door and a
// desk — roughly the trial setup described in issue #13.
function sampleProject() {
  const levelId = 'level-1';
  return {
    venue: { id: 'venue-1', name: 'Contoso HQ', coordinates: [151.2093, -33.8688] },
    building: { id: 'building-1', name: 'Building A' },
    address: {
      id: 'address-1',
      address: '1 Example Street',
      locality: 'Sydney',
      province: 'NSW',
      country: 'AU',
      postal_code: '2000'
    },
    levels: [{ id: levelId, name: 'Ground Floor', ordinal: 0, short_name: '0' }],
    units: [
      {
        id: 'unit-1',
        name: 'Meeting Room 1',
        category: 'conferenceroom',
        levelId,
        exchangeId: 'room1@contoso.com',
        // Deliberately clockwise, to prove the exporter rewinds it.
        coordinates: [[
          [151.2093, -33.8688],
          [151.2093, -33.8687],
          [151.2094, -33.8687],
          [151.2094, -33.8688]
        ]]
      },
      {
        id: 'unit-2',
        name: 'Hot Desks',
        category: 'room',
        levelId,
        coordinates: [[
          [151.2094, -33.8688],
          [151.2095, -33.8688],
          [151.2095, -33.8687],
          [151.2094, -33.8687]
        ]]
      }
    ],
    amenities: [
      { id: 'amenity-1', name: 'Desk', category: 'seating', levelId, unitIds: ['unit-2'], coordinates: [151.20945, -33.86875] }
    ],
    fixtures: [
      { id: 'fixture-1', category: 'wall', levelId, coordinates: [[151.2093, -33.8688], [151.2095, -33.8688]] }
    ],
    openings: [
      { id: 'opening-1', category: 'pedestrian', levelId, coordinates: [[151.20935, -33.8688], [151.20938, -33.8688]] }
    ],
    anchors: []
  };
}

test('every IMDF file in the archive is present', () => {
  const files = generateIMDFFiles(sampleProject());
  for (const name of ['manifest.json', 'venue.geojson', 'building.geojson', 'footprint.geojson',
    'level.geojson', 'unit.geojson', 'amenity.geojson', 'fixture.geojson',
    'opening.geojson', 'anchor.geojson', 'address.geojson']) {
    assert.ok(files[name], `${name} missing`);
  }
});

// ── Issue #25 ──────────────────────────────────────────────────────

test('issue #25: footprint.geojson is not empty', () => {
  const files = generateIMDFFiles(sampleProject());
  const footprints = files['footprint.geojson'].features;
  assert.equal(footprints.length, 1);
  assert.equal(footprints[0].feature_type, 'footprint');
  assert.ok(footprints[0].geometry, 'footprint has geometry');
  assert.equal(footprints[0].geometry.type, 'Polygon');
  assert.ok(footprints[0].geometry.coordinates[0].length >= 4);
});

test('footprint references the building and uses a valid category', () => {
  const files = generateIMDFFiles(sampleProject());
  const fp = files['footprint.geojson'].features[0];
  const buildingId = files['building.geojson'].features[0].id;
  assert.deepEqual(fp.properties.building_ids, [buildingId]);
  assert.ok(['ground', 'aerial', 'subterranean'].includes(fp.properties.category));
});

test('the footprint encloses every unit that was drawn', () => {
  const project = sampleProject();
  const files = generateIMDFFiles(project);
  const ring = files['footprint.geojson'].features[0].geometry.coordinates[0];
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);

  for (const unit of project.units) {
    for (const [lon, lat] of unit.coordinates[0]) {
      assert.ok(lon >= Math.min(...lons) && lon <= Math.max(...lons), 'lon inside footprint');
      assert.ok(lat >= Math.min(...lats) && lat <= Math.max(...lats), 'lat inside footprint');
    }
  }
});

test('building is unlocated: geometry MUST be null', () => {
  const files = generateIMDFFiles(sampleProject());
  const building = files['building.geojson'].features[0];
  assert.equal(building.geometry, null);
  assert.ok(building.properties.display_point, 'building still has a display point');
});

test('footprint is still produced when nothing but units exist', () => {
  const project = sampleProject();
  delete project.building;
  const files = generateIMDFFiles(project);
  assert.equal(files['footprint.geojson'].features.length, 1);
});

test('an empty project does not crash and emits no bogus geometry', () => {
  const files = generateIMDFFiles({});
  assert.equal(files['footprint.geojson'].features.length, 0);
  assert.equal(files['venue.geojson'].features.length, 0);
  assert.equal(files['unit.geojson'].features.length, 0);
  assert.equal(files['building.geojson'].features[0].geometry, null);
});

// ── Spec conformance ───────────────────────────────────────────────

test('venue has polygonal geometry, not a point', () => {
  const files = generateIMDFFiles(sampleProject());
  const venue = files['venue.geojson'].features[0];
  assert.equal(venue.geometry.type, 'Polygon');
  assert.equal(venue.properties.display_point.type, 'Point');
});

test('names are LABELS objects, never bare strings', () => {
  const files = generateIMDFFiles(sampleProject());
  assert.deepEqual(files['venue.geojson'].features[0].properties.name, { en: 'Contoso HQ' });
  assert.deepEqual(files['building.geojson'].features[0].properties.name, { en: 'Building A' });
  assert.deepEqual(files['level.geojson'].features[0].properties.short_name, { en: '0' });
  assert.deepEqual(files['unit.geojson'].features[0].properties.name, { en: 'Meeting Room 1' });
});

test('units reference their level via level_id', () => {
  const files = generateIMDFFiles(sampleProject());
  const unit = files['unit.geojson'].features[0];
  assert.equal(unit.properties.level_id, 'level-1');
  assert.equal(unit.properties.level, undefined);
});

test('levels carry outdoor, ordinal and building_ids', () => {
  const files = generateIMDFFiles(sampleProject());
  const level = files['level.geojson'].features[0].properties;
  assert.equal(level.outdoor, false);
  assert.equal(level.ordinal, 0);
  assert.deepEqual(level.building_ids, ['building-1']);
});

test('levels get distinct extents instead of one shared placeholder', () => {
  const project = sampleProject();
  project.levels.push({ id: 'level-2', name: 'First Floor', ordinal: 1 });
  project.units.push({
    id: 'unit-3', name: 'Upstairs', levelId: 'level-2',
    coordinates: [[[151.3, -33.9], [151.3001, -33.9], [151.3001, -33.8999], [151.3, -33.8999]]]
  });
  const files = generateIMDFFiles(project);
  const [a, b] = files['level.geojson'].features;
  assert.notDeepEqual(a.geometry.coordinates, b.geometry.coordinates);
});

test('fixtures become polygons because IMDF forbids fixture linestrings', () => {
  const files = generateIMDFFiles(sampleProject());
  const fixture = files['fixture.geojson'].features[0];
  assert.equal(fixture.geometry.type, 'Polygon');
  assert.equal(fixture.properties.level_id, 'level-1');
});

test('openings stay linestrings', () => {
  const files = generateIMDFFiles(sampleProject());
  assert.equal(files['opening.geojson'].features[0].geometry.type, 'LineString');
});

test('amenities reference units through unit_ids', () => {
  const files = generateIMDFFiles(sampleProject());
  assert.deepEqual(files['amenity.geojson'].features[0].properties.unit_ids, ['unit-2']);
});

test('address.geojson is populated and referenced by venue and building', () => {
  const files = generateIMDFFiles(sampleProject());
  const address = files['address.geojson'].features[0];
  assert.equal(address.properties.locality, 'Sydney');
  assert.equal(files['venue.geojson'].features[0].properties.address_id, address.id);
  assert.equal(files['building.geojson'].features[0].properties.address_id, address.id);
});

test('address_id is null when no address was entered', () => {
  const project = sampleProject();
  project.address = null;
  const files = generateIMDFFiles(project);
  assert.equal(files['address.geojson'].features.length, 0);
  assert.equal(files['venue.geojson'].features[0].properties.address_id, null);
});

test('all exterior rings are wound counter-clockwise and closed', () => {
  const files = generateIMDFFiles(sampleProject());
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.geojson')) continue;
    for (const feature of content.features) {
      if (!feature.geometry || feature.geometry.type !== 'Polygon') continue;
      const ring = feature.geometry.coordinates[0];
      assert.deepEqual(ring[0], ring[ring.length - 1], `${name} ring not closed`);
      assert.ok(signedArea(ring) > 0, `${name} ring not counter-clockwise`);
    }
  }
});

test('Exchange room IDs survive export as exchange_id', () => {
  const files = generateIMDFFiles(sampleProject());
  const units = files['unit.geojson'].features;
  assert.equal(units[0].properties.exchange_id, 'room1@contoso.com');
  assert.equal(units[1].properties.exchange_id, undefined);
});

test('manifest declares the generator and language', () => {
  const files = generateIMDFFiles(sampleProject());
  assert.equal(files['manifest.json'].version, '1.0.0');
  assert.equal(files['manifest.json'].language, 'en');
  assert.ok(files['manifest.json'].generated_by);
  assert.deepEqual(files['manifest.json'].extensions, []);
});

// ── Helpers ────────────────────────────────────────────────────────

test('labels() wraps strings and passes objects through', () => {
  assert.deepEqual(labels('Room'), { en: 'Room' });
  assert.deepEqual(labels({ fr: 'Salle' }), { fr: 'Salle' });
  assert.equal(labels(''), null);
  assert.equal(labels(null), null);
});

test('polygonGeometry rejects degenerate rings instead of inventing one', () => {
  assert.equal(polygonGeometry([[[0, 0], [1, 1]]]), null);
  assert.equal(polygonGeometry(null), null);
  assert.equal(polygonGeometry([]), null);
});
