/**
 * The authoritative BASTIONS world: map, players, buildings, units and the
 * fixed-step simulation. Pure game logic: no sockets, no file I/O, and both the
 * clock and the randomness are injected, so the whole simulation is unit-testable.
 */
import { CONFIG, TILE, WALKABLE, BUILDING_KINDS, UNIT_KINDS, PLAYER_COLORS } from '../shared/config.js';
import { generateMap } from '../shared/mapgen.js';
import { computeFlowField, nextStep } from './pathfinding.js';

/** Result helper for player actions. */
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (reason) => ({ ok: false, reason });

/** Max flow fields computed per tick; units needing more wait one tick. */
const FIELD_BUDGET_PER_TICK = 8;
/** Per player per tick, so one army cannot starve everyone else's pathfinding. */
const FIELD_BUDGET_PER_OWNER = 3;
/** Cache memory budget for flow fields (Float64 per tile). */
const FIELD_CACHE_BYTES = 16e6;
/** Two units closer than this push each other apart. */
const SEPARATION = 0.32;
/** Collision radius used when an attack targets a unit. */
const UNIT_RADIUS = 0.3;

export class World {
  /**
   * @param {object} opts
   * @param {number} opts.seed Map seed.
   * @param {number} [opts.size] Map size in tiles (defaults to config.map.size).
   * @param {object} [opts.config] Gameplay data (defaults to shared CONFIG).
   * @param {() => number} [opts.now] Wall clock in ms (shield timers survive restarts).
   * @param {() => number} [opts.random] RNG in [0, 1) for spawns.
   * @param {boolean} [opts.offlineShield] Offline players' bases cannot be attacked.
   * @param {number} [opts.shieldSeconds] Host override of config.spawn.shieldSeconds.
   * @param {number} [opts.startGold] Host override of config.spawn.startGold.
   */
  constructor({
    seed, size, config = CONFIG, now = () => Date.now(), random = Math.random, offlineShield = true,
    shieldSeconds = config.spawn.shieldSeconds, startGold = config.spawn.startGold,
  }) {
    this.config = config;
    this.shieldSeconds = shieldSeconds;
    this.startGold = startGold;
    this.seed = seed >>> 0;
    this.size = size || config.map.size;
    this.now = now;
    this.random = random;
    this.offlineShield = offlineShield;

    const map = generateMap(this.seed, this.size, config.map);
    this.tiles = map.tiles;
    /** Tile edits made after generation (persisted): index → code. */
    this.tileEdits = new Map();
    /** Building id per tile, 0 when empty. */
    this.occ = new Int32Array(this.size * this.size);

    this.players = new Map();
    this.buildings = new Map();
    this.units = new Map();
    this.nextPlayerId = 1;
    this.nextId = 1;

    this.time = 0;
    this.secondAcc = 0;
    this.layoutVersion = 0;
    this.flowCache = new Map();
    this.flowCacheLimit = Math.max(32, Math.floor(FIELD_CACHE_BYTES / (this.size * this.size * 8)));
    this.fieldBudget = FIELD_BUDGET_PER_TICK;
    this.ownerBudget = new Map();
    this.spawnFullAt = -1;
    this.resetEvents();
  }

  // ---------------------------------------------------------------- helpers

  /** Clear the per-tick event buffers. Call after broadcasting them. */
  resetEvents() {
    this.events = { bAdd: [], bDel: [], bHp: new Map(), fx: [], tiles: [], notices: [], playersDirty: false };
  }

  idx(x, y) { return y * this.size + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }
  tileOf(u) { return this.idx(Math.floor(u.x), Math.floor(u.y)); }
  terrainWalkable(i) { return WALKABLE[this.tiles[i]] === true; }
  /** Blocked for movement and diagonal corner-cutting: bad terrain or any building. */
  solid(i) { return !this.terrainWalkable(i) || this.occ[i] !== 0; }

  setTile(i, code) {
    this.tiles[i] = code;
    this.tileEdits.set(i, code);
    this.events.tiles.push([i, code]);
  }

  /** Is the player currently protected (spawn shield, or offline protection)? */
  isShielded(player) {
    if (!player) return true;
    if (this.now() < player.shieldUntil) return true;
    if (!this.offlineShield || player.online) return false;
    // A short grace period, so closing the tab does not end a raid instantly.
    return this.now() - player.lastSeen > this.config.combat.offlineShieldDelay * 1000;
  }

  /** Seconds of spawn shield left (0 when none). */
  shieldLeft(player) {
    return Math.max(0, Math.ceil((player.shieldUntil - this.now()) / 1000));
  }

  /** Can units/towers of `a` damage things owned by `b`? */
  hostile(aOwner, bOwner) {
    if (aOwner === bOwner) return false;
    return !this.isShielded(this.players.get(aOwner)) && !this.isShielded(this.players.get(bOwner));
  }

  coreOf(player) { return player.coreId ? this.buildings.get(player.coreId) : undefined; }

  /** Current unit cap for a player. */
  unitCap(player) {
    return Math.min(this.config.limits.unitsHardCap, player.counts.barracks * this.config.buildings.barracks.unitCap);
  }

  /** Gold per second for a player. */
  income(player) {
    if (!this.coreOf(player)) return 0;
    const b = this.config.buildings;
    return b.core.income + player.counts.mine * b.mine.income;
  }

  unitCount(player) {
    let n = 0;
    for (const u of this.units.values()) if (u.owner === player.id) n++;
    return n;
  }

  notify(to, text, kind = 'info') { this.events.notices.push({ to, text, kind }); }

  // ---------------------------------------------------------------- players

  /**
   * Register a new player and give them a base.
   * @returns {{ok:boolean, reason?:string, player?:object}}
   */
  addPlayer({ name, tokenHash, at = null }) {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    const color = [...PLAYER_COLORS].sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0))[0];
    const player = {
      id: this.nextPlayerId++,
      name,
      tokenHash,
      color,
      gold: this.startGold,
      glory: 0,
      online: false,
      coreId: 0,
      shieldUntil: 0,
      queue: [],
      counts: Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0])),
      lastSeen: this.now(),
      createdAt: this.now(),
      playSeconds: 0,
      alertAt: -Infinity,
      wasShielded: true,
    };
    this.players.set(player.id, player);
    if (!this.spawnBase(player, at)) {
      this.players.delete(player.id);
      return fail('La carte est pleine : aucun emplacement libre pour une nouvelle base.');
    }
    this.events.playersDirty = true;
    return ok({ player });
  }

  /** Remove a player and everything they own. */
  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.wipeAssets(p);
    this.players.delete(playerId);
    this.events.playersDirty = true;
  }

  setOnline(playerId, online) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.online = online;
    p.lastSeen = this.now();
    this.events.playersDirty = true;
  }

  /** Is (x, y) a decent core location? Grass, free 3×3, mostly walkable territory. */
  goodSpawn(x, y) {
    const { radius } = this.config.territory;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = this.idx(x + dx, y + dy);
        if (this.solid(i)) return false;
      }
    }
    if (this.tiles[this.idx(x, y)] !== TILE.GRASS) return false;
    let total = 0;
    let open = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const tx = x + dx;
        const ty = y + dy;
        total++;
        if (this.inBounds(tx, ty) && !this.solid(this.idx(tx, ty))) open++;
      }
    }
    return open / total >= 0.55;
  }

  /** Choose a spawn tile far from other cores, relaxing the spacing if the map is crowded. */
  findSpawn() {
    // A failed search is only retried once the layout changed (cheap rejection when full).
    if (this.spawnFullAt === this.layoutVersion) return null;
    const cores = [];
    for (const b of this.buildings.values()) if (b.kind === 'core') cores.push(b);
    const { minCoreDistance, edgeMargin, candidates } = this.config.spawn;
    const span = this.size - 2 * edgeMargin;
    if (span <= 0) return null;
    for (const minDist of [minCoreDistance, minCoreDistance * 0.75, minCoreDistance * 0.55]) {
      let best = null;
      let bestScore = -Infinity;
      for (let n = 0; n < candidates; n++) {
        const x = edgeMargin + Math.floor(this.random() * span);
        const y = edgeMargin + Math.floor(this.random() * span);
        let d = Infinity;
        for (const c of cores) d = Math.min(d, Math.hypot(c.x - x, c.y - y));
        if (d < minDist) continue;
        if (!this.goodSpawn(x, y)) continue;
        const score = Math.min(d, minDist * 2) + this.random() * 2;
        if (score > bestScore) { bestScore = score; best = { x, y }; }
      }
      if (best) return best;
    }
    this.spawnFullAt = this.layoutVersion;
    return null;
  }

  /**
   * Place a fresh core (with guaranteed gold veins and a spawn shield) for `player`.
   * @param {{x:number, y:number}|null} [at] Forced location (tests, admin tools).
   */
  spawnBase(player, at = null) {
    const spot = at || this.findSpawn();
    if (!spot) return false;
    const core = this.placeBuilding(player, 'core', spot.x, spot.y);
    player.coreId = core.id;
    player.shieldUntil = this.now() + this.shieldSeconds * 1000;
    player.wasShielded = true;

    const { radius } = this.config.territory;
    let gold = 0;
    const grass = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dy * dy;
        const tx = spot.x + dx;
        const ty = spot.y + dy;
        if (d2 > (radius - 1) * (radius - 1) || !this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        if (this.tiles[i] === TILE.GOLD) gold++;
        else if (this.tiles[i] === TILE.GRASS && this.occ[i] === 0 && d2 >= 9) grass.push(i);
      }
    }
    while (gold < this.config.spawn.guaranteedGold && grass.length > 0) {
      const k = Math.floor(this.random() * grass.length);
      const i = grass.splice(k, 1)[0];
      this.setTile(i, TILE.GOLD);
      gold++;
    }
    this.events.playersDirty = true;
    return true;
  }

  /** Destroy every building and unit a player owns (no rewards). */
  wipeAssets(player) {
    for (const b of [...this.buildings.values()]) if (b.owner === player.id) this.removeBuilding(b);
    for (const u of [...this.units.values()]) if (u.owner === player.id) this.removeUnit(u);
    player.coreId = 0;
    player.queue = [];
  }

  // ---------------------------------------------------------------- buildings

  placeBuilding(player, kind, x, y) {
    const def = this.config.buildings[kind];
    const b = { id: this.nextId++, owner: player.id, kind, x, y, hp: def.hp, cd: 0, readyAt: 0 };
    this.buildings.set(b.id, b);
    this.occ[this.idx(x, y)] = b.id;
    player.counts[kind]++;
    this.layoutVersion++;
    this.evictUnits(x, y);
    this.events.bAdd.push(b);
    return b;
  }

  removeBuilding(b) {
    if (!this.buildings.has(b.id)) return;
    this.buildings.delete(b.id);
    this.occ[this.idx(b.x, b.y)] = 0;
    const owner = this.players.get(b.owner);
    if (owner) {
      owner.counts[b.kind]--;
      if (owner.coreId === b.id) owner.coreId = 0;
    }
    this.layoutVersion++;
    this.events.bDel.push(b.id);
    this.events.bHp.delete(b.id);
  }

  /** Move any unit standing on (x, y) to the nearest free tile. */
  evictUnits(x, y) {
    const here = this.idx(x, y);
    for (const u of this.units.values()) {
      if (this.tileOf(u) !== here) continue;
      const spot = this.nearestOpenTile(x, y, 4);
      if (spot >= 0) {
        u.x = (spot % this.size) + 0.5;
        u.y = Math.floor(spot / this.size) + 0.5;
      }
    }
  }

  /** Nearest walkable, building-free tile to (x, y) within `maxR` rings, or -1. */
  nearestOpenTile(x, y, maxR) {
    for (let r = 0; r <= maxR; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = x + dx;
          const ty = y + dy;
          if (!this.inBounds(tx, ty)) continue;
          const i = this.idx(tx, ty);
          if (this.solid(i)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Check whether `player` may build `kind` at (x, y).
   * @returns {{ok:boolean, reason?:string}}
   */
  canBuild(player, kind, x, y) {
    const def = this.config.buildings[kind];
    if (!def || !def.buildable) return fail('Bâtiment inconnu.');
    if (!Number.isInteger(x) || !Number.isInteger(y) || !this.inBounds(x, y)) return fail('Hors de la carte.');
    const core = this.coreOf(player);
    if (!core) return fail('Vous n\'avez plus de Noyau.');
    const { radius } = this.config.territory;
    if ((x - core.x) ** 2 + (y - core.y) ** 2 > radius * radius) return fail('Hors de votre territoire.');
    const i = this.idx(x, y);
    if (this.occ[i] !== 0) return fail('Emplacement occupé.');
    const t = this.tiles[i];
    if (def.needsGold && t !== TILE.GOLD) return fail('Une Mine doit être posée sur un filon d\'or.');
    if (!def.needsGold && t !== TILE.GRASS) return fail(t === TILE.GOLD ? 'Les filons d\'or sont réservés aux Mines.' : 'Terrain impraticable.');
    const total = BUILDING_KINDS.reduce((s, k) => s + player.counts[k], 0);
    if (total >= this.config.limits.buildingsPerPlayer) return fail('Limite de bâtiments atteinte.');
    if (kind === 'tower' && player.counts.tower >= this.config.limits.towersPerPlayer) {
      return fail(`Maximum ${this.config.limits.towersPerPlayer} Tours par seigneur.`);
    }
    if (player.gold < def.cost) return fail('Pas assez d\'or.');
    return ok();
  }

  /** Build for a player (gold is spent). */
  build(playerId, kind, x, y) {
    const player = this.players.get(playerId);
    if (!player) return fail('Joueur inconnu.');
    const check = this.canBuild(player, kind, x, y);
    if (!check.ok) return check;
    player.gold -= this.config.buildings[kind].cost;
    const b = this.placeBuilding(player, kind, x, y);
    return ok({ building: b });
  }

  /** Demolish one of your own buildings (not the core) for a partial refund. */
  demolish(playerId, buildingId) {
    const player = this.players.get(playerId);
    const b = this.buildings.get(buildingId);
    if (!player || !b || b.owner !== playerId) return fail('Ce bâtiment ne vous appartient pas.');
    if (b.kind === 'core') return fail('Le Noyau ne peut pas être démoli.');
    const def = this.config.buildings[b.kind];
    const refund = Math.floor(def.cost * this.config.economy.demolishRefund * (b.hp / def.hp));
    player.gold = Math.min(this.config.economy.goldCap, player.gold + refund);
    this.removeBuilding(b);
    return ok({ refund });
  }

  // ---------------------------------------------------------------- units

  /** Queue a unit for training (gold is spent now). */
  train(playerId, kind) {
    const player = this.players.get(playerId);
    const def = this.config.units[kind];
    if (!player || !def) return fail('Unité inconnue.');
    if (player.counts.barracks === 0) return fail('Construisez d\'abord une Caserne.');
    if (player.queue.length >= this.config.limits.trainQueue) return fail('File de recrutement pleine.');
    if (this.unitCount(player) + player.queue.length >= this.unitCap(player)) {
      return fail('Population maximale atteinte : construisez une Caserne de plus.');
    }
    if (player.gold < def.cost) return fail('Pas assez d\'or.');
    player.gold -= def.cost;
    player.queue.push(kind);
    return ok();
  }

  spawnUnit(player, kind, x, y) {
    const def = this.config.units[kind];
    const u = {
      id: this.nextId++, owner: player.id, kind, x, y, hp: def.hp, cd: 0,
      order: null, engage: 0, anchorX: x, anchorY: y, returning: false,
    };
    this.units.set(u.id, u);
    return u;
  }

  removeUnit(u) { this.units.delete(u.id); }

  /** Resolve the unit list a client sent: own units only; `null` means all of them. */
  ownUnits(playerId, ids) {
    if (ids == null) return [...this.units.values()].filter((u) => u.owner === playerId);
    const out = [];
    for (const id of ids) {
      const u = this.units.get(id);
      if (u && u.owner === playerId) out.push(u);
    }
    return out;
  }

  /**
   * Order units. `order` is {type:'move', x, y} | {type:'attack', bid} | {type:'attack', uid} | {type:'recall'}.
   */
  command(playerId, ids, order) {
    const player = this.players.get(playerId);
    if (!player) return fail('Joueur inconnu.');
    const units = this.ownUnits(playerId, ids);
    if (units.length === 0) return fail('Aucune unité sélectionnée.');

    if (order.type === 'recall') {
      const core = this.coreOf(player);
      if (!core) return fail('Vous n\'avez plus de Noyau.');
      order = { type: 'move', x: core.x, y: core.y };
    }

    if (order.type === 'move') {
      if (!Number.isInteger(order.x) || !Number.isInteger(order.y) || !this.inBounds(order.x, order.y)) return fail('Destination invalide.');
      const goal = this.nearestOpenTile(order.x, order.y, 4);
      if (goal < 0) return fail('Destination inaccessible.');
      for (const u of units) {
        u.order = { type: 'move', goal };
        u.engage = 0;
        u.returning = false;
      }
      return ok();
    }

    if (order.type === 'attack') {
      let target = null;
      let tt = '';
      if (order.bid != null) { target = this.buildings.get(order.bid); tt = 'b'; }
      else if (order.uid != null) { target = this.units.get(order.uid); tt = 'u'; }
      if (!target || target.owner === playerId) return fail('Cible invalide.');
      const victim = this.players.get(target.owner);
      if (this.isShielded(victim)) return fail(`${victim.name} est protégé par un bouclier.`);
      if (this.now() < player.shieldUntil) {
        player.shieldUntil = 0;
        this.notify(player.id, 'Vous attaquez : votre bouclier de départ est levé.', 'warn');
        this.events.playersDirty = true;
      }
      for (const u of units) {
        u.order = { type: 'attack', tt, tid: target.id };
        u.engage = 0;
        u.returning = false;
      }
      return ok();
    }
    return fail('Ordre inconnu.');
  }

  // ---------------------------------------------------------------- simulation

  /** Advance the world by `dt` seconds (call at CONFIG.tickRate). */
  tick(dt) {
    this.time += dt;
    this.fieldBudget = FIELD_BUDGET_PER_TICK;
    this.ownerBudget.clear();
    this.secondAcc += dt;
    while (this.secondAcc >= 1 - 1e-9) { // epsilon: ten 0.1 s steps sum to 0.999…
      this.secondAcc -= 1;
      this.everySecond();
    }
    this.updateTraining();
    this.updateTowers(dt);
    for (const u of [...this.units.values()]) {
      if (this.units.has(u.id)) this.updateUnit(u, dt);
    }
    this.separateUnits();
  }

  everySecond() {
    const cap = this.config.economy.goldCap;
    for (const p of this.players.values()) {
      if (p.online) p.playSeconds = (p.playSeconds || 0) + 1;
      p.gold = Math.min(cap, p.gold + this.income(p));
      const shielded = this.isShielded(p);
      if (shielded !== p.wasShielded) {
        p.wasShielded = shielded;
        this.layoutVersion++; // shielded bases become (im)passable for attackers
        this.events.playersDirty = true;
      }
    }
  }

  updateTraining() {
    const due = new Map();
    for (const b of this.buildings.values()) {
      if (b.kind !== 'barracks' || b.readyAt > this.time) continue;
      const p = this.players.get(b.owner);
      if (!p || p.queue.length === 0) continue;
      if (!due.has(p.id)) due.set(p.id, []);
      due.get(p.id).push(b);
    }
    for (const [pid, list] of due) {
      const p = this.players.get(pid);
      for (const b of list) {
        if (p.queue.length === 0 || this.unitCount(p) >= this.unitCap(p)) break;
        const spot = this.nearestOpenTile(b.x, b.y, 3);
        if (spot < 0) continue;
        const kind = p.queue.shift();
        const sx = (spot % this.size) + 0.3 + this.random() * 0.4;
        const sy = Math.floor(spot / this.size) + 0.3 + this.random() * 0.4;
        this.spawnUnit(p, kind, sx, sy);
        b.readyAt = this.time + this.config.buildings.barracks.trainSeconds;
      }
    }
  }

  updateTowers(dt) {
    const def = this.config.buildings.tower;
    for (const t of this.buildings.values()) {
      if (t.kind !== 'tower') continue;
      t.cd = Math.max(0, t.cd - dt);
      if (t.cd > 0) continue;
      const cx = t.x + 0.5;
      const cy = t.y + 0.5;
      let best = null;
      let bestD = def.range * def.range;
      for (const u of this.units.values()) {
        if (!this.hostile(t.owner, u.owner)) continue;
        const d = (u.x - cx) ** 2 + (u.y - cy) ** 2;
        if (d <= bestD) { bestD = d; best = u; }
      }
      if (best) {
        t.cd = def.cooldown;
        this.events.fx.push(2, cx, cy, best.x, best.y);
        this.damageUnit(best, def.damage, t.owner);
      }
    }
  }

  /** Distance from point (x, y) to the square of tile (tx, ty). */
  static distToTile(x, y, tx, ty) {
    const dx = Math.max(tx - x, 0, x - (tx + 1));
    const dy = Math.max(ty - y, 0, y - (ty + 1));
    return Math.hypot(dx, dy);
  }

  inRange(u, range, target, tt) {
    if (tt === 'b') return World.distToTile(u.x, u.y, target.x, target.y) <= range;
    return Math.hypot(target.x - u.x, target.y - u.y) <= range + UNIT_RADIUS;
  }

  /** Nearest hostile unit within `radius` of `u`, or null. */
  findEnemyUnit(u, radius) {
    let best = null;
    let bestD = radius * radius;
    for (const o of this.units.values()) {
      if (!this.hostile(u.owner, o.owner)) continue;
      const d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
      if (d <= bestD) { bestD = d; best = o; }
    }
    return best;
  }

  updateUnit(u, dt) {
    const def = this.config.units[u.kind];
    const combat = this.config.combat;
    u.cd = Math.max(0, u.cd - dt);

    // Drop stale engagements and orders.
    if (u.engage) {
      const e = this.units.get(u.engage);
      if (!e || !this.hostile(u.owner, e.owner)) u.engage = 0;
    }
    if (u.order && u.order.type === 'attack') {
      const tgt = u.order.tt === 'b' ? this.buildings.get(u.order.tid) : this.units.get(u.order.tid);
      if (!tgt || !this.hostile(u.owner, tgt.owner)) this.goIdle(u);
    }

    // Leash for idle defenders.
    if (!u.order && u.engage && Math.hypot(u.x - u.anchorX, u.y - u.anchorY) > combat.leashRadius) {
      u.engage = 0;
      u.returning = true;
    }

    // Acquire a fight: idle units and attackers react to nearby enemy units; marching units do not.
    const marching = u.order && u.order.type === 'move';
    if (!u.engage && !marching && !u.returning) {
      const e = this.findEnemyUnit(u, combat.aggroRadius);
      if (e) u.engage = e.id;
    }

    // What are we fighting?
    let target = null;
    let tt = '';
    if (u.engage) { target = this.units.get(u.engage); tt = 'u'; }
    else if (u.order && u.order.type === 'attack') {
      tt = u.order.tt;
      target = tt === 'b' ? this.buildings.get(u.order.tid) : this.units.get(u.order.tid);
    }

    if (target) {
      if (this.inRange(u, def.range, target, tt)) { this.strike(u, def, target, tt); return; }
      const goal = tt === 'b' ? this.idx(target.x, target.y) : this.tileOf(target);
      this.approach(u, def, dt, goal, tt === 'b' ? target : null);
      return;
    }

    if (marching) {
      const goal = u.order.goal;
      const gx = (goal % this.size) + 0.5;
      const gy = Math.floor(goal / this.size) + 0.5;
      if (this.tileOf(u) === goal) {
        if (this.moveToward(u, gx, gy, def.speed * dt)) this.goIdle(u);
        return;
      }
      const res = this.followField(u, def, dt, 'move', goal);
      if (res === 'unreachable') this.goIdle(u);
      return;
    }

    // Idle: drift back to the anchor if pushed or after a chase.
    const away = Math.hypot(u.x - u.anchorX, u.y - u.anchorY);
    if (away > 1.2) {
      const ax = Math.floor(u.anchorX);
      const ay = Math.floor(u.anchorY);
      const goal = this.idx(ax, ay);
      if (this.tileOf(u) === goal || this.solid(goal)) {
        this.moveToward(u, u.anchorX, u.anchorY, def.speed * dt);
      } else if (this.followField(u, def, dt, 'move', goal) === 'unreachable') {
        u.anchorX = u.x; u.anchorY = u.y;
      }
    } else {
      u.returning = false;
    }
  }

  goIdle(u) {
    u.order = null;
    u.engage = 0;
    u.returning = false;
    u.anchorX = u.x;
    u.anchorY = u.y;
  }

  /**
   * March toward `goal` through enemy walls if needed. If the next tile holds an
   * enemy building, attack it instead of walking.
   */
  approach(u, def, dt, goal, targetBuilding) {
    const field = this.getField(u.owner, 'break', goal);
    if (!field) return;
    const here = this.tileOf(u);
    const grid = this.gridFor(u.owner, 'break');
    const next = here === goal ? goal : nextStep(field, grid, here, goal);
    if (next < 0) {
      if (targetBuilding || !Number.isFinite(field[here])) this.goIdle(u);
      return;
    }
    const bid = this.occ[next];
    if (bid && (!targetBuilding || bid !== targetBuilding.id)) {
      const blocker = this.buildings.get(bid);
      if (blocker && this.hostile(u.owner, blocker.owner)) {
        if (this.inRange(u, def.range, blocker, 'b')) { this.strike(u, def, blocker, 'b'); return; }
      }
    }
    const nx = (next % this.size) + 0.5;
    const ny = Math.floor(next / this.size) + 0.5;
    this.moveToward(u, nx, ny, def.speed * dt);
  }

  /** Follow a non-breaking flow field toward `goal`. Returns 'moved' | 'wait' | 'unreachable'. */
  followField(u, def, dt, mode, goal) {
    const field = this.getField(u.owner, mode, goal);
    if (!field) return 'wait';
    const here = this.tileOf(u);
    if (!Number.isFinite(field[here])) return 'unreachable';
    const next = nextStep(field, this.gridFor(u.owner, mode), here, goal);
    if (next < 0) return 'unreachable';
    this.moveToward(u, (next % this.size) + 0.5, Math.floor(next / this.size) + 0.5, def.speed * dt);
    return 'moved';
  }

  /** Step toward (tx, ty); returns true when the point is reached. Never enters solid tiles. */
  moveToward(u, tx, ty, step) {
    const dx = tx - u.x;
    const dy = ty - u.y;
    const d = Math.hypot(dx, dy);
    if (d <= step) {
      if (!this.solid(this.idx(Math.floor(tx), Math.floor(ty))) || this.tileOf(u) === this.idx(Math.floor(tx), Math.floor(ty))) {
        u.x = tx; u.y = ty;
      }
      return true;
    }
    const nx = u.x + (dx / d) * step;
    const ny = u.y + (dy / d) * step;
    const ni = this.idx(Math.floor(nx), Math.floor(ny));
    if (ni === this.tileOf(u) || !this.solid(ni)) { u.x = nx; u.y = ny; }
    return false;
  }

  strike(u, def, target, tt) {
    if (u.cd > 0) return;
    u.cd = def.cooldown;
    const tx = tt === 'b' ? target.x + 0.5 : target.x;
    const ty = tt === 'b' ? target.y + 0.5 : target.y;
    this.events.fx.push(u.kind === 'archer' ? 1 : 0, u.x, u.y, tx, ty);
    if (tt === 'b') this.damageBuilding(target, def.damage, u.owner);
    else this.damageUnit(target, def.damage, u.owner);
  }

  alertDefender(victimId, attackerId, x, y) {
    const victim = this.players.get(victimId);
    if (!victim || this.time - victim.alertAt < this.config.alertCooldown) return;
    victim.alertAt = this.time;
    const attacker = this.players.get(attackerId);
    this.events.notices.push({
      to: victimId, kind: 'alert', x, y,
      text: `Votre base est attaquée${attacker ? ` par ${attacker.name}` : ''} !`,
    });
  }

  damageUnit(target, amount, attackerId) {
    target.hp -= amount;
    if (target.hp > 0) return;
    this.removeUnit(target);
    const attacker = this.players.get(attackerId);
    if (attacker) attacker.glory += this.config.combat.gloryPerUnitKill;
    this.events.playersDirty = true;
  }

  damageBuilding(b, amount, attackerId) {
    b.hp -= amount;
    this.alertDefender(b.owner, attackerId, b.x, b.y);
    if (b.hp > 0) { this.events.bHp.set(b.id, b.hp); return; }
    const attacker = this.players.get(attackerId);
    const victim = this.players.get(b.owner);
    const def = this.config.buildings[b.kind];
    const cap = this.config.economy.goldCap;
    this.removeBuilding(b);
    if (attacker) {
      attacker.gold = Math.min(cap, attacker.gold + Math.floor(def.cost * this.config.economy.buildingLootShare));
      attacker.glory += Math.round(def.cost * this.config.combat.buildingGloryPerGold);
    }
    if (b.kind === 'core' && victim) this.eliminate(victim, attacker);
    this.events.playersDirty = true;
  }

  /** A core fell: loot, wipe the base, respawn the victim elsewhere with a shield. */
  eliminate(victim, attacker) {
    const loot = Math.floor(victim.gold * this.config.economy.coreLootShare);
    victim.gold -= loot;
    if (attacker) {
      attacker.gold = Math.min(this.config.economy.goldCap, attacker.gold + loot);
      attacker.glory += World.coreGlory(this.config.combat, attacker.glory, victim.glory);
    }
    this.wipeAssets(victim);
    victim.gold = Math.max(victim.gold, this.startGold);
    const by = attacker ? attacker.name : 'un inconnu';
    this.notify(null, `${by} a rasé le bastion de ${victim.name} ! (+${loot} or pillés)`, 'kill');
    const respawned = this.spawnBase(victim);
    this.notify(victim.id, respawned
      ? `Votre Noyau est tombé. Une nouvelle base vous attend, sous bouclier.`
      : `Votre Noyau est tombé et la carte est pleine : réessayez plus tard.`, 'alert');
  }

  /**
   * Glory for razing a core: base × clamp((victim + 100) / (attacker + 100), min, max).
   * Farming a much weaker player pays a quarter; toppling the leader pays up to 1.5×.
   */
  static coreGlory(combat, attackerGlory, victimGlory) {
    const ratio = (victimGlory + 100) / (attackerGlory + 100);
    const k = Math.min(combat.coreGloryMax, Math.max(combat.coreGloryMin, ratio));
    return Math.round(combat.gloryPerCore * k);
  }

  /** Unit spread so groups don't stack on one pixel. */
  separateUnits() {
    const list = [...this.units.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (Math.abs(dx) > SEPARATION || Math.abs(dy) > SEPARATION) continue;
        const d = Math.hypot(dx, dy) || 0.001;
        if (d >= SEPARATION) continue;
        const push = (SEPARATION - d) / 2;
        const ux = dx / d || (this.random() - 0.5);
        const uy = dy / d;
        this.nudge(a, -ux * push, -uy * push);
        this.nudge(b, ux * push, uy * push);
      }
    }
  }

  nudge(u, dx, dy) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    if (!this.inBounds(Math.floor(nx), Math.floor(ny))) return;
    const ni = this.idx(Math.floor(nx), Math.floor(ny));
    if (ni === this.tileOf(u) || !this.solid(ni)) { u.x = nx; u.y = ny; }
  }

  // ---------------------------------------------------------------- flow fields

  /** Grid predicates for an owner: 'move' never crosses buildings, 'break' smashes hostile ones. */
  gridFor(owner, mode) {
    const breakCost = this.config.combat.breakCost;
    const occ = this.occ;
    const breakable = (i) => {
      const id = occ[i];
      if (!id) return false;
      const b = this.buildings.get(id);
      return !!b && this.hostile(owner, b.owner);
    };
    return {
      size: this.size,
      solid: (i) => this.solid(i),
      passable: mode === 'break'
        ? (i) => this.terrainWalkable(i) && (occ[i] === 0 || breakable(i))
        : (i) => this.terrainWalkable(i) && occ[i] === 0,
      extraCost: mode === 'break' ? (i) => (occ[i] !== 0 && breakable(i) ? breakCost : 0) : () => 0,
    };
  }

  /** Cached flow field toward `goal`, or null when this tick's budget is spent. */
  getField(owner, mode, goal) {
    const key = `${mode}:${owner}:${goal}`;
    const hit = this.flowCache.get(key);
    if (hit) { this.flowCache.delete(key); this.flowCache.set(key, hit); } // LRU: most recent last
    if (hit && hit.version === this.layoutVersion) return hit.field;
    const used = this.ownerBudget.get(owner) || 0;
    if (this.fieldBudget <= 0 || used >= FIELD_BUDGET_PER_OWNER) return hit ? hit.field : null;
    this.fieldBudget--;
    this.ownerBudget.set(owner, used + 1);
    while (this.flowCache.size >= this.flowCacheLimit) this.flowCache.delete(this.flowCache.keys().next().value);
    const field = computeFlowField(this.gridFor(owner, mode), goal);
    this.flowCache.set(key, { field, version: this.layoutVersion });
    return field;
  }

  // ---------------------------------------------------------------- views

  /** Compact building tuple sent to clients: [id, owner, kindIndex, x, y, hp]. */
  static packBuilding(b) {
    return [b.id, b.owner, BUILDING_KINDS.indexOf(b.kind), b.x, b.y, Math.max(0, Math.round(b.hp))];
  }

  /** Flat unit array for snapshots: id, owner, kind, x×100, y×100, hp per unit. */
  packUnits() {
    const out = [];
    for (const u of this.units.values()) {
      out.push(u.id, u.owner, UNIT_KINDS.indexOf(u.kind), Math.round(u.x * 100), Math.round(u.y * 100), Math.max(0, Math.round(u.hp)));
    }
    return out;
  }

  /** Public scoreboard rows. */
  playerList() {
    const rows = [];
    for (const p of this.players.values()) {
      const core = this.coreOf(p);
      rows.push({
        id: p.id, name: p.name, color: p.color, glory: p.glory, online: p.online,
        shielded: this.isShielded(p), cx: core ? core.x : -1, cy: core ? core.y : -1,
      });
    }
    return rows.sort((a, b) => b.glory - a.glory);
  }

  /** Private per-player status line. */
  playerStatus(p) {
    return {
      gold: Math.floor(p.gold), income: this.income(p), glory: p.glory,
      units: this.unitCount(p), cap: this.unitCap(p), queue: p.queue.length,
      shield: this.shieldLeft(p), core: p.coreId,
    };
  }

  // ---------------------------------------------------------------- persistence

  /** Serialisable snapshot of the whole world (no sockets, no tokens in clear). */
  toJSON() {
    return {
      version: 1,
      seed: this.seed,
      size: this.size,
      savedAt: this.now(),
      nextPlayerId: this.nextPlayerId,
      nextId: this.nextId,
      tileEdits: [...this.tileEdits.entries()],
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, tokenHash: p.tokenHash, color: p.color,
        gold: Math.floor(p.gold), glory: p.glory, coreId: p.coreId,
        shieldUntil: p.shieldUntil, queue: p.queue, lastSeen: p.lastSeen,
        createdAt: p.createdAt, playSeconds: p.playSeconds || 0,
      })),
      buildings: [...this.buildings.values()].map((b) => ({ id: b.id, owner: b.owner, kind: b.kind, x: b.x, y: b.y, hp: b.hp })),
      units: [...this.units.values()].map((u) => ({ id: u.id, owner: u.owner, kind: u.kind, x: u.x, y: u.y, hp: u.hp })),
    };
  }

  /** Rebuild a world from `toJSON()` output. Everyone starts offline, all units idle. */
  static fromJSON(data, opts = {}) {
    const w = new World({ ...opts, seed: data.seed, size: data.size });
    for (const [i, code] of data.tileEdits || []) { w.tiles[i] = code; w.tileEdits.set(i, code); }
    w.nextPlayerId = data.nextPlayerId;
    w.nextId = data.nextId;
    for (const s of data.players || []) {
      w.players.set(s.id, {
        ...s, online: false, queue: Array.isArray(s.queue) ? s.queue.filter((k) => w.config.units[k]) : [],
        counts: Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0])), alertAt: -Infinity, wasShielded: true,
      });
    }
    for (const s of data.buildings || []) {
      const p = w.players.get(s.owner);
      if (!p || !w.config.buildings[s.kind] || !w.inBounds(s.x, s.y)) continue;
      const i = w.idx(s.x, s.y);
      if (w.occ[i] !== 0) continue;
      const b = { ...s, cd: 0, readyAt: 0 };
      w.buildings.set(b.id, b);
      w.occ[i] = b.id;
      p.counts[b.kind]++;
    }
    for (const s of data.units || []) {
      const p = w.players.get(s.owner);
      if (!p || !w.config.units[s.kind]) continue;
      w.units.set(s.id, { ...s, cd: 0, order: null, engage: 0, anchorX: s.x, anchorY: s.y, returning: false });
    }
    for (const p of w.players.values()) if (p.coreId && !w.buildings.has(p.coreId)) p.coreId = 0;
    w.resetEvents();
    return w;
  }
}
