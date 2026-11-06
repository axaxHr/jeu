import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../../src/server/world.js';
import { CONFIG, TILE, keepLevel } from '../../../src/shared/config.js';
import { mulberry32 } from '../../../src/shared/mapgen.js';
import { makeFlatWorld, addPlayerAt, runFor, spawnUnitAt, makeClock, paint } from '../../helpers/world-factory.js';

const B = CONFIG.buildings;
const U = CONFIG.units;

function countAroundCore(world, core, code, r) {
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r || !world.inBounds(core.x + dx, core.y + dy)) continue;
      if (world.tiles[world.idx(core.x + dx, core.y + dy)] === code) n++;
    }
  }
  return n;
}

test('world_new_player_gets_keep_resources_shield_and_nearby_deposits', () => {
  const clock = makeClock();
  const world = new World({ seed: 1234, size: 160, now: clock.now, random: mulberry32(7) });
  const res = world.addPlayer({ name: 'Ana', tokenHash: 'h' });
  assert.ok(res.ok, res.reason);
  const p = res.player;
  const core = world.coreOf(p);
  assert.equal(core.kind, 'core');
  assert.equal(core.level, 1);
  assert.deepEqual([p.gold, p.wood, p.stone], [CONFIG.spawn.start.gold, CONFIG.spawn.start.wood, CONFIG.spawn.start.stone]);
  assert.equal(world.shieldLeft(p), CONFIG.spawn.shieldSeconds);
  const r = keepLevel(1).radius;
  const g = CONFIG.spawn.guaranteed;
  assert.ok(countAroundCore(world, core, TILE.GOLD, r) >= g.gold, 'gold veins');
  assert.ok(countAroundCore(world, core, TILE.FOREST, r) >= g.forest, 'forest');
  assert.ok(countAroundCore(world, core, TILE.ROCK, r) >= g.rock, 'rock');
});

test('world_spawns_keep_keeps_apart_and_away_from_the_sanctuary', () => {
  const clock = makeClock();
  const world = new World({ seed: 99, size: 160, now: clock.now, random: mulberry32(3) });
  world.seedNeutrals();
  const keeps = [];
  for (let i = 0; i < 8; i++) {
    const res = world.addPlayer({ name: `P${i}`, tokenHash: `h${i}` });
    assert.ok(res.ok, res.reason);
    keeps.push(world.coreOf(res.player));
  }
  const s = world.shrineInfo();
  for (let i = 0; i < keeps.length; i++) {
    assert.ok(Math.hypot(keeps[i].x - s.x, keeps[i].y - s.y) >= CONFIG.spawn.shrineDistance * 0.55);
    for (let j = i + 1; j < keeps.length; j++) {
      const d = Math.hypot(keeps[i].x - keeps[j].x, keeps[i].y - keeps[j].y);
      assert.ok(d >= CONFIG.spawn.minCoreDistance * 0.55, `keeps ${i},${j} at ${d.toFixed(1)}`);
    }
  }
});

test('world_build_spends_resources_and_respects_rules', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30, { res: { gold: 100, wood: 100, stone: 20 } });
  assert.ok(world.build(p.id, 'wall', 31, 30).ok);
  assert.equal(p.stone, 20 - B.wall.cost.stone);
  assert.equal(world.build(p.id, 'wall', 31, 30).ok, false, 'occupied');
  assert.equal(world.build(p.id, 'wall', 30 + keepLevel(1).radius + 1, 30).ok, false, 'outside territory');
  assert.equal(world.build(p.id, 'core', 32, 30).ok, false, 'keep not buildable');
  world.tiles[world.idx(33, 30)] = TILE.GOLD;
  assert.equal(world.build(p.id, 'wall', 33, 30).ok, false, 'gold reserved for mines');
  assert.equal(world.build(p.id, 'mine', 34, 30).ok, false, 'mine needs gold');
  world.tiles[world.idx(35, 30)] = TILE.WATER;
  assert.equal(world.build(p.id, 'wall', 35, 30).ok, false, 'water');
  const tower = world.build(p.id, 'tower', 30, 32);
  assert.equal(tower.ok, false, 'tower needs 40 stone');
  assert.match(tower.reason, /Ressources/);
  assert.equal(world.build(p.id, 'stable', 30, 33).ok, false, 'stable locked at keep level 1');
});

test('world_income_comes_from_keep_mines_sawmills_and_quarries', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  paint(world, TILE.GOLD, 32, 30, 2, 1);
  paint(world, TILE.FOREST, 25, 25, 3, 3);
  paint(world, TILE.ROCK, 35, 35, 2, 2);
  assert.ok(world.build(p.id, 'mine', 32, 30).ok);
  assert.ok(world.build(p.id, 'mine', 33, 30).ok);
  assert.ok(world.build(p.id, 'sawmill', 28, 26).ok, 'touches 3 forest tiles');
  assert.ok(world.build(p.id, 'quarry', 34, 34).ok, 'touches 1 rock tile');
  assert.equal(world.build(p.id, 'sawmill', 30, 34).ok, false, 'sawmill needs forest');
  const inc = world.income(p);
  const base = keepLevel(1).income;
  assert.equal(inc.gold, base.gold + 2 * B.mine.income.gold);
  assert.ok(Math.abs(inc.wood - (base.wood + 3 * B.sawmill.perTile.wood)) < 1e-9);
  assert.ok(Math.abs(inc.stone - (base.stone + 1 * B.quarry.perTile.stone)) < 1e-9);
  const before = { ...p };
  runFor(world, clock, 10);
  assert.ok(Math.abs(p.gold - before.gold - 10 * inc.gold) < 1e-6);
  assert.ok(Math.abs(p.wood - before.wood - 10 * inc.wood) < 1e-6);
});

test('world_keep_upgrade_grows_territory_and_unlocks_buildings', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  const far = 30 + keepLevel(1).radius + 2;
  assert.equal(world.build(p.id, 'wall', far, 30).ok, false);
  assert.equal(world.upgradeCore(p.id).ok, true);
  const core = world.coreOf(p);
  assert.equal(core.level, 2);
  assert.equal(core.hp, keepLevel(2).hp);
  assert.ok(world.build(p.id, 'wall', far, 30).ok, 'territory grew');
  assert.ok(world.build(p.id, 'stable', 30, 33).ok, 'stable unlocked');
  assert.equal(world.build(p.id, 'workshop', 30, 34).ok, false, 'workshop needs level 3');
  p.gold = 0;
  assert.equal(world.upgradeCore(p.id).ok, false, 'not enough gold');
});

test('world_outposts_extend_territory_and_are_limited_by_keep_level', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 20, 30);
  assert.ok(world.build(p.id, 'outpost', 28, 30).ok);
  assert.ok(world.build(p.id, 'wall', 33, 30).ok, 'outpost claim reaches further');
  assert.equal(world.build(p.id, 'outpost', 20, 37).ok, false, 'one outpost at level 1');
});

test('world_cannot_build_inside_another_players_territory', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 20, 30);
  addPlayerAt(world, clock, 'Bob', 34, 30);
  assert.equal(world.build(a.id, 'wall', 28, 30).ok, false, 'closer to Bob');
  assert.ok(world.build(a.id, 'wall', 26, 30).ok, 'closer to Ana');
});

test('world_demolish_refunds_half_and_protects_the_keep', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  const t = world.build(p.id, 'tower', 31, 31).building;
  const before = { gold: p.gold, stone: p.stone };
  assert.ok(world.demolish(p.id, t.id).ok);
  assert.equal(p.gold - before.gold, Math.floor(B.tower.cost.gold * CONFIG.economy.demolishRefund));
  assert.equal(p.stone - before.stone, Math.floor(B.tower.cost.stone * CONFIG.economy.demolishRefund));
  assert.equal(world.demolish(p.id, p.coreId).ok, false);
});

test('world_training_needs_the_right_building_and_respects_army_room', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  assert.equal(world.train(p.id, 'warrior').ok, false, 'no barracks yet');
  assert.ok(world.build(p.id, 'barracks', 32, 30).ok);
  for (let i = 0; i < B.barracks.popCap; i++) assert.ok(world.train(p.id, 'warrior').ok);
  const over = world.train(p.id, 'archer');
  assert.equal(over.ok, false);
  assert.match(over.reason, /Armée au complet/);
  assert.equal(world.train(p.id, 'cavalry').ok, false, 'cavalry needs level 2 and a stable');
  assert.equal(world.train(p.id, 'barbarian').ok, false, 'monsters are not trainable');
  runFor(world, clock, B.barracks.trainSeconds * B.barracks.popCap + 1);
  assert.equal(world.popUsed(p), B.barracks.popCap);
  assert.equal(p.queue.length, 0);
});

test('world_stables_train_cavalry_after_the_keep_upgrade', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  world.upgradeCore(p.id);
  assert.ok(world.build(p.id, 'stable', 32, 30).ok);
  assert.ok(world.train(p.id, 'cavalry').ok);
  runFor(world, clock, B.stable.trainSeconds + 0.5);
  assert.ok([...world.units.values()].some((u) => u.owner === p.id && u.kind === 'cavalry'));
  assert.equal(world.popUsed(p), U.cavalry.pop);
});

test('world_cannot_attack_a_shielded_player_and_attacking_drops_own_shield', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 15, { keepShield: true });
  const b = addPlayerAt(world, clock, 'Bob', 48, 48, { keepShield: true });
  const u = spawnUnitAt(world, a, 'warrior', 16.5, 15.5);
  assert.equal(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, false);
  b.shieldUntil = 0;
  assert.ok(world.isShielded(a));
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok);
  assert.equal(world.isShielded(a), false, 'attacker lost spawn shield');
});

test('world_offline_shield_starts_after_the_grace_delay', () => {
  const { world, clock } = makeFlatWorld({ offlineShield: true });
  const a = addPlayerAt(world, clock, 'Ana', 15, 15);
  const b = addPlayerAt(world, clock, 'Bob', 48, 48);
  world.setOnline(b.id, false);
  const u = spawnUnitAt(world, a, 'warrior', 16.5, 15.5);
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, 'closing the tab does not end a raid');
  clock.advance(CONFIG.combat.offlineShieldDelay + 1);
  assert.equal(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, false, 'protected after the delay');
});

test('world_offline_shield_can_be_disabled_by_the_host', () => {
  const { world, clock } = makeFlatWorld({ offlineShield: false });
  const a = addPlayerAt(world, clock, 'Ana', 15, 15);
  const b = addPlayerAt(world, clock, 'Bob', 48, 48);
  world.setOnline(b.id, false);
  clock.advance(3600);
  const u = spawnUnitAt(world, a, 'warrior', 16.5, 15.5);
  assert.ok(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok);
});

test('world_warriors_break_an_enemy_wall_in_the_expected_time', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 40, 30);
  const wall = world.build(b.id, 'wall', 37, 30).building;
  const units = [];
  for (let i = 0; i < 4; i++) units.push(spawnUnitAt(world, a, 'warrior', 35.5, 29.6 + i * 0.3));
  assert.ok(world.command(a.id, units.map((u) => u.id), { type: 'attack', bid: wall.id }).ok);
  const dps = 4 * U.warrior.damage / U.warrior.cooldown;
  runFor(world, clock, B.wall.hp / dps + 3);
  assert.equal(world.buildings.has(wall.id), false, 'wall destroyed');
});

test('world_tower_kills_a_lone_warrior', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 40, 30);
  world.build(b.id, 'tower', 37, 30);
  const u = spawnUnitAt(world, a, 'warrior', 34.5, 30.5);
  const shots = Math.ceil(U.warrior.hp / B.tower.damage);
  runFor(world, clock, shots * B.tower.cooldown + 0.5);
  assert.equal(world.units.has(u.id), false);
});

test('world_army_breaks_into_a_walled_keep_and_eliminates_the_owner', () => {
  const { world, clock } = makeFlatWorld({ size: 96 });
  const a = addPlayerAt(world, clock, 'Ana', 15, 48);
  const b = addPlayerAt(world, clock, 'Bob', 60, 48);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) assert.ok(world.build(b.id, 'wall', 60 + dx, 48 + dy).ok);
  const oldCore = b.coreId;
  const army = [];
  for (let i = 0; i < 14; i++) army.push(spawnUnitAt(world, a, 'warrior', 50.5, 46 + i * 0.3));
  assert.ok(world.command(a.id, army.map((u) => u.id), { type: 'attack', bid: oldCore }).ok);
  const goldBefore = a.gold;
  runFor(world, clock, 60);
  assert.equal(world.buildings.has(oldCore), false, 'keep destroyed');
  assert.ok(b.coreId && b.coreId !== oldCore, 'victim respawned with a new keep');
  assert.ok(world.isShielded(b), 'victim has a fresh shield');
  assert.ok(a.gold > goldBefore, 'attacker looted');
  assert.ok(a.glory >= CONFIG.combat.gloryPerCore * CONFIG.combat.coreGloryMin);
  assert.equal([...world.buildings.values()].filter((x) => x.owner === b.id).length, 1, 'only the new keep remains');
});

test('world_idle_defenders_engage_nearby_attackers', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 40, 30);
  const attacker = spawnUnitAt(world, a, 'archer', 36.5, 30.5);
  const defenders = [0, 1, 2].map((i) => spawnUnitAt(world, b, 'warrior', 39.5, 29.5 + i));
  runFor(world, clock, 12);
  assert.equal(world.units.has(attacker.id), false);
  assert.ok(defenders.some((d) => world.units.has(d.id)));
});

test('world_move_order_reaches_destination_around_obstacles', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 15);
  paint(world, TILE.ROCK, 25, 0, 1, 40);
  const u = spawnUnitAt(world, a, 'warrior', 19.5, 15.5);
  assert.ok(world.command(a.id, [u.id], { type: 'move', x: 31, y: 15 }).ok);
  runFor(world, clock, 40);
  assert.equal(Math.floor(u.x), 31);
  assert.equal(Math.floor(u.y), 15);
  assert.equal(u.order, null);
});

test('world_units_never_stand_inside_blocked_tiles', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 40, 30);
  for (let dy = -2; dy <= 2; dy++) world.build(b.id, dy === 0 ? 'gate' : 'wall', 36, 30 + dy);
  const army = [];
  for (let i = 0; i < 8; i++) army.push(spawnUnitAt(world, a, i % 2 ? 'archer' : 'warrior', 30.5, 28 + i * 0.5));
  world.command(a.id, army.map((u) => u.id), { type: 'attack', bid: b.coreId });
  for (let s = 0; s < 300; s++) {
    runFor(world, clock, 0.1);
    for (const u of world.units.values()) {
      assert.equal(world.blocked(u.owner, world.tileOf(u)), false, `unit ${u.id} inside a blocked tile at ${u.x},${u.y}`);
    }
  }
});

test('world_gates_let_friends_through_and_stop_enemies', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 30, 30);
  const e = addPlayerAt(world, clock, 'Eve', 5, 5);
  // A full wall line across the map with one gate at y = 30.
  for (let y = 0; y < 64; y++) world.placeBuilding(a, y === 30 ? 'gate' : 'wall', 34, y);
  const friend = spawnUnitAt(world, a, 'warrior', 32.5, 30.5);
  world.command(a.id, [friend.id], { type: 'move', x: 38, y: 30 });
  runFor(world, clock, 6);
  assert.equal(Math.floor(friend.x), 38, 'own unit walked through its gate');
  const foe = spawnUnitAt(world, e, 'warrior', 32.5, 20.5);
  world.command(e.id, [foe.id], { type: 'move', x: 38, y: 20 });
  runFor(world, clock, 8);
  assert.ok(foe.x < 34, 'enemy cannot walk through the gate');
});

test('world_cavalry_deals_bonus_damage_to_archers', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 45, 30);
  const knight = spawnUnitAt(world, a, 'cavalry', 30.5, 30.5);
  const archer = spawnUnitAt(world, b, 'archer', 31, 30.5);
  world.strike(knight, U.cavalry, archer, 'u');
  assert.equal(archer.hp, U.archer.hp - U.cavalry.damage * U.cavalry.bonus.archer);
});

test('world_catapults_only_hit_buildings_and_outrange_towers', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 10, 30);
  const b = addPlayerAt(world, clock, 'Bob', 48, 30);
  const tower = world.build(b.id, 'tower', 40, 30).building;
  const cat = spawnUnitAt(world, a, 'catapult', 33.5, 30.5);
  const foe = spawnUnitAt(world, b, 'warrior', 50.5, 40.5);
  assert.equal(world.command(a.id, [cat.id], { type: 'attack', uid: foe.id }).ok, false);
  assert.ok(world.command(a.id, [cat.id], { type: 'attack', bid: tower.id }).ok);
  const volleys = Math.ceil(B.tower.hp / U.catapult.damage);
  runFor(world, clock, volleys * U.catapult.cooldown + 1);
  assert.equal(world.buildings.has(tower.id), false, 'tower destroyed');
  assert.equal(cat.hp, U.catapult.hp, 'catapult never took a hit');
});

test('world_healers_mend_wounded_allies', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 30, 30);
  const hurt = spawnUnitAt(world, a, 'warrior', 33.5, 33.5);
  hurt.hp = 50;
  spawnUnitAt(world, a, 'healer', 35.5, 33.5);
  runFor(world, clock, 3);
  assert.ok(hurt.hp > 50 + U.healer.heal);
});

test('world_forge_research_raises_attack_and_armor', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 45, 30);
  assert.equal(world.research(a.id, 'attack').ok, false, 'needs a forge');
  world.upgradeCore(a.id);
  assert.ok(world.build(a.id, 'forge', 17, 30).ok);
  assert.ok(world.research(a.id, 'attack').ok);
  const w = spawnUnitAt(world, a, 'warrior', 30.5, 30.5);
  const t = spawnUnitAt(world, b, 'archer', 31, 30.5);
  world.strike(w, U.warrior, t, 'u');
  const expected = U.warrior.damage * U.warrior.bonus.archer ** 0 * (1 + CONFIG.techs.attack.perLevel) * (U.warrior.bonus.archer || 1);
  assert.ok(Math.abs((U.archer.hp - t.hp) - expected) < 1e-9);
  assert.ok(world.research(a.id, 'armor').ok);
  const hit = spawnUnitAt(world, a, 'warrior', 20.5, 20.5);
  world.damageUnit(hit, 100, b.id);
  assert.ok(Math.abs(hit.hp - (U.warrior.hp - 100 * (1 - CONFIG.techs.armor.perLevel))) < 1e-9);
});

test('world_camps_are_seeded_guarded_looted_and_respawn', () => {
  const clock = makeClock();
  const world = new World({ seed: 21, size: 128, now: clock.now, random: mulberry32(5) });
  world.seedNeutrals();
  assert.equal(world.campCount(), world.campTarget());
  const camp = [...world.buildings.values()].find((b) => CONFIG.buildings[b.kind].camp);
  const guards = [...world.units.values()].filter((u) => u.campId === camp.id);
  assert.ok(guards.length > 0, 'camp has guards');
  const res = world.addPlayer({ name: 'Ana', tokenHash: 'h' });
  const p = res.player;
  const before = { gold: p.gold, glory: p.glory };
  world.damageBuilding(camp, 1e9, p.id);
  const kind = CONFIG.camps.kinds[camp.campKind];
  assert.equal(p.gold, Math.min(CONFIG.economy.cap, before.gold + kind.loot.gold));
  assert.equal(p.glory, before.glory + kind.glory);
  assert.equal(world.campCount(), world.campTarget() - 1);
  runFor(world, clock, CONFIG.camps.respawnSeconds + 2);
  assert.equal(world.campCount(), world.campTarget(), 'camp respawned');
});

test('world_monsters_fight_players_even_under_spawn_shield', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 15, { keepShield: true });
  assert.ok(world.hostile(0, a.id));
  const u = spawnUnitAt(world, a, 'warrior', 40.5, 40.5);
  const wolf = spawnUnitAt(world, 0, 'wolf', 42.5, 40.5);
  runFor(world, clock, 15);
  assert.ok(!world.units.has(wolf.id) || !world.units.has(u.id), 'they fought');
});

test('world_sanctuary_is_captured_by_a_lone_army_and_pays_its_holder', () => {
  const { world, clock } = makeFlatWorld();
  world.ensureShrine();
  const s = world.buildings.get(world.shrineId);
  const a = addPlayerAt(world, clock, 'Ana', 10, 10);
  const b = addPlayerAt(world, clock, 'Bob', 54, 54);
  for (let i = 0; i < 3; i++) spawnUnitAt(world, a, 'warrior', s.x - 1.5 + i, s.y + 2.5);
  runFor(world, clock, CONFIG.shrine.captureSeconds + 2);
  assert.equal(s.holder, a.id);
  const inc = world.income(a);
  assert.equal(inc.gold, keepLevel(1).income.gold + CONFIG.shrine.income.gold);
  const foe = spawnUnitAt(world, b, 'warrior', s.x + 2.5, s.y - 1.5);
  foe.hp = 1e9;
  runFor(world, clock, 1.1);
  assert.equal(world.shrineInfo().contested, true);
});

test('world_clans_make_allies_who_cannot_fight_and_share_gates', () => {
  const { world, clock } = makeFlatWorld();
  const a = addPlayerAt(world, clock, 'Ana', 15, 30);
  const b = addPlayerAt(world, clock, 'Bob', 48, 30);
  assert.equal(world.createClan(a.id, 'x').ok, false, 'tag too short');
  assert.ok(world.createClan(a.id, 'loup').ok);
  assert.equal(world.createClan(b.id, 'LOUP').ok, false, 'tag taken');
  assert.ok(world.inviteToClan(a.id, b.id).ok);
  assert.ok(world.answerInvite(b.id, true).ok);
  assert.equal(b.clan, 'LOUP');
  assert.equal(world.hostile(a.id, b.id), false);
  const u = spawnUnitAt(world, a, 'warrior', 40.5, 30.5);
  assert.equal(world.command(a.id, [u.id], { type: 'attack', bid: b.coreId }).ok, false);
  const gate = world.build(b.id, 'gate', 44, 30).building;
  assert.equal(world.blocked(a.id, world.idx(gate.x, gate.y)), false, 'ally passes the gate');
  assert.ok(world.leaveClan(b.id).ok);
  assert.ok(world.hostile(a.id, b.id));
  assert.equal(world.clans.get('LOUP').members.size, 1);
});

test('world_tower_count_follows_keep_level', () => {
  const { world, clock } = makeFlatWorld();
  const p = addPlayerAt(world, clock, 'Ana', 30, 30);
  let built = 0;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if ((dx || dy) && world.build(p.id, 'tower', 30 + dx, 30 + dy).ok) built++;
  assert.equal(built, keepLevel(1).towers);
});

test('world_core_glory_is_scaled_by_relative_glory', () => {
  const c = CONFIG.combat;
  assert.equal(World.coreGlory(c, 0, 0), c.gloryPerCore);
  assert.equal(World.coreGlory(c, 900, 0), Math.round(c.gloryPerCore * c.coreGloryMin));
  assert.equal(World.coreGlory(c, 0, 900), Math.round(c.gloryPerCore * c.coreGloryMax));
});

test('world_persistence_round_trip_keeps_players_clans_buildings_and_monsters', () => {
  const { world, clock } = makeFlatWorld();
  world.seedNeutrals();
  const a = addPlayerAt(world, clock, 'Ana', 15, 15, { res: { gold: 777, wood: 555, stone: 333 } });
  world.upgradeCore(a.id);
  a.gold = 777;
  world.createClan(a.id, 'ROI');
  world.build(a.id, 'tower', 16, 16);
  world.setTile(world.idx(5, 5), TILE.GOLD);
  spawnUnitAt(world, a, 'archer', 17.5, 17.5);
  const json = JSON.parse(JSON.stringify(world.toJSON()));
  const copy = World.fromJSON(json, { now: clock.now });
  const p = copy.players.get(a.id);
  assert.deepEqual([p.gold, p.wood, p.stone], [a.gold, a.wood, a.stone].map(Math.floor));
  assert.equal(p.clan, 'ROI');
  assert.equal(copy.clans.get('ROI').members.has(a.id), true);
  assert.equal(copy.coreOf(p).level, 2);
  assert.equal(copy.buildings.size, world.buildings.size);
  assert.equal(copy.units.size, world.units.size);
  assert.equal(copy.campCount(), world.campCount());
  assert.equal(copy.tiles[copy.idx(5, 5)], TILE.GOLD);
});

test('world_loads_a_version_1_save', () => {
  const v1 = {
    version: 1, seed: 3, size: 64, nextPlayerId: 2, nextId: 3, tileEdits: [],
    players: [{ id: 1, name: 'Old', tokenHash: 'h', color: '#c0392b', gold: 500, glory: 9, coreId: 1, shieldUntil: 0, queue: ['warrior'], lastSeen: 1 }],
    buildings: [{ id: 1, owner: 1, kind: 'core', x: 12, y: 12, hp: 2000 }, { id: 2, owner: 1, kind: 'barracks', x: 14, y: 12, hp: 450 }],
    units: [],
  };
  const w = World.fromJSON(v1, { now: () => 5 });
  const p = w.players.get(1);
  assert.equal(p.gold, 500);
  assert.equal(p.wood, CONFIG.spawn.start.wood);
  assert.equal(w.coreOf(p).level, 1);
  assert.ok(w.shrineInfo(), 'sanctuary added to old worlds');
});
