/**
 * Title-screen backdrop: a small generated world with three rival keeps and a
 * few patrols, drawn by the real renderer while the player picks a name.
 * Purely cosmetic and client-side; replaced by the server's world on login.
 */
import { CONFIG, TILE, PLAYER_COLORS } from './shared/config.js';
import { generateMap } from './shared/mapgen.js';

const DEMO_SEED = 1789;
const DEMO_SIZE = 72;
const LORDS = ['Aliénor', 'Bohémond', 'Mathilde'];

/** Fill `state` with a decorative world. Returns an `animate(now)` function. */
export function loadDemoWorld(state) {
  const { tiles } = generateMap(DEMO_SEED, DEMO_SIZE, CONFIG.map);
  state.reset();
  state.ready = true;
  state.size = DEMO_SIZE;
  state.tiles = tiles;
  const grass = (x, y) => x > 1 && y > 1 && x < DEMO_SIZE - 2 && y < DEMO_SIZE - 2 && tiles[y * DEMO_SIZE + x] === TILE.GRASS;
  const free = (x, y) => grass(x, y) && !state.buildingAt(x, y);
  let nextId = 1;
  const add = (owner, kind, x, y) => { if (free(x, y)) state.addBuilding([nextId++, owner, ['core', 'wall', 'tower', 'mine', 'barracks'].indexOf(kind), x, y, CONFIG.buildings[kind].hp]); };

  const anchors = [[0.32, 0.36], [0.68, 0.42], [0.48, 0.7]];
  const players = [];
  const patrols = [];
  anchors.forEach(([ax, ay], i) => {
    const owner = -(i + 1);
    const color = PLAYER_COLORS[[0, 1, 2][i]];
    let cx = Math.round(ax * DEMO_SIZE);
    let cy = Math.round(ay * DEMO_SIZE);
    // Walk to the nearest open 3×3 patch.
    for (let r = 0; r < 12; r++) {
      let found = false;
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          let ok = true;
          for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) ok = ok && grass(x + k, y + j);
          if (ok) { cx = x; cy = y; found = true; }
        }
      }
      if (found) break;
    }
    players.push({ id: owner, name: LORDS[i], color, glory: 0, online: true, shielded: i === 2, cx, cy });
    add(owner, 'core', cx, cy);
    add(owner, 'barracks', cx - 2, cy + 1);
    add(owner, 'tower', cx + 3, cy - 2);
    add(owner, 'tower', cx - 3, cy - 2);
    for (let x = cx - 3; x <= cx + 3; x++) add(owner, 'wall', x, cy - 3);
    for (let y = cy - 2; y <= cy + 2; y++) { add(owner, 'wall', cx - 4, y); add(owner, 'wall', cx + 4, y); }
    for (let k = 0; k < 4; k++) {
      const u = { id: 1000 + i * 10 + k, owner, kind: k % 2 ? 'archer' : 'warrior', x: cx - 1 + k, y: cy + 3.5, hp: 999, face: 1 };
      u.px = u.x; u.py = u.y;
      state.units.set(u.id, u);
      patrols.push({ u, x0: u.x, y0: u.y, phase: k * 1.7 + i });
    }
  });
  state.setPlayers(players);
  state.snapAt = performance.now();

  return function animate(now, renderer) {
    for (const p of patrols) {
      const t = now / 2600 + p.phase;
      const nx = p.x0 + Math.sin(t) * 2.2;
      p.u.px = p.u.x;
      p.u.py = p.u.y;
      p.u.face = nx >= p.u.x ? 1 : -1;
      p.u.x = nx;
      p.u.y = p.y0 + Math.sin(t * 0.5) * 0.4;
    }
    state.snapAt = now - state.tickMs;
    renderer.cam.x = DEMO_SIZE / 2 + Math.sin(now / 26000) * 9;
    renderer.cam.y = DEMO_SIZE / 2 + Math.cos(now / 31000) * 6;
  };
}
