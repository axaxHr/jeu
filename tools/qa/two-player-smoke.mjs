#!/usr/bin/env node
/**
 * Two-player run-and-observe smoke test (Playwright, real browsers, real server).
 *
 * Starts the server on a throwaway data dir, joins a desktop player and a mobile
 * player, builds two bases through real mouse/touch input, trains an army, raids
 * the other base, chats, and saves screenshots to production/qa/evidence/bastions-mvp/.
 * Exits non-zero on any page error, console error, or unmet checkpoint.
 *
 * Usage: node tools/qa/two-player-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'production/qa/evidence/bastions-mvp');
mkdirSync(outDir, { recursive: true });
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}/?debug`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const log = (m) => console.log(`[smoke] ${m}`);

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bastions-smoke-'));
let server = null;
function startServer() {
  server = spawn(process.execPath, ['src/server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      MAP_SEED: '20261106',
      START_GOLD: '2500',
      SHIELD_SECONDS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => { process.stderr.write(`[server] ${d}`); problems.push(`server stderr: ${d}`); });
}
async function stopServer() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
}
startServer();

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
}

/** Read helpers that run inside the page through the ?debug hook. */
const probe = {
  core: (page) => page.evaluate(() => {
    const { state } = window.__bastions;
    const c = state.myCore();
    return c ? { x: c.x, y: c.y } : null;
  }),
  /** Free tiles of a terrain code inside my territory, nearest to the core first. */
  freeTiles: (page, code, minR, maxR) => page.evaluate(([code, minR, maxR]) => {
    const { state } = window.__bastions;
    const c = state.myCore();
    const out = [];
    const span = Math.ceil(maxR);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const d = Math.hypot(dx, dy);
        if (d < minR || d > maxR) continue;
        const x = c.x + dx;
        const y = c.y + dy;
        if (x < 0 || y < 0 || x >= state.size || y >= state.size) continue;
        if (state.tileAt(x, y) === code && !state.buildingAt(x, y)) out.push({ x, y, d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }, [code, minR, maxR]),
  screenOf: (page, x, y) => page.evaluate(([x, y]) => window.__bastions.renderer.toScreen(x + 0.5, y + 0.5), [x, y]),
  setCam: (page, x, y, zoom) => page.evaluate(([x, y, zoom]) => {
    const r = window.__bastions.renderer;
    r.cam.x = x; r.cam.y = y; if (zoom) r.cam.zoom = zoom;
  }, [x, y, zoom]),
  me: (page) => page.evaluate(() => window.__bastions.state.me),
  counts: (page) => page.evaluate(() => {
    const { state } = window.__bastions;
    const c = {};
    for (const b of state.buildings.values()) if (b.owner === state.youId) c[b.kind] = (c[b.kind] || 0) + 1;
    return c;
  }),
};

async function tapTile(page, x, y, touch) {
  const [sx, sy] = await probe.screenOf(page, x, y);
  if (touch) await page.touchscreen.tap(sx, sy);
  else await page.mouse.click(sx, sy);
  await sleep(140);
}

async function login(page, name) {
  await page.goto(BASE);
  await page.fill('#name', name);
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 5000 });
  await page.waitForFunction(() => window.__bastions.state.myCore());
}

/** Keep only tiles whose centre is drawn on the bare canvas (not under a HUD panel). */
async function onCanvas(page, tiles) {
  const out = [];
  for (const t of tiles) {
    const [sx, sy] = await probe.screenOf(page, t.x, t.y);
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id === 'world', [sx, sy]);
    if (hit) out.push(t);
  }
  return out;
}

/** Build a small fortified base around the core using the real UI. */
async function buildBase(page, { touch, towers, walls }) {
  const pressBuild = async (kind) => page.click(`[data-build="${kind}"]`);
  const GRASS = 0;
  const GOLD = 4;

  await pressBuild('mine');
  for (const t of (await onCanvas(page, await probe.freeTiles(page, GOLD, 2, 8))).slice(0, 3)) await tapTile(page, t.x, t.y, touch);

  await pressBuild('barracks');
  for (const t of (await onCanvas(page, await probe.freeTiles(page, GRASS, 2, 3))).slice(0, 2)) await tapTile(page, t.x, t.y, touch);

  await pressBuild('tower');
  const ring = await onCanvas(page, await probe.freeTiles(page, GRASS, 3, 5));
  const picked = [];
  for (const t of ring) {
    if (picked.every((p) => Math.hypot(p.x - t.x, p.y - t.y) > 3.5)) picked.push(t);
    if (picked.length >= towers) break;
  }
  for (const t of picked) await tapTile(page, t.x, t.y, touch);

  await pressBuild('wall');
  // Only tiles drawn on the bare canvas (not under a HUD panel), in angular order around the core.
  const core = await probe.core(page);
  const candidates = (await onCanvas(page, await probe.freeTiles(page, GRASS, 6.5, 7.4)))
    .map((t) => ({ ...t, a: Math.atan2(t.y - core.y, t.x - core.x) }));
  const wallTiles = candidates.sort((p, q) => p.a - q.a).slice(0, walls);
  if (!touch && wallTiles.length > 1) {
    // Paint a rampart by dragging along the arc.
    const first = await probe.screenOf(page, wallTiles[0].x, wallTiles[0].y);
    await page.mouse.move(first[0], first[1]);
    await page.mouse.down();
    for (const t of wallTiles) {
      const [sx, sy] = await probe.screenOf(page, t.x, t.y);
      await page.mouse.move(sx, sy, { steps: 4 });
      await sleep(40);
    }
    await page.mouse.up();
  } else {
    for (const t of wallTiles) await tapTile(page, t.x, t.y, touch);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300);
}

async function main() {
  await waitForServer();
  const browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 });
  const mob = await browser.newContext({ ...devices['iPhone 13'] });
  const a = await desk.newPage();
  const b = await mob.newPage();
  watch(a, 'desktop');
  watch(b, 'mobile');

  await a.goto(BASE);
  await a.waitForSelector('#login:not([hidden])');
  await sleep(200);
  await a.screenshot({ path: path.join(outDir, '01-login-desktop.png') });
  log('login screen captured');

  await login(a, 'Aliénor');
  await login(b, 'Bohémond');
  log('both players joined');

  await buildBase(a, { touch: false, towers: 3, walls: 14 });
  await buildBase(b, { touch: true, towers: 3, walls: 8 });
  const ca = await probe.counts(a);
  const cb = await probe.counts(b);
  log(`desktop buildings ${JSON.stringify(ca)}; mobile buildings ${JSON.stringify(cb)}`);
  if (!(ca.tower >= 2 && ca.barracks >= 1 && ca.wall >= 5)) problems.push(`desktop base incomplete: ${JSON.stringify(ca)}`);
  if (!(cb.tower >= 2 && cb.barracks >= 1)) problems.push(`mobile base incomplete: ${JSON.stringify(cb)}`);

  for (let i = 0; i < 7; i++) await a.click('[data-train="warrior"]');
  for (let i = 0; i < 5; i++) await a.click('[data-train="archer"]');
  for (let i = 0; i < 4; i++) await b.click('[data-train="warrior"]');

  await a.fill('#chat-input', 'Bohémond, tes murs ne tiendront pas !');
  await a.press('#chat-input', 'Enter');
  await b.waitForFunction(() => [...document.querySelectorAll('#chat-log li')].some((li) => li.textContent.includes('tes murs')), null, { timeout: 4000 })
    .catch(() => problems.push('chat line did not reach the mobile player'));

  await sleep(9000);
  const coreA = await probe.core(a);
  await probe.setCam(a, coreA.x + 0.5, coreA.y + 0.5, 2.5);
  await sleep(300);
  await a.screenshot({ path: path.join(outDir, '02-base-desktop.png') });
  await b.screenshot({ path: path.join(outDir, '03-base-mobile.png') });
  log(`army ready: ${JSON.stringify(await probe.me(a))}`);

  // Wait for the mobile player's spawn shield to drop, then raid.
  await b.waitForFunction(() => window.__bastions.state.me.shield === 0, null, { timeout: 40_000 });
  const coreB = await probe.core(b);
  await a.keyboard.press('x');
  await probe.setCam(a, coreB.x + 0.5, coreB.y + 0.5, 1.5);
  await sleep(200);
  const [tx, ty] = await probe.screenOf(a, coreB.x, coreB.y);
  await a.mouse.click(tx, ty, { button: 'right' });
  log(`raid ordered on core at ${coreB.x},${coreB.y}`);

  // Follow the battle.
  let shot = false;
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const fighting = await a.evaluate(() => window.__bastions.state.fx.length);
    if (!shot && fighting > 3) {
      await sleep(1200);
      const mid = await a.evaluate(() => {
        const { state } = window.__bastions;
        const mine = [...state.units.values()].filter((u) => u.owner === state.youId);
        if (mine.length === 0) return null;
        return { x: mine.reduce((s, u) => s + u.x, 0) / mine.length, y: mine.reduce((s, u) => s + u.y, 0) / mine.length };
      });
      if (mid) await probe.setCam(a, mid.x, mid.y, 2.5);
      await sleep(250);
      await a.screenshot({ path: path.join(outDir, '04-raid-desktop.png') });
      await b.screenshot({ path: path.join(outDir, '05-under-attack-mobile.png') });
      shot = true;
      log('battle captured');
    }
    const glory = (await probe.me(a)).glory;
    if (shot && glory >= 100) break;
  }
  const meA = await probe.me(a);
  log(`after raid: attacker ${JSON.stringify(meA)}`);
  if (!shot) problems.push('no combat effects observed during the raid');
  if (meA.glory <= 0) problems.push('attacker earned no glory');
  await sleep(500);
  await a.screenshot({ path: path.join(outDir, '06-after-raid-desktop.png') });
  await b.screenshot({ path: path.join(outDir, '07-after-raid-mobile.png') });

  // Restart the server: the world must persist and both clients must resume their own base.
  const before = await a.evaluate(() => ({ id: window.__bastions.state.youId, n: window.__bastions.state.buildings.size }));
  await stopServer();
  await a.waitForFunction(() => !document.getElementById('conn').hidden, null, { timeout: 5000 });
  await a.screenshot({ path: path.join(outDir, '09-connection-lost-desktop.png') });
  startServer();
  await waitForServer();
  await a.waitForFunction(() => document.getElementById('conn').hidden, null, { timeout: 15_000 })
    .catch(() => problems.push('desktop client did not reconnect after a server restart'));
  await b.waitForFunction(() => document.getElementById('conn').hidden, null, { timeout: 15_000 })
    .catch(() => problems.push('mobile client did not reconnect after a server restart'));
  const after = await a.evaluate(() => ({ id: window.__bastions.state.youId, n: window.__bastions.state.buildings.size }));
  log(`restart: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  if (after.id !== before.id) problems.push('player identity changed across a server restart');
  if (Math.abs(after.n - before.n) > 2) problems.push('buildings were not restored after a server restart');

  await a.click('#help-btn');
  await sleep(200);
  await a.screenshot({ path: path.join(outDir, '08-help-desktop.png') });

  await browser.close();
}

let code = 0;
try {
  await main();
} catch (err) {
  problems.push(`fatal: ${err.stack || err.message}`);
} finally {
  if (server && server.exitCode === null) await stopServer();
  if (problems.length) {
    code = 1;
    console.error('[smoke] FAIL');
    for (const p of problems) console.error(` - ${p}`);
  } else {
    console.log(`[smoke] PASS, screenshots in ${path.relative(root, outDir)}/`);
  }
  process.exit(code);
}
