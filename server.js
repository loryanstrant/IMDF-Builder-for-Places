const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const LOCAL_COORDINATE_SCALE = 0.05;
const DEFAULT_FOOTPRINT_SIZE = 0.001;
const FOOTPRINT_PADDING = 0.00005;

// Rate limiters
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Keep accidental loops bounded without blocking normal local testing
  message: { error: 'Too many upload requests, please try again later.' }
});

const projectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 project requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));

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
    const id = projectId ? validateProjectId(projectId) : uuidv4();
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
    
    const archive = archiver('zip', { zlib: { level: 9 } });
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

// Helper function to generate IMDF files
function generateIMDFFiles(projectData) {
  const {
    venue,
    building,
    levels = [],
    units = [],
    fixtures = [],
  } = projectData;

  const buildingId = building?.id || uuidv4();
  const footprintId = building?.footprintId || uuidv4();
  const localBounds = getLocalBounds({ building, levels, units, fixtures });
  const footprintCoordinates = createFootprintCoordinates(venue?.coordinates, localBounds);

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
        name: building?.name || 'Building',
        alt_name: building?.alt_name || {}
      }
    }]
  };

  const footprintFeatures = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: footprintId,
      feature_type: 'footprint',
      geometry: {
        type: 'Polygon',
        coordinates: footprintCoordinates
      },
      properties: {
        category: 'building',
        building: buildingId
      }
    }]
  };

  const levelFeatures = {
    type: 'FeatureCollection',
    features: levels.map(level => ({
      type: 'Feature',
      id: level.id || uuidv4(),
      feature_type: 'level',
      geometry: {
        type: 'Polygon',
        coordinates: isLocalCanvasPolygon(level.coordinates)
          ? footprintCoordinates
          : normalizePolygonCoordinates(level.coordinates, venue?.coordinates, localBounds)
      },
      properties: {
        ordinal: level.ordinal ?? 0,
        category: 'unspecified',
        restriction: 'restricted',
        name: level.name || `Level ${level.ordinal}`,
        short_name: level.short_name || level.ordinal?.toString() || '0',
        building: buildingId
      }
    }))
  };

  const unitFeatures = {
    type: 'FeatureCollection',
    features: units.map(unit => ({
      type: 'Feature',
      id: unit.id || uuidv4(),
      feature_type: 'unit',
      geometry: {
        type: 'Polygon',
        coordinates: normalizePolygonCoordinates(unit.coordinates, venue?.coordinates, localBounds)
      },
      properties: {
        category: unit.category || 'unspecified',
        restriction: unit.restriction || 'restricted',
        accessibility: unit.accessibility || [],
        name: unit.name || 'Unit',
        alt_name: unit.alt_name || {},
        display_point: normalizeDisplayPoint(unit.display_point, venue?.coordinates, localBounds),
        level: unit.levelId
      }
    }))
  };

  const fixtureFeatures = {
    type: 'FeatureCollection',
    features: fixtures
      .filter(fixture => fixture.geometryType === 'Polygon' || fixture.geometryType === 'MultiPolygon')
      .map(fixture => ({
        type: 'Feature',
        id: fixture.id || uuidv4(),
        feature_type: 'fixture',
        geometry: {
          type: fixture.geometryType,
          coordinates: fixture.geometryType === 'MultiPolygon'
            ? fixture.coordinates
            : normalizePolygonCoordinates(fixture.coordinates, venue?.coordinates, localBounds)
        },
        properties: {
          category: fixture.category || 'furniture',
          level: fixture.levelId
        }
      }))
  };

  const sectionFeatures = {
    type: 'FeatureCollection',
    features: []
  };

  return {
    'building.geojson': buildingFeatures,
    'footprint.geojson': footprintFeatures,
    'level.geojson': levelFeatures,
    'unit.geojson': unitFeatures,
    'section.geojson': sectionFeatures,
    'fixture.geojson': fixtureFeatures
  };
}

function normalizePolygonCoordinates(coordinates, venueCoordinates, localBounds) {
  if (isValidPolygonCoordinates(coordinates)) {
    return isLocalCanvasPolygon(coordinates)
      ? translateLocalPolygonToVenue(coordinates, venueCoordinates, localBounds)
      : coordinates;
  }

  return createFootprintCoordinates(venueCoordinates, localBounds);
}

function normalizeDisplayPoint(displayPoint, venueCoordinates, localBounds) {
  const coordinates = displayPoint?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) {
    return {
      type: 'Point',
      coordinates: getVenueLonLat(venueCoordinates)
    };
  }

  return {
    type: 'Point',
    coordinates: isLocalCanvasCoordinate(coordinates)
      ? translateLocalCoordinateToVenue(coordinates, venueCoordinates, localBounds)
      : coordinates
  };
}

function isValidPolygonCoordinates(coordinates) {
  return Array.isArray(coordinates)
    && Array.isArray(coordinates[0])
    && Array.isArray(coordinates[0][0])
    && coordinates[0].length >= 4;
}

function isLocalCanvasPolygon(coordinates) {
  if (!isValidPolygonCoordinates(coordinates)) {
    return false;
  }

  return coordinates.flat(2).every(value => typeof value === 'number' && value >= 0 && value < 1);
}

function isLocalCanvasCoordinate(coordinates) {
  if (!Array.isArray(coordinates)) {
    return false;
  }

  return coordinates.every(value => typeof value === 'number' && value >= 0 && value < 1);
}

function translateLocalPolygonToVenue(coordinates, venueCoordinates, localBounds) {
  return coordinates.map(ring => ring.map(point => translateLocalCoordinateToVenue(point, venueCoordinates, localBounds)));
}

function translateLocalCoordinateToVenue(coordinates, venueCoordinates, localBounds) {
  const [originLon, originLat] = getVenueLonLat(venueCoordinates);
  const minX = localBounds?.minX ?? 0;
  const minY = localBounds?.minY ?? 0;

  return [
    originLon + ((coordinates[0] - minX) * LOCAL_COORDINATE_SCALE),
    originLat + ((coordinates[1] - minY) * LOCAL_COORDINATE_SCALE)
  ];
}

function getVenueLonLat(venueCoordinates) {
  if (!Array.isArray(venueCoordinates) || venueCoordinates.length !== 2) {
    return [0, 0];
  }

  const [lat, lon] = venueCoordinates;
  return [lon, lat];
}

function createFootprintCoordinates(venueCoordinates, localBounds) {
  const [lon, lat] = getVenueLonLat(venueCoordinates);
  if (!localBounds) {
    return createDefaultFootprint(lon, lat);
  }

  const width = Math.max(
    (localBounds.maxX - localBounds.minX) * LOCAL_COORDINATE_SCALE,
    DEFAULT_FOOTPRINT_SIZE
  );
  const height = Math.max(
    (localBounds.maxY - localBounds.minY) * LOCAL_COORDINATE_SCALE,
    DEFAULT_FOOTPRINT_SIZE
  );

  return [[
    [lon - FOOTPRINT_PADDING, lat - FOOTPRINT_PADDING],
    [lon - FOOTPRINT_PADDING, lat + height + FOOTPRINT_PADDING],
    [lon + width + FOOTPRINT_PADDING, lat + height + FOOTPRINT_PADDING],
    [lon + width + FOOTPRINT_PADDING, lat - FOOTPRINT_PADDING],
    [lon - FOOTPRINT_PADDING, lat - FOOTPRINT_PADDING]
  ]];
}

function createDefaultFootprint(lon, lat) {
  return [[
    [lon, lat],
    [lon, lat + DEFAULT_FOOTPRINT_SIZE],
    [lon + DEFAULT_FOOTPRINT_SIZE, lat + DEFAULT_FOOTPRINT_SIZE],
    [lon + DEFAULT_FOOTPRINT_SIZE, lat],
    [lon, lat]
  ]];
}

function getLocalBounds({ building, levels, units, fixtures }) {
  const points = [];
  collectLocalPolygonPoints(building?.coordinates, points);
  levels.forEach(level => collectLocalPolygonPoints(level.coordinates, points));
  units.forEach(unit => collectLocalPolygonPoints(unit.coordinates, points));
  fixtures.forEach(fixture => collectLocalPolygonPoints(fixture.coordinates, points));

  if (points.length === 0) {
    return null;
  }

  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxX: Math.max(bounds.maxX, point[0]),
    maxY: Math.max(bounds.maxY, point[1])
  }), {
    minX: points[0][0],
    minY: points[0][1],
    maxX: points[0][0],
    maxY: points[0][1]
  });
}

function collectLocalPolygonPoints(coordinates, points) {
  if (!isValidPolygonCoordinates(coordinates) || !isLocalCanvasPolygon(coordinates)) {
    return;
  }

  coordinates.forEach(ring => {
    ring.forEach(point => points.push(point));
  });
}

// Start server
ensureDirectories().then(() => {
  app.listen(PORT, () => {
    console.log(`IMDF Builder server running on http://localhost:${PORT}`);
  });
});
