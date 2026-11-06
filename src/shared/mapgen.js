/**
 * Deterministic terrain generation. The same (seed, size) always yields the
 * same map, so the server only needs to persist the seed plus later edits.
 */
import { TILE } from './config.js';

/**
 * Mulberry32 seeded PRNG.
 * @param {number} seed 32-bit integer seed.
 * @returns {() => number} Function returning floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash an arbitrary string to a 32-bit seed. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Smooth value noise on a lattice of `cell` tiles, sampled at (x, y). */
function makeValueNoise(rng, cell, size) {
  const n = Math.ceil(size / cell) + 2;
  const lattice = new Float32Array(n * n);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = smooth(gx - x0);
    const ty = smooth(gy - y0);
    const v = (ix, iy) => lattice[iy * n + ix];
    const top = v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx;
    const bottom = v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/** Fractal noise: three octaves of value noise normalised to [0, 1]. */
function makeFbm(rng, size, baseCell) {
  const octaves = [
    { noise: makeValueNoise(rng, baseCell, size), weight: 0.6 },
    { noise: makeValueNoise(rng, baseCell / 2, size), weight: 0.28 },
    { noise: makeValueNoise(rng, baseCell / 4, size), weight: 0.12 },
  ];
  return (x, y) => octaves.reduce((sum, o) => sum + o.noise(x, y) * o.weight, 0);
}

/**
 * Generate a square terrain map.
 * @param {number} seed 32-bit seed.
 * @param {number} size Width and height in tiles.
 * @param {object} mapConfig CONFIG.map (thresholds, gold density).
 * @returns {{size:number, tiles:Uint8Array}} Row-major tile codes (TILE.*).
 */
export function generateMap(seed, size, mapConfig) {
  const rng = mulberry32(seed);
  const elevation = makeFbm(rng, size, 24);
  const moisture = makeFbm(rng, size, 14);
  const tiles = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const e = elevation(x, y);
      const m = moisture(x, y);
      let t = TILE.GRASS;
      if (e < mapConfig.waterBelow) t = TILE.WATER;
      else if (e > mapConfig.rockAbove) t = TILE.ROCK;
      else if (m > mapConfig.forestMoistureAbove) t = TILE.FOREST;
      tiles[y * size + x] = t;
    }
  }

  const clusters = Math.round((size * size / 1000) * mapConfig.goldClustersPer1000);
  for (let c = 0; c < clusters; c++) {
    let x = Math.floor(rng() * size);
    let y = Math.floor(rng() * size);
    const count = mapConfig.goldClusterMin
      + Math.floor(rng() * (mapConfig.goldClusterMax - mapConfig.goldClusterMin + 1));
    for (let k = 0; k < count; k++) {
      if (x >= 0 && y >= 0 && x < size && y < size && tiles[y * size + x] === TILE.GRASS) {
        tiles[y * size + x] = TILE.GOLD;
      }
      x += Math.floor(rng() * 3) - 1;
      y += Math.floor(rng() * 3) - 1;
    }
  }
  return { size, tiles };
}
