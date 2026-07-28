const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');
// archiver v8+ is ESM-only (loaded via dynamic import) and replaced the
// archiver('zip', opts) factory with exported classes like ZipArchive
const zipArchivePromise = import('archiver').then((mod) => mod.ZipArchive);
const rateLimit = require('express-rate-limit');
const { version } = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiters
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 upload requests per windowMs
  message: 'Too many upload requests, please try again later.'
});

const projectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 project requests per windowMs
  message: 'Too many requests, please try again later.'
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Create directories if they don't exist
const ensureDirectories = async () => {
  const dirs = ['uploads', 'projects'];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.log(`Directory ${dir} already exists or error:`, err.message);
    }
  }
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, and PDF are allowed.'));
    }
  }
});

// Helper function to validate and sanitize project ID
function validateProjectId(id) {
  // Only allow alphanumeric characters and hyphens (UUID format)
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error('Invalid project ID format');
  }
  // Additional length check (UUIDs are 36 characters with hyphens)
  if (id.length > 50) {
    throw new Error('Invalid project ID length');
  }
  return id;
}

// Helper function to safely construct and validate project file path
function getProjectFilePath(id) {
  const validatedId = validateProjectId(id);
  const filename = `${validatedId}.json`;
  const filepath = path.join('projects', filename);
  
  // Resolve to absolute path and ensure it's within the projects directory
  const resolvedPath = path.resolve(filepath);
  const projectsDir = path.resolve('projects');
  
  if (!resolvedPath.startsWith(projectsDir)) {
    throw new Error('Invalid project path');
  }
  
  return filepath;
}

// Routes

// App version (single source of truth for the header credit line)
app.get('/api/version', (req, res) => {
  res.json({ version });
});

// Upload floor plan
app.post('/api/upload', uploadLimiter, upload.single('floorplan'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      success: true,
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Save project
app.post('/api/projects/save', projectLimiter, async (req, res) => {
  try {
    const { projectId, projectName, projectData } = req.body;
    const id = projectId ? validateProjectId(projectId) : randomUUID();
    const filepath = getProjectFilePath(id);
    
    const project = {
      id,
      name: projectName,
      createdAt: projectData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: projectData
    };

    await fs.writeFile(filepath, JSON.stringify(project, null, 2));
    res.json({ success: true, projectId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Load project
app.get('/api/projects/:id', projectLimiter, async (req, res) => {
  try {
    const filepath = getProjectFilePath(req.params.id);
    const data = await fs.readFile(filepath, 'utf-8');
    res.json(JSON.parse(data));
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.status(404).json({ error: 'Project not found' });
    } else if (error.message === 'Invalid project ID format' || error.message === 'Invalid project path' || error.message === 'Invalid project ID length') {
      res.status(400).json({ error: 'Invalid project ID' });
    } else {
      res.status(500).json({ error: 'Error loading project' });
    }
  }
});

// List projects
app.get('/api/projects', projectLimiter, async (req, res) => {
  try {
    const files = await fs.readdir('projects');
    const projects = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join('projects', file), 'utf-8');
        const project = JSON.parse(data);
        projects.push({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt
        });
      }
    }
    
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate and download IMDF files
app.post('/api/generate-imdf', projectLimiter, async (req, res) => {
  try {
    const { projectData } = req.body;
    
    // Generate IMDF files
    const imdfFiles = generateIMDFFiles(projectData);
    
    // Create a ZIP file
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=imdf-export.zip');
    
    const ZipArchive = await zipArchivePromise;
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.pipe(res);
    
    // Add each IMDF file to the archive
    for (const [filename, content] of Object.entries(imdfFiles)) {
      archive.append(JSON.stringify(content, null, 2), { name: filename });
    }
    
    await archive.finalize();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate the Microsoft Places correlations CSV (mapfeatures.csv) matching
// the exported IMDF package, replacing Import-MapCorrelations' extract pass.
app.post('/api/generate-mapfeatures', projectLimiter, async (req, res) => {
  try {
    const { projectData } = req.body;
    const csv = generateMapFeaturesCSV(projectData);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=mapfeatures.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IMDF "name"-type fields are localised label dictionaries ({"en": "Lobby"}),
// not plain strings — Microsoft Places rejects the package otherwise.
function toLabels(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0 ? value : null;
  }
  return { en: String(value) };
}

// The venue coordinates field in the UI collects "Lat, Lon", but GeoJSON is
// [longitude, latitude]. Swap, unless the first value can't be a latitude.
function getVenueOrigin(venue) {
  const coords = venue?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const a = Number(coords[0]);
  const b = Number(coords[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  return Math.abs(a) > 90 ? { lon: a, lat: b } : { lon: b, lat: a };
}

// GeoJSON exterior rings should wind counterclockwise (right-hand rule).
function ensureCounterclockwise(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  }
  return area > 0 ? ring.slice().reverse() : ring;
}

// Helper function to generate IMDF files
function generateIMDFFiles(projectData) {
  const {
    venue,
    building,
    levels = [],
    units = [],
    fixtures = []
  } = projectData;

  const buildingId = building?.id || randomUUID();
  const origin = getVenueOrigin(venue);

  // Sections (desk pools) ride in the units array flagged featureType:
  // 'section' and export to their own file — Places locates bookable desks
  // through their parent Section correlated to a section feature.
  const sections = units.filter(u => u.featureType === 'section');
  const roomUnits = units.filter(u => u.featureType !== 'section');

  // The canvas produces tiny coordinates near [0, 0] (pixels / 100000, in
  // degrees). Microsoft Places requires georeferenced geometry, so shift the
  // whole drawing onto the venue's real location by centring its bounding box
  // there. Canvas y grows downward, so it's flipped onto latitude.
  const rings = [];
  for (const unit of units) {
    for (const ring of unit.coordinates || []) rings.push(ring);
  }
  if (rings.length === 0 && building?.coordinates) {
    for (const ring of building.coordinates) rings.push(ring);
  }
  if (rings.length === 0) {
    rings.push([[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const projectPoint = ([x, y]) => (origin
    ? [origin.lon + (x - centerX), origin.lat - (y - centerY)]
    : [x, y]);
  const projectPolygon = polygon => polygon.map((ring, i) => {
    const projected = ring.map(projectPoint);
    return i === 0 ? ensureCounterclockwise(projected) : projected;
  });

  // Footprint = drawing bounding box plus a margin, so every unit falls inside it.
  const padX = Math.max((maxX - minX) * 0.1, 0.00005);
  const padY = Math.max((maxY - minY) * 0.1, 0.00005);
  const footprintPolygon = projectPolygon([[
    [minX - padX, minY - padY],
    [minX - padX, maxY + padY],
    [maxX + padX, maxY + padY],
    [maxX + padX, minY - padY],
    [minX - padX, minY - padY]
  ]]);

  // Generate building.geojson — Microsoft Places requires building geometry to be null;
  // the building outline goes in footprint.geojson instead.
  const buildingFeatures = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: buildingId,
      feature_type: 'building',
      geometry: null,
      properties: {
        category: 'unspecified',
        restriction: 'restricted',
        name: toLabels(building?.name || venue?.name || 'Building'),
        alt_name: toLabels(building?.alt_name),
        display_point: {
          type: 'Point',
          coordinates: projectPoint([centerX, centerY])
        }
      }
    }]
  };

  // Generate footprint.geojson — required by Microsoft Places; outline of the building.
  const footprintFeatures = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      // Stable across exports (persisted with the project) so a filled-in
      // Places correlations CSV keeps matching regenerated packages.
      id: building?.footprintId || randomUUID(),
      feature_type: 'footprint',
      geometry: {
        type: 'Polygon',
        coordinates: footprintPolygon
      },
      properties: {
        category: 'ground',
        name: null,
        building_ids: [buildingId]
      }
    }]
  };

  // Generate level.geojson — each floor spans the building footprint (the
  // canvas drawing has no real per-level outline of its own).
  const levelFeatures = {
    type: 'FeatureCollection',
    features: levels.map(level => ({
      type: 'Feature',
      id: level.id || randomUUID(),
      feature_type: 'level',
      geometry: {
        type: 'Polygon',
        coordinates: footprintPolygon
      },
      properties: {
        ordinal: level.ordinal || 0,
        category: 'unspecified',
        restriction: 'restricted',
        outdoor: false,
        name: toLabels(level.name || `Level ${level.ordinal}`),
        short_name: toLabels(level.short_name || level.ordinal?.toString() || '0'),
        building_ids: [buildingId]
      }
    }))
  };

  // Units and sections share a shape; only the feature_type and file differ.
  const drawnFeature = (unit, featureType) => ({
    type: 'Feature',
    id: unit.id || randomUUID(),
    feature_type: featureType,
    geometry: {
      type: 'Polygon',
      coordinates: projectPolygon(unit.coordinates || [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]])
    },
    properties: {
      category: unit.category || 'unspecified',
      // Default to unrestricted: "restricted" marks the room off-limits in Places.
      restriction: unit.restriction || null,
      name: toLabels(unit.name || 'Unit'),
      alt_name: toLabels(unit.alt_name),
      display_point: {
        type: 'Point',
        coordinates: projectPoint(unit.display_point?.coordinates || [centerX, centerY])
      },
      level_id: unit.levelId || null
    }
  });

  const unitFeatures = {
    type: 'FeatureCollection',
    features: roomUnits.map(u => drawnFeature(u, 'unit'))
  };

  const sectionFeatures = {
    type: 'FeatureCollection',
    features: sections.map(s => drawnFeature(s, 'section'))
  };

  // Generate fixture.geojson
  const fixtureFeatures = {
    type: 'FeatureCollection',
    features: fixtures.map(fixture => ({
      type: 'Feature',
      id: fixture.id || randomUUID(),
      feature_type: 'fixture',
      geometry: (fixture.geometryType || 'Point') === 'Point'
        ? { type: 'Point', coordinates: projectPoint(fixture.coordinates || [centerX, centerY]) }
        : { type: fixture.geometryType, coordinates: projectPolygon(fixture.coordinates || []) },
      properties: {
        category: fixture.category || 'wall',
        name: null,
        level_id: fixture.levelId || null
      }
    }))
  };

  // Microsoft Places accepts only these files in the IMDF package and rejects the
  // upload with "Import not supported for file <name>" for anything it doesn't
  // recognise, so the export is limited to the supported set:
  // building/footprint/level/unit (required) plus fixture/section (optional).
  const files = {
    'building.geojson': buildingFeatures,
    'footprint.geojson': footprintFeatures,
    'level.geojson': levelFeatures,
    'unit.geojson': unitFeatures
  };

  if (sections.length > 0) {
    files['section.geojson'] = sectionFeatures;
  }
  if (fixtures.length > 0) {
    files['fixture.geojson'] = fixtureFeatures;
  }

  validatePlacesCompatibility(files);
  return files;
}

// Microsoft Places parses IMDF with a strict, undocumented schema and reports
// violations with misleading errors (an unknown property becomes "Invalid JSON
// format ... Expected token '}' not found"). Catch those mistakes at export
// time with a clear message instead. The property lists mirror what
// Import-MapCorrelations itself emits, i.e. the set Places is known to accept.
const PLACES_FILE_ALLOWLIST = new Set([
  'building.geojson', 'footprint.geojson', 'level.geojson', 'unit.geojson',
  'section.geojson', 'fixture.geojson'
]);
const PLACES_PROPERTY_ALLOWLIST = {
  building: ['category', 'restriction', 'name', 'alt_name', 'display_point'],
  footprint: ['category', 'name', 'building_ids'],
  level: ['ordinal', 'category', 'restriction', 'outdoor', 'name', 'short_name', 'building_ids'],
  unit: ['category', 'restriction', 'name', 'alt_name', 'display_point', 'level_id'],
  section: ['category', 'restriction', 'name', 'alt_name', 'display_point', 'level_id'],
  fixture: ['category', 'name', 'level_id']
};
const LABEL_PROPERTIES = ['name', 'alt_name', 'short_name'];

function validatePlacesCompatibility(files) {
  const problems = [];

  for (const [filename, collection] of Object.entries(files)) {
    if (!PLACES_FILE_ALLOWLIST.has(filename)) {
      problems.push(`${filename}: Places rejects files outside ${[...PLACES_FILE_ALLOWLIST].join(', ')}`);
      continue;
    }

    for (const feature of collection.features) {
      const type = feature.feature_type;
      const label = `${filename} feature ${feature.id}`;
      const allowed = PLACES_PROPERTY_ALLOWLIST[type] || [];

      for (const key of Object.keys(feature.properties)) {
        if (!allowed.includes(key)) {
          problems.push(`${label}: property "${key}" is not accepted by Places for ${type}`);
        }
      }

      for (const key of LABEL_PROPERTIES) {
        const value = feature.properties[key];
        if (value !== undefined && value !== null && typeof value !== 'object') {
          problems.push(`${label}: "${key}" must be a localized label object like {"en": "..."}, not a plain string`);
        }
      }

      if (type === 'building' && feature.geometry !== null) {
        problems.push(`${label}: building geometry must be null (the outline belongs in footprint.geojson)`);
      }
      if (type === 'level') {
        if (!Number.isInteger(feature.properties.ordinal)) {
          problems.push(`${label}: level ordinal must be an integer`);
        }
        if (feature.properties.outdoor !== false) {
          problems.push(`${label}: level requires "outdoor": false`);
        }
        if (!Array.isArray(feature.properties.building_ids) || feature.properties.building_ids.length === 0) {
          problems.push(`${label}: level requires a non-empty building_ids array`);
        }
      }
      if (type === 'unit' && !feature.properties.level_id) {
        problems.push(`${label}: unit requires level_id (assign the unit to a level)`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Export is not Microsoft Places compatible:\n${problems.join('\n')}`);
  }
}

// Build the correlations CSV consumed by Import-MapCorrelations, pre-filled
// with the feature ids from the export (which is all its "extract" pass
// produces) plus any Microsoft Places directory ids entered in the builder.
// Remaining blanks: paste in the PlaceIds from
// Get-PlaceV3 -AncestorId <buildingPlaceId>.
function generateMapFeaturesCSV(projectData) {
  const files = generateIMDFFiles(projectData);
  const placeIdsByFeatureId = new Map();
  const directoryTypes = { building: 'Building', level: 'Floor', unit: 'Room', section: 'Section' };

  const buildingFeature = files['building.geojson'].features[0];
  if (projectData.building?.placeId) {
    placeIdsByFeatureId.set(buildingFeature.id, projectData.building.placeId);
  }
  for (const item of [...(projectData.levels || []), ...(projectData.units || [])]) {
    if (item.id && item.placeId) placeIdsByFeatureId.set(item.id, item.placeId);
  }

  const csvField = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const rows = [['PlaceId', 'Name', 'Type', 'FeatureType', 'FeatureId', 'FeatureName', 'FeatureCategory']];
  for (const filename of ['building.geojson', 'level.geojson', 'unit.geojson', 'section.geojson']) {
    if (!files[filename]) continue;
    for (const feature of files[filename].features) {
      const featureName = feature.properties.name?.en || '';
      const placeId = placeIdsByFeatureId.get(feature.id) || '';
      rows.push([
        placeId,
        placeId ? featureName : '',
        placeId ? directoryTypes[feature.feature_type] : '',
        feature.feature_type.charAt(0).toUpperCase() + feature.feature_type.slice(1),
        feature.id,
        featureName,
        feature.properties.category || 'unspecified'
      ]);
    }
  }

  return rows.map(row => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// Error-handling middleware — ensure API errors return JSON, never an HTML error
// page (an HTML body is what caused the "JSON.parse: unexpected character" upload
// failures reported in issue #4).
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  // Multer surfaces file-size violations with this code; its filter rejects bad types.
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large. Maximum size is 50MB.' });
  }
  console.error('Request error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start server
ensureDirectories().then(() => {
  app.listen(PORT, () => {
    console.log(`IMDF Builder server running on http://localhost:${PORT}`);
  });
});
