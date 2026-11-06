/**
 * Territory rules shared by server (authority) and client (preview, borders).
 * A territory is the union of claim discs: one per keep (radius by keep level)
 * and one per outpost. Where claims of different players overlap, the tile goes
 * to the claim whose centre is nearest.
 */
import { CONFIG, keepLevel } from './config.js';

/**
 * Claim discs from a list of buildings.
 * @param {Iterable<{owner:number, kind:string, x:number, y:number, level?:number}>} buildings
 * @returns {Array<{owner:number, x:number, y:number, r:number}>}
 */
export function claimsFrom(buildings) {
  const out = [];
  for (const b of buildings) {
    if (b.kind === 'core') out.push({ owner: b.owner, x: b.x, y: b.y, r: keepLevel(b.level || 1).radius });
    else if (b.kind === 'outpost') out.push({ owner: b.owner, x: b.x, y: b.y, r: CONFIG.territory.outpostRadius });
  }
  return out;
}

/**
 * Owner of tile (x, y), or 0 when unclaimed.
 * @param {Array<{owner:number, x:number, y:number, r:number}>} claims
 */
export function territoryOwner(claims, x, y) {
  let best = 0;
  let bestD = Infinity;
  for (const c of claims) {
    const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d2 > c.r * c.r || d2 >= bestD) continue;
    bestD = d2;
    best = c.owner;
  }
  return best;
}

/** Tiles of the 8-neighbourhood of (x, y) that satisfy `pred(tx, ty)`. */
export function countAround(x, y, pred) {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && pred(x + dx, y + dy)) n++;
    }
  }
  return n;
}
