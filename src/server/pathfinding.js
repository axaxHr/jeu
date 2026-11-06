/**
 * Flow fields: one reverse Dijkstra from a goal tile gives every tile its cost
 * to reach that goal, so a whole army sent to the same target shares a single
 * computation. Units then step to the neighbour that minimises
 * `dist[neighbour] + stepCost`.
 */

const SQRT2 = Math.SQRT2;
/** 8-neighbourhood: [dx, dy, cost]. Orthogonal first. */
export const DIRS = Object.freeze([
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
]);

const DX = Int8Array.from(DIRS.map((d) => d[0]));
const DY = Int8Array.from(DIRS.map((d) => d[1]));
const DC = Float64Array.from(DIRS.map((d) => d[2]));

/**
 * Compute a flow field toward `goal`.
 * @param {object} grid
 * @param {number} grid.size Map width/height in tiles.
 * @param {(i:number) => boolean} grid.passable Can a unit stand on / move through tile i
 *   (a breakable enemy building counts as passable, with `extraCost`).
 * @param {(i:number) => boolean} grid.solid Tile blocks diagonal corner-cutting.
 * @param {(i:number) => number} grid.extraCost Additional cost to enter tile i.
 * @param {number} goal Goal tile index (always reachable as the destination).
 * @returns {Float64Array} Cost to reach the goal from each tile (Infinity = unreachable).
 */
export function computeFlowField({ size, passable, solid, extraCost }, goal) {
  const n = size * size;
  // Sample the predicates once into typed arrays: the search below touches each
  // tile up to 8 times, and closures per neighbour dominated the cost.
  const pass = new Uint8Array(n);
  const sol = new Uint8Array(n);
  const extra = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pass[i] = passable(i) ? 1 : 0;
    sol[i] = solid(i) ? 1 : 0;
    extra[i] = pass[i] ? extraCost(i) : 0;
  }
  extra[goal] = 0;

  // Float64 on purpose: Float32 storage rounds below the heap's double priorities,
  // which made the stale-entry check skip valid nodes.
  const dist = new Float64Array(n).fill(Infinity);

  // Binary min-heap in parallel typed arrays (priority, tile).
  let cap = 1024;
  let hp = new Float64Array(cap);
  let hv = new Int32Array(cap);
  let hs = 0;
  const push = (pr, v) => {
    if (hs === cap) {
      cap *= 2;
      const np = new Float64Array(cap); np.set(hp); hp = np;
      const nv = new Int32Array(cap); nv.set(hv); hv = nv;
    }
    let i = hs++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (hp[parent] <= pr) break;
      hp[i] = hp[parent]; hv[i] = hv[parent];
      i = parent;
    }
    hp[i] = pr; hv[i] = v;
  };

  dist[goal] = 0;
  push(0, goal);
  while (hs > 0) {
    const d = hp[0];
    const b = hv[0];
    hs--;
    if (hs > 0) {
      const lp = hp[hs];
      const lv = hv[hs];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= hs) break;
        const r = l + 1;
        const m = r < hs && hp[r] < hp[l] ? r : l;
        if (hp[m] >= lp) break;
        hp[i] = hp[m]; hv[i] = hv[m];
        i = m;
      }
      hp[i] = lp; hv[i] = lv;
    }
    if (d > dist[b]) continue;
    const bx = b % size;
    const by = (b - bx) / size;
    const enter = extra[b];
    for (let k = 0; k < 8; k++) {
      // A unit standing on `a` moves into `b`, so a = b - (dx, dy).
      const ax = bx - DX[k];
      const ay = by - DY[k];
      if (ax < 0 || ay < 0 || ax >= size || ay >= size) continue;
      const a = ay * size + ax;
      if (!pass[a]) continue;
      if (k >= 4 && (sol[ay * size + bx] || sol[by * size + ax])) continue;
      const nd = d + DC[k] + enter;
      if (nd < dist[a]) {
        dist[a] = nd;
        push(nd, a);
      }
    }
  }
  return dist;
}

/**
 * Pick the best next tile from `from` using a flow field.
 * @returns {number} Tile index, or -1 when no neighbour leads toward the goal.
 */
export function nextStep(field, { size, solid, extraCost }, from, goal) {
  if (from === goal) return goal;
  const fx = from % size;
  const fy = (from - fx) / size;
  let best = -1;
  let bestCost = Infinity;
  for (const [dx, dy, step] of DIRS) {
    const x = fx + dx;
    const y = fy + dy;
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const i = y * size + x;
    if (!Number.isFinite(field[i])) continue;
    if (dx !== 0 && dy !== 0) {
      if (solid(fy * size + x) || solid(y * size + fx)) continue;
    }
    const c = field[i] + step + (i === goal ? 0 : extraCost(i));
    if (c < bestCost) {
      bestCost = c;
      best = i;
    }
  }
  return best;
}
