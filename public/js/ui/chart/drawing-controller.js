// Lets the person draw, select, move, recolour and delete support, resistance and trend lines.
//
// How a mouse or finger is handled:
//   pointerdown  decides who owns the gesture. If a drawing tool is on, or a drawing lies under the pointer,
//                this file owns it and the chart does not pan. Otherwise the chart keeps it.
//   mousedown / touchstart  are the events Lightweight Charts listens to. They are stopped here when this file owns the gesture.
//   pointermove / pointerup  follow the gesture on the whole window, so a drag may leave the chart.

import { createDrawing, hitTest, moveDrawing, pointsNeeded } from '../../logic/chart-drawings.js';
import { DrawingsPrimitive } from './drawing-primitive.js';
import { readCssVariable } from '../dom.js';

const CLICK_DISTANCE = 6;

export function createDrawingController({ container, engine, onChange, onToolDone, onSelectionChange }) {
  const primitive = new DrawingsPrimitive({
    project: engine.project,
    textColor: readCssVariable('--color-text'),
    surfaceColor: readCssVariable('--color-surface'),
    fontFamily: readCssVariable('--font-sans'),
  });
  engine.candleSeries.attachPrimitive(primitive);

  let drawings = [];
  let selectedId = null;
  let tool = null; // 'trend', 'ray', 'hline', 'rect', 'fib' or null for the normal pointer
  let color = '#d9b26f';
  let magnet = false;
  let draft = null; // a drawing being placed: { id: 'draft', type, color, points }
  let gesture = null; // { mode: 'draw' | 'move' | 'handle', ... }
  let claimed = false;
  let hoverFrame = 0;

  function sync() {
    primitive.setState({ drawings, draft, selectedId });
    container.classList.toggle('is-tool-active', tool !== null);
    container.classList.toggle('is-editing', tool !== null || selectedId !== null);
  }

  function select(id) {
    if (selectedId === id) return;
    selectedId = id;
    onSelectionChange?.(drawings.find((item) => item.id === id) ?? null);
    sync();
  }

  function commit(next) {
    drawings = next;
    onChange(drawings);
  }

  function pointerPosition(event) {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function isInsideMainPane({ x, y }) {
    const bounds = engine.mainPaneBounds();
    return x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height;
  }

  function toPoint({ x, y }) {
    const point = engine.unproject(x, y);
    return point && magnet ? engine.snap(point) : point;
  }

  function finishDraft() {
    const finished = createDrawing(draft.type, draft.points.map((point) => ({ ...point })), draft.color);
    draft = null;
    gesture = null;
    commit([...drawings, finished]);
    tool = null;
    selectedId = finished.id;
    onToolDone?.();
    onSelectionChange?.(finished);
    sync();
  }

  function cancelDraft() {
    draft = null;
    gesture = null;
    sync();
  }

  // ---------- Pointer handling ----------

  function handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const position = pointerPosition(event);
    if (!isInsideMainPane(position)) return;
    const width = engine.mainPaneBounds().width;

    if (tool) {
      const point = toPoint(position);
      if (!point) return;
      claim(event);

      if (draft) {
        // The second click of a two-click drawing.
        draft.points[1] = point;
        finishDraft();
        return;
      }
      if (pointsNeeded(tool) === 1) {
        draft = { id: 'draft', type: tool, color, points: [point] };
        finishDraft();
        return;
      }
      draft = { id: 'draft', type: tool, color, points: [point, point] };
      gesture = { mode: 'draw', startX: position.x, startY: position.y };
      sync();
      return;
    }

    const hit = hitTest(drawings, engine.project, width, position.x, position.y);
    if (!hit) {
      select(null);
      return;
    }

    claim(event);
    select(hit.drawing.id);
    const start = engine.unproject(position.x, position.y);
    gesture = { mode: hit.handleIndex >= 0 ? 'handle' : 'move', id: hit.drawing.id, handleIndex: hit.handleIndex, original: hit.drawing, start, moved: false };
  }

  function claim(event) {
    claimed = true;
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerMove(event) {
    if (!gesture && !draft) {
      if (container.contains(event.target)) scheduleHoverCheck(event);
      return;
    }
    const position = pointerPosition(event);
    const point = toPoint(position);
    if (!point) return;

    if (draft) {
      draft.points[1] = point;
      sync();
      return;
    }

    if (gesture?.mode === 'handle' || gesture?.mode === 'move') {
      gesture.moved = true;
      const current = gesture.mode === 'handle' ? point : engine.unproject(position.x, position.y);
      if (!current || !gesture.start) return;
      const moved = moveDrawing(gesture.original, gesture.handleIndex, current.time - gesture.start.time, current.price - gesture.start.price, point);
      drawings = drawings.map((item) => (item.id === moved.id ? moved : item));
      sync();
    }
  }

  function handlePointerUp(event) {
    if (!claimed && !gesture) return;
    claimed = false;
    if (!gesture) return;

    if (gesture.mode === 'draw' && draft) {
      const position = pointerPosition(event);
      const travelled = Math.hypot(position.x - gesture.startX, position.y - gesture.startY);
      // A drag ends the drawing. A plain click leaves it open, and the next click sets the second point.
      if (travelled > CLICK_DISTANCE) finishDraft();
      else gesture = null;
      return;
    }

    if ((gesture.mode === 'move' || gesture.mode === 'handle') && gesture.moved) onChange(drawings);
    gesture = null;
  }

  function handlePointerCancel() {
    claimed = false;
    if (draft) cancelDraft();
    else if (gesture) {
      drawings = drawings.map((item) => (item.id === gesture.id ? gesture.original : item));
      gesture = null;
      sync();
    }
  }

  // Lightweight Charts listens to mouse and touch events. When this file owns the gesture, those are stopped.
  function blockChartEvent(event) {
    if (!claimed) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  }

  function scheduleHoverCheck(event) {
    if (event.pointerType === 'touch' || hoverFrame) return;
    const position = pointerPosition(event);
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const over = !tool && isInsideMainPane(position) && hitTest(drawings, engine.project, engine.mainPaneBounds().width, position.x, position.y);
      container.classList.toggle('is-over-drawing', Boolean(over));
    });
  }

  function handleKeyDown(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Escape') {
      if (draft) cancelDraft();
      else if (tool) setTool(null);
      else select(null);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
      event.preventDefault();
      deleteSelected();
    }
  }

  container.addEventListener('pointerdown', handlePointerDown, true);
  container.addEventListener('mousedown', blockChartEvent, true);
  container.addEventListener('touchstart', blockChartEvent, { capture: true, passive: false });
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerCancel);
  document.addEventListener('keydown', handleKeyDown);

  // ---------- Controls used by the toolbar ----------

  function setTool(name) {
    if (draft) cancelDraft();
    tool = name;
    if (name) select(null);
    sync();
  }

  function deleteSelected() {
    if (!selectedId) return;
    commit(drawings.filter((item) => item.id !== selectedId));
    selectedId = null;
    onSelectionChange?.(null);
    sync();
  }

  return {
    setTool,
    getTool: () => tool,
    setMagnet(value) {
      magnet = value;
    },
    // Sets the colour for new drawings, and recolours the selected drawing if there is one.
    setColor(value) {
      color = value;
      if (!selectedId) return;
      commit(drawings.map((item) => (item.id === selectedId ? { ...item, color: value } : item)));
      onSelectionChange?.(drawings.find((item) => item.id === selectedId) ?? null);
      sync();
    },
    getColor: () => color,
    deleteSelected,
    hasSelection: () => selectedId !== null,
    clearAll() {
      if (drawings.length === 0) return;
      commit([]);
      selectedId = null;
      onSelectionChange?.(null);
      sync();
    },
    // Replaces the drawings without reporting a change (used after loading saved drawings).
    load(list) {
      drawings = list;
      draft = null;
      gesture = null;
      selectedId = null;
      onSelectionChange?.(null);
      sync();
    },
    getDrawings: () => drawings,
    destroy() {
      container.removeEventListener('pointerdown', handlePointerDown, true);
      container.removeEventListener('mousedown', blockChartEvent, true);
      container.removeEventListener('touchstart', blockChartEvent, { capture: true });
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      document.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(hoverFrame);
      container.classList.remove('is-tool-active', 'is-editing', 'is-over-drawing');
    },
  };
}
