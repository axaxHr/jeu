/**
 * Pixel-art terrain painter. The whole map is painted once into an offscreen
 * canvas at 16 art pixels per tile: dithered ground per pixel, then beaches,
 * cliffs, ore and trees on top. Tile edits repaint a 3×3 neighbourhood.
 */
import { TILE } from './shared/config.js';
import { ART, PAL, makeCanvas, treeSprite } from './sprites.js';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16);

/** Deterministic hash of integer coordinates to [0, 1). */
export function hash(x, y, z = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in pixel space (lattice every `cell` pixels). */
function noise(px, py, cell, seed) {
  const gx = px / cell;
  const gy = py / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const sx = gx - x0;
  const sy = gy - y0;
  const u = sx * sx * (3 - 2 * sx);
  const v = sy * sy * (3 - 2 * sy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const GRASS = [PAL.g1, PAL.g2, PAL.g3].map(rgb);
const FOREST_FLOOR = [PAL.g0, PAL.g1, PAL.g1].map(rgb);
const WATER = [PAL.w1, PAL.w2, PAL.w2].map(rgb);
const ROCK = [PAL.s2, PAL.s3, PAL.s3].map(rgb);

/** Minimap colour per tile code. */
export const MINI_COLORS = {
  [TILE.GRASS]: rgb(PAL.g2),
  [TILE.WATER]: rgb(PAL.w2),
  [TILE.ROCK]: rgb(PAL.s2),
  [TILE.FOREST]: rgb(PAL.f2),
  [TILE.GOLD]: rgb(PAL.y1),
};

export class TerrainPainter {
  /**
   * @param {Uint8Array} tiles
   * @param {number} size Map size in tiles.
   */
  constructor(tiles, size) {
    this.tiles = tiles;
    this.size = size;
    const { c, g } = makeCanvas(size * ART, size * ART);
    this.canvas = c;
    this.g = g;
  }

  at(x, y) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return TILE.ROCK;
    return this.tiles[y * this.size + x];
  }

  /** Small rock deposits (at most one rock neighbour) are drawn as boulders on grass. */
  isBoulder(x, y) {
    if (this.at(x, y) !== TILE.ROCK) return false;
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.at(x + dx, y + dy) === TILE.ROCK) n++;
    return n <= 1;
  }

  paintAll() {
    this.paintGround(0, 0, this.size, this.size);
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.decorate(x, y);
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.trees(x, y);
    return this.canvas;
  }

  /** Repaint the tiles around index `i` after a server-side tile edit. */
  repaint(i) {
    const x = i % this.size;
    const y = Math.floor(i / this.size);
    const x0 = Math.max(0, x - 1);
    const y0 = Math.max(0, y - 1);
    const x1 = Math.min(this.size, x + 2);
    const y1 = Math.min(this.size, y + 2);
    this.paintGround(x0, y0, x1 - x0, y1 - y0);
    for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) this.decorate(tx, ty);
    for (let ty = y0; ty < y1 + 1 && ty < this.size; ty++) for (let tx = x0; tx < x1; tx++) this.trees(tx, ty);
  }

  /** Per-pixel dithered ground for a block of tiles. */
  paintGround(tx0, ty0, tw, th) {
    const w = tw * ART;
    const h = th * ART;
    const img = this.g.createImageData(w, h);
    const d = img.data;
    for (let py = 0; py < h; py++) {
      const gy = ty0 * ART + py;
      const ty = Math.floor(gy / ART);
      for (let px = 0; px < w; px++) {
        const gx = tx0 * ART + px;
        const tx = Math.floor(gx / ART);
        const t = this.tiles[ty * this.size + tx];
        let ramp = GRASS;
        let cell = 40;
        if (t === TILE.WATER) { ramp = WATER; cell = 20; }
        else if (t === TILE.ROCK && !this.isBoulder(tx, ty)) { ramp = ROCK; cell = 14; }
        else if (t === TILE.FOREST) ramp = FOREST_FLOOR;
        let n = noise(gx, gy, cell, t === TILE.WATER ? 7 : 3) * 0.75
          + noise(gx, gy, 6, 11) * 0.25
          + (BAYER[(gy & 3) * 4 + (gx & 3)] - 0.5) * 0.22;
        if (ramp === ROCK) n = 0.55 + (n - 0.5) * 0.45; // calmer stone: mostly the light shade
        const col = ramp[n < 0.33 ? 0 : n < 0.66 ? 1 : 2];
        const o = (py * w + px) * 4;
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
      }
    }
    this.g.putImageData(img, tx0 * ART, ty0 * ART);
  }

  px(color, x, y, w = 1, h = 1) {
    this.g.fillStyle = color;
    this.g.fillRect(x, y, w, h);
  }

  decorate(x, y) {
    const t = this.at(x, y);
    const X = x * ART;
    const Y = y * ART;
    const h = hash(x, y);
    const land = (c) => c !== TILE.WATER;

    if (t === TILE.WATER) {
      // Bank shadow under land to the north, foam on every shore edge.
      if (land(this.at(x, y - 1))) { this.px(PAL.w0, X, Y, ART, 2); this.px(PAL.w4, X, Y + 2, ART, 1); }
      if (land(this.at(x, y + 1))) this.px(PAL.w3, X, Y + ART - 1, ART, 1);
      if (land(this.at(x - 1, y))) this.px(PAL.w3, X, Y, 1, ART);
      if (land(this.at(x + 1, y))) this.px(PAL.w3, X + ART - 1, Y, 1, ART);
      if (h < 0.35) {
        const wx = X + 2 + Math.floor(hash(x, y, 1) * 9);
        const wy = Y + 4 + Math.floor(hash(x, y, 2) * 9);
        this.px(PAL.w3, wx, wy, 3, 1);
        this.px(PAL.w3, wx + 1, wy - 1, 2, 1);
      }
      return;
    }

    if (t === TILE.ROCK && this.isBoulder(x, y)) {
      // Two or three rounded boulders with a lit top and a ground shadow.
      const stones = [[2, 6, 7, 6], [8, 3, 6, 6], [6, 9, 8, 6]];
      for (let k = 0; k < stones.length; k++) {
        const [sx, sy, w, hh] = stones[k];
        const ox = X + sx + Math.floor(hash(x, y, 100 + k) * 2);
        const oy = Y + sy;
        this.px('rgba(20, 14, 26, 0.35)', ox + 1, oy + hh - 1, w, 2);
        this.px(PAL.ink, ox, oy + 1, w, hh - 2);
        this.px(PAL.ink, ox + 1, oy, w - 2, hh);
        this.px(PAL.s2, ox + 1, oy + 1, w - 2, hh - 2);
        this.px(PAL.s3, ox + 1, oy + 1, w - 3, 2);
        this.px(PAL.s4, ox + 2, oy + 1, 2, 1);
        this.px(PAL.s1, ox + 1, oy + hh - 2, w - 2, 1);
      }
      return;
    }

    if (t === TILE.ROCK) {
      const below = this.at(x, y + 1) === TILE.ROCK;
      const above = this.at(x, y - 1) === TILE.ROCK;
      if (!above) this.px(PAL.s4, X, Y, ART, 1);
      if (this.at(x - 1, y) !== TILE.ROCK) this.px(PAL.s4, X, Y, 1, below ? ART : ART - 6);
      if (this.at(x + 1, y) !== TILE.ROCK) this.px(PAL.s1, X + ART - 1, Y, 1, ART);
      for (let k = 0; k < 3; k++) {
        const rx = X + 2 + Math.floor(hash(x, y, 20 + k) * 11);
        const ry = Y + 2 + Math.floor(hash(x, y, 30 + k) * (below ? 11 : 6));
        this.px(PAL.s1, rx, ry, 2, 1);
        this.px(PAL.s4, rx, ry - 1, 1, 1);
      }
      if (!below) {
        // Cliff face: the plateau drops toward the viewer.
        this.px(PAL.s1, X, Y + ART - 6, ART, 6);
        this.px(PAL.s0, X, Y + ART - 6, ART, 1);
        for (let k = 0; k < 4; k++) {
          const cx = X + 1 + Math.floor(hash(x, y, 40 + k) * 14);
          this.px(PAL.s0, cx, Y + ART - 5, 1, 2 + Math.floor(hash(x, y, 50 + k) * 3));
        }
        this.px(PAL.s2, X, Y + ART - 5, ART, 1);
      }
      return;
    }

    // Land tiles: grass, forest floor, gold veins.
    if (this.at(x, y - 1) === TILE.ROCK) {
      this.px('rgba(20, 14, 26, 0.35)', X, Y, ART, 2);
    }
    const sand = (side) => {
      for (let k = 0; k < ART; k++) {
        const depth = 2 + (hash(x * 31 + k, y, side) < 0.5 ? 1 : 0);
        if (side === 0) { this.px(PAL.n1, X + k, Y, 1, depth); this.px(PAL.n2, X + k, Y, 1, 1); }
        if (side === 1) this.px(PAL.n1, X + ART - depth, Y + k, depth, 1);
        if (side === 2) { this.px(PAL.n1, X + k, Y + ART - depth, 1, depth); this.px(PAL.n0, X + k, Y + ART - 1, 1, 1); }
        if (side === 3) this.px(PAL.n1, X, Y + k, depth, 1);
      }
    };
    if (this.at(x, y - 1) === TILE.WATER) sand(0);
    if (this.at(x + 1, y) === TILE.WATER) sand(1);
    if (this.at(x, y + 1) === TILE.WATER) sand(2);
    if (this.at(x - 1, y) === TILE.WATER) sand(3);

    if (t === TILE.GOLD) {
      const rocks = [[3, 5], [9, 3], [7, 10]];
      for (let k = 0; k < rocks.length; k++) {
        const [rx, ry] = rocks[k];
        const ox = X + rx + Math.floor(hash(x, y, 60 + k) * 3) - 1;
        const oy = Y + ry + Math.floor(hash(x, y, 70 + k) * 3) - 1;
        this.px(PAL.ink, ox - 1, oy, 7, 5);
        this.px(PAL.ink, ox, oy - 1, 5, 7);
        this.px(PAL.s2, ox, oy, 5, 5);
        this.px(PAL.s3, ox, oy, 3, 1);
        this.px(PAL.s1, ox + 4, oy + 1, 1, 4);
        this.px(PAL.y1, ox + 1, oy + 1, 3, 3);
        this.px(PAL.y2, ox + 1, oy + 1, 2, 2);
        this.px(PAL.y3, ox + 1, oy + 1, 1, 1);
      }
      return;
    }

    if (t === TILE.GRASS) {
      const tufts = Math.floor(hash(x, y, 3) * 4);
      for (let k = 0; k < tufts; k++) {
        const gx = X + 1 + Math.floor(hash(x, y, 80 + k) * 13);
        const gy = Y + 3 + Math.floor(hash(x, y, 90 + k) * 11);
        this.px(PAL.g4, gx, gy, 1, 2);
        this.px(PAL.g4, gx + 2, gy, 1, 2);
        this.px(PAL.g5, gx + 1, gy - 1, 1, 2);
        this.px(PAL.g1, gx, gy + 2, 3, 1);
      }
      if (h > 0.9) {
        const fx = X + 3 + Math.floor(hash(x, y, 5) * 10);
        const fy = Y + 3 + Math.floor(hash(x, y, 6) * 10);
        const petal = [PAL.cloth, PAL.y3, PAL.red][Math.floor(hash(x, y, 7) * 3)];
        this.px(petal, fx - 1, fy, 3, 1);
        this.px(petal, fx, fy - 1, 1, 3);
        this.px(PAL.y2, fx, fy, 1, 1);
      }
    }
  }

  trees(x, y) {
    if (this.at(x, y) !== TILE.FOREST) return;
    const count = hash(x, y, 8) < 0.45 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const spr = treeSprite(hash(x, y, 9 + k) < 0.35 ? 1 : 0);
      const jx = count === 2 ? (k === 0 ? -4 : 4) : Math.floor(hash(x, y, 12) * 5) - 2;
      const jy = count === 2 ? (k === 0 ? -2 : 1) : Math.floor(hash(x, y, 13) * 3) - 1;
      const X = x * ART + spr.ox + jx;
      const Y = y * ART + spr.oy + jy;
      this.g.fillStyle = 'rgba(16, 28, 20, 0.45)';
      this.g.fillRect(X + 4, y * ART + 13 + jy, 10, 2);
      this.g.fillRect(X + 5, y * ART + 12 + jy, 8, 4);
      this.g.drawImage(spr.c, X, Y);
    }
  }
}
