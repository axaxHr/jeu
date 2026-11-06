/**
 * Client-side mirror of the world, fed by server messages. It never decides
 * game outcomes: it stores what the server said and interpolates unit motion
 * between ticks for smooth rendering.
 */
import { CONFIG, TILE, BUILDING_KINDS, UNIT_KINDS } from './shared/config.js';

export class ClientState {
  constructor() {
    this.tileListeners = [];
    this.buildingListeners = [];
    this.reset();
  }

  reset() {
    this.ready = false;
    this.youId = 0;
    this.size = 0;
    this.tiles = new Uint8Array(0);
    this.buildings = new Map();
    this.occ = new Map();
    this.units = new Map();
    this.players = new Map();
    this.me = { gold: 0, income: 0, glory: 0, units: 0, cap: 0, queue: 0, shield: 0, core: 0 };
    this.fx = [];
    this.alerts = [];
    this.snapAt = 0;
    this.tickMs = 1000 / CONFIG.tickRate;
    this.offlineShield = true;
  }

  /** Apply the `welcome` message (full state). */
  applyWelcome(msg, now) {
    this.reset();
    this.ready = true;
    this.youId = msg.you.id;
    this.size = msg.size;
    this.tickMs = 1000 / msg.tickRate;
    this.offlineShield = msg.offlineShield;
    const bin = atob(msg.tiles);
    this.tiles = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) this.tiles[i] = bin.charCodeAt(i);
    for (const packed of msg.buildings) this.addBuilding(packed);
    this.setPlayers(msg.players);
    this.me = msg.me;
    this.snapAt = now;
  }

  addBuilding([id, owner, kindIndex, x, y, hp]) {
    const b = { id, owner, kind: BUILDING_KINDS[kindIndex], x, y, hp };
    this.buildings.set(id, b);
    this.occ.set(y * this.size + x, id);
    return b;
  }

  removeBuilding(id) {
    const b = this.buildings.get(id);
    if (!b) return null;
    this.buildings.delete(id);
    if (this.occ.get(b.y * this.size + b.x) === id) this.occ.delete(b.y * this.size + b.x);
    return b;
  }

  setPlayers(list) {
    this.players = new Map(list.map((p) => [p.id, p]));
  }

  /** Apply one tick snapshot `{u, fx, ba, bd, bh, te}` and the private status. */
  applySnapshot(w, me, now) {
    const ease = Math.min(1, (now - this.snapAt) / this.tickMs);
    this.snapAt = now;
    this.me = me;

    for (const [i, code] of w.te) {
      this.tiles[i] = code;
      for (const fn of this.tileListeners) fn(i, code);
    }
    for (const id of w.bd) {
      const b = this.removeBuilding(id);
      if (b) this.fx.push({ type: 'rubble', x0: b.x + 0.5, y0: b.y + 0.5, t0: now, dur: 650 });
    }
    for (const packed of w.ba) this.addBuilding(packed);
    for (const [id, hp] of w.bh) {
      const b = this.buildings.get(id);
      if (b) b.hp = hp;
    }
    if (w.bd.length || w.ba.length) for (const fn of this.buildingListeners) fn();

    const seen = new Set();
    const u = w.u;
    for (let k = 0; k < u.length; k += 6) {
      const id = u[k];
      seen.add(id);
      const x = u[k + 3] / 100;
      const y = u[k + 4] / 100;
      const prev = this.units.get(id);
      if (prev) {
        // Start the new segment from where the unit is currently drawn.
        prev.px = prev.px + (prev.x - prev.px) * ease;
        prev.py = prev.py + (prev.y - prev.py) * ease;
        if (x > prev.x + 0.004) prev.face = 1;
        else if (x < prev.x - 0.004) prev.face = -1;
        prev.x = x; prev.y = y; prev.hp = u[k + 5];
      } else {
        this.units.set(id, { id, owner: u[k + 1], kind: UNIT_KINDS[u[k + 2]], x, y, px: x, py: y, hp: u[k + 5], face: 1 });
      }
    }
    for (const [id, unit] of this.units) {
      if (!seen.has(id)) {
        this.units.delete(id);
        this.fx.push({ type: 'puff', x0: unit.x, y0: unit.y, t0: now, dur: 380 });
      }
    }

    const fx = w.fx;
    for (let k = 0; k < fx.length; k += 5) {
      const type = ['melee', 'arrow', 'bolt'][fx[k]];
      this.fx.push({
        type, x0: fx[k + 1] / 100, y0: fx[k + 2] / 100, x1: fx[k + 3] / 100, y1: fx[k + 4] / 100,
        t0: now, dur: type === 'melee' ? 160 : type === 'arrow' ? 220 : 170,
      });
    }
  }

  /** Interpolation factor for unit positions at time `now`. */
  alpha(now) { return Math.min(1, Math.max(0, (now - this.snapAt) / this.tickMs)); }

  /** Drop finished effects and alerts. */
  prune(now) {
    this.fx = this.fx.filter((f) => now - f.t0 < f.dur);
    this.alerts = this.alerts.filter((a) => now - a.t0 < 4000);
  }

  myCore() { return this.buildings.get(this.me.core); }
  myPlayer() { return this.players.get(this.youId); }
  isMine(entity) { return entity.owner === this.youId; }
  tileAt(x, y) { return this.tiles[y * this.size + x]; }

  /** Client-side mirror of World.canBuild, for the placement preview only. */
  canBuild(kind, x, y) {
    const def = CONFIG.buildings[kind];
    if (!def || x < 0 || y < 0 || x >= this.size || y >= this.size) return 'Hors de la carte.';
    const core = this.myCore();
    if (!core) return 'Vous n\'avez plus de Noyau.';
    const r = CONFIG.territory.radius;
    if ((x - core.x) ** 2 + (y - core.y) ** 2 > r * r) return 'Hors de votre territoire.';
    if (this.occ.has(y * this.size + x)) return 'Emplacement occupé.';
    const t = this.tileAt(x, y);
    if (def.needsGold && t !== TILE.GOLD) return 'Une Mine doit être posée sur un filon d\'or.';
    if (!def.needsGold && t !== TILE.GRASS) return t === TILE.GOLD ? 'Les filons d\'or sont réservés aux Mines.' : 'Terrain impraticable.';
    if (this.me.gold < def.cost) return 'Pas assez d\'or.';
    return null;
  }

  /** Building under tile (x, y), if any. */
  buildingAt(x, y) {
    const id = this.occ.get(y * this.size + x);
    return id ? this.buildings.get(id) : null;
  }

  /** Nearest unit to world point (wx, wy) within `radius` tiles, filtered by `pred`. */
  unitNear(wx, wy, radius, pred = () => true) {
    let best = null;
    let bestD = radius * radius;
    for (const u of this.units.values()) {
      if (!pred(u)) continue;
      const d = (u.x - wx) ** 2 + (u.y - wy) ** 2;
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }
}
