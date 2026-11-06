/**
 * Pixel-art renderer: cached terrain, territory borders, y-sorted buildings and
 * units with shadows, combat effects, placement preview and the minimap.
 * Reads ClientState, never mutates it.
 */
import { CONFIG, TILE } from './shared/config.js';
import {
  ART, PAL, teamRamp, keepSprite, towerSprite, mineSprite, barracksSprite, wallSprite, unitSprite, makeCanvas,
} from './sprites.js';
import { TerrainPainter, MINI_COLORS, hash } from './terrain.js';

export const ZOOM_DEFAULT = 2;
export const UI_FONT = '"Pixelify Sans", ui-monospace, monospace';

/** Pixel ellipse used for soft ground shadows and selection rings. */
function ellipseSprite(w, h, fill, ring) {
  const { c, g } = makeCanvas(w, h);
  const rx = w / 2;
  const ry = h / 2;
  g.fillStyle = fill;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ((x + 0.5 - rx) / rx) ** 2 + ((y + 0.5 - ry) / ry) ** 2;
      if (v > 1 || (ring && v < 0.45)) continue;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas Main view.
   * @param {HTMLCanvasElement} minimap Minimap canvas.
   * @param {import('./state.js').ClientState} state
   */
  constructor(canvas, minimap, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.state = state;
    this.cam = { x: 0, y: 0, zoom: ZOOM_DEFAULT };
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.terrain = null;
    this.painter = null;
    this.miniTerrain = null;
    this.borders = new Map();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.shadowSmall = ellipseSprite(10, 4, 'rgba(18, 10, 24, 0.35)');
    this.shadowBig = ellipseSprite(16, 6, 'rgba(18, 10, 24, 0.35)');
    this.shadowKeep = ellipseSprite(30, 9, 'rgba(18, 10, 24, 0.35)');
    this.selectRing = ellipseSprite(14, 6, PAL.y2, true);
    state.tileListeners.push((i) => this.redrawTile(i));
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    const m = this.mini.clientWidth || 1;
    this.mini.width = Math.round(m * this.dpr);
    this.mini.height = Math.round(m * this.dpr);
  }

  // ------------------------------------------------------------ coordinates

  /** CSS pixels per tile. `cam.zoom` is CSS pixels per art pixel. */
  get scale() { return ART * this.cam.zoom; }
  toScreen(wx, wy) {
    const s = this.scale;
    return [(wx - this.cam.x) * s + this.width / 2, (wy - this.cam.y) * s + this.height / 2];
  }
  toWorld(sx, sy) {
    const s = this.scale;
    return [(sx - this.width / 2) / s + this.cam.x, (sy - this.height / 2) / s + this.cam.y];
  }

  clampCamera() {
    const n = this.state.size;
    this.cam.x = Math.min(n, Math.max(0, this.cam.x));
    this.cam.y = Math.min(n, Math.max(0, this.cam.y));
  }

  // ------------------------------------------------------------ terrain

  buildTerrain() {
    const st = this.state;
    this.painter = new TerrainPainter(st.tiles, st.size);
    this.terrain = this.painter.paintAll();
    this.borders.clear();
    const { c, g } = makeCanvas(st.size, st.size);
    const img = g.createImageData(st.size, st.size);
    for (let i = 0; i < st.size * st.size; i++) {
      const col = MINI_COLORS[st.tiles[i]];
      img.data.set([col[0], col[1], col[2], 255], i * 4);
    }
    g.putImageData(img, 0, 0);
    this.miniTerrain = c;
  }

  redrawTile(i) {
    if (!this.painter) return;
    this.painter.repaint(i);
    const g = this.miniTerrain.getContext('2d');
    const col = MINI_COLORS[this.state.tiles[i]];
    g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    g.fillRect(i % this.state.size, Math.floor(i / this.state.size), 1, 1);
  }

  /** Tile-edge segments [x, y, dx, dy] outlining the territory disc of `core`. Cached. */
  borderOf(core) {
    const key = `${core.id}`;
    let segs = this.borders.get(key);
    if (segs) return segs;
    const r = CONFIG.territory.radius;
    const inside = (x, y) => (x - core.x) ** 2 + (y - core.y) ** 2 <= r * r;
    segs = [];
    for (let y = core.y - r; y <= core.y + r; y++) {
      for (let x = core.x - r; x <= core.x + r; x++) {
        if (!inside(x, y)) continue;
        if (!inside(x, y - 1)) segs.push([x, y, 1, 0]);
        if (!inside(x, y + 1)) segs.push([x, y + 1, 1, 0]);
        if (!inside(x - 1, y)) segs.push([x, y, 0, 1]);
        if (!inside(x + 1, y)) segs.push([x + 1, y, 0, 1]);
      }
    }
    this.borders.set(key, segs);
    return segs;
  }

  // ------------------------------------------------------------ frame

  /**
   * Draw one frame.
   * @param {number} now performance.now()
   * @param {object} view UI state: build kind + hover tile, selection, drag box, focused building.
   */
  draw(now, view) {
    const ctx = this.ctx;
    const st = this.state;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!st.ready || !this.terrain) return;

    const s = this.scale;
    const z = this.cam.zoom;
    const [ox, oy] = this.toScreen(0, 0);
    ctx.drawImage(this.terrain, Math.round(ox), Math.round(oy), st.size * s, st.size * s);

    const [wx0, wy0] = this.toWorld(0, 0);
    const [wx1, wy1] = this.toWorld(this.width, this.height);
    const vis = { x0: Math.floor(wx0) - 2, y0: Math.floor(wy0) - 2, x1: Math.ceil(wx1) + 2, y1: Math.ceil(wy1) + 3 };
    const visible = (x, y, pad = 0) => x >= vis.x0 - pad && x <= vis.x1 + pad && y >= vis.y0 - pad && y <= vis.y1 + pad;

    if (!this.reducedMotion) this.drawWaterGlints(ctx, now, vis);
    this.drawTerritories(ctx, now, visible);
    if (view.build) this.drawBuildZone(ctx, view.build);

    // Y-sorted scene: buildings and units.
    const items = [];
    for (const b of st.buildings.values()) {
      if (visible(b.x, b.y, 2)) items.push({ y: b.y + 1, b });
    }
    const a = st.alpha(now);
    for (const u of st.units.values()) {
      const x = u.px + (u.x - u.px) * a;
      const y = u.py + (u.y - u.py) * a;
      if (visible(x, y, 1)) items.push({ y, u, x });
    }
    items.sort((p, q) => p.y - q.y);
    for (const it of items) {
      if (it.b) this.drawBuilding(ctx, it.b, view.focusBuilding === it.b.id);
      else this.drawUnit(ctx, it.u, it.x, it.y, now, view.selection.has(it.u.id));
    }
    for (const it of items) {
      if (it.b) this.buildingBar(ctx, it.b);
      else this.unitBar(ctx, it.u, it.x, it.y);
    }

    this.drawEffects(ctx, now, z);
    this.drawAlerts(ctx, now, s);
    if (view.build && view.hover) this.drawGhost(ctx, view.build, view.hover.x, view.hover.y, now);
    this.drawLabels(ctx, visible);
    if (view.box) {
      const { x0, y0, x1, y1 } = view.box;
      const x = Math.round(Math.min(x0, x1));
      const y = Math.round(Math.min(y0, y1));
      const w = Math.round(Math.abs(x1 - x0));
      const h = Math.round(Math.abs(y1 - y0));
      ctx.fillStyle = 'rgba(234, 181, 52, 0.12)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = PAL.y2;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
    this.drawMinimap(now);
  }

  drawWaterGlints(ctx, now, vis) {
    const st = this.state;
    const z = this.cam.zoom;
    const phase = Math.floor(now / 450);
    ctx.fillStyle = PAL.w4;
    for (let y = Math.max(0, vis.y0); y < Math.min(st.size, vis.y1); y++) {
      for (let x = Math.max(0, vis.x0); x < Math.min(st.size, vis.x1); x++) {
        if (st.tiles[y * st.size + x] !== TILE.WATER || hash(x, y, phase) > 0.12) continue;
        const [sx, sy] = this.toScreen(x, y);
        const gx = 2 + Math.floor(hash(x, y, phase + 1) * 11);
        const gy = 3 + Math.floor(hash(x, y, phase + 2) * 10);
        ctx.fillRect(Math.round(sx + gx * z), Math.round(sy + gy * z), 2 * z, z);
      }
    }
  }

  /** Dotted tile-edge border around each territory: gold for yours, team colour for others, ice when shielded. */
  drawTerritories(ctx, now, visible) {
    const st = this.state;
    const z = this.cam.zoom;
    const r = CONFIG.territory.radius;
    const march = this.reducedMotion ? 0 : Math.floor(now / 140) % 4;
    for (const b of st.buildings.values()) {
      if (b.kind !== 'core' || !visible(b.x, b.y, r + 2)) continue;
      const p = st.players.get(b.owner);
      const mine = b.owner === st.youId;
      const color = p && p.shielded ? PAL.w4 : mine ? PAL.y2 : teamRamp(p ? p.color : '#888888').t3;
      for (const [x, y, dx, dy] of this.borderOf(b)) {
        const [sx, sy] = this.toScreen(x, y);
        for (let k = 0; k < ART; k += 4) {
          const kk = (k + (mine ? march : 0)) % ART;
          const px = Math.round(sx + dx * kk * z) - z;
          const py = Math.round(sy + dy * kk * z) - z;
          ctx.fillStyle = PAL.ink;
          ctx.fillRect(px, py + z, 2 * z, 2 * z);
          ctx.fillStyle = color;
          ctx.fillRect(px, py, 2 * z, 2 * z);
        }
      }
    }
  }

  /** In build mode, light up every tile where this building could go (gold permitting). */
  drawBuildZone(ctx, kind) {
    const st = this.state;
    const core = st.myCore();
    if (!core) return;
    const r = CONFIG.territory.radius;
    const s = Math.round(this.scale);
    ctx.fillStyle = 'rgba(255, 229, 140, 0.12)';
    for (let y = core.y - r; y <= core.y + r; y++) {
      for (let x = core.x - r; x <= core.x + r; x++) {
        const reason = st.canBuild(kind, x, y);
        if (reason && reason !== 'Pas assez d\'or.') continue;
        const [sx, sy] = this.toScreen(x, y);
        ctx.fillRect(Math.round(sx) + 1, Math.round(sy) + 1, s - 2, s - 2);
      }
    }
  }

  ownerColor(owner) {
    const p = this.state.players.get(owner);
    return p ? p.color : '#888888';
  }

  /** Neighbour mask so ramparts join each other and towers. */
  wallMask(b) {
    const st = this.state;
    const joins = (x, y) => {
      if (x < 0 || y < 0 || x >= st.size || y >= st.size) return false;
      const o = st.buildingAt(x, y);
      return !!o && o.owner === b.owner && (o.kind === 'wall' || o.kind === 'tower');
    };
    return (joins(b.x, b.y - 1) ? 1 : 0) | (joins(b.x + 1, b.y) ? 2 : 0) | (joins(b.x, b.y + 1) ? 4 : 0) | (joins(b.x - 1, b.y) ? 8 : 0);
  }

  spriteOf(b, color) {
    switch (b.kind) {
      case 'core': return keepSprite(color);
      case 'tower': return towerSprite(color);
      case 'mine': return mineSprite(color);
      case 'barracks': return barracksSprite(color);
      default: return wallSprite(color, b.mask ?? this.wallMask(b));
    }
  }

  /** Blit a sprite whose anchor is the top-left corner of tile (tx, ty). */
  blit(ctx, spr, tx, ty) {
    const z = this.cam.zoom;
    const [sx, sy] = this.toScreen(tx, ty);
    ctx.drawImage(spr.c, Math.round(sx + spr.ox * z), Math.round(sy + spr.oy * z), spr.c.width * z, spr.c.height * z);
  }

  shadow(ctx, img, wx, wy) {
    const z = this.cam.zoom;
    const [sx, sy] = this.toScreen(wx, wy);
    ctx.drawImage(img, Math.round(sx - (img.width * z) / 2), Math.round(sy - (img.height * z) / 2), img.width * z, img.height * z);
  }

  drawBuilding(ctx, b, focused) {
    const color = b.color || this.ownerColor(b.owner);
    if (b.kind === 'core') this.shadow(ctx, this.shadowKeep, b.x + 0.5, b.y + 0.95);
    else if (b.kind !== 'wall') this.shadow(ctx, this.shadowBig, b.x + 0.5, b.y + 0.95);
    this.blit(ctx, this.spriteOf(b, color), b.x, b.y);
    if (!focused) return;
    const [sx, sy] = this.toScreen(b.x, b.y);
    const s = Math.round(this.scale);
    const z = this.cam.zoom;
    const L = 4 * z;
    ctx.fillStyle = PAL.y2;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [s, 0, -1, 1], [0, s, 1, -1], [s, s, -1, -1]]) {
      ctx.fillRect(Math.round(sx + cx - (dx < 0 ? L : 0)), Math.round(sy + cy - (dy < 0 ? z : 0)), L, z);
      ctx.fillRect(Math.round(sx + cx - (dx < 0 ? z : 0)), Math.round(sy + cy - (dy < 0 ? L : 0)), z, L);
    }
    if (b.kind === 'tower') this.rangeRing(ctx, b.x + 0.5, b.y + 0.5, CONFIG.buildings.tower.range, PAL.y2);
  }

  /** Dotted pixel circle (tower range). */
  rangeRing(ctx, cx, cy, radius, color) {
    const z = this.cam.zoom;
    const s = this.scale;
    const [sx, sy] = this.toScreen(cx, cy);
    const n = Math.max(24, Math.round(radius * 10));
    ctx.fillStyle = color;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      ctx.fillRect(Math.round(sx + Math.cos(a) * radius * s - z), Math.round(sy + Math.sin(a) * radius * s - z), 2 * z, 2 * z);
    }
  }

  /** Pixel health bar centred on (sx, sy). */
  bar(ctx, sx, sy, wArt, frac) {
    const z = Math.max(1, Math.round(this.cam.zoom));
    const w = wArt * z;
    const x = Math.round(sx - w / 2);
    const y = Math.round(sy);
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(x - z, y - z, w + 2 * z, 3 * z);
    ctx.fillStyle = PAL.redD;
    ctx.fillRect(x, y, w, z);
    ctx.fillStyle = frac > 0.5 ? PAL.g4 : frac > 0.25 ? PAL.y2 : PAL.red;
    ctx.fillRect(x, y, Math.max(z, Math.round(w * frac)), z);
  }

  buildingBar(ctx, b) {
    const max = CONFIG.buildings[b.kind].hp;
    if (b.hp >= max) return;
    const lift = b.kind === 'core' ? 1.15 : b.kind === 'tower' ? 0.95 : 0.45;
    const [sx, sy] = this.toScreen(b.x + 0.5, b.y - lift);
    this.bar(ctx, sx, sy, b.kind === 'core' ? 20 : 12, b.hp / max);
  }

  unitBar(ctx, u, x, y) {
    const max = CONFIG.units[u.kind].hp;
    if (u.hp >= max) return;
    const [sx, sy] = this.toScreen(x, y - 1.05);
    this.bar(ctx, sx, sy, 8, u.hp / max);
  }

  drawUnit(ctx, u, wx, wy, now, selected) {
    const z = this.cam.zoom;
    this.shadow(ctx, selected ? this.selectRing : this.shadowSmall, wx, wy);
    const moving = Math.abs(u.x - u.px) + Math.abs(u.y - u.py) > 0.02;
    const frame = moving && !this.reducedMotion ? Math.floor(now / 170 + u.id) % 2 : 0;
    const spr = unitSprite(u.kind, this.ownerColor(u.owner), frame);
    const [fx, fy] = this.toScreen(wx, wy);
    const sx = Math.round(fx);
    const y = Math.round(fy + spr.oy * z + (frame === 1 ? -z : 0));
    const w = spr.c.width * z;
    const h = spr.c.height * z;
    if (u.face < 0) {
      // Mirror around the unit's feet.
      ctx.save();
      ctx.translate(sx, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(spr.c, Math.round(spr.ox * z), y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(spr.c, sx + Math.round(spr.ox * z), y, w, h);
    }
  }

  /** Name plates above each keep, in the owner's colours; a small ice badge when shielded. */
  drawLabels(ctx, visible) {
    const st = this.state;
    const z = this.cam.zoom;
    const size = Math.max(12, Math.round(5.5 * z));
    ctx.font = `700 ${size}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of st.buildings.values()) {
      if (b.kind !== 'core' || !visible(b.x, b.y, 2)) continue;
      const p = st.players.get(b.owner);
      if (!p) continue;
      const [sx, sy] = this.toScreen(b.x + 0.5, b.y - 1.55);
      const w = Math.round(ctx.measureText(p.name).width + size * 0.9);
      const h = Math.round(size * 1.35);
      const x = Math.round(sx - w / 2);
      const y = Math.round(sy - h / 2);
      const ramp = teamRamp(p.color);
      ctx.fillStyle = PAL.ink;
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      ctx.fillStyle = ramp.t1;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = ramp.t2;
      ctx.fillRect(x, y, w, 2);
      ctx.fillStyle = PAL.cloth;
      ctx.fillText(p.name, Math.round(sx), Math.round(sy) + 1);
      if (p.shielded) {
        const ix = x + w + 6;
        ctx.fillStyle = PAL.ink;
        ctx.fillRect(ix - 2, y - 2, h + 4, h + 4);
        ctx.fillStyle = PAL.w3;
        ctx.fillRect(ix, y, h, h);
        ctx.fillStyle = PAL.w4;
        ctx.fillRect(ix + 2, y + 2, Math.round(h / 3), Math.round(h / 3));
      }
    }
  }

  drawEffects(ctx, now, z) {
    for (const f of this.state.fx) {
      const t = (now - f.t0) / f.dur;
      if (t < 0 || t > 1) continue;
      if (f.type === 'arrow' || f.type === 'bolt') {
        const len = Math.hypot(f.x1 - f.x0, f.y1 - f.y0) || 1;
        const dx = (f.x1 - f.x0) / len;
        const dy = (f.y1 - f.y0) / len;
        const lob = f.type === 'arrow' ? Math.sin(t * Math.PI) * Math.min(1, len / 4) : 0;
        const [ax, ay] = this.toScreen(f.x0 + (f.x1 - f.x0) * t, f.y0 + (f.y1 - f.y0) * t - lob - 0.45);
        if (f.type === 'arrow') {
          ctx.fillStyle = PAL.k3;
          for (let k = 0; k < 4; k++) ctx.fillRect(Math.round(ax - dx * k * z), Math.round(ay - dy * k * z), z, z);
          ctx.fillStyle = PAL.cloth;
          ctx.fillRect(Math.round(ax + dx * z), Math.round(ay + dy * z), z, z);
        } else {
          ctx.fillStyle = PAL.y2;
          for (let k = 1; k < 4; k++) ctx.fillRect(Math.round(ax - dx * k * 2 * z), Math.round(ay - dy * k * 2 * z), z, z);
          ctx.fillStyle = PAL.y3;
          ctx.fillRect(Math.round(ax - z), Math.round(ay - z), 2 * z, 2 * z);
        }
      } else if (f.type === 'melee') {
        const [ax, ay] = this.toScreen(f.x1, f.y1 - 0.4);
        ctx.fillStyle = t < 0.5 ? PAL.cloth : PAL.metal;
        const r = (2 + t * 4) * z;
        for (let k = -2; k <= 2; k++) ctx.fillRect(Math.round(ax + k * z), Math.round(ay - r + Math.abs(k) * z), z, z);
      } else if (f.type === 'puff') {
        const [ax, ay] = this.toScreen(f.x0, f.y0 - 0.3);
        ctx.fillStyle = t < 0.5 ? PAL.cloth : PAL.s3;
        const d = (2 + t * 6) * z;
        for (const [px, py] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1.4]]) {
          ctx.fillRect(Math.round(ax + px * d), Math.round(ay + py * d - t * 4 * z), 2 * z, 2 * z);
        }
      } else if (f.type === 'rubble') {
        const [ax, ay] = this.toScreen(f.x0, f.y0);
        const n = this.reducedMotion ? 5 : 12;
        for (let k = 0; k < n; k++) {
          const ang = (k / n) * Math.PI * 2 + k;
          const d = (3 + t * 12) * z * (0.6 + (k % 3) * 0.2);
          ctx.fillStyle = k % 3 === 0 ? PAL.k2 : k % 3 === 1 ? PAL.s2 : PAL.s3;
          ctx.fillRect(Math.round(ax + Math.cos(ang) * d), Math.round(ay + Math.sin(ang) * d * 0.6 - (1 - t) * 6 * z + t * t * 10 * z), 2 * z, 2 * z);
        }
      } else if (f.type === 'order') {
        const [ax, ay] = this.toScreen(f.x0, f.y0);
        const d = Math.round((1 - t) * 5 * z + 2 * z);
        ctx.fillStyle = f.attack ? PAL.red : PAL.g5;
        for (const [px, py] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.fillRect(Math.round(ax + px * d - z), Math.round(ay + py * d - z), 2 * z, 2 * z);
          ctx.fillRect(Math.round(ax + px * (d - 2 * z) - z), Math.round(ay + py * (d - 2 * z) - z), 2 * z, 2 * z);
        }
      }
    }
  }

  drawAlerts(ctx, now, s) {
    const z = this.cam.zoom;
    for (const a of this.state.alerts) {
      const t = ((now - a.t0) % 900) / 900;
      const r = (0.7 + t * 1.8) * s;
      const [x, y] = this.toScreen(a.x + 0.5, a.y + 0.5);
      ctx.fillStyle = t < 0.6 ? PAL.red : PAL.redD;
      for (let k = 0; k < 20; k++) {
        const ang = (k / 20) * Math.PI * 2;
        ctx.fillRect(Math.round(x + Math.cos(ang) * r), Math.round(y + Math.sin(ang) * r * 0.75), 2 * z, 2 * z);
      }
    }
  }

  drawGhost(ctx, kind, tx, ty, now) {
    const st = this.state;
    const reason = st.canBuild(kind, tx, ty);
    const me = st.myPlayer();
    const s = Math.round(this.scale);
    const z = this.cam.zoom;
    const [fx, fy] = this.toScreen(tx, ty);
    const sx = Math.round(fx);
    const sy = Math.round(fy);
    ctx.fillStyle = reason ? 'rgba(210, 74, 60, 0.35)' : 'rgba(166, 204, 106, 0.30)';
    ctx.fillRect(sx, sy, s, s);
    ctx.globalAlpha = 0.6 + 0.2 * Math.sin(now / 160);
    this.drawBuilding(ctx, { kind, x: tx, y: ty, color: me ? me.color : '#888888', mask: 0 }, false);
    ctx.globalAlpha = 1;
    ctx.fillStyle = reason ? PAL.red : PAL.g5;
    ctx.fillRect(sx, sy, s, z);
    ctx.fillRect(sx, sy + s - z, s, z);
    ctx.fillRect(sx, sy, z, s);
    ctx.fillRect(sx + s - z, sy, z, s);
    if (kind === 'tower') this.rangeRing(ctx, tx + 0.5, ty + 0.5, CONFIG.buildings.tower.range, reason ? PAL.red : PAL.y2);
  }

  // ------------------------------------------------------------ minimap

  drawMinimap(now) {
    const st = this.state;
    const m = this.mctx;
    const W = this.mini.width;
    const k = W / st.size;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.imageSmoothingEnabled = false;
    m.drawImage(this.miniTerrain, 0, 0, W, W);
    for (const b of st.buildings.values()) {
      const ramp = teamRamp(this.ownerColor(b.owner));
      if (b.kind === 'core') {
        m.fillStyle = PAL.ink;
        m.fillRect(Math.round((b.x - 1.5) * k) - 1, Math.round((b.y - 1.5) * k) - 1, Math.round(4 * k) + 2, Math.round(4 * k) + 2);
        m.fillStyle = ramp.t3;
        m.fillRect(Math.round((b.x - 1.5) * k), Math.round((b.y - 1.5) * k), Math.round(4 * k), Math.round(4 * k));
      } else {
        m.fillStyle = ramp.t2;
        m.fillRect(Math.round(b.x * k), Math.round(b.y * k), Math.max(2, Math.round(k)), Math.max(2, Math.round(k)));
      }
    }
    for (const u of st.units.values()) {
      m.fillStyle = u.owner === st.youId ? PAL.y3 : teamRamp(this.ownerColor(u.owner)).t4;
      m.fillRect(Math.round(u.x * k) - 1, Math.round(u.y * k) - 1, 2, 2);
    }
    for (const a of st.alerts) {
      const t = ((now - a.t0) % 900) / 900;
      const r = 4 + t * 10;
      m.strokeStyle = PAL.red;
      m.lineWidth = 2;
      m.strokeRect(a.x * k - r, a.y * k - r, r * 2, r * 2);
    }
    const [wx0, wy0] = this.toWorld(0, 0);
    const [wx1, wy1] = this.toWorld(this.width, this.height);
    m.strokeStyle = PAL.cloth;
    m.lineWidth = 2;
    m.strokeRect(Math.round(wx0 * k), Math.round(wy0 * k), Math.round((wx1 - wx0) * k), Math.round((wy1 - wy0) * k));
  }
}
