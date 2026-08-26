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

        // Polygon drawing state
        this.polyPoints = [];       // vertices collected so far
        this.polyLines = [];        // preview line objects on canvas
        this.polyDots = [];         // vertex dot objects on canvas
        this.previewLine = null;    // rubber-band line tracking mouse

        // Edge-snapping state
        this.snapEnabled = true;
        this.snapRadius = 12;       // pixels (canvas coords)
        this.snapCanvas = null;     // offscreen canvas for pixel sampling
        this.snapCtx = null;
        
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

        // Handle window resize — update canvas dimensions and refit the background image
        window.addEventListener('resize', () => {
            const container = canvasElement.parentElement;
            this.canvas.setDimensions({
                width: container.clientWidth,
                height: container.clientHeight
            });
            this.refitBackground();
            this.buildSnapCanvas();
            this.canvas.renderAll();
        });

        // Canvas event handlers
        this.canvas.on('selection:created', (e) => this.handleSelection(e));
        this.canvas.on('selection:updated', (e) => this.handleSelection(e));
        this.canvas.on('selection:cleared', () => this.clearSelection());
        this.canvas.on('mouse:down', (e) => this.handleCanvasClick(e));
        this.canvas.on('mouse:move', (e) => this.handleCanvasMove(e));
        this.canvas.on('mouse:dblclick', (e) => this.handleCanvasDblClick(e));

        // Escape cancels an in-progress polygon
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.cancelPolygon();
        });
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
                const tool = e.currentTarget.dataset.tool;
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

        // Snap toggle
        const snapToggle = document.getElementById('snapToggle');
        if (snapToggle) {
            snapToggle.addEventListener('change', (e) => {
                this.snapEnabled = e.target.checked;
                this.showToast(`Edge snapping ${this.snapEnabled ? 'on' : 'off'}`, 'info');
            });
        }

        // Modal close
        document.querySelector('.close').addEventListener('click', () => {
            document.getElementById('loadProjectModal').style.display = 'none';
        });
    }

    setTool(tool) {
        // Cancel any in-progress polygon draw when switching tools
        if (this.polyPoints.length > 0) this.cancelPolygon();

        this.currentTool = tool;
        document.querySelectorAll('.btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
        
        if (tool === 'select') {
            this.canvas.selection = true;
            this.canvas.isDrawingMode = false;
            this.hideDrawingHint();
        } else {
            this.canvas.selection = false;
            this.canvas.isDrawingMode = false;
            if (tool === 'unit') {
                this.showDrawingHint('Click to place vertices — double-click or click near start to close the polygon. Esc to cancel.');
            } else {
                this.hideDrawingHint();
            }
        }
        
        this.updateCanvasInfo(`Tool: ${tool}`);
    }

    showDrawingHint(msg) {
        const el = document.getElementById('drawingHint');
        if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    hideDrawingHint() {
        const el = document.getElementById('drawingHint');
        if (el) el.style.display = 'none';
    }

    handleCanvasClick(event) {
        if (!event.pointer || this.currentTool === 'select') return;
        if (!this.currentLevel) {
            this.showToast('Please add and select a level first', 'error');
            return;
        }

        const raw = this.canvas.getPointer(event.e);
        const pointer = this.snapEnabled ? this.snapToEdge(raw) : raw;

        switch (this.currentTool) {
            case 'unit':
                this.handlePolygonClick(pointer);
                break;
            case 'unit-rect':
                this.placeRectUnit(pointer);
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

    handleCanvasMove(event) {
        const raw = this.canvas.getPointer(event.e);
        const pos = this.snapEnabled ? this.snapToEdge(raw) : raw;

        // Show snap cursor dot
        this.updateSnapCursor(pos, raw !== pos || this.polyPoints.length > 0);

        // Update rubber-band preview line while drawing polygon
        if (this.currentTool === 'unit' && this.polyPoints.length > 0) {
            const last = this.polyPoints[this.polyPoints.length - 1];
            if (this.previewLine) {
                this.previewLine.set({ x1: last.x, y1: last.y, x2: pos.x, y2: pos.y });
            } else {
                this.previewLine = new fabric.Line([last.x, last.y, pos.x, pos.y], {
                    stroke: '#ff5c00',
                    strokeWidth: 1.5,
                    strokeDashArray: [4, 4],
                    selectable: false,
                    evented: false,
                    excludeFromExport: true
                });
                this.canvas.add(this.previewLine);
            }
            this.canvas.renderAll();
        }
    }

    handleCanvasDblClick(event) {
        if (this.currentTool === 'unit' && this.polyPoints.length >= 3) {
            this.closePolygon();
        }
    }

    updateSnapCursor(snapped, show) {
        const el = document.getElementById('snapCursor');
        if (!el) return;
        if (!show) { el.style.display = 'none'; return; }
        // Convert canvas coords back to DOM coords
        const vpt = this.canvas.viewportTransform;
        const x = snapped.x * vpt[0] + vpt[4];
        const y = snapped.y * vpt[3] + vpt[5];
        el.style.left = x + 'px';
        el.style.top  = y + 'px';
        el.style.display = 'block';
    }

    // ── Polygon drawing ───────────────────────────────────────────

    handlePolygonClick(pointer) {
        const CLOSE_RADIUS = 14; // px — click near first vertex to close

        // Check if clicking near the first vertex to close the polygon
        if (this.polyPoints.length >= 3) {
            const first = this.polyPoints[0];
            const dx = pointer.x - first.x;
            const dy = pointer.y - first.y;
            if (Math.sqrt(dx*dx + dy*dy) < CLOSE_RADIUS) {
                this.closePolygon();
                return;
            }
        }

        // Add the vertex
        this.polyPoints.push({ x: pointer.x, y: pointer.y });

        // Draw a vertex dot
        const dot = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: 4,
            fill: this.polyPoints.length === 1 ? '#28a745' : '#ff5c00',
            stroke: '#fff',
            strokeWidth: 1.5,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            excludeFromExport: true
        });
        this.canvas.add(dot);
        this.polyDots.push(dot);

        // Draw an edge from the previous vertex
        if (this.polyPoints.length > 1) {
            const prev = this.polyPoints[this.polyPoints.length - 2];
            const line = new fabric.Line([prev.x, prev.y, pointer.x, pointer.y], {
                stroke: '#ff5c00',
                strokeWidth: 1.5,
                selectable: false,
                evented: false,
                excludeFromExport: true
            });
            this.canvas.add(line);
            this.polyLines.push(line);
        }

        // Remove preview line so it gets recreated from the new last point
        if (this.previewLine) {
            this.canvas.remove(this.previewLine);
            this.previewLine = null;
        }

        const n = this.polyPoints.length;
        this.showDrawingHint(
            n === 1
                ? 'First vertex placed — keep clicking to add more. Double-click or click ● to close.'
                : `${n} vertices — double-click or click the green dot to close the polygon. Esc to cancel.`
        );
        this.canvas.renderAll();
    }

    closePolygon() {
        if (this.polyPoints.length < 3) return;

        // Clean up preview geometry
        this.cancelPolygonPreview();

        // Build Fabric polygon from the collected points
        const points = this.polyPoints.map(p => ({ x: p.x, y: p.y }));
        const poly = new fabric.Polygon(points, {
            fill: 'rgba(0, 120, 212, 0.3)',
            stroke: '#0078d4',
            strokeWidth: 2,
            selectable: true,
            evented: true,
            objectCaching: false
        });

        const unit = {
            id: this.generateUUID(),
            type: 'unit',
            name: `Unit ${this.units.length + 1}`,
            category: 'room',
            restriction: 'restricted',
            exchangeId: '',
            levelId: this.currentLevel.id,
            fabricObject: poly
        };

        poly.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(poly);
        this.canvas.setActiveObject(poly);
        this.updateCounts();
        this.polyPoints = [];
        this.showDrawingHint('Click to place vertices — double-click or click near start to close the polygon. Esc to cancel.');
        this.canvas.renderAll();
    }

    cancelPolygon() {
        if (this.polyPoints.length === 0) return;
        this.cancelPolygonPreview();
        this.polyPoints = [];
    }

    cancelPolygonPreview() {
        // Remove all temporary preview objects from canvas
        [...this.polyLines, ...this.polyDots].forEach(o => this.canvas.remove(o));
        if (this.previewLine) this.canvas.remove(this.previewLine);
        this.polyLines = [];
        this.polyDots = [];
        this.previewLine = null;
        this.canvas.renderAll();
    }

    // ── Edge snapping ─────────────────────────────────────────────

    // Build the offscreen sampling canvas whenever a new floor plan is loaded.
    // We draw the background image into an offscreen <canvas> at its natural
    // resolution so we can read pixel values without CORS issues (the image was
    // uploaded by the user and served from our own origin).
    buildSnapCanvas() {
        const bg = this.canvas.backgroundImage;
        if (!bg) { this.snapCanvas = null; this.snapCtx = null; return; }

        try {
            const el = bg._originalElement || bg.getElement && bg.getElement();
            if (!el) { this.snapCanvas = null; return; }

            const w = el.naturalWidth  || el.width  || 800;
            const h = el.naturalHeight || el.height || 600;

            this.snapCanvas = document.createElement('canvas');
            this.snapCanvas.width  = w;
            this.snapCanvas.height = h;
            this.snapCtx = this.snapCanvas.getContext('2d');
            this.snapCtx.drawImage(el, 0, 0, w, h);
        } catch (e) {
            // Cross-origin or tainted canvas — silently disable snapping
            this.snapCanvas = null;
            this.snapCtx = null;
        }
    }

    // Map a canvas-coordinate point to the nearest dark edge pixel within
    // snapRadius.  Returns the original point if no edge is found.
    snapToEdge(pt) {
        if (!this.snapEnabled || !this.snapCtx || !this.canvas.backgroundImage) return pt;

        const bg = this.canvas.backgroundImage;
        // Background image transform: position and scale
        const bgScaleX = bg.scaleX || 1;
        const bgScaleY = bg.scaleY || 1;
        const bgLeft   = bg.left   || 0;
        const bgTop    = bg.top    || 0;
        const bgW = (bg._originalElement ? (bg._originalElement.naturalWidth  || bg.width) : bg.width)  || 1;
        const bgH = (bg._originalElement ? (bg._originalElement.naturalHeight || bg.height) : bg.height) || 1;
        const bgOriginX = bgLeft - (bgW * bgScaleX) / 2;
        const bgOriginY = bgTop  - (bgH * bgScaleY) / 2;

        // Convert canvas coords → image pixel coords
        const imgX = (pt.x - bgOriginX) / bgScaleX;
        const imgY = (pt.y - bgOriginY) / bgScaleY;

        // Scale snap radius from canvas coords to image coords
        const imgRadius = this.snapRadius / Math.min(bgScaleX, bgScaleY);

        let bestX = pt.x, bestY = pt.y;
        let bestEdge = 0;
        let found = false;

        const r = Math.ceil(imgRadius);
        const cx = Math.round(imgX), cy = Math.round(imgY);
        const x0 = Math.max(0, cx - r), x1 = Math.min(this.snapCanvas.width  - 1, cx + r);
        const y0 = Math.max(0, cy - r), y1 = Math.min(this.snapCanvas.height - 1, cy + r);

        if (x0 >= x1 || y0 >= y1) return pt;

        const imgData = this.snapCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        const data = imgData.data;
        const stride = (x1 - x0 + 1) * 4;

        for (let dy = 0; dy <= y1 - y0; dy++) {
            for (let dx = 0; dx <= x1 - x0; dx++) {
                const px = x0 + dx, py = y0 + dy;
                const distSq = (px - imgX) ** 2 + (py - imgY) ** 2;
                if (distSq > imgRadius * imgRadius) continue;

                const idx = dy * stride + dx * 4;
                const r_val = data[idx], g_val = data[idx+1], b_val = data[idx+2];
                const brightness = (r_val + g_val + b_val) / 3;
                // Lower brightness = darker = more likely an edge/wall
                const edgeScore = (255 - brightness) / 255;

                if (edgeScore > 0.4 && edgeScore > bestEdge) {
                    bestEdge = edgeScore;
                    // Convert back to canvas coords
                    bestX = bgOriginX + px * bgScaleX;
                    bestY = bgOriginY + py * bgScaleY;
                    found = true;
                }
            }
        }

        return found ? { x: bestX, y: bestY } : pt;
    }

    // ── Rectangle unit (legacy quick-place) ──────────────────────
    placeRectUnit(pointer) {
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
            type: 'unit',
            name: `Unit ${this.units.length + 1}`,
            category: 'room',
            restriction: 'restricted',
            exchangeId: '',
            levelId: this.currentLevel.id,
            fabricObject: rect
        };

        rect.imdfData = unit;
        this.units.push(unit);
        this.canvas.add(rect);
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
            type: 'amenity',
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
            type: 'fixture',
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
            type: 'opening',
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

        // Determine the item type label
        const typeMap = {
            unit: 'Unit / Room',
            amenity: 'Amenity',
            fixture: 'Fixture',
            opening: 'Opening / Door'
        };
        const typeLabel = typeMap[data.type] || (data.levelId ? 'Item' : 'Unknown');

        let html = `<span class="prop-type-badge">${typeLabel}</span>`;

        // Read-only ID
        html += `
            <div class="property-field">
                <label>ID:</label>
                <input type="text" value="${data.id || ''}" readonly />
            </div>
        `;

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

        // Exchange ID field — only for units (which have a restriction property)
        if (data.exchangeId !== undefined) {
            html += `
                <div class="property-field">
                    <label>Exchange Room ID:</label>
                    <input type="text" id="prop-exchangeId" value="${data.exchangeId || ''}"
                           placeholder="e.g. room.building@contoso.com" />
                </div>
            `;
        }

        html += `
            <button id="updatePropertiesBtn" class="btn btn-primary" style="width: 100%; margin-top: 10px;">
                Update Properties
            </button>
        `;

        panel.innerHTML = html;

        // Auto-apply on blur for text inputs
        panel.querySelectorAll('input:not([readonly]), select').forEach(el => {
            el.addEventListener('change', () => this.updateSelectedProperties(data));
        });

        const updateBtn = document.getElementById('updatePropertiesBtn');
        if (updateBtn) {
            updateBtn.addEventListener('click', () => this.updateSelectedProperties(data));
        }
    }

    updateSelectedProperties(data) {
        const nameInput = document.getElementById('prop-name');
        const categoryInput = document.getElementById('prop-category');

        if (nameInput) data.name = nameInput.value;
        if (categoryInput) data.category = categoryInput.value;
        const exchangeInput = document.getElementById('prop-exchangeId');
        if (exchangeInput !== null) data.exchangeId = exchangeInput.value;

        this.showToast('Properties updated', 'success');
    }

    deleteSelected() {
        if (!this.selectedObject) {
            this.showToast('No object selected', 'info');
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
            this.showToast('Please select a file first', 'error');
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
                this.showToast('Floor plan uploaded successfully!', 'success');
            } else {
                this.showToast('Upload failed: ' + (result.error || `HTTP ${response.status}`), 'error');
            }
        } catch (error) {
            this.showToast('Upload error: ' + error.message, 'error');
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
        const isSvg = /\.svg($|\?)/i.test(imageUrl);

        if (isSvg) {
            await this.loadSvgToCanvas(imageUrl);
            return;
        }

        const sourceUrl = isPdf ? await this.renderPdfToDataUrl(imageUrl) : imageUrl;

        // Fabric v6 returns a Promise from fromURL (the old callback form is gone).
        const img = await fabric.Image.fromURL(sourceUrl);
        if (!img) {
            throw new Error('Failed to load floor plan image');
        }

        img.set({ selectable: false, evented: false });

        // Fabric v6: backgroundImage is a property; setBackgroundImage() was removed.
        this.canvas.backgroundImage = img;
        this.refitBackground();
        this.buildSnapCanvas();
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

    // Re-scale and re-centre the background image to fill 90% of the current
    // canvas size.  Called after every resize so the floor plan tracks the window.
    refitBackground() {
        const bg = this.canvas.backgroundImage;
        if (!bg) return;

        // Natural dimensions — for a Fabric Image use width/height; for an SVG
        // Group use the original width/height stored on the object.
        const naturalW = bg._originalElement ? bg._originalElement.naturalWidth || bg.width : bg.width;
        const naturalH = bg._originalElement ? bg._originalElement.naturalHeight || bg.height : bg.height;
        const srcW = naturalW || bg.width || 1;
        const srcH = naturalH || bg.height || 1;

        const scale = Math.min(
            this.canvas.width  / srcW,
            this.canvas.height / srcH
        ) * 0.9;

        bg.scale(scale);
        bg.set({
            left: this.canvas.width  / 2,
            top:  this.canvas.height / 2,
            originX: 'center',
            originY: 'center'
        });
    }

    async loadSvgToCanvas(svgUrl) {
        // Fabric v6 exposes loadSVGFromURL on the util namespace.
        const loadFn = (fabric.util && fabric.util.loadSVGFromURL)
            ? fabric.util.loadSVGFromURL
            : fabric.loadSVGFromURL;

        if (!loadFn) {
            throw new Error('SVG loading not supported by this version of Fabric.js');
        }

        const { objects, options } = await new Promise((resolve, reject) => {
            loadFn(svgUrl, (objects, options) => {
                if (!objects) reject(new Error('Failed to parse SVG'));
                else resolve({ objects, options });
            });
        });

        const group = fabric.util.groupSVGElements(objects, options);
        group.set({ selectable: false, evented: false });

        this.canvas.backgroundImage = group;
        this.refitBackground();
        this.buildSnapCanvas();
        this.canvas.renderAll();
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

    async saveProject() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        
        const projectData = {
            projectName: projectName,
            venue: {
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                name: document.getElementById('buildingName').value || 'Building',
                coordinates: this.getBuildingCoordinates()
            },
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                coordinates: this.getLevelCoordinates()
            })),
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                category: u.category,
                restriction: u.restriction,
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
            })),
            floorplanImage: this.floorplanImage,
            createdAt: new Date().toISOString()
        };

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
                this.showToast('Project saved successfully!', 'success');
            } else {
                this.showToast('Save failed: ' + result.error, 'error');
            }
        } catch (error) {
            this.showToast('Save error: ' + error.message, 'error');
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
            this.showToast('Error loading projects: ' + error.message, 'error');
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
                    const rect = new fabric.Rect({
                        left: 100,
                        top: 100,
                        width: 100,
                        height: 100,
                        fill: 'rgba(0, 120, 212, 0.3)',
                        stroke: '#0078d4',
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
            this.showToast('Project loaded successfully!', 'success');
        } catch (error) {
            this.showToast('Error loading project: ' + error.message, 'error');
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
            
            document.getElementById('projectName').value = '';
            document.getElementById('buildingName').value = '';
            document.getElementById('venueCoords').value = '0, 0';
            
            this.renderLevelsList();
            this.updateCounts();
            this.clearSelection();
            this.showToast('New project started', 'info');
        }
    }

    async exportIMDF() {
        const projectName = document.getElementById('projectName').value || 'Untitled Project';
        
        const projectData = {
            venue: {
                id: this.generateUUID(),
                name: projectName,
                coordinates: this.parseCoordinates(document.getElementById('venueCoords').value)
            },
            building: {
                id: this.generateUUID(),
                name: document.getElementById('buildingName').value || 'Building',
                coordinates: this.getBuildingCoordinates()
            },
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                coordinates: this.getLevelCoordinates()
            })),
            units: this.units.map(u => ({
                id: u.id,
                name: u.name,
                category: u.category,
                restriction: u.restriction,
                exchangeId: u.exchangeId || '',
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
            })),
            anchors: []
        };

        try {
            const response = await fetch('/api/generate-imdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectData })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'imdf-export.zip';
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                this.showToast('IMDF files exported successfully!', 'success');
            } else {
                this.showToast('Export failed', 'error');
            }
        } catch (error) {
            this.showToast('Export error: ' + error.message, 'error');
        }
    }

    // ── Toast notification helper ────────────────────────────────
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const icons = { success: '✓', error: '✕', info: 'ℹ' };
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${message}</span>`;
        container.appendChild(toast);

        const dismiss = () => {
            toast.classList.add('removing');
            toast.addEventListener('animationend', () => toast.remove(), { once: true });
        };
        setTimeout(dismiss, 4000);
        toast.addEventListener('click', dismiss);
    }

    // ── UUID generator ───────────────────────────────────────────
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
        if (!obj) return [[[0, 0], [0, 0.0001], [0.0001, 0.0001], [0.0001, 0], [0, 0]]];

        // Fabric Polygon — export its actual vertices
        if (obj.type === 'polygon' && obj.points) {
            const coords = obj.points.map(p => [
                (obj.left + p.x - (obj.pathOffset ? obj.pathOffset.x : 0)) / 100000,
                (obj.top  + p.y - (obj.pathOffset ? obj.pathOffset.y : 0)) / 100000
            ]);
            // Close the ring
            if (coords.length > 0) coords.push(coords[0]);
            return [coords];
        }

        // Fabric Rect (legacy rectangle units)
        const left   = obj.left / 100000;
        const top    = obj.top  / 100000;
        const width  = (obj.width  * (obj.scaleX || 1)) / 100000;
        const height = (obj.height * (obj.scaleY || 1)) / 100000;
        
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
        document.getElementById('levelCount').textContent = this.levels.length;
        document.getElementById('unitCount').textContent = this.units.length;
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
