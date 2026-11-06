/**
 * The authoritative BASTIONS world: map, players, clans, buildings, units,
 * monster camps, the Sanctuary and the fixed-step simulation. Pure game logic:
 * no sockets, no file I/O; the clock and the randomness are injected, so the
 * whole simulation is unit-testable.
 */
import {
  CONFIG, TILE, WALKABLE, BUILDING_KINDS, UNIT_KINDS, PLAYER_COLORS, RESOURCES, NEUTRAL,
  keepLevel, canAfford, costValue,
} from '../shared/config.js';
import { generateMap } from '../shared/mapgen.js';
import { claimsFrom, territoryOwner, countAround } from '../shared/territory.js';
import { computeFlowField, nextStep } from './pathfinding.js';

/** Result helpers for player actions. */
const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (reason) => ({ ok: false, reason });

/** Max flow fields computed per tick; units needing more wait one tick. */
const FIELD_BUDGET_PER_TICK = 6;
/** Per player per tick, so one army cannot starve everyone else's pathfinding. */
const FIELD_BUDGET_PER_OWNER = 3;
/** Cache memory budget for flow fields (Float64 per tile). */
const FIELD_CACHE_BYTES = 24e6;
/** Two units closer than this push each other apart. */
const SEPARATION = 0.32;
/** Collision radius used when an attack targets a unit. */
const UNIT_RADIUS = 0.3;
/** Spatial hash cell size (tiles) for neighbour queries. */
const CELL = 4;
/** Effect codes on the wire. */
export const FX = Object.freeze({ MELEE: 0, ARROW: 1, BOLT: 2, BOULDER: 3, HEAL: 4 });

const TAG_RE = /^[A-Z0-9]{2,5}$/;

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
   * @param {object} [opts.startResources] Host override of config.spawn.start.
   */
  constructor({
    seed, size, config = CONFIG, now = () => Date.now(), random = Math.random, offlineShield = true,
    shieldSeconds = config.spawn.shieldSeconds, startResources = config.spawn.start,
  }) {
    this.config = config;
    this.shieldSeconds = shieldSeconds;
    this.start = { ...config.spawn.start, ...startResources };
    this.seed = seed >>> 0;
    this.size = size || config.map.size;
    this.now = now;
    this.random = random;
    this.offlineShield = offlineShield;

    const map = generateMap(this.seed, this.size, config.map);
    this.tiles = map.tiles;
    this.clearShrineSite();
    /** Tile edits made after generation (persisted): index → code. */
    this.tileEdits = new Map();
    /** Building id per tile, 0 when empty. */
    this.occ = new Int32Array(this.size * this.size);

    this.players = new Map();
    this.clans = new Map();
    this.invites = new Map();
    this.buildings = new Map();
    this.units = new Map();
    this.nextPlayerId = 1;
    this.nextId = 1;
    this.shrineId = 0;

    this.time = 0;
    this.seconds = 0;
    this.secondAcc = 0;
    this.layoutVersion = 0;
    this.claimsVersion = 0;
    this.claimsCache = { version: -1, claims: [] };
    this.campRespawns = [];
    this.flowCache = new Map();
    this.flowCacheLimit = Math.max(24, Math.floor(FIELD_CACHE_BYTES / (this.size * this.size * 8)));
    this.fieldBudget = FIELD_BUDGET_PER_TICK;
    this.ownerBudget = new Map();
    this.spawnFullAt = -1;
    this.buckets = new Map();
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
  terrainAt(x, y) { return this.inBounds(x, y) ? this.tiles[this.idx(x, y)] : TILE.ROCK; }
  /** Blocked for corner-cutting and spawning: bad terrain or any building. */
  solid(i) { return !this.terrainWalkable(i) || this.occ[i] !== 0; }

  /** Blocked for a unit of `owner`: like solid(), except friendly gates let it through. */
  blocked(owner, i) {
    if (!this.terrainWalkable(i)) return true;
    const id = this.occ[i];
    if (!id) return false;
    const b = this.buildings.get(id);
    return !(b && this.config.buildings[b.kind].gate && this.friendly(owner, b.owner));
  }

  setTile(i, code) {
    this.tiles[i] = code;
    this.tileEdits.set(i, code);
    this.events.tiles.push([i, code]);
  }

  /** The Sanctuary sits on an open clearing at the map centre (part of generation, not an edit). */
  clearShrineSite() {
    const c = Math.floor(this.size / 2);
    const r = this.config.map.shrineClearing;
    for (let y = c - r; y <= c + r; y++) {
      for (let x = c - r; x <= c + r; x++) if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = TILE.GRASS;
    }
  }

  /** Is the player currently protected from other players (spawn shield, or offline protection)? */
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

  /** Same player, or members of the same clan. */
  friendly(aOwner, bOwner) {
    if (aOwner === bOwner) return true;
    const a = this.players.get(aOwner);
    const b = this.players.get(bOwner);
    return !!a && !!b && !!a.clan && a.clan === b.clan;
  }

  /**
   * Can units/towers of `a` damage things owned by `b`? Monsters fight every
   * player (shields only protect against other players); allies never fight.
   */
  hostile(aOwner, bOwner) {
    if (aOwner === bOwner) return false;
    if (aOwner === NEUTRAL) return this.players.has(bOwner);
    if (bOwner === NEUTRAL) return this.players.has(aOwner);
    if (this.friendly(aOwner, bOwner)) return false;
    const a = this.players.get(aOwner);
    const b = this.players.get(bOwner);
    return !!a && !!b && !this.isShielded(a) && !this.isShielded(b);
  }

  coreOf(player) { return player && player.coreId ? this.buildings.get(player.coreId) : undefined; }
  coreLevel(player) { const c = this.coreOf(player); return c ? c.level : 0; }

  maxHp(b) { return b.kind === 'core' ? keepLevel(b.level).hp : this.config.buildings[b.kind].hp; }

  /** Territory claims of all players (cached until a keep or outpost changes). */
  claims() {
    if (this.claimsCache.version !== this.claimsVersion) {
      this.claimsCache = { version: this.claimsVersion, claims: claimsFrom(this.buildings.values()) };
    }
    return this.claimsCache.claims;
  }

  stock(p) { return { gold: p.gold, wood: p.wood, stone: p.stone }; }

  pay(p, cost) { for (const r of RESOURCES) p[r] -= cost[r] || 0; }

  gain(p, amount, mult = 1) {
    const cap = this.config.economy.cap;
    for (const r of RESOURCES) p[r] = Math.min(cap, p[r] + (amount[r] || 0) * mult);
  }

  /** Army room used (units + queue) and available. */
  popUsed(p) {
    let n = 0;
    for (const u of this.units.values()) if (u.owner === p.id) n += this.config.units[u.kind].pop;
    return n;
  }
  popQueued(p) { return p.queue.reduce((s, k) => s + this.config.units[k].pop, 0); }
  popCap(p) {
    const level = this.coreLevel(p);
    if (!level) return 0;
    let room = 0;
    for (const [k, def] of Object.entries(this.config.buildings)) if (def.popCap) room += p.counts[k] * def.popCap;
    return Math.min(keepLevel(level).unitCap, room);
  }

  /** Resources per second for a player. */
  income(p) {
    const out = { gold: 0, wood: 0, stone: 0 };
    const core = this.coreOf(p);
    if (!core) return out;
    const add = (inc) => { for (const r of RESOURCES) out[r] += inc[r] || 0; };
    add(keepLevel(core.level).income);
    for (const b of this.buildings.values()) {
      if (b.owner !== p.id) continue;
      const def = this.config.buildings[b.kind];
      if (def.income) add(def.income);
      if (b.yield) add(b.yield);
    }
    const shrine = this.buildings.get(this.shrineId);
    if (shrine && shrine.holder === p.id) add(this.config.shrine.income);
    return out;
  }

  /** Income of a sawmill / quarry from the matching terrain around it. */
  yieldAt(kind, x, y) {
    const def = this.config.buildings[kind];
    if (!def.near) return null;
    const code = def.near === 'forest' ? TILE.FOREST : TILE.ROCK;
    const n = countAround(x, y, (tx, ty) => this.terrainAt(tx, ty) === code);
    const out = {};
    for (const [r, v] of Object.entries(def.perTile)) out[r] = Math.min(def.maxIncome, v * n);
    return out;
  }

  notify(to, text, kind = 'info', extra = {}) { this.events.notices.push({ to, text, kind, ...extra }); }

  // ---------------------------------------------------------------- players

  /**
   * Register a new player and give them a base.
   * @returns {{ok:boolean, reason?:string, player?:object}}
   */
  addPlayer({ name, tokenHash, at = null }) {
    const used = new Map();
    for (const p of this.players.values()) used.set(p.color, (used.get(p.color) || 0) + 1);
    const color = [...PLAYER_COLORS].sort((a, b) => (used.get(a) || 0) - (used.get(b) || 0))[0];
    const player = this.makePlayer({
      id: this.nextPlayerId++, name, tokenHash, color, ...this.start, lastSeen: this.now(), createdAt: this.now(),
    });
    this.players.set(player.id, player);
    if (!this.spawnBase(player, at)) {
      this.players.delete(player.id);
      return fail('La carte est pleine : aucun emplacement libre pour une nouvelle base.');
    }
    this.events.playersDirty = true;
    return ok({ player });
  }

  /** Normalise a player record (new or loaded). */
  makePlayer(s) {
    return {
      id: s.id,
      name: s.name,
      tokenHash: s.tokenHash,
      color: s.color,
      gold: s.gold ?? this.start.gold,
      wood: s.wood ?? this.start.wood,
      stone: s.stone ?? this.start.stone,
      glory: s.glory || 0,
      online: false,
      coreId: s.coreId || 0,
      shieldUntil: s.shieldUntil || 0,
      queue: Array.isArray(s.queue) ? s.queue.filter((k) => this.config.units[k] && !this.config.units[k].neutral) : [],
      counts: Object.fromEntries(BUILDING_KINDS.map((k) => [k, 0])),
      lastSeen: s.lastSeen || this.now(),
      createdAt: s.createdAt || this.now(),
      playSeconds: s.playSeconds || 0,
      techs: { attack: s.techs?.attack || 0, armor: s.techs?.armor || 0 },
      clan: s.clan || null,
      alertAt: -Infinity,
      wasShielded: true,
    };
  }

  /** Remove a player and everything they own. */
  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.clan) this.leaveClan(playerId);
    this.wipeAssets(p);
    this.players.delete(playerId);
    this.invites.delete(playerId);
    const shrine = this.buildings.get(this.shrineId);
    if (shrine && shrine.holder === playerId) shrine.holder = 0;
    this.events.playersDirty = true;
  }

  setOnline(playerId, online) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.online = online;
    p.lastSeen = this.now();
    this.events.playersDirty = true;
  }

  /** Is (x, y) a decent keep location? Grass, free 3×3, mostly walkable territory. */
  goodSpawn(x, y) {
    const radius = keepLevel(1).radius;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.solid(this.idx(x + dx, y + dy))) return false;
      }
    }
    if (this.tiles[this.idx(x, y)] !== TILE.GRASS) return false;
    let total = 0;
    let open = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        total++;
        if (this.inBounds(x + dx, y + dy) && !this.solid(this.idx(x + dx, y + dy))) open++;
      }
    }
    return open / total >= 0.5;
  }

  /** Choose a spawn tile far from other keeps, camps and the Sanctuary, relaxing spacing if crowded. */
  findSpawn() {
    // A failed search is only retried once the layout changed (cheap rejection when full).
    if (this.spawnFullAt === this.layoutVersion) return null;
    const keeps = [];
    const others = [];
    for (const b of this.buildings.values()) {
      if (b.kind === 'core') keeps.push(b);
      else if (b.owner === NEUTRAL) others.push(b);
    }
    const { minCoreDistance, edgeMargin, candidates, shrineDistance } = this.config.spawn;
    const span = this.size - 2 * edgeMargin;
    if (span <= 0) return null;
    const c = Math.floor(this.size / 2);
    for (const k of [1, 0.75, 0.55]) {
      const minDist = minCoreDistance * k;
      let best = null;
      let bestScore = -Infinity;
      for (let n = 0; n < candidates; n++) {
        const x = edgeMargin + Math.floor(this.random() * span);
        const y = edgeMargin + Math.floor(this.random() * span);
        let d = Infinity;
        for (const b of keeps) d = Math.min(d, Math.hypot(b.x - x, b.y - y));
        if (d < minDist) continue;
        if (Math.hypot(c - x, c - y) < shrineDistance * k) continue;
        if (others.some((b) => Math.hypot(b.x - x, b.y - y) < 10)) continue;
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
   * Place a fresh keep (with guaranteed gold, forest and rock nearby, and a
   * spawn shield) for `player`.
   * @param {{x:number, y:number}|null} [at] Forced location (tests, admin tools).
   */
  spawnBase(player, at = null) {
    const spot = at || this.findSpawn();
    if (!spot) return false;
    const core = this.placeBuilding(player, 'core', spot.x, spot.y);
    player.coreId = core.id;
    player.shieldUntil = this.now() + this.shieldSeconds * 1000;
    player.wasShielded = true;
    this.ensureResourcesAround(spot.x, spot.y);
    this.events.playersDirty = true;
    return true;
  }

  /** Top up gold veins, forest and rock inside a new level-1 territory. */
  ensureResourcesAround(cx, cy) {
    const radius = keepLevel(1).radius;
    const g = this.config.spawn.guaranteed;
    const counts = { [TILE.GOLD]: 0, [TILE.FOREST]: 0, [TILE.ROCK]: 0 };
    const grass = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > (radius - 1) * (radius - 1) || !this.inBounds(cx + dx, cy + dy)) continue;
        const i = this.idx(cx + dx, cy + dy);
        if (counts[this.tiles[i]] !== undefined) counts[this.tiles[i]]++;
        else if (this.tiles[i] === TILE.GRASS && this.occ[i] === 0 && d2 >= 16) grass.push(i);
      }
    }
    const pick = () => (grass.length ? grass.splice(Math.floor(this.random() * grass.length), 1)[0] : -1);
    const fill = (code, want, cluster) => {
      while (counts[code] < want) {
        const i = pick();
        if (i < 0) return;
        const x = i % this.size;
        const y = Math.floor(i / this.size);
        for (const [dx, dy] of cluster) {
          const j = this.idx(x + dx, y + dy);
          if (this.inBounds(x + dx, y + dy) && this.tiles[j] === TILE.GRASS && this.occ[j] === 0
            && Math.hypot(x + dx - cx, y + dy - cy) >= 4) {
            this.setTile(j, code);
            counts[code]++;
          }
        }
      }
    };
    fill(TILE.GOLD, g.gold, [[0, 0]]);
    fill(TILE.FOREST, g.forest, [[0, 0], [1, 0], [0, 1]]);
    fill(TILE.ROCK, g.rock, [[0, 0], [1, 0]]);
  }

  /** Destroy every building and unit a player owns (no rewards). */
  wipeAssets(player) {
    for (const b of [...this.buildings.values()]) if (b.owner === player.id) this.removeBuilding(b);
    for (const u of [...this.units.values()]) if (u.owner === player.id) this.removeUnit(u);
    player.coreId = 0;
    player.queue = [];
  }

  // ---------------------------------------------------------------- clans

  /** Found a clan with a 2–5 character tag. */
  createClan(playerId, rawTag) {
    const p = this.players.get(playerId);
    if (!p) return fail('Joueur inconnu.');
    if (p.clan) return fail('Vous êtes déjà dans un clan.');
    const tag = typeof rawTag === 'string' ? rawTag.normalize('NFKC').trim().toUpperCase() : '';
    if (!TAG_RE.test(tag)) return fail('Le tag de clan fait 2 à 5 lettres ou chiffres.');
    if (this.clans.has(tag)) return fail('Ce tag est déjà pris.');
    this.clans.set(tag, { tag, leader: p.id, members: new Set([p.id]) });
    p.clan = tag;
    this.clanChanged();
    this.notify(null, `${p.name} fonde le clan [${tag}].`, 'info');
    return ok({ tag });
  }

  /** Invite another player into your clan (they must accept). */
  inviteToClan(playerId, targetId) {
    const p = this.players.get(playerId);
    const t = this.players.get(targetId);
    if (!p || !p.clan) return fail('Fondez ou rejoignez d\'abord un clan.');
    if (!t || t.id === p.id) return fail('Joueur inconnu.');
    if (t.clan) return fail(`${t.name} est déjà dans un clan.`);
    const clan = this.clans.get(p.clan);
    if (clan.members.size >= this.config.clans.maxMembers) return fail(`Un clan compte au plus ${this.config.clans.maxMembers} membres.`);
    this.invites.set(t.id, { tag: clan.tag, from: p.id, expires: this.now() + this.config.clans.inviteSeconds * 1000 });
    this.notify(t.id, `${p.name} vous invite dans le clan [${clan.tag}].`, 'invite', { tag: clan.tag, fromName: p.name });
    return ok();
  }

  /** Accept (or decline) your pending clan invitation. */
  answerInvite(playerId, accept) {
    const p = this.players.get(playerId);
    const inv = this.invites.get(playerId);
    this.invites.delete(playerId);
    if (!p || !inv || inv.expires < this.now()) return fail('Aucune invitation en cours.');
    if (!accept) return ok();
    const clan = this.clans.get(inv.tag);
    if (!clan) return fail('Ce clan n\'existe plus.');
    if (p.clan) return fail('Vous êtes déjà dans un clan.');
    if (clan.members.size >= this.config.clans.maxMembers) return fail('Ce clan est complet.');
    clan.members.add(p.id);
    p.clan = clan.tag;
    this.clanChanged();
    this.notify(null, `${p.name} rejoint le clan [${clan.tag}].`, 'info');
    return ok({ tag: clan.tag });
  }

  leaveClan(playerId) {
    const p = this.players.get(playerId);
    if (!p || !p.clan) return fail('Vous n\'êtes dans aucun clan.');
    const clan = this.clans.get(p.clan);
    p.clan = null;
    if (clan) {
      clan.members.delete(p.id);
      if (clan.members.size === 0) this.clans.delete(clan.tag);
      else if (clan.leader === p.id) clan.leader = [...clan.members][0];
    }
    this.clanChanged();
    return ok();
  }

  /** Alliances change who may cross gates and who fights whom. */
  clanChanged() {
    this.layoutVersion++;
    this.events.playersDirty = true;
  }

  // ---------------------------------------------------------------- buildings

  placeBuilding(owner, kind, x, y, extra = {}) {
    const def = this.config.buildings[kind];
    const ownerId = typeof owner === 'number' ? owner : owner.id;
    const b = { id: this.nextId++, owner: ownerId, kind, x, y, hp: def.hp, cd: 0, readyAt: 0, ...extra };
    if (kind === 'core') { b.level = b.level || 1; b.hp = keepLevel(b.level).hp; }
    const y2 = this.yieldAt(kind, x, y);
    if (y2) b.yield = y2;
    this.buildings.set(b.id, b);
    this.occ[this.idx(x, y)] = b.id;
    const p = this.players.get(ownerId);
    if (p) p.counts[kind]++;
    if (kind === 'core' || kind === 'outpost') this.claimsVersion++;
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
    if (b.kind === 'core' || b.kind === 'outpost') this.claimsVersion++;
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
          if (!this.inBounds(x + dx, y + dy)) continue;
          const i = this.idx(x + dx, y + dy);
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
    const level = this.coreLevel(player);
    if (!level) return fail('Vous n\'avez plus de Donjon.');
    if (def.minLevel && level < def.minLevel) return fail(`${def.name} : débloqué au niveau ${def.minLevel} du Donjon.`);
    if (territoryOwner(this.claims(), x, y) !== player.id) return fail('Hors de votre territoire.');
    const i = this.idx(x, y);
    if (this.occ[i] !== 0) return fail('Emplacement occupé.');
    const t = this.tiles[i];
    if (def.needsGold && t !== TILE.GOLD) return fail('Une Mine doit être posée sur un filon d\'or.');
    if (!def.needsGold && t !== TILE.GRASS) return fail(t === TILE.GOLD ? 'Les filons d\'or sont réservés aux Mines.' : 'Terrain impraticable.');
    if (def.near) {
      const y2 = this.yieldAt(kind, x, y);
      if (!Object.values(y2).some((v) => v > 0)) {
        return fail(def.near === 'forest' ? 'Une Scierie doit toucher la forêt.' : 'Une Carrière doit toucher la roche.');
      }
    }
    const total = BUILDING_KINDS.reduce((s, k) => s + player.counts[k], 0);
    if (total >= this.config.limits.buildingsPerPlayer) return fail('Limite de bâtiments atteinte.');
    const kl = keepLevel(level);
    if (kind === 'tower' && player.counts.tower >= kl.towers) return fail(`Maximum ${kl.towers} Tours à ce niveau de Donjon.`);
    if (kind === 'outpost' && player.counts.outpost >= kl.outposts) return fail(`Maximum ${kl.outposts} Avant-poste(s) à ce niveau de Donjon.`);
    if (def.max && player.counts[kind] >= def.max) return fail(`Une seule ${def.name} par seigneur.`);
    if (!canAfford(this.stock(player), def.cost)) return fail('Ressources insuffisantes.');
    return ok();
  }

  /** Build for a player (resources are spent). */
  build(playerId, kind, x, y) {
    const player = this.players.get(playerId);
    if (!player) return fail('Joueur inconnu.');
    const check = this.canBuild(player, kind, x, y);
    if (!check.ok) return check;
    this.pay(player, this.config.buildings[kind].cost);
    const b = this.placeBuilding(player, kind, x, y);
    return ok({ building: b });
  }

  /** Demolish one of your own buildings (not the keep) for a partial refund. */
  demolish(playerId, buildingId) {
    const player = this.players.get(playerId);
    const b = this.buildings.get(buildingId);
    if (!player || !b || b.owner !== playerId) return fail('Ce bâtiment ne vous appartient pas.');
    if (b.kind === 'core') return fail('Le Donjon ne peut pas être démoli.');
    const def = this.config.buildings[b.kind];
    const k = this.config.economy.demolishRefund * (b.hp / def.hp);
    const refund = {};
    for (const r of RESOURCES) refund[r] = Math.floor((def.cost[r] || 0) * k);
    this.gain(player, refund);
    this.removeBuilding(b);
    return ok({ refund });
  }

  /** Raise the keep one level: bigger territory, more HP, income and army, new unlocks. */
  upgradeCore(playerId) {
    const p = this.players.get(playerId);
    const core = this.coreOf(p);
    if (!core) return fail('Vous n\'avez plus de Donjon.');
    if (core.level >= this.config.keep.levels.length) return fail('Votre Donjon est déjà au niveau maximum.');
    const next = keepLevel(core.level + 1);
    if (!canAfford(this.stock(p), next.cost)) return fail('Ressources insuffisantes.');
    this.pay(p, next.cost);
    const before = keepLevel(core.level).hp;
    core.level++;
    core.hp += next.hp - before;
    this.claimsVersion++;
    this.events.bAdd.push(core);
    this.notify(p.id, `Donjon niveau ${core.level} ! Territoire agrandi et nouvelles constructions débloquées.`, 'loot');
    this.events.playersDirty = true;
    return ok({ level: core.level });
  }

  /** Forge research: +attack or +armor for all of the player's units. */
  research(playerId, tech) {
    const p = this.players.get(playerId);
    const t = this.config.techs[tech];
    if (!p || !t) return fail('Recherche inconnue.');
    if (p.counts.forge === 0) return fail('Construisez d\'abord une Forge.');
    const level = p.techs[tech];
    if (level >= t.costs.length) return fail(`${t.name} : niveau maximum atteint.`);
    if (!canAfford(this.stock(p), t.costs[level])) return fail('Ressources insuffisantes.');
    this.pay(p, t.costs[level]);
    p.techs[tech]++;
    this.notify(p.id, `${t.name} niveau ${p.techs[tech]} !`, 'loot');
    return ok({ level: p.techs[tech] });
  }

  // ---------------------------------------------------------------- units

  /** Queue a unit for training (resources are spent now). */
  train(playerId, kind) {
    const p = this.players.get(playerId);
    const def = this.config.units[kind];
    if (!p || !def || def.neutral) return fail('Unité inconnue.');
    const level = this.coreLevel(p);
    if (def.minLevel && level < def.minLevel) return fail(`${def.name} : débloqué au niveau ${def.minLevel} du Donjon.`);
    const trainers = Object.entries(this.config.buildings).filter(([, b]) => b.trains && b.trains.includes(kind));
    if (!trainers.some(([k]) => p.counts[k] > 0)) {
      return fail(`Construisez d'abord : ${trainers.map(([, b]) => b.name).join(' ou ')}.`);
    }
    if (p.queue.length >= this.config.limits.trainQueue) return fail('File de recrutement pleine.');
    if (this.popUsed(p) + this.popQueued(p) + def.pop > this.popCap(p)) {
      return fail('Armée au complet : construisez des casernes ou montez le Donjon de niveau.');
    }
    if (!canAfford(this.stock(p), def.cost)) return fail('Ressources insuffisantes.');
    this.pay(p, def.cost);
    p.queue.push(kind);
    return ok();
  }

  spawnUnit(owner, kind, x, y, extra = {}) {
    const def = this.config.units[kind];
    const u = {
      id: this.nextId++, owner: typeof owner === 'number' ? owner : owner.id, kind, x, y, hp: def.hp, cd: 0,
      order: null, engage: 0, anchorX: x, anchorY: y, returning: false, ...extra,
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
      if (!core) return fail('Vous n\'avez plus de Donjon.');
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
      if (tt === 'b' && this.config.buildings[target.kind].invulnerable) return fail('Le Sanctuaire ne se détruit pas : tenez-le avec vos troupes.');
      if (this.friendly(playerId, target.owner)) return fail('Vous ne pouvez pas attaquer un allié.');
      if (target.owner !== NEUTRAL) {
        const victim = this.players.get(target.owner);
        if (!victim || this.isShielded(victim)) return fail(`${victim ? victim.name : 'Ce joueur'} est protégé par un bouclier.`);
        if (this.now() < player.shieldUntil) {
          player.shieldUntil = 0;
          this.notify(player.id, 'Vous attaquez un joueur : votre bouclier de départ est levé.', 'warn');
          this.events.playersDirty = true;
        }
      }
      let assigned = 0;
      for (const u of units) {
        if (tt === 'u' && this.config.units[u.kind].siege) continue; // catapults only hit buildings
        u.order = { type: 'attack', tt, tid: target.id };
        u.engage = 0;
        u.returning = false;
        assigned++;
      }
      return assigned ? ok() : fail('Les catapultes n\'attaquent que les bâtiments.');
    }
    return fail('Ordre inconnu.');
  }

  // ---------------------------------------------------------------- monsters and the Sanctuary

  /** Place the Sanctuary and fill the map with monster camps (new worlds). */
  seedNeutrals() {
    this.ensureShrine();
    const target = this.campTarget();
    for (let n = this.campCount(); n < target; n++) if (!this.spawnCamp()) break;
  }

  ensureShrine() {
    if (this.buildings.has(this.shrineId)) return;
    for (const b of this.buildings.values()) if (b.kind === 'shrine') { this.shrineId = b.id; return; }
    const c = Math.floor(this.size / 2);
    const spot = this.occ[this.idx(c, c)] === 0 && this.terrainWalkable(this.idx(c, c)) ? this.idx(c, c) : this.nearestOpenTile(c, c, 8);
    if (spot < 0) return;
    const s = this.placeBuilding(NEUTRAL, 'shrine', spot % this.size, Math.floor(spot / this.size),
      { holder: 0, progress: 0, capturer: 0, contested: false });
    this.shrineId = s.id;
  }

  campTarget() { return Math.round((this.size * this.size / 1000) * this.config.camps.per1000Tiles); }
  campCount() {
    let n = 0;
    for (const b of this.buildings.values()) if (this.config.buildings[b.kind].camp) n++;
    return n;
  }

  /** Spawn one random camp with its guards. Returns the camp building or null. */
  spawnCamp() {
    const cfg = this.config.camps;
    const kinds = Object.entries(cfg.kinds);
    let roll = this.random() * kinds.reduce((s, [, k]) => s + k.weight, 0);
    let [campKind, camp] = kinds[0];
    for (const [k, def] of kinds) { roll -= def.weight; if (roll <= 0) { campKind = k; camp = def; break; } }

    const keeps = [];
    const camps = [];
    for (const b of this.buildings.values()) {
      if (b.kind === 'core' || b.kind === 'outpost') keeps.push(b);
      else if (this.config.buildings[b.kind].camp || b.kind === 'shrine') camps.push(b);
    }
    const margin = 5;
    for (let tries = 0; tries < 300; tries++) {
      const x = margin + Math.floor(this.random() * (this.size - 2 * margin));
      const y = margin + Math.floor(this.random() * (this.size - 2 * margin));
      if (this.tiles[this.idx(x, y)] !== TILE.GRASS) continue;
      let open = true;
      for (let dy = -1; dy <= 1 && open; dy++) for (let dx = -1; dx <= 1 && open; dx++) open = !this.solid(this.idx(x + dx, y + dy));
      if (!open) continue;
      if (keeps.some((b) => Math.hypot(b.x - x, b.y - y) < cfg.minDistanceFromKeeps)) continue;
      if (camps.some((b) => Math.hypot(b.x - x, b.y - y) < cfg.minDistanceBetween)) continue;
      if (territoryOwner(this.claims(), x, y) !== 0) continue;
      const b = this.placeBuilding(NEUTRAL, camp.building, x, y, { campKind });
      for (const [kind, n] of camp.guards) {
        for (let k = 0; k < n; k++) {
          const spot = this.nearestOpenTile(x + Math.round((this.random() - 0.5) * 4), y + Math.round((this.random() - 0.5) * 4), 3);
          if (spot < 0) continue;
          this.spawnUnit(NEUTRAL, kind, (spot % this.size) + 0.5, Math.floor(spot / this.size) + 0.5, { campId: b.id });
        }
      }
      return b;
    }
    return null;
  }

  /** Keep the camp count at its target: destroyed camps come back after respawnSeconds. */
  maintainCamps() {
    const missing = this.campTarget() - this.campCount() - this.campRespawns.length;
    for (let k = 0; k < missing; k++) this.campRespawns.push(this.time + this.config.camps.respawnSeconds);
    const due = this.campRespawns.filter((t) => t <= this.time);
    if (due.length === 0) return;
    this.campRespawns = this.campRespawns.filter((t) => t > this.time);
    // Guards whose camp fell long ago go home with it (unless still fighting).
    for (const u of [...this.units.values()]) {
      if (u.owner === NEUTRAL && u.campId && !this.buildings.has(u.campId) && !u.engage) this.removeUnit(u);
    }
    for (let k = 0; k < due.length; k++) if (!this.spawnCamp()) this.campRespawns.push(this.time + 30);
  }

  /** Side of a player at the Sanctuary: their clan, or themselves. */
  sideOf(p) { return p.clan ? `c:${p.clan}` : `p:${p.id}`; }

  /**
   * Once per second: whoever alone has units near the Sanctuary captures it
   * after captureSeconds; the holder earns income (see income()) and glory.
   */
  updateShrine() {
    const s = this.buildings.get(this.shrineId);
    if (!s) return;
    const cfg = this.config.shrine;
    const sides = new Map();
    for (const u of this.unitsNear(s.x + 0.5, s.y + 0.5, cfg.radius)) {
      if (u.owner === NEUTRAL) continue;
      const p = this.players.get(u.owner);
      if (!p || this.isShielded(p)) continue;
      const side = this.sideOf(p);
      const e = sides.get(side) || { count: 0, byPlayer: new Map() };
      e.count++;
      e.byPlayer.set(p.id, (e.byPlayer.get(p.id) || 0) + 1);
      sides.set(side, e);
    }
    const holder = this.players.get(s.holder);
    if (s.holder && !holder) s.holder = 0;
    const holderSide = holder ? this.sideOf(holder) : null;
    s.contested = sides.size > 1;
    if (sides.size === 1) {
      const [side, e] = [...sides.entries()][0];
      if (side === holderSide) {
        s.progress = 0;
      } else {
        if (s.capturer !== side) { s.capturer = side; s.progress = 0; }
        s.progress++;
        if (s.progress >= cfg.captureSeconds) {
          const winner = [...e.byPlayer.entries()].sort((a, b) => b[1] - a[1])[0][0];
          s.holder = winner;
          s.progress = 0;
          s.capturer = 0;
          const w = this.players.get(winner);
          this.notify(null, `${w.name}${w.clan ? ` [${w.clan}]` : ''} s'empare du Sanctuaire !`, 'kill');
          this.events.bAdd.push(s);
        }
      }
    } else if (sides.size === 0 && s.progress > 0) {
      s.progress--;
    }
    if (holder && this.seconds % cfg.gloryEverySeconds === 0) holder.glory++;
    this.events.playersDirty = true;
  }

  // ---------------------------------------------------------------- simulation

  /** Advance the world by `dt` seconds (call at CONFIG.tickRate). */
  tick(dt) {
    this.time += dt;
    this.fieldBudget = FIELD_BUDGET_PER_TICK;
    this.ownerBudget.clear();
    this.rebuildBuckets();
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
    this.seconds++;
    for (const p of this.players.values()) {
      if (p.online) p.playSeconds = (p.playSeconds || 0) + 1;
      this.gain(p, this.income(p));
      const shielded = this.isShielded(p);
      if (shielded !== p.wasShielded) {
        p.wasShielded = shielded;
        this.layoutVersion++; // shielded bases become (im)passable for attackers
        this.events.playersDirty = true;
      }
    }
    for (const [id, inv] of this.invites) if (inv.expires < this.now()) this.invites.delete(id);
    this.updateShrine();
    this.maintainCamps();
  }

  updateTraining() {
    for (const b of this.buildings.values()) {
      const def = this.config.buildings[b.kind];
      if (!def.trains || b.readyAt > this.time) continue;
      const p = this.players.get(b.owner);
      if (!p || p.queue.length === 0) continue;
      const qi = p.queue.findIndex((k) => def.trains.includes(k));
      if (qi < 0) continue;
      const kind = p.queue[qi];
      if (this.popUsed(p) + this.config.units[kind].pop > this.popCap(p)) continue;
      const spot = this.nearestOpenTile(b.x, b.y, 3);
      if (spot < 0) continue;
      p.queue.splice(qi, 1);
      const sx = (spot % this.size) + 0.3 + this.random() * 0.4;
      const sy = Math.floor(spot / this.size) + 0.3 + this.random() * 0.4;
      this.spawnUnit(p, kind, sx, sy);
      b.readyAt = this.time + def.trainSeconds;
    }
  }

  // Spatial hash for neighbour queries (rebuilt once per tick).
  rebuildBuckets() {
    this.buckets.clear();
    for (const u of this.units.values()) {
      const key = (Math.floor(u.x / CELL) << 16) | Math.floor(u.y / CELL);
      let list = this.buckets.get(key);
      if (!list) { list = []; this.buckets.set(key, list); }
      list.push(u);
    }
  }

  /** Units (from the last bucket rebuild) within `radius` of (x, y). */
  *unitsNear(x, y, radius) {
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const y0 = Math.floor((y - radius) / CELL);
    const y1 = Math.floor((y + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.buckets.get((cx << 16) | cy);
        if (!list) continue;
        for (const u of list) {
          if (this.units.has(u.id) && (u.x - x) ** 2 + (u.y - y) ** 2 <= r2) yield u;
        }
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
      let bestD = Infinity;
      for (const u of this.unitsNear(cx, cy, def.range)) {
        if (!this.hostile(t.owner, u.owner)) continue;
        const d = (u.x - cx) ** 2 + (u.y - cy) ** 2;
        if (d < bestD) { bestD = d; best = u; }
      }
      if (best) {
        t.cd = def.cooldown;
        this.events.fx.push(FX.BOLT, cx, cy, best.x, best.y);
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
    let bestD = Infinity;
    for (const o of this.unitsNear(u.x, u.y, radius)) {
      if (!this.hostile(u.owner, o.owner)) continue;
      const d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Healers: mend the most wounded friendly unit in range. */
  heal(u, def) {
    if (u.cd > 0) return;
    let best = null;
    let worst = 1;
    for (const o of this.unitsNear(u.x, u.y, def.range)) {
      if (o.id === u.id || !this.friendly(u.owner, o.owner)) continue;
      const frac = o.hp / this.config.units[o.kind].hp;
      if (frac < worst) { worst = frac; best = o; }
    }
    if (!best) return;
    u.cd = def.cooldown;
    best.hp = Math.min(this.config.units[best.kind].hp, best.hp + def.heal);
    this.events.fx.push(FX.HEAL, u.x, u.y, best.x, best.y);
  }

  updateUnit(u, dt) {
    const def = this.config.units[u.kind];
    const neutral = u.owner === NEUTRAL;
    const aggro = neutral ? this.config.camps.aggroRadius : this.config.combat.aggroRadius;
    const leash = neutral ? this.config.camps.leashRadius : this.config.combat.leashRadius;
    u.cd = Math.max(0, u.cd - dt);
    if (def.healer) this.heal(u, def);

    // Drop stale engagements and orders.
    if (u.engage) {
      const e = this.units.get(u.engage);
      if (!e || !this.hostile(u.owner, e.owner)) u.engage = 0;
    }
    if (u.order && u.order.type === 'attack') {
      const tgt = u.order.tt === 'b' ? this.buildings.get(u.order.tid) : this.units.get(u.order.tid);
      if (!tgt || !this.hostile(u.owner, tgt.owner)) this.goIdle(u);
    }

    // Leash for idle defenders and camp guards.
    if (!u.order && u.engage && Math.hypot(u.x - u.anchorX, u.y - u.anchorY) > leash) {
      u.engage = 0;
      u.returning = true;
    }

    // Acquire a fight: idle units and attackers react to nearby enemy units; marching
    // units, healers and siege engines do not.
    const marching = u.order && u.order.type === 'move';
    const fighter = !def.healer && !def.siege;
    if (fighter && !u.engage && !marching && !u.returning) {
      const e = this.findEnemyUnit(u, aggro);
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
      const goal = this.idx(Math.floor(u.anchorX), Math.floor(u.anchorY));
      if (this.tileOf(u) === goal || this.blocked(u.owner, goal)) {
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
      if (blocker && this.hostile(u.owner, blocker.owner) && !this.config.buildings[blocker.kind].invulnerable) {
        if (this.inRange(u, def.range, blocker, 'b')) { this.strike(u, def, blocker, 'b'); return; }
      }
    }
    this.moveToward(u, (next % this.size) + 0.5, Math.floor(next / this.size) + 0.5, def.speed * dt);
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

  /** Step toward (tx, ty); returns true when the point is reached. Never enters blocked tiles. */
  moveToward(u, tx, ty, step) {
    const dx = tx - u.x;
    const dy = ty - u.y;
    const d = Math.hypot(dx, dy);
    const here = this.tileOf(u);
    if (d <= step) {
      const ti = this.idx(Math.floor(tx), Math.floor(ty));
      if (ti === here || !this.blocked(u.owner, ti)) { u.x = tx; u.y = ty; }
      return true;
    }
    const nx = u.x + (dx / d) * step;
    const ny = u.y + (dy / d) * step;
    const ni = this.idx(Math.floor(nx), Math.floor(ny));
    if (ni === here || !this.blocked(u.owner, ni)) { u.x = nx; u.y = ny; }
    return false;
  }

  /** Attack multiplier from the owner's forge research. */
  attackMult(owner) {
    const p = this.players.get(owner);
    return p ? 1 + p.techs.attack * this.config.techs.attack.perLevel : 1;
  }

  strike(u, def, target, tt) {
    if (u.cd > 0 || def.healer) return;
    if (tt === 'u' && def.siege) return;
    u.cd = def.cooldown;
    const tx = tt === 'b' ? target.x + 0.5 : target.x;
    const ty = tt === 'b' ? target.y + 0.5 : target.y;
    const fx = def.siege ? FX.BOULDER : def.range > 2 ? FX.ARROW : FX.MELEE;
    this.events.fx.push(fx, u.x, u.y, tx, ty);
    const bonus = tt === 'u' && def.bonus ? def.bonus[target.kind] || 1 : 1;
    const amount = def.damage * bonus * this.attackMult(u.owner);
    if (tt === 'b') this.damageBuilding(target, amount, u.owner);
    else this.damageUnit(target, amount, u.owner);
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
    const p = this.players.get(target.owner);
    const armor = p ? p.techs.armor * this.config.techs.armor.perLevel : 0;
    target.hp -= amount * (1 - armor);
    if (target.hp > 0) return;
    this.removeUnit(target);
    const attacker = this.players.get(attackerId);
    if (attacker) attacker.glory += this.config.combat.gloryPerUnitKill;
    this.events.playersDirty = true;
  }

  damageBuilding(b, amount, attackerId) {
    const def = this.config.buildings[b.kind];
    if (def.invulnerable) return;
    b.hp -= amount;
    if (b.owner !== NEUTRAL) this.alertDefender(b.owner, attackerId, b.x, b.y);
    if (b.hp > 0) { this.events.bHp.set(b.id, b.hp); return; }
    const attacker = this.players.get(attackerId);
    const victim = this.players.get(b.owner);
    this.removeBuilding(b);
    if (def.camp) {
      this.lootCamp(b, attacker);
    } else if (attacker) {
      const loot = {};
      for (const r of RESOURCES) loot[r] = Math.floor((def.cost[r] || 0) * this.config.economy.buildingLootShare);
      this.gain(attacker, loot);
      attacker.glory += Math.round(costValue(def.cost) * this.config.combat.buildingGloryPerGold);
    }
    if (b.kind === 'core' && victim) this.eliminate(victim, attacker);
    this.events.playersDirty = true;
  }

  /** A monster camp fell: treasure and glory to the attacker; the camp returns elsewhere later. */
  lootCamp(b, attacker) {
    const camp = this.config.camps.kinds[b.campKind] || this.config.camps.kinds[this.config.buildings[b.kind].camp];
    this.campRespawns.push(this.time + this.config.camps.respawnSeconds);
    if (!attacker || !camp) return;
    this.gain(attacker, camp.loot);
    attacker.glory += camp.glory;
    const parts = [`+${camp.loot.gold} or`, `+${camp.loot.wood} bois`, `+${camp.loot.stone} pierre`];
    this.notify(attacker.id, `Trésor pillé : ${parts.join(', ')} !`, 'loot', { x: b.x, y: b.y });
  }

  /** A keep fell: loot, wipe the base, respawn the victim elsewhere with a shield. */
  eliminate(victim, attacker) {
    const loot = {};
    for (const r of RESOURCES) {
      loot[r] = Math.floor(victim[r] * this.config.economy.coreLootShare);
      victim[r] -= loot[r];
    }
    if (attacker) {
      this.gain(attacker, loot);
      attacker.glory += World.coreGlory(this.config.combat, attacker.glory, victim.glory);
    }
    this.wipeAssets(victim);
    for (const r of RESOURCES) victim[r] = Math.max(victim[r], this.start[r]);
    const by = attacker ? attacker.name : 'un inconnu';
    this.notify(null, `${by} a rasé le bastion de ${victim.name} ! (+${loot.gold} or pillés)`, 'kill');
    const respawned = this.spawnBase(victim);
    this.notify(victim.id, respawned
      ? 'Votre Donjon est tombé. Une nouvelle base vous attend, sous bouclier.'
      : 'Votre Donjon est tombé et la carte est pleine : réessayez plus tard.', 'alert');
  }

  /**
   * Glory for razing a keep: base × clamp((victim + 100) / (attacker + 100), min, max).
   * Farming a much weaker player pays a quarter; toppling the leader pays up to 1.5×.
   */
  static coreGlory(combat, attackerGlory, victimGlory) {
    const ratio = (victimGlory + 100) / (attackerGlory + 100);
    const k = Math.min(combat.coreGloryMax, Math.max(combat.coreGloryMin, ratio));
    return Math.round(combat.gloryPerCore * k);
  }

  /** Unit spread so groups don't stack on one pixel. */
  separateUnits() {
    for (const list of this.buckets.values()) {
      for (const a of list) {
        if (!this.units.has(a.id)) continue;
        for (const b of this.unitsNear(a.x, a.y, SEPARATION)) {
          if (b.id <= a.id) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
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
  }

  nudge(u, dx, dy) {
    const nx = u.x + dx;
    const ny = u.y + dy;
    if (!this.inBounds(Math.floor(nx), Math.floor(ny))) return;
    const ni = this.idx(Math.floor(nx), Math.floor(ny));
    if (ni === this.tileOf(u) || !this.blocked(u.owner, ni)) { u.x = nx; u.y = ny; }
  }

  // ---------------------------------------------------------------- flow fields

  /**
   * Grid predicates for an owner: 'move' crosses only friendly gates, 'break'
   * also smashes through hostile buildings (at a cost).
   */
  gridFor(owner, mode) {
    const breakCost = this.config.combat.breakCost;
    const occ = this.occ;
    const kinds = this.config.buildings;
    const open = (i) => {
      const id = occ[i];
      if (!id) return true;
      const b = this.buildings.get(id);
      return !!b && kinds[b.kind].gate && this.friendly(owner, b.owner);
    };
    const breakable = (i) => {
      const id = occ[i];
      if (!id) return false;
      const b = this.buildings.get(id);
      return !!b && !kinds[b.kind].invulnerable && this.hostile(owner, b.owner);
    };
    return {
      size: this.size,
      // Rock and water always block corner-cutting; buildings do unless they are friendly gates.
      solid: (i) => !this.terrainWalkable(i) || (occ[i] !== 0 && !open(i)),
      passable: mode === 'break'
        ? (i) => this.terrainWalkable(i) && (open(i) || breakable(i))
        : (i) => this.terrainWalkable(i) && open(i),
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

  /**
   * Compact building tuple sent to clients: [id, owner, kindIndex, x, y, hp, extra]
   * where extra is the keep level, or the Sanctuary holder.
   */
  static packBuilding(b) {
    const extra = b.kind === 'core' ? b.level : b.kind === 'shrine' ? b.holder : 0;
    return [b.id, b.owner, BUILDING_KINDS.indexOf(b.kind), b.x, b.y, Math.max(0, Math.round(b.hp)), extra || 0];
  }

  /**
   * Flat unit array for snapshots: id, owner, kind, x×100, y×100, hp per unit.
   * @param {(u:object) => boolean} [keep] Optional filter (view culling).
   */
  packUnits(keep = null) {
    const out = [];
    for (const u of this.units.values()) {
      if (keep && !keep(u)) continue;
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
        id: p.id, name: p.name, color: p.color, glory: p.glory, online: p.online, clan: p.clan,
        shielded: this.isShielded(p), cx: core ? core.x : -1, cy: core ? core.y : -1, level: core ? core.level : 0,
      });
    }
    return rows.sort((a, b) => b.glory - a.glory);
  }

  /** Public Sanctuary state. */
  shrineInfo() {
    const s = this.buildings.get(this.shrineId);
    if (!s) return null;
    return {
      x: s.x, y: s.y, holder: s.holder, progress: s.progress, need: this.config.shrine.captureSeconds,
      contested: !!s.contested, capturer: s.capturer || 0,
    };
  }

  /** Private per-player status line. */
  playerStatus(p) {
    const inc = this.income(p);
    const round = (v) => Math.round(v * 10) / 10;
    const inv = this.invites.get(p.id);
    return {
      gold: Math.floor(p.gold), wood: Math.floor(p.wood), stone: Math.floor(p.stone),
      income: { gold: round(inc.gold), wood: round(inc.wood), stone: round(inc.stone) },
      glory: p.glory, pop: this.popUsed(p), cap: this.popCap(p), queue: p.queue.length,
      shield: this.shieldLeft(p), core: p.coreId, level: this.coreLevel(p), techs: p.techs, clan: p.clan,
      invite: inv ? { tag: inv.tag, from: this.players.get(inv.from)?.name || '?' } : null,
    };
  }

  // ---------------------------------------------------------------- persistence

  /** Serialisable snapshot of the whole world (no sockets, no tokens in clear). */
  toJSON() {
    return {
      version: 2,
      seed: this.seed,
      size: this.size,
      savedAt: this.now(),
      nextPlayerId: this.nextPlayerId,
      nextId: this.nextId,
      tileEdits: [...this.tileEdits.entries()],
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, tokenHash: p.tokenHash, color: p.color,
        gold: Math.floor(p.gold), wood: Math.floor(p.wood), stone: Math.floor(p.stone),
        glory: p.glory, coreId: p.coreId, shieldUntil: p.shieldUntil, queue: p.queue, lastSeen: p.lastSeen,
        createdAt: p.createdAt, playSeconds: p.playSeconds || 0, techs: p.techs, clan: p.clan,
      })),
      clans: [...this.clans.values()].map((c) => ({ tag: c.tag, leader: c.leader, members: [...c.members] })),
      buildings: [...this.buildings.values()].map((b) => ({
        id: b.id, owner: b.owner, kind: b.kind, x: b.x, y: b.y, hp: b.hp,
        level: b.level, holder: b.holder, campKind: b.campKind,
      })),
      units: [...this.units.values()].map((u) => ({
        id: u.id, owner: u.owner, kind: u.kind, x: u.x, y: u.y, hp: u.hp, campId: u.campId,
      })),
    };
  }

  /** Rebuild a world from `toJSON()` output (v1 or v2). Everyone starts offline, all units idle. */
  static fromJSON(data, opts = {}) {
    const w = new World({ ...opts, seed: data.seed, size: data.size });
    for (const [i, code] of data.tileEdits || []) { w.tiles[i] = code; w.tileEdits.set(i, code); }
    w.nextPlayerId = data.nextPlayerId;
    w.nextId = data.nextId;
    for (const s of data.players || []) w.players.set(s.id, w.makePlayer(s));
    for (const c of data.clans || []) {
      const members = new Set(c.members.filter((id) => w.players.get(id)?.clan === c.tag));
      if (members.size) w.clans.set(c.tag, { tag: c.tag, leader: members.has(c.leader) ? c.leader : [...members][0], members });
    }
    for (const p of w.players.values()) if (p.clan && !w.clans.has(p.clan)) p.clan = null;
    for (const s of data.buildings || []) {
      const def = w.config.buildings[s.kind];
      const p = w.players.get(s.owner);
      if (!def || !w.inBounds(s.x, s.y) || (!p && s.owner !== NEUTRAL)) continue;
      const i = w.idx(s.x, s.y);
      if (w.occ[i] !== 0) continue;
      const b = { id: s.id, owner: s.owner, kind: s.kind, x: s.x, y: s.y, hp: s.hp, cd: 0, readyAt: 0 };
      if (s.kind === 'core') b.level = s.level || 1;
      if (s.kind === 'shrine') { b.holder = w.players.has(s.holder) ? s.holder : 0; b.progress = 0; b.capturer = 0; w.shrineId = b.id; }
      if (def.camp) b.campKind = s.campKind || def.camp;
      const y2 = w.yieldAt(s.kind, s.x, s.y);
      if (y2) b.yield = y2;
      w.buildings.set(b.id, b);
      w.occ[i] = b.id;
      if (p) p.counts[b.kind]++;
    }
    for (const s of data.units || []) {
      const def = w.config.units[s.kind];
      if (!def || (!w.players.has(s.owner) && s.owner !== NEUTRAL)) continue;
      w.units.set(s.id, {
        id: s.id, owner: s.owner, kind: s.kind, x: s.x, y: s.y, hp: s.hp, cd: 0, campId: s.campId,
        order: null, engage: 0, anchorX: s.x, anchorY: s.y, returning: false,
      });
    }
    for (const p of w.players.values()) if (p.coreId && !w.buildings.has(p.coreId)) p.coreId = 0;
    w.claimsVersion++;
    w.ensureShrine();
    w.resetEvents();
    return w;
  }
}
