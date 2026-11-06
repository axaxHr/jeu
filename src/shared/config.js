/**
 * BASTIONS gameplay data, shared by the server (authority) and the client
 * (display and pre-validation only). All gameplay numbers live here, never in logic files.
 *
 * Units: distances in tiles, time in seconds, money in gold.
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

export const CONFIG = Object.freeze({
  /** Server simulation rate. The client interpolates between ticks. */
  tickRate: 10,

  map: {
    /** Default map size; the server can override it with MAP_SIZE. */
    size: 96,
    /** Noise thresholds for terrain generation (src/shared/mapgen.js). */
    waterBelow: 0.3,
    rockAbove: 0.74,
    forestMoistureAbove: 0.64,
    /** Gold vein clusters per 1000 tiles, and tiles per cluster. */
    goldClustersPer1000: 2.2,
    goldClusterMin: 2,
    goldClusterMax: 5,
  },

  spawn: {
    /** Minimum distance between two cores when the map allows it. */
    minCoreDistance: 22,
    /** Keep cores this far from the map edge. */
    edgeMargin: 7,
    /** Candidate positions tried per spawn. */
    candidates: 240,
    /** Gold tiles guaranteed inside a new territory. */
    guaranteedGold: 4,
    startGold: 220,
    /** Spawn protection, seconds. Lost early if the player orders an attack. */
    shieldSeconds: 180,
  },

  economy: {
    /** Gold is credited once per second. */
    goldCap: 6000,
    demolishRefund: 0.5,
    /** Share of the victim's gold taken when their core falls. */
    coreLootShare: 0.3,
    /** Share of a destroyed building's cost paid to the attacker. */
    buildingLootShare: 0.25,
  },

  territory: {
    /** Build radius around the player's core (Euclidean, tiles). */
    radius: 9,
  },

  limits: {
    buildingsPerPlayer: 140,
    /** Caps turtling: 12 towers stay below what a full army can break. */
    towersPerPlayer: 12,
    unitsHardCap: 40,
    trainQueue: 10,
  },

  /** Buildings. `income` is gold per second. All buildings are 1×1 tiles. */
  buildings: {
    core: { name: 'Noyau', cost: 0, hp: 2000, income: 3, buildable: false },
    wall: { name: 'Mur', cost: 8, hp: 250, buildable: true },
    tower: {
      name: 'Tour', cost: 70, hp: 350, buildable: true,
      range: 5, damage: 18, cooldown: 0.9,
    },
    mine: { name: 'Mine', cost: 60, hp: 220, income: 2, buildable: true, needsGold: true },
    barracks: {
      name: 'Caserne', cost: 90, hp: 450, buildable: true,
      unitCap: 6, trainSeconds: 2.5,
    },
  },

  /** Units. `range` is measured from the unit centre to the target's edge. */
  units: {
    warrior: {
      name: 'Guerrier', cost: 25, hp: 120, damage: 14, cooldown: 0.9,
      range: 0.55, speed: 2.4,
    },
    /** Archers outrange towers (5.5 > 5): the attacker's answer to a tower line. */
    archer: {
      name: 'Archer', cost: 30, hp: 70, damage: 12, cooldown: 1.1,
      range: 5.5, speed: 2.2,
    },
  },

  combat: {
    /** Idle and marching units engage enemy units this close. */
    aggroRadius: 5,
    /** Idle defenders give up a chase this far from where they stood. */
    leashRadius: 10,
    /** Extra path cost for stepping through an enemy building (it must be destroyed). */
    breakCost: 6,
    /** Glory rewards. Building glory = cost × buildingGloryPerGold. */
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

  /** Seconds after an attack during which the defender is warned again. */
  alertCooldown: 15,
});

/** Numeric ids used on the wire, so snapshots stay small. */
export const BUILDING_KINDS = Object.freeze(['core', 'wall', 'tower', 'mine', 'barracks']);
export const UNIT_KINDS = Object.freeze(['warrior', 'archer']);

/** Twelve player colours, distinct on the parchment terrain. */
export const PLAYER_COLORS = Object.freeze([
  '#c0392b', '#2e6fb7', '#d68910', '#7d3c98', '#1e8449', '#c2185b',
  '#00838f', '#6d4c41', '#3949ab', '#827717', '#e64a19', '#455a64',
]);
