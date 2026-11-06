/**
 * Pixel-art sprite factory. Every sprite is painted procedurally at native
 * resolution (one tile = 16 art pixels) into an offscreen canvas, given an
 * automatic 1px outline, and cached per team colour. Nothing is loaded from disk.
 */

export const ART = 16;

/** The game palette. Every colour on screen comes from here or from a team ramp. */
export const PAL = {
  ink: '#1b1420',
  g0: '#2d5530', g1: '#3a6a36', g2: '#4a7f3e', g3: '#5f9548', g4: '#7fb056', g5: '#a6cc6a',
  d0: '#4f3526', d1: '#6e4b31', d2: '#8f6a43',
  s0: '#34333f', s1: '#525364', s2: '#717486', s3: '#9699a9', s4: '#c3c5cf',
  w0: '#1b3a5e', w1: '#21497a', w2: '#2a5d95', w3: '#4683bb', w4: '#93c7e0',
  n0: '#a88c58', n1: '#cdb47c', n2: '#e2cf9a',
  k0: '#3e261a', k1: '#5e3b24', k2: '#835532', k3: '#a8743f',
  f0: '#16301f', f1: '#1f4a2b', f2: '#2b6233', f3: '#3f7f3d', f4: '#5f9c48',
  y0: '#7a4e10', y1: '#b97f1c', y2: '#eab534', y3: '#ffe58c',
  skin: '#e2a37a', skinD: '#b06e55', cloth: '#efe4cc', metal: '#c0c5d1', metalD: '#7d8396',
  red: '#d24a3c', redD: '#7c1f1f',
  // Forge embers and torches, darkest → white-hot.
  fire0: '#a3321f', fire1: '#ec7a2a', fire2: '#ffd45e',
  // Sanctuary crystal, darkest → glint.
  cry0: '#3b2a78', cry1: '#6a4fd0', cry2: '#a58df5', cry3: '#ece4ff',
  // Ogre hide, an olive green kept apart from the grass ramp.
  ogre0: '#4d5726', ogre1: '#7a8a3a', ogre2: '#a9b862',
};

// ------------------------------------------------------------------ colour helpers

function hexToRgb(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Five-step ramp (darkest → highlight) from a team's base colour, hue-shifted like hand-picked pixel ramps. */
export function teamRamp(hex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const shift = (dh) => (h + dh + 1) % 1;
  return {
    t0: hslToHex(shift(0.03), Math.min(1, s * 0.9), l * 0.42),
    t1: hslToHex(shift(0.015), s, l * 0.7),
    t2: hex,
    t3: hslToHex(shift(-0.015), s * 0.95, l + (1 - l) * 0.28),
    t4: hslToHex(shift(-0.03), s * 0.8, l + (1 - l) * 0.55),
  };
}

/** Undyed cloth ramp, same shape as a team ramp: banners nobody holds. */
const NEUTRAL_RAMP = Object.freeze({ t0: PAL.s1, t1: PAL.s3, t2: PAL.s4, t3: PAL.cloth, t4: '#ffffff' });

// ------------------------------------------------------------------ canvas helpers

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return { c, g };
}

const R = (g, color, x, y, w = 1, h = 1) => { g.fillStyle = color; g.fillRect(x, y, w, h); };

/** Single pixels: P(g, color, x0, y0, x1, y1, ...). */
function P(g, color, ...xy) {
  g.fillStyle = color;
  for (let i = 0; i < xy.length; i += 2) g.fillRect(xy[i], xy[i + 1], 1, 1);
}

/** 1px Bresenham line, end points included. */
function line(g, color, x0, y0, x1, y1) {
  g.fillStyle = color;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Filled disc, rasterised like the tree crowns. */
function disc(g, color, cx, cy, r) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) g.fillRect(cx + x, cy + y, 1, 1);
}

/** Filled ellipse centred on (cx, cy); cx, cy may sit on a pixel boundary (.5). */
function ellipse(g, color, cx, cy, rx, ry) {
  g.fillStyle = color;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const half = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1);
  }
}

/**
 * Add a 1px outline (4-neighbourhood) around opaque pixels.
 * @param {{left?:boolean,right?:boolean,top?:boolean,bottom?:boolean}} [open] Sides where the
 *   shape continues into the next tile, so no outline is drawn on that canvas edge.
 */
function outline(c, color = PAL.ink, open = {}) {
  const g = c.getContext('2d');
  const { width: w, height: h } = c;
  const img = g.getImageData(0, 0, w, h);
  const src = img.data;
  const out = new Uint8ClampedArray(src);
  const [r, gg, b] = hexToRgb(color);
  const a = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : src[(y * w + x) * 4 + 3]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a(x, y) > 0) continue;
      if ((open.left && x === 0) || (open.right && x === w - 1) || (open.top && y === 0) || (open.bottom && y === h - 1)) continue;
      if (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1)) {
        const i = (y * w + x) * 4;
        out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255;
      }
    }
  }
  g.putImageData(new ImageData(out, w, h), 0, 0);
}

/** Shaded cone roof: rows from apex to base, left lit, right in shade. */
function cone(g, cx, top, base, halfMax, t) {
  const rows = base - top + 1;
  for (let i = 0; i < rows; i++) {
    const half = Math.round(((i + 1) / rows) * halfMax);
    const y = top + i;
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      const rel = x - cx;
      let col = t.t2;
      if (rel < -half * 0.35) col = t.t3;
      if (rel > half * 0.4) col = t.t1;
      if (i === rows - 1) col = t.t0;
      if (i === 0 || (rel < -half * 0.6 && i % 3 === 1)) col = i === 0 ? t.t4 : t.t4;
      R(g, col, x, y);
    }
  }
}

/**
 * Symmetric cone roof over a shaft at x0 of width w, with `over` px of eave on each side.
 * `gold` gilds the eave and apex and sets a finial above it (two rows above `top`).
 */
function roof(g, x0, w, top, base, over, t, gold = false) {
  const rows = base - top + 1;
  const full = w + 2 * over;
  for (let i = 0; i < rows; i++) {
    let wi = Math.round((full * (i + 1)) / rows);
    if ((wi + w) % 2) wi += 1;
    wi = Math.max(2 - (w % 2), Math.min(full, wi));
    const half = wi / 2;
    const xs = x0 + (w - wi) / 2;
    for (let k = 0; k < wi; k++) {
      const rel = k + 0.5 - half;
      let col = t.t2;
      if (rel < -half * 0.35) col = t.t3;
      if (rel > half * 0.4) col = t.t1;
      if (i % 3 === 1 && rel < -half * 0.6) col = t.t4;
      if (i === 0) col = gold ? PAL.y3 : t.t4;
      if (i === rows - 1) {
        if (gold) col = rel > half * 0.4 ? PAL.y1 : rel < -half * 0.7 ? PAL.y3 : PAL.y2;
        else col = t.t0;
      }
      if (gold && i === Math.round(rows * 0.55)) col = rel > half * 0.4 ? PAL.y1 : PAL.y2;
      R(g, col, xs + k, top + i);
    }
  }
  if (gold) {
    const cx = x0 + Math.floor((w - 1) / 2);
    R(g, PAL.y2, cx, top - 2, 2 - (w % 2), 2);
    R(g, PAL.y3, cx, top - 2, 1, 1);
  }
}

/** Stone face with staggered mortar lines. */
function bricks(g, x0, y0, w, h, light, mid, dark, mortar) {
  R(g, mid, x0, y0, w, h);
  R(g, light, x0, y0, Math.min(2, w), h);
  R(g, dark, x0 + w - 2, y0, 2, h);
  for (let y = y0 + 3; y < y0 + h; y += 3) {
    R(g, mortar, x0, y, w, 1);
    const off = ((y - y0) / 3) % 2 ? 2 : 5;
    for (let x = x0 + off; x < x0 + w; x += 6) R(g, mortar, x, y - 2, 1, 2);
  }
}

/** Crenellations: 2px merlons, 2px gaps, centred on [x0, x0 + w). */
function merlons(g, x0, w, y, h, color) {
  const n = Math.floor((w + 2) / 4);
  const start = x0 + Math.floor((w - (4 * n - 2)) / 2);
  for (let i = 0; i < n; i++) R(g, color, start + 4 * i, y, 2, h);
}

/** Hanging team banner, w×h plus a swallowtail row; optional rod colour above it. */
function banner(g, x, y, w, h, t, rod) {
  R(g, t.t2, x, y, w, h);
  R(g, t.t3, x, y, 1, h);
  R(g, t.t1, x + w - 1, y, 1, h);
  R(g, t.t4, x + Math.floor((w - 2) / 2), y + Math.floor(h / 2) - 1, 2 - (w % 2), 2);
  R(g, t.t2, x, y + h, 1, 1);
  R(g, t.t1, x + w - 1, y + h, 1, 1);
  if (rod) R(g, rod, x - 1, y - 1, w + 2, 1);
}

/** Pennant on a 3px pole whose foot is at (x, y + 3). */
function pennant(g, x, y, t) {
  R(g, PAL.k0, x, y, 1, 4);
  R(g, t.t2, x + 1, y, 3, 2);
  R(g, t.t3, x + 1, y, 1, 1);
  R(g, t.t1, x + 3, y + 1, 1, 1);
}

/** A log seen end-on, 4×4, bark ring around pale heartwood. */
function logEnd(g, x, y) {
  R(g, PAL.k1, x + 1, y, 2, 4);
  R(g, PAL.k1, x, y + 1, 4, 2);
  R(g, PAL.n1, x + 1, y + 1, 2, 2);
  R(g, PAL.n2, x + 1, y + 1, 1, 1);
}

/** Bounding box of the opaque pixels of a canvas. */
function opaqueBounds(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!d[(y * w + x) * 4 + 3]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ------------------------------------------------------------------ cache

const cache = new Map();
function cached(key, make) {
  let v = cache.get(key);
  if (!v) { v = make(); cache.set(key, v); }
  return v;
}

/**
 * A drawable sprite: canvas plus the offset of its anchor from the tile's
 * top-left corner, in art pixels.
 * @typedef {{c:HTMLCanvasElement, ox:number, oy:number}} Sprite
 */

/**
 * Paint a one-tile building: content is w×h art px, bottom row on the tile's last row,
 * content column `left` on the tile's column 0. Returns the outlined sprite.
 */
function building(w, h, left, paint) {
  const { c, g } = makeCanvas(w + 2, h + 2);
  g.translate(1, 1);
  paint(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  outline(c);
  return { c, ox: -1 - left, oy: 15 - h };
}

// ------------------------------------------------------------------ buildings

/**
 * Castle keep, wider than its tile and centred on it.
 * Level 1: 28×30 (two turrets and a hall). Level 2: 36×40 (curtain wall, gatehouse and a
 * rear keep). Level 3: 38×50 (central donjon, gilded roofs). Out-of-range levels clamp to 1..3.
 * @param {string} color Team base colour.
 * @param {number} [level=1]
 */
export function keepSprite(color, level = 1) {
  const lv = level >= 3 ? 3 : level >= 2 ? 2 : 1;
  return cached(`keep:${color}:${lv}`, () => {
    const t = teamRamp(color);
    if (lv === 2) return keepLevel2(t);
    if (lv === 3) return keepLevel3(t);
    const { c, g } = makeCanvas(30, 32);
    g.translate(1, 1);
    // Turrets
    for (const [x0, lit] of [[0, true], [20, false]]) {
      bricks(g, x0, 7, 8, 22, lit ? PAL.s4 : PAL.s3, PAL.s2, PAL.s1, PAL.s1);
      R(g, PAL.ink, x0 + 3, 12, 2, 3);
      R(g, PAL.ink, x0 + 3, 19, 2, 3);
      cone(g, x0 + 3.5, 0, 7, 5, t);
    }
    // Hall with crenellations
    for (let x = 8; x < 20; x += 3) R(g, PAL.s3, x, 8, 2, 2);
    R(g, PAL.s4, 8, 10, 12, 1);
    bricks(g, 8, 11, 12, 18, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    // Gate
    R(g, PAL.ink, 11, 21, 6, 8);
    R(g, PAL.ink, 12, 20, 4, 1);
    R(g, PAL.k1, 12, 22, 4, 7);
    R(g, PAL.k0, 13, 22, 1, 7);
    R(g, PAL.k0, 15, 22, 1, 7);
    R(g, PAL.k2, 12, 22, 4, 1);
    // Banner
    R(g, t.t2, 12, 12, 4, 6);
    R(g, t.t3, 12, 12, 1, 6);
    R(g, t.t1, 15, 12, 1, 6);
    R(g, t.t4, 13, 14, 2, 2);
    R(g, t.t2, 12, 18, 1, 1);
    R(g, t.t2, 15, 18, 1, 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return { c, ox: 8 - 15, oy: 16 - 31 };
  });
}

/** Lit window slit with a warm glow. */
function window2(g, x, y) {
  R(g, PAL.ink, x, y, 2, 3);
  R(g, PAL.y2, x, y + 1, 2, 1);
}

/** Front gate: arched frame, planked doors, iron bands. Door is w px wide, h px tall below the arch. */
function castleGate(g, x, y, w, h, trim) {
  R(g, PAL.ink, x + 1, y, w - 2, 1);
  R(g, PAL.ink, x, y + 1, w, h);
  R(g, PAL.k1, x + 1, y + 2, w - 2, h - 1);
  R(g, PAL.k2, x + 1, y + 2, w - 2, 1);
  for (let k = x + 2; k < x + w - 1; k += 2) R(g, PAL.k0, k, y + 3, 1, h - 2);
  R(g, PAL.metalD, x + 1, y + 4, w - 2, 1);
  R(g, PAL.metalD, x + 1, y + h - 1, w - 2, 1);
  if (trim) {
    R(g, trim, x + Math.floor(w / 2) - 1, y - 1, 2, 1);
    P(g, trim, x, y, x + w - 1, y);
  }
}

/** Keep, level 2: two tall turrets, a crenellated rear keep and a gated curtain wall. */
function keepLevel2(t) {
  return building(36, 40, 10, (g) => {
    // Rear keep
    merlons(g, 9, 18, 12, 2, PAL.s3);
    R(g, PAL.s4, 9, 14, 18, 1);
    bricks(g, 9, 15, 18, 11, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    R(g, PAL.s1, 9, 22, 18, 1);
    window2(g, 11, 16);
    window2(g, 23, 16);
    banner(g, 15, 16, 6, 5, t);
    // Turrets
    for (const [x0, lit] of [[2, true], [26, false]]) {
      bricks(g, x0, 11, 8, 29, lit ? PAL.s4 : PAL.s3, PAL.s2, PAL.s1, PAL.s1);
      R(g, PAL.ink, x0 + 3, 15, 2, 3);
      R(g, PAL.ink, x0 + 3, 21, 2, 3);
      banner(g, x0 + 2, 27, 4, 5, t, PAL.k1);
      roof(g, x0, 8, 3, 11, 2, t);
      pennant(g, x0 + 3, 0, t);
    }
    // Curtain wall and gatehouse
    merlons(g, 10, 16, 23, 2, PAL.s4);
    R(g, PAL.s4, 10, 25, 16, 1);
    R(g, PAL.s3, 10, 26, 16, 2);
    R(g, t.t2, 10, 26, 16, 1);
    bricks(g, 10, 28, 16, 12, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    R(g, t.t1, 10, 28, 16, 1);
    castleGate(g, 14, 30, 8, 9, PAL.s4);
  });
}

/** Keep, level 3: a gilded donjon over two side towers and a torch-lit curtain wall. */
function keepLevel3(t) {
  return building(38, 50, 11, (g) => {
    // Donjon
    bricks(g, 12, 15, 14, 19, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    window2(g, 14, 18);
    window2(g, 22, 18);
    window2(g, 14, 25);
    window2(g, 22, 25);
    banner(g, 16, 18, 6, 8, t, PAL.y2);
    roof(g, 12, 14, 3, 15, 2, t, true);
    // Back ramparts between donjon and towers
    for (const x0 of [10, 26]) {
      merlons(g, x0, 2, 22, 2, PAL.s3);
      bricks(g, x0, 24, 2, 10, PAL.s2, PAL.s1, PAL.s1, PAL.s0);
    }
    // Side towers
    for (const [x0, lit] of [[2, true], [28, false]]) {
      bricks(g, x0, 18, 8, 32, lit ? PAL.s4 : PAL.s3, PAL.s2, PAL.s1, PAL.s1);
      R(g, PAL.ink, x0 + 3, 22, 2, 3);
      window2(g, x0 + 3, 29);
      banner(g, x0 + 2, 37, 4, 6, t, PAL.y2);
      roof(g, x0, 8, 9, 18, 2, t, true);
      pennant(g, x0 + 3, 4, t);
    }
    // Curtain wall
    merlons(g, 10, 18, 32, 2, PAL.s4);
    R(g, PAL.s4, 10, 34, 18, 1);
    R(g, PAL.s3, 10, 35, 18, 2);
    R(g, t.t2, 10, 35, 18, 1);
    bricks(g, 10, 37, 18, 13, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    R(g, t.t1, 10, 37, 18, 1);
    R(g, PAL.y1, 10, 38, 18, 1);
    castleGate(g, 15, 40, 8, 9, PAL.y2);
    // Torches beside the gate
    for (const x of [12, 25]) {
      R(g, PAL.k0, x, 43, 1, 2);
      R(g, PAL.fire1, x, 41, 1, 2);
      R(g, PAL.fire2, x, 42, 1, 1);
    }
  });
}

/** Watchtower, 16×28, a cone roof in team colours. */
export function towerSprite(color) {
  return cached(`tower:${color}`, () => {
    const t = teamRamp(color);
    const { c, g } = makeCanvas(18, 30);
    g.translate(1, 1);
    bricks(g, 3, 10, 10, 18, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    R(g, PAL.s4, 3, 10, 10, 1);
    R(g, PAL.ink, 7, 13, 2, 3);
    R(g, PAL.y2, 7, 14, 2, 1);
    R(g, PAL.k1, 6, 23, 4, 5);
    R(g, PAL.k2, 7, 22, 2, 1);
    R(g, PAL.k0, 8, 23, 1, 5);
    cone(g, 7.5, 0, 9, 7, t);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return { c, ox: -1, oy: 16 - 29 };
  });
}

/** Gold mine: wooden headframe over a pit, cart of ore, team pennant. */
export function mineSprite(color) {
  return cached(`mine:${color}`, () => {
    const t = teamRamp(color);
    const { c, g } = makeCanvas(18, 22);
    g.translate(1, 1);
    // pit
    R(g, PAL.d0, 2, 15, 12, 4);
    R(g, PAL.ink, 4, 16, 8, 2);
    // posts and beam
    R(g, PAL.k2, 2, 4, 2, 13);
    R(g, PAL.k1, 3, 4, 1, 13);
    R(g, PAL.k2, 12, 4, 2, 13);
    R(g, PAL.k1, 13, 4, 1, 13);
    R(g, PAL.k3, 1, 4, 14, 2);
    R(g, PAL.k1, 1, 5, 14, 1);
    // wheel and rope
    R(g, PAL.k0, 6, 1, 4, 4);
    R(g, PAL.k3, 7, 2, 2, 2);
    R(g, PAL.k0, 8, 5, 1, 10);
    // cart full of ore
    R(g, PAL.s1, 3, 12, 7, 4);
    R(g, PAL.s2, 3, 12, 7, 1);
    R(g, PAL.y1, 4, 10, 5, 2);
    R(g, PAL.y2, 4, 10, 2, 1);
    R(g, PAL.y3, 7, 10, 1, 1);
    R(g, PAL.ink, 4, 16, 2, 2);
    R(g, PAL.ink, 8, 16, 2, 2);
    // pennant
    R(g, PAL.k0, 13, 0, 1, 4);
    R(g, t.t2, 14, 0, 3, 2);
    R(g, t.t3, 14, 0, 1, 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return { c, ox: -1, oy: 16 - 21 };
  });
}

/** Barracks: a striped war tent in team colours. */
export function barracksSprite(color) {
  return cached(`barracks:${color}`, () => {
    const t = teamRamp(color);
    const { c, g } = makeCanvas(18, 22);
    g.translate(1, 1);
    for (let y = 3; y <= 16; y++) {
      const half = Math.round(((y - 3) / 13) * 7.5);
      for (let x = 8 - half; x <= 7 + half; x++) {
        let col = Math.floor(x / 2) % 2 ? t.t2 : t.t3;
        if (x > 7 + half - 2) col = t.t1;
        if (y === 16) col = t.t0;
        R(g, col, x, y);
      }
    }
    // doorway
    for (let y = 10; y <= 16; y++) {
      const half = Math.round(((y - 10) / 6) * 2.5);
      R(g, PAL.ink, 8 - half, y, half * 2, 1);
    }
    R(g, PAL.k1, 0, 17, 16, 2);
    R(g, PAL.k2, 0, 17, 16, 1);
    // pole and flag
    R(g, PAL.k0, 7, 0, 2, 4);
    R(g, t.t4, 9, 0, 3, 2);
    // spear rack
    R(g, PAL.k2, 14, 8, 1, 9);
    R(g, PAL.metal, 14, 7, 1, 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return { c, ox: -1, oy: 16 - 21 };
  });
}

/** Rampart body shared by walls and gates (walkway, team stripe, merlons, front face). */
function wallBody(g, t, N, E, S, W) {
  const L = W ? 0 : 2;
  const Rt = E ? 16 : 14;
  const top = N ? 4 : 7;
  const faceTop = 15;
  const bottom = S ? 20 : faceTop;
  // walkway (top face)
  R(g, PAL.s3, L, top, Rt - L, bottom - top);
  R(g, PAL.s4, L, top, Rt - L, 1);
  for (let x = L + 1; x < Rt - 1; x += 4) R(g, PAL.s2, x, top + 3, 2, 1);
  R(g, t.t2, L, top + (N ? 0 : 1), Rt - L, 1);
  if (!N) for (let x = L; x < Rt; x += 4) R(g, PAL.s4, x, top - 3, 2, 3);
  // front face
  if (!S) {
    bricks(g, L, faceTop, Rt - L, 5, PAL.s2, PAL.s1, PAL.s0, PAL.s0);
    R(g, t.t1, L, faceTop, Rt - L, 1);
  }
}

/**
 * Wall segment that joins its neighbours. `mask` bits: 1 north, 2 east, 4 south, 8 west.
 * Canvas covers the tile plus 4 art pixels above for the merlons.
 */
export function wallSprite(color, mask) {
  return cached(`wall:${color}:${mask}`, () => {
    const t = teamRamp(color);
    const N = mask & 1;
    const E = mask & 2;
    const S = mask & 4;
    const W = mask & 8;
    const { c, g } = makeCanvas(18, 22);
    g.translate(1, 1);
    wallBody(g, t, N, E, S, W);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c, PAL.ink, { top: !!N, right: !!E, bottom: !!S, left: !!W });
    return { c, ox: -1, oy: -5 };
  });
}

/**
 * Gate in a rampart: the wall body of wallSprite (same mask bits and joins) with a
 * crenellated gatehouse and a wooden double door on its face. Same canvas and anchor as walls.
 */
export function gateSprite(color, mask) {
  return cached(`gate:${color}:${mask}`, () => {
    const t = teamRamp(color);
    const N = mask & 1;
    const E = mask & 2;
    const S = mask & 4;
    const W = mask & 8;
    const { c, g } = makeCanvas(18, 22);
    g.translate(1, 1);
    wallBody(g, t, N, E, S, W);
    // gatehouse
    merlons(g, 2, 12, 1, 3, PAL.s4);
    R(g, PAL.s4, 2, 4, 12, 1);
    R(g, PAL.s3, 2, 5, 12, 3);
    R(g, t.t2, 2, 6, 12, 1);
    bricks(g, 2, 8, 12, 12, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
    R(g, t.t1, 2, 8, 12, 1);
    // arch and double door
    R(g, PAL.s4, 7, 9, 2, 1);
    R(g, PAL.ink, 5, 10, 6, 1);
    R(g, PAL.ink, 4, 11, 8, 9);
    R(g, PAL.k2, 6, 11, 2, 1);
    R(g, PAL.k1, 8, 11, 2, 1);
    R(g, PAL.k2, 5, 12, 3, 8);
    R(g, PAL.k3, 5, 12, 1, 8);
    R(g, PAL.k1, 8, 12, 3, 8);
    R(g, PAL.k0, 10, 12, 1, 8);
    R(g, PAL.metalD, 5, 14, 6, 1);
    R(g, PAL.metalD, 5, 17, 6, 1);
    P(g, PAL.metal, 7, 15, 8, 15);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c, PAL.ink, { top: !!N, right: !!E, bottom: !!S, left: !!W });
    return { c, ox: -1, oy: -5 };
  });
}

/** Sawmill: a plank shed with a team roof, a circular saw on its bench, a pile of logs. 16×20. */
export function sawmillSprite(color) {
  return cached(`sawmill:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 20, 0, (g) => {
      // shed
      R(g, PAL.k1, 1, 9, 11, 6);
      for (let x = 1; x < 12; x += 3) R(g, PAL.k2, x, 9, 2, 6);
      R(g, PAL.ink, 4, 10, 5, 5);
      R(g, t.t2, 0, 4, 13, 5);
      for (let x = 2; x < 12; x += 3) R(g, t.t1, x, 5, 1, 3);
      R(g, t.t3, 0, 4, 13, 1);
      R(g, t.t3, 0, 4, 2, 5);
      R(g, t.t1, 11, 4, 2, 5);
      R(g, t.t0, 0, 8, 13, 1);
      pennant(g, 2, 0, t);
      // circular saw through the bench
      disc(g, PAL.metal, 5, 13, 2);
      P(g, PAL.metalD, 5, 10, 8, 13, 3, 12, 7, 11);
      R(g, PAL.k0, 5, 13, 1, 1);
      R(g, PAL.k2, 6, 14, 3, 1);
      R(g, PAL.k3, 0, 15, 10, 1);
      R(g, PAL.k1, 0, 16, 10, 1);
      R(g, PAL.k0, 1, 17, 1, 3);
      R(g, PAL.k0, 8, 17, 1, 3);
      // log pile
      logEnd(g, 11, 12);
      logEnd(g, 9, 16);
      logEnd(g, 12, 16);
    });
  });
}

/** Quarry: a cut rock face, a timber crane hoisting a block, finished blocks and a pick. 16×20. */
export function quarrySprite(color) {
  return cached(`quarry:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 20, 0, (g) => {
      // stepped rock face
      R(g, PAL.s3, 2, 3, 12, 3);
      R(g, PAL.s4, 2, 3, 12, 1);
      R(g, PAL.s2, 2, 6, 12, 3);
      R(g, PAL.s1, 12, 6, 2, 3);
      R(g, PAL.s3, 0, 9, 16, 2);
      R(g, PAL.s4, 0, 9, 9, 1);
      R(g, PAL.s2, 0, 11, 16, 3);
      R(g, PAL.s1, 14, 11, 2, 3);
      P(g, PAL.s1, 5, 7, 6, 8, 3, 12, 9, 12, 10, 13);
      // crane
      R(g, PAL.k2, 12, 2, 1, 13);
      R(g, PAL.k1, 13, 2, 1, 13);
      R(g, PAL.k3, 4, 2, 10, 1);
      line(g, PAL.k1, 9, 3, 12, 6);
      R(g, PAL.k0, 5, 3, 1, 4);
      R(g, PAL.s4, 4, 7, 3, 1);
      R(g, PAL.s3, 4, 8, 3, 2);
      R(g, PAL.s2, 6, 8, 1, 2);
      pennant(g, 12, -1, t);
      // cut blocks
      R(g, PAL.s4, 1, 14, 5, 2);
      R(g, PAL.cloth, 1, 14, 2, 1);
      R(g, PAL.s3, 1, 16, 5, 3);
      R(g, PAL.s2, 5, 16, 1, 3);
      R(g, PAL.s4, 9, 15, 6, 2);
      R(g, PAL.cloth, 9, 15, 2, 1);
      R(g, PAL.s3, 9, 17, 6, 3);
      R(g, PAL.s2, 14, 17, 1, 3);
      // pick leaning on a block
      line(g, PAL.k3, 7, 19, 8, 13);
      R(g, PAL.metal, 6, 13, 4, 1);
      P(g, PAL.metalD, 6, 14, 9, 13);
    });
  });
}

/** Stable: a plank barn under a team roof, a horse at the stall window, a hay bale. 16×20. */
export function stableSprite(color) {
  return cached(`stable:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 20, 0, (g) => {
      // roof
      R(g, t.t2, 0, 3, 16, 7);
      R(g, t.t3, 0, 3, 16, 1);
      for (let y = 5; y < 9; y += 2) R(g, t.t1, 0, y, 16, 1);
      R(g, t.t3, 0, 3, 2, 7);
      R(g, t.t1, 14, 3, 2, 7);
      R(g, t.t0, 0, 9, 16, 1);
      // cupola
      R(g, PAL.k2, 6, 1, 4, 2);
      R(g, PAL.ink, 7, 1, 2, 1);
      R(g, t.t1, 5, 0, 6, 1);
      // walls
      R(g, PAL.k2, 1, 10, 14, 10);
      for (let x = 3; x < 15; x += 3) R(g, PAL.k1, x, 11, 1, 9);
      R(g, PAL.k3, 1, 10, 1, 10);
      R(g, PAL.k1, 14, 10, 1, 10);
      R(g, PAL.k3, 1, 10, 14, 1);
      // double door with cross braces
      R(g, PAL.k0, 6, 12, 5, 8);
      R(g, PAL.k1, 7, 13, 3, 7);
      line(g, PAL.k3, 7, 13, 9, 19);
      line(g, PAL.k3, 9, 13, 7, 19);
      // horse at the stall
      R(g, PAL.ink, 2, 12, 3, 4);
      R(g, PAL.k3, 2, 13, 3, 3);
      R(g, PAL.d1, 2, 12, 1, 1);
      R(g, PAL.d1, 4, 12, 1, 1);
      R(g, PAL.cloth, 3, 13, 1, 2);
      R(g, PAL.k1, 2, 16, 3, 1);
      // hay bale
      R(g, PAL.n1, 11, 16, 5, 4);
      R(g, PAL.n2, 11, 16, 5, 1);
      R(g, PAL.n0, 15, 17, 1, 3);
      R(g, PAL.y1, 13, 16, 1, 4);
    });
  });
}

/** Siege workshop: a timber frame with a team canvas roof, a big gear wheel, a flag. 16×20. */
export function workshopSprite(color) {
  return cached(`workshop:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 20, 0, (g) => {
      // canvas roof on the frame
      R(g, t.t2, 0, 4, 16, 4);
      R(g, t.t3, 0, 4, 16, 1);
      for (let x = 1; x < 16; x += 4) R(g, t.t3, x, 5, 2, 2);
      R(g, t.t0, 0, 8, 16, 1);
      for (let x = 0; x < 16; x += 2) R(g, t.t1, x, 8, 1, 1);
      // frame and dark interior
      R(g, PAL.ink, 1, 9, 14, 7);
      R(g, PAL.k3, 0, 9, 2, 11);
      R(g, PAL.k1, 1, 9, 1, 11);
      R(g, PAL.k3, 14, 9, 2, 11);
      R(g, PAL.k1, 15, 9, 1, 11);
      line(g, PAL.k2, 2, 13, 5, 10);
      // flag
      R(g, PAL.k0, 2, 0, 1, 4);
      R(g, t.t2, 3, 0, 4, 2);
      R(g, t.t3, 3, 0, 1, 2);
      R(g, t.t4, 4, 0, 1, 1);
      // planks stacked in front
      R(g, PAL.k3, 1, 17, 6, 1);
      R(g, PAL.k2, 1, 18, 6, 2);
      // gear wheel
      disc(g, PAL.k2, 10, 14, 4);
      for (const [dx, dy] of [[0, -5], [0, 5], [-5, 0], [5, 0], [-4, -4], [4, -4], [-4, 4], [4, 4]]) R(g, PAL.k1, 10 + dx, 14 + dy, 1, 1);
      disc(g, PAL.k3, 10, 14, 3);
      disc(g, PAL.k1, 10, 14, 2);
      R(g, PAL.k2, 9, 12, 3, 5);
      R(g, PAL.k2, 8, 13, 5, 3);
      R(g, PAL.metal, 10, 14, 1, 1);
      P(g, PAL.k3, 7, 13, 8, 11);
    });
  });
}

/** Forge: a stone smithy with a team roof, a chimney, a glowing hearth and an anvil. 16×22. */
export function forgeSprite(color) {
  return cached(`forge:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 22, 0, (g) => {
      // smoke
      R(g, PAL.s3, 9, 0, 2, 1);
      R(g, PAL.s4, 8, 1, 2, 1);
      // roof
      R(g, t.t2, 0, 7, 12, 4);
      R(g, t.t3, 0, 7, 12, 1);
      R(g, t.t3, 0, 7, 2, 4);
      R(g, t.t1, 0, 9, 12, 1);
      R(g, t.t0, 0, 11, 12, 1);
      // chimney
      bricks(g, 8, 3, 4, 8, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
      R(g, PAL.s4, 7, 3, 6, 1);
      R(g, PAL.ink, 8, 2, 4, 1);
      // stone walls with the hearth
      bricks(g, 0, 12, 12, 10, PAL.s3, PAL.s2, PAL.s1, PAL.s1);
      R(g, PAL.ink, 3, 14, 5, 6);
      R(g, PAL.ink, 4, 13, 3, 1);
      R(g, PAL.fire0, 3, 15, 5, 5);
      R(g, PAL.fire0, 4, 14, 3, 1);
      R(g, PAL.fire1, 4, 16, 3, 4);
      R(g, PAL.fire2, 5, 17, 1, 3);
      R(g, PAL.fire2, 4, 19, 3, 1);
      R(g, PAL.s4, 2, 20, 7, 1);
      // anvil on a stump
      R(g, PAL.k2, 12, 19, 3, 3);
      R(g, PAL.k3, 12, 19, 1, 3);
      R(g, PAL.metalD, 13, 17, 1, 2);
      R(g, PAL.metal, 11, 16, 5, 1);
      R(g, PAL.metalD, 12, 17, 3, 1);
      R(g, PAL.metal, 10, 16, 1, 1);
      R(g, PAL.fire1, 12, 15, 2, 1);
      R(g, PAL.fire2, 12, 15, 1, 1);
    });
  });
}

/** Outpost: a tall team banner over a ring of sharpened stakes, a claim flag. 16×26. */
export function outpostSprite(color) {
  return cached(`outpost:${color}`, () => {
    const t = teamRamp(color);
    return building(16, 26, 0, (g) => {
      // back stakes
      for (let x = 1; x < 15; x += 2) R(g, PAL.k1, x, 15, 2, 4);
      // pole, crossbar and banner
      R(g, PAL.metal, 3, 0, 1, 2);
      R(g, PAL.k3, 3, 2, 1, 19);
      R(g, PAL.k1, 4, 2, 1, 19);
      R(g, PAL.k2, 3, 3, 10, 1);
      R(g, PAL.y2, 12, 3, 1, 1);
      R(g, t.t2, 5, 4, 7, 11);
      R(g, t.t3, 5, 4, 1, 11);
      R(g, t.t1, 11, 4, 1, 11);
      R(g, t.t4, 7, 7, 3, 1);
      R(g, t.t4, 8, 6, 1, 3);
      R(g, t.t3, 7, 10, 3, 1);
      R(g, t.t2, 5, 15, 2, 1);
      R(g, t.t1, 10, 15, 2, 1);
      R(g, t.t2, 5, 16, 1, 1);
      R(g, t.t1, 11, 16, 1, 1);
      // front palisade
      for (let x = 0; x < 16; x += 2) {
        const tall = (x / 2) % 2 === 0;
        const y0 = tall ? 18 : 19;
        R(g, PAL.k2, x, y0 + 1, 2, 25 - y0);
        R(g, PAL.k3, x, y0 + 1, 1, 25 - y0);
        R(g, PAL.k2, x, y0, 1, 1);
      }
      R(g, PAL.k0, 0, 22, 16, 1);
    });
  });
}

/**
 * The neutral Sanctuary: a ring of standing stones around a floating crystal, with banners
 * in the holder's colour (null = unclaimed, white). 30×28, centred on its tile like the keep.
 * @param {string|null} holderColor
 */
export function shrineSprite(holderColor) {
  return cached(`shrine:${holderColor ?? 'none'}`, () => {
    const t = holderColor ? teamRamp(holderColor) : NEUTRAL_RAMP;
    const { c, g } = makeCanvas(32, 30);
    g.translate(1, 1);
    const stone = (x, base, h) => {
      const top = base - h + 1;
      R(g, PAL.s4, x + 1, top, 1, 1);
      R(g, PAL.s3, x, top + 1, 3, h - 1);
      R(g, PAL.s4, x, top + 1, 1, h - 1);
      R(g, PAL.s2, x + 2, top + 1, 1, h - 1);
      R(g, PAL.s1, x, base, 3, 1);
      R(g, PAL.f3, x + 1, base - 2, 1, 1);
    };
    // dais
    ellipse(g, PAL.s1, 15, 23, 14, 4.5);
    ellipse(g, PAL.s3, 15, 21.5, 14, 4.5);
    ellipse(g, PAL.s4, 15, 20.5, 12, 3);
    ellipse(g, PAL.s3, 15, 21.5, 11, 3);
    ellipse(g, PAL.cry1, 15, 21.5, 6, 2);
    ellipse(g, PAL.cry2, 15, 21.5, 3.5, 1.2);
    // back stones
    stone(4, 19, 7);
    stone(10, 17, 8);
    stone(17, 17, 8);
    stone(23, 19, 7);
    // banners
    for (const x of [0, 28]) {
      R(g, PAL.k1, x + 1, 6, 1, 18);
      R(g, PAL.y2, x + 1, 5, 1, 1);
    }
    banner(g, 2, 7, 3, 7, t);
    banner(g, 25, 7, 3, 7, t);
    // crystal
    R(g, PAL.s2, 12, 18, 6, 2);
    R(g, PAL.s3, 12, 18, 6, 1);
    const rows = [[2, 2], [3, 2], [4, 4], [5, 4], [6, 6], [7, 6], [8, 6], [9, 6], [10, 6], [11, 6], [12, 4], [13, 4], [14, 2], [15, 2]];
    for (const [y, w] of rows) {
      const x0 = 15 - w / 2;
      R(g, PAL.cry1, x0, y, w, 1);
      R(g, PAL.cry2, x0, y, Math.max(1, w / 2), 1);
      if (w >= 4) R(g, PAL.cry3, x0 + 1, y, 1, 1);
      R(g, PAL.cry0, x0 + w - 1, y, 1, 1);
    }
    // front stones
    stone(1, 24, 6);
    stone(8, 26, 6);
    stone(19, 26, 6);
    stone(26, 24, 6);
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    // glints, painted after the outline so they float as light
    g.translate(1, 1);
    P(g, PAL.cry3, 10, 4, 20, 9, 9, 12);
    P(g, PAL.cry2, 20, 3, 11, 8, 21, 13);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return { c, ox: 8 - 16, oy: 15 - 28 };
  });
}

/**
 * Neutral loot camp (no team colour), 18×20, centred on its tile.
 * @param {'barbarian'|'wolves'|'ogre'} variant Unknown variants draw the barbarian camp.
 */
export function campSprite(variant) {
  const v = variant === 'wolves' || variant === 'ogre' ? variant : 'barbarian';
  return cached(`camp:${v}`, () => building(18, 20, 1, (g) => {
    if (v === 'wolves') {
      // dirt and a rocky den
      ellipse(g, PAL.d1, 9, 17, 9, 3);
      ellipse(g, PAL.s1, 9, 11, 8.5, 6);
      ellipse(g, PAL.s2, 8, 10, 7.5, 5);
      ellipse(g, PAL.s3, 6, 8, 4, 2.5);
      R(g, PAL.s4, 5, 6, 3, 1);
      P(g, PAL.f3, 3, 6, 12, 5, 13, 6, 15, 9);
      ellipse(g, PAL.ink, 9, 14, 4, 3.5);
      P(g, PAL.y2, 8, 13, 10, 13);
      // bones
      line(g, PAL.cloth, 2, 18, 6, 16);
      P(g, PAL.n2, 1, 18, 2, 19, 6, 15, 7, 16);
      line(g, PAL.cloth, 12, 16, 16, 18);
      P(g, PAL.n2, 11, 16, 12, 15, 16, 19, 17, 18);
      R(g, PAL.cloth, 13, 18, 3, 2);
      P(g, PAL.ink, 13, 19, 15, 19);
    } else if (v === 'ogre') {
      // rocky cave mouth
      ellipse(g, PAL.s1, 9, 10, 9, 9.5);
      ellipse(g, PAL.s2, 8, 9, 8, 8.5);
      ellipse(g, PAL.s3, 6, 6, 4.5, 4);
      R(g, PAL.s4, 4, 2, 4, 1);
      R(g, PAL.f3, 6, 0, 6, 2);
      R(g, PAL.f4, 6, 0, 3, 1);
      P(g, PAL.f3, 3, 3, 14, 3, 15, 4);
      R(g, PAL.ink, 5, 8, 8, 12);
      R(g, PAL.ink, 6, 7, 6, 1);
      P(g, PAL.ink, 4, 11, 13, 10);
      // treasure pile
      ellipse(g, PAL.y1, 9, 18, 6, 2.5);
      ellipse(g, PAL.y2, 9, 17, 4.5, 2);
      R(g, PAL.y3, 7, 15, 2, 1);
      P(g, PAL.y3, 5, 17, 11, 16);
      R(g, PAL.red, 10, 15, 2, 2);
      R(g, PAL.cloth, 10, 15, 1, 1);
      R(g, PAL.w3, 6, 18, 1, 1);
      // big bone
      line(g, PAL.cloth, 14, 19, 17, 15);
      P(g, PAL.n2, 13, 19, 14, 18, 17, 14, 16, 15);
    } else {
      // hide tent
      for (let y = 3; y <= 17; y++) {
        const half = Math.round(((y - 3) / 14) * 6.5);
        for (let x = 7 - half; x <= 7 + half; x++) {
          let col = PAL.n0;
          if (x < 7 - half / 3) col = PAL.n1;
          if (x > 7 + half / 2) col = PAL.d2;
          if (y === 17) col = PAL.d1;
          R(g, col, x, y);
        }
      }
      line(g, PAL.k1, 4, 15, 7, 4);
      line(g, PAL.k1, 10, 15, 8, 6);
      R(g, PAL.d1, 9, 9, 2, 2);
      P(g, PAL.k1, 4, 11, 5, 9);
      for (let y = 11; y <= 17; y++) {
        const half = Math.round(((y - 11) / 6) * 2);
        R(g, PAL.ink, 7 - half, y, half * 2 + 1, 1);
      }
      P(g, PAL.k1, 6, 0, 6, 1, 8, 0, 8, 1, 7, 2);
      // skull totem
      R(g, PAL.k1, 15, 4, 1, 14);
      R(g, PAL.k2, 15, 4, 1, 1);
      R(g, PAL.cloth, 14, 1, 3, 3);
      R(g, PAL.n2, 16, 1, 1, 3);
      P(g, PAL.ink, 14, 2, 16, 2);
      R(g, PAL.cloth, 15, 4, 1, 1);
      R(g, PAL.red, 14, 6, 1, 3);
      R(g, PAL.redD, 16, 6, 1, 2);
      // treasure chest
      R(g, PAL.k3, 9, 15, 6, 2);
      R(g, PAL.k2, 9, 17, 6, 3);
      R(g, PAL.k1, 9, 19, 6, 1);
      R(g, PAL.y2, 9, 15, 1, 5);
      R(g, PAL.y2, 14, 15, 1, 5);
      R(g, PAL.y3, 11, 17, 2, 1);
      R(g, PAL.y1, 11, 18, 2, 1);
      P(g, PAL.y2, 16, 19, 17, 18);
    }
  }));
}

// ------------------------------------------------------------------ units

/** Mounted knight, 18×18, facing right. */
function paintCavalry(g, t, step) {
  // tail and horse
  R(g, PAL.k0, 2, 8, 1, 2);
  R(g, PAL.k0, 1, 9, 1, 4);
  R(g, PAL.k2, 3, 8, 10, 4);
  R(g, PAL.k1, 3, 11, 10, 1);
  R(g, PAL.k2, 12, 5, 3, 6);
  R(g, PAL.k3, 13, 5, 1, 4);
  R(g, PAL.k0, 12, 4, 1, 4);
  R(g, PAL.k2, 14, 3, 3, 3);
  R(g, PAL.k3, 14, 3, 2, 1);
  R(g, PAL.k1, 16, 5, 2, 2);
  R(g, PAL.k0, 17, 6, 1, 1);
  R(g, PAL.k1, 14, 2, 1, 1);
  R(g, PAL.ink, 15, 4, 1, 1);
  // legs
  const legs = step ? [[3, PAL.k1], [6, PAL.k2], [10, PAL.k1], [13, PAL.k2]] : [[4, PAL.k1], [5, PAL.k2], [11, PAL.k1], [12, PAL.k2]];
  for (const [x, col] of legs) {
    R(g, col, x, 12, 1, 5);
    R(g, PAL.k0, x, 17, 1, 1);
  }
  // caparison
  R(g, t.t2, 3, 7, 9, 5);
  R(g, t.t3, 3, 7, 9, 1);
  R(g, t.t1, 3, 11, 9, 1);
  for (let x = 4; x < 12; x += 2) R(g, t.t1, x, 12, 1, 1);
  R(g, t.t4, 7, 9, 2, 1);
  R(g, t.t4, 4, 8, 1, 1);
  // rider
  R(g, t.t1, 4, 3, 2, 4);
  R(g, t.t3, 4, 4, 1, 2);
  R(g, t.t2, 6, 3, 4, 4);
  R(g, t.t3, 6, 3, 1, 3);
  R(g, t.t1, 9, 3, 1, 4);
  R(g, PAL.k1, 6, 6, 4, 1);
  R(g, PAL.metalD, 8, 7, 2, 3);
  R(g, PAL.metal, 6, 0, 4, 3);
  R(g, PAL.metalD, 9, 0, 1, 3);
  R(g, PAL.cloth, 7, 0, 1, 1);
  R(g, PAL.ink, 8, 2, 2, 1);
  R(g, t.t2, 5, 0, 1, 2);
  // lance with pennant
  R(g, PAL.k3, 11, 1, 1, 9);
  R(g, PAL.metal, 11, 0, 1, 1);
  R(g, PAL.skin, 10, 5, 1, 1);
  R(g, t.t2, 12, 1, 2, 1);
  R(g, t.t3, 12, 2, 1, 1);
}

/** Siege catapult, 16×14, facing right; frame 1 has the arm thrown forward. */
function paintCatapult(g, t, step) {
  // banner
  R(g, PAL.k0, 14, 1, 1, 8);
  R(g, t.t2, 11, 1, 3, 2);
  R(g, t.t3, 11, 1, 1, 1);
  R(g, t.t1, 13, 2, 1, 1);
  // frame
  line(g, PAL.k2, 7, 8, 9, 3);
  line(g, PAL.k1, 12, 8, 10, 3);
  R(g, PAL.k3, 8, 3, 4, 1);
  R(g, PAL.k0, 9, 4, 2, 1);
  // arm
  if (step) {
    line(g, PAL.k3, 5, 8, 8, 1);
    R(g, PAL.k1, 7, 0, 3, 1);
    R(g, PAL.k1, 8, 1, 2, 1);
  } else {
    line(g, PAL.k3, 5, 8, 1, 6);
    R(g, PAL.k1, 0, 5, 3, 1);
    R(g, PAL.k1, 0, 4, 1, 1);
    R(g, PAL.k1, 2, 4, 1, 1);
    R(g, PAL.s3, 1, 4, 1, 1);
  }
  // base and wheels
  R(g, PAL.k3, 0, 9, 16, 1);
  R(g, PAL.k1, 0, 10, 16, 1);
  R(g, PAL.k0, 4, 7, 2, 2);
  for (const x of [1, 10]) {
    R(g, PAL.k1, x + 1, 10, 2, 4);
    R(g, PAL.k1, x, 11, 4, 2);
    R(g, PAL.k3, x + 1, 11, 2, 2);
    R(g, PAL.k0, x + 1, 11, 1, 1);
  }
}

/** Robed healer with a staff, 12×14 like the soldiers. */
function paintHealer(g, t, step) {
  R(g, PAL.k1, step ? 3 : 4, 13, 2, 1);
  R(g, PAL.k1, step ? 7 : 6, 13, 2, 1);
  // robe
  R(g, PAL.cloth, 3, 5, 6, 6);
  R(g, PAL.cloth, 2, 10, 8, 3);
  R(g, PAL.n1, 7, 5, 2, 6);
  R(g, PAL.n1, 8, 10, 2, 3);
  R(g, PAL.n0, 9, 11, 1, 2);
  R(g, t.t2, 5, 6, 1, 6);
  R(g, t.t2, 2, 12, 8, 1);
  R(g, t.t1, 7, 12, 3, 1);
  R(g, PAL.k3, 3, 8, 6, 1);
  // hood and face
  R(g, PAL.cloth, 3, 1, 5, 5);
  R(g, PAL.n1, 7, 2, 1, 4);
  R(g, t.t2, 4, 1, 3, 1);
  R(g, PAL.skin, 5, 3, 3, 2);
  R(g, PAL.ink, 7, 3, 1, 1);
  // staff with a glowing orb
  R(g, PAL.k3, 10, 3, 1, 10);
  R(g, PAL.k2, 10, 8, 1, 5);
  R(g, PAL.skin, 9, 7, 1, 1);
  R(g, PAL.y2, 9, 1, 3, 2);
  R(g, PAL.y3, 10, 0, 1, 2);
  R(g, PAL.y3, 9, 1, 1, 1);
}

/** Neutral barbarian: horned helmet, fur, beard and axe, 12×14. */
function paintBarbarian(g, step) {
  R(g, PAL.skinD, step ? 3 : 4, 11, 2, 2);
  R(g, PAL.skinD, step ? 7 : 6, 11, 2, 2);
  R(g, PAL.k1, step ? 3 : 4, 13, 2, 1);
  R(g, PAL.k1, step ? 7 : 6, 13, 2, 1);
  // body
  R(g, PAL.skin, 3, 6, 6, 4);
  R(g, PAL.skinD, 8, 6, 1, 4);
  R(g, PAL.k2, 3, 9, 6, 2);
  R(g, PAL.k0, 3, 9, 6, 1);
  R(g, PAL.n0, 2, 5, 7, 2);
  R(g, PAL.n1, 2, 5, 3, 1);
  P(g, PAL.d1, 4, 6, 7, 6, 2, 6);
  // head
  R(g, PAL.metal, 3, 1, 5, 2);
  R(g, PAL.metalD, 7, 1, 1, 2);
  R(g, PAL.cloth, 4, 1, 1, 1);
  P(g, PAL.n2, 2, 0, 2, 1, 8, 0, 8, 1);
  R(g, PAL.skin, 5, 3, 3, 1);
  R(g, PAL.ink, 7, 3, 1, 1);
  R(g, PAL.k3, 4, 4, 4, 2);
  R(g, PAL.y1, 4, 4, 1, 1);
  // axe
  R(g, PAL.k2, 10, 2, 1, 10);
  R(g, PAL.skin, 9, 7, 1, 1);
  R(g, PAL.metal, 11, 1, 1, 4);
  R(g, PAL.metal, 10, 2, 1, 2);
  R(g, PAL.metalD, 11, 4, 1, 1);
  R(g, PAL.cloth, 11, 1, 1, 1);
}

/** Grey wolf, 12×9, facing right. */
function paintWolf(g, step) {
  // tail
  P(g, PAL.s2, 0, 1, 1, 2, 1, 3);
  R(g, PAL.s3, 0, 2, 1, 2);
  // body
  R(g, PAL.s3, 2, 3, 7, 3);
  R(g, PAL.s2, 3, 3, 5, 1);
  R(g, PAL.s4, 3, 5, 5, 1);
  R(g, PAL.s3, 8, 2, 2, 4);
  R(g, PAL.s4, 8, 4, 1, 2);
  // head
  R(g, PAL.s3, 9, 1, 2, 3);
  R(g, PAL.s2, 9, 0, 1, 1);
  R(g, PAL.s4, 10, 3, 2, 1);
  R(g, PAL.ink, 11, 3, 1, 1);
  R(g, PAL.y2, 10, 2, 1, 1);
  // legs
  const xs = step ? [1, 4, 7, 10] : [3, 4, 8, 9];
  for (const [i, x] of xs.entries()) R(g, i % 2 ? PAL.s2 : PAL.s1, x, 6, 1, 3);
}

/** Ogre, 16×20: green brute with a studded club. */
function paintOgre(g, step) {
  // legs
  R(g, PAL.ogre1, step ? 3 : 4, 15, 3, 4);
  R(g, PAL.ogre0, step ? 10 : 9, 15, 3, 4);
  R(g, PAL.k1, step ? 3 : 4, 19, 3, 1);
  R(g, PAL.k1, step ? 10 : 9, 19, 3, 1);
  // back arm
  R(g, PAL.ogre0, 1, 7, 2, 6);
  R(g, PAL.ogre1, 1, 12, 2, 1);
  // body
  R(g, PAL.ogre1, 3, 6, 10, 8);
  R(g, PAL.ogre1, 2, 8, 12, 4);
  R(g, PAL.ogre2, 3, 6, 4, 4);
  R(g, PAL.ogre2, 2, 8, 2, 2);
  R(g, PAL.ogre0, 11, 7, 3, 6);
  R(g, PAL.ogre2, 6, 10, 3, 2);
  // loincloth
  R(g, PAL.k2, 3, 13, 10, 2);
  R(g, PAL.k1, 3, 14, 10, 1);
  R(g, PAL.k1, 7, 15, 3, 2);
  // head
  R(g, PAL.ogre1, 6, 1, 5, 5);
  R(g, PAL.ogre2, 6, 1, 2, 2);
  R(g, PAL.ogre0, 6, 2, 5, 1);
  R(g, PAL.ink, 9, 3, 1, 1);
  R(g, PAL.ogre0, 7, 5, 4, 1);
  P(g, PAL.cloth, 8, 4, 10, 4);
  // front arm and club
  R(g, PAL.ogre1, 13, 7, 2, 4);
  R(g, PAL.ogre0, 14, 7, 1, 4);
  R(g, PAL.k2, 13, 0, 3, 5);
  R(g, PAL.k3, 13, 0, 1, 4);
  R(g, PAL.k1, 15, 1, 1, 4);
  R(g, PAL.k2, 14, 5, 1, 5);
  P(g, PAL.metal, 14, 1, 13, 3, 15, 3);
  R(g, PAL.ogre2, 13, 10, 2, 2);
}

/** Bigger or neutral units: content size, feet column, painter. Feet sit on the content's bottom row. */
const UNIT_SHAPES = {
  cavalry: { w: 18, h: 18, feet: 9, team: true, paint: paintCavalry },
  catapult: { w: 16, h: 14, feet: 8, team: true, paint: paintCatapult },
  healer: { w: 12, h: 14, feet: 6, team: true, paint: paintHealer },
  barbarian: { w: 12, h: 14, feet: 6, team: false, paint: (g, t, step) => paintBarbarian(g, step) },
  wolf: { w: 12, h: 9, feet: 6, team: false, paint: (g, t, step) => paintWolf(g, step) },
  ogre: { w: 16, h: 20, feet: 8, team: false, paint: (g, t, step) => paintOgre(g, step) },
};

/** Unit kinds unitSprite draws (anything else falls back to the warrior). */
const UNIT_KINDS = Object.freeze(['warrior', 'archer', ...Object.keys(UNIT_SHAPES)]);

/**
 * Unit sprites, two walk frames, facing right; (ox, oy) is the canvas offset from the feet.
 * warrior/archer/healer/barbarian 12×14, cavalry 18×18, catapult 16×14, wolf 12×9, ogre 16×20.
 * barbarian, wolf and ogre are neutral and ignore `color`. Unknown kinds draw the warrior.
 */
export function unitSprite(kind, color, frame) {
  return cached(`unit:${kind}:${color}:${frame}`, () => {
    const shape = UNIT_SHAPES[kind];
    if (shape) {
      const { c, g } = makeCanvas(shape.w + 2, shape.h + 2);
      g.translate(1, 1);
      shape.paint(g, shape.team ? teamRamp(color) : null, frame === 1);
      g.setTransform(1, 0, 0, 1, 0, 0);
      outline(c);
      return { c, ox: -1 - shape.feet, oy: -shape.h };
    }
    const t = teamRamp(color);
    const { c, g } = makeCanvas(14, 16);
    g.translate(1, 1);
    const step = frame === 1;
    // legs
    R(g, PAL.k0, step ? 3 : 4, 11, 2, 3);
    R(g, PAL.k0, step ? 7 : 6, 11, 2, 3);
    if (kind === 'archer') {
      R(g, PAL.k2, 3, 6, 6, 5);
      R(g, PAL.k1, 7, 6, 2, 5);
      R(g, t.t2, 3, 6, 1, 1); R(g, t.t2, 4, 7, 1, 1); R(g, t.t2, 5, 8, 1, 1); R(g, t.t2, 6, 9, 1, 1); R(g, t.t2, 7, 10, 1, 1);
      // hood
      R(g, t.t2, 3, 1, 5, 5);
      R(g, t.t3, 3, 1, 2, 3);
      R(g, t.t1, 7, 2, 1, 4);
      R(g, PAL.skin, 5, 3, 3, 2);
      R(g, PAL.ink, 7, 3, 1, 1);
      // bow
      R(g, PAL.k3, 10, 2, 1, 1); R(g, PAL.k3, 11, 3, 1, 6); R(g, PAL.k3, 10, 9, 1, 1);
      R(g, PAL.cloth, 10, 3, 1, 6);
    } else {
      R(g, t.t2, 3, 6, 6, 5);
      R(g, t.t3, 3, 6, 2, 4);
      R(g, t.t1, 8, 6, 1, 5);
      R(g, PAL.k1, 3, 9, 6, 1);
      // helmet + face
      R(g, PAL.metal, 3, 1, 5, 3);
      R(g, PAL.metalD, 7, 1, 1, 3);
      R(g, PAL.skin, 5, 3, 3, 2);
      R(g, PAL.ink, 7, 3, 1, 1);
      R(g, PAL.metalD, 4, 4, 1, 1);
      // shield
      R(g, t.t1, 0, 5, 3, 5);
      R(g, t.t3, 1, 6, 1, 2);
      R(g, PAL.metal, 1, 8, 1, 1);
      // sword
      R(g, PAL.metal, 10, 1, 1, 7);
      R(g, PAL.cloth, 10, 1, 1, 2);
      R(g, PAL.k1, 9, 8, 3, 1);
      R(g, PAL.k2, 10, 9, 1, 1);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return { c, ox: -7, oy: -14 };
  });
}

// ------------------------------------------------------------------ nature

/** Trees for forest tiles: 0 = broadleaf, 1 = pine. */
export function treeSprite(variant) {
  return cached(`tree:${variant}`, () => {
    const { c, g } = makeCanvas(18, 24);
    g.translate(1, 1);
    if (variant === 1) {
      R(g, PAL.k1, 7, 17, 2, 4);
      const tiers = [[2, 6, 3], [6, 11, 5], [10, 17, 7]];
      for (const [y0, y1, half] of tiers) {
        for (let y = y0; y <= y1; y++) {
          const hw = Math.round(((y - y0 + 1) / (y1 - y0 + 1)) * half);
          for (let x = 8 - hw; x < 8 + hw; x++) {
            let col = PAL.f2;
            if (x < 8 - hw / 3) col = PAL.f3;
            if (x >= 8 + hw / 3) col = PAL.f1;
            if (y === y1) col = PAL.f1;
            R(g, col, x, y);
          }
        }
      }
      R(g, PAL.f4, 6, 4, 1, 1); R(g, PAL.f4, 4, 9, 2, 1); R(g, PAL.f4, 3, 14, 2, 1);
    } else {
      R(g, PAL.k1, 7, 15, 2, 6);
      R(g, PAL.k0, 8, 15, 1, 6);
      const blob = (cx, cy, r, col) => {
        for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) R(g, col, cx + x, cy + y);
      };
      blob(8, 9, 7, PAL.f1);
      blob(7, 8, 6, PAL.f2);
      blob(6, 6, 4, PAL.f3);
      blob(5, 5, 2, PAL.f4);
      R(g, PAL.f0, 10, 14, 3, 1); R(g, PAL.f0, 12, 12, 2, 2);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c, PAL.f0);
    return { c, ox: -1, oy: 16 - 23 };
  });
}

// ------------------------------------------------------------------ HUD icons

function toDataUrl(c, scale) {
  const { c: big, g } = makeCanvas(c.width * scale, c.height * scale);
  g.drawImage(c, 0, 0, big.width, big.height);
  return big.toDataURL('image/png');
}

/**
 * Small UI icons as data URLs (9×9 art px plus outline): coin, helmet, crown, shield, chat,
 * sword, wood, stone, lock, skull, hammer, flag, heart, anvil.
 */
export function iconUrl(name, scale = 3) {
  return cached(`icon:${name}:${scale}`, () => {
    const { c, g } = makeCanvas(11, 11);
    g.translate(1, 1);
    if (name === 'coin') {
      R(g, PAL.y1, 1, 0, 6, 9); R(g, PAL.y1, 0, 1, 9, 7);
      R(g, PAL.y2, 1, 1, 6, 7); R(g, PAL.y3, 2, 1, 2, 1); R(g, PAL.y3, 1, 2, 1, 2);
      R(g, PAL.y1, 4, 2, 1, 5); R(g, PAL.y0, 5, 2, 1, 5);
    } else if (name === 'helmet') {
      R(g, PAL.metal, 1, 1, 7, 5); R(g, PAL.metal, 2, 0, 5, 1); R(g, PAL.cloth, 2, 1, 2, 2);
      R(g, PAL.metalD, 6, 1, 2, 5); R(g, PAL.ink, 1, 6, 2, 2); R(g, PAL.ink, 6, 6, 2, 2);
      R(g, PAL.metal, 1, 6, 1, 3); R(g, PAL.metal, 7, 6, 1, 3); R(g, PAL.metalD, 4, 4, 1, 4);
    } else if (name === 'crown') {
      R(g, PAL.y2, 0, 3, 9, 5); R(g, PAL.y2, 0, 1, 1, 2); R(g, PAL.y2, 4, 0, 1, 3); R(g, PAL.y2, 8, 1, 1, 2);
      R(g, PAL.y1, 0, 7, 9, 1); R(g, PAL.red, 2, 4, 1, 2); R(g, PAL.w3, 4, 4, 1, 2); R(g, PAL.red, 6, 4, 1, 2);
      R(g, PAL.y3, 1, 3, 2, 1);
    } else if (name === 'shield') {
      R(g, PAL.w3, 0, 0, 9, 5); R(g, PAL.w3, 1, 5, 7, 2); R(g, PAL.w3, 3, 7, 3, 2);
      R(g, PAL.w4, 1, 1, 3, 3); R(g, PAL.w2, 5, 1, 3, 5); R(g, PAL.cloth, 4, 0, 1, 8);
    } else if (name === 'chat') {
      R(g, PAL.cloth, 0, 0, 9, 6); R(g, PAL.cloth, 1, 6, 2, 2); R(g, PAL.ink, 2, 2, 1, 1);
      R(g, PAL.ink, 4, 2, 1, 1); R(g, PAL.ink, 6, 2, 1, 1); R(g, PAL.n1, 0, 5, 9, 1);
    } else if (name === 'sword') {
      R(g, PAL.metal, 7, 0, 2, 2); R(g, PAL.metal, 6, 1, 2, 2); R(g, PAL.metal, 5, 2, 2, 2); R(g, PAL.metal, 4, 3, 2, 2);
      R(g, PAL.cloth, 7, 0, 1, 1); R(g, PAL.k2, 1, 4, 4, 1); R(g, PAL.k2, 3, 2, 1, 4); R(g, PAL.k1, 1, 6, 2, 2);
    } else if (name === 'wood') {
      R(g, PAL.k2, 0, 2, 6, 5); R(g, PAL.k3, 0, 2, 6, 1); R(g, PAL.k1, 0, 6, 6, 1);
      P(g, PAL.k1, 1, 4, 3, 3, 4, 5);
      R(g, PAL.k1, 6, 1, 2, 7); R(g, PAL.k1, 5, 2, 4, 5);
      R(g, PAL.n1, 6, 2, 2, 5); R(g, PAL.n2, 6, 2, 1, 2); R(g, PAL.n0, 7, 4, 1, 1);
    } else if (name === 'stone') {
      R(g, PAL.s4, 1, 1, 7, 3); R(g, PAL.cloth, 1, 1, 3, 1);
      R(g, PAL.s3, 1, 4, 7, 4); R(g, PAL.s2, 6, 4, 2, 4); R(g, PAL.s3, 0, 2, 1, 5);
      P(g, PAL.s2, 3, 5, 4, 6, 4, 7);
    } else if (name === 'lock') {
      R(g, PAL.metal, 2, 0, 5, 1); R(g, PAL.metal, 1, 1, 1, 3); R(g, PAL.metalD, 7, 1, 1, 3);
      R(g, PAL.y2, 0, 4, 9, 5); R(g, PAL.y3, 1, 4, 3, 1); R(g, PAL.y1, 7, 4, 2, 5); R(g, PAL.y1, 0, 8, 9, 1);
      R(g, PAL.ink, 4, 5, 1, 2); R(g, PAL.ink, 3, 6, 3, 1);
    } else if (name === 'skull') {
      R(g, PAL.cloth, 1, 0, 7, 6); R(g, PAL.cloth, 0, 1, 9, 4); R(g, PAL.cloth, 2, 6, 5, 2);
      R(g, PAL.n1, 7, 1, 1, 5); R(g, PAL.n1, 8, 1, 1, 4); R(g, PAL.n1, 5, 6, 2, 2);
      R(g, PAL.ink, 2, 3, 2, 2); R(g, PAL.ink, 5, 3, 2, 2); R(g, PAL.ink, 4, 5, 1, 1);
      R(g, PAL.ink, 3, 7, 1, 1); R(g, PAL.ink, 5, 7, 1, 1);
    } else if (name === 'hammer') {
      R(g, PAL.metal, 0, 0, 9, 3); R(g, PAL.cloth, 1, 0, 2, 1); R(g, PAL.metalD, 0, 2, 9, 1); R(g, PAL.metalD, 7, 0, 2, 3);
      R(g, PAL.k3, 4, 3, 1, 6); R(g, PAL.k1, 5, 3, 1, 6);
    } else if (name === 'flag') {
      R(g, PAL.k2, 1, 1, 1, 8); R(g, PAL.y2, 1, 0, 1, 1);
      R(g, PAL.red, 2, 1, 4, 4); R(g, PAL.red, 6, 2, 3, 4);
      R(g, PAL.redD, 2, 4, 4, 1); R(g, PAL.redD, 6, 5, 3, 1); R(g, PAL.cloth, 3, 2, 2, 1);
    } else if (name === 'heart') {
      R(g, PAL.red, 1, 0, 3, 1); R(g, PAL.red, 5, 0, 3, 1); R(g, PAL.red, 0, 1, 9, 3);
      R(g, PAL.red, 1, 4, 7, 1); R(g, PAL.red, 2, 5, 5, 1); R(g, PAL.red, 3, 6, 3, 1); R(g, PAL.red, 4, 7, 1, 1);
      R(g, PAL.redD, 7, 2, 1, 2); R(g, PAL.redD, 6, 4, 1, 1); R(g, PAL.redD, 5, 5, 1, 1);
      R(g, PAL.cloth, 1, 1, 2, 1); R(g, PAL.cloth, 1, 2, 1, 1);
    } else if (name === 'anvil') {
      R(g, PAL.metal, 0, 1, 9, 1); R(g, PAL.cloth, 1, 1, 3, 1);
      R(g, PAL.metal, 2, 2, 7, 1); R(g, PAL.metalD, 3, 3, 5, 1);
      R(g, PAL.metalD, 4, 4, 3, 2); R(g, PAL.s1, 2, 6, 7, 2); R(g, PAL.s2, 2, 6, 3, 1);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return toDataUrl(c, scale);
  });
}

/** Kinds whose preview keeps the original placement (fixed square, no fitting). */
const LEGACY_PREVIEW = new Set(['core', 'tower', 'mine', 'barracks', 'wall', 'warrior', 'archer']);
/** Kinds spriteFor knows besides walls. */
const FIT_PREVIEW = new Set([
  'gate', 'sawmill', 'quarry', 'stable', 'workshop', 'forge', 'outpost', 'shrine',
  'camp_barbarian', 'camp_wolves', 'camp_ogre', ...Object.keys(UNIT_SHAPES),
]);

/**
 * A building or unit drawn into a square icon (for the action bar). For the newer kinds the
 * square grows past `size` when the sprite would not fit, so the data URL can be larger than
 * size × scale; units are centred, buildings sit on the bottom edge.
 */
export function previewUrl(kind, color, size = 22, scale = 2) {
  return cached(`preview:${kind}:${color}:${size}:${scale}`, () => {
    if (FIT_PREVIEW.has(kind)) {
      const s = kind === 'gate' ? gateSprite(color, 10) : spriteFor(kind, color);
      const b = opaqueBounds(s.c);
      const side = Math.max(size, b.w, b.h);
      const { c, g } = makeCanvas(side, side);
      const x = Math.floor((side - b.w) / 2) - b.x;
      const y = (UNIT_SHAPES[kind] ? Math.floor((side - b.h) / 2) : side - Math.min(1, side - b.h) - b.h) - b.y;
      g.drawImage(s.c, x, y);
      return toDataUrl(c, scale);
    }
    const { c, g } = makeCanvas(size, size);
    let s;
    if (kind === 'warrior' || kind === 'archer') s = unitSprite(kind, color, 0);
    else if (kind === 'wall') s = wallSprite(color, 10);
    else s = spriteFor(kind, color);
    const x = Math.floor((size - s.c.width) / 2);
    const y = size - s.c.height - (kind === 'warrior' || kind === 'archer' ? 3 : 1);
    g.drawImage(s.c, x, Math.max(0, y));
    return toDataUrl(c, scale);
  });
}

/**
 * Sprite by kind. Buildings are tile-anchored (walls and gates need their mask for joins:
 * use wallSprite/gateSprite); unit kinds return frame 0, anchored on the feet. `level` is the
 * keep level. 'shrine' takes the holder colour or null. Unknown kinds draw a lone wall.
 */
export function spriteFor(kind, color, level = 1) {
  switch (kind) {
    case 'core': return keepSprite(color, level);
    case 'tower': return towerSprite(color);
    case 'mine': return mineSprite(color);
    case 'barracks': return barracksSprite(color);
    case 'gate': return gateSprite(color, 0);
    case 'sawmill': return sawmillSprite(color);
    case 'quarry': return quarrySprite(color);
    case 'stable': return stableSprite(color);
    case 'workshop': return workshopSprite(color);
    case 'forge': return forgeSprite(color);
    case 'outpost': return outpostSprite(color);
    case 'shrine': return shrineSprite(color ?? null);
    case 'camp_barbarian': return campSprite('barbarian');
    case 'camp_wolves': return campSprite('wolves');
    case 'camp_ogre': return campSprite('ogre');
    default:
      if (UNIT_KINDS.includes(kind)) return unitSprite(kind, color, 0);
      return wallSprite(color, 0);
  }
}
