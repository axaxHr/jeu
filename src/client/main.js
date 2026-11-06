/**
 * BASTIONS browser client: login, connection, the game controller that maps
 * input to server intents, and the render loop.
 */
import { CONFIG, PLAYER_COLORS } from './shared/config.js';
import { PROTOCOL_VERSION, cleanName, cleanChat, LIMITS } from './shared/protocol.js';
import { ClientState } from './state.js';
import { Renderer, ZOOM_DEFAULT } from './render.js';
import { Connection, socketUrl } from './net.js';
import { attachInput, zoomAt } from './input.js';
import { el, initCosts, paintIcons, renderStatus, renderBoard, addChatLine, clearUnread, toast, setHint, setActive } from './ui.js';
import { loadDemoWorld } from './demo.js';

const STORE_KEY = 'bastions.session';
const store = {
  get() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || null; } catch { return null; }
  },
  set(v) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  },
  clear() {
    try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
  },
};

const state = new ClientState();
const renderer = new Renderer(el.world, el.minimap, state);
const view = { build: null, hover: null, selection: new Set(), box: null, focusBuilding: 0 };
let conn = null;
let inGame = false;
let firstWelcome = true;
let pendingName = '';
let lastPaintTile = -1;
let demo = null;

// ------------------------------------------------------------------ login

function showLogin() {
  el.login.hidden = false;
  el.hud.hidden = true;
  demo = loadDemoWorld(state);
  renderer.buildTerrain();
  renderer.cam.zoom = window.innerWidth < 600 ? 2 : 3;
  const saved = store.get();
  const canResume = saved && typeof saved.token === 'string' && saved.token.length === LIMITS.tokenLength;
  el.resume.hidden = !canResume;
  el.fresh.hidden = !!canResume;
  if (canResume) {
    el.resumeBtn.textContent = `Reprendre en tant que ${saved.name}`;
    el.resumeBtn.focus();
  } else {
    el.name.focus();
  }
}

el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = cleanName(el.name.value);
  if (!name) {
    el.loginError.textContent = `Nom invalide : ${LIMITS.nameMin} à ${LIMITS.nameMax} caractères (lettres, chiffres, espace, - _ . ').`;
    return;
  }
  join(name, null);
});
el.resumeBtn.addEventListener('click', () => {
  const saved = store.get();
  if (saved) join(saved.name, saved.token);
});
el.forgetBtn.addEventListener('click', () => {
  store.clear();
  el.resume.hidden = true;
  el.fresh.hidden = false;
  el.name.focus();
});

function join(name, token) {
  el.loginError.textContent = 'Connexion au serveur…';
  pendingName = name;
  if (conn) conn.stop();
  conn = new Connection(socketUrl(), {
    // Re-read the stored token on every (re)connection: a brand-new player only
    // receives theirs in the first welcome, and must resume with it after a drop.
    onOpen: () => conn.send({ t: 'hello', v: PROTOCOL_VERSION, name, token: (store.get() || {}).token || token || undefined }),
    onMessage,
    onClose: (e, final) => {
      if (!inGame) {
        if (!final) el.loginError.textContent = 'Serveur injoignable, nouvelle tentative…';
        return;
      }
      el.conn.hidden = false;
      el.conn.textContent = final
        ? 'Session ouverte dans un autre onglet. Rechargez la page pour reprendre ici.'
        : 'Connexion perdue. Reconnexion…';
    },
  });
  conn.open();
}

// ------------------------------------------------------------------ messages

function onMessage(msg) {
  const now = performance.now();
  switch (msg.t) {
    case 'welcome': onWelcome(msg, now); break;
    case 's':
      state.applySnapshot(msg.w, msg.me, now);
      for (const id of view.selection) if (!state.units.has(id)) view.selection.delete(id);
      refreshHud();
      break;
    case 'players':
      state.setPlayers(msg.list);
      renderBoard(msg.list, state.youId);
      break;
    case 'chat':
      addChatLine(msg);
      break;
    case 'notice':
      toast(msg.text, msg.kind, msg.kind === 'alert' ? 5000 : 3600);
      if (msg.kind === 'alert' && Number.isInteger(msg.x)) state.alerts.push({ x: msg.x, y: msg.y, t0: now });
      break;
    case 'err':
      if (!inGame) {
        el.loginError.textContent = msg.text;
        conn.stop();
        if (/obsolète/.test(msg.text)) break;
        const saved = store.get();
        if (saved && saved.name === pendingName && /pseudo|Pseudo/.test(msg.text)) store.clear();
      } else {
        toast(msg.text, 'err');
      }
      break;
    default:
      break;
  }
}

function onWelcome(msg, now) {
  const reconnect = inGame;
  if (msg.token) store.set({ token: msg.token, name: msg.you.name });
  else {
    const saved = store.get();
    if (saved) store.set({ ...saved, name: msg.you.name });
  }
  demo = null;
  state.applyWelcome(msg, now);
  renderer.buildTerrain();
  paintIcons(msg.you.color);
  inGame = true;
  el.login.hidden = true;
  el.hud.hidden = false;
  el.conn.hidden = true;
  el.chatLog.replaceChildren();
  for (const line of msg.chat) addChatLine(line);
  renderBoard(msg.players, state.youId);
  renderer.resize();
  if (firstWelcome || !reconnect) centerOnBase();
  firstWelcome = false;
  view.selection.clear();
  refreshHud();
  if (!reconnect) {
    toast(`Bienvenue, ${msg.you.name}. Votre Noyau est au centre du cercle doré.`, 'info', 5000);
  }
}

// ------------------------------------------------------------------ HUD

function ownCounts() {
  const counts = { core: 0, wall: 0, tower: 0, mine: 0, barracks: 0 };
  for (const b of state.buildings.values()) if (b.owner === state.youId) counts[b.kind]++;
  return counts;
}

function refreshHud() {
  const counts = ownCounts();
  renderStatus(state.me, counts);
  setActive('[data-build]', (b) => b.dataset.build === view.build);
  el.selection.hidden = view.selection.size === 0;
  el.selCount.textContent = `${view.selection.size} unité${view.selection.size > 1 ? 's' : ''}`;
  el.world.classList.toggle('building', !!view.build);
  el.world.classList.toggle('commanding', !view.build && view.selection.size > 0);
  refreshCard();

  if (view.build) {
    const def = CONFIG.buildings[view.build];
    const how = view.build === 'mine' ? 'touchez un filon doré de votre territoire' : 'touchez une case libre de votre territoire';
    setHint(`${def.name} (${def.cost} or) : ${how}${view.build === 'wall' ? ', ou glissez pour tracer un rempart' : ''}. Échap pour annuler.`);
  } else if (view.selection.size > 0) {
    setHint('Touchez un ennemi pour attaquer, ou une case pour vous déplacer.');
  } else if (counts.mine === 0) {
    setHint('Astuce : posez une Mine (3) sur un filon doré pour augmenter vos revenus.');
  } else if (counts.barracks === 0) {
    setHint('Astuce : une Caserne (4) permet de recruter une armée.');
  } else if (state.me.units === 0 && state.me.queue === 0) {
    setHint('Astuce : recrutez des Guerriers (5) et des Archers (6).');
  } else {
    setHint('');
  }
}

function openCard(b) {
  view.focusBuilding = b.id;
  el.card.hidden = false;
  refreshCard();
}

function closeCard() {
  view.focusBuilding = 0;
  el.card.hidden = true;
}

function refreshCard() {
  if (!view.focusBuilding) return;
  const b = state.buildings.get(view.focusBuilding);
  if (!b) { closeCard(); return; }
  const def = CONFIG.buildings[b.kind];
  const owner = state.players.get(b.owner);
  const mine = b.owner === state.youId;
  el.cardTitle.textContent = mine ? def.name : `${def.name} de ${owner ? owner.name : '?'}`;
  const lines = [`${Math.max(0, b.hp)} / ${def.hp} PV`];
  if (b.kind === 'tower') lines.push(`portée ${def.range} cases, ${def.damage} dégâts`);
  if (b.kind === 'mine') lines.push(`+${def.income} or/s`);
  if (b.kind === 'core') lines.push(mine ? 'S\'il tombe, toute votre base s\'effondre.' : `+${def.income} or/s · le raser pille 30 % de l'or`);
  if (b.kind === 'barracks') lines.push(`+${def.unitCap} de population`);
  if (!mine && owner && owner.shielded) lines.push('Protégé par un bouclier.');
  el.cardBody.textContent = lines.join(' · ');

  const action = el.cardAction;
  action.className = 'btn btn-small';
  if (mine && b.kind !== 'core') {
    const refund = Math.floor(def.cost * CONFIG.economy.demolishRefund * (b.hp / def.hp));
    action.hidden = false;
    action.textContent = `Démolir (+${refund} or)`;
    action.classList.add('btn-danger');
    action.onclick = () => { conn.send({ t: 'demolish', id: b.id }); closeCard(); };
  } else if (!mine && state.me.units > 0) {
    action.hidden = false;
    action.textContent = view.selection.size > 0 ? `Attaquer avec la sélection (${view.selection.size})` : 'Attaquer avec toute l\'armée';
    action.classList.add('btn-primary');
    action.onclick = () => {
      const ids = view.selection.size > 0 ? [...view.selection] : null;
      command(ids, { type: 'attack', bid: b.id }, b.x + 0.5, b.y + 0.5);
      closeCard();
    };
  } else {
    action.hidden = true;
  }
}

// ------------------------------------------------------------------ actions

function setBuild(kind) {
  view.build = view.build === kind ? null : kind;
  if (view.build) { view.selection.clear(); closeCard(); }
  refreshHud();
}

function train(kind) {
  conn.send({ t: 'train', kind });
}

function selectArmy() {
  view.build = null;
  view.selection = new Set([...state.units.values()].filter((u) => u.owner === state.youId).map((u) => u.id));
  if (view.selection.size === 0) toast('Vous n\'avez pas encore d\'unités : recrutez-en à la Caserne.', 'err');
  refreshHud();
}

function clearSelection() {
  view.selection.clear();
  refreshHud();
}

function centerOnBase() {
  const core = state.myCore();
  if (!core) return;
  renderer.cam.x = core.x + 0.5;
  renderer.cam.y = core.y + 0.5;
  if (firstWelcome) renderer.cam.zoom = ZOOM_DEFAULT;
}

function command(ids, order, wx, wy) {
  const list = ids && ids.length > LIMITS.idsPerCommand ? ids.slice(0, LIMITS.idsPerCommand) : ids;
  conn.send({ t: 'cmd', ids: list, order });
  state.fx.push({ type: 'order', x0: wx, y0: wy, attack: order.type === 'attack', t0: performance.now(), dur: 600 });
}

function tryBuild(tx, ty, quiet) {
  const reason = state.canBuild(view.build, tx, ty);
  if (reason) { if (!quiet) toast(reason, 'err', 2200); return; }
  conn.send({ t: 'build', kind: view.build, x: tx, y: ty });
}

// ------------------------------------------------------------------ input

attachInput(el.world, renderer, {
  canPaint: () => view.build === 'wall',
  onPaint(sx, sy) {
    const [wx, wy] = renderer.toWorld(sx, sy);
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    const i = ty * state.size + tx;
    if (i === lastPaintTile) return;
    lastPaintTile = i;
    tryBuild(tx, ty, true);
  },
  onHover(sx, sy) {
    const [wx, wy] = renderer.toWorld(sx, sy);
    view.hover = { x: Math.floor(wx), y: Math.floor(wy) };
  },
  onBoxPreview(box) { view.box = box; },
  onBox(x0, y0, x1, y1, shift) {
    const [ax, ay] = renderer.toWorld(Math.min(x0, x1), Math.min(y0, y1));
    const [bx, by] = renderer.toWorld(Math.max(x0, x1), Math.max(y0, y1));
    if (!shift) view.selection.clear();
    for (const u of state.units.values()) {
      if (u.owner === state.youId && u.x >= ax && u.x <= bx && u.y >= ay && u.y <= by) view.selection.add(u.id);
    }
    if (view.selection.size > 0) { view.build = null; closeCard(); }
    refreshHud();
  },
  onTap(sx, sy, { button, shift, touch }) {
    lastPaintTile = -1;
    if (!state.ready) return;
    const [wx, wy] = renderer.toWorld(sx, sy);
    const tx = Math.floor(wx);
    const ty = Math.floor(wy);
    if (touch) view.hover = { x: tx, y: ty };

    if (view.build) {
      if (button === 2) { setBuild(null); return; }
      tryBuild(tx, ty, false);
      return;
    }

    const pickRadius = touch ? 0.7 : 0.45;
    const unit = state.unitNear(wx, wy, pickRadius);
    const building = tx >= 0 && ty >= 0 && tx < state.size && ty < state.size ? state.buildingAt(tx, ty) : null;
    const hasSel = view.selection.size > 0;
    const ownUnit = unit && unit.owner === state.youId;
    const ownBuilding = building && building.owner === state.youId;

    if (button === 2 || (hasSel && !ownUnit && !ownBuilding)) {
      if (!hasSel) return;
      const ids = [...view.selection];
      if (unit && !ownUnit) command(ids, { type: 'attack', uid: unit.id }, unit.x, unit.y);
      else if (building && !ownBuilding) command(ids, { type: 'attack', bid: building.id }, tx + 0.5, ty + 0.5);
      else if (tx >= 0 && ty >= 0 && tx < state.size && ty < state.size) command(ids, { type: 'move', x: tx, y: ty }, tx + 0.5, ty + 0.5);
      return;
    }
    if (ownUnit) {
      if (shift && view.selection.has(unit.id)) view.selection.delete(unit.id);
      else {
        if (!shift) view.selection.clear();
        view.selection.add(unit.id);
      }
      closeCard();
      refreshHud();
      return;
    }
    if (building) { openCard(building); return; }
    closeCard();
  },
});

// Minimap: tap or drag to move the camera.
{
  let dragging = false;
  const go = (e) => {
    const rect = el.minimap.getBoundingClientRect();
    renderer.cam.x = ((e.clientX - rect.left) / rect.width) * state.size;
    renderer.cam.y = ((e.clientY - rect.top) / rect.height) * state.size;
    renderer.clampCamera();
  };
  el.minimap.addEventListener('pointerdown', (e) => { dragging = true; el.minimap.setPointerCapture(e.pointerId); go(e); });
  el.minimap.addEventListener('pointermove', (e) => { if (dragging) go(e); });
  el.minimap.addEventListener('pointerup', () => { dragging = false; });
}

el.actions.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !inGame) return;
  if (btn.dataset.build) setBuild(btn.dataset.build);
  else if (btn.dataset.train) train(btn.dataset.train);
  else if (btn.dataset.action === 'army') selectArmy();
  else if (btn.dataset.action === 'center') centerOnBase();
  btn.blur();
});
el.selRecall.addEventListener('click', () => {
  const core = state.myCore();
  if (core) command([...view.selection], { type: 'recall' }, core.x + 0.5, core.y + 0.5);
});
el.selClear.addEventListener('click', clearSelection);
el.cardClose.addEventListener('click', closeCard);
el.helpBtn.addEventListener('click', () => { el.help.hidden = false; });
el.helpClose.addEventListener('click', () => { el.help.hidden = true; });
el.help.addEventListener('click', (e) => { if (e.target === el.help) el.help.hidden = true; });
el.boardToggle.addEventListener('click', () => {
  const collapsed = el.board.classList.toggle('collapsed');
  el.boardToggle.setAttribute('aria-expanded', String(!collapsed));
});
el.chatToggle.addEventListener('click', () => {
  const collapsed = el.chat.classList.toggle('collapsed');
  el.chatToggle.setAttribute('aria-expanded', String(!collapsed));
  if (!collapsed) clearUnread();
});
el.chatInput.addEventListener('focus', () => clearUnread());
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = cleanChat(el.chatInput.value);
  if (text) conn.send({ t: 'chat', text });
  el.chatInput.value = '';
  el.chatInput.blur();
});

// Keyboard: shortcuts are layout-agnostic (digits, arrows, X, C, space).
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (!inGame) return;
  const typing = document.activeElement === el.chatInput;
  if (typing) {
    if (e.key === 'Escape') el.chatInput.blur();
    return;
  }
  if (!el.help.hidden && e.key === 'Escape') { el.help.hidden = true; return; }
  const k = e.key;
  if (k.startsWith('Arrow')) { held.add(k); e.preventDefault(); return; }
  const builds = { 1: 'wall', 2: 'tower', 3: 'mine', 4: 'barracks' };
  if (builds[k]) { setBuild(builds[k]); return; }
  if (k === '5') { train('warrior'); return; }
  if (k === '6') { train('archer'); return; }
  if (k === 'x' || k === 'X') { selectArmy(); return; }
  if ((k === 'c' || k === 'C') && view.selection.size > 0) { el.selRecall.click(); return; }
  if (k === ' ') { e.preventDefault(); centerOnBase(); return; }
  if (k === 'Escape') { view.build = null; view.selection.clear(); closeCard(); refreshHud(); return; }
  if (k === 'Enter') { e.preventDefault(); el.chat.classList.remove('collapsed'); clearUnread(); el.chatInput.focus(); return; }
  if (k === '+' || k === '=') zoomAt(renderer, renderer.width / 2, renderer.height / 2, 1.2);
  if (k === '-' || k === '_') zoomAt(renderer, renderer.width / 2, renderer.height / 2, 1 / 1.2);
});
window.addEventListener('keyup', (e) => held.delete(e.key));
window.addEventListener('blur', () => held.clear());
window.addEventListener('resize', () => renderer.resize());

// ------------------------------------------------------------------ loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (held.size) {
    const speed = (14 * dt) / renderer.cam.zoom;
    if (held.has('ArrowLeft')) renderer.cam.x -= speed;
    if (held.has('ArrowRight')) renderer.cam.x += speed;
    if (held.has('ArrowUp')) renderer.cam.y -= speed;
    if (held.has('ArrowDown')) renderer.cam.y += speed;
    renderer.clampCamera();
  }
  if (demo) demo(now, renderer);
  state.prune(now);
  renderer.draw(now, view);
  requestAnimationFrame(frame);
}

// QA hook: ?debug exposes read access to the client state for automated smoke tests.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__bastions = { state, renderer, view };
}

// Small screens start with the chat and leaderboard folded so the map stays visible.
if (window.matchMedia('(max-width: 600px)').matches) {
  el.chat.classList.add('collapsed');
  el.chatToggle.setAttribute('aria-expanded', 'false');
  el.board.classList.add('collapsed');
  el.boardToggle.setAttribute('aria-expanded', 'false');
}

initCosts();
paintIcons(PLAYER_COLORS[0]);
renderer.resize();
showLogin();
requestAnimationFrame(frame);

// Ping for a live connection indicator in the console when debugging.
setInterval(() => { if (conn && inGame) conn.send({ t: 'ping', n: Date.now() % 1e6 }); }, 20_000);
