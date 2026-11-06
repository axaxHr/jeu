/**
 * Network layer: WebSocket sessions, authentication by reconnect token,
 * message validation and rate limiting, and the tick/broadcast loop.
 * The World never sees raw client input; every message is checked here first.
 */
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CONFIG, BUILDING_KINDS, UNIT_KINDS } from '../shared/config.js';
import { PROTOCOL_VERSION, LIMITS, cleanName, cleanChat, nameKey, isToken } from '../shared/protocol.js';
import { World } from './world.js';

/** Token bucket: `rate` messages per second, bursts up to `burst`. */
const RATE = { rate: 20, burst: 40, kickAfterDrops: 200 };
const CHAT_MIN_INTERVAL_MS = 700;
const MAX_BUFFERED_BYTES = 1 << 20;
/** New WebSocket connections allowed per IP per minute. */
const CONNECTS_PER_IP_MINUTE = 12;
/** A socket must log in within this delay, and gets this many failed attempts. */
const HELLO_TIMEOUT_MS = 10_000;
const MAX_FAILED_HELLOS = 3;
/** Reconnecting within this delay does not announce leave/join in the chat. */
const QUIET_RECONNECT_MS = 60_000;
/** Bases with less play time than this, offline for TRIAL_PURGE_HOURS, are removed early. */
const TRIAL_PLAY_SECONDS = 600;
const TRIAL_PURGE_HOURS = 48;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Group addresses for per-IP limits: IPv4 as-is, IPv6 by /64 (one customer
 * usually owns a whole /64, so per-address limits would be meaningless).
 */
export function ipKey(ip) {
  if (!ip || !ip.includes(':')) return ip || 'unknown';
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const isInt = (v) => Number.isInteger(v) && Math.abs(v) < 1e6;

export class GameServer {
  /**
   * @param {object} opts
   * @param {World} opts.world
   * @param {import('node:http').Server} opts.httpServer
   * @param {object} [opts.options] maxOnline, maxConnPerIp, trustProxy, inactiveDays.
   * @param {() => Promise<void>} [opts.save] Persist the world.
   * @param {(msg:string) => void} [opts.log]
   */
  constructor({ world, httpServer, options = {}, save = async () => {}, log = () => {} }) {
    this.world = world;
    this.options = {
      maxOnline: 32, maxConnPerIp: 6, newPlayersPerIpHour: 3, trustProxy: false,
      trustedProxies: [], allowedOrigins: [], inactiveDays: 21, ...options,
    };
    this.save = save;
    this.log = log;
    this.sessions = new Set();
    this.byPlayer = new Map();
    this.ipCount = new Map();
    this.connectLog = new Map();
    this.signupLog = new Map();
    this.leftAt = new Map();
    this.chatHistory = [];
    this.timers = [];

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false });
    httpServer.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  /** Start the simulation, broadcast, heartbeat, cleanup and autosave loops. */
  start({ saveEverySeconds = 30 } = {}) {
    const dt = 1 / CONFIG.tickRate;
    let tickNo = 0;
    this.timers.push(setInterval(() => {
      this.world.tick(dt);
      tickNo++;
      this.broadcastTick(tickNo % CONFIG.tickRate === 0);
    }, 1000 / CONFIG.tickRate));
    this.timers.push(setInterval(() => this.heartbeat(), 30_000));
    this.timers.push(setInterval(() => { this.cleanupInactive(); this.pruneLogs(); }, 60_000));
    if (saveEverySeconds > 0) {
      this.timers.push(setInterval(() => {
        this.save().catch((err) => this.log(`Autosave failed: ${err.message}`));
      }, saveEverySeconds * 1000));
    }
  }

  /** Stop loops and close every connection. */
  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.sessions) s.ws.close(1001, 'Serveur arrêté');
    this.wss.close();
  }

  clientIp(req) {
    const direct = req.socket.remoteAddress || 'unknown';
    // Only a proxy we trust may tell us the client address: loopback or TRUSTED_PROXIES.
    const fromProxy = LOOPBACK.has(direct) || this.options.trustedProxies.includes(direct);
    if (this.options.trustProxy && fromProxy) {
      const fwd = req.headers['x-forwarded-for'];
      // The right-most entry is the one our own proxy appended; earlier ones are client-controlled.
      if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',').pop().trim().slice(0, 64);
    }
    return req.socket.remoteAddress || 'unknown';
  }

  onUpgrade(req, socket, head) {
    // Anything thrown here would be an uncaught exception and kill the server.
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.endsWith('/ws')) { socket.destroy(); return; }
      if (!this.originAllowed(req)) { this.reject(socket, '403 Forbidden'); return; }
      const ip = ipKey(this.clientIp(req));
      if ((this.ipCount.get(ip) || 0) >= this.options.maxConnPerIp || !this.allowConnect(ip)) {
        this.reject(socket, '429 Too Many Requests');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
    } catch {
      socket.destroy();
    }
  }

  reject(socket, status) {
    try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch { /* gone */ }
    socket.destroy();
  }

  /**
   * Browsers always send Origin on WebSocket upgrades: refuse pages from other
   * sites (they could otherwise create accounts through visitors' browsers).
   * Non-browser clients send no Origin and are allowed.
   */
  originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.options.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  /** Sliding-window limit on new connections per IP. */
  allowConnect(ip) {
    const now = Date.now();
    const recent = (this.connectLog.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= CONNECTS_PER_IP_MINUTE) { this.connectLog.set(ip, recent); return false; }
    recent.push(now);
    this.connectLog.set(ip, recent);
    return true;
  }

  /** Sliding-window limit on new accounts per IP. */
  allowSignup(ip) {
    const now = Date.now();
    const recent = (this.signupLog.get(ip) || []).filter((t) => now - t < 3_600_000);
    this.signupLog.set(ip, recent);
    return recent.length < this.options.newPlayersPerIpHour;
  }

  pruneLogs() {
    const now = Date.now();
    for (const [ip, list] of this.connectLog) if (!list.some((t) => now - t < 60_000)) this.connectLog.delete(ip);
    for (const [ip, list] of this.signupLog) if (!list.some((t) => now - t < 3_600_000)) this.signupLog.delete(ip);
    for (const [id, t] of this.leftAt) if (now - t > QUIET_RECONNECT_MS) this.leftAt.delete(id);
  }

  onConnection(ws, ip) {
    this.ipCount.set(ip, (this.ipCount.get(ip) || 0) + 1);
    const session = {
      ws, ip, playerId: 0, tokens: RATE.burst, last: Date.now(), drops: 0, lastChat: 0, alive: true, failedHellos: 0,
    };
    this.sessions.add(session);
    session.helloTimer = setTimeout(() => { if (!session.playerId) ws.close(1008, 'Identification attendue'); }, HELLO_TIMEOUT_MS);
    ws.on('pong', () => { session.alive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
    ws.on('close', () => this.onClose(session));
    ws.on('error', () => {});
  }

  onClose(session) {
    clearTimeout(session.helloTimer);
    this.sessions.delete(session);
    const n = (this.ipCount.get(session.ip) || 1) - 1;
    if (n <= 0) this.ipCount.delete(session.ip); else this.ipCount.set(session.ip, n);
    if (session.playerId && this.byPlayer.get(session.playerId) === session) {
      this.byPlayer.delete(session.playerId);
      this.world.setOnline(session.playerId, false);
      this.leftAt.set(session.playerId, Date.now());
      const pid = session.playerId;
      // Announce the departure only if they do not come back within a minute.
      setTimeout(() => {
        const p = this.world.players.get(pid);
        if (p && !p.online && this.leftAt.has(pid)) this.systemChat(`${p.name} s'est déconnecté.`);
      }, QUIET_RECONNECT_MS).unref?.();
    }
  }

  heartbeat() {
    for (const s of this.sessions) {
      if (!s.alive) { s.ws.terminate(); continue; }
      s.alive = false;
      try { s.ws.ping(); } catch { /* closed */ }
    }
  }

  /**
   * Remove bases of players who have not connected for `inactiveDays`, and
   * barely-played "trial" bases much sooner, so squatters cannot fill the map.
   */
  cleanupInactive() {
    const now = this.world.now();
    const days = this.options.inactiveDays;
    const inactiveLimit = days ? now - days * 86_400_000 : -Infinity;
    const trialLimit = now - TRIAL_PURGE_HOURS * 3_600_000;
    for (const p of [...this.world.players.values()]) {
      if (p.online) continue;
      const trial = (p.playSeconds || 0) < TRIAL_PLAY_SECONDS && p.lastSeen < trialLimit;
      if (p.lastSeen < inactiveLimit || trial) {
        this.log(`Removing ${trial ? 'abandoned trial' : 'inactive'} player ${p.name}`);
        this.world.removePlayer(p.id);
      }
    }
  }

  send(session, msg) {
    if (session.ws.readyState !== 1) return;
    session.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  error(session, text) { this.send(session, { t: 'err', text }); }

  /** Rate limiting with a token bucket; persistent flooding closes the socket. */
  allow(session) {
    const now = Date.now();
    session.tokens = Math.min(RATE.burst, session.tokens + ((now - session.last) / 1000) * RATE.rate);
    session.last = now;
    if (session.tokens >= 1) { session.tokens -= 1; return true; }
    session.drops++;
    if (session.drops > RATE.kickAfterDrops) session.ws.close(1008, 'Trop de messages');
    return false;
  }

  onMessage(session, data, isBinary) {
    if (isBinary || !this.allow(session)) return;
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'hello') { this.onHello(session, msg); return; }
    if (msg.t === 'ping') { this.send(session, { t: 'pong', n: isInt(msg.n) ? msg.n : 0 }); return; }
    if (!session.playerId) return;

    const pid = session.playerId;
    const w = this.world;
    let res = null;
    switch (msg.t) {
      case 'build':
        if (!BUILDING_KINDS.includes(msg.kind) || !isInt(msg.x) || !isInt(msg.y)) return;
        res = w.build(pid, msg.kind, msg.x, msg.y);
        break;
      case 'demolish':
        if (!isInt(msg.id)) return;
        res = w.demolish(pid, msg.id);
        break;
      case 'train':
        if (!UNIT_KINDS.includes(msg.kind)) return;
        res = w.train(pid, msg.kind);
        break;
      case 'cmd':
        res = this.onCommand(pid, msg);
        break;
      case 'chat':
        this.onChat(session, msg);
        return;
      default:
        return;
    }
    if (res && !res.ok) this.error(session, res.reason);
  }

  onCommand(pid, msg) {
    let ids = null;
    if (msg.ids !== null) {
      if (!Array.isArray(msg.ids) || msg.ids.length > LIMITS.idsPerCommand || !msg.ids.every(isInt)) return null;
      ids = msg.ids;
    }
    const o = msg.order;
    if (!o || typeof o !== 'object') return null;
    if (o.type === 'move' && isInt(o.x) && isInt(o.y)) return this.world.command(pid, ids, { type: 'move', x: o.x, y: o.y });
    if (o.type === 'attack' && isInt(o.bid)) return this.world.command(pid, ids, { type: 'attack', bid: o.bid });
    if (o.type === 'attack' && isInt(o.uid)) return this.world.command(pid, ids, { type: 'attack', uid: o.uid });
    if (o.type === 'recall') return this.world.command(pid, ids, { type: 'recall' });
    return null;
  }

  onChat(session, msg) {
    const now = Date.now();
    if (now - session.lastChat < CHAT_MIN_INTERVAL_MS) { this.error(session, 'Doucement sur le chat !'); return; }
    const text = cleanChat(msg.text);
    if (!text) return;
    session.lastChat = now;
    const p = this.world.players.get(session.playerId);
    this.pushChat({ name: p.name, color: p.color, text, at: now });
  }

  pushChat(line) {
    this.chatHistory.push(line);
    if (this.chatHistory.length > LIMITS.chatHistory) this.chatHistory.shift();
    const out = JSON.stringify({ t: 'chat', ...line });
    for (const s of this.sessions) if (s.playerId) this.send(s, out);
  }

  systemChat(text) { this.pushChat({ name: '', color: '', text, at: Date.now(), sys: true }); }

  findByToken(token) {
    const hash = sha256(token);
    for (const p of this.world.players.values()) if (p.tokenHash === hash) return p;
    return null;
  }

  /** A rejected login: tell the client, and drop sockets that keep failing. */
  helloFailed(session, text) {
    this.error(session, text);
    session.failedHellos++;
    if (session.failedHellos >= MAX_FAILED_HELLOS) session.ws.close(1008, 'Trop de tentatives');
  }

  onHello(session, msg) {
    if (session.playerId) return;
    if (msg.v !== PROTOCOL_VERSION) { this.helloFailed(session, 'Version du jeu obsolète : rechargez la page.'); return; }
    if (this.byPlayer.size >= this.options.maxOnline) { this.helloFailed(session, 'Serveur complet, réessayez plus tard.'); return; }
    const w = this.world;
    let player = null;
    let newToken = null;

    if (isToken(msg.token)) player = this.findByToken(msg.token);
    if (!player) {
      const name = cleanName(msg.name);
      if (!name) { this.helloFailed(session, `Pseudo invalide (${LIMITS.nameMin} à ${LIMITS.nameMax} lettres, chiffres, espaces, - _ . ').`); return; }
      const key = nameKey(name);
      for (const p of w.players.values()) {
        if (nameKey(p.name) === key) { this.helloFailed(session, 'Ce pseudo est déjà pris.'); return; }
      }
      if (!this.allowSignup(session.ip)) {
        this.helloFailed(session, 'Trop de nouveaux seigneurs depuis cette connexion. Réessayez dans une heure.');
        return;
      }
      newToken = crypto.randomBytes(LIMITS.tokenLength / 2).toString('hex');
      const res = w.addPlayer({ name, tokenHash: sha256(newToken) });
      if (!res.ok) { this.helloFailed(session, res.reason); return; }
      this.signupLog.get(session.ip).push(Date.now());
      player = res.player;
      this.log(`New player ${name} (#${player.id}) from ${session.ip}`);
    } else if (!w.coreOf(player)) {
      w.spawnBase(player);
    }

    const previous = this.byPlayer.get(player.id);
    if (previous) {
      previous.playerId = 0;
      this.error(previous, 'Connecté depuis un autre onglet ou appareil.');
      previous.ws.close(4000, 'Remplacé');
    }
    session.playerId = player.id;
    clearTimeout(session.helloTimer);
    this.byPlayer.set(player.id, session);
    w.setOnline(player.id, true);
    const quiet = this.leftAt.has(player.id) || !!previous;
    this.leftAt.delete(player.id);

    this.send(session, {
      t: 'welcome',
      you: { id: player.id, name: player.name, color: player.color },
      token: newToken,
      size: w.size,
      tiles: Buffer.from(w.tiles).toString('base64'),
      buildings: [...w.buildings.values()].map(World.packBuilding),
      players: w.playerList(),
      chat: this.chatHistory,
      tickRate: CONFIG.tickRate,
      offlineShield: w.offlineShield,
      me: w.playerStatus(player),
    });
    if (!quiet) this.systemChat(`${player.name} a rejoint la partie.`);
  }

  /** Send this tick's shared snapshot plus each player's private status. */
  broadcastTick(includePlayers) {
    const w = this.world;
    const ev = w.events;
    const round = (v) => Math.round(v * 100);
    const shared = JSON.stringify({
      u: w.packUnits(),
      fx: ev.fx.map((v, i) => (i % 5 === 0 ? v : round(v))),
      ba: ev.bAdd.filter((b) => w.buildings.has(b.id)).map(World.packBuilding),
      bd: ev.bDel,
      bh: [...ev.bHp.entries()].map(([id, hp]) => [id, Math.max(0, Math.round(hp))]),
      te: ev.tiles,
    });
    const playersMsg = includePlayers || ev.playersDirty
      ? JSON.stringify({ t: 'players', list: w.playerList() })
      : null;

    for (const s of this.sessions) {
      if (!s.playerId || s.ws.readyState !== 1) continue;
      if (s.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow client: skip a frame
      const p = w.players.get(s.playerId);
      if (!p) continue;
      s.ws.send(`{"t":"s","w":${shared},"me":${JSON.stringify(w.playerStatus(p))}}`);
      if (playersMsg) s.ws.send(playersMsg);
    }
    for (const n of ev.notices) {
      const msg = JSON.stringify({ t: 'notice', text: n.text, kind: n.kind, x: n.x, y: n.y });
      if (n.to === null) {
        for (const s of this.sessions) if (s.playerId) this.send(s, msg);
        if (n.kind === 'kill') this.systemChat(n.text);
      } else {
        const s = this.byPlayer.get(n.to);
        if (s) this.send(s, msg);
      }
    }
    w.resetEvents();
  }
}
