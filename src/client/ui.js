/**
 * DOM side of the HUD: resources, tabbed action bar, leaderboard, chat, toasts,
 * cards, clan panel and invitations. All player-provided text goes through
 * textContent, never HTML.
 */
import { CONFIG, RESOURCES, BUILD_MENU, TRAIN_MENU, keepLevel, canAfford } from './shared/config.js';
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
  res: Object.fromEntries(RESOURCES.map((r) => [r, { value: $(`st-${r}`), rate: $(`st-${r}-rate`) }])),
  army: $('st-army'),
  queue: $('st-queue'),
  glory: $('st-glory'),
  shieldWrap: $('st-shield-wrap'),
  shield: $('st-shield'),
  board: $('board'),
  boardToggle: $('board-toggle'),
  boardList: $('board-list'),
  boardCount: $('board-count'),
  shrineLine: $('shrine-line'),
  chat: $('chat'),
  chatToggle: $('chat-toggle'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatCh: $('chat-ch'),
  chatUnread: $('chat-unread'),
  toasts: $('toasts'),
  invite: $('invite'),
  inviteText: $('invite-text'),
  inviteYes: $('invite-yes'),
  inviteNo: $('invite-no'),
  card: $('card'),
  cardTitle: $('card-title'),
  cardBody: $('card-body'),
  cardActions: $('card-actions'),
  cardClose: $('card-close'),
  clan: $('clan'),
  clanClose: $('clan-close'),
  clanNone: $('clan-none'),
  clanIn: $('clan-in'),
  clanForm: $('clan-form'),
  clanTag: $('clan-tag'),
  clanTitle: $('clan-title'),
  clanMembers: $('clan-members'),
  clanLeave: $('clan-leave'),
  selection: $('selection'),
  selCount: $('sel-count'),
  selRecall: $('sel-recall'),
  selClear: $('sel-clear'),
  hint: $('hint'),
  actions: $('actions'),
  actionButtons: $('action-buttons'),
  minimap: $('minimap'),
  help: $('help'),
  helpBtn: $('help-btn'),
  helpClose: $('help-close'),
  conn: $('conn'),
  world: $('world'),
};

const fmt = new Intl.NumberFormat('fr-FR');
const RES_ICON = { gold: 'coin', wood: 'wood', stone: 'stone' };
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function img(src, alt = '') {
  const i = document.createElement('img');
  i.src = src;
  i.alt = alt;
  return i;
}

/** Inline cost chips: icon + amount per resource. */
export function costChips(cost) {
  const wrap = document.createElement('span');
  wrap.className = 'cost';
  for (const r of RESOURCES) {
    if (!cost[r]) continue;
    const chip = document.createElement('span');
    chip.className = 'chip-res';
    chip.dataset.res = r;
    chip.append(img(iconUrl(RES_ICON[r], 2)), document.createTextNode(String(cost[r])));
    wrap.append(chip);
  }
  if (!wrap.childElementCount) wrap.textContent = '—';
  return wrap;
}

/** The actions of each tab, in order. */
export function tabActions(tab) {
  if (tab === 'build') return BUILD_MENU.map((kind) => ({ act: 'build', kind }));
  if (tab === 'army') return [...TRAIN_MENU.map((kind) => ({ act: 'train', kind })), { act: 'army' }, { act: 'recall' }];
  return [{ act: 'upgrade' }, { act: 'research', tech: 'attack' }, { act: 'research', tech: 'armor' }, { act: 'clan' }, { act: 'center' }];
}

function actionLabel(a) {
  switch (a.act) {
    case 'build': return { name: CONFIG.buildings[a.kind].name, preview: a.kind };
    case 'train': return { name: CONFIG.units[a.kind].name, preview: a.kind };
    case 'army': return { name: 'Tout', icon: 'sword', note: 'sélectionner' };
    case 'recall': return { name: 'Rappel', icon: 'flag', note: 'tout rentre' };
    case 'upgrade': return { name: 'Donjon', preview: 'core' };
    case 'research': return { name: CONFIG.techs[a.tech].name.split(' ')[0], icon: a.tech === 'attack' ? 'sword' : 'shield' };
    case 'clan': return { name: 'Clan', icon: 'flag', note: 'alliances' };
    default: return { name: 'Ma base', preview: 'core', note: 'centrer' };
  }
}

/** Build the buttons of a tab. */
export function renderTab(tab, color) {
  const frag = document.createDocumentFragment();
  tabActions(tab).forEach((a, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'act';
    btn.dataset.act = a.act;
    if (a.kind) btn.dataset.kind = a.kind;
    if (a.tech) btn.dataset.tech = a.tech;
    const label = actionLabel(a);
    if (i < KEYS.length) {
      const k = document.createElement('kbd');
      k.textContent = KEYS[i];
      btn.append(k);
    }
    btn.append(img(label.preview ? previewUrl(label.preview, color) : iconUrl(label.icon, 3)));
    const name = document.createElement('span');
    name.className = 'act-name';
    name.textContent = label.name;
    btn.append(name);
    const sub = document.createElement('span');
    sub.className = 'act-sub';
    if (label.note) { sub.classList.add('cost-plain'); sub.textContent = label.note; }
    btn.append(sub);
    const lock = document.createElement('span');
    lock.className = 'lock';
    lock.hidden = true;
    lock.append(img(iconUrl('lock', 2)), document.createElement('span'));
    btn.append(lock);
    frag.append(btn);
  });
  el.actionButtons.replaceChildren(frag);
  for (const t of el.actions.querySelectorAll('.tab')) {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
}

function setSub(btn, cost) {
  const sub = btn.querySelector('.act-sub');
  const key = JSON.stringify(cost);
  if (sub.dataset.key === key) return;
  sub.dataset.key = key;
  sub.className = 'act-sub';
  sub.replaceChildren(cost ? costChips(cost) : document.createTextNode('max'));
}

function setLock(btn, text) {
  const lock = btn.querySelector('.lock');
  lock.hidden = !text;
  if (text) lock.lastChild.textContent = text;
  btn.classList.toggle('locked', !!text);
}

/** Refresh affordability, locks and titles of the visible action buttons. */
export function updateActions(state, view) {
  const me = state.me;
  const counts = state.counts();
  for (const btn of el.actionButtons.querySelectorAll('.act')) {
    const { act, kind, tech } = btn.dataset;
    let cost = null;
    let lock = null;
    let title = '';
    if (act === 'build') {
      const def = CONFIG.buildings[kind];
      cost = def.cost;
      lock = state.lockReason(def) ? `Niv. ${def.minLevel}` : null;
      title = `${def.name} : ${buildingBlurb(kind)}`;
      btn.classList.toggle('active', view.build === kind);
    } else if (act === 'train') {
      const def = CONFIG.units[kind];
      cost = def.cost;
      const trainer = Object.values(CONFIG.buildings).find((b) => b.trains && b.trains.includes(kind));
      const hasTrainer = Object.entries(CONFIG.buildings).some(([k, b]) => b.trains && b.trains.includes(kind) && counts[k] > 0);
      lock = state.lockReason(def) ? `Niv. ${def.minLevel}` : !hasTrainer ? trainer.name : null;
      title = `${def.name} : ${unitBlurb(kind)}`;
    } else if (act === 'upgrade') {
      const next = me.level < CONFIG.keep.levels.length ? keepLevel(me.level + 1) : null;
      cost = next ? next.cost : null;
      btn.querySelector('.act-name').textContent = next ? `Niveau ${me.level + 1}` : 'Niveau max';
      title = next ? `Donjon niveau ${me.level + 1} : territoire ${next.radius} cases, armée ${next.unitCap}, ${next.towers} tours max.` : 'Donjon au niveau maximum.';
    } else if (act === 'research') {
      const t = CONFIG.techs[tech];
      const lvl = me.techs[tech];
      cost = lvl < t.costs.length ? t.costs[lvl] : null;
      lock = counts.forge ? null : 'Forge';
      btn.querySelector('.act-name').textContent = `${t.name.split(' ')[0]} ${lvl}/${t.costs.length}`;
      title = `${t.name} : ${tech === 'attack' ? `+${t.perLevel * 100} % de dégâts` : `−${t.perLevel * 100} % de dégâts subis`} par niveau, pour toutes vos unités.`;
    }
    if (act === 'build' || act === 'train' || act === 'upgrade' || act === 'research') {
      setSub(btn, cost);
      btn.classList.toggle('poor', !!cost && !canAfford(me, cost));
      for (const chip of btn.querySelectorAll('.chip-res')) {
        chip.classList.toggle('short', (me[chip.dataset.res] || 0) < (cost?.[chip.dataset.res] || 0));
      }
      setLock(btn, lock);
    }
    if (title) btn.title = title;
  }
}

function buildingBlurb(kind) {
  const d = CONFIG.buildings[kind];
  switch (kind) {
    case 'wall': return 'bloque les ennemis, à casser pour passer.';
    case 'gate': return 'un mur que vos troupes et vos alliés traversent.';
    case 'tower': return `tire sur les ennemis à ${d.range} cases.`;
    case 'mine': return `sur un filon d'or, +${d.income.gold} or/s.`;
    case 'sawmill': return `contre la forêt, +${d.perTile.wood} bois/s par case de forêt voisine.`;
    case 'quarry': return `contre la roche, +${d.perTile.stone} pierre/s par case de roche voisine.`;
    case 'barracks': return `Guerriers, Archers, Soigneurs ; +${d.popCap} places d'armée.`;
    case 'stable': return `Cavaliers ; +${d.popCap} places d'armée.`;
    case 'workshop': return `Catapultes ; +${d.popCap} places d'armée.`;
    case 'forge': return 'améliore l\'attaque et l\'armure de toutes vos unités.';
    case 'outpost': return `étend votre territoire de ${CONFIG.territory.outpostRadius} cases autour de lui.`;
    default: return '';
  }
}

function unitBlurb(kind) {
  const d = CONFIG.units[kind];
  const bits = [`${d.hp} PV`];
  if (d.healer) bits.push(`soigne ${d.heal} PV`);
  else bits.push(`${d.damage} dégâts`, `portée ${d.range}`);
  if (d.siege) bits.push('bâtiments seulement');
  if (d.bonus) for (const [k, v] of Object.entries(d.bonus)) bits.push(`×${v} contre ${CONFIG.units[k].name}s`);
  bits.push(`${d.pop} place${d.pop > 1 ? 's' : ''}`);
  return bits.join(', ');
}

/** Paint every pixel icon and building preview in the page, in the player's colour. */
export function paintIcons(color) {
  for (const i of document.querySelectorAll('img[data-icon]')) i.src = iconUrl(i.dataset.icon, 3);
  for (const i of document.querySelectorAll('img[data-preview]')) i.src = previewUrl(i.dataset.preview, color);
}

function short(n) {
  return n >= 10000 ? `${Math.floor(n / 1000)}k` : fmt.format(Math.floor(n));
}

export function renderStatus(me) {
  for (const r of RESOURCES) {
    el.res[r].value.textContent = short(me[r]);
    el.res[r].rate.textContent = `+${me.income[r]}`;
  }
  el.army.textContent = `${me.pop}/${me.cap}`;
  el.queue.textContent = me.queue > 0 ? `+${me.queue}` : '';
  el.glory.textContent = fmt.format(me.glory);
  el.shieldWrap.hidden = !(me.shield > 0);
  if (me.shield > 0) el.shield.textContent = `${Math.floor(me.shield / 60)}:${String(me.shield % 60).padStart(2, '0')}`;
}

/**
 * Leaderboard rows (players are buttons: tap to see, invite or visit them),
 * plus the Sanctuary line.
 */
export function renderBoard(players, youId, shrine, onPick) {
  const frag = document.createDocumentFragment();
  let online = 0;
  for (const p of players) {
    if (p.online) online++;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn';
    if (!p.online) btn.classList.add('off');
    if (p.id === youId) btn.classList.add('me');
    btn.title = p.online ? 'En ligne' : 'Hors ligne';
    btn.addEventListener('click', () => onPick(p));
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--c', p.color);
    const name = document.createElement('span');
    name.className = 'name';
    if (p.clan) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `[${p.clan}]`;
      name.append(tag);
    }
    name.append(document.createTextNode(p.name));
    if (p.shielded) {
      const badge = img(iconUrl('shield', 2), 'bouclier');
      badge.className = 'badge';
      name.append(badge);
    }
    const glory = document.createElement('span');
    glory.className = 'glory';
    glory.textContent = fmt.format(p.glory);
    btn.append(dot, name, glory);
    li.append(btn);
    frag.append(li);
  }
  el.boardList.replaceChildren(frag);
  el.boardCount.textContent = `· ${online} en ligne`;
  if (shrine) {
    const holder = players.find((p) => p.id === shrine.holder);
    el.shrineLine.textContent = holder
      ? `Sanctuaire : ${holder.clan ? `[${holder.clan}] ` : ''}${holder.name}${shrine.contested ? ' (disputé !)' : ''}`
      : `Sanctuaire : libre${shrine.contested ? ' (disputé)' : ''}`;
  }
}

let unread = 0;
export function addChatLine(line) {
  const li = document.createElement('li');
  if (line.sys) {
    li.className = 'sys';
    li.textContent = line.text;
  } else {
    if (line.clan) li.className = 'clan';
    const who = document.createElement('b');
    who.style.setProperty('--c', line.color);
    who.textContent = line.clan ? `[${line.clan}] ${line.name}` : line.tag ? `[${line.tag}] ${line.name}` : line.name;
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

/** Show a transient message. kind: info | err | alert | kill | warn | loot */
export function toast(text, kind = 'info', ms = 3200) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = text;
  el.toasts.append(node);
  while (el.toasts.childElementCount > 4) el.toasts.firstElementChild.remove();
  setTimeout(() => node.remove(), ms);
}

export function setHint(text) { el.hint.textContent = text || ''; }

/** Card action buttons: [{label, kind: 'gold'|'danger'|'', onClick}] */
export function setCardActions(actions) {
  const frag = document.createDocumentFragment();
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-small${a.kind ? ` btn-${a.kind}` : ''}`;
    if (a.cost) {
      b.append(document.createTextNode(`${a.label} `), costChips(a.cost));
    } else {
      b.textContent = a.label;
    }
    b.disabled = !!a.disabled;
    b.addEventListener('click', a.onClick);
    frag.append(b);
  }
  el.cardActions.replaceChildren(frag);
}

/** Clan panel contents. */
export function renderClan(me, players) {
  el.clanNone.hidden = !!me.clan;
  el.clanIn.hidden = !me.clan;
  if (!me.clan) return;
  el.clanTitle.textContent = `[${me.clan}]`;
  const frag = document.createDocumentFragment();
  for (const p of players.values()) {
    if (p.clan !== me.clan) continue;
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--c', p.color);
    li.append(dot, document.createTextNode(` ${p.name}${p.online ? '' : ' (hors ligne)'}`));
    frag.append(li);
  }
  el.clanMembers.replaceChildren(frag);
}
