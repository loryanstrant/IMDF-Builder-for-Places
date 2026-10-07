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

        // Georeferencing — canvas pixels to WGS84 (see public/js/geo.js)
        this.geo = new Georeference({});
        this.calibrationPoints = [];

        // Multi-page PDF floor plans: the uploaded document, plus the page each
        // level was traced from.
        this.pdfSource = null;      // { path, pageCount }
        this.pendingPageChoice = null;

        // Polygon drawing state
        this.polyPoints = [];       // vertices collected so far
        this.polyLines = [];        // preview line objects on canvas
        this.polyDots = [];         // vertex dot objects on canvas
        this.previewLine = null;    // rubber-band line tracking mouse

        // Polygon vertex editing
        this.vertexHandles = null;  // array of handle circles for selected polygon

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
        this.initGeoControls();
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

        // ── Panning (ALT + drag) and zoom (mouse wheel) ──────────────
        let isPanning = false;
        let lastPosX = 0;
        let lastPosY = 0;

        this.canvas.on('mouse:down', (opt) => {
            if (opt.e.altKey) {
                isPanning = true;
                lastPosX = opt.e.clientX;
                lastPosY = opt.e.clientY;
                this.canvas.selection = false;
            }
        });

        this.canvas.on('mouse:move', (opt) => {
            if (!isPanning) return;

            const e = opt.e;
            const vpt = this.canvas.viewportTransform;

            vpt[4] += e.clientX - lastPosX;
            vpt[5] += e.clientY - lastPosY;

            this.canvas.requestRenderAll();

            lastPosX = e.clientX;
            lastPosY = e.clientY;
        });

        this.canvas.on('mouse:up', () => {
            if (!isPanning) return;
            isPanning = false;
            // Restore rubber-band selection, which panning disabled
            this.canvas.selection = this.currentTool === 'select';
        });

        // Zoom to cursor with the mouse wheel
        this.canvas.on('mouse:wheel', (opt) => {
            const delta = opt.e.deltaY;

            let zoom = this.canvas.getZoom();

            zoom *= Math.pow(0.999, delta);

            if (zoom > 10) zoom = 10;
            if (zoom < 0.1) zoom = 0.1;

            this.canvas.zoomToPoint(
                {
                    x: opt.e.offsetX,
                    y: opt.e.offsetY
                },
                zoom
            );
            if (this.vertexHandles) {

                const radius = Math.max(2, 6 / zoom);

                this.vertexHandles.forEach(handle => {
                    handle.set({
                        radius: radius,
                        strokeWidth: Math.max(1, 2 / zoom)
                    });
                });

            }

            opt.e.preventDefault();
            opt.e.stopPropagation();
        });

        window.addEventListener('keydown', (e) => {
            // Never hijack keys while the user is typing into a form field
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

            if (e.key === 'Delete') this.deleteSelected();
            if (e.key === 'Escape') this.cancelPolygon();
        });

        // When a polygon vertex handle moves, update the polygon points
        this.canvas.on('object:moving', (e) => {
            const obj = e.target;
            if (obj && obj._vertexHandle) {
                this.updatePolygonVertex(obj);
            }
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

        // Georeferencing controls
        ['venueCoords', 'geoScale', 'geoRotation'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => {
                this.syncGeoFromInputs();
                this.updateGeoReadout();
            });
        });

        const calibrateBtn = document.getElementById('calibrateScaleBtn');
        if (calibrateBtn) calibrateBtn.addEventListener('click', () => this.startCalibration());

        const anchorBtn = document.getElementById('setAnchorBtn');
        if (anchorBtn) anchorBtn.addEventListener('click', () => this.startAnchorPick());

        // Modal close buttons
        document.querySelectorAll('.close').forEach(btn => {
            btn.addEventListener('click', () => {
                const modal = btn.closest('.modal');
                if (modal) modal.style.display = 'none';
            });
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
        if (!event.pointer) return;
        if (event.e.altKey) return; // panning

        // Georeferencing tools come first: they work before any level exists and
        // must still fire when the click lands on an existing shape.
        if (this.currentTool === 'calibrate' || this.currentTool === 'anchor') {
            const p = this.canvas.getPointer(event.e);
            if (this.currentTool === 'calibrate') this.handleCalibrationClick(p);
            else this.handleAnchorClick(p);
            return;
        }

        if (this.currentTool === 'select') return;
        if (event.target) return; // clicking an existing object
        if (event.target && event.target._vertexHandle) return;

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
        const point = fabric.util.transformPoint(
            new fabric.Point(snapped.x, snapped.y),
            this.canvas.viewportTransform
        );

        el.style.left = point.x + 'px';
        el.style.top = point.y + 'px';
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
            if (Math.sqrt(dx * dx + dy * dy) < CLOSE_RADIUS) {
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
            radius: Math.max(2, 6 / this.canvas.getZoom()),
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

            const w = el.naturalWidth || el.width || 800;
            const h = el.naturalHeight || el.height || 600;

            this.snapCanvas = document.createElement('canvas');
            this.snapCanvas.width = w;
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
        const bgLeft = bg.left || 0;
        const bgTop = bg.top || 0;
        const bgW = (bg._originalElement ? (bg._originalElement.naturalWidth || bg.width) : bg.width) || 1;
        const bgH = (bg._originalElement ? (bg._originalElement.naturalHeight || bg.height) : bg.height) || 1;
        const bgOriginX = bgLeft - (bgW * bgScaleX) / 2;
        const bgOriginY = bgTop - (bgH * bgScaleY) / 2;

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
        const x0 = Math.max(0, cx - r), x1 = Math.min(this.snapCanvas.width - 1, cx + r);
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
                const r_val = data[idx], g_val = data[idx + 1], b_val = data[idx + 2];
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
            radius: Math.max(2, 15 / this.canvas.getZoom()),
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
        // Show vertex handles when a polygon is selected in select mode
        if (obj && obj.type === 'polygon' && this.currentTool === 'select') {
            this.showVertexHandles(obj);
        } else {
            this.removeVertexHandles();
        }
    }

    clearSelection() {
        this.selectedObject = null;
        this.removeVertexHandles();
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

        // Vertex-edit tip for polygons
        if (data.type === 'unit' && this.selectedObject && this.selectedObject.type === 'polygon') {
            html += `<p class="hint" style="margin-bottom:8px">🔴 Drag the orange dots to reshape the room.</p>`;
        }

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

        // Remove vertex handles before deleting
        this.removeVertexHandles();

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

    addLevel(options) {
        const opts = options || {};
        const nameInput = document.getElementById('levelName');
        const ordinalInput = document.getElementById('levelOrdinal');

        const name = opts.name || nameInput.value || `Level ${this.levels.length}`;
        const ordinal = Number.isFinite(opts.ordinal)
            ? opts.ordinal
            : (parseInt(ordinalInput.value, 10) || this.levels.length);

        const level = {
            id: this.generateUUID(),
            name: name,
            ordinal: ordinal,
            short_name: String(ordinal),
            outdoor: false,
            // Levels remember which page of the uploaded plan they were traced
            // from, so a multi-page PDF can carry a whole building (issue #13).
            floorplan: opts.floorplan || (this.activePlan ? { ...this.activePlan } : null)
        };

        this.levels.push(level);
        this.renderLevelsList();
        this.updateCounts();

        if (!opts.deferSelect) {
            this.selectLevel(level);
        }

        nameInput.value = '';
        ordinalInput.value = this.levels.length;
        return level;
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

    async selectLevel(level) {
        this.currentLevel = level;
        this.renderLevelsList();
        this.updateCanvasInfo(`Current Level: ${level.name}`);

        // Each level can be traced from its own page of a multi-page PDF.
        const plan = level.floorplan;
        if (plan && plan.path) {
            const same = this.activePlan &&
                this.activePlan.path === plan.path &&
                this.activePlan.page === plan.page;
            if (!same) {
                try {
                    await this.loadFloorplanToCanvas(plan.path, plan.page);
                    this.activePlan = { path: plan.path, page: plan.page };
                } catch (err) {
                    this.showToast('Could not load this level\'s floor plan: ' + err.message, 'error');
                }
            }
        }

        this.applyLevelVisibility();
    }

    // Show only the items belonging to the current level. With one level (or
    // none) everything stays visible, so single-floor projects are unaffected.
    applyLevelVisibility() {
        const showAll = this.levels.length <= 1 || !this.currentLevel;
        const currentId = this.currentLevel && this.currentLevel.id;

        this.canvas.getObjects().forEach(obj => {
            if (!obj.imdfData) return;
            const visible = showAll || obj.imdfData.levelId === currentId;
            obj.set({ visible, evented: visible, selectable: visible });
        });

        if (this.selectedObject && !this.selectedObject.visible) {
            this.canvas.discardActiveObject();
            this.clearSelection();
        }
        this.canvas.renderAll();
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
        this.applyLevelVisibility();
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

            if (!response.ok || !result.success) {
                this.showToast('Upload failed: ' + (result.error || `HTTP ${response.status}`), 'error');
                return;
            }

            this.floorplanImage = result.path;

            const pageCount = await this.getPdfPageCount(result.path);
            this.pdfSource = pageCount > 0 ? { path: result.path, pageCount } : null;

            if (pageCount > 1) {
                // A multi-page PDF is usually one page per floor.
                await this.showPdfPageModal();
            } else {
                await this.loadFloorplanToCanvas(result.path, 1);
                this.activePlan = { path: result.path, page: 1 };
                if (this.currentLevel) this.currentLevel.floorplan = { ...this.activePlan };
                this.showToast('Floor plan uploaded successfully!', 'success');
            }
        } catch (error) {
            this.showToast('Upload error: ' + error.message, 'error');
        }
    }

    // Parse a fetch response as JSON, tolerating a non-JSON body (e.g. an HTML
    // error page from a proxy or a crashed server) instead of throwing the
    // confusing "JSON.parse: unexpected character" error reported in issue #4.
    async parseJsonResponse(response) {
        const text = await response.text();
        try {
            return text ? JSON.parse(text) : {};
        } catch {
            return { error: `Server returned a non-JSON response (HTTP ${response.status})` };
        }
    }

    // ── Multi-page PDF floor plans (issue #13) ────────────────────

    async getPdfPageCount(url) {
        if (!/\.pdf($|\?)/i.test(url) || !window.pdfjsLib) return 0;
        try {
            const pdf = await pdfjsLib.getDocument(url).promise;
            return pdf.numPages;
        } catch {
            return 0;
        }
    }

    async showPdfPageModal() {
        const modal = document.getElementById('pdfPageModal');
        const grid = document.getElementById('pdfPageGrid');
        const summary = document.getElementById('pdfPageSummary');
        if (!modal || !grid) {
            // No modal in the DOM — fall back to page 1 rather than failing.
            await this.loadFloorplanToCanvas(this.pdfSource.path, 1);
            this.activePlan = { path: this.pdfSource.path, page: 1 };
            return;
        }

        const { path, pageCount } = this.pdfSource;
        summary.textContent = `This PDF has ${pageCount} pages. Pick the page for the current level, or create one level per page.`;
        grid.innerHTML = '<p class="hint">Rendering previews…</p>';
        modal.style.display = 'block';

        const thumbs = [];
        for (let page = 1; page <= pageCount; page++) {
            thumbs.push(await this.renderPdfToDataUrl(path, page, 0.35));
        }

        grid.innerHTML = '';
        thumbs.forEach((src, i) => {
            const page = i + 1;
            const card = document.createElement('div');
            card.className = 'pdf-page-card';
            const img = document.createElement('img');
            img.src = src;
            img.alt = `Page ${page}`;
            const label = document.createElement('span');
            label.textContent = `Page ${page}`;
            card.appendChild(img);
            card.appendChild(label);
            card.addEventListener('click', async () => {
                await this.usePdfPage(page);
                modal.style.display = 'none';
            });
            grid.appendChild(card);
        });

        const bulkBtn = document.getElementById('pdfCreateLevelsBtn');
        if (bulkBtn) {
            bulkBtn.onclick = async () => {
                await this.createLevelPerPdfPage();
                modal.style.display = 'none';
            };
        }
    }

    async usePdfPage(page) {
        const { path } = this.pdfSource;
        await this.loadFloorplanToCanvas(path, page);
        this.activePlan = { path, page };
        if (this.currentLevel) {
            this.currentLevel.floorplan = { ...this.activePlan };
        }
        this.showToast(`Using page ${page} of the PDF`, 'success');
    }

    async createLevelPerPdfPage() {
        const { path, pageCount } = this.pdfSource;
        const base = this.levels.length;

        for (let page = 1; page <= pageCount; page++) {
            const ordinal = base + page - 1;
            this.addLevel({
                name: `Level ${ordinal}`,
                ordinal,
                floorplan: { path, page },
                deferSelect: true
            });
        }

        this.renderLevelsList();
        await this.selectLevel(this.levels[base]);
        this.updateCounts();
        this.showToast(`Created ${pageCount} levels, one per PDF page`, 'success');
    }

    async loadFloorplanToCanvas(imageUrl, page) {
        // A PDF can't be drawn as an <img>; rasterize the requested page first
        // (issue #4 for PDFs at all, issue #13 for pages beyond the first).
        const isPdf = /\.pdf($|\?)/i.test(imageUrl);
        const isSvg = /\.svg($|\?)/i.test(imageUrl);

        if (isSvg) {
            await this.loadSvgToCanvas(imageUrl);
            return;
        }

        const sourceUrl = isPdf
            ? await this.renderPdfToDataUrl(imageUrl, page || 1)
            : imageUrl;

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

    async renderPdfToDataUrl(pdfUrl, pageNumber, scale) {
        if (!window.pdfjsLib) {
            throw new Error('PDF support failed to load. Please refresh and try again.');
        }
        const pdf = await pdfjsLib.getDocument(pdfUrl).promise;
        const page = Math.min(Math.max(parseInt(pageNumber, 10) || 1, 1), pdf.numPages);
        const pdfPage = await pdf.getPage(page);
        // Render at 2x so the background stays crisp when zoomed in; thumbnails
        // pass a smaller scale.
        const viewport = pdfPage.getViewport({ scale: scale || 2 });
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = viewport.width;
        tmpCanvas.height = viewport.height;
        await pdfPage.render({ canvasContext: tmpCanvas.getContext('2d'), viewport }).promise;
        return tmpCanvas.toDataURL('image/png');
    }

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
            this.canvas.width / srcW,
            this.canvas.height / srcH
        ) * 0.9;

        bg.scale(scale);
        bg.set({
            left: this.canvas.width / 2,
            top: this.canvas.height / 2,
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

    // Everything needed to rebuild the project: the IMDF coordinates for export
    // AND the canvas geometry for redrawing (issue #12).
    collectProjectData() {
        this.syncGeoFromInputs();
        const projectName = document.getElementById('projectName').value || 'Untitled Project';

        return {
            schemaVersion: IMDFBuilder.SCHEMA_VERSION,
            projectName: projectName,
            georeference: this.geo.toJSON(),
            venue: {
                name: projectName,
                category: 'businesscampus',
                coordinates: [this.geo.lon, this.geo.lat]
            },
            building: {
                name: document.getElementById('buildingName').value || 'Building'
            },
            address: this.collectAddress(),
            levels: this.levels.map(l => ({
                id: l.id,
                name: l.name,
                ordinal: l.ordinal,
                short_name: l.short_name,
                outdoor: !!l.outdoor,
                floorplan: l.floorplan || null
            })),
            units: this.units.map(u => ({
                id: u.id,
                type: 'unit',
                name: u.name,
                category: u.category,
                restriction: u.restriction,
                exchangeId: u.exchangeId || '',
                levelId: u.levelId,
                canvas: this.captureCanvasState(u.fabricObject),
                coordinates: this.getObjectCoordinates(u.fabricObject),
                display_point: this.getDisplayPoint(u.fabricObject)
            })),
            amenities: this.amenities.map(a => ({
                id: a.id,
                type: 'amenity',
                name: a.name,
                category: a.category,
                levelId: a.levelId,
                canvas: this.captureCanvasState(a.fabricObject),
                coordinates: this.getPointCoordinates(a.fabricObject)
            })),
            fixtures: this.fixtures.map(f => ({
                id: f.id,
                type: 'fixture',
                category: f.category,
                levelId: f.levelId,
                canvas: this.captureCanvasState(f.fabricObject),
                coordinates: this.getLineCoordinates(f.fabricObject)
            })),
            openings: this.openings.map(o => ({
                id: o.id,
                type: 'opening',
                category: o.category,
                door: o.door || 'yes',
                levelId: o.levelId,
                canvas: this.captureCanvasState(o.fabricObject),
                coordinates: this.getLineCoordinates(o.fabricObject)
            })),
            floorplanImage: this.floorplanImage,
            createdAt: new Date().toISOString()
        };
    }

    collectAddress() {
        const val = id => {
            const el = document.getElementById(id);
            return el && el.value.trim() ? el.value.trim() : null;
        };
        const address = {
            address: val('addrStreet'),
            locality: val('addrLocality'),
            province: val('addrProvince'),
            country: val('addrCountry'),
            postal_code: val('addrPostcode')
        };
        return Object.values(address).some(Boolean) ? address : null;
    }

    applyAddress(address) {
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        };
        const a = address || {};
        set('addrStreet', a.address);
        set('addrLocality', a.locality);
        set('addrProvince', a.province);
        set('addrCountry', a.country);
        set('addrPostcode', a.postal_code);
    }

    async saveProject() {
        const projectData = this.collectProjectData();

        try {
            const response = await fetch('/api/projects/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: this.projectId,
                    projectName: projectData.projectName,
                    projectData: projectData
                })
            });

            const result = await this.parseJsonResponse(response);

            if (response.ok && result.success) {
                this.projectId = result.projectId;
                this.showToast('Project saved successfully!', 'success');
            } else {
                this.showToast('Save failed: ' + (result.error || `HTTP ${response.status}`), 'error');
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
                        <h3></h3>
                        <p>Updated: </p>
                    `;
                    item.querySelector('h3').textContent = project.name || 'Untitled Project';
                    item.querySelector('p').textContent =
                        'Updated: ' + new Date(project.updatedAt).toLocaleString();
                    item.addEventListener('click', () => this.loadProject(project.id));
                    list.appendChild(item);
                });
            }

            document.getElementById('loadProjectModal').style.display = 'block';
        } catch (error) {
            this.showToast('Error loading projects: ' + error.message, 'error');
        }
    }

    // Rebuild a Fabric object from the canvas state stored at save time.
    // Falls back to re-projecting the IMDF coordinates for pre-v2 projects, and
    // only then to a placeholder.
    rebuildFabricObject(item, kind) {
        const state = item.canvas;
        const styles = {
            unit: { fill: 'rgba(0, 120, 212, 0.3)', stroke: '#0078d4', strokeWidth: 2 },
            amenity: { fill: 'rgba(40, 167, 69, 0.5)', stroke: '#28a745', strokeWidth: 2 },
            fixture: { stroke: '#6c757d', strokeWidth: 3 },
            opening: { stroke: '#dc3545', strokeWidth: 4 }
        };
        const style = styles[kind] || styles.unit;

        const common = state ? {
            left: state.left,
            top: state.top,
            angle: state.angle || 0,
            scaleX: state.scaleX || 1,
            scaleY: state.scaleY || 1
        } : {};

        if (kind === 'unit') {
            if (state && state.type === 'polygon' && state.points && state.points.length >= 3) {
                return new fabric.Polygon(state.points.map(p => ({ x: p.x, y: p.y })), {
                    ...style, ...common, objectCaching: false
                });
            }
            if (state && state.type === 'rect') {
                return new fabric.Rect({ ...style, ...common, width: state.width, height: state.height });
            }
            // Pre-v2 project: re-project the stored lon/lat ring back to canvas.
            const ring = item.coordinates && item.coordinates[0];
            if (ring && ring.length >= 3) {
                const points = ring.slice(0, -1).map(([lon, lat]) => this.geo.toCanvas(lon, lat));
                if (points.length >= 3) {
                    return new fabric.Polygon(points, { ...style, objectCaching: false });
                }
            }
            return new fabric.Rect({ ...style, left: 100, top: 100, width: 100, height: 100 });
        }

        if (kind === 'amenity') {
            const radius = (state && state.radius) || Math.max(2, 15 / this.canvas.getZoom());
            if (state) {
                return new fabric.Circle({ ...style, ...common, radius });
            }
            const c = item.coordinates
                ? this.geo.toCanvas(item.coordinates[0], item.coordinates[1])
                : { x: 200, y: 200 };
            return new fabric.Circle({ ...style, left: c.x, top: c.y, radius });
        }

        // Fixtures and openings are lines. These were never restored at all
        // before — the load path simply had no loop for them (issue #12).
        let x1, y1, x2, y2;
        if (state && state.x1 !== undefined) {
            x1 = state.x1; y1 = state.y1; x2 = state.x2; y2 = state.y2;
        } else if (item.coordinates && item.coordinates.length >= 2) {
            const a = this.geo.toCanvas(item.coordinates[0][0], item.coordinates[0][1]);
            const b = this.geo.toCanvas(item.coordinates[1][0], item.coordinates[1][1]);
            x1 = a.x; y1 = a.y; x2 = b.x; y2 = b.y;
        } else {
            x1 = 100; y1 = 100; x2 = 150; y2 = 100;
        }
        return new fabric.Line([x1, y1, x2, y2], style);
    }

    restoreCollection(items, kind, target) {
        (items || []).forEach(item => {
            const obj = this.rebuildFabricObject(item, kind);
            const record = { ...item, type: kind, fabricObject: obj };
            delete record.canvas;
            obj.imdfData = record;
            target.push(record);
            this.canvas.add(obj);
        });
    }

    async loadProject(projectId) {
        try {
            const response = await fetch(`/api/projects/${projectId}`);
            const project = await this.parseJsonResponse(response);
            if (!response.ok) {
                throw new Error(project.error || `HTTP ${response.status}`);
            }

            const data = project.data || {};

            // Clear current state
            this.removeVertexHandles();
            this.canvas.clear();
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;

            this.projectId = project.id;
            document.getElementById('projectName').value = project.name || '';
            document.getElementById('buildingName').value =
                (data.building && data.building.name) || 'Building';

            // Georeferencing. Pre-v2 projects only stored a venue point, so seed
            // the anchor from that and leave the scale uncalibrated.
            if (data.georeference) {
                this.geo = new Georeference(data.georeference);
            } else if (data.venue && Array.isArray(data.venue.coordinates)) {
                this.geo = new Georeference({
                    lon: data.venue.coordinates[0],
                    lat: data.venue.coordinates[1]
                });
            } else {
                this.geo = new Georeference({});
            }
            this.applyGeoToInputs();
            this.applyAddress(data.address);

            // Floor plan
            this.floorplanImage = data.floorplanImage || null;
            if (this.floorplanImage) {
                try {
                    await this.loadFloorplanToCanvas(this.floorplanImage);
                } catch (err) {
                    this.showToast('Floor plan could not be reloaded: ' + err.message, 'error');
                }
            }

            // Levels
            this.levels = (data.levels || []).map(l => ({ ...l }));

            // Items — order matters only for the counts, but all four types must
            // be restored. The old code dropped fixtures and openings entirely
            // and rebuilt every unit as a 100x100 box at (100, 100).
            this.restoreCollection(data.units, 'unit', this.units);
            this.restoreCollection(data.amenities, 'amenity', this.amenities);
            this.restoreCollection(data.fixtures, 'fixture', this.fixtures);
            this.restoreCollection(data.openings, 'opening', this.openings);

            this.renderLevelsList();
            if (this.levels.length > 0) {
                // Select the level last, so its visibility filter applies to the
                // items that were just added.
                await this.selectLevel(this.levels[0]);
            } else {
                this.applyLevelVisibility();
            }

            this.updateCounts();
            this.canvas.renderAll();
            document.getElementById('loadProjectModal').style.display = 'none';

            const restored = this.units.length + this.amenities.length +
                this.fixtures.length + this.openings.length;
            this.showToast(`Project loaded — ${restored} item${restored === 1 ? '' : 's'} restored`, 'success');
        } catch (error) {
            this.showToast('Error loading project: ' + error.message, 'error');
        }
    }

    newProject() {
        if (confirm('Start a new project? Any unsaved changes will be lost.')) {
            this.removeVertexHandles();
            this.canvas.clear();
            this.canvas.backgroundImage = null;
            this.levels = [];
            this.units = [];
            this.amenities = [];
            this.fixtures = [];
            this.openings = [];
            this.currentLevel = null;
            this.projectId = null;
            this.floorplanImage = null;
            this.pdfSource = null;
            this.geo = new Georeference({});

            document.getElementById('projectName').value = '';
            document.getElementById('buildingName').value = '';
            this.applyGeoToInputs();
            this.applyAddress(null);

            this.renderLevelsList();
            this.updateCounts();
            this.clearSelection();
            this.canvas.renderAll();
            this.showToast('New project started', 'info');
        }
    }

    // Warn about anything that would make Microsoft Places reject the upload.
    exportWarnings() {
        const warnings = [];
        if (!this.geo.calibrated) {
            warnings.push('the plan scale has not been calibrated, so room sizes will be wrong');
        }
        if (this.geo.lat === 0 && this.geo.lon === 0) {
            warnings.push('the venue anchor is still 0, 0');
        }
        if (this.levels.length === 0) {
            warnings.push('there are no levels');
        }
        if (this.units.length === 0) {
            warnings.push('there are no units/rooms');
        }
        const orphans = this.units.filter(u => !this.levels.some(l => l.id === u.levelId)).length;
        if (orphans > 0) {
            warnings.push(`${orphans} unit${orphans === 1 ? '' : 's'} reference a level that no longer exists`);
        }
        return warnings;
    }

    async exportIMDF() {
        const warnings = this.exportWarnings();
        if (warnings.length > 0) {
            const proceed = confirm(
                'This export may be rejected by Microsoft Places because:\n\n  • ' +
                warnings.join('\n  • ') +
                '\n\nExport anyway?'
            );
            if (!proceed) return;
        }

        const saved = this.collectProjectData();

        const projectData = {
            language: 'en',
            venue: {
                id: this.generateUUID(),
                name: saved.projectName,
                category: 'businesscampus',
                coordinates: saved.venue.coordinates
            },
            building: {
                id: this.generateUUID(),
                name: saved.building.name
            },
            address: saved.address,
            levels: saved.levels,
            units: saved.units.filter(u => u.coordinates),
            amenities: saved.amenities.filter(a => a.coordinates),
            fixtures: saved.fixtures.filter(f => f.coordinates),
            openings: saved.openings.filter(o => o.coordinates),
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
                const result = await this.parseJsonResponse(response);
                this.showToast('Export failed: ' + (result.error || `HTTP ${response.status}`), 'error');
            }
        } catch (error) {
            this.showToast('Export error: ' + error.message, 'error');
        }
    }

    // ── Polygon vertex editing ────────────────────────────────────

    showVertexHandles(polygon) {
        this.removeVertexHandles();

        // Disable the polygon's own transform controls while editing vertices
        polygon.set({
            hasControls: false,
            hasBorders: false,
            lockMovementX: true,
            lockMovementY: true
        });
        this.canvas.renderAll();

        const points = polygon.points;
        if (!points) return;

        // pathOffset is the polygon's internal origin used by Fabric
        const ox = polygon.pathOffset ? polygon.pathOffset.x : 0;
        const oy = polygon.pathOffset ? polygon.pathOffset.y : 0;

        this.vertexHandles = points.map((pt, i) => {
            const handle = new fabric.Circle({
                left: polygon.left + pt.x - ox,
                top: polygon.top + pt.y - oy,
                radius: Math.max(2, 6 / this.canvas.getZoom()),
                fill: '#ff5c00',
                stroke: '#ffffff',
                strokeWidth: 2,
                originX: 'center',
                originY: 'center',
                hasControls: false,
                hasBorders: false,
                selectable: true,
                evented: true,
                _vertexHandle: true,
                _polygon: polygon,
                _vertexIndex: i
            });
            this.canvas.add(handle);
            return handle;
        });

        this.canvas.renderAll();
    }

    removeVertexHandles() {
        if (!this.vertexHandles) return;
        this.vertexHandles.forEach(h => this.canvas.remove(h));
        this.vertexHandles = null;

        // Re-enable transform controls on the previously-edited polygon
        if (this.selectedObject && this.selectedObject.type === 'polygon') {
            this.selectedObject.set({
                hasControls: true,
                hasBorders: true,
                lockMovementX: false,
                lockMovementY: false
            });
            this.canvas.renderAll();
        }
    }

    updatePolygonVertex(handle) {
        const polygon = handle._polygon;
        const i = handle._vertexIndex;
        if (!polygon || i === undefined) return;

        const ox = polygon.pathOffset ? polygon.pathOffset.x : 0;
        const oy = polygon.pathOffset ? polygon.pathOffset.y : 0;

        // Snap to edge if enabled
        const raw = { x: handle.left, y: handle.top };
        const snapped = this.snapEnabled ? this.snapToEdge(raw) : raw;

        // Move handle to snapped position
        handle.set({ left: snapped.x, top: snapped.y });

        // Update the polygon's point — coords are relative to polygon.left/top minus pathOffset
        polygon.points[i] = {
            x: snapped.x - polygon.left + ox,
            y: snapped.y - polygon.top + oy
        };

        // Force Fabric to recompute the polygon geometry
        polygon.set({ dirty: true });
        this.canvas.renderAll();
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

    // ── Georeferencing controls ───────────────────────────────────

    initGeoControls() {
        this.applyGeoToInputs();
    }

    applyGeoToInputs() {
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        };
        set('venueCoords', `${this.geo.lat}, ${this.geo.lon}`);
        set('geoScale', this.geo.metresPerPixel.toFixed(4));
        set('geoRotation', this.geo.rotation);
        this.updateGeoReadout();
    }

    syncGeoFromInputs() {
        const coordsEl = document.getElementById('venueCoords');
        if (coordsEl) {
            const parsed = this.parseCoordinates(coordsEl.value);
            if (parsed) {
                this.geo.lat = parsed.lat;
                this.geo.lon = parsed.lon;
            }
        }

        const scaleEl = document.getElementById('geoScale');
        if (scaleEl) {
            const scale = parseFloat(scaleEl.value);
            if (isFinite(scale) && scale > 0) this.geo.metresPerPixel = scale;
        }

        const rotEl = document.getElementById('geoRotation');
        if (rotEl) {
            const rot = parseFloat(rotEl.value);
            if (isFinite(rot)) this.geo.rotation = rot;
        }

        // The anchor defaults to the centre of the floor plan, which is where
        // the venue coordinate is assumed to sit until the user picks a point.
        if (!this.geo.anchorX && !this.geo.anchorY) {
            this.geo.anchorX = this.canvas.width / 2;
            this.geo.anchorY = this.canvas.height / 2;
        }
    }

    updateGeoReadout() {
        const el = document.getElementById('geoReadout');
        if (!el) return;
        const scale = this.geo.metresPerPixel;
        el.textContent = this.geo.calibrated
            ? `● Calibrated — 1 px = ${scale.toFixed(4)} m`
            : `○ Not calibrated — assuming 1 px = ${scale.toFixed(4)} m`;
        el.classList.toggle('geo-ok', this.geo.calibrated);
    }

    startCalibration() {
        this.calibrationPoints = [];
        this.clearCalibrationMarkers();
        this.setTool('calibrate');
        this.showDrawingHint('Calibrate scale: click two points a known distance apart on the plan.');
        this.showToast('Click the first of two points whose real distance you know', 'info');
    }

    handleCalibrationClick(pointer) {
        this.calibrationPoints.push({ x: pointer.x, y: pointer.y });
        this.addCalibrationMarker(pointer);

        if (this.calibrationPoints.length < 2) {
            this.showDrawingHint('Now click the second point.');
            return;
        }

        const [p1, p2] = this.calibrationPoints;
        const answer = prompt('How far apart are those two points, in metres?', '10');
        this.calibrationPoints = [];
        this.clearCalibrationMarkers();
        this.setTool('select');

        const metres = parseFloat(answer);
        if (!isFinite(metres) || metres <= 0) {
            this.showToast('Calibration cancelled', 'info');
            return;
        }

        try {
            this.geo.calibrateFromPoints(p1, p2, metres);
            this.applyGeoToInputs();
            this.showToast(`Scale set: 1 px = ${this.geo.metresPerPixel.toFixed(4)} m`, 'success');
        } catch (error) {
            this.showToast(error.message, 'error');
        }
    }

    startAnchorPick() {
        this.setTool('anchor');
        this.showDrawingHint('Click the point on the plan that matches the venue latitude/longitude.');
        this.showToast('Click the point matching your venue coordinates', 'info');
    }

    handleAnchorClick(pointer) {
        this.syncGeoFromInputs();
        this.geo.anchorX = pointer.x;
        this.geo.anchorY = pointer.y;
        this.setTool('select');
        this.clearCalibrationMarkers();
        this.addCalibrationMarker(pointer, '#0078d4', true);
        this.showToast(`Anchor set to ${this.geo.lat}, ${this.geo.lon}`, 'success');
        this.updateGeoReadout();
    }

    addCalibrationMarker(pointer, colour, persist) {
        const marker = new fabric.Circle({
            left: pointer.x,
            top: pointer.y,
            radius: Math.max(3, 7 / this.canvas.getZoom()),
            fill: colour || '#ff5c00',
            stroke: '#fff',
            strokeWidth: 1.5,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            excludeFromExport: true
        });
        marker._calibrationMarker = true;
        marker._persistentMarker = !!persist;
        this.canvas.add(marker);
        this.canvas.renderAll();
    }

    clearCalibrationMarkers(includePersistent) {
        this.canvas.getObjects()
            .filter(o => o._calibrationMarker && (includePersistent || !o._persistentMarker))
            .forEach(o => this.canvas.remove(o));
        this.canvas.renderAll();
    }

    // ── UUID generator ───────────────────────────────────────────
    generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    parseCoordinates(str) {
        // The field is typed "lat, lon" (the order people read off a map), but
        // GeoJSON wants [lon, lat].
        const parts = String(str || '').split(',').map(v => parseFloat(v.trim()));
        if (parts.length !== 2 || !isFinite(parts[0]) || !isFinite(parts[1])) return null;
        return { lat: parts[0], lon: parts[1] };
    }

    // ── Canvas geometry -> WGS84 ──────────────────────────────────
    // Every exported coordinate goes through this.geo, so the output lands on
    // the real site instead of near [0, 0] off the coast of Africa.

    // Absolute canvas-space vertices of a Fabric polygon, honouring any move,
    // scale or rotation applied after it was drawn.
    polygonCanvasPoints(obj) {
        if (!obj || !obj.points) return [];
        const matrix = obj.calcTransformMatrix();
        const ox = obj.pathOffset ? obj.pathOffset.x : 0;
        const oy = obj.pathOffset ? obj.pathOffset.y : 0;
        return obj.points.map(p => {
            const t = fabric.util.transformPoint(
                new fabric.Point(p.x - ox, p.y - oy),
                matrix
            );
            return { x: t.x, y: t.y };
        });
    }

    // Absolute canvas-space corners of a Fabric rectangle.
    rectCanvasPoints(obj) {
        const c = obj.aCoords || obj.calcACoords();
        return [c.tl, c.tr, c.br, c.bl].map(p => ({ x: p.x, y: p.y }));
    }

    // Absolute canvas-space endpoints of a Fabric line. obj.x1/y1 are local and
    // stale once the line has been dragged, so go through the transform matrix.
    lineCanvasPoints(obj) {
        if (!obj) return [];
        if (typeof obj.calcLinePoints === 'function') {
            const local = obj.calcLinePoints();
            const matrix = obj.calcTransformMatrix();
            const a = fabric.util.transformPoint(new fabric.Point(local.x1, local.y1), matrix);
            const b = fabric.util.transformPoint(new fabric.Point(local.x2, local.y2), matrix);
            return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
        }
        return [{ x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }];
    }

    centreCanvasPoint(obj) {
        if (!obj) return { x: 0, y: 0 };
        const c = obj.getCenterPoint ? obj.getCenterPoint() : { x: obj.left, y: obj.top };
        return { x: c.x, y: c.y };
    }

    canvasPointsToRing(points) {
        if (!points || points.length < 3) return null;
        const ring = points.map(p => this.geo.toLonLat(p.x, p.y));
        return window.geoUtils.toCounterClockwise(ring);
    }

    // Outer ring of a unit, as [[lon, lat], ...]. Returns null when the object
    // has no usable geometry rather than inventing a placeholder square.
    getObjectCoordinates(obj) {
        if (!obj) return null;
        const points = obj.type === 'polygon'
            ? this.polygonCanvasPoints(obj)
            : this.rectCanvasPoints(obj);
        const ring = this.canvasPointsToRing(points);
        return ring ? [ring] : null;
    }

    getDisplayPoint(obj) {
        if (!obj) return null;
        const c = this.centreCanvasPoint(obj);
        return { type: 'Point', coordinates: this.geo.toLonLat(c.x, c.y) };
    }

    getPointCoordinates(obj) {
        if (!obj) return null;
        const c = this.centreCanvasPoint(obj);
        return this.geo.toLonLat(c.x, c.y);
    }

    getLineCoordinates(obj) {
        const points = this.lineCanvasPoints(obj);
        if (points.length < 2) return null;
        return points.map(p => this.geo.toLonLat(p.x, p.y));
    }

    // ── Canvas state for save/load ────────────────────────────────
    // Issue #12: saved projects only kept the projected IMDF coordinates, which
    // are not enough to put a shape back on the canvas. This block is.
    captureCanvasState(obj) {
        if (!obj) return null;
        const base = {
            type: obj.type,
            left: obj.left,
            top: obj.top,
            angle: obj.angle || 0,
            scaleX: obj.scaleX || 1,
            scaleY: obj.scaleY || 1,
            originX: obj.originX,
            originY: obj.originY
        };

        if (obj.type === 'polygon' && obj.points) {
            base.points = obj.points.map(p => ({ x: p.x, y: p.y }));
            base.pathOffset = obj.pathOffset ? { x: obj.pathOffset.x, y: obj.pathOffset.y } : null;
        } else if (obj.type === 'line') {
            const pts = this.lineCanvasPoints(obj);
            base.x1 = pts[0].x; base.y1 = pts[0].y;
            base.x2 = pts[1].x; base.y2 = pts[1].y;
        } else if (obj.type === 'circle') {
            base.radius = obj.radius;
        } else {
            base.width = obj.width;
            base.height = obj.height;
        }

        return base;
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

// Saved-project schema. v1 stored only projected IMDF coordinates, which were
// not enough to redraw anything (issue #12); v2 also stores canvas geometry
// and the georeference.
IMDFBuilder.SCHEMA_VERSION = 2;

// Initialize the application
let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new IMDFBuilder();
});

