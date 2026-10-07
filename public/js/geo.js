// Georeferencing — converts Fabric canvas pixel coordinates into WGS84
// longitude/latitude pairs suitable for IMDF/GeoJSON output.
//
// Before this existed the exporter simply divided canvas pixels by 100000, so
// every exported feature landed in the Gulf of Guinea instead of on the real
// site (the root cause behind the unusable exports in issue #25).
//
// The model is a local tangent-plane ("ENU") approximation anchored on a single
// known point:
//
//   anchorX/anchorY   the canvas pixel that corresponds to a known lat/lon
//   lat, lon          the real-world coordinate of that pixel
//   metresPerPixel    the plan's scale, from a two-point calibration
//   rotation          degrees to rotate the plan clockwise onto true north
//
// Over the extent of a building (<2 km) the flat-earth approximation is good to
// well under a metre, far below the precision of a traced floor plan.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.Georeference = api.Georeference;
        root.geoUtils = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Metres per degree of latitude (mean meridional).
    const METRES_PER_DEG_LAT = 111320;
    const DEG = Math.PI / 180;

    class Georeference {
        constructor(options) {
            const o = options || {};
            this.lat = num(o.lat, 0);
            this.lon = num(o.lon, 0);
            this.anchorX = num(o.anchorX, 0);
            this.anchorY = num(o.anchorY, 0);
            // 0.05 m/px suits a page-sized plan, but it is only a placeholder
            // until the user calibrates.
            this.metresPerPixel = positive(o.metresPerPixel, 0.05);
            this.rotation = num(o.rotation, 0);
            this.calibrated = !!o.calibrated;
        }

        static fromJSON(json) {
            return new Georeference(json || {});
        }

        toJSON() {
            return {
                lat: this.lat,
                lon: this.lon,
                anchorX: this.anchorX,
                anchorY: this.anchorY,
                metresPerPixel: this.metresPerPixel,
                rotation: this.rotation,
                calibrated: this.calibrated
            };
        }

        // Metres east/north of the anchor for a canvas pixel. Canvas Y grows
        // downwards, which is why north is negated.
        toLocalMetres(x, y) {
            const dx = (num(x, 0) - this.anchorX) * this.metresPerPixel;
            const dy = (num(y, 0) - this.anchorY) * this.metresPerPixel;

            const eastPlan = dx;
            const northPlan = -dy;

            const t = this.rotation * DEG;
            const cos = Math.cos(t);
            const sin = Math.sin(t);

            return {
                east: eastPlan * cos + northPlan * sin,
                north: northPlan * cos - eastPlan * sin
            };
        }

        // Canvas pixel -> [longitude, latitude] (GeoJSON axis order).
        toLonLat(x, y) {
            const { east, north } = this.toLocalMetres(x, y);
            const lat = this.lat + north / METRES_PER_DEG_LAT;
            const mPerDegLon = METRES_PER_DEG_LAT * Math.cos(this.lat * DEG);
            const lon = this.lon + (Math.abs(mPerDegLon) < 1e-9 ? 0 : east / mPerDegLon);
            return [round7(lon), round7(lat)];
        }

        // [longitude, latitude] -> canvas pixel. Used to place geometry back on
        // the canvas when a saved project predates stored canvas coordinates.
        toCanvas(lon, lat) {
            const north = (num(lat, 0) - this.lat) * METRES_PER_DEG_LAT;
            const mPerDegLon = METRES_PER_DEG_LAT * Math.cos(this.lat * DEG);
            const east = (num(lon, 0) - this.lon) * mPerDegLon;

            const t = -this.rotation * DEG;
            const cos = Math.cos(t);
            const sin = Math.sin(t);
            const eastPlan = east * cos + north * sin;
            const northPlan = north * cos - east * sin;

            return {
                x: this.anchorX + eastPlan / this.metresPerPixel,
                y: this.anchorY - northPlan / this.metresPerPixel
            };
        }

        // Derive metres-per-pixel from two clicked points plus the real-world
        // distance between them.
        calibrateFromPoints(p1, p2, realMetres) {
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const pixels = Math.sqrt(dx * dx + dy * dy);
            if (!(pixels > 0) || !(realMetres > 0)) {
                throw new Error('Calibration needs two distinct points and a positive distance.');
            }
            this.metresPerPixel = realMetres / pixels;
            this.calibrated = true;
            return this.metresPerPixel;
        }
    }

    // ── Ring helpers ─────────────────────────────────────────────────

    // Shoelace signed area. Positive = counter-clockwise in lon/lat space.
    function signedArea(ring) {
        let sum = 0;
        for (let i = 0, n = ring.length - 1; i < n; i++) {
            const [x1, y1] = ring[i];
            const [x2, y2] = ring[i + 1];
            sum += (x2 - x1) * (y2 + y1);
        }
        return -sum / 2;
    }

    function closeRing(ring) {
        if (ring.length === 0) return ring;
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            ring.push([first[0], first[1]]);
        }
        return ring;
    }

    // RFC 7946 section 3.1.6: exterior rings MUST wind counter-clockwise.
    function toCounterClockwise(ring) {
        const closed = closeRing(ring.slice());
        if (closed.length < 4) return closed;
        if (signedArea(closed) < 0) {
            const reversed = closed.slice().reverse();
            return reversed;
        }
        return closed;
    }

    // Axis-aligned bounding ring (counter-clockwise) around a set of [lon, lat]
    // positions, optionally padded outwards by padMetres.
    function boundingRing(positions, padMetres, refLat) {
        if (!positions || positions.length === 0) return null;

        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
        for (const pos of positions) {
            const lon = pos[0], lat = pos[1];
            if (!isFinite(lon) || !isFinite(lat)) continue;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
        if (!isFinite(minLon) || !isFinite(minLat)) return null;

        const pad = num(padMetres, 0);
        if (pad > 0) {
            const lat0 = num(refLat, (minLat + maxLat) / 2);
            const dLat = pad / METRES_PER_DEG_LAT;
            const dLon = pad / Math.max(1e-9, METRES_PER_DEG_LAT * Math.cos(lat0 * DEG));
            minLon -= dLon; maxLon += dLon;
            minLat -= dLat; maxLat += dLat;
        }

        // A degenerate extent (one point, or nothing drawn yet) would be an
        // invalid polygon, so give it a minimum size.
        if (maxLon - minLon < 1e-9) { minLon -= 5e-7; maxLon += 5e-7; }
        if (maxLat - minLat < 1e-9) { minLat -= 5e-7; maxLat += 5e-7; }

        return toCounterClockwise([
            [round7(minLon), round7(minLat)],
            [round7(maxLon), round7(minLat)],
            [round7(maxLon), round7(maxLat)],
            [round7(minLon), round7(maxLat)]
        ]);
    }

    function centroidOfRing(ring) {
        if (!ring || ring.length === 0) return [0, 0];
        let sx = 0, sy = 0, n = 0;
        const last = ring.length - 1;
        // Skip the repeated closing vertex.
        const end = (ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1]) ? last : ring.length;
        for (let i = 0; i < end; i++) {
            sx += ring[i][0];
            sy += ring[i][1];
            n++;
        }
        return n ? [round7(sx / n), round7(sy / n)] : [0, 0];
    }

    // Expand a LineString into a thin rectangle. IMDF fixtures must be
    // polygonal, but the editor draws them as lines.
    function bufferLine(coords, widthMetres, refLat) {
        if (!coords || coords.length < 2) return null;
        const half = Math.max(num(widthMetres, 0.2), 0.01) / 2;
        const lat0 = num(refLat, coords[0][1]);
        const dLat = half / METRES_PER_DEG_LAT;
        const dLon = half / Math.max(1e-9, METRES_PER_DEG_LAT * Math.cos(lat0 * DEG));

        const x1 = coords[0][0], y1 = coords[0][1];
        const x2 = coords[coords.length - 1][0], y2 = coords[coords.length - 1][1];
        let ux = x2 - x1;
        let uy = y2 - y1;
        const len = Math.sqrt(ux * ux + uy * uy);
        if (len < 1e-12) {
            // Zero-length line: emit a small square so the export stays valid.
            return toCounterClockwise([
                [round7(x1 - dLon), round7(y1 - dLat)],
                [round7(x1 + dLon), round7(y1 - dLat)],
                [round7(x1 + dLon), round7(y1 + dLat)],
                [round7(x1 - dLon), round7(y1 + dLat)]
            ]);
        }
        ux /= len; uy /= len;
        // Normal in degree space, scaled per-axis back into metres.
        const nx = -uy * dLon;
        const ny = ux * dLat;

        return toCounterClockwise([
            [round7(x1 + nx), round7(y1 + ny)],
            [round7(x2 + nx), round7(y2 + ny)],
            [round7(x2 - nx), round7(y2 - ny)],
            [round7(x1 - nx), round7(y1 - ny)]
        ]);
    }

    function num(v, fallback) {
        const n = typeof v === 'string' ? parseFloat(v) : v;
        return Number.isFinite(n) ? n : fallback;
    }

    function positive(v, fallback) {
        const n = num(v, fallback);
        return n > 0 ? n : fallback;
    }

    // ~1 cm of longitude at the equator — finer than a traced plan warrants.
    function round7(n) {
        return Math.round(n * 1e7) / 1e7;
    }

    return {
        Georeference,
        METRES_PER_DEG_LAT,
        signedArea,
        closeRing,
        toCounterClockwise,
        boundingRing,
        centroidOfRing,
        bufferLine,
        round7
    };
});
