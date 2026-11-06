import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, mulberry32, hashSeed } from '../../../src/shared/mapgen.js';
import { CONFIG, TILE } from '../../../src/shared/config.js';

test('mapgen_same_seed_produces_identical_maps', () => {
  const a = generateMap(1234, 64, CONFIG.map);
  const b = generateMap(1234, 64, CONFIG.map);
  assert.deepEqual(a.tiles, b.tiles);
});

test('mapgen_different_seeds_produce_different_maps', () => {
  const a = generateMap(1, 64, CONFIG.map);
  const b = generateMap(2, 64, CONFIG.map);
  assert.notDeepEqual(a.tiles, b.tiles);
});

test('mapgen_default_size_is_mostly_buildable_with_some_gold', () => {
  const { tiles } = generateMap(42, CONFIG.map.size, CONFIG.map);
  const count = (code) => tiles.reduce((n, t) => n + (t === code ? 1 : 0), 0);
  const total = tiles.length;
  assert.ok(count(TILE.GRASS) / total > 0.45, 'at least 45% grass');
  assert.ok(count(TILE.GOLD) > 10, 'some gold veins exist');
  assert.ok(count(TILE.WATER) + count(TILE.ROCK) + count(TILE.FOREST) > 0, 'some obstacles exist');
});

test('mulberry32_is_deterministic_and_in_unit_range', () => {
  const r1 = mulberry32(5);
  const r2 = mulberry32(5);
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});

test('hashSeed_is_stable', () => {
  assert.equal(hashSeed('bastions'), hashSeed('bastions'));
  assert.notEqual(hashSeed('a'), hashSeed('b'));
});
