/**
 * BASTIONS browser client: login, connection, the game controller that maps
 * input to server intents, and the render loop.
 */
import { CONFIG, PLAYER_COLORS, keepLevel, costLabel } from './shared/config.js';
import { PROTOCOL_VERSION, cleanName, cleanChat, LIMITS } from './shared/protocol.js';
import { ClientState } from './state.js';
import { Renderer, ZOOM_DEFAULT } from './render.js';
import { Connection, socketUrl } from './net.js';
import { attachInput, zoomAt } from './input.js';
import {
  el, paintIcons, renderTab, tabActions, updateActions, renderStatus, renderBoard, addChatLine, clearUnread,
  toast, setHint, setCardActions, renderClan,
} from './ui.js';
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

const TABS = ['build', 'army', 'keep'];
const state = new ClientState();
const renderer = new Renderer(el.world, el.minimap, state);
const view = { build: null, hover: null, selection: new Set(), box: null, focusBuilding: 0 };
let conn = null;
let inGame = false;
let firstWelcome = true;
let pendingName = '';
let lastPaintTile = -1;
let demo = null;
let tab = 'build';
let myColor = PLAYER_COLORS[0];
let chatChannel = 'all';
let card = null;
let sentView = { x: -99, y: -99 };

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
      state.setPlayers(msg.list, msg.shrine);
      renderBoard(msg.list, state.youId, state.shrine, openPlayerCard);
      renderClan(state.me, state.players);
      break;
    case 'chat':
      addChatLine(msg);
      break;
    case 'notice':
      if (msg.kind === 'invite') { refreshInvite(); break; }
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
  myColor = msg.you.color;
  paintIcons(myColor);
  renderTab(tab, myColor);
  inGame = true;
  el.login.hidden = true;
  el.hud.hidden = false;
  el.conn.hidden = true;
  el.chatLog.replaceChildren();
  for (const line of msg.chat) addChatLine(line);
  renderBoard(msg.players, state.youId, state.shrine, openPlayerCard);
  renderer.resize();
  if (firstWelcome || !reconnect) centerOnBase();
  firstWelcome = false;
  view.selection.clear();
  sentView = { x: -99, y: -99 };
  refreshHud();
  if (!reconnect) {
    toast(`Bienvenue, ${msg.you.name}. Ton Donjon est au centre de la bordure dorée.`, 'info', 5000);
  }
}

// ------------------------------------------------------------------ HUD

function refreshHud() {
  const counts = state.counts();
  renderStatus(state.me);
  updateActions(state, view);
  el.selection.hidden = view.selection.size === 0;
  el.selCount.textContent = `${view.selection.size} unité${view.selection.size > 1 ? 's' : ''}`;
  el.world.classList.toggle('building', !!view.build);
  el.world.classList.toggle('commanding', !view.build && view.selection.size > 0);
  el.chatCh.hidden = !state.me.clan;
  if (!state.me.clan && chatChannel === 'clan') setChannel('all');
  refreshCard();
  refreshInvite();
  if (!el.clan.hidden) renderClan(state.me, state.players);

  if (view.build) {
    const def = CONFIG.buildings[view.build];
    const where = def.needsGold ? 'sur un filon doré'
      : def.near === 'forest' ? 'contre la forêt'
        : def.near === 'rock' ? 'contre la roche' : 'sur une case libre';
    setHint(`${def.name} (${costLabel(def.cost)}) : touche ${where} de ton territoire${view.build === 'wall' ? ', ou glisse pour tracer un rempart' : ''}. Échap pour annuler.`);
  } else if (view.selection.size > 0) {
    setHint('Touche un ennemi ou un camp de monstres pour attaquer, ou une case pour te déplacer.');
  } else if (counts.mine === 0) {
    setHint('Astuce : pose une Mine sur un filon doré (onglet Bâtir).');
  } else if (counts.sawmill === 0) {
    setHint('Astuce : une Scierie collée à la forêt produit du bois.');
  } else if (counts.quarry === 0) {
    setHint('Astuce : une Carrière collée à la roche produit de la pierre.');
  } else if (counts.barracks === 0) {
    setHint('Astuce : une Caserne permet de recruter une armée.');
  } else if (state.me.level === 1 && state.me.pop > 0) {
    setHint('Astuce : améliore ton Donjon (onglet Donjon) pour agrandir ton territoire.');
  } else {
    setHint('');
  }
}

function refreshInvite() {
  const inv = state.me.invite;
  el.invite.hidden = !inv;
  if (inv) el.inviteText.textContent = `${inv.from} t'invite dans le clan [${inv.tag}]`;
}

function closeCard() {
  card = null;
  view.focusBuilding = 0;
  el.card.hidden = true;
}

function openBuildingCard(b) {
  card = { type: 'building', id: b.id };
  view.focusBuilding = b.id;
  el.card.hidden = false;
  refreshCard();
}

function openPlayerCard(p) {
  card = { type: 'player', id: p.id };
  view.focusBuilding = 0;
  el.card.hidden = false;
  refreshCard();
}

function attackWithArmy(target) {
  const ids = view.selection.size > 0 ? [...view.selection] : null;
  command(ids, target.bid ? { type: 'attack', bid: target.bid } : { type: 'attack', uid: target.uid }, target.x, target.y);
  closeCard();
}

function refreshCard() {
  if (!card) return;
  if (card.type === 'player') { refreshPlayerCard(); return; }
  const b = state.buildings.get(card.id);
  if (!b) { closeCard(); return; }
  const def = CONFIG.buildings[b.kind];
  const owner = state.players.get(b.owner);
  const mine = b.owner === state.youId;
  const ally = !mine && state.friendly(b.owner);
  const maxHp = b.kind === 'core' ? keepLevel(b.level).hp : def.hp;
  const lines = [];
  const actions = [];
  const haveArmy = state.me.pop > 0;
  const armyLabel = view.selection.size > 0 ? `Attaquer (${view.selection.size})` : 'Attaquer avec l\'armée';

  if (b.kind === 'shrine') {
    el.cardTitle.textContent = def.name;
    const holder = state.players.get(b.holder);
    const s = state.shrine;
    lines.push(holder ? `Tenu par ${holder.name}.` : 'Libre.');
    lines.push(`Reste seul à ${CONFIG.shrine.radius} cases avec tes troupes pendant ${CONFIG.shrine.captureSeconds} s pour le capturer.`);
    lines.push(`Rapporte ${costLabel(CONFIG.shrine.income)} par seconde, et de la gloire.`);
    if (s && s.progress > 0) lines.push(`Capture en cours : ${s.progress}/${s.need} s${s.contested ? ' (disputé)' : ''}.`);
    if (haveArmy) {
      actions.push({
        label: 'Envoyer l\'armée', kind: 'gold', onClick: () => {
          const ids = view.selection.size > 0 ? [...view.selection] : null;
          command(ids, { type: 'move', x: b.x, y: b.y + 2 }, b.x + 0.5, b.y + 2.5);
          closeCard();
        },
      });
    }
  } else if (def.camp) {
    const camp = CONFIG.camps.kinds[def.camp];
    el.cardTitle.textContent = def.name;
    lines.push(`${Math.max(0, Math.round(b.hp))} / ${maxHp} PV.`);
    lines.push(`Trésor : ${costLabel(camp.loot)}, +${camp.glory} gloire. Gardé par des monstres.`);
    if (haveArmy) actions.push({ label: armyLabel, kind: 'gold', onClick: () => attackWithArmy({ bid: b.id, x: b.x + 0.5, y: b.y + 0.5 }) });
  } else {
    el.cardTitle.textContent = mine ? def.name : `${def.name} de ${owner ? owner.name : '?'}`;
    lines.push(`${Math.max(0, Math.round(b.hp))} / ${maxHp} PV`);
    if (b.kind === 'core') {
      const kl = keepLevel(b.level);
      lines.push(`niveau ${b.level}, territoire ${kl.radius} cases`);
      if (mine) lines.push(`+${costLabel(kl.income)} /s`);
    }
    if (b.kind === 'tower') lines.push(`portée ${def.range}, ${def.damage} dégâts`);
    if (def.income) lines.push(`+${costLabel(def.income)} /s`);
    if (def.near) {
      const code = def.near === 'forest' ? 3 : 2;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && state.tileAt(b.x + dx, b.y + dy) === code) n++;
      const [r, v] = Object.entries(def.perTile)[0];
      lines.push(`+${Math.min(def.maxIncome, Math.round(v * n * 10) / 10)} ${r === 'wood' ? 'bois' : 'pierre'}/s`);
    }
    if (def.popCap) lines.push(`+${def.popCap} places d'armée`);
    if (ally) lines.push('Allié.');
    if (!mine && owner && owner.shielded) lines.push('Protégé par un bouclier.');

    if (mine && b.kind === 'core' && b.level < CONFIG.keep.levels.length) {
      const next = keepLevel(b.level + 1);
      actions.push({ label: `Niveau ${b.level + 1}`, kind: 'gold', cost: next.cost, onClick: () => conn.send({ t: 'upgrade' }) });
    }
    if (mine && b.kind === 'forge') {
      for (const tech of Object.keys(CONFIG.techs)) {
        const t = CONFIG.techs[tech];
        const lvl = state.me.techs[tech];
        if (lvl < t.costs.length) {
          actions.push({ label: `${t.name} ${lvl + 1}`, kind: 'gold', cost: t.costs[lvl], onClick: () => conn.send({ t: 'research', tech }) });
        }
      }
    }
    if (mine && b.kind !== 'core') {
      const k = CONFIG.economy.demolishRefund * (b.hp / def.hp);
      const refund = {};
      for (const [r, v] of Object.entries(def.cost)) refund[r] = Math.floor(v * k);
      actions.push({ label: 'Démolir', kind: 'danger', cost: refund, onClick: () => { conn.send({ t: 'demolish', id: b.id }); closeCard(); } });
    } else if (!mine && !ally && haveArmy) {
      actions.push({ label: armyLabel, kind: 'gold', onClick: () => attackWithArmy({ bid: b.id, x: b.x + 0.5, y: b.y + 0.5 }) });
    }
  }
  el.cardBody.textContent = lines.join(' · ');
  setCardActions(actions);
}

function refreshPlayerCard() {
  const p = state.players.get(card.id);
  if (!p) { closeCard(); return; }
  el.cardTitle.textContent = `${p.clan ? `[${p.clan}] ` : ''}${p.name}`;
  el.cardBody.textContent = [
    `${p.glory} gloire`,
    p.level ? `Donjon niveau ${p.level}` : 'sans Donjon',
    p.online ? 'en ligne' : 'hors ligne',
    p.shielded ? 'sous bouclier' : null,
  ].filter(Boolean).join(' · ');
  const actions = [];
  if (p.cx >= 0) {
    actions.push({ label: 'Voir sa base', onClick: () => { renderer.cam.x = p.cx + 0.5; renderer.cam.y = p.cy + 0.5; closeCard(); } });
  }
  if (p.id !== state.youId && state.me.clan && !p.clan) {
    actions.push({ label: `Inviter dans [${state.me.clan}]`, kind: 'gold', onClick: () => { conn.send({ t: 'clan', op: 'invite', target: p.id }); toast(`Invitation envoyée à ${p.name}.`); } });
  }
  if (p.id !== state.youId && !state.me.clan) {
    actions.push({ label: 'Fonder un clan', onClick: () => { closeCard(); openClan(); } });
  }
  setCardActions(actions);
}

function openClan() {
  el.clan.hidden = false;
  renderClan(state.me, state.players);
  if (!state.me.clan) el.clanTag.focus();
}

// ------------------------------------------------------------------ actions

function setTab(next) {
  tab = next;
  renderTab(tab, myColor);
  updateActions(state, view);
}

function setBuild(kind) {
  view.build = view.build === kind ? null : kind;
  if (view.build) { view.selection.clear(); closeCard(); }
  refreshHud();
}

function runAction(btn) {
  const { act, kind, tech } = btn.dataset;
  if (btn.classList.contains('locked')) { toast(`Verrouillé : ${btn.querySelector('.lock span').textContent}.`, 'err', 2000); return; }
  switch (act) {
    case 'build': setBuild(kind); break;
    case 'train': conn.send({ t: 'train', kind }); break;
    case 'army': selectArmy(); break;
    case 'recall': command(null, { type: 'recall' }, (state.myCore()?.x ?? 0) + 0.5, (state.myCore()?.y ?? 0) + 0.5); break;
    case 'upgrade': conn.send({ t: 'upgrade' }); break;
    case 'research': conn.send({ t: 'research', tech }); break;
    case 'clan': openClan(); break;
    default: centerOnBase(); break;
  }
}

function selectArmy() {
  view.build = null;
  view.selection = new Set([...state.units.values()].filter((u) => u.owner === state.youId).map((u) => u.id));
  if (view.selection.size === 0) toast('Tu n\'as pas encore d\'unités : recrute-en (onglet Armée).', 'err');
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

function setChannel(ch) {
  chatChannel = ch;
  el.chatCh.textContent = ch === 'clan' ? `[${state.me.clan || 'Clan'}]` : 'Tous';
  el.chatCh.classList.toggle('btn-gold', ch === 'clan');
  el.chatInput.placeholder = ch === 'clan' ? 'Message au clan…' : 'Entrée pour parler…';
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
    if (!state.ready || !inGame) return;
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
    const friendlyBuilding = building && (state.friendly(building.owner) || building.kind === 'shrine');
    const hostileUnit = unit && !state.friendly(unit.owner);

    if (button === 2 || (hasSel && !ownUnit && !friendlyBuilding)) {
      if (!hasSel) return;
      const ids = [...view.selection];
      if (hostileUnit) command(ids, { type: 'attack', uid: unit.id }, unit.x, unit.y);
      else if (building && !friendlyBuilding) command(ids, { type: 'attack', bid: building.id }, tx + 0.5, ty + 0.5);
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
    if (building) { openBuildingCard(building); return; }
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
  if (!inGame) return;
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
  const btn = e.target.closest('.act');
  if (!btn) return;
  runAction(btn);
  btn.blur();
});
// A mouse wheel scrolls the action buttons sideways when they overflow.
el.actionButtons.addEventListener('wheel', (e) => {
  if (el.actionButtons.scrollWidth <= el.actionButtons.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  el.actionButtons.scrollLeft += e.deltaY;
}, { passive: false });
el.selRecall.addEventListener('click', () => {
  const core = state.myCore();
  if (core) command([...view.selection], { type: 'recall' }, core.x + 0.5, core.y + 0.5);
});
el.selClear.addEventListener('click', clearSelection);
el.cardClose.addEventListener('click', closeCard);
el.inviteYes.addEventListener('click', () => conn.send({ t: 'clan', op: 'accept' }));
el.inviteNo.addEventListener('click', () => conn.send({ t: 'clan', op: 'decline' }));
el.clanClose.addEventListener('click', () => { el.clan.hidden = true; });
el.clanForm.addEventListener('submit', (e) => {
  e.preventDefault();
  conn.send({ t: 'clan', op: 'create', tag: el.clanTag.value });
  el.clanTag.value = '';
});
el.clanLeave.addEventListener('click', () => conn.send({ t: 'clan', op: 'leave' }));
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
el.chatCh.addEventListener('click', () => setChannel(chatChannel === 'clan' ? 'all' : 'clan'));
el.chatInput.addEventListener('focus', () => clearUnread());
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = cleanChat(el.chatInput.value);
  if (text) conn.send({ t: 'chat', text, ch: chatChannel });
  el.chatInput.value = '';
  el.chatInput.blur();
});

// Keyboard: digits press the buttons of the current tab, Tab switches tabs.
const held = new Set();
window.addEventListener('keydown', (e) => {
  if (!inGame) return;
  const typing = document.activeElement === el.chatInput || document.activeElement === el.clanTag;
  if (typing) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (!el.help.hidden && e.key === 'Escape') { el.help.hidden = true; return; }
  const k = e.key;
  if (k.startsWith('Arrow')) { held.add(k); e.preventDefault(); return; }
  if (k === 'Tab') { e.preventDefault(); setTab(TABS[(TABS.indexOf(tab) + (e.shiftKey ? 2 : 1)) % TABS.length]); return; }
  const digit = '1234567890'.indexOf(k);
  if (digit >= 0) {
    const btn = el.actionButtons.querySelectorAll('.act')[digit];
    if (btn && digit < tabActions(tab).length) runAction(btn);
    return;
  }
  if (k === 'x' || k === 'X') { selectArmy(); return; }
  if ((k === 'c' || k === 'C') && view.selection.size > 0) { el.selRecall.click(); return; }
  if (k === ' ') { e.preventDefault(); centerOnBase(); return; }
  if (k === 'Escape') { view.build = null; view.selection.clear(); closeCard(); el.clan.hidden = true; refreshHud(); return; }
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
    const speed = (14 * dt) / renderer.cam.zoom * 2;
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

// Tell the server where the camera is, so it sends the units around it.
setInterval(() => {
  if (!conn || !inGame) return;
  const x = Math.round(renderer.cam.x);
  const y = Math.round(renderer.cam.y);
  if (Math.abs(x - sentView.x) + Math.abs(y - sentView.y) < 2) return;
  sentView = { x, y };
  conn.send({ t: 'view', x, y });
}, 300);

// QA hook: ?debug exposes read access to the client state for automated smoke tests.
if (new URLSearchParams(window.location.search).has('debug')) {
  window.__bastions = { state, renderer, view, setTab };
}

// Small screens start with the chat and leaderboard folded so the map stays visible.
if (window.matchMedia('(max-width: 600px)').matches) {
  el.chat.classList.add('collapsed');
  el.chatToggle.setAttribute('aria-expanded', 'false');
  el.board.classList.add('collapsed');
  el.boardToggle.setAttribute('aria-expanded', 'false');
}

paintIcons(PLAYER_COLORS[0]);
renderTab(tab, myColor);
renderer.resize();
showLogin();
requestAnimationFrame(frame);

// Keep-alive ping.
setInterval(() => { if (conn && inGame) conn.send({ t: 'ping', n: Date.now() % 1e6 }); }, 20_000);
