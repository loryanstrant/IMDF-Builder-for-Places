const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

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
    amenities = [],
    fixtures = [],
    openings = [],
    anchors = []
  } = projectData;

  const venueId = venue?.id || uuidv4();
  const buildingId = building?.id || uuidv4();

  // Generate venue.geojson
  const venueFeatures = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: venueId,
      feature_type: 'venue',
      geometry: {
        type: 'Point',
        coordinates: venue?.coordinates || [0, 0]
      },
      properties: {
        category: 'business',
        restriction: 'restricted',
        name: venue?.name || 'Venue',
        alt_name: venue?.alt_name || {}
      }
    }]
  };

  // Generate building.geojson
  const buildingFeatures = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: buildingId,
      feature_type: 'building',
      geometry: {
        type: 'Polygon',
        coordinates: building?.coordinates || [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
      },
      properties: {
        category: 'unspecified',
        restriction: 'restricted',
        name: building?.name || 'Building',
        alt_name: building?.alt_name || {}
      }
    }]
  };

  // Generate level.geojson
  const levelFeatures = {
    type: 'FeatureCollection',
    features: levels.map(level => ({
      type: 'Feature',
      id: level.id || uuidv4(),
      feature_type: 'level',
      geometry: {
        type: 'Polygon',
        coordinates: level.coordinates || [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
      },
      properties: {
        ordinal: level.ordinal || 0,
        category: 'unspecified',
        restriction: 'restricted',
        name: level.name || `Level ${level.ordinal}`,
        short_name: level.short_name || level.ordinal?.toString() || '0',
        building: buildingId
      }
    }))
  };

  // Generate unit.geojson
  const unitFeatures = {
    type: 'FeatureCollection',
    features: units.map(unit => ({
      type: 'Feature',
      id: unit.id || uuidv4(),
      feature_type: 'unit',
      geometry: {
        type: 'Polygon',
        coordinates: unit.coordinates || [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]]
      },
      properties: {
        category: unit.category || 'unspecified',
        restriction: unit.restriction || 'restricted',
        accessibility: unit.accessibility || [],
        name: unit.name || 'Unit',
        alt_name: unit.alt_name || {},
        display_point: unit.display_point || { type: 'Point', coordinates: [0, 0] },
        level: unit.levelId
      }
    }))
  };

  // Generate amenity.geojson
  const amenityFeatures = {
    type: 'FeatureCollection',
    features: amenities.map(amenity => ({
      type: 'Feature',
      id: amenity.id || uuidv4(),
      feature_type: 'amenity',
      geometry: {
        type: 'Point',
        coordinates: amenity.coordinates || [0, 0]
      },
      properties: {
        category: amenity.category || 'seating',
        accessibility: amenity.accessibility || [],
        name: amenity.name || 'Amenity',
        alt_name: amenity.alt_name || {},
        unit: amenity.unitId,
        level: amenity.levelId
      }
    }))
  };

  // Generate fixture.geojson
  const fixtureFeatures = {
    type: 'FeatureCollection',
    features: fixtures.map(fixture => ({
      type: 'Feature',
      id: fixture.id || uuidv4(),
      feature_type: 'fixture',
      geometry: {
        type: fixture.geometryType || 'Point',
        coordinates: fixture.coordinates || [0, 0]
      },
      properties: {
        category: fixture.category || 'wall',
        level: fixture.levelId
      }
    }))
  };

  // Generate opening.geojson
  const openingFeatures = {
    type: 'FeatureCollection',
    features: openings.map(opening => ({
      type: 'Feature',
      id: opening.id || uuidv4(),
      feature_type: 'opening',
      geometry: {
        type: 'LineString',
        coordinates: opening.coordinates || [[0, 0], [0, 1]]
      },
      properties: {
        category: opening.category || 'door',
        accessibility: opening.accessibility || [],
        door: opening.door || 'no',
        level: opening.levelId
      }
    }))
  };

  // Generate anchor.geojson
  const anchorFeatures = {
    type: 'FeatureCollection',
    features: anchors.map(anchor => ({
      type: 'Feature',
      id: anchor.id || uuidv4(),
      feature_type: 'anchor',
      geometry: {
        type: 'Point',
        coordinates: anchor.coordinates || [0, 0]
      },
      properties: {
        unit: anchor.unitId,
        address: anchor.address || {}
      }
    }))
  };

  // Generate empty collections for other required files
  const emptyCollection = {
    type: 'FeatureCollection',
    features: []
  };

  // Generate manifest.json
  const manifest = {
    version: '1.0.0',
    language: 'en',
    created: new Date().toISOString(),
    updated: new Date().toISOString()
  };

  return {
    'venue.geojson': venueFeatures,
    'building.geojson': buildingFeatures,
    'level.geojson': levelFeatures,
    'unit.geojson': unitFeatures,
    'amenity.geojson': amenityFeatures,
    'fixture.geojson': fixtureFeatures,
    'opening.geojson': openingFeatures,
    'anchor.geojson': anchorFeatures,
    'address.geojson': emptyCollection,
    'detail.geojson': emptyCollection,
    'footprint.geojson': emptyCollection,
    'geojson-spec.geojson': emptyCollection,
    'kiosk.geojson': emptyCollection,
    'occupant.geojson': emptyCollection,
    'relationship.geojson': emptyCollection,
    'section.geojson': emptyCollection,
    'manifest.json': manifest
  };
}

// Start server
ensureDirectories().then(() => {
  app.listen(PORT, () => {
    console.log(`IMDF Builder server running on http://localhost:${PORT}`);
  });
});
