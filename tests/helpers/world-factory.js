/**
 * Test factories for BASTIONS worlds: flat all-grass maps, a controllable clock
 * and deterministic randomness, so every test builds its own isolated state.
 */
import { World } from '../../src/server/world.js';
import { CONFIG, TILE } from '../../src/shared/config.js';
import { mulberry32 } from '../../src/shared/mapgen.js';

/** Plenty of everything, for tests that are not about the economy. */
export const RICH = Object.freeze({ gold: 8000, wood: 8000, stone: 8000 });

/** A manual clock: `clock.now()` returns ms, `clock.advance(seconds)` moves it. */
export function makeClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (s) => { t += s * 1000; } };
}

/**
 * A world whose terrain is all grass.
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @param {boolean} [opts.offlineShield]
 */
export function makeFlatWorld({ size = 64, offlineShield = true, clock = makeClock() } = {}) {
  const world = new World({ seed: 7, size, config: CONFIG, now: clock.now, random: mulberry32(99), offlineShield });
  world.tiles.fill(TILE.GRASS);
  world.resetEvents();
  return { world, clock };
}

/** Add an online player whose keep sits at (x, y), shield already expired. */
export function addPlayerAt(world, clock, name, x, y, { res = RICH, keepShield = false } = {}) {
  // Spawning tops up nearby gold/forest/rock; tests want the terrain they painted, so restore it.
  const terrain = world.tiles.slice();
  const r = world.addPlayer({ name, tokenHash: `hash-${name}`, at: { x, y } });
  world.tiles.set(terrain);
  if (!r.ok) throw new Error(r.reason);
  const p = r.player;
  world.setOnline(p.id, true);
  Object.assign(p, { gold: 0, wood: 0, stone: 0 }, res);
  if (!keepShield) p.shieldUntil = clock.now() - 1;
  return p;
}

/** Run the simulation for `seconds` at the configured tick rate. */
export function runFor(world, clock, seconds) {
  const dt = 1 / CONFIG.tickRate;
  const steps = Math.round(seconds * CONFIG.tickRate);
  for (let i = 0; i < steps; i++) {
    clock.advance(dt);
    world.tick(dt);
  }
}

/** Put a unit for `player` (or NEUTRAL = 0) directly at a position. */
export function spawnUnitAt(world, owner, kind, x, y) {
  return world.spawnUnit(owner, kind, x, y);
}

/** Paint a rectangle of terrain (tests set up forests, rocks, rivers). */
export function paint(world, code, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) world.tiles[world.idx(x, y)] = code;
}
