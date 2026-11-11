/**
 * renderer.ts — Canvas2D renderer for «Плотина».
 *
 * Two layers: a cached static layer (background, tiles, pipes, reservoir frames —
 * rebuilt only when the board changes) and a per-frame dynamic layer (water with
 * animated wave tops and flow streaks, particles, HUD, screens). No gradients are
 * rebuilt per frame and no objects are allocated in the render loop.
 */

import { BOARD, PACING, SCORING } from "./config";
import { maskOf } from "./pieces";
import type { Board } from "./board";
import type { Particles } from "./particles";
import { N, E, S, W, type GameEvent, type PipeKind } from "./types";

const { COLS, ROWS, SRC_COLS } = BOARD;

export type GameScreen = "title" | "playing" | "paused" | "gameover";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  w: number;
  h: number;
  cell: number;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
  hud: Rect;
  floodBar: Rect;
  queueSlots: Rect[];
  buttons: Record<string, Rect>;
  reservoirs: Rect[];
  sources: Rect[];
}

export interface ButtonSpec {
  id: string;
  rect: Rect;
  label: string;
  sub?: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ViewModel {
  board: Board;
  particles: Particles;
  screen: GameScreen;
  time: number;
  cursor: { col: number; row: number; visible: boolean };
  pointer: { x: number; y: number; active: boolean; isTouch: boolean };
  scorePulse: number;
  best: number;
  muted: boolean;
  shake: number;
  stats: { games: number; delivered: number };
  banner: { text: string; t: number; max: number } | null;
  /** placement cooldown 0..1 (head queue slot dims while refilling) */
  cooldownFrac: number;
}

const WATER = SCORING.COLORS as unknown as string[];
const MUDDY = "#8d7a5f";

const ui = {
  bg0: "#0d1420",
  bg1: "#122036",
  tile: "#1b2a3d",
  tileEdge: "#0e1826",
  tileHi: "rgba(255,255,255,0.05)",
  ground: "#3d3428",
  groundHi: "#4a4032",
  pit: "#070b11",
  pipe: "#b8cfe0",
  pipeDark: "#5c7488",
  gold: "#ffd54f",
  stone: "#6b7686",
  stoneDark: "#3f4754",
  ink: "#e8f1f8",
  inkDim: "#8fa8bd",
  accent: "#7dd3fc",
  danger: "#f87171",
  good: "#4ade80",
  panel: "rgba(10,17,28,0.92)",
  line: "rgba(148,184,210,0.22)",
};

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  layout!: Layout;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticCtx: CanvasRenderingContext2D | null = null;
  private dirtyStatic = true;
  /** transient cell water activity for wave amplitude, 0..1 */
  private wave: Float32Array = new Float32Array(0);
  private waterLevel = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.resize();
  }

  markDirty(): void {
    this.dirtyStatic = true;
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    const margin = Math.max(10, Math.min(20, w * 0.03));
    const hudH = 58;
    const queueH = 86;
    const srcH = 24;
    const resH = 56;
    const gap = 8;
    const availW = w - margin * 2;
    const availH = h - hudH - queueH - srcH - resH - gap * 4 - margin;
    const cell = Math.max(18, Math.floor(Math.min(availW / COLS, availH / ROWS)));
    const gridW = cell * COLS;
    const gridH = cell * ROWS;
    const gridX = Math.round((w - gridW) / 2);
    const gridY = Math.round(hudH + gap);

    const resW = cell * 1.6;
    this.layout = {
      w,
      h,
      cell,
      gridX,
      gridY,
      gridW,
      gridH,
      hud: { x: margin, y: 8, w: w - margin * 2, h: hudH - 12 },
      floodBar: { x: margin, y: hudH - 6, w: w - margin * 2, h: 7 },
      queueSlots: [],
      buttons: {},
      reservoirs: [],
      sources: [],
    };

    // queue slots centered at the bottom
    const slot = Math.min(64, queueH - 22);
    const totalW = slot * PACING.QUEUE_SIZE + 14 * (PACING.QUEUE_SIZE - 1) + 44 * 2 + 16;
    let qx = Math.round((w - totalW) / 2);
    const qy = h - queueH + (queueH - slot) / 2 + 4;
    for (let i = 0; i < PACING.QUEUE_SIZE; i++) {
      this.layout.queueSlots.push({ x: qx, y: qy, w: slot, h: slot });
      qx += slot + 14;
    }
    this.layout.buttons.rotate = { x: qx + 6, y: qy + 6, w: 34, h: 34 };
    this.layout.buttons.swap = { x: qx + 6, y: qy + slot - 40, w: 34, h: 34 };
    this.layout.buttons.pause = { x: w - margin - 40, y: 10, w: 34, h: 30 };

    // sources above the grid, reservoirs below
    for (const col of SRC_COLS) {
      const cx = gridX + col * cell + cell / 2;
      this.layout.sources.push({ x: cx - cell * 0.35, y: gridY - srcH, w: cell * 0.7, h: srcH - 4 });
      this.layout.reservoirs.push({ x: cx - resW / 2, y: gridY + gridH + gap + 2, w: resW, h: resH - 6 });
    }

    if (this.wave.length !== COLS * ROWS) this.wave = new Float32Array(COLS * ROWS);
    this.staticLayer = null; // force rebuild at new size
    this.dirtyStatic = true;
  }

  /* ---------- geometry helpers ---------- */

  cellRect(col: number, row: number): Rect {
    const { gridX, gridY, cell } = this.layout;
    return { x: gridX + col * cell, y: gridY + row * cell, w: cell, h: cell };
  }

  cellAtPoint(x: number, y: number): { col: number; row: number } | null {
    const { gridX, gridY, cell } = this.layout;
    const col = Math.floor((x - gridX) / cell);
    const row = Math.floor((y - gridY) / cell);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return { col, row };
  }

  inRect(x: number, y: number, r: Rect): boolean {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /* ---------- static layer ---------- */

  private ensureStatic(vm: ViewModel): void {
    if (!this.dirtyStatic && this.staticLayer) return;
    const { w, h } = this.layout;
    if (!this.staticLayer) {
      this.staticLayer = document.createElement("canvas");
      this.staticCtx = this.staticLayer.getContext("2d");
    }
    this.staticLayer.width = Math.round(w * this.dpr);
    this.staticLayer.height = Math.round(h * this.dpr);
    const c = this.staticCtx!;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.paintStatic(c, vm);
    this.dirtyStatic = false;
  }

  private paintStatic(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const { w, h } = this.layout;
    // background: vertical twilight gradient + vignette
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, ui.bg1);
    g.addColorStop(0.55, ui.bg0);
    g.addColorStop(1, "#080d16");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);

    const v = c.createRadialGradient(w / 2, h * 0.42, h * 0.2, w / 2, h * 0.42, h * 0.75);
    v.addColorStop(0, "rgba(125,211,252,0.05)");
    v.addColorStop(1, "rgba(0,0,0,0.42)");
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);

    const board = vm.board;

    // grid tiles
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const cellObj = board.at(col, r)!;
        const rc = this.cellRect(col, r);
        const pad = 1.5;
        const x = rc.x + pad;
        const y = rc.y + pad;
        const s = rc.w - pad * 2;

        if (cellObj.terrain <= 0) {
          // collapsed pit
          c.fillStyle = ui.pit;
          this.rr(c, x, y, s, s, 4);
          c.fill();
          c.strokeStyle = "rgba(125,211,252,0.10)";
          c.lineWidth = 1;
          this.rr(c, x + 1, y + 1, s - 2, s - 2, 3);
          c.stroke();
        } else if (cellObj.kind !== null) {
          // paved cell — pipe drawn on top below
          c.fillStyle = ui.tile;
          this.rr(c, x, y, s, s, 4);
          c.fill();
          c.fillStyle = ui.tileHi;
          this.rr(c, x, y, s, s * 0.45, 4);
          c.fill();
          c.strokeStyle = ui.tileEdge;
          c.lineWidth = 1;
          this.rr(c, x, y, s, s, 4);
          c.stroke();
        } else {
          // bare ground, darker as it erodes
          const hp = cellObj.terrain;
          const max = BOARD.TERRAIN_HP + (r === 0 ? 2 : 0);
          const t = Math.max(0, Math.min(1, hp / max));
          c.fillStyle = lerpColor(ui.ground, ui.groundHi, t);
          this.rr(c, x, y, s, s, 4);
          c.fill();
          c.strokeStyle = ui.tileEdge;
          c.lineWidth = 1;
          this.rr(c, x, y, s, s, 4);
          c.stroke();
          // cracks appear as the ground weakens
          if (t < 0.75) {
            c.strokeStyle = "rgba(15,12,8,0.55)";
            c.lineWidth = 1.2;
            c.beginPath();
            const cx = x + s * 0.3;
            c.moveTo(cx, y + s * 0.12);
            c.lineTo(cx + s * 0.18, y + s * (0.35 + 0.3 * (1 - t)));
            if (t < 0.45) c.lineTo(cx + s * 0.05, y + s * 0.85);
            c.stroke();
          }
        }
      }
    }

    // pipes on paved cells
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const cellObj = board.at(col, r)!;
        if (cellObj.kind === null) continue;
        this.paintPipe(c, col, r, cellObj.kind as PipeKind, cellObj.rot, 1);
      }
    }

    // source mouths
    for (let i = 0; i < this.layout.sources.length; i++) {
      const rc = this.layout.sources[i];
      const color = WATER[board.sources[i].color] ?? WATER[0];
      c.fillStyle = ui.tileEdge;
      this.rr(c, rc.x, rc.y, rc.w, rc.h, 3);
      c.fill();
      c.fillStyle = color;
      this.rr(c, rc.x + rc.w * 0.28, rc.y + rc.h * 0.35, rc.w * 0.44, rc.h, 2);
      c.fill();
    }

    // reservoir frames
    for (const rc of this.layout.reservoirs) {
      c.fillStyle = "rgba(13,22,35,0.9)";
      this.rr(c, rc.x, rc.y, rc.w, rc.h, 6);
      c.fill();
      c.strokeStyle = ui.line;
      c.lineWidth = 1.5;
      this.rr(c, rc.x, rc.y, rc.w, rc.h, 6);
      c.stroke();
    }

    // bottom bar backdrop for the queue
    const barY = this.layout.queueSlots[0].y - 8;
    c.fillStyle = "rgba(9,15,25,0.72)";
    this.rr(c, 0, barY, w, h - barY, 0);
    c.fill();
  }

  /** draw a pipe body (no water) centered in its cell */
  private paintPipe(c: CanvasRenderingContext2D, col: number, row: number, kind: PipeKind, rot: number, alpha: number): void {
    this.paintPipeIn(c, this.cellRect(col, row), kind, rot, alpha);
  }

  /** draw a pipe body inside an arbitrary rect (queue previews, ghosts) */
  private paintPipeIn(c: CanvasRenderingContext2D, rc: Rect, kind: PipeKind, rot: number, alpha: number): void {
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const arm = rc.w / 2;
    const wPipe = rc.w * 0.3;

    c.save();
    c.globalAlpha = alpha;
    if (kind === "stone") {
      this.paintStoneAt(c, rc);
      c.restore();
      return;
    }

    const mask = maskOf(kind, rot);
    const goldPipe = kind === "gold";
    const body = goldPipe ? ui.gold : ui.pipe;

    c.lineCap = "round";
    // shadow
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = wPipe + 3;
    c.beginPath();
    this.tracePipe(c, cx, cy + 1.5, arm, mask);
    c.stroke();
    // body
    c.strokeStyle = body;
    c.lineWidth = wPipe;
    c.beginPath();
    this.tracePipe(c, cx, cy, arm, mask);
    c.stroke();
    // inner shading
    c.strokeStyle = "rgba(0,0,0,0.28)";
    c.lineWidth = wPipe * 0.45;
    c.beginPath();
    this.tracePipe(c, cx, cy, arm * 0.98, mask);
    c.stroke();
    // rim light
    c.strokeStyle = goldPipe ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.35)";
    c.lineWidth = wPipe * 0.16;
    c.beginPath();
    this.tracePipe(c, cx - 0.5, cy - wPipe * 0.22, arm, mask);
    c.stroke();
    c.restore();
  }

  /** trace pipe arms from center per mask */
  private tracePipe(c: CanvasRenderingContext2D, cx: number, cy: number, arm: number, mask: number): void {
    c.moveTo(cx, cy);
    if (mask & N) { c.lineTo(cx, cy - arm); c.moveTo(cx, cy); }
    if (mask & S) { c.lineTo(cx, cy + arm); c.moveTo(cx, cy); }
    if (mask & E) { c.lineTo(cx + arm, cy); c.moveTo(cx, cy); }
    if (mask & W) { c.lineTo(cx - arm, cy); }
  }

  /* ---------- dynamic layer ---------- */

  /** feed events so the renderer can bump wave activity */
  notifyEvents(events: GameEvent[]): void {
    for (const e of events) {
      const idx = e.row * COLS + e.col;
      if (e.row >= 0 && e.row < ROWS && e.col >= 0 && e.col < COLS) {
        if (e.type === "deliver" || e.type === "leak" || e.type === "collapse" || e.type === "place") {
          this.wave[idx] = 1;
        }
      }
    }
  }

  render(vm: ViewModel, dt: number): void {
    this.ensureStatic(vm);
    const c = this.ctx;
    const { w, h } = this.layout;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // screen shake
    if (vm.shake > 0.01) {
      const s = vm.shake * 6;
      c.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    c.drawImage(this.staticLayer!, 0, 0, w, h);

    // decay wave activity
    let totalWater = 0;
    for (let i = 0; i < this.wave.length; i++) {
      if (this.wave[i] > 0) this.wave[i] = Math.max(0, this.wave[i] - dt * 2.2);
    }

    this.paintWater(c, vm, (n) => { totalWater = n; });
    this.waterLevel = totalWater;
    this.paintSources(c, vm);
    this.paintReservoirs(c, vm);
    this.paintQueue(c, vm);
    this.paintHud(c, vm);
    this.paintParticlesLayer(c, vm);

    if (vm.screen === "title") this.paintTitle(c, vm);
    else if (vm.screen === "paused") this.paintPaused(c, vm);
    else if (vm.screen === "gameover") this.paintGameOver(c, vm);
    else this.paintCursor(c, vm);

    if (vm.banner) this.paintBanner(c, vm);
  }

  getWaterLevel(): number {
    return this.waterLevel;
  }

  /* water */

  private paintWater(c: CanvasRenderingContext2D, vm: ViewModel, setTotal: (n: number) => void): void {
    const { cell } = this.layout;
    const t = vm.time;
    let total = 0;
    const board = vm.board;
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const cellObj = board.at(col, r)!;
        if (cellObj.water <= 0.01) continue;
        total += cellObj.water;
        const rc = this.cellRect(col, r);
        const color = cellObj.color === -1 ? MUDDY : (WATER[cellObj.color] ?? WATER[0]);
        const level = cellObj.water;
        const energy = this.wave[r * COLS + col];

        if (cellObj.kind !== null) {
          this.paintPipeWater(c, rc, cellObj.kind as PipeKind, cellObj.rot, color, t);
        } else {
          // puddle with a wavy surface
          const pad = 3;
          const innerW = rc.w - pad * 2;
          const hMax = rc.h - pad * 2;
          const fillH = hMax * Math.min(1, level);
          const top = rc.y + rc.h - pad - fillH;
          const amp = (1.2 + energy * 2.2) * Math.min(1, level + 0.25);
          c.beginPath();
          c.moveTo(rc.x + pad, rc.y + rc.h - pad);
          c.lineTo(rc.x + pad, top);
          const steps = 5;
          for (let i = 1; i <= steps; i++) {
            const fx = rc.x + pad + (innerW * i) / steps;
            const fy = top + Math.sin(t * 5 + col * 1.7 + r * 0.9 + i * 1.3) * amp;
            c.lineTo(fx, fy);
          }
          c.lineTo(rc.x + rc.w - pad, rc.y + rc.h - pad);
          c.closePath();
          c.fillStyle = color;
          c.globalAlpha = 0.8;
          c.fill();
          c.globalAlpha = 0.35;
          c.strokeStyle = "#ffffff";
          c.lineWidth = 1;
          c.stroke();
          c.globalAlpha = 1;
        }
      }
    }
    setTotal(total / (COLS * ROWS));
  }

  /** animated water inside a pipe: fill + moving bright streaks along arms */
  private paintPipeWater(c: CanvasRenderingContext2D, rc: Rect, kind: PipeKind, rot: number, color: string, t: number): void {
    if (kind === "stone") return;
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2;
    const arm = rc.w / 2;
    const wPipe = rc.w * 0.3;
    const mask = maskOf(kind, rot);

    // inner fill
    c.save();
    c.lineCap = "round";
    c.strokeStyle = color;
    c.globalAlpha = 0.55;
    c.lineWidth = wPipe * 0.62;
    c.beginPath();
    this.tracePipe(c, cx, cy, arm * 0.92, mask);
    c.stroke();

    // moving streaks — two per arm, offset by time → constant visible flow
    c.globalAlpha = 0.85;
    c.strokeStyle = "#ffffff";
    c.lineWidth = wPipe * 0.14;
    const dirs: Array<[number, number]> = [];
    if (mask & N) dirs.push([0, -1]);
    if (mask & S) dirs.push([0, 1]);
    if (mask & E) dirs.push([1, 0]);
    if (mask & W) dirs.push([-1, 0]);
    c.beginPath();
    for (const [dx, dy] of dirs) {
      for (let k = 0; k < 2; k++) {
        const p = ((t * 0.9 + k * 0.5) % 1) * 0.8 + 0.08;
        const len = 0.16;
        const x0 = cx + dx * arm * p;
        const y0 = cy + dy * arm * p;
        c.moveTo(x0, y0);
        c.lineTo(x0 + dx * arm * len, y0 + dy * arm * len);
      }
    }
    c.stroke();
    c.restore();
  }

  private paintSources(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const t = vm.time;
    for (let i = 0; i < this.layout.sources.length; i++) {
      const rc = this.layout.sources[i];
      const color = WATER[vm.board.sources[i].color] ?? WATER[0];
      // animated stream into the cell below
      const below = vm.board.at(SRC_COLS[i], 0)!;
      if (below.terrain > 0 && below.water < BOARD.CAPACITY - 0.05) {
        const drop = ((t * 2.4 + i * 0.37) % 1);
        c.fillStyle = color;
        c.globalAlpha = 0.9;
        const dx = rc.x + rc.w / 2;
        c.beginPath();
        c.ellipse(dx, rc.y + rc.h + drop * rc.h * 0.9, 2.2, 3.2, 0, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
      }
      // color tag
      c.fillStyle = color;
      c.beginPath();
      c.arc(rc.x + rc.w / 2, rc.y - 5, 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  private paintReservoirs(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const board = vm.board;
    for (let i = 0; i < this.layout.reservoirs.length; i++) {
      const rc = this.layout.reservoirs[i];
      const res = board.reservoirs[i];
      const color = WATER[res.order] ?? WATER[0];
      const pad = 5;
      const frac = Math.min(1, res.fill / res.capacity);
      const innerH = rc.h - pad * 2 - 12;

      // fill
      if (frac > 0.01) {
        const fh = innerH * frac;
        c.fillStyle = color;
        c.globalAlpha = 0.85;
        this.rr(c, rc.x + pad, rc.y + rc.h - 12 - fh, rc.w - pad * 2, fh, 3);
        c.fill();
        c.globalAlpha = 1;
      }
      // order chip: which color this reservoir wants
      c.fillStyle = color;
      c.beginPath();
      c.arc(rc.x + rc.w / 2, rc.y + 8, 4.5, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,0.55)";
      c.lineWidth = 1;
      c.stroke();

      // pulse ring after delivery
      if (res.pulse > 0.01) {
        c.strokeStyle = color;
        c.globalAlpha = res.pulse * 0.7;
        c.lineWidth = 2;
        c.beginPath();
        c.arc(rc.x + rc.w / 2, rc.y + rc.h / 2, (rc.w / 2) * (1.1 + (1 - res.pulse) * 0.7), 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }

      // capacity ticks
      c.fillStyle = ui.inkDim;
      c.font = "9px ui-sans-serif, system-ui";
      c.textAlign = "center";
      c.fillText(`${Math.floor(res.fill)}/${Math.ceil(res.capacity)}`, rc.x + rc.w / 2, rc.y + rc.h - 2);
    }
  }

  private paintQueue(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const board = vm.board;
    for (let i = 0; i < this.layout.queueSlots.length; i++) {
      const rc = this.layout.queueSlots[i];
      c.fillStyle = i === 0 ? "rgba(125,211,252,0.10)" : "rgba(20,32,50,0.85)";
      this.rr(c, rc.x, rc.y, rc.w, rc.h, 10);
      c.fill();
      c.strokeStyle = i === 0 ? ui.accent : ui.line;
      c.lineWidth = i === 0 ? 2 : 1.5;
      this.rr(c, rc.x, rc.y, rc.w, rc.h, 10);
      c.stroke();

      const piece = board.queue[i];
      if (piece) {
        // mini pipe preview inside the slot (head slot bigger)
        const scale = i === 0 ? 0.72 : 0.5;
        const size = rc.w * scale;
        const fx = rc.x + rc.w / 2 - size / 2;
        const fy = rc.y + rc.h / 2 - size / 2;
        c.save();
        c.beginPath();
        this.rr(c, rc.x + 2, rc.y + 2, rc.w - 4, rc.h - 4, 8);
        c.clip();
        this.paintPipeIn(c, { x: fx, y: fy, w: size, h: size }, piece.kind, piece.rot, i === 0 ? 1 : 0.85);
        c.restore();
        if (piece.kind === "gold") {
          c.fillStyle = ui.gold;
          c.font = "bold 9px ui-sans-serif, system-ui";
          c.textAlign = "right";
          c.fillText("×2", rc.x + rc.w - 5, rc.y + 12);
        }
      }

      // cooldown veil over the head slot
      if (vm.cooldownFrac > 0.01) {
        const h = rc.h * vm.cooldownFrac;
        c.fillStyle = "rgba(5,9,15,0.55)";
        c.fillRect(rc.x, rc.y + rc.h - h, rc.w, h);
      }
    }

    // side buttons
    this.paintIconButton(c, this.layout.buttons.rotate, "⟳");
    this.paintIconButton(c, this.layout.buttons.swap, "⇄");
  }

  private paintStoneAt(c: CanvasRenderingContext2D, rc: Rect): void {
    const pad = rc.w * 0.08;
    const grd = c.createLinearGradient(rc.x, rc.y, rc.x, rc.y + rc.h);
    grd.addColorStop(0, ui.stone);
    grd.addColorStop(1, ui.stoneDark);
    c.fillStyle = grd;
    this.rr(c, rc.x + pad, rc.y + pad, rc.w - pad * 2, rc.h - pad * 2, 6);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.12)";
    this.rr(c, rc.x + pad + 3, rc.y + pad + 3, rc.w - pad * 2 - 6, (rc.h - pad * 2) * 0.3, 5);
    c.fill();
  }

  private paintIconButton(c: CanvasRenderingContext2D, rc: Rect, glyph: string): void {
    c.fillStyle = "rgba(20,32,50,0.9)";
    this.rr(c, rc.x, rc.y, rc.w, rc.h, 9);
    c.fill();
    c.strokeStyle = ui.line;
    c.lineWidth = 1.5;
    this.rr(c, rc.x, rc.y, rc.w, rc.h, 9);
    c.stroke();
    c.fillStyle = ui.ink;
    c.font = "20px ui-sans-serif, system-ui";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(glyph, rc.x + rc.w / 2, rc.y + rc.h / 2 + 1);
    c.textBaseline = "alphabetic";
  }

  private paintHud(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const board = vm.board;
    const hud = this.layout.hud;
    // score with pop
    const pop = 1 + vm.scorePulse * 0.35;
    c.save();
    c.translate(hud.x + 4, hud.y + hud.h / 2);
    c.scale(pop, pop);
    c.fillStyle = ui.inkDim;
    c.font = "600 10px ui-sans-serif, system-ui";
    c.textAlign = "left";
    c.fillText("СЧЁТ", 0, -12);
    c.fillStyle = ui.ink;
    c.font = "800 26px ui-sans-serif, system-ui";
    c.fillText(String(Math.floor(board.score)), 0, 14);
    c.restore();

    // level badge
    c.textAlign = "center";
    c.fillStyle = ui.inkDim;
    c.font = "600 10px ui-sans-serif, system-ui";
    c.fillText("УРОВЕНЬ", hud.x + hud.w / 2, hud.y + 8);
    c.fillStyle = ui.accent;
    c.font = "800 22px ui-sans-serif, system-ui";
    c.fillText(String(board.level), hud.x + hud.w / 2, hud.y + 30);

    // combo flame
    if (board.combo >= 2) {
      const mult = Math.min(1 + board.combo * PACING.COMBO_STEP, PACING.COMBO_CAP);
      c.fillStyle = "#fbbf24";
      c.font = "800 15px ui-sans-serif, system-ui";
      c.fillText(`КОМБО ×${mult.toFixed(1)}`, hud.x + hud.w / 2, hud.y + 47);
    }

    // pause button (top-right)
    this.paintIconButton(c, this.layout.buttons.pause, "Ⅱ");

    // flood meter
    const fb = this.layout.floodBar;
    const frac = Math.min(1, board.flood / PACING.FLOOD_MAX);
    c.fillStyle = "rgba(15,24,38,0.9)";
    this.rr(c, fb.x, fb.y, fb.w, fb.h, fb.h / 2);
    c.fill();
    if (frac > 0.005) {
      const danger = frac > 0.6;
      c.fillStyle = danger ? ui.danger : "#38bdf8";
      this.rr(c, fb.x, fb.y, fb.w * frac, fb.h, fb.h / 2);
      c.fill();
      if (danger && Math.sin(vm.time * 8) > 0) {
        c.strokeStyle = "rgba(248,113,113,0.8)";
        c.lineWidth = 1.5;
        this.rr(c, fb.x - 1, fb.y - 1, fb.w + 2, fb.h + 2, fb.h / 2);
        c.stroke();
      }
    }
    c.fillStyle = ui.inkDim;
    c.font = "600 9px ui-sans-serif, system-ui";
    c.textAlign = "left";
    c.fillText("ПАВОДОК", fb.x, fb.y + fb.h + 9);
    c.textAlign = "right";
    c.fillText(`${Math.round(frac * 100)}%`, fb.x + fb.w, fb.y + fb.h + 9);
  }

  private paintParticlesLayer(c: CanvasRenderingContext2D, vm: ViewModel): void {
    vm.particles.pool.each((p) => {
      c.globalAlpha = Math.max(0, Math.min(1, (p.life / p.maxLife) * 1.2));
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      c.fill();
    });
    c.globalAlpha = 1;
    vm.particles.texts.each((t) => {
      const a = Math.min(1, (t.life / t.maxLife) * 1.6);
      c.globalAlpha = a;
      c.font = `800 ${t.size}px ui-sans-serif, system-ui`;
      c.textAlign = "center";
      c.strokeStyle = "rgba(0,0,0,0.55)";
      c.lineWidth = 3;
      c.strokeText(t.text, t.x, t.y);
      c.fillStyle = t.color;
      c.fillText(t.text, t.x, t.y);
    });
    c.globalAlpha = 1;
  }

  /* cursor + ghost (playing) */

  private paintCursor(c: CanvasRenderingContext2D, vm: ViewModel): void {
    let target: { col: number; row: number } | null = null;
    if (vm.pointer.active && !vm.pointer.isTouch) {
      target = this.cellAtPoint(vm.pointer.x, vm.pointer.y);
    }
    if (!target && vm.cursor.visible) {
      target = { col: vm.cursor.col, row: vm.cursor.row };
    }
    if (!target) return;
    const rc = this.cellRect(target.col, target.row);

    // hover highlight
    const cell = vm.board.at(target.col, target.row)!;
    const ok = cell.kind === null && cell.terrain > 0;
    c.strokeStyle = ok ? ui.accent : "rgba(248,113,113,0.7)";
    c.lineWidth = 2;
    this.rr(c, rc.x + 1.5, rc.y + 1.5, rc.w - 3, rc.h - 3, 5);
    c.stroke();

    // ghost of the queue head
    if (ok && vm.screen === "playing") {
      const piece = vm.board.queue[0];
      if (piece && piece.kind !== "stone") {
        this.paintPipe(c, target.col, target.row, piece.kind, piece.rot, 0.45);
      }
    }
  }

  /* ---------- screens ---------- */

  private overlay(c: CanvasRenderingContext2D): void {
    c.fillStyle = "rgba(6,10,17,0.78)";
    c.fillRect(0, 0, this.layout.w, this.layout.h);
  }

  private paintTitle(c: CanvasRenderingContext2D, vm: ViewModel): void {
    this.overlay(c);
    const cx = this.layout.w / 2;
    const cy = this.layout.h * 0.34;
    c.textAlign = "center";
    c.fillStyle = ui.accent;
    c.font = "800 44px ui-sans-serif, system-ui";
    c.fillText("ПЛОТИНА", cx, cy);
    c.fillStyle = ui.inkDim;
    c.font = "500 14px ui-sans-serif, system-ui";
    c.fillText("направляй воду, не дай земле размыться", cx, cy + 28);

    c.font = "500 13px ui-sans-serif, system-ui";
    c.fillStyle = ui.ink;
    c.fillText(`рекорд: ${vm.best}`, cx, cy + 62);
    if (vm.stats.games > 0) {
      c.fillStyle = ui.inkDim;
      c.fillText(`всего игр: ${vm.stats.games} · собрано воды: ${Math.floor(vm.stats.delivered)}`, cx, cy + 82);
    }

    this.paintBigButton(c, this.titleButtons()[0], vm.time);
    c.fillStyle = ui.inkDim;
    c.font = "500 12px ui-sans-serif, system-ui";
    c.fillText("тап — поставить · тап по трубе — повернуть · двойной тап — убрать", cx, cy + 186);
    c.fillText("вода того же цвета, что кружок резервуара, — за полную цену", cx, cy + 204);
    c.fillText("WASD — курсор · Пробел — ставить · R — повернуть · Q — обмен", cx, cy + 222);
  }

  titleButtons(): ButtonSpec[] {
    const cx = this.layout.w / 2;
    return [{ id: "start", rect: { x: cx - 110, y: this.layout.h * 0.34 + 108, w: 220, h: 52 }, label: "ИГРАТЬ", primary: true }];
  }

  pausedButtons(): ButtonSpec[] {
    const cx = this.layout.w / 2;
    return [
      { id: "resume", rect: { x: cx - 110, y: this.layout.h * 0.42, w: 220, h: 50 }, label: "ПРОДОЛЖИТЬ", primary: true },
      { id: "restart", rect: { x: cx - 110, y: this.layout.h * 0.42 + 62, w: 220, h: 46 }, label: "ЗАНОВО" },
      { id: "mute", rect: { x: cx - 110, y: this.layout.h * 0.42 + 120, w: 220, h: 46 }, label: "ЗВУК: ВКЛ" },
    ];
  }

  gameoverButtons(): ButtonSpec[] {
    const cx = this.layout.w / 2;
    return [{ id: "restart", rect: { x: cx - 110, y: this.layout.h * 0.52 + 96, w: 220, h: 52 }, label: "ЕЩЁ РАЗ", primary: true }];
  }

  private paintPaused(c: CanvasRenderingContext2D, vm: ViewModel): void {
    this.overlay(c);
    const cx = this.layout.w / 2;
    c.textAlign = "center";
    c.fillStyle = ui.ink;
    c.font = "800 34px ui-sans-serif, system-ui";
    c.fillText("ПАУЗА", cx, this.layout.h * 0.42 - 24);
    const btns = this.pausedButtons();
    btns[2].label = vm.muted ? "ЗВУК: ВЫКЛ" : "ЗВУК: ВКЛ";
    for (const b of btns) this.paintBigButton(c, b, vm.time);
  }

  private paintGameOver(c: CanvasRenderingContext2D, vm: ViewModel): void {
    this.overlay(c);
    const cx = this.layout.w / 2;
    const board = vm.board;
    const isRecord = Math.floor(board.score) > vm.best && vm.best > 0;
    c.textAlign = "center";
    c.fillStyle = ui.danger;
    c.font = "800 34px ui-sans-serif, system-ui";
    c.fillText("ПЛОТИНА ПРОРВАЛА", cx, this.layout.h * 0.30);
    c.fillStyle = ui.ink;
    c.font = "800 40px ui-sans-serif, system-ui";
    c.fillText(String(Math.floor(board.score)), cx, this.layout.h * 0.30 + 52);
    c.font = "500 14px ui-sans-serif, system-ui";
    c.fillStyle = ui.inkDim;
    c.fillText(`уровень ${board.level} · собрано ${Math.floor(board.delivered)} воды · потеряно ${Math.floor(board.leaked)}`, cx, this.layout.h * 0.30 + 80);
    if (isRecord) {
      c.fillStyle = ui.gold;
      c.font = "800 17px ui-sans-serif, system-ui";
      c.fillText("НОВЫЙ РЕКОРД!", cx, this.layout.h * 0.30 + 110);
    } else {
      c.fillText(`рекорд: ${vm.best}`, cx, this.layout.h * 0.30 + 110);
    }
    for (const b of this.gameoverButtons()) this.paintBigButton(c, b, vm.time);
  }

  private paintBigButton(c: CanvasRenderingContext2D, b: ButtonSpec, t: number): void {
    const breathe = b.primary ? 1 + Math.sin(t * 3) * 0.012 : 1;
    const cx = b.rect.x + b.rect.w / 2;
    const cy = b.rect.y + b.rect.h / 2;
    c.save();
    c.translate(cx, cy);
    c.scale(breathe, breathe);
    c.translate(-cx, -cy);
    c.fillStyle = b.primary ? ui.accent : "rgba(30,46,68,0.95)";
    this.rr(c, b.rect.x, b.rect.y, b.rect.w, b.rect.h, 14);
    c.fill();
    if (b.primary) {
      c.strokeStyle = "rgba(255,255,255,0.35)";
      c.lineWidth = 1.5;
      this.rr(c, b.rect.x + 1, b.rect.y + 1, b.rect.w - 2, b.rect.h - 2, 13);
      c.stroke();
    }
    c.fillStyle = b.primary ? "#06202e" : ui.ink;
    c.font = "800 18px ui-sans-serif, system-ui";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(b.label, cx, cy + 1);
    c.textBaseline = "alphabetic";
    c.restore();
  }

  private paintBanner(c: CanvasRenderingContext2D, vm: ViewModel): void {
    const b = vm.banner!;
    const a = Math.min(1, (b.t / b.max) * 4) * Math.min(1, b.t * 3);
    const cx = this.layout.w / 2;
    const y = this.layout.gridY + this.layout.gridH * 0.3;
    c.globalAlpha = a;
    c.font = "800 30px ui-sans-serif, system-ui";
    c.textAlign = "center";
    c.strokeStyle = "rgba(0,0,0,0.6)";
    c.lineWidth = 5;
    c.strokeText(b.text, cx, y);
    c.fillStyle = ui.gold;
    c.fillText(b.text, cx, y);
    c.globalAlpha = 1;
  }

  /* util */

  private rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `rgb(${r},${g},${bl})`;
}
