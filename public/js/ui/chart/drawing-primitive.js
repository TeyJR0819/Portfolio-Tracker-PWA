// Draws the support, resistance and trend lines on top of the candles.
// It is a "series primitive" of Lightweight Charts: the library calls draw() whenever the chart repaints,
// so the lines stay in place while the person zooms or scrolls.

import { buildShape, FIB_LEVELS } from '../../logic/chart-drawings.js';

function withAlpha(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export class DrawingsPrimitive {
  constructor({ project, textColor, surfaceColor, fontFamily }) {
    this.project = project; // (point) -> { x, y } in pixels
    this.textColor = textColor;
    this.surfaceColor = surfaceColor;
    this.fontFamily = fontFamily;
    this.drawings = [];
    this.draft = null;
    this.selectedId = null;
    this.series = null;
    this.requestUpdate = () => {};
    this.view = { renderer: () => ({ draw: (target) => this.draw(target) }) };
  }

  attached({ series, requestUpdate }) {
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = () => {};
  }

  paneViews() {
    return [this.view];
  }

  updateAllViews() {}

  setState({ drawings, draft, selectedId }) {
    this.drawings = drawings;
    this.draft = draft;
    this.selectedId = selectedId;
    this.requestUpdate();
  }

  formatPrice(price) {
    return this.series ? this.series.priceFormatter().format(price) : String(price);
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
      context.save();
      context.beginPath();
      context.rect(0, 0, mediaSize.width, mediaSize.height);
      context.clip();
      for (const drawing of all) {
        const isSelected = drawing.id === this.selectedId || drawing === this.draft;
        this.drawOne(context, mediaSize, drawing, isSelected);
      }
      context.restore();
    });
  }

  drawOne(context, mediaSize, drawing, isSelected) {
    const shape = buildShape(drawing, this.project, mediaSize.width);
    const finite = shape.handles.every((handle) => Number.isFinite(handle.x) && Number.isFinite(handle.y));
    if (!finite) return;

    context.lineWidth = isSelected ? 2.5 : 1.5;
    context.strokeStyle = drawing.color;
    context.fillStyle = withAlpha(drawing.color, 0.14);
    context.setLineDash(drawing === this.draft ? [6, 4] : []);

    if (shape.box) {
      context.fillRect(shape.box.x, shape.box.y, shape.box.width, shape.box.height);
      context.strokeRect(shape.box.x, shape.box.y, shape.box.width, shape.box.height);
    }

    if (drawing.type === 'fib') this.drawFibonacci(context, drawing, shape);
    else {
      for (const [x1, y1, x2, y2] of shape.segments) {
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y2);
        context.stroke();
      }
    }

    if (drawing.type === 'hline') this.drawLabel(context, this.formatPrice(drawing.points[0].price), mediaSize.width - 6, shape.handles[0].y, drawing.color);

    context.setLineDash([]);
    if (isSelected) {
      for (const handle of shape.handles) {
        context.beginPath();
        context.arc(handle.x, handle.y, 5, 0, Math.PI * 2);
        context.fillStyle = this.surfaceColor;
        context.fill();
        context.stroke();
      }
    }
  }

  drawFibonacci(context, drawing, shape) {
    const [first, second] = drawing.points;
    const left = Math.min(shape.handles[0].x, shape.handles[1].x);
    const right = Math.max(shape.handles[0].x, shape.handles[1].x);

    shape.levels.forEach((entry, index) => {
      const next = shape.levels[index + 1];
      if (next) {
        context.fillStyle = withAlpha(drawing.color, index % 2 === 0 ? 0.06 : 0.12);
        context.fillRect(left, Math.min(entry.y, next.y), right - left, Math.abs(next.y - entry.y));
      }
      context.beginPath();
      context.moveTo(left, entry.y);
      context.lineTo(right, entry.y);
      context.stroke();

      const price = second.price + (first.price - second.price) * FIB_LEVELS[index];
      this.drawLabel(context, `${FIB_LEVELS[index]} (${this.formatPrice(price)})`, left + 4, entry.y, drawing.color, 'left');
    });

    const [a, b] = shape.handles;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }

  drawLabel(context, text, x, y, color, align = 'right') {
    context.save();
    context.setLineDash([]);
    context.font = `11px ${this.fontFamily}`;
    context.textAlign = align;
    context.textBaseline = 'bottom';
    context.fillStyle = color;
    context.fillText(text, x, y - 3);
    context.restore();
  }
}
