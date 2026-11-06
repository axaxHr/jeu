/** Save files on disk: what the server writes, it must load back (current format and v1). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../../../src/server/world.js';
import { saveWorld, loadWorld } from '../../../src/server/persistence.js';

test('persistence_saved_world_loads_back_from_disk', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bastions-save-'));
  const file = path.join(dir, 'world.json');
  const world = new World({ seed: 11, size: 96 });
  world.seedNeutrals();
  const p = world.addPlayer({ name: 'Disque', tokenHash: 'h' }).player;
  world.createClan(p.id, 'SAVE');
  await saveWorld(file, world);
  const logs = [];
  const loaded = await loadWorld(file, {}, (m) => logs.push(m));
  assert.ok(loaded, `world loaded (${logs.join('; ')})`);
  assert.equal(loaded.players.get(p.id).clan, 'SAVE');
  assert.equal(loaded.buildings.size, world.buildings.size);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('corrupt')), [], 'nothing moved aside');
});

test('persistence_unreadable_save_is_moved_aside_not_deleted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bastions-save-'));
  const file = path.join(dir, 'world.json');
  writeFileSync(file, '{ not json');
  const loaded = await loadWorld(file, {}, () => {});
  assert.equal(loaded, null);
  assert.equal(readdirSync(dir).filter((f) => f.includes('corrupt')).length, 1);
});
