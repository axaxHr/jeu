/**
 * BASTIONS gameplay data, shared by the server (authority) and the client
 * (display and pre-validation only). All gameplay numbers live here, never in logic files.
 *
 * Units: distances in tiles, time in seconds, resources in gold / wood / stone.
 * Costs and incomes are objects such as { gold: 40, stone: 40 }; a missing key is 0.
 * Rationale for the balance anchors: design/game-brief.md § Tuning & rationale.
 */

/** Terrain tile codes stored in the map grid. */
export const TILE = Object.freeze({
  GRASS: 0,
  WATER: 1,
  ROCK: 2,
  FOREST: 3,
  GOLD: 4,
});

/** Tiles a unit can walk on (when no building stands there). */
export const WALKABLE = Object.freeze([true, false, false, false, true]);

/** The three resources, in display order. */
export const RESOURCES = Object.freeze(['gold', 'wood', 'stone']);

/** Owner id of monsters, camps and the Sanctuary. */
export const NEUTRAL = 0;

export const CONFIG = Object.freeze({
  /** Server simulation rate. The client interpolates between ticks. */
  tickRate: 10,

  map: {
    /** Default map size; the server can override it with MAP_SIZE. */
    size: 160,
    /** Noise thresholds for terrain generation (src/shared/mapgen.js). */
    waterBelow: 0.3,
    rockAbove: 0.74,
    forestMoistureAbove: 0.64,
    /** Gold vein clusters per 1000 tiles, and tiles per cluster. */
    goldClustersPer1000: 1.6,
    goldClusterMin: 2,
    goldClusterMax: 5,
    /** Half-size of the open clearing around the central Sanctuary. */
    shrineClearing: 4,
  },

  spawn: {
    /** Minimum distance between two keeps when the map allows it. */
    minCoreDistance: 34,
    /** Keep keeps this far from the map edge. */
    edgeMargin: 10,
    /** And this far from the central Sanctuary. */
    shrineDistance: 24,
    /** Candidate positions tried per spawn. */
    candidates: 320,
    /** Resource tiles guaranteed inside a new territory. */
    guaranteed: { gold: 4, forest: 8, rock: 6 },
    start: { gold: 250, wood: 150, stone: 100 },
    /** Spawn protection, seconds. Lost early if the player orders an attack. */
    shieldSeconds: 180,
  },

  economy: {
    /** Each resource is capped at this amount. */
    cap: 9000,
    demolishRefund: 0.5,
    /** Share of the victim's stock taken when their keep falls. */
    coreLootShare: 0.3,
    /** Share of a destroyed building's cost paid to the attacker. */
    buildingLootShare: 0.25,
  },

  /**
   * The keep (core). Its level sets the territory radius, keep HP, passive
   * income, army size and which buildings and units are unlocked.
   */
  keep: {
    levels: [
      { hp: 2000, radius: 9, income: { gold: 3, wood: 1, stone: 1 }, unitCap: 40, towers: 8, outposts: 1 },
      { hp: 3000, radius: 12, income: { gold: 5, wood: 2, stone: 2 }, unitCap: 55, towers: 12, outposts: 2,
        cost: { gold: 350, wood: 250, stone: 250 } },
      { hp: 4200, radius: 15, income: { gold: 7, wood: 3, stone: 3 }, unitCap: 70, towers: 16, outposts: 3,
        cost: { gold: 800, wood: 500, stone: 600 } },
    ],
  },

  territory: {
    /** Radius claimed by an outpost. */
    outpostRadius: 6,
  },

  limits: {
    buildingsPerPlayer: 220,
    trainQueue: 12,
  },

  /**
   * Buildings. All occupy one tile. `minLevel` is the keep level that unlocks
   * them; `trains` lists the units they recruit; `popCap` adds army room.
   * `near` + `perTile` + `maxIncome`: income per adjacent tile of that terrain.
   */
  buildings: {
    core: { name: 'Donjon', cost: {}, hp: 2000, buildable: false },
    wall: { name: 'Mur', cost: { stone: 5 }, hp: 250, buildable: true },
    gate: { name: 'Porte', cost: { wood: 15, stone: 10 }, hp: 400, buildable: true, gate: true },
    tower: {
      name: 'Tour', cost: { gold: 40, stone: 40 }, hp: 350, buildable: true,
      range: 5, damage: 18, cooldown: 0.9,
    },
    mine: { name: 'Mine', cost: { gold: 40, wood: 30 }, hp: 220, buildable: true, needsGold: true, income: { gold: 2 } },
    sawmill: {
      name: 'Scierie', cost: { gold: 40 }, hp: 200, buildable: true,
      near: 'forest', perTile: { wood: 0.4 }, maxIncome: 2.8,
    },
    quarry: {
      name: 'Carrière', cost: { gold: 40, wood: 30 }, hp: 260, buildable: true,
      near: 'rock', perTile: { stone: 0.35 }, maxIncome: 2.4,
    },
    barracks: {
      name: 'Caserne', cost: { gold: 60, wood: 50 }, hp: 450, buildable: true,
      popCap: 8, trains: ['warrior', 'archer', 'healer'], trainSeconds: 2.5,
    },
    stable: {
      name: 'Écurie', cost: { gold: 90, wood: 80 }, hp: 450, buildable: true, minLevel: 2,
      popCap: 8, trains: ['cavalry'], trainSeconds: 3.5,
    },
    workshop: {
      name: 'Atelier', cost: { gold: 120, wood: 120, stone: 60 }, hp: 500, buildable: true, minLevel: 3,
      popCap: 9, trains: ['catapult'], trainSeconds: 6,
    },
    forge: { name: 'Forge', cost: { gold: 120, stone: 80 }, hp: 500, buildable: true, minLevel: 2, max: 1 },
    outpost: { name: 'Avant-poste', cost: { gold: 150, wood: 100, stone: 80 }, hp: 600, buildable: true },
    shrine: { name: 'Sanctuaire', cost: {}, hp: 1, buildable: false, invulnerable: true },
    camp_barbarian: { name: 'Camp barbare', cost: {}, hp: 400, buildable: false, camp: 'barbarian' },
    camp_wolves: { name: 'Tanière de loups', cost: {}, hp: 250, buildable: false, camp: 'wolves' },
    camp_ogre: { name: "Antre de l'ogre", cost: {}, hp: 800, buildable: false, camp: 'ogre' },
  },

  /**
   * Units. `range` is measured from the unit centre to the target's edge.
   * `bonus` multiplies damage against the listed unit kinds. `pop` is army room used.
   */
  units: {
    warrior: {
      name: 'Guerrier', cost: { gold: 25 }, hp: 120, damage: 14, cooldown: 0.9,
      range: 0.55, speed: 2.4, pop: 1, bonus: { cavalry: 1.5 },
    },
    /** Archers outrange towers (5.5 > 5): the attacker's answer to a tower line. */
    archer: {
      name: 'Archer', cost: { gold: 20, wood: 15 }, hp: 70, damage: 12, cooldown: 1.1,
      range: 5.5, speed: 2.2, pop: 1, bonus: { warrior: 1.25 },
    },
    healer: {
      name: 'Soigneur', cost: { gold: 40, wood: 10 }, hp: 60, heal: 9, cooldown: 1.2,
      range: 4, speed: 2.3, pop: 1, minLevel: 2, healer: true,
    },
    cavalry: {
      name: 'Cavalier', cost: { gold: 60, wood: 20 }, hp: 170, damage: 16, cooldown: 1.0,
      range: 0.6, speed: 3.6, pop: 2, bonus: { archer: 2, catapult: 2, healer: 2 },
    },
    /** Siege: hits buildings only, from beyond tower range. */
    catapult: {
      name: 'Catapulte', cost: { gold: 80, wood: 80, stone: 40 }, hp: 150, damage: 70, cooldown: 3.2,
      range: 7, speed: 1.2, pop: 3, siege: true,
    },
    // Monsters (never trained by players).
    barbarian: { name: 'Barbare', cost: {}, hp: 110, damage: 12, cooldown: 1.0, range: 0.55, speed: 2.2, pop: 0, neutral: true },
    wolf: { name: 'Loup', cost: {}, hp: 60, damage: 8, cooldown: 0.7, range: 0.5, speed: 3.4, pop: 0, neutral: true },
    ogre: { name: 'Ogre', cost: {}, hp: 700, damage: 38, cooldown: 1.6, range: 0.7, speed: 1.8, pop: 0, neutral: true },
  },

  /** Monster camps spread over the map: destroy the camp to take its treasure. */
  camps: {
    per1000Tiles: 1.1,
    minDistanceFromKeeps: 16,
    minDistanceBetween: 11,
    respawnSeconds: 240,
    aggroRadius: 5,
    leashRadius: 7,
    kinds: {
      barbarian: { building: 'camp_barbarian', guards: [['barbarian', 5]], loot: { gold: 250, wood: 120, stone: 60 }, glory: 12, weight: 3 },
      wolves: { building: 'camp_wolves', guards: [['wolf', 6]], loot: { gold: 120, wood: 60, stone: 40 }, glory: 8, weight: 3 },
      ogre: { building: 'camp_ogre', guards: [['ogre', 1], ['barbarian', 2]], loot: { gold: 500, wood: 250, stone: 250 }, glory: 25, weight: 1 },
    },
  },

  /** The central Sanctuary: stand alone near it to capture it; the holder earns income and glory. */
  shrine: {
    radius: 3,
    captureSeconds: 12,
    income: { gold: 4, wood: 2, stone: 2 },
    gloryEverySeconds: 10,
  },

  /** Forge research, applied to every unit of the player. */
  techs: {
    attack: { name: 'Lames affûtées', perLevel: 0.2, costs: [{ gold: 200, stone: 100 }, { gold: 450, stone: 250 }] },
    armor: { name: 'Armures', perLevel: 0.15, costs: [{ gold: 200, stone: 120 }, { gold: 450, stone: 300 }] },
  },

  clans: { maxMembers: 5, inviteSeconds: 300 },

  combat: {
    /** Idle and marching units engage enemy units this close. */
    aggroRadius: 5,
    /** Idle defenders give up a chase this far from where they stood. */
    leashRadius: 10,
    /** Extra path cost for stepping through an enemy building (it must be destroyed). */
    breakCost: 6,
    /** Glory rewards. Building glory = gold-equivalent cost × buildingGloryPerGold. */
    gloryPerUnitKill: 2,
    buildingGloryPerGold: 0.1,
    gloryPerCore: 100,
    /**
     * Core glory is scaled by (victim.glory + 100) / (attacker.glory + 100),
     * clamped to [coreGloryMin, coreGloryMax]: bullying the weakest pays less.
     */
    coreGloryMin: 0.25,
    coreGloryMax: 1.5,
    /** Offline protection starts this many seconds after a disconnect (no combat-logging). */
    offlineShieldDelay: 120,
  },

  /** Units farther than this (tiles, square radius) from a player's camera are not sent to them. */
  viewRadius: 30,

  /** Seconds after an attack during which the defender is warned again. */
  alertCooldown: 15,
});

/** Numeric ids used on the wire, so snapshots stay small. Append only: indexes are protocol. */
export const BUILDING_KINDS = Object.freeze([
  'core', 'wall', 'tower', 'mine', 'barracks',
  'gate', 'sawmill', 'quarry', 'stable', 'workshop', 'forge', 'outpost',
  'shrine', 'camp_barbarian', 'camp_wolves', 'camp_ogre',
]);
export const UNIT_KINDS = Object.freeze(['warrior', 'archer', 'healer', 'cavalry', 'catapult', 'barbarian', 'wolf', 'ogre']);

/** Player-buildable kinds in action-bar order. */
export const BUILD_MENU = Object.freeze(['wall', 'gate', 'tower', 'mine', 'sawmill', 'quarry', 'barracks', 'stable', 'workshop', 'forge', 'outpost']);
/** Player-trainable kinds in action-bar order. */
export const TRAIN_MENU = Object.freeze(['warrior', 'archer', 'healer', 'cavalry', 'catapult']);

/** Twelve player colours, distinct on the terrain. */
export const PLAYER_COLORS = Object.freeze([
  '#c0392b', '#2e6fb7', '#d68910', '#7d3c98', '#1e8449', '#c2185b',
  '#00838f', '#6d4c41', '#3949ab', '#827717', '#e64a19', '#455a64',
]);

/** Colour used for monsters and neutral buildings. */
export const NEUTRAL_COLOR = '#8a6d4b';

// ------------------------------------------------------------------ helpers shared by server and client

/** Keep level definition (1-based level). */
export function keepLevel(level) {
  return CONFIG.keep.levels[Math.max(1, Math.min(CONFIG.keep.levels.length, level)) - 1];
}

/** Can `stock` pay `cost`? */
export function canAfford(stock, cost) {
  return RESOURCES.every((r) => (stock[r] || 0) >= (cost[r] || 0));
}

/** Short French label for a cost, e.g. "40 or, 40 pierre". */
export function costLabel(cost) {
  const names = { gold: 'or', wood: 'bois', stone: 'pierre' };
  const parts = RESOURCES.filter((r) => cost[r]).map((r) => `${cost[r]} ${names[r]}`);
  return parts.length ? parts.join(', ') : 'gratuit';
}

/** Gold-equivalent value of a cost (for glory and loot on destruction). */
export function costValue(cost) {
  return (cost.gold || 0) + (cost.wood || 0) * 0.8 + (cost.stone || 0) * 0.8;
}
