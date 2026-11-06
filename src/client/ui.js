/**
 * DOM side of the HUD: status line, leaderboard, chat log, toasts, building
 * card and hints. All player-provided text goes through textContent, never HTML.
 */
import { CONFIG } from './shared/config.js';
import { iconUrl, previewUrl } from './sprites.js';

const $ = (id) => document.getElementById(id);

export const el = {
  hud: $('hud'),
  login: $('login'),
  loginForm: $('login-form'),
  loginError: $('login-error'),
  name: $('name'),
  resume: $('resume'),
  resumeBtn: $('resume-btn'),
  forgetBtn: $('forget-btn'),
  fresh: $('fresh'),
  gold: $('st-gold'),
  income: $('st-income'),
  army: $('st-army'),
  queue: $('st-queue'),
  glory: $('st-glory'),
  shieldWrap: $('st-shield-wrap'),
  shield: $('st-shield'),
  board: $('board'),
  boardToggle: $('board-toggle'),
  boardList: $('board-list'),
  boardCount: $('board-count'),
  chat: $('chat'),
  chatToggle: $('chat-toggle'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatUnread: $('chat-unread'),
  toasts: $('toasts'),
  card: $('card'),
  cardTitle: $('card-title'),
  cardBody: $('card-body'),
  cardAction: $('card-action'),
  cardClose: $('card-close'),
  selection: $('selection'),
  selCount: $('sel-count'),
  selRecall: $('sel-recall'),
  selClear: $('sel-clear'),
  hint: $('hint'),
  actions: $('actions'),
  minimap: $('minimap'),
  help: $('help'),
  helpBtn: $('help-btn'),
  helpClose: $('help-close'),
  conn: $('conn'),
  world: $('world'),
};

const fmt = new Intl.NumberFormat('fr-FR');

/** Fill the cost labels from the shared config so UI and server never disagree. */
export function initCosts() {
  for (const node of document.querySelectorAll('[data-cost]')) {
    const key = node.dataset.cost;
    const def = CONFIG.buildings[key] || CONFIG.units[key];
    if (!def) continue;
    const coin = document.createElement('img');
    coin.src = iconUrl('coin', 2);
    coin.alt = '';
    node.replaceChildren(coin, document.createTextNode(String(def.cost)));
    node.closest('button').title = `${def.name} : ${def.cost} or`;
  }
}

/** Paint every pixel icon and building preview in the page, in the player's colour. */
export function paintIcons(color) {
  for (const img of document.querySelectorAll('img[data-icon]')) img.src = iconUrl(img.dataset.icon, 3);
  for (const img of document.querySelectorAll('img[data-preview]')) img.src = previewUrl(img.dataset.preview, color);
}

export function renderStatus(me, ownCounts) {
  el.gold.textContent = fmt.format(me.gold);
  el.income.textContent = `+${me.income}/s`;
  el.army.textContent = `${me.units}/${me.cap}`;
  el.queue.textContent = me.queue > 0 ? `+${me.queue} en file` : '';
  el.glory.textContent = fmt.format(me.glory);
  el.shieldWrap.hidden = !(me.shield > 0);
  if (me.shield > 0) {
    const m = Math.floor(me.shield / 60);
    const s = String(me.shield % 60).padStart(2, '0');
    el.shield.textContent = `${m}:${s}`;
  }
  for (const btn of el.actions.querySelectorAll('[data-build],[data-train]')) {
    const key = btn.dataset.build || btn.dataset.train;
    const def = CONFIG.buildings[key] || CONFIG.units[key];
    btn.classList.toggle('poor', me.gold < def.cost);
    if (btn.dataset.train) {
      btn.title = ownCounts.barracks
        ? `${def.name} : ${def.cost} or, ${def.hp} PV, ${def.damage} dégâts, portée ${def.range}`
        : 'Construisez d\'abord une Caserne';
    }
  }
}

export function renderBoard(players, youId) {
  const frag = document.createDocumentFragment();
  let online = 0;
  for (const p of players) {
    if (p.online) online++;
    const li = document.createElement('li');
    if (!p.online) li.classList.add('off');
    if (p.id === youId) li.classList.add('me');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--c', p.color);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name;
    name.title = p.online ? 'En ligne' : 'Hors ligne';
    if (p.shielded) {
      const badge = document.createElement('img');
      badge.className = 'badge';
      badge.src = iconUrl('shield', 2);
      badge.alt = 'bouclier';
      badge.title = 'Sous bouclier';
      name.append(badge);
    }
    const glory = document.createElement('span');
    glory.className = 'glory';
    glory.textContent = fmt.format(p.glory);
    li.append(dot, name, glory);
    frag.append(li);
  }
  el.boardList.replaceChildren(frag);
  el.boardCount.textContent = `· ${online} en ligne`;
}

let unread = 0;
export function addChatLine(line) {
  const li = document.createElement('li');
  if (line.sys) {
    li.className = 'sys';
    li.textContent = line.text;
  } else {
    const who = document.createElement('b');
    who.style.setProperty('--c', line.color);
    who.textContent = line.name;
    li.append(who, document.createTextNode(` ${line.text}`));
  }
  const log = el.chatLog;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.append(li);
  while (log.childElementCount > 120) log.firstElementChild.remove();
  if (stick) log.scrollTop = log.scrollHeight;
  if (el.chat.classList.contains('collapsed') && !line.sys) {
    unread++;
    el.chatUnread.hidden = false;
    el.chatUnread.textContent = String(unread);
  }
}

export function clearUnread() {
  unread = 0;
  el.chatUnread.hidden = true;
}

/** Show a transient message. kind: info | err | alert | kill | warn */
export function toast(text, kind = 'info', ms = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  el.toasts.append(node);
  while (el.toasts.childElementCount > 4) el.toasts.firstElementChild.remove();
  setTimeout(() => node.remove(), ms);
}

export function setHint(text) { el.hint.textContent = text || ''; }

export function setActive(selector, active) {
  for (const btn of el.actions.querySelectorAll(selector)) btn.classList.toggle('active', active(btn));
}
