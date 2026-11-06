/**
 * Client-side mirror of the world, fed by server messages. It never decides
 * game outcomes: it stores what the server said, mirrors the build rules for
 * the placement preview, and interpolates unit motion between ticks.
 */
import { CONFIG, TILE, BUILDING_KINDS, UNIT_KINDS, keepLevel, canAfford } from './shared/config.js';
import { claimsFrom, territoryOwner, countAround } from './shared/territory.js';

const FX_TYPES = ['melee', 'arrow', 'bolt', 'boulder', 'heal'];
const FX_DURATION = { melee: 160, arrow: 220, bolt: 170, boulder: 650, heal: 420 };

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
    this.shrine = null;
    this.me = {
      gold: 0, wood: 0, stone: 0, income: { gold: 0, wood: 0, stone: 0 }, glory: 0, pop: 0, cap: 0, queue: 0,
      shield: 0, core: 0, level: 0, techs: { attack: 0, armor: 0 }, clan: null, invite: null,
    };
    this.fx = [];
    this.alerts = [];
    this.snapAt = 0;
    this.tickMs = 1000 / CONFIG.tickRate;
    this.offlineShield = true;
    this.claimsVersion = 0;
    this.claimsCache = { version: -1, claims: [] };
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
    this.shrine = msg.shrine || null;
    this.me = msg.me;
    this.snapAt = now;
  }

  /** Add or update a building from its wire tuple [id, owner, kind, x, y, hp, extra]. */
  addBuilding([id, owner, kindIndex, x, y, hp, extra]) {
    const old = this.buildings.get(id);
    if (old && this.occ.get(old.y * this.size + old.x) === id) this.occ.delete(old.y * this.size + old.x);
    const kind = BUILDING_KINDS[kindIndex];
    const b = { id, owner, kind, x, y, hp };
    if (kind === 'core') b.level = extra || 1;
    if (kind === 'shrine') b.holder = extra || 0;
    this.buildings.set(id, b);
    this.occ.set(y * this.size + x, id);
    if (kind === 'core' || kind === 'outpost') this.claimsVersion++;
    return b;
  }

  removeBuilding(id) {
    const b = this.buildings.get(id);
    if (!b) return null;
    this.buildings.delete(id);
    if (this.occ.get(b.y * this.size + b.x) === id) this.occ.delete(b.y * this.size + b.x);
    if (b.kind === 'core' || b.kind === 'outpost') this.claimsVersion++;
    return b;
  }

  setPlayers(list, shrine) {
    this.players = new Map(list.map((p) => [p.id, p]));
    if (shrine !== undefined) this.shrine = shrine;
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
        prev.px += (prev.x - prev.px) * ease;
        prev.py += (prev.y - prev.py) * ease;
        if (x > prev.x + 0.004) prev.face = 1;
        else if (x < prev.x - 0.004) prev.face = -1;
        prev.x = x; prev.y = y; prev.hp = u[k + 5];
      } else {
        this.units.set(id, { id, owner: u[k + 1], kind: UNIT_KINDS[u[k + 2]], x, y, px: x, py: y, hp: u[k + 5], face: 1 });
      }
    }
    for (const [id, unit] of this.units) {
      if (seen.has(id)) continue;
      this.units.delete(id);
      // Units leaving the view are not deaths: only puff when they were well inside it.
      if (unit.hp <= CONFIG.units[unit.kind].hp * 0.5) this.fx.push({ type: 'puff', x0: unit.x, y0: unit.y, t0: now, dur: 380 });
    }

    const fx = w.fx;
    for (let k = 0; k < fx.length; k += 5) {
      const type = FX_TYPES[fx[k]] || 'melee';
      this.fx.push({
        type, x0: fx[k + 1] / 100, y0: fx[k + 2] / 100, x1: fx[k + 3] / 100, y1: fx[k + 4] / 100,
        t0: now, dur: FX_DURATION[type],
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

  /** Allied (same clan) or self. */
  friendly(owner) {
    if (owner === this.youId) return true;
    const me = this.players.get(this.youId);
    const o = this.players.get(owner);
    return !!me && !!o && !!me.clan && me.clan === o.clan;
  }

  claims() {
    if (this.claimsCache.version !== this.claimsVersion) {
      this.claimsCache = { version: this.claimsVersion, claims: claimsFrom(this.buildings.values()) };
    }
    return this.claimsCache.claims;
  }

  ownerOfTile(x, y) { return territoryOwner(this.claims(), x, y); }

  counts() {
    const c = Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0]));
    for (const b of this.buildings.values()) if (b.owner === this.youId) c[b.kind]++;
    return c;
  }

  /** Why a building or unit kind is locked for me, or null. */
  lockReason(def) {
    if (def.minLevel && this.me.level < def.minLevel) return `Niveau ${def.minLevel} du Donjon`;
    return null;
  }

  /** Client-side mirror of World.canBuild, for the placement preview only. */
  canBuild(kind, x, y, counts = this.counts()) {
    const def = CONFIG.buildings[kind];
    if (!def || x < 0 || y < 0 || x >= this.size || y >= this.size) return 'Hors de la carte.';
    if (!this.myCore()) return 'Vous n\'avez plus de Donjon.';
    const lock = this.lockReason(def);
    if (lock) return `${def.name} : débloqué au ${lock.toLowerCase()}.`;
    if (this.ownerOfTile(x, y) !== this.youId) return 'Hors de votre territoire.';
    if (this.occ.has(y * this.size + x)) return 'Emplacement occupé.';
    const t = this.tileAt(x, y);
    if (def.needsGold && t !== TILE.GOLD) return 'Une Mine doit être posée sur un filon d\'or.';
    if (!def.needsGold && t !== TILE.GRASS) return t === TILE.GOLD ? 'Les filons d\'or sont réservés aux Mines.' : 'Terrain impraticable.';
    if (def.near) {
      const code = def.near === 'forest' ? TILE.FOREST : TILE.ROCK;
      const n = countAround(x, y, (tx, ty) => tx >= 0 && ty >= 0 && tx < this.size && ty < this.size && this.tileAt(tx, ty) === code);
      if (n === 0) return def.near === 'forest' ? 'Une Scierie doit toucher la forêt.' : 'Une Carrière doit toucher la roche.';
    }
    const kl = keepLevel(this.me.level);
    if (kind === 'tower' && counts.tower >= kl.towers) return `Maximum ${kl.towers} Tours à ce niveau de Donjon.`;
    if (kind === 'outpost' && counts.outpost >= kl.outposts) return `Maximum ${kl.outposts} Avant-poste(s) à ce niveau de Donjon.`;
    if (def.max && counts[kind] >= def.max) return `Une seule ${def.name} par seigneur.`;
    if (!canAfford(this.me, def.cost)) return 'Ressources insuffisantes.';
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
