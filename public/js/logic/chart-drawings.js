// Drawing tools for the chart: what a drawing is, how it is measured on screen, and how a click finds it.
// Pure functions: no browser features are used here, so everything can be tested.
//
// A drawing is stored in chart units, so it survives zooming and a change of timeframe:
//   { id, type, color, points: [{ time, price }] }
//   type "trend"  two points, a line between them
//   type "ray"    two points, the line continues to the right
//   type "hline"  one point, a horizontal line across the chart (support or resistance)
//   type "rect"   two points, a box (a zone)
//   type "fib"    two points, Fibonacci retracement levels

export const DRAWING_TYPES = Object.freeze(['trend', 'ray', 'hline', 'rect', 'fib']);
export const FIB_LEVELS = Object.freeze([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
export const DRAWING_COLORS = Object.freeze(['#d9b26f', '#60a5fa', '#34d399', '#f87171', '#c084fc', '#e9eef6']);
export const MAX_DRAWINGS = 200;

const HIT_DISTANCE = 8;

export function pointsNeeded(type) {
  return type === 'hline' ? 1 : 2;
}

export function createDrawing(type, points, color) {
  return { id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, type, color, points };
}

// Drops anything that is not a valid drawing. Saved data comes from outside, so it is checked.
export function sanitiseDrawings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item) =>
        item &&
        DRAWING_TYPES.includes(item.type) &&
        typeof item.id === 'string' &&
        Array.isArray(item.points) &&
        item.points.length === pointsNeeded(item.type) &&
        item.points.every((point) => Number.isFinite(point?.time) && Number.isFinite(point?.price)),
    )
    .slice(0, MAX_DRAWINGS)
    .map((item) => ({
      id: item.id,
      type: item.type,
      color: typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : DRAWING_COLORS[0],
      points: item.points.map(({ time, price }) => ({ time, price })),
    }));
}

export function fibPrice(first, second, level) {
  return second + (first - second) * level;
}

// Turns a drawing into pixel shapes.
//   project(point) -> { x, y } in pixels, width: the width of the chart area.
// Returns { handles, segments, box } where segments are [x1, y1, x2, y2] lines and box is { x, y, width, height }.
export function buildShape(drawing, project, width) {
  const points = drawing.points.map(project);

  switch (drawing.type) {
    case 'hline':
      return { handles: [points[0]], segments: [[0, points[0].y, width, points[0].y]], box: null };

    case 'trend':
      return { handles: points, segments: [[points[0].x, points[0].y, points[1].x, points[1].y]], box: null };

    case 'ray': {
      // The line starts at the first point, passes the second and runs on to the edge of the chart.
      const [a, b] = points;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let end;
      if (Math.abs(dx) < 0.5) end = { x: b.x, y: a.y + (dy >= 0 ? 5000 : -5000) };
      else {
        const edge = dx > 0 ? width + 50 : -50;
        const scale = (edge - a.x) / dx;
        end = { x: edge, y: a.y + dy * scale };
      }
      return { handles: points, segments: [[a.x, a.y, end.x, end.y]], box: null };
    }

    case 'rect': {
      const [a, b] = points;
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      return { handles: points, segments: [], box };
    }

    case 'fib': {
      const [a, b] = points;
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x);
      const levels = FIB_LEVELS.map((level) => ({ level, y: b.y + (a.y - b.y) * level }));
      return {
        handles: points,
        segments: [...levels.map(({ y }) => [left, y, right, y]), [a.x, a.y, b.x, b.y]],
        levels,
        box: null,
      };
    }

    default:
      return { handles: [], segments: [], box: null };
  }
}

export function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// What is under the pointer? Handles win over lines, and the newest drawing wins over older ones.
// Returns { drawing, handleIndex } where handleIndex is -1 when the line or box body was hit, or null.
export function hitTest(drawings, project, width, x, y, distance = HIT_DISTANCE) {
  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    const shape = buildShape(drawings[i], project, width);
    const handleIndex = shape.handles.findIndex((handle) => Math.hypot(handle.x - x, handle.y - y) <= distance + 2);
    if (handleIndex >= 0) return { drawing: drawings[i], handleIndex };
  }

  for (let i = drawings.length - 1; i >= 0; i -= 1) {
    const shape = buildShape(drawings[i], project, width);
    const onLine = shape.segments.some((segment) => distanceToSegment(x, y, segment) <= distance);
    const inBox = shape.box && x >= shape.box.x && x <= shape.box.x + shape.box.width && y >= shape.box.y && y <= shape.box.y + shape.box.height;
    if (onLine || inBox) return { drawing: drawings[i], handleIndex: -1 };
  }
  return null;
}

// Moves one handle (handleIndex >= 0) or the whole drawing (handleIndex -1) by a change in time and price.
export function moveDrawing(drawing, handleIndex, deltaTime, deltaPrice, newPoint) {
  if (handleIndex >= 0) {
    return { ...drawing, points: drawing.points.map((point, index) => (index === handleIndex ? newPoint : point)) };
  }
  return { ...drawing, points: drawing.points.map((point) => ({ time: point.time + deltaTime, price: point.price + deltaPrice })) };
}
