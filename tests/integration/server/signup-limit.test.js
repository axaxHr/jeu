/** New-account rate limit per IP: squatters cannot fill the map from one address. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { World } from '../../../src/server/world.js';
import { GameServer } from '../../../src/server/net.js';
import { PROTOCOL_VERSION } from '../../../src/shared/protocol.js';

test('net_new_accounts_per_ip_are_limited', async () => {
  const server = http.createServer();
  const game = new GameServer({ world: new World({ seed: 9, size: 96 }), httpServer: server, options: { newPlayersPerIpHour: 2, maxConnPerIp: 10 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tryJoin = (name) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'welcome' || m.t === 'err') { ws.close(); resolve(m.t); }
    });
  });
  assert.equal(await tryJoin('Un'), 'welcome');
  assert.equal(await tryJoin('Deux'), 'welcome');
  assert.equal(await tryJoin('Trois'), 'err');
  game.stop();
  await new Promise((r) => server.close(r));
});
