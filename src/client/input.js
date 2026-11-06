/**
 * Pointer, touch and wheel input on the map canvas. Turns raw events into a
 * few intents (tap, box select, paint, hover) and drives the camera directly.
 *
 * Mouse: left tap = act, left drag = selection box (or paint walls in wall
 * mode), right or middle drag = pan, right tap = command. Touch: one finger
 * drag = pan, tap = act, two fingers = pinch zoom and pan.
 */

const TAP_SLOP = 7;
/** Zoom is CSS pixels per art pixel (pixel-art scale). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;

/**
 * Zoom keeping the world point under (sx, sy) fixed on screen.
 * @param {import('./render.js').Renderer} r
 */
export function zoomAt(r, sx, sy, factor) {
  const [wx, wy] = r.toWorld(sx, sy);
  r.cam.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r.cam.zoom * factor));
  const [nx, ny] = r.toWorld(sx, sy);
  r.cam.x += wx - nx;
  r.cam.y += wy - ny;
  r.clampCamera();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('./render.js').Renderer} r
 * @param {object} h Handlers: onTap(sx, sy, {button, shift}), onBox(x0, y0, x1, y1, shift),
 *   onBoxPreview(box|null), onPaint(sx, sy), onHover(sx, sy), canPaint() → boolean.
 */
export function attachInput(canvas, r, h) {
  const pointers = new Map();
  let gesture = null;

  const local = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y, sx: x, sy: y, type: e.pointerType, button: e.button });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = {
        kind: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: r.cam.zoom,
        mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      };
      h.onBoxPreview(null);
      return;
    }
    if (pointers.size > 2) return;
    if (e.pointerType === 'mouse') {
      gesture = { kind: e.button === 0 ? 'left' : 'right', moved: false, shift: e.shiftKey };
      if (e.button === 0 && h.canPaint()) { gesture.kind = 'paint'; h.onPaint(x, y); }
    } else {
      gesture = { kind: 'touch', moved: false, shift: false };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = local(e);
    if (e.pointerType === 'mouse') h.onHover(x, y);
    const p = pointers.get(e.pointerId);
    if (!p || !gesture) return;
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;

    if (gesture.kind === 'pinch') {
      const [a, b] = [...pointers.values()];
      if (!b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, gesture.zoom * (dist / gesture.dist)));
      zoomAt(r, mid[0], mid[1], target / r.cam.zoom);
      r.cam.x -= (mid[0] - gesture.mid[0]) / r.scale;
      r.cam.y -= (mid[1] - gesture.mid[1]) / r.scale;
      gesture.mid = mid;
      r.clampCamera();
      return;
    }

    if (!gesture.moved && Math.hypot(x - p.sx, y - p.sy) > TAP_SLOP) gesture.moved = true;
    if (!gesture.moved) return;

    if (gesture.kind === 'touch' || gesture.kind === 'right') {
      r.cam.x -= dx / r.scale;
      r.cam.y -= dy / r.scale;
      r.clampCamera();
    } else if (gesture.kind === 'left') {
      h.onBoxPreview({ x0: p.sx, y0: p.sy, x1: x, y1: y });
    } else if (gesture.kind === 'paint') {
      h.onPaint(x, y);
    }
  });

  const end = (e, cancelled) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p || !gesture) return;
    if (gesture.kind === 'pinch') {
      if (pointers.size === 0) gesture = null;
      else gesture = { kind: 'touch', moved: true };
      return;
    }
    const g = gesture;
    gesture = null;
    if (cancelled) { h.onBoxPreview(null); return; }
    if (!g.moved && g.kind !== 'paint') {
      h.onTap(p.x, p.y, { button: g.kind === 'right' ? 2 : 0, shift: g.shift, touch: g.kind === 'touch' });
    } else if (g.kind === 'left') {
      h.onBoxPreview(null);
      h.onBox(p.sx, p.sy, p.x, p.y, g.shift);
    }
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(r, x, y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
}
