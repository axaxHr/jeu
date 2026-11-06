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

// ------------------------------------------------------------------ buildings

/** Castle keep, 28×30, wider than its tile. */
export function keepSprite(color) {
  return cached(`keep:${color}`, () => {
    const t = teamRamp(color);
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
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c, PAL.ink, { top: !!N, right: !!E, bottom: !!S, left: !!W });
    return { c, ox: -1, oy: -5 };
  });
}

// ------------------------------------------------------------------ units

/** Soldier sprites, 12×14, two walk frames, facing right. */
export function unitSprite(kind, color, frame) {
  return cached(`unit:${kind}:${color}:${frame}`, () => {
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

/** Small UI icons as data URLs: coin, helmet, crown, shield, chat. */
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
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    outline(c);
    return toDataUrl(c, scale);
  });
}

/** A building or unit drawn into a square icon (for the action bar). */
export function previewUrl(kind, color, size = 22, scale = 2) {
  return cached(`preview:${kind}:${color}:${size}:${scale}`, () => {
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

/** Building sprite by kind (walls need their mask: use wallSprite). */
export function spriteFor(kind, color) {
  switch (kind) {
    case 'core': return keepSprite(color);
    case 'tower': return towerSprite(color);
    case 'mine': return mineSprite(color);
    case 'barracks': return barracksSprite(color);
    default: return wallSprite(color, 0);
  }
}
