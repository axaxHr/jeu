#!/usr/bin/env node
/**
 * BASTIONS server entry point. One process serves the web client and the
 * WebSocket game. Configuration comes from environment variables (see
 * docs/deploy-vps.md); everything has a sensible default.
 */
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { World } from './world.js';
import { GameServer } from './net.js';
import { createStaticHandler } from './http.js';
import { saveWorld, loadWorld } from './persistence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d, min, max) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

const settings = {
  port: int(env.PORT, 3000, 1, 65535),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', '..', 'data')),
  mapSize: int(env.MAP_SIZE, CONFIG.map.size, 64, 256),
  mapSeed: env.MAP_SEED ? int(env.MAP_SEED, 1, 0, 2 ** 31 - 1) : crypto.randomInt(1, 2 ** 31 - 1),
  offlineShield: bool(env.OFFLINE_SHIELD, true),
  trustProxy: bool(env.TRUST_PROXY, false),
  maxOnline: int(env.MAX_ONLINE, 32, 1, 500),
  maxConnPerIp: int(env.MAX_CONN_PER_IP, 6, 1, 100),
  inactiveDays: int(env.INACTIVE_DAYS, 21, 0, 3650),
  saveEvery: int(env.SAVE_INTERVAL, 30, 5, 3600),
  shieldSeconds: int(env.SHIELD_SECONDS, CONFIG.spawn.shieldSeconds, 0, 86_400),
  startResources: {
    gold: int(env.START_GOLD, CONFIG.spawn.start.gold, 0, CONFIG.economy.cap),
    wood: int(env.START_WOOD, CONFIG.spawn.start.wood, 0, CONFIG.economy.cap),
    stone: int(env.START_STONE, CONFIG.spawn.start.stone, 0, CONFIG.economy.cap),
  },
};

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const saveFile = path.join(settings.dataDir, 'world.json');
const worldOpts = {
  offlineShield: settings.offlineShield,
  shieldSeconds: settings.shieldSeconds,
  startResources: settings.startResources,
};

let world = await loadWorld(saveFile, worldOpts, log);
if (world) {
  log(`Loaded world: ${world.size}×${world.size}, seed ${world.seed}, ${world.players.size} players.`);
} else {
  world = new World({ seed: settings.mapSeed, size: settings.mapSize, ...worldOpts });
  world.seedNeutrals();
  log(`New world: ${world.size}×${world.size}, seed ${world.seed}, ${world.campCount()} monster camps.`);
}

const save = () => saveWorld(saveFile, world);
const started = Date.now();
let game = null;

const health = (req, res) => {
  if (req.url !== '/healthz') return false;
  const body = JSON.stringify({
    ok: true,
    players: world.players.size,
    online: game ? game.byPlayer.size : 0,
    uptime: Math.round((Date.now() - started) / 1000),
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
  return true;
};

const server = http.createServer(createStaticHandler([
  { prefix: '/', dir: path.resolve(here, '..', 'client') },
  { prefix: '/shared/', dir: path.resolve(here, '..', 'shared') },
], health));

game = new GameServer({
  world,
  httpServer: server,
  options: {
    maxOnline: settings.maxOnline,
    maxConnPerIp: settings.maxConnPerIp,
    trustProxy: settings.trustProxy,
    inactiveDays: settings.inactiveDays,
  },
  save,
  log,
});
game.start({ saveEverySeconds: settings.saveEvery });

server.listen(settings.port, settings.host, () => {
  log(`BASTIONS listening on http://${settings.host}:${settings.port} (offline shield: ${settings.offlineShield ? 'on' : 'off'})`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, saving world…`);
  game.stop();
  try { await save(); log('World saved.'); } catch (err) { log(`Save failed: ${err.message}`); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
