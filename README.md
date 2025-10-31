# IMDF Builder for Microsoft Places

A user-friendly web application to create Indoor Mapping Data Format (IMDF) files for use with Microsoft Places. This tool provides a graphical interface for non-technical users to upload floor plans, place various indoor mapping elements, and generate standards-compliant IMDF files.

## Features

- 🖼️ **Floor Plan Upload**: Upload PDF or image files of your floor plans
- 🏢 **Interactive Editor**: Visual canvas-based editor for placing indoor mapping elements
- 📍 **IMDF Elements Support**:
  - Units (rooms, offices, conference rooms)
  - Amenities (desks, seating, facilities)
  - Fixtures (walls, windows)
  - Openings (doors, entrances)
  - Levels (floors)
- 💾 **Project Management**: Save and load projects for later editing
- 📦 **Export**: Generate complete IMDF file packages as ZIP archives
- 🐳 **Docker Support**: Easy deployment with Docker and Docker Compose

## Quick Start

### Using Docker (Recommended)

1. **Install Docker Desktop**
   - Download from [docker.com](https://www.docker.com/products/docker-desktop)
   - Install and start Docker Desktop

2. **Run the Application**
   ```bash
   # Clone the repository
   git clone https://github.com/loryanstrant/IMDF-Builder-for-Places.git
   cd IMDF-Builder-for-Places

   # Start the application with Docker Compose
   docker-compose up -d

   # The application will be available at http://localhost:3000
   ```

3. **Stop the Application**
   ```bash
   docker-compose down
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

## How to Use

### Step 1: Create a New Project
1. Enter a project name in the "Project Name" field
2. Enter your building name and venue coordinates (latitude, longitude)
3. Click "Save Project" to save your initial setup

### Step 2: Upload Floor Plan
1. Click "Choose File" in the Floor Plan section
2. Select a PDF or image file of your floor plan
3. Click "Upload" to load it onto the canvas

### Step 3: Add Levels
1. In the "Levels" section, enter a level name (e.g., "Ground Floor")
2. Enter the level number (0 for ground floor, 1 for first floor, etc.)
3. Click "Add Level"
4. Click on a level in the list to make it active for placing items

### Step 4: Place Items on the Floor Plan
1. Select a tool from the "Place Items" section:
   - **Place Unit**: For rooms, offices, conference rooms
   - **Place Amenity**: For desks, seating, facilities
   - **Place Fixture**: For walls, windows
   - **Place Opening**: For doors, entrances
2. Click on the canvas where you want to place the item
3. Use "Select Mode" to select and move items

### Step 5: Edit Item Properties
1. Click "Select Mode" button
2. Click on an item on the canvas
3. Edit properties in the "Selected Item Properties" panel:
   - Change the name
   - Update the category
4. Click "Update Properties" to save changes

### Step 6: Export IMDF Files
1. Click the "Export IMDF Files" button in the right sidebar
2. A ZIP file will be downloaded containing all required IMDF files:
   - venue.geojson
   - building.geojson
   - level.geojson
   - unit.geojson
   - amenity.geojson
   - fixture.geojson
   - opening.geojson
   - anchor.geojson
   - manifest.json
   - And other required empty files

### Step 7: Upload to Microsoft Places
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

## Project Structure

```
IMDF-Builder-for-Places/
├── server.js              # Express.js backend server
├── public/                # Frontend files
│   ├── index.html        # Main HTML page
│   ├── css/
│   │   └── styles.css    # Application styles
│   └── js/
│       └── app.js        # Application logic
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

### Frontend
- HTML5/CSS3/JavaScript
- Fabric.js for canvas-based editing
- Responsive design
- No framework dependencies for simplicity

### Docker
- Based on Node.js 18 Alpine image
- Lightweight and efficient
- Persistent volumes for projects and uploads

## Browser Compatibility

- Chrome (recommended)
- Firefox
- Safari
- Edge

## Troubleshooting

### Issue: Cannot upload floor plan
- Check file size (max 50MB)
- Ensure file is PDF, PNG, or JPEG format

### Issue: Docker container won't start
- Ensure Docker Desktop is running
- Check if port 3000 is available
- Try `docker-compose down` and `docker-compose up -d`

### Issue: Items not appearing on canvas
- Ensure you've added and selected a level first
- Check that the correct tool is selected

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
