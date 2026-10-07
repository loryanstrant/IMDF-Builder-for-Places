# IMDF Builder for Microsoft Places

A user-friendly web application to create Indoor Mapping Data Format (IMDF) files for use with Microsoft Places. This tool provides a graphical interface for non-technical users to upload floor plans, place various indoor mapping elements, and generate standards-compliant IMDF files.

## Features

- 🖼️ **Floor Plan Upload**: Upload PDF or image files of your floor plans — multi-page PDFs can become one level per page
- 🌍 **Real Georeferencing**: Calibrate the scale from a known distance, set an anchor point and rotation, and every exported feature lands on the real world at real size
- 🔍 **Pan & Zoom**: ALT + drag to pan, mouse wheel to zoom, with keyboard shortcuts
- 🏢 **Interactive Editor**: Visual canvas-based editor for placing indoor mapping elements
- 📍 **IMDF Elements Support**:
  - Units (rooms, offices, conference rooms)
  - Amenities (desks, seating, facilities)
  - Fixtures (walls, windows)
  - Openings (doors, entrances)
  - Levels (floors)
- 💾 **Project Management**: Save and load projects for later editing
- 📦 **Export**: Generate complete, spec-conformant IMDF file packages as ZIP archives — including a real `footprint.geojson` and `address.geojson`
- 🌓 **Dark Mode**: Toggle in the header; remembers your choice and follows your OS preference
- 🐳 **Docker Support**: Easy deployment with Docker and Docker Compose


<img width="1280" height="720" alt="508439876-18132b6d-a9e5-442c-80ca-4a68871fbd1e" src="https://github.com/user-attachments/assets/d4df6899-b70f-451e-9d73-d1c2b2cf975a" />


> **New here?** [docs/USAGE.md](docs/USAGE.md) is the practical walkthrough — georeferencing,
> L-shaped rooms, Exchange IDs and a pre-export checklist.

## Quick Start

### Using Docker (Recommended)

The easiest way to run the application is using the pre-built Docker image from GitHub Container Registry:

1. **Install Docker Desktop**
   - Download from [docker.com](https://www.docker.com/products/docker-desktop)
   - Install and start Docker Desktop

2. **Run the Application**
   ```bash
   # Using Docker Compose (recommended)
   docker-compose up -d

   # Or using Docker directly
   docker run -d -p 3000:3000 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads ghcr.io/loryanstrant/imdf-builder-for-places:latest

   # The application will be available at http://localhost:3000
   ```

3. **Stop the Application**
   ```bash
   docker-compose down
   ```

**Note**: The pre-built image is automatically updated from the main branch. If you want to build locally instead, edit `docker-compose.yml` and uncomment the `build: .` line.

#### Configuration (optional)

Copy `.env.example` to `.env` (Docker Compose reads it automatically) to change:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST_PORT` | `3000` | Host port the app is published on — change it if `3000` is already taken. |
| `TZ` | `UTC` | Container timezone, any IANA name (e.g. `Australia/Sydney`). |

```bash
cp .env.example .env
# edit .env, then:
docker-compose up -d
```

### Running Locally (Without Docker)

1. **Prerequisites**
   - Node.js 18 or higher
   - npm (comes with Node.js)

2. **Installation**
   ```bash
   # Clone the repository
   git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
   cd IMDF-Builder-for-Places

   # Install dependencies
   npm install

   # Start the application
   npm start
   ```

3. **Access the Application**
   - Open your browser and navigate to `http://localhost:3000`

### Building Docker Image Locally (Optional)

If you want to build the Docker image yourself instead of using the pre-built one:

```bash
# Clone the repository
git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
cd IMDF-Builder-for-Places

# Build the Docker image
docker build -t imdf-builder .

# Run the container
docker run -d -p 3000:3000 -v $(pwd)/projects:/app/projects -v $(pwd)/uploads:/app/uploads imdf-builder

# Or edit docker-compose.yml to use 'build: .' instead of the image
```

## How to Use

### Step 1: Create a New Project
1. Enter a project name in the "Project Name" field
2. Enter your building name and venue coordinates (latitude, longitude)
3. Click "Save Project" to save your initial setup

### Step 2: Upload Floor Plan
1. Click "Choose File" in the Floor Plan section
2. Select a PDF or image file of your floor plan
3. Click "Upload" to load it onto the canvas
4. For a multi-page PDF, pick the page to trace — or click **Create one level per page**
   to turn the whole document into a stack of levels in one go

### Step 3: Georeference the Plan

Do this **before** drawing: every exported coordinate depends on it.

1. Click **⌖ Set Anchor Point** and click a feature whose real coordinates you know —
   a building corner or main entrance, *not* the middle of the building
2. Paste that feature's latitude and longitude into "Venue Coordinates"
3. Click **⟷ Calibrate from Two Points**, click the ends of something of known length
   (a scale bar, a dimension line, a 0.9 m door) and enter that length in metres
4. If the plan's "up" is not true north, enter the clockwise rotation in degrees

The readout shows `● Calibrated — 1 px = 0.0500 m` once this is done. Without it, the
export warns you and the result has no real size or position.

### Step 4: Add Levels
1. In the "Levels" section, enter a level name (e.g., "Ground Floor")
2. Enter the level number (0 for ground floor, 1 for first floor, etc.)
3. Click "Add Level"
4. Click on a level in the list to make it active for placing items

### Step 5: Place Items on the Floor Plan
1. Select a tool from the "Place Items" section:
   - **Draw Unit (Polygon)**: For any room shape — including L-shaped and irregular
     rooms. Click each corner, then click the first point again to close it; drag the
     vertex handles afterwards to adjust
   - **Place Unit (Rectangle)**: Quick rectangular rooms
   - **Place Amenity**: For desks, seating, facilities
   - **Place Fixture**: For walls, windows
   - **Place Opening**: For doors, entrances
2. Click on the canvas where you want to place the item
3. Use "Select Mode" to select and move items

**Canvas controls:**

| Control | Action |
|---|---|
| `ALT` + left-drag | Pan the floor plan |
| Mouse wheel | Zoom in/out at the cursor (0.1x &ndash; 10x) |
| `DEL` | Delete the selected item |
| `ESC` | Cancel the polygon currently being drawn |

> Items placed imprecisely? Turn off **Edge snapping** in the toolbar.

### Step 6: Edit Item Properties
1. Click "Select Mode" button
2. Click on an item on the canvas
3. Edit properties in the "Selected Item Properties" panel:
   - Change the name
   - Update the category
   - Set the **Exchange ID** — the room mailbox's primary SMTP address
     (`room-3-12@contoso.com`). This is what links the room to Microsoft Places;
     leave it blank for corridors and lobbies
4. Click "Update Properties" to save changes

### Step 7: Fill in the Address, then Export IMDF Files
1. Fill in the Address panel — IMDF requires an address, and Places uses it to place
   the venue. The country is a two-letter ISO code (`AU`, `US`, `GB`)
2. Click the "Export IMDF Files" button in the right sidebar
3. A ZIP file will be downloaded containing all required IMDF files:
   - venue.geojson
   - building.geojson (geometry is `null` by design — the shape lives in footprint)
   - footprint.geojson
   - address.geojson
   - level.geojson
   - unit.geojson
   - amenity.geojson
   - fixture.geojson
   - opening.geojson
   - anchor.geojson
   - manifest.json
   - And other required empty files

### Step 8: Upload to Microsoft Places
1. Extract the downloaded ZIP file
2. Follow Microsoft's documentation to upload the files to Microsoft Places
3. Reference: [Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places)

## IMDF Compliance

This tool generates files that comply with the IMDF (Indoor Mapping Data Format) specification as required by Microsoft Places. All generated files include:

- Proper GeoJSON structure
- Unique UUIDs for all features
- Required properties for each feature type
- WGS84 coordinate system (latitude/longitude)
- Relationships between features
- Counter-clockwise exterior rings, as RFC 7946 requires
- `name` and `alt_name` as IMDF `LABELS` objects, not bare strings
- Unlocated buildings (`"geometry": null`) with the extent carried by `footprint.geojson`

Geometry is derived bottom-up: the items you draw define each level's extent, the levels
define the building footprint, and the footprint defines the venue boundary — so IMDF's
containment rules hold without you tracing four nested outlines by hand.

## Project Structure

```
IMDF-Builder-for-Places/
├── server.js              # Express.js backend server
├── public/                # Frontend files
│   ├── index.html        # Main HTML page
│   ├── css/
│   │   └── styles.css    # Application styles
│   ├── js/
│   │   ├── app.js        # Application logic
│   │   └── geo.js        # Georeferencing engine (canvas pixels <-> lat/lon)
│   └── lib/              # Vendored third-party libraries
├── imdf.js               # IMDF file generation
├── docs/
│   └── USAGE.md          # Practical walkthrough
├── test/                 # Unit tests (node --test)
├── uploads/              # Uploaded floor plans (created at runtime)
├── projects/             # Saved projects (created at runtime)
├── package.json          # Node.js dependencies
├── Dockerfile            # Docker configuration
└── docker-compose.yml    # Docker Compose configuration
```

## Technical Details

### Backend (Node.js/Express)
- File upload handling with Multer
- Project persistence as JSON files
- IMDF file generation
- ZIP archive creation for exports

### Testing

```bash
npm test
```

Runs the georeferencing, IMDF-generation and project round-trip suites with Node's
built-in test runner. No extra dependencies.

### Frontend
- HTML5/CSS3/JavaScript
- Fabric.js for canvas-based editing
- Responsive design
- No framework dependencies for simplicity

### Docker
- Based on Node.js 18 Alpine image
- Lightweight and efficient
- Persistent volumes for projects and uploads
- Available on GitHub Container Registry (GHCR)
- Image: `ghcr.io/loryanstrant/imdf-builder-for-places:latest`

**Available Image Tags:**
- `latest` - Latest build from the main branch
- `main` - Latest build from the main branch (same as latest)
- `v*.*.*` - Specific version tags (when releases are created)

**Pulling the Image:**
```bash
# Pull the latest version
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:latest

# Pull a specific version (example)
docker pull ghcr.io/loryanstrant/imdf-builder-for-places:v1.0.0
```

## Browser Compatibility

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Troubleshooting

### Issue: Cannot upload floor plan
- Check file size (max 50MB)
- Ensure file is PDF, PNG, or JPEG format
- Both raster images (PNG/JPEG) and PDFs are supported. For a multi-page PDF you choose
  which page to trace, or create one level per page.

### Issue: Docker container won't start
- Ensure Docker Desktop is running
- Check if port 3000 is available — or set `HOST_PORT` in `.env` to a free port
- Try `docker-compose down` and `docker-compose up -d`

### Issue: Items not appearing on canvas
- Ensure you've added and selected a level first
- Check that the correct tool is selected
- With more than one level, only the selected level's items are shown

### Issue: Exported rooms are the wrong size or in the wrong place
- Re-check the scale calibration if the size is wrong
- Re-check the anchor point if the position is wrong — anchor on a corner you can
  identify, not the middle of the building
- Open `unit.geojson` at [geojson.io](https://geojson.io) to see where it actually landed

### Issue: footprint.geojson is empty
- Fixed in v1.4.0. Earlier versions always exported an empty footprint and put a
  placeholder polygon on the building instead, which is the inverse of what IMDF wants.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

## References

- [Microsoft Places Documentation](https://learn.microsoft.com/en-us/microsoft-365/places/)
- [Configure Maps in Microsoft Places](https://learn.microsoft.com/en-us/microsoft-365/places/configure-maps-in-places)
- [IMDF Specification](https://register.apple.com/resources/imdf/)
