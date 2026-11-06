/**
 * End-to-end network test: a real HTTP + WebSocket server on a random port,
 * driven by real `ws` clients. Covers join, reconnect, chat, building sync,
 * input validation and static file confinement.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import WebSocket from 'ws';
import { World } from '../../../src/server/world.js';
import { GameServer, ipKey } from '../../../src/server/net.js';
import { createStaticHandler } from '../../../src/server/http.js';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');
let server;
let game;
let base;

before(async () => {
  const world = new World({ seed: 4242, size: 160 });
  server = http.createServer(createStaticHandler([
    { prefix: '/', dir: path.join(root, 'client') },
    { prefix: '/shared/', dir: path.join(root, 'shared') },
  ]));
  game = new GameServer({ world, httpServer: server, options: { maxConnPerIp: 20, newPlayersPerIpHour: 100, connectsPerIpMinute: 1000 } });
  game.start({ saveEverySeconds: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  game.stop();
  await new Promise((r) => server.close(r));
});

/** Connect a client that records every message and can wait for one. */
function connect() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const client = {
    ws,
    inbox,
    open: new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor(pred, ms = 3000) {
      const found = inbox.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      });
    },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  return client;
}

async function join(name, token) {
  const c = connect();
  await c.open;
  c.send({ t: 'hello', v: PROTOCOL_VERSION, name, token });
  const welcome = await c.waitFor((m) => m.t === 'welcome' || m.t === 'err');
  return { c, welcome };
}

test('net_join_returns_map_token_and_base', async () => {
  const { c, welcome } = await join('Alice');
  assert.equal(welcome.t, 'welcome');
  assert.equal(Buffer.from(welcome.tiles, 'base64').length, welcome.size * welcome.size);
  assert.match(welcome.token, /^[0-9a-f]{48}$/);
  assert.ok(welcome.buildings.some((b) => b[1] === welcome.you.id && b[2] === 0), 'own core present');
  await c.close();
});

test('net_duplicate_names_are_rejected_case_insensitively', async () => {
  const a = await join('Bérénice');
  const b = await join('berenice');
  assert.equal(b.welcome.t, 'err');
  await a.c.close();
  await b.c.close();
});

test('net_reconnect_with_token_resumes_the_same_player', async () => {
  const first = await join('Carl');
  const id = first.welcome.you.id;
  const token = first.welcome.token;
  await first.c.close();
  const again = await join('ignored-name', token);
  assert.equal(again.welcome.t, 'welcome');
  assert.equal(again.welcome.you.id, id);
  assert.equal(again.welcome.token, null, 'no new token on resume');
  await again.c.close();
});

test('net_chat_is_broadcast_and_sanitised', async () => {
  const a = await join('Dora');
  const b = await join('Emil');
  const RLO = String.fromCodePoint(0x202e);
  const NUL = String.fromCodePoint(0);
  a.c.send({ t: 'chat', text: `  salut${RLO}   les${NUL} amis  ` });
  const line = await b.c.waitFor((m) => m.t === 'chat' && m.name === 'Dora');
  assert.equal(line.text, 'salut les amis');
  await a.c.close();
  await b.c.close();
});

test('net_build_is_validated_and_synced_to_other_players', async () => {
  const a = await join('Fanny');
  const b = await join('Gus');
  const core = a.welcome.buildings.find((x) => x[1] === a.welcome.you.id && x[2] === 0);
  const tiles = Buffer.from(a.welcome.tiles, 'base64');
  const size = a.welcome.size;
  let spot = null;
  for (let r = 1; r <= 3 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) {
      for (let dx = -r; dx <= r && !spot; dx++) {
        const x = core[3] + dx;
        const y = core[4] + dy;
        if ((dx || dy) && tiles[y * size + x] === 0 && !a.welcome.buildings.some((q) => q[3] === x && q[4] === y)) spot = { x, y };
      }
    }
  }
  assert.ok(spot, 'found a grass tile near the core');
  a.c.send({ t: 'build', kind: 'wall', x: spot.x, y: spot.y });
  const snap = await b.c.waitFor((m) => m.t === 's' && m.w.ba.some((q) => q[3] === spot.x && q[4] === spot.y));
  assert.ok(snap);

  a.c.send({ t: 'build', kind: 'wall', x: 1, y: 1 });
  const err = await a.c.waitFor((m) => m.t === 'err');
  assert.match(err.text, /territoire|Terrain|occupé|carte/);
  await a.c.close();
  await b.c.close();
});

test('net_garbage_input_is_ignored_and_oversized_frames_close_only_that_socket', async () => {
  const a = await join('Hugo');
  a.c.ws.send('not json');
  a.c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  a.c.send({ t: 'build', kind: '__proto__', x: 'a', y: null });
  a.c.send({ t: 'cmd', ids: null, order: { type: 'attack', bid: { $gt: 1 } } });
  a.c.send({ t: 'cmd', ids: [1, 'x'], order: { type: 'move', x: 1, y: 1 } });
  a.c.send({ t: 'ping', n: 7 });
  const pong = await a.c.waitFor((m) => m.t === 'pong');
  assert.equal(pong.n, 7, 'session still alive after garbage');

  const flood = await join('Iris');
  const closed = new Promise((r) => flood.c.ws.once('close', (code) => r(code)));
  flood.c.send({ t: 'chat', text: 'x'.repeat(20_000) });
  assert.equal(await closed, 1009, 'oversized frame closes that socket (message too big)');

  a.c.send({ t: 'ping', n: 8 });
  assert.equal((await a.c.waitFor((m) => m.t === 'pong' && m.n === 8)).n, 8, 'other sessions unaffected');
  await a.c.close();
});

test('net_static_files_are_confined_to_the_client_and_shared_roots', async () => {
  const get = (p) => new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(await get('/'), 200);
  assert.equal(await get('/shared/config.js'), 200);
  assert.equal(await get('/../package.json'), 404);
  assert.equal(await get('/%2e%2e/server/world.js'), 404);
  assert.equal(await get('/shared/../server/world.js'), 404);
});

test('net_malformed_upgrade_request_does_not_crash_the_server', async () => {
  await new Promise((resolve) => {
    const sock = net.connect(server.address().port, '127.0.0.1', () => {
      sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('error', () => resolve());
    sock.on('close', () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 500);
  });
  const { c, welcome } = await join('Survivant');
  assert.equal(welcome.t, 'welcome', 'server still serves players');
  await c.close();
});

test('net_cross_site_origin_is_refused', async () => {
  const ws = new WebSocket(`ws://${base}/ws`, { headers: { Origin: 'https://evil.example' } });
  const outcome = await new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('error', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
});

test('net_ip_key_groups_ipv6_by_64_and_unwraps_mapped_ipv4', () => {
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), ipKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
});

test('net_units_far_from_the_camera_are_not_sent_until_the_view_moves_there', async () => {
  const { c, welcome } = await join('Vigie');
  const core = welcome.buildings.find((b) => b[1] === welcome.you.id && b[2] === 0);
  const fx = core[3] > 48 ? 5 : 90;
  const far = game.world.spawnUnit(0, 'wolf', fx + 0.5, 5.5);
  const first = await c.waitFor((m) => m.t === 's');
  const ids = (m) => m.w.u.filter((_, i) => i % 6 === 0);
  assert.equal(ids(first).includes(far.id), false, 'far unit hidden');
  c.send({ t: 'view', x: fx, y: 5 });
  const later = await c.waitFor((m) => m.t === 's' && ids(m).includes(far.id));
  assert.ok(later);
  game.world.removeUnit(far);
  await c.close();
});

test('net_clan_invites_and_clan_chat_reach_only_members', async () => {
  const a = await join('Chef');
  const b = await join('Recrue');
  const outsider = await join('Passant');
  a.c.send({ t: 'clan', op: 'create', tag: 'ours' });
  await a.c.waitFor((m) => m.t === 'players' && m.list.some((p) => p.name === 'Chef' && p.clan === 'OURS'));
  a.c.send({ t: 'clan', op: 'invite', target: b.welcome.you.id });
  const inv = await b.c.waitFor((m) => m.t === 'notice' && m.kind === 'invite');
  assert.equal(inv.tag, 'OURS');
  b.c.send({ t: 'clan', op: 'accept' });
  await b.c.waitFor((m) => m.t === 'players' && m.list.some((p) => p.name === 'Recrue' && p.clan === 'OURS'));
  a.c.send({ t: 'chat', ch: 'clan', text: 'rendez-vous au sanctuaire' });
  const line = await b.c.waitFor((m) => m.t === 'chat' && m.clan === 'OURS');
  assert.equal(line.text, 'rendez-vous au sanctuaire');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(outsider.c.inbox.some((m) => m.t === 'chat' && m.clan), false, 'outsider did not get clan chat');
  await Promise.all([a.c.close(), b.c.close(), outsider.c.close()]);
});
