// IMDF Builder Application

class IMDFBuilder {
    constructor() {
        this.canvas = null;
        this.currentTool = 'select';
        this.currentLevel = null;
        this.levels = [];
        this.units = [];
        this.amenities = [];
        this.fixtures = [];
        this.openings = [];
        this.selectedObject = null;
        this.projectId = null;
        this.floorplanImage = null;
        // Persisted so re-exports keep the same IMDF feature ids — a filled-in
        // Microsoft Places correlations CSV stays valid across exports.
        this.buildingId = null;
        this.footprintId = null;
        
        this.init();
    }

    init() {
        this.initPdfJs();
        this.initCanvas();
        this.attachEventListeners();
        this.updateCounts();
        this.initTheme();
        this.loadVersion();
    }

    async loadVersion() {
        try {
            const res = await fetch('/api/version');
            const { version } = await res.json();
            const el = document.getElementById('appVersion');
            if (el && version) el.textContent = `v${version}`;
        } catch {
            // Non-fatal: leave the placeholder if the version can't be fetched.
        }
    }

    initTheme() {
        // The inline head script already set data-theme; mirror it into the UI and
        // wire the toggle. Falls back to OS preference when nothing is stored.
        const saved = localStorage.getItem('imdf-theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.applyTheme(saved || (prefersDark ? 'dark' : 'light'));

        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                localStorage.setItem('imdf-theme', next);
                this.applyTheme(next);
            });
        }
    }

    applyTheme(theme) {
        const isDark = theme === 'dark';
        document.documentElement.setAttribute('data-theme', theme);

        const icon = document.querySelector('.theme-toggle-icon');
        const label = document.querySelector('.theme-toggle-label');
        if (icon) icon.textContent = isDark ? '☀' : '☾';
        if (label) label.textContent = isDark ? 'Light' : 'Dark';

        // Keep the Fabric drawing surface in sync with the theme.
        if (this.canvas) {
            this.canvas.backgroundColor = isDark ? '#1e1e1e' : '#ffffff';
            this.canvas.renderAll();
        }
    }

    initPdfJs() {
        // pdf.js runs its parser in a web worker; point it at the vendored copy.
        if (window.pdfjsLib) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';
        }
    }

    initCanvas() {
        const canvasElement = document.getElementById('mainCanvas');
        const container = canvasElement.parentElement;
        
        // Set canvas size to fill container
        canvasElement.width = container.clientWidth;
        canvasElement.height = container.clientHeight;
        
        this.canvas = new fabric.Canvas('mainCanvas', {
            backgroundColor: '#ffffff',
            selection: true
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            const container = canvasElement.parentElement;
            this.canvas.setDimensions({
                width: container.clientWidth,
                height: container.clientHeight
            });
            this.canvas.renderAll();
        });

        // Canvas event handlers
        this.canvas.on('selection:created', (e) => this.handleSelection(e));
        this.canvas.on('selection:updated', (e) => this.handleSelection(e));
        this.canvas.on('selection:cleared', () => this.clearSelection());
        this.canvas.on('mouse:down', (e) => this.handleCanvasClick(e));
    }

    attachEventListeners() {
        // Project controls
        document.getElementById('newProjectBtn').addEventListener('click', () => this.newProject());
        document.getElementById('saveProjectBtn').addEventListener('click', () => this.saveProject());
        document.getElementById('loadProjectBtn').addEventListener('click', () => this.showLoadProjectModal());
        
        // Upload floor plan
        document.getElementById('uploadBtn').addEventListener('click', () => this.uploadFloorplan());
        
        // Level management
        document.getElementById('addLevelBtn').addEventListener('click', () => this.addLevel());
        
        // Tool selection
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tool = e.target.dataset.tool;
                this.setTool(tool);
            });
        });

        // Delete selected
        document.getElementById('deleteBtn').addEventListener('click', () => this.deleteSelected());

        // Canvas controls
        document.getElementById('zoomInBtn').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoomOutBtn').addEventListener('click', () => this.zoomOut());
        document.getElementById('resetViewBtn').addEventListener('click', () => this.resetView());

        // Export
        document.getElementById('exportBtn').addEventListener('click', () => this.exportIMDF());

        // Modal close
        document.querySelector('.close').addEventListener('click', () => {
            document.getElementById('loadProjectModal').style.display = 'none';
        });
    }

    setTool(tool) {
        this.currentTool = tool;
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        if (tool === 'select') {
            this.canvas.selection = true;
            this.canvas.isDrawingMode = false;
        } else {
            this.canvas.selection = false;
            this.canvas.isDrawingMode = false;
        }
        
        this.updateCanvasInfo(`Tool: ${tool}`);
    }

    handleCanvasClick(event) {
        if (!event.pointer || this.currentTool === 'select') return;
        if (!this.currentLevel) {
            alert('Please add and select a level first');
            return;
        }

        const pointer = this.canvas.getPointer(event.e);
        
        switch (this.currentTool) {
            case 'unit':
                this.placeUnit(pointer);
                break;
            case 'section':
                this.placeSection(pointer);
                break;
            case 'amenity':
                this.placeAmenity(pointer);
                break;
            case 'fixture':
                this.placeFixture(pointer);
                break;
            case 'opening':
                this.placeOpening(pointer);
                break;
        }
    }

    placeUnit(pointer) {
        const rect = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 100,
            height: 100,
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
            strokeWidth: 2
        });

        const unit = {
            id: this.generateUUID(),
            name: `Unit ${this.units.length + 1}`,
            featureType: 'unit',
            category: 'room',
            restriction: null,
            placeId: null,
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(rect);
        this.updateCounts();
    }

    // Sections are desk pools: Places locates a bookable desk through the
    // Section directory object correlated to a section feature on the map.
    placeSection(pointer) {
        const rect = new fabric.Rect({
            left: pointer.x,
            top: pointer.y,
            width: 120,
            height: 100,
            fill: 'rgba(255, 140, 0, 0.3)',
            stroke: '#ff8c00',
            strokeWidth: 2
        });

        const section = {
            id: this.generateUUID(),
            name: `Section ${this.units.filter(u => u.featureType === 'section').length + 1}`,
            featureType: 'section',
            category: 'unspecified',
            restriction: null,
            placeId: null,
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = section;
        this.units.push(section);
        this.canvas.add(rect);
        this.updateCounts();
    }

    applyFeatureTypeStyle(fabricObject, featureType) {
        if (!fabricObject) return;
        const isSection = featureType === 'section';
        fabricObject.set({
            fill: isSection ? 'rgba(255, 140, 0, 0.3)' : 'rgba(0, 120, 212, 0.3)',
            stroke: isSection ? '#ff8c00' : '#0078d4'
        });
        this.canvas.renderAll();
        this.updateCounts();
    }

    placeAmenity(pointer) {
        const circle = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 15,
            fill: 'rgba(40, 167, 69, 0.5)',
            stroke: '#28a745',
            strokeWidth: 2
        });

        const amenity = {
            id: this.generateUUID(),
            name: `Amenity ${this.amenities.length + 1}`,
            category: 'seating',
            levelId: this.currentLevel.id,
            fabricObject: circle
        };

        circle.imdfData = amenity;
        this.amenities.push(amenity);
        this.canvas.add(circle);
        this.updateCounts();
    }

    placeFixture(pointer) {
        const line = new fabric.Line([pointer.x, pointer.y, pointer.x + 50, pointer.y], {
            stroke: '#6c757d',
            strokeWidth: 3
        });

        const fixture = {
            id: this.generateUUID(),
            category: 'wall',
            levelId: this.currentLevel.id,
            fabricObject: line
        };

        line.imdfData = fixture;
        this.fixtures.push(fixture);
        this.canvas.add(line);
        this.updateCounts();
    }

    placeOpening(pointer) {
        const line = new fabric.Line([pointer.x, pointer.y, pointer.x + 30, pointer.y], {
            stroke: '#dc3545',
            strokeWidth: 4
        });

        const opening = {
            id: this.generateUUID(),
            category: 'door',
            levelId: this.currentLevel.id,
            fabricObject: line
        };

        line.imdfData = opening;
        this.openings.push(opening);
        this.canvas.add(line);
        this.updateCounts();
    }

    handleSelection(event) {
        const obj = event.selected[0];
        if (obj && obj.imdfData) {
            this.selectedObject = obj;
            this.showProperties(obj.imdfData);
        }
    }

    clearSelection() {
        this.selectedObject = null;
        document.getElementById('propertiesPanel').innerHTML = '<p class="hint">Select an item to edit its properties</p>';
    }

    showProperties(data) {
        const panel = document.getElementById('propertiesPanel');
        let html = '';

        if (data.name !== undefined) {
            html += `
                <div class="property-field">
                    <label>Name:</label>
                    <input type="text" id="prop-name" value="${data.name || ''}" />
                </div>
            `;
        }

        if (data.category !== undefined) {
            html += `
                <div class="property-field">
                    <label>Category:</label>
                    <select id="prop-category">
                        <option value="room" ${data.category === 'room' ? 'selected' : ''}>Room</option>
                        <option value="office" ${data.category === 'office' ? 'selected' : ''}>Office</option>
                        <option value="conference" ${data.category === 'conference' ? 'selected' : ''}>Conference Room</option>
                        <option value="seating" ${data.category === 'seating' ? 'selected' : ''}>Seating</option>
                        <option value="restroom" ${data.category === 'restroom' ? 'selected' : ''}>Restroom</option>
                        <option value="elevator" ${data.category === 'elevator' ? 'selected' : ''}>Elevator</option>
                        <option value="stairs" ${data.category === 'stairs' ? 'selected' : ''}>Stairs</option>
                        <option value="wall" ${data.category === 'wall' ? 'selected' : ''}>Wall</option>
                        <option value="door" ${data.category === 'door' ? 'selected' : ''}>Door</option>
                        <option value="unspecified" ${data.category === 'unspecified' ? 'selected' : ''}>Unspecified</option>
                    </select>
                </div>
            `;
        }

        // Drawn shapes can be correlated to a Microsoft Places directory object:
        // units to a Room, sections (desk pools) to a Section.
        if (this.units.some(u => u.id === data.id)) {
            const isSection = data.featureType === 'section';
            html += `
                <div class="property-field">
                    <label>Map Feature:</label>
                    <select id="prop-featuretype">
                        <option value="unit" ${!isSection ? 'selected' : ''}>Unit (Room)</option>
                        <option value="section" ${isSection ? 'selected' : ''}>Section (Desk Pool)</option>
                    </select>
                </div>
                <div class="property-field">
                    <label>Microsoft Places ID (optional):</label>
                    <input type="text" id="prop-placeid" value="${data.placeId || ''}" placeholder="${isSection ? 'Section' : 'Room'} PlaceId from Get-PlaceV3" />
                </div>
            `;
        }

        html += `
            <button id="updatePropertiesBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Properties
            </button>
        `;

        panel.innerHTML = html;

        // Attach update handler
        const updateBtn = document.getElementById('updatePropertiesBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.updateSelectedProperties(data));
        }
    }

    updateSelectedProperties(data) {
        const nameInput = document.getElementById('prop-name');
        const categoryInput = document.getElementById('prop-category');
        const placeIdInput = document.getElementById('prop-placeid');
        const featureTypeInput = document.getElementById('prop-featuretype');

        if (nameInput) data.name = nameInput.value;
        if (categoryInput) data.category = categoryInput.value;
        if (placeIdInput) data.placeId = placeIdInput.value.trim() || null;
        if (featureTypeInput && featureTypeInput.value !== (data.featureType || 'unit')) {
            data.featureType = featureTypeInput.value;
            this.applyFeatureTypeStyle(data.fabricObject, data.featureType);
        }

        alert('Properties updated!');
    }

    deleteSelected() {
        if (!this.selectedObject) {
            alert('No object selected');
            return;
        }

        const data = this.selectedObject.imdfData;
        
        // Remove from canvas
        this.canvas.remove(this.selectedObject);

        // Remove from data arrays
        this.units = this.units.filter(u => u.id !== data.id);
        this.amenities = this.amenities.filter(a => a.id !== data.id);
        this.fixtures = this.fixtures.filter(f => f.id !== data.id);
        this.openings = this.openings.filter(o => o.id !== data.id);

        this.selectedObject = null;
        this.clearSelection();
        this.updateCounts();
    }

    addLevel() {
        const name = document.getElementById('levelName').value || `Level ${this.levels.length}`;
        const ordinal = parseInt(document.getElementById('levelOrdinal').value) || this.levels.length;

        const level = {
            id: this.generateUUID(),
            name: name,
            ordinal: ordinal,
            short_name: ordinal.toString()
        };

        this.levels.push(level);
        this.renderLevelsList();
        this.updateCounts();

        // Auto-select the new level
        this.selectLevel(level);

        // Clear inputs
        document.getElementById('levelName').value = '';
        document.getElementById('levelOrdinal').value = this.levels.length;
    }

    renderLevelsList() {
        const list = document.getElementById('levelsList');
        list.innerHTML = '';

        this.levels.forEach(level => {
            const item = document.createElement('div');
            item.className = 'level-item';
            if (this.currentLevel && this.currentLevel.id === level.id) {
                item.classList.add('active');
            }
            item.innerHTML = `
                <span>${level.name} (${level.ordinal})</span>
                <button class="btn btn-danger btn-sm" onclick="app.removeLevel('${level.id}')">Remove</button>
            `;
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('btn')) {
                    this.selectLevel(level);
                }
            });
            list.appendChild(item);
        });
    }

    selectLevel(level) {
        this.currentLevel = level;
        this.renderLevelsList();
        this.updateCanvasInfo(`Current Level: ${level.name}`);
        this.showLevelProperties(level);
    }

    showLevelProperties(level) {
        const panel = document.getElementById('propertiesPanel');
        panel.innerHTML = `
            <div class="property-field">
                <label>Level Name:</label>
                <input type="text" id="level-prop-name" value="${level.name || ''}" />
            </div>
            <div class="property-field">
                <label>Level Number:</label>
                <input type="number" id="level-prop-ordinal" value="${level.ordinal}" />
            </div>
            <div class="property-field">
                <label>Microsoft Places ID (optional):</label>
                <input type="text" id="level-prop-placeid" value="${level.placeId || ''}" placeholder="Floor PlaceId from Get-PlaceV3" />
            </div>
            <p class="hint">The floor's Places SortOrder must match the level number.</p>
            <button id="updateLevelBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Level
            </button>
        `;
        document.getElementById('updateLevelBtn').addEventListener('click', () => {
            level.name = document.getElementById('level-prop-name').value || level.name;
            const ordinal = parseInt(document.getElementById('level-prop-ordinal').value);
            if (!isNaN(ordinal)) {
                level.ordinal = ordinal;
                level.short_name = ordinal.toString();
            }
            level.placeId = document.getElementById('level-prop-placeid').value.trim() || null;
            this.renderLevelsList();
            this.updateCanvasInfo(`Current Level: ${level.name}`);
            alert('Level updated!');
        });
    }

    removeLevel(levelId) {
        // Remove level
        this.levels = this.levels.filter(l => l.id !== levelId);
        
        // Remove associated items from canvas
        const itemsToRemove = [];
        this.canvas.getObjects().forEach(obj => {
            if (obj.imdfData && obj.imdfData.levelId === levelId) {
                itemsToRemove.push(obj);
            }
        });
        itemsToRemove.forEach(obj => this.canvas.remove(obj));

        // Remove from data arrays
        this.units = this.units.filter(u => u.levelId !== levelId);
        this.amenities = this.amenities.filter(a => a.levelId !== levelId);
        this.fixtures = this.fixtures.filter(f => f.levelId !== levelId);
        this.openings = this.openings.filter(o => o.levelId !== levelId);

        if (this.currentLevel && this.currentLevel.id === levelId) {
            this.currentLevel = null;
        }

        this.renderLevelsList();
        this.updateCounts();
    }

    async uploadFloorplan() {
        const fileInput = document.getElementById('floorplanUpload');
        const file = fileInput.files[0];
        
        if (!file) {
            alert('Please select a file first');
            return;
        }

        const formData = new FormData();
        formData.append('floorplan', file);

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const result = await this.parseJsonResponse(response);

            if (response.ok && result.success) {
                this.floorplanImage = result.path;
                await this.loadFloorplanToCanvas(result.path);
                alert('Floor plan uploaded successfully!');
            } else {
                alert('Upload failed: ' + (result.error || `HTTP ${response.status}`));
            }
        } catch (error) {
            alert('Upload error: ' + error.message);
        }
    }

    // Parse a fetch response as JSON, tolerating a non-JSON body (e.g. an HTML error
    // page from a proxy or a crashed server) instead of throwing the confusing
    // "JSON.parse: unexpected character" error users reported in issue #4.
    async parseJsonResponse(response) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return { error: `Server returned a non-JSON response (HTTP ${response.status})` };
        }
    }

    async loadFloorplanToCanvas(imageUrl) {
        // A PDF can't be drawn as an <img>; rasterize its first page first (issue #4).
        const isPdf = /\.pdf($|\?)/i.test(imageUrl);
        const sourceUrl = isPdf ? await this.renderPdfToDataUrl(imageUrl) : imageUrl;

        // Fabric v6 returns a Promise from fromURL (the old callback form is gone).
        const img = await fabric.Image.fromURL(sourceUrl);
        if (!img) {
            throw new Error('Failed to load floor plan image');
        }

        // Scale image to fit canvas
        const scale = Math.min(
            this.canvas.width / img.width,
            this.canvas.height / img.height
        ) * 0.9;

        img.scale(scale);
        img.set({
            left: this.canvas.width / 2,
            top: this.canvas.height / 2,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false
        });

        // Fabric v6: backgroundImage is a property; setBackgroundImage() was removed.
        this.canvas.backgroundImage = img;
        this.canvas.renderAll();
    }

    async renderPdfToDataUrl(pdfUrl) {
        if (!window.pdfjsLib) {
            throw new Error('PDF support failed to load. Please refresh and try again.');
        }
        const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
        const page = await pdf.getPage(1); // first page becomes the floor plan
        // Render at 2x so the background stays crisp when zoomed in.
        const viewport = page.getViewport({ scale: 2 });
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = viewport.width;
        tmpCanvas.height = viewport.height;
        await page.render({ canvasContext: tmpCanvas.getContext('2d'), viewport }).promise;
        return tmpCanvas.toDataURL('image/png');
    }

    zoomIn() {
        const zoom = this.canvas.getZoom();
        this.canvas.setZoom(zoom * 1.1);
    }

    zoomOut() {
        const zoom = this.canvas.getZoom();
        this.canvas.setZoom(zoom * 0.9);
    }

    resetView() {
        this.canvas.setZoom(1);
        this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        this.canvas.renderAll();
    }

    // Single source of truth for the project payload used by save and export.
    // Building/footprint ids are minted once and persisted so every export
    // reuses them — a filled-in Places correlations CSV stays valid.
    collectProjectData() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        this.buildingId = this.buildingId || this.generateUUID();
        this.footprintId = this.footprintId || this.generateUUID();

        return {
            projectName: projectName,
            venue: {
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                id: this.buildingId,
                footprintId: this.footprintId,
                name: document.getElementById('buildingName').value || 'Building',
                placeId: document.getElementById('buildingPlaceId').value.trim() || null,
                coordinates: this.getBuildingCoordinates()
            },
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                placeId: l.placeId || null,
                coordinates: this.getLevelCoordinates()
            })),
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                featureType: u.featureType || 'unit',
                category: u.category,
                restriction: u.restriction,
                placeId: u.placeId || null,
                levelId: u.levelId,
                coordinates: this.getObjectCoordinates(u.fabricObject),
                display_point: this.getDisplayPoint(u.fabricObject)
            })),
            amenities: this.amenities.map(a => ({
                id: a.id,
                name: a.name,
                category: a.category,
                levelId: a.levelId,
                coordinates: this.getPointCoordinates(a.fabricObject)
            })),
            fixtures: this.fixtures.map(f => ({
                id: f.id,
                category: f.category,
                levelId: f.levelId,
                geometryType: 'LineString',
                coordinates: this.getLineCoordinates(f.fabricObject)
            })),
            openings: this.openings.map(o => ({
                id: o.id,
                category: o.category,
                levelId: o.levelId,
                coordinates: this.getLineCoordinates(o.fabricObject)
            }))
        };
    }

    async saveProject() {
        const projectData = this.collectProjectData();
        const projectName = projectData.projectName;
        projectData.floorplanImage = this.floorplanImage;
        projectData.createdAt = new Date().toISOString();

        try {
            const response = await fetch('/api/projects/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: this.projectId,
                    projectName: projectName,
                    projectData: projectData
                })
            });

            const result = await response.json();
            
            if (result.success) {
                this.projectId = result.projectId;
                alert('Project saved successfully!');
            } else {
                alert('Save failed: ' + result.error);
            }
        } catch (error) {
            alert('Save error: ' + error.message);
        }
    }

    async showLoadProjectModal() {
        try {
            const response = await fetch('/api/projects');
            const projects = await response.json();

            const list = document.getElementById('projectsList');
            list.innerHTML = '';

            if (projects.length === 0) {
                list.innerHTML = '<p>No saved projects found.</p>';
            } else {
                projects.forEach(project => {
                    const item = document.createElement('div');
                    item.className = 'project-item';
                    item.innerHTML = `
                        <h3>${project.name}</h3>
                        <p>Updated: ${new Date(project.updatedAt).toLocaleString()}</p>
                    `;
                    item.addEventListener('click', () => this.loadProject(project.id));
                    list.appendChild(item);
                });
            }

            document.getElementById('loadProjectModal').style.display = 'block';
        } catch (error) {
            alert('Error loading projects: ' + error.message);
        }
    }

    async loadProject(projectId) {
        try {
            const response = await fetch(`/api/projects/${projectId}`);
            const project = await response.json();

            // Clear current state
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;

            // Load project data
            this.projectId = project.id;
            document.getElementById('projectName').value = project.name;
            
            const data = project.data;
            
            if (data.venue) {
                document.getElementById('venueCoords').value = data.venue.coordinates.join(', ');
            }
            
            if (data.building) {
                document.getElementById('buildingName').value = data.building.name;
                document.getElementById('buildingPlaceId').value = data.building.placeId || '';
                this.buildingId = data.building.id || null;
                this.footprintId = data.building.footprintId || null;
            }

            // Load floor plan if exists
            if (data.floorplanImage) {
                this.floorplanImage = data.floorplanImage;
                await this.loadFloorplanToCanvas(data.floorplanImage);
            }

            // Load levels
            if (data.levels) {
                this.levels = data.levels;
                this.renderLevelsList();
                if (this.levels.length > 0) {
                    this.selectLevel(this.levels[0]);
                }
            }

            // Load units
            if (data.units) {
                data.units.forEach(unitData => {
                    const isSection = unitData.featureType === 'section';
                    const rect = new fabric.Rect({
                        left: 100,
                        top: 100,
                        width: 100,
                        height: 100,
                        fill: isSection ? 'rgba(255, 140, 0, 0.3)' : 'rgba(0, 120, 212, 0.3)',
                        stroke: isSection ? '#ff8c00' : '#0078d4',
                        strokeWidth: 2
                    });
                    unitData.fabricObject = rect;
                    rect.imdfData = unitData;
                    this.units.push(unitData);
                    this.canvas.add(rect);
                });
            }

            // Load amenities
            if (data.amenities) {
                data.amenities.forEach(amenityData => {
                    const circle = new fabric.Circle({
                        left: 200,
                        top: 200,
                        radius: 15,
                        fill: 'rgba(40, 167, 69, 0.5)',
                        stroke: '#28a745',
                        strokeWidth: 2
                    });
                    amenityData.fabricObject = circle;
                    circle.imdfData = amenityData;
                    this.amenities.push(amenityData);
                    this.canvas.add(circle);
                });
            }

            this.updateCounts();
            document.getElementById('loadProjectModal').style.display = 'none';
            alert('Project loaded successfully!');
        } catch (error) {
            alert('Error loading project: ' + error.message);
        }
    }

    newProject() {
        if (confirm('Start a new project? Any unsaved changes will be lost.')) {
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;
            this.projectId = null;
            this.floorplanImage = null;
            this.buildingId = null;
            this.footprintId = null;

            document.getElementById('projectName').value = '';
            document.getElementById('buildingName').value = '';
            document.getElementById('buildingPlaceId').value = '';
            document.getElementById('venueCoords').value = '0, 0';
            
            this.renderLevelsList();
            this.updateCounts();
            this.clearSelection();
        }
    }

    async exportIMDF() {
        const projectData = this.collectProjectData();

        try {
            const response = await fetch('/api/generate-imdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });

            if (!response.ok) {
                const result = await this.parseJsonResponse(response);
                alert('Export failed: ' + (result.error || `HTTP ${response.status}`));
                return;
            }
            this.downloadBlob(await response.blob(), 'imdf-export.zip');

            // Companion correlations CSV for Import-MapCorrelations, pre-filled
            // with this export's feature ids and any Places IDs entered above.
            const csvResponse = await fetch('/api/generate-mapfeatures', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });
            if (csvResponse.ok) {
                this.downloadBlob(await csvResponse.blob(), 'mapfeatures.csv');
            }

            alert('IMDF files exported successfully!');
        } catch (error) {
            alert('Export error: ' + error.message);
        }
    }

    downloadBlob(blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }

    // Helper methods
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    parseCoordinates(str) {
        const parts = str.split(',').map(s => parseFloat(s.trim()));
        return parts.length === 2 ? parts : [0, 0];
    }

    getBuildingCoordinates() {
        // Return a simple polygon for the building footprint
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    getLevelCoordinates() {
        // Return a simple polygon for the level
        return [[[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0], [0, 0]]];
    }

    getObjectCoordinates(obj) {
        // Convert fabric object to polygon coordinates
        if (!obj) return [[[0, 0], [0, 0.0001], [0.0001, 0.0001], [0.0001, 0], [0, 0]]];
        
        const left = obj.left / 100000;
        const top = obj.top / 100000;
        const width = (obj.width * obj.scaleX) / 100000;
        const height = (obj.height * obj.scaleY) / 100000;
        
        return [[
            [left, top],
            [left, top + height],
            [left + width, top + height],
            [left + width, top],
            [left, top]
        ]];
    }

    getDisplayPoint(obj) {
        if (!obj) return { type: 'Point', coordinates: [0, 0] };
        
        return {
            type: 'Point',
            coordinates: [
                (obj.left + (obj.width * obj.scaleX) / 2) / 100000,
                (obj.top + (obj.height * obj.scaleY) / 2) / 100000
            ]
        };
    }

    getPointCoordinates(obj) {
        if (!obj) return [0, 0];
        return [obj.left / 100000, obj.top / 100000];
    }

    getLineCoordinates(obj) {
        if (!obj) return [[0, 0], [0, 0.0001]];
        return [
            [obj.x1 / 100000, obj.y1 / 100000],
            [obj.x2 / 100000, obj.y2 / 100000]
        ];
    }

    updateCounts() {
        const sections = this.units.filter(u => u.featureType === 'section').length;
        document.getElementById('levelCount').textContent = this.levels.length;
        document.getElementById('unitCount').textContent = this.units.length - sections;
        document.getElementById('sectionCount').textContent = sections;
        document.getElementById('amenityCount').textContent = this.amenities.length;
        document.getElementById('fixtureCount').textContent = this.fixtures.length;
        document.getElementById('openingCount').textContent = this.openings.length;
    }

    updateCanvasInfo(text) {
        document.getElementById('canvasInfo').textContent = text;
    }
}

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new IMDFBuilder();
});
