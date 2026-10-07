// A minimal stand-in for the parts of Fabric.js that the save/load path uses,
// so the issue #12 round-trip can be tested without a browser or a canvas.

function transformPoint(point, matrix) {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

class FabricObject {
  constructor(options) {
    Object.assign(this, { left: 0, top: 0, angle: 0, scaleX: 1, scaleY: 1 }, options || {});
  }
  calcTransformMatrix() {
    return [this.scaleX, 0, 0, this.scaleY, this.left, this.top];
  }
  getCenterPoint() {
    return { x: this.left + (this.width || 0) / 2, y: this.top + (this.height || 0) / 2 };
  }
  set(values) { Object.assign(this, values); return this; }
}

class Polygon extends FabricObject {
  constructor(points, options) {
    super(options);
    this.type = 'polygon';
    this.points = points.map(p => ({ x: p.x, y: p.y }));
    const xs = this.points.map(p => p.x);
    const ys = this.points.map(p => p.y);
    this.width = Math.max(...xs) - Math.min(...xs);
    this.height = Math.max(...ys) - Math.min(...ys);
    this.pathOffset = {
      x: (Math.max(...xs) + Math.min(...xs)) / 2,
      y: (Math.max(...ys) + Math.min(...ys)) / 2
    };
    if (!options || options.left === undefined) this.left = this.pathOffset.x;
    if (!options || options.top === undefined) this.top = this.pathOffset.y;
  }
}

class Rect extends FabricObject {
  constructor(options) { super(options); this.type = 'rect'; }
  get aCoords() {
    const w = (this.width || 0) * this.scaleX;
    const h = (this.height || 0) * this.scaleY;
    return {
      tl: { x: this.left, y: this.top },
      tr: { x: this.left + w, y: this.top },
      br: { x: this.left + w, y: this.top + h },
      bl: { x: this.left, y: this.top + h }
    };
  }
}

class Circle extends FabricObject {
  constructor(options) { super(options); this.type = 'circle'; }
  getCenterPoint() { return { x: this.left, y: this.top }; }
}

class Line extends FabricObject {
  constructor(coords, options) {
    super(options);
    this.type = 'line';
    const [x1, y1, x2, y2] = coords;
    this.left = Math.min(x1, x2);
    this.top = Math.min(y1, y2);
    this._abs = { x1, y1, x2, y2 };
    this.x1 = x1 - this.left; this.y1 = y1 - this.top;
    this.x2 = x2 - this.left; this.y2 = y2 - this.top;
    this.width = Math.abs(x2 - x1);
    this.height = Math.abs(y2 - y1);
  }
  calcLinePoints() { return { x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2 }; }
  getCenterPoint() {
    return { x: (this._abs.x1 + this._abs.x2) / 2, y: (this._abs.y1 + this._abs.y2) / 2 };
  }
}

const fabric = {
  Polygon, Rect, Circle, Line,
  Point: class Point { constructor(x, y) { this.x = x; this.y = y; } },
  util: { transformPoint }
};

// A canvas stub that only tracks the object list.
function makeCanvas() {
  const objects = [];
  return {
    width: 800,
    height: 600,
    add(o) { objects.push(o); },
    remove(o) { const i = objects.indexOf(o); if (i >= 0) objects.splice(i, 1); },
    getObjects() { return objects.slice(); },
    getZoom() { return 1; },
    renderAll() {},
    clear() { objects.length = 0; },
    discardActiveObject() {}
  };
}

module.exports = { fabric, makeCanvas };
