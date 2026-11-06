import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsFrom, territoryOwner, countAround } from '../../../src/shared/territory.js';
import { CONFIG, keepLevel } from '../../../src/shared/config.js';

test('territory_keep_radius_grows_with_level', () => {
  const claims = claimsFrom([{ owner: 1, kind: 'core', x: 50, y: 50, level: 2 }]);
  assert.equal(claims[0].r, keepLevel(2).radius);
  assert.equal(territoryOwner(claims, 50 + keepLevel(2).radius, 50), 1);
  assert.equal(territoryOwner(claims, 50 + keepLevel(2).radius + 1, 50), 0);
});

test('territory_outposts_add_a_disc', () => {
  const claims = claimsFrom([
    { owner: 1, kind: 'core', x: 20, y: 20, level: 1 },
    { owner: 1, kind: 'outpost', x: 28, y: 20 },
    { owner: 1, kind: 'wall', x: 21, y: 20 },
  ]);
  assert.equal(claims.length, 2, 'walls claim nothing');
  assert.equal(territoryOwner(claims, 28 + CONFIG.territory.outpostRadius, 20), 1);
});

test('territory_overlap_goes_to_the_nearest_claim', () => {
  const claims = claimsFrom([
    { owner: 1, kind: 'core', x: 20, y: 20, level: 1 },
    { owner: 2, kind: 'core', x: 34, y: 20, level: 1 },
  ]);
  assert.equal(territoryOwner(claims, 26, 20), 1);
  assert.equal(territoryOwner(claims, 28, 20), 2);
});

test('territory_count_around_checks_the_8_neighbourhood', () => {
  const set = new Set(['4,5', '6,6', '5,5']);
  assert.equal(countAround(5, 5, (x, y) => set.has(`${x},${y}`)), 2, 'centre tile is excluded');
});
