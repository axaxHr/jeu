import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFlowField, nextStep } from '../../../src/server/pathfinding.js';

/** Build a grid from ASCII rows: '.' open, '#' solid terrain, 'W' breakable wall. */
function grid(rows, breakCost = 10) {
  const size = rows.length;
  const cells = rows.join('');
  return {
    size,
    passable: (i) => cells[i] !== '#',
    solid: (i) => cells[i] !== '.',
    extraCost: (i) => (cells[i] === 'W' ? breakCost : 0),
  };
}

function walk(g, field, from, goal, maxSteps = 200) {
  const path = [from];
  let cur = from;
  for (let k = 0; k < maxSteps && cur !== goal; k++) {
    cur = nextStep(field, g, cur, goal);
    if (cur < 0) return null;
    path.push(cur);
  }
  return cur === goal ? path : null;
}

test('flowfield_open_grid_cost_is_octile_distance', () => {
  const g = grid(['.....', '.....', '.....', '.....', '.....']);
  const field = computeFlowField(g, 0);
  assert.equal(field[0], 0);
  assert.equal(field[4], 4);
  assert.ok(Math.abs(field[24] - 4 * Math.SQRT2) < 1e-5);
});

test('flowfield_routes_around_solid_terrain', () => {
  const g = grid([
    '.....',
    '####.',
    '.....',
    '.####',
    '.....',
  ]);
  const goal = 0;
  const from = 24;
  const field = computeFlowField(g, goal);
  const path = walk(g, field, from, goal);
  assert.ok(path, 'a path exists');
  for (const i of path) assert.ok(g.passable(i), `tile ${i} on the path is passable`);
});

test('flowfield_marks_enclosed_areas_unreachable', () => {
  const g = grid([
    '..#..',
    '..#..',
    '###..',
    '.....',
    '.....',
  ]);
  const field = computeFlowField(g, 24);
  assert.equal(field[0], Infinity);
  assert.equal(nextStep(field, g, 0, 24), -1);
});

test('flowfield_breaks_a_wall_when_the_detour_is_longer', () => {
  // Goal enclosed by walls: the only way in is through a W.
  const g = grid([
    '.......',
    '.WWWWW.',
    '.W...W.',
    '.W...W.',
    '.W...W.',
    '.WWWWW.',
    '.......',
  ], 5);
  const goal = 3 * 7 + 3;
  const from = 0;
  const field = computeFlowField(g, goal);
  assert.ok(Number.isFinite(field[from]));
  const path = walk(g, field, from, goal);
  assert.ok(path.some((i) => g.extraCost(i) > 0), 'path crosses a wall');
});

test('flowfield_never_cuts_corners_between_solid_tiles', () => {
  const g = grid([
    '.#',
    '#.',
  ]);
  const field = computeFlowField(g, 3);
  assert.equal(field[0], Infinity, 'diagonal squeeze is forbidden');
});
