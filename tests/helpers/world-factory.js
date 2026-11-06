/**
 * Test factories for BASTIONS worlds: flat all-grass maps, a controllable clock
 * and deterministic randomness, so every test builds its own isolated state.
 */
import { World } from '../../src/server/world.js';
import { CONFIG, TILE } from '../../src/shared/config.js';
import { mulberry32 } from '../../src/shared/mapgen.js';

/** A manual clock: `clock.now()` returns ms, `clock.advance(seconds)` moves it. */
export function makeClock(startMs = 1_000_000) {
  let t = startMs;
  return { now: () => t, advance: (s) => { t += s * 1000; } };
}

/**
 * A world whose terrain is all grass (optionally with a few tiles overridden).
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @param {boolean} [opts.offlineShield]
 */
export function makeFlatWorld({ size = 48, offlineShield = true, clock = makeClock() } = {}) {
  const world = new World({ seed: 7, size, config: CONFIG, now: clock.now, random: mulberry32(99), offlineShield });
  world.tiles.fill(TILE.GRASS);
  world.resetEvents();
  return { world, clock };
}

/** Add an online player whose core sits at (x, y), shield already expired. */
export function addPlayerAt(world, clock, name, x, y, { gold = 5000, keepShield = false } = {}) {
  const res = world.addPlayer({ name, tokenHash: `hash-${name}`, at: { x, y } });
  if (!res.ok) throw new Error(res.reason);
  const p = res.player;
  world.setOnline(p.id, true);
  p.gold = gold;
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

/** Put a unit for `player` directly at a position (bypasses barracks). */
export function spawnUnitAt(world, player, kind, x, y) {
  return world.spawnUnit(player, kind, x, y);
}
