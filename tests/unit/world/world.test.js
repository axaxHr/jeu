import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../../src/server/world.js';
import { CONFIG, TILE } from '../../../src/shared/config.js';
import { makeFlatWorld, addPlayerAt, runFor, spawnUnitAt, makeClock } from '../../helpers/world-factory.js';

const B = CONFIG.buildings;
const U = CONFIG.units;

test('world_new_player_gets_core_gold_shield_and_gold_veins', () => {
  const clock = makeClock();
  let s = 7;
  const world = new World({ seed: 1234, size: 96, now: clock.now, random: () => ((s = (s * 16807) % 2147483647) / 2147483647) });
  const res = world.addPlayer({ name: 'Ana', tokenHash: 'h' });
  assert.ok(res.ok, res.reason);
  const p = res.player;
  const core = world.coreOf(p);
  assert.ok(core && core.kind === 'core');
  assert.equal(p.gold, CONFIG.spawn.startGold);
  assert.equal(world.shieldLeft(p), CONFIG.spawn.shieldSeconds);
  const r = CONFIG.territory.radius;
  let gold = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r || !world.inBounds(core.x + dx, core.y + dy)) continue;
      if (world.tiles[world.idx(core.x + dx, core.y + dy)] === TILE.GOLD) gold++;
    }
  }
  assert.ok(gold >= CONFIG.spawn.guaranteedGold, `found ${gold} gold tiles`);
});

test('world_spawns_keep_cores_apart', () => {
  const clock = makeClock();
  let s = 1;
  const world = new World({ seed: 99, size: 96, now: clock.now, random: () => ((s = (s * 16807) % 2147483647) / 2147483647) });
  const cores = [];
  for (let i = 0; i < 6; i++) {
    const res = world.addPlayer({ name: `P${i}`, tokenHash: `h${i}` });
    assert.ok(res.ok, res.reason);
    cores.push(world.coreOf(res.player));
  }
  for (let i = 0; i < cores.length; i++) {
    for (let j = i + 1; j < cores.length; j++) {
      const d = Math.hypot(cores[i].x - cores[j].x, cores[i].y - cores[j].y);
      assert.ok(d >= CONFIG.spawn.minCoreDistance * 0.55, `cores ${i},${j} at ${d.toFixed(1)}`);
    }
  }
});

test('world_build_spends_gold_and_respects_rules', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 20, { gold: 100 });
  assert.ok(world.build(p.id, 'wall', 21, 20).ok);
  assert.equal(p.gold, 100 - B.wall.cost);

  assert.equal(world.build(p.id, 'wall', 21, 20).ok, false, 'occupied');
  assert.equal(world.build(p.id, 'wall', 20 + CONFIG.territory.radius + 1, 20).ok, false, 'outside territory');
  assert.equal(world.build(p.id, 'core', 22, 20).ok, false, 'core not buildable');

  world.tiles[world.idx(23, 20)] = TILE.GOLD;
  assert.equal(world.build(p.id, 'wall', 23, 20).ok, false, 'gold reserved for mines');
  assert.equal(world.build(p.id, 'mine', 24, 20).ok, false, 'mine needs gold');
  world.tiles[world.idx(25, 20)] = TILE.WATER;
  assert.equal(world.build(p.id, 'wall', 25, 20).ok, false, 'water');

  p.gold = B.tower.cost - 1;
  const res = world.build(p.id, 'tower', 20, 22);
  assert.equal(res.ok, false);
  assert.match(res.reason, /or/);
});

test('world_income_is_core_plus_mines_per_second', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 20, { gold: 1000 });
  world.tiles[world.idx(22, 20)] = TILE.GOLD;
  world.tiles[world.idx(23, 20)] = TILE.GOLD;
  assert.ok(world.build(p.id, 'mine', 22, 20).ok);
  assert.ok(world.build(p.id, 'mine', 23, 20).ok);
  const start = p.gold;
  runFor(world, clock, 10);
  assert.equal(p.gold - start, 10 * (B.core.income + 2 * B.mine.income));
});

test('world_demolish_refunds_half_and_protects_core', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 20, { gold: 1000 });
  const t = world.build(p.id, 'tower', 21, 21).building;
  const before = p.gold;
  assert.ok(world.demolish(p.id, t.id).ok);
  assert.equal(p.gold - before, Math.floor(B.tower.cost * CONFIG.economy.demolishRefund));
  assert.equal(world.demolish(p.id, p.coreId).ok, false);
});

test('world_training_needs_barracks_respects_cap_and_spawns_units', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 20, { gold: 2000 });
  assert.equal(world.train(p.id, 'warrior').ok, false, 'no barracks yet');
  assert.ok(world.build(p.id, 'barracks', 22, 20).ok);
  for (let i = 0; i < B.barracks.unitCap; i++) assert.ok(world.train(p.id, 'warrior').ok);
  const over = world.train(p.id, 'archer');
  assert.equal(over.ok, false, 'cap reached');
  assert.match(over.reason, /Population/);
  runFor(world, clock, B.barracks.trainSeconds * B.barracks.unitCap + 1);
  assert.equal(world.unitCount(p), B.barracks.unitCap);
  assert.equal(p.queue.length, 0);
});

test('world_cannot_attack_a_shielded_player_and_attacking_drops_own_shield', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10, { keepShield: true });
  const b = addPlayerAt(world, clock, 'Bob', 34, 34, { keepShield: true });
  const u = spawnUnitAt(world, a, 'warrior', 11.5, 10.5);
  const blocked = world.command(a.id, [u.id], { type: 'attack', bid: b.coreId });
  assert.equal(blocked.ok, false);
  b.shieldUntil = 0;
  assert.ok(world.isShielded(a));
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok);
  assert.equal(world.isShielded(a), false, 'attacker lost spawn shield');
});

test('world_offline_shield_starts_after_the_grace_delay', () => {
  const { world, clock } = makeFlatWorld({ offlineShield: true });
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 34, 34);
  world.setOnline(b.id, false);
  const u = spawnUnitAt(world, a, 'warrior', 11.5, 10.5);
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, 'closing the tab does not end a raid');
  clock.advance(CONFIG.combat.offlineShieldDelay + 1);
  assert.equal(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, false, 'protected after the delay');
});

test('world_offline_shield_can_be_disabled_by_the_host', () => {
  const { world, clock } = makeFlatWorld({ offlineShield: false });
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 34, 34);
  world.setOnline(b.id, false);
  clock.advance(3600);
  const u = spawnUnitAt(world, a, 'warrior', 11.5, 10.5);
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok);
});

test('world_tower_count_is_capped_per_player', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 20, { gold: 5000 });
  const spots = [];
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx || dy) spots.push([20 + dx, 20 + dy]);
  let built = 0;
  for (const [x, y] of spots) if (world.build(p.id, 'tower', x, y).ok) built++;
  assert.equal(built, CONFIG.limits.towersPerPlayer);
});

test('world_core_glory_is_scaled_by_relative_glory', () => {
  const c = CONFIG.combat;
  assert.equal(World.coreGlory(c, 0, 0), c.gloryPerCore, 'equals pay the base');
  assert.equal(World.coreGlory(c, 900, 0), Math.round(c.gloryPerCore * c.coreGloryMin), 'bully gets the floor');
  assert.equal(World.coreGlory(c, 0, 900), Math.round(c.gloryPerCore * c.coreGloryMax), 'underdog gets the ceiling');
});

test('world_warriors_break_an_enemy_wall_in_the_expected_time', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 30, 10);
  const wall = world.build(b.id, 'wall', 27, 10).building;
  const units = [];
  for (let i = 0; i < 4; i++) units.push(spawnUnitAt(world, a, 'warrior', 25.5, 9.6 + i * 0.3));
  assert.ok(world.command(a.id, units.map((u) => u.id), { type: 'attack', bid: wall.id }).ok);
  const dps = 4 * U.warrior.damage / U.warrior.cooldown;
  runFor(world, clock, B.wall.hp / dps + 3);
  assert.equal(world.buildings.has(wall.id), false, 'wall destroyed');
  assert.ok(a.glory > 0, 'glory awarded');
});

test('world_tower_kills_a_lone_warrior', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 30, 10);
  world.build(b.id, 'tower', 27, 10);
  const u = spawnUnitAt(world, a, 'warrior', 24.5, 10.5);
  const shots = Math.ceil(U.warrior.hp / B.tower.damage);
  runFor(world, clock, shots * B.tower.cooldown + 0.5);
  assert.equal(world.units.has(u.id), false);
});

test('world_army_breaks_into_a_walled_core_and_eliminates_the_owner', () => {
  const { world, clock } = makeFlatWorld({ size: 56 });
  const a = addPlayerAt(world, clock, 'Ana', 8, 28);
  const b = addPlayerAt(world, clock, 'Bob', 40, 28, { gold: 900 });
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) assert.ok(world.build(b.id, 'wall', 40 + dx, 28 + dy).ok);
    }
  }
  const oldCore = b.coreId;
  const army = [];
  for (let i = 0; i < 12; i++) army.push(spawnUnitAt(world, a, 'warrior', 30.5, 26 + i * 0.4));
  assert.ok(world.command(a.id, army.map((u) => u.id), { type: 'attack', bid: oldCore }).ok);
  const goldBefore = a.gold;
  runFor(world, clock, 60);
  assert.equal(world.buildings.has(oldCore), false, 'core destroyed');
  assert.ok(b.coreId && b.coreId !== oldCore, 'victim respawned with a new core');
  assert.ok(world.isShielded(b), 'victim has a fresh shield');
  assert.ok(a.gold > goldBefore, 'attacker looted gold');
  assert.ok(a.glory >= CONFIG.combat.gloryPerCore);
  const leftovers = [...world.buildings.values()].filter((x) => x.owner === b.id);
  assert.equal(leftovers.length, 1, 'only the new core remains');
});

test('world_idle_defenders_engage_nearby_attackers', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 30, 10);
  const attacker = spawnUnitAt(world, a, 'archer', 26.5, 10.5);
  const defenders = [0, 1, 2].map((i) => spawnUnitAt(world, b, 'warrior', 29.5, 9.5 + i));
  runFor(world, clock, 12);
  assert.equal(world.units.has(attacker.id), false, 'attacker killed by defenders');
  assert.ok(defenders.some((d) => world.units.has(d.id)));
});

test('world_move_order_reaches_destination_around_obstacles', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  for (let y = 0; y < 30; y++) world.tiles[world.idx(20, y)] = TILE.ROCK;
  const u = spawnUnitAt(world, a, 'warrior', 14.5, 10.5);
  assert.ok(world.command(a.id, [u.id], { type: 'move', x: 26, y: 10 }).ok);
  runFor(world, clock, 30);
  assert.equal(Math.floor(u.x), 26);
  assert.equal(Math.floor(u.y), 10);
  assert.equal(u.order, null, 'unit is idle on arrival');
});

test('world_units_never_stand_inside_solid_tiles', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 30, 10);
  for (let dy = -2; dy <= 2; dy++) world.build(b.id, 'wall', 26, 10 + dy);
  const army = [];
  for (let i = 0; i < 8; i++) army.push(spawnUnitAt(world, a, i % 2 ? 'archer' : 'warrior', 20.5, 8 + i * 0.5));
  world.command(a.id, army.map((u) => u.id), { type: 'attack', bid: b.coreId });
  for (let s = 0; s < 300; s++) {
    runFor(world, clock, 0.1);
    for (const u of world.units.values()) {
      assert.equal(world.solid(world.tileOf(u)), false, `unit ${u.id} inside a solid tile at ${u.x},${u.y}`);
    }
  }
});

test('world_persistence_round_trip_keeps_players_buildings_and_edits', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 10, { gold: 777 });
  world.build(a.id, 'tower', 11, 11);
  world.setTile(world.idx(5, 5), TILE.GOLD);
  spawnUnitAt(world, a, 'archer', 12.5, 12.5);
  const json = JSON.parse(JSON.stringify(world.toJSON()));
  const copy = World.fromJSON(json, { now: clock.now });
  const p = copy.players.get(a.id);
  assert.equal(p.name, 'Ana');
  assert.equal(p.online, false);
  assert.equal(p.counts.tower, 1);
  assert.equal(copy.buildings.size, world.buildings.size);
  assert.equal(copy.units.size, 1);
  assert.equal(copy.tiles[copy.idx(5, 5)], TILE.GOLD);
  assert.equal(copy.occ[copy.idx(11, 11)] !== 0, true);
});
