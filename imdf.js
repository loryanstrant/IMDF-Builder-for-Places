// IMDF export — turns the editor's project data into the set of GeoJSON
// feature collections that Apple's Indoor Mapping Data Format (IMDF 1.0.0,
// OGC 20-094) defines and Microsoft Places consumes.
//
// Everything that arrives here is already in WGS84 lon/lat: the browser
// projects canvas pixels through public/js/geo.js before posting.

const { randomUUID } = require('crypto');
const geo = require('./public/js/geo.js');

const { toCounterClockwise, boundingRing, centroidOfRing, bufferLine, round7 } = geo;

// IMDF LABELS are language-keyed objects, never bare strings.
function labels(value, lang) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    return Object.keys(value).length ? value : null;
  }
  const out = {};
  out[lang || 'en'] = String(value);
  return out;
}

function requiredLabels(value, fallback, lang) {
  return labels(value, lang) || labels(fallback, lang);
}

function displayPoint(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!isFinite(lon) || !isFinite(lat)) return null;
  return { type: 'Point', coordinates: [round7(lon), round7(lat)] };
}

// Normalise anything polygon-shaped into a well-formed, correctly wound
// Polygon geometry. Accepts a bare ring, a list of rings, or a geometry object.
function polygonGeometry(input) {
  if (!input) return null;

  if (input.type === 'Polygon' && Array.isArray(input.coordinates)) {
    return polygonGeometry(input.coordinates);
  }
  if (input.type === 'MultiPolygon' && Array.isArray(input.coordinates)) {
    const polys = input.coordinates
      .map((rings) => polygonGeometry(rings))
      .filter(Boolean)
      .map((g) => g.coordinates);
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }

  if (!Array.isArray(input) || input.length === 0) return null;

  // A bare ring: [[lon, lat], ...]
  const isBareRing = Array.isArray(input[0]) && typeof input[0][0] === 'number';
  const rings = isBareRing ? [input] : input;

  const cleaned = [];
  rings.forEach((ring, index) => {
    if (!Array.isArray(ring) || ring.length < 3) return;
    const positions = ring
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => isFinite(p[0]) && isFinite(p[1]));
    if (positions.length < 3) return;
    const wound = toCounterClockwise(positions);
    // Interior rings wind the opposite way to the exterior ring.
    cleaned.push(index === 0 ? wound : wound.slice().reverse());
  });

  return cleaned.length ? { type: 'Polygon', coordinates: cleaned } : null;
}

function lineGeometry(input) {
  if (!input) return null;
  if (input.type === 'LineString' && Array.isArray(input.coordinates)) {
    return lineGeometry(input.coordinates);
  }
  if (!Array.isArray(input) || input.length < 2) return null;
  const positions = input
    .map((p) => [Number(p[0]), Number(p[1])])
    .filter((p) => isFinite(p[0]) && isFinite(p[1]));
  return positions.length >= 2 ? { type: 'LineString', coordinates: positions } : null;
}

// Every lon/lat position inside a geometry — used to derive the venue, building
// and level extents from whatever has actually been drawn.
function positionsOf(geometry) {
  if (!geometry || !geometry.coordinates) return [];
  const out = [];
  (function walk(node) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0], node[1]]);
      return;
    }
    node.forEach(walk);
  })(geometry.coordinates);
  return out;
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

function emptyCollection() {
  return featureCollection([]);
}

function generateIMDFFiles(projectData) {
  const {
    venue = {},
    building = {},
    address = null,
    levels = [],
    units = [],
    amenities = [],
    fixtures = [],
    openings = [],
    anchors = [],
    language = 'en'
  } = projectData || {};

  const venueId = venue.id || randomUUID();
  const buildingId = building.id || randomUUID();
  const addressId = (address && address.id) || randomUUID();
  const hasAddress = !!(address && (address.address || address.locality || address.country));

  // ── Geometry, bottom-up ────────────────────────────────────────
  // Units define the level extents, levels define the building footprint, and
  // the footprint defines the venue boundary. That ordering is what makes the
  // IMDF "within" rules hold without asking the user to trace four outlines.

  const unitGeometries = units.map((unit) => polygonGeometry(unit.coordinates));
  const openingGeometries = openings.map((o) => lineGeometry(o.coordinates));

  const positionsByLevel = new Map();
  const addPositions = (levelId, positions) => {
    if (!levelId || !positions.length) return;
    const list = positionsByLevel.get(levelId) || [];
    positionsByLevel.set(levelId, list.concat(positions));
  };

  units.forEach((unit, i) => addPositions(unit.levelId || unit.level_id, positionsOf(unitGeometries[i])));
  openings.forEach((o, i) => addPositions(o.levelId || o.level_id, positionsOf(openingGeometries[i])));

  const allPositions = [];
  positionsByLevel.forEach((list) => allPositions.push(...list));
  amenities.forEach((a) => {
    const dp = displayPoint(a.coordinates);
    if (dp) allPositions.push(dp.coordinates);
  });

  const refLat = allPositions.length
    ? allPositions.reduce((sum, p) => sum + p[1], 0) / allPositions.length
    : (displayPoint(venue.coordinates) ? venue.coordinates[1] : 0);

  // Fixtures are drawn as lines in the editor but IMDF requires polygons.
  const fixtureGeometries = fixtures.map((f) => {
    const asPolygon = polygonGeometry(f.coordinates);
    if (asPolygon) return asPolygon;
    const line = lineGeometry(f.coordinates);
    if (!line) return null;
    const ring = bufferLine(line.coordinates, f.widthMetres || 0.2, refLat);
    return ring ? { type: 'Polygon', coordinates: [ring] } : null;
  });
  fixtures.forEach((f, i) => addPositions(f.levelId || f.level_id, positionsOf(fixtureGeometries[i])));

  const levelGeometries = levels.map((level) => {
    const explicit = polygonGeometry(level.coordinates);
    if (explicit) return explicit;
    const ring = boundingRing(positionsByLevel.get(level.id) || [], 2, refLat);
    return ring ? { type: 'Polygon', coordinates: [ring] } : null;
  });

  const levelPositions = [];
  levelGeometries.forEach((g) => levelPositions.push(...positionsOf(g)));

  // The footprint is the physical extent of the building. The old exporter left
  // footprint.geojson empty and put a placeholder polygon on the building
  // instead — exactly backwards, and the cause of issue #25.
  const footprintGeometry =
    polygonGeometry(building.footprint) ||
    polygonGeometry(building.coordinates) ||
    (() => {
      const ring = boundingRing(levelPositions.length ? levelPositions : allPositions, 3, refLat);
      return ring ? { type: 'Polygon', coordinates: [ring] } : null;
    })();

  const venueGeometry =
    polygonGeometry(venue.boundary) ||
    (() => {
      const source = positionsOf(footprintGeometry);
      const ring = boundingRing(source.length ? source : allPositions, 10, refLat);
      return ring ? { type: 'Polygon', coordinates: [ring] } : null;
    })();

  const venuePoint =
    displayPoint(venue.coordinates) ||
    (venueGeometry ? displayPoint(centroidOfRing(venueGeometry.coordinates[0])) : null);

  const buildingPoint =
    displayPoint(building.display_point) ||
    (footprintGeometry ? displayPoint(centroidOfRing(footprintGeometry.coordinates[0])) : venuePoint);

  // ── Feature collections ────────────────────────────────────────

  const venueFeatures = featureCollection(
    venueGeometry
      ? [
          {
            id: venueId,
            type: 'Feature',
            feature_type: 'venue',
            geometry: venueGeometry,
            properties: {
              category: venue.category || 'businesscampus',
              restriction: venue.restriction || null,
              name: requiredLabels(venue.name, 'Venue', language),
              alt_name: labels(venue.alt_name, language),
              hours: venue.hours || null,
              phone: venue.phone || null,
              website: venue.website || null,
              display_point: venuePoint,
              address_id: hasAddress ? addressId : null
            }
          }
        ]
      : []
  );

  // IMDF building features are "unlocated": geometry MUST be null and the
  // extent lives on the footprint.
  const buildingFeatures = featureCollection([
    {
      id: buildingId,
      type: 'Feature',
      feature_type: 'building',
      geometry: null,
      properties: {
        category: building.category || 'unspecified',
        restriction: building.restriction || null,
        name: requiredLabels(building.name, 'Building', language),
        alt_name: labels(building.alt_name, language),
        display_point: buildingPoint,
        address_id: hasAddress ? addressId : null
      }
    }
  ]);

  const footprintFeatures = featureCollection(
    footprintGeometry
      ? [
          {
            id: building.footprintId || randomUUID(),
            type: 'Feature',
            feature_type: 'footprint',
            geometry: footprintGeometry,
            properties: {
              category: building.footprintCategory || 'ground',
              name: requiredLabels(building.name, 'Building', language),
              building_ids: [buildingId]
            }
          }
        ]
      : []
  );

  const levelFeatures = featureCollection(
    levels
      .map((level, i) => {
        const geometry = levelGeometries[i];
        if (!geometry) return null;
        const ordinal = Number.isFinite(Number(level.ordinal)) ? Number(level.ordinal) : 0;
        return {
          id: level.id || randomUUID(),
          type: 'Feature',
          feature_type: 'level',
          geometry,
          properties: {
            category: level.category || 'unspecified',
            restriction: level.restriction || null,
            outdoor: level.outdoor === true,
            ordinal,
            name: requiredLabels(level.name, `Level ${ordinal}`, language),
            short_name: requiredLabels(level.short_name, String(ordinal), language),
            display_point: displayPoint(level.display_point) || displayPoint(centroidOfRing(geometry.coordinates[0])),
            address_id: null,
            building_ids: [buildingId]
          }
        };
      })
      .filter(Boolean)
  );

  const unitFeatures = featureCollection(
    units
      .map((unit, i) => {
        const geometry = unitGeometries[i];
        if (!geometry) return null;
        const feature = {
          id: unit.id || randomUUID(),
          type: 'Feature',
          feature_type: 'unit',
          geometry,
          properties: {
            category: unit.category || 'nonpublic',
            restriction: unit.restriction || null,
            accessibility: unit.accessibility && unit.accessibility.length ? unit.accessibility : null,
            name: labels(unit.name, language),
            alt_name: labels(unit.alt_name, language),
            display_point:
              displayPoint(unit.display_point) || displayPoint(centroidOfRing(geometry.coordinates[0])),
            level_id: unit.levelId || unit.level_id || null
          }
        };
        // Microsoft Places matches rooms to Exchange resource mailboxes on this
        // key; it is an IMDF extension, not part of the base spec.
        if (unit.exchangeId) {
          feature.properties.exchange_id = unit.exchangeId;
        }
        return feature;
      })
      .filter(Boolean)
  );

  const amenityFeatures = featureCollection(
    amenities
      .map((amenity) => {
        const point = displayPoint(amenity.coordinates);
        if (!point) return null;
        const unitIds = amenity.unitIds || amenity.unit_ids || (amenity.unitId ? [amenity.unitId] : []);
        return {
          id: amenity.id || randomUUID(),
          type: 'Feature',
          feature_type: 'amenity',
          geometry: point,
          properties: {
            category: amenity.category || 'unspecified',
            accessibility: amenity.accessibility && amenity.accessibility.length ? amenity.accessibility : null,
            name: labels(amenity.name, language),
            alt_name: labels(amenity.alt_name, language),
            hours: amenity.hours || null,
            phone: amenity.phone || null,
            website: amenity.website || null,
            address_id: null,
            unit_ids: unitIds
          }
        };
      })
      .filter(Boolean)
  );

  const fixtureFeatures = featureCollection(
    fixtures
      .map((fixture, i) => {
        const geometry = fixtureGeometries[i];
        if (!geometry) return null;
        return {
          id: fixture.id || randomUUID(),
          type: 'Feature',
          feature_type: 'fixture',
          geometry,
          properties: {
            category: fixture.category || 'wall',
            restriction: fixture.restriction || null,
            name: labels(fixture.name, language),
            alt_name: labels(fixture.alt_name, language),
            display_point: displayPoint(centroidOfRing(geometry.coordinates[0])),
            level_id: fixture.levelId || fixture.level_id || null
          }
        };
      })
      .filter(Boolean)
  );

  const openingFeatures = featureCollection(
    openings
      .map((opening, i) => {
        const geometry = openingGeometries[i];
        if (!geometry) return null;
        return {
          id: opening.id || randomUUID(),
          type: 'Feature',
          feature_type: 'opening',
          geometry,
          properties: {
            category: opening.category || 'pedestrian',
            accessibility: opening.accessibility && opening.accessibility.length ? opening.accessibility : null,
            access_control: opening.access_control || null,
            door: opening.door || null,
            name: labels(opening.name, language),
            alt_name: labels(opening.alt_name, language),
            level_id: opening.levelId || opening.level_id || null
          }
        };
      })
      .filter(Boolean)
  );

  const anchorFeatures = featureCollection(
    anchors
      .map((anchor) => {
        const point = displayPoint(anchor.coordinates);
        if (!point) return null;
        return {
          id: anchor.id || randomUUID(),
          type: 'Feature',
          feature_type: 'anchor',
          geometry: point,
          properties: {
            address_id: hasAddress ? addressId : null,
            unit_id: anchor.unitId || anchor.unit_id || null
          }
        };
      })
      .filter(Boolean)
  );

  const addressFeatures = featureCollection(
    hasAddress
      ? [
          {
            id: addressId,
            type: 'Feature',
            feature_type: 'address',
            geometry: null,
            properties: {
              address: address.address || null,
              unit: address.unit || null,
              locality: address.locality || null,
              province: address.province || null,
              country: address.country || null,
              postal_code: address.postal_code || null,
              postal_code_ext: address.postal_code_ext || null,
              postal_code_vanity: address.postal_code_vanity || null
            }
          }
        ]
      : []
  );

  const manifest = {
    version: '1.0.0',
    created: new Date().toISOString(),
    language,
    generated_by: 'IMDF Builder for Places',
    extensions: []
  };

  return {
    'manifest.json': manifest,
    'address.geojson': addressFeatures,
    'venue.geojson': venueFeatures,
    'building.geojson': buildingFeatures,
    'footprint.geojson': footprintFeatures,
    'level.geojson': levelFeatures,
    'unit.geojson': unitFeatures,
    'amenity.geojson': amenityFeatures,
    'fixture.geojson': fixtureFeatures,
    'opening.geojson': openingFeatures,
    'anchor.geojson': anchorFeatures,
    'detail.geojson': emptyCollection(),
    'kiosk.geojson': emptyCollection(),
    'occupant.geojson': emptyCollection(),
    'relationship.geojson': emptyCollection(),
    'section.geojson': emptyCollection()
  };
}

module.exports = {
  generateIMDFFiles,
  labels,
  polygonGeometry,
  lineGeometry,
  positionsOf
};
