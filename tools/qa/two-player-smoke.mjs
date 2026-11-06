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
      START_GOLD: '4000',
      START_WOOD: '3000',
      START_STONE: '3000',
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
  /** Free grass tiles in my territory touching terrain `nearCode` (forest 3, rock 2). */
  tilesTouching: (page, nearCode, maxR) => page.evaluate(([nearCode, maxR]) => {
    const { state } = window.__bastions;
    const c = state.myCore();
    const out = [];
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dx = -maxR; dx <= maxR; dx++) {
        const x = c.x + dx;
        const y = c.y + dy;
        if (state.canBuild(nearCode === 3 ? 'sawmill' : 'quarry', x, y)) continue;
        out.push({ x, y, d: Math.hypot(dx, dy) });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }, [nearCode, maxR]),
  nearestCamp: (page) => page.evaluate(() => {
    const { state } = window.__bastions;
    const c = state.myCore();
    let best = null;
    for (const b of state.buildings.values()) {
      if (!b.kind.startsWith('camp_')) continue;
      const d = Math.hypot(b.x - c.x, b.y - c.y);
      if (!best || d < best.d) best = { id: b.id, x: b.x, y: b.y, d, kind: b.kind };
    }
    return best;
  }),
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

async function tab(page, name) {
  await page.click(`.tab[data-tab="${name}"]`);
  await sleep(80);
}

async function act(page, sel) {
  await page.click(`.act${sel}`);
  await sleep(60);
}

/** Build a small fortified base around the keep using the real UI. */
async function buildBase(page, { touch, towers, walls }) {
  const pressBuild = async (kind) => { await tab(page, 'build'); await act(page, `[data-act="build"][data-kind="${kind}"]`); };
  const GRASS = 0;
  const GOLD = 4;

  await pressBuild('mine');
  for (const t of (await onCanvas(page, await probe.freeTiles(page, GOLD, 2, 8))).slice(0, 3)) await tapTile(page, t.x, t.y, touch);

  await pressBuild('sawmill');
  for (const t of (await onCanvas(page, await probe.tilesTouching(page, 3, 8))).slice(0, 1)) await tapTile(page, t.x, t.y, touch);
  await pressBuild('quarry');
  for (const t of (await onCanvas(page, await probe.tilesTouching(page, 2, 8))).slice(0, 1)) await tapTile(page, t.x, t.y, touch);

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
  // Only tiles drawn on the bare canvas (not under a HUD panel), in angular order around the keep.
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

/** Upgrade the keep, then place a stable and a forge (level-2 unlocks). */
async function expand(page) {
  await tab(page, 'keep');
  await act(page, '[data-act="upgrade"]');
  await page.waitForFunction(() => window.__bastions.state.me.level >= 2, null, { timeout: 4000 })
    .catch(() => problems.push('keep upgrade did not happen'));
  await tab(page, 'build');
  for (const kind of ['stable', 'forge', 'outpost']) {
    await act(page, `[data-act="build"][data-kind="${kind}"]`);
    const spots = await onCanvas(page, await probe.freeTiles(page, 0, kind === 'outpost' ? 10 : 2, kind === 'outpost' ? 11 : 4));
    if (spots[0]) await tapTile(page, spots[0].x, spots[0].y, false);
  }
  await page.keyboard.press('Escape');
  await tab(page, 'keep');
  await act(page, '[data-act="research"][data-tech="attack"]');
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
  await sleep(400);
  await a.screenshot({ path: path.join(outDir, '01-login-desktop.png') });
  log('login screen captured');

  await login(a, 'Aliénor');
  await login(b, 'Bohémond');
  log('both players joined');

  await buildBase(a, { touch: false, towers: 3, walls: 14 });
  await buildBase(b, { touch: true, towers: 3, walls: 8 });
  await expand(a);
  const ca = await probe.counts(a);
  const cb = await probe.counts(b);
  log(`desktop buildings ${JSON.stringify(ca)}; mobile buildings ${JSON.stringify(cb)}`);
  for (const k of ['mine', 'sawmill', 'quarry', 'barracks', 'tower', 'stable', 'forge']) {
    if (!(ca[k] >= 1)) problems.push(`desktop base is missing a ${k}: ${JSON.stringify(ca)}`);
  }
  if (!(ca.wall >= 5)) problems.push(`desktop walls not painted: ${JSON.stringify(ca)}`);
  if (!(cb.tower >= 2 && cb.barracks >= 1)) problems.push(`mobile base incomplete: ${JSON.stringify(cb)}`);
  const meA0 = await probe.me(a);
  if (meA0.techs.attack !== 1) problems.push('forge research did not apply');

  await tab(a, 'army');
  const train = async (page, kind, n) => { for (let i = 0; i < n; i++) await act(page, `[data-act="train"][data-kind="${kind}"]`); };
  await train(a, 'warrior', 6);
  await train(a, 'archer', 4);
  await train(a, 'healer', 2);
  await train(a, 'cavalry', 3);
  await tab(b, 'army');
  await train(b, 'warrior', 4);

  await a.fill('#chat-input', 'Bohémond, tes murs ne tiendront pas !');
  await a.press('#chat-input', 'Enter');
  await b.waitForFunction(() => [...document.querySelectorAll('#chat-log li')].some((li) => li.textContent.includes('tes murs')), null, { timeout: 4000 })
    .catch(() => problems.push('chat line did not reach the mobile player'));

  await sleep(12000);
  const coreA = await probe.core(a);
  await probe.setCam(a, coreA.x + 0.5, coreA.y + 0.5, 2.5);
  await tab(a, 'build');
  await sleep(400);
  await a.screenshot({ path: path.join(outDir, '02-base-desktop.png') });
  await tab(a, 'army');
  await sleep(200);
  await a.screenshot({ path: path.join(outDir, '02b-army-tab-desktop.png') });
  await b.screenshot({ path: path.join(outDir, '03-base-mobile.png') });
  log(`army ready: ${JSON.stringify(await probe.me(a))}`);

  // Monster camp: send the army, watch the fight, collect the treasure.
  const camp = await probe.nearestCamp(a);
  const gloryBefore = (await probe.me(a)).glory;
  await a.keyboard.press('x');
  await probe.setCam(a, camp.x + 0.5, camp.y + 0.5, 2.5);
  await sleep(300);
  const [cx, cy] = await probe.screenOf(a, camp.x, camp.y);
  await a.mouse.click(cx, cy, { button: 'right' });
  log(`camp raid ordered on ${camp.kind} at ${camp.x},${camp.y} (${camp.d.toFixed(0)} tiles away)`);
  let campShot = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const st = await a.evaluate((id) => ({ alive: window.__bastions.state.buildings.has(id), fx: window.__bastions.state.fx.length }), camp.id);
    if (!campShot && st.fx > 3) {
      await sleep(800);
      await a.screenshot({ path: path.join(outDir, '04a-camp-raid-desktop.png') });
      campShot = true;
    }
    if (!st.alive) break;
  }
  await sleep(600);
  const meCamp = await probe.me(a);
  log(`after camp: ${JSON.stringify({ glory: meCamp.glory, gold: meCamp.gold, pop: meCamp.pop })}`);
  if (meCamp.glory <= gloryBefore) problems.push('no glory from the monster camp');

  // Wait for the mobile player's spawn shield to drop, then raid what is left.
  await b.waitForFunction(() => window.__bastions.state.me.shield === 0, null, { timeout: 40_000 });
  if ((await probe.me(a)).pop < 4) {
    await tab(a, 'army');
    await train(a, 'warrior', 8);
    await sleep(12000);
  }
  const coreB = await probe.core(b);
  await a.keyboard.press('x');
  await probe.setCam(a, coreB.x + 0.5, coreB.y + 0.5, 1.5);
  await sleep(200);
  const [tx, ty] = await probe.screenOf(a, coreB.x, coreB.y);
  await a.mouse.click(tx, ty, { button: 'right' });
  log(`raid ordered on keep at ${coreB.x},${coreB.y}`);

  let shot = false;
  const gloryRaid = (await probe.me(a)).glory;
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
    if (shot && (await probe.me(a)).glory >= gloryRaid + 20) break;
  }
  const meA = await probe.me(a);
  log(`after raid: attacker ${JSON.stringify({ glory: meA.glory, gold: meA.gold, pop: meA.pop })}`);
  if (!shot) problems.push('no combat effects observed during the raid');
  if (meA.glory <= gloryRaid) problems.push('attacker earned no glory from the raid');
  await sleep(500);
  await a.screenshot({ path: path.join(outDir, '06-after-raid-desktop.png') });
  await b.screenshot({ path: path.join(outDir, '07-after-raid-mobile.png') });

  // Clan: found one on desktop, invite the mobile player from the leaderboard, accept on mobile.
  await tab(a, 'keep');
  await act(a, '[data-act="clan"]');
  await a.fill('#clan-tag', 'lys');
  await a.click('#clan-form button[type=submit]');
  await a.waitForFunction(() => window.__bastions.state.me.clan === 'LYS', null, { timeout: 4000 })
    .catch(() => problems.push('clan was not founded'));
  await a.screenshot({ path: path.join(outDir, '10-clan-panel-desktop.png') });
  await a.click('#clan-close');
  await a.click('#board-list .row-btn:not(.me)');
  await a.click('#card-actions .btn-gold');
  await b.waitForSelector('#invite:not([hidden])', { timeout: 5000 }).catch(() => problems.push('invitation banner not shown'));
  await b.screenshot({ path: path.join(outDir, '11-clan-invite-mobile.png') });
  await b.click('#invite-yes').catch(() => {});
  await b.waitForFunction(() => window.__bastions.state.me.clan === 'LYS', null, { timeout: 5000 })
    .catch(() => problems.push('invitation was not accepted'));

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
  const after = await a.evaluate(() => ({ id: window.__bastions.state.youId, n: window.__bastions.state.buildings.size, clan: window.__bastions.state.me.clan }));
  log(`restart: before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  if (after.id !== before.id) problems.push('player identity changed across a server restart');
  if (Math.abs(after.n - before.n) > 2) problems.push('buildings were not restored after a server restart');
  if (after.clan !== 'LYS') problems.push('clan lost across a server restart');

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
