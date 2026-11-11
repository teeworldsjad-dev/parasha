/**
 * game.ts — «Плотина» orchestration: state machine, input (pointer + keyboard),
 * flow-tick scheduling, event → juice processing, HUD animations, persistence.
 * Rendering is renderer.ts; simulation is board.ts.
 */

import { Board } from "./board";
import { BOARD, QUALITY, SCORING } from "./config";
import { AudioSystem } from "./audio";
import { GameLoop } from "./engine";
import { Particles } from "./particles";
import { Renderer, type ButtonSpec, type ViewModel, type GameScreen } from "./renderer";
import { GameStateMachine } from "./state";
import { storage } from "./storage";
import { hapticImpact, hapticNotify, initTelegram } from "./telegram";
import { type GameEvent } from "./types";

const { COLS, ROWS } = BOARD;

interface Stats {
  games: number;
  delivered: number;
  best: number;
  bestLevel: number;
}

const STATS_KEY = "plotina.stats.v1";

function loadStats(): Stats {
  const s = storage.get<Partial<Stats>>(STATS_KEY, {});
  return {
    games: typeof s.games === "number" ? s.games : 0,
    delivered: typeof s.delivered === "number" ? s.delivered : 0,
    best: typeof s.best === "number" ? s.best : 0,
    bestLevel: typeof s.bestLevel === "number" ? s.bestLevel : 0,
  };
}

export class Game {
  private renderer: Renderer;
  private board: Board;
  private particles: Particles;
  private audio = new AudioSystem();
  private fsm = new GameStateMachine();
  private loop: GameLoop;

  private stats: Stats = loadStats();
  private time = 0;
  private flowTimer = 0;
  private startGrace = 2.2; // calm seconds before the first flow tick
  private placeTimer = 0; // placement cooldown — one piece per fraction of a flow tick
  private scorePulse = 0;
  private shake = 0;
  private banner: { text: string; t: number; max: number } | null = null;
  private events: GameEvent[] = [];
  private lastErodeSfx = 0;
  private ambienceTimer = 0;

  private cursor = { col: 3, row: 4, visible: false };
  private pointer = { x: 0, y: 0, active: false, isTouch: false };
  private lastTap = { t: -1, col: -1, row: -1 };

  // fps watchdog → particle quality tier
  private fpsAccum = 0;
  private fpsFrames = 0;
  private lowFpsTime = 0;
  private qualityLow = false;

  private unsubscribe: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement) {
    initTelegram();
    this.renderer = new Renderer(canvas);
    this.board = new Board((Date.now() % 2147483647) | 0);
    this.particles = new Particles(QUALITY.PARTICLES_HIGH);
    this.loop = new GameLoop({ update: (dt) => this.update(dt), render: () => this.render() });
    this.bindInput(canvas);
    this.fsm.onChange((s) => this.onStateChange(s));
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.audio.dispose();
  }

  /* ---------------- input ---------------- */

  private on<T extends Event>(el: Window | Document | HTMLElement, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions): void {
    const handler = fn as EventListener;
    el.addEventListener(type, handler, opts);
    this.unsubscribe.push(() => el.removeEventListener(type, handler, opts));
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    this.on<PointerEvent>(canvas, "pointerdown", (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.active = true;
      this.pointer.isTouch = e.pointerType === "touch";
      canvas.setPointerCapture?.(e.pointerId);
      this.audio.startAmbience();
    });
    this.on<PointerEvent>(canvas, "pointermove", (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.active = true;
      this.pointer.isTouch = e.pointerType === "touch";
    });
    this.on<PointerEvent>(canvas, "pointerup", (e) => {
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
      this.pointer.active = false;
      this.handleTap(e.clientX, e.clientY);
    });
    this.on<PointerEvent>(canvas, "pointercancel", () => {
      this.pointer.active = false;
    });
    this.on(canvas, "contextmenu", (e) => e.preventDefault());

    this.on<KeyboardEvent>(window, "keydown", (e) => {
      if (e.repeat) return;
      this.audio.startAmbience();
      const k = e.code;
      if (k === "KeyM") {
        this.toggleMute();
        return;
      }
      if (this.fsm.is("title")) {
        if (k === "Space" || k === "Enter") {
          e.preventDefault();
          this.startRun();
        }
        return;
      }
      if (this.fsm.is("gameover")) {
        if (k === "Space" || k === "Enter" || k === "KeyR") {
          e.preventDefault();
          this.startRun();
        }
        return;
      }
      if (k === "Escape" || k === "KeyP") {
        this.togglePause();
        return;
      }
      if (this.fsm.is("paused")) return;

      // playing — keyboard cursor control
      let moved = false;
      if (k === "KeyW" || k === "ArrowUp") {
        this.cursor.row = Math.max(0, this.cursor.row - 1);
        moved = true;
      } else if (k === "KeyS" || k === "ArrowDown") {
        this.cursor.row = Math.min(ROWS - 1, this.cursor.row + 1);
        moved = true;
      } else if (k === "KeyA" || k === "ArrowLeft") {
        this.cursor.col = Math.max(0, this.cursor.col - 1);
        moved = true;
      } else if (k === "KeyD" || k === "ArrowRight") {
        this.cursor.col = Math.min(COLS - 1, this.cursor.col + 1);
        moved = true;
      }
      if (moved) {
        this.cursor.visible = true;
        e.preventDefault();
        return;
      }
      if (k === "Space" || k === "Enter") {
        e.preventDefault();
        this.tryPlace(this.cursor.col, this.cursor.row);
      } else if (k === "KeyR") {
        this.rotateHead();
      } else if (k === "KeyQ") {
        this.swapQueue();
      } else if (k === "KeyX" || k === "Backspace") {
        this.removeAt(this.cursor.col, this.cursor.row);
      }
    });

    this.on(window, "resize", () => {
      this.renderer.resize();
      this.renderer.markDirty();
    });
    this.on(document, "visibilitychange", () => {
      if (document.hidden && this.fsm.is("playing")) this.fsm.transition("paused");
    });
  }

  private screenButtons(): ButtonSpec[] {
    switch (this.fsm.state as GameScreen) {
      case "title":
        return this.renderer.titleButtons();
      case "paused":
        return this.renderer.pausedButtons();
      case "gameover":
        return this.renderer.gameoverButtons();
      default:
        return [];
    }
  }

  private handleTap(x: number, y: number): void {
    // screen buttons first
    for (const b of this.screenButtons()) {
      if (this.renderer.inRect(x, y, b.rect)) {
        this.audio.sfx("ui");
        hapticImpact("light");
        if (b.id === "start" || b.id === "restart") this.startRun();
        else if (b.id === "resume") this.fsm.transition("playing");
        else if (b.id === "mute") this.toggleMute();
        return;
      }
    }

    if (!this.fsm.is("playing")) return;

    // HUD buttons
    const L = this.renderer.layout;
    if (this.renderer.inRect(x, y, L.buttons.pause)) {
      this.fsm.transition("paused");
      this.audio.sfx("ui");
      return;
    }
    if (this.renderer.inRect(x, y, L.buttons.rotate)) {
      this.rotateHead();
      return;
    }
    if (this.renderer.inRect(x, y, L.buttons.swap)) {
      this.swapQueue();
      return;
    }

    const cell = this.renderer.cellAtPoint(x, y);
    if (!cell) return;

    const now = this.time;
    const isDouble = now - this.lastTap.t < 0.3 && this.lastTap.col === cell.col && this.lastTap.row === cell.row;

    if (isDouble) {
      this.lastTap.t = -1;
      this.removeAt(cell.col, cell.row);
      return;
    }
    this.lastTap = { t: now, col: cell.col, row: cell.row };

    const target = this.board.at(cell.col, cell.row)!;
    if (target.kind !== null) {
      this.board.rotateAt(cell.col, cell.row); // sfx comes through the event
    } else {
      this.tryPlace(cell.col, cell.row);
    }
  }

  /* ---------------- actions ---------------- */

  private tryPlace(col: number, row: number): boolean {
    if (this.placeTimer > 0 && this.startGrace <= 0) {
      this.audio.sfx("deny");
      return false;
    }
    const ok = this.board.place(col, row);
    if (ok) {
      this.renderer.markDirty();
      this.placeTimer = this.board.flowTick * 0.7;
    }
    return ok;
  }

  private rotateHead(): void {
    if (this.board.rotateQueueHead()) {
      this.audio.sfx("rotate");
      hapticImpact("light");
    }
  }

  private swapQueue(): void {
    if (this.board.swapQueue()) {
      this.audio.sfx("swap");
      hapticImpact("light");
    }
  }

  private removeAt(col: number, row: number): void {
    if (this.board.removeAt(col, row)) this.renderer.markDirty();
  }

  private togglePause(): void {
    if (this.fsm.is("playing")) {
      this.fsm.transition("paused");
      this.audio.sfx("ui");
    } else if (this.fsm.is("paused")) {
      this.fsm.transition("playing");
      this.audio.sfx("ui");
    }
  }

  private toggleMute(): void {
    const muted = this.audio.toggleMute();
    this.bannerMsg(muted ? "ЗВУК ВЫКЛ" : "ЗВУК ВКЛ", 0.9);
  }

  private startRun(): void {
    this.board.reset((Date.now() % 2147483647) | 0);
    this.particles.clear();
    this.renderer.markDirty();
    this.flowTimer = 0;
    this.startGrace = 2.2;
    this.placeTimer = 0;
    this.banner = null;
    this.shake = 0;
    this.scorePulse = 0;
    this.stats.games++;
    this.saveStats();
    if (this.fsm.is("title") || this.fsm.is("gameover")) this.fsm.transition("playing");
    else if (this.fsm.is("paused")) {
      this.fsm.transition("playing");
    }
    this.audio.startAmbience();
    this.audio.sfx("levelup");
  }

  private endRun(): void {
    const score = Math.floor(this.board.score);
    if (score > this.stats.best) this.stats.best = score;
    this.stats.bestLevel = Math.max(this.stats.bestLevel, this.board.level);
    this.saveStats();
    this.audio.sfx("lose");
    hapticNotify("error");
  }

  private saveStats(): void {
    storage.set(STATS_KEY, this.stats);
  }

  private onStateChange(s: string): void {
    if (s === "gameover") {
      this.banner = null;
      this.endRun();
    }
  }

  private bannerMsg(text: string, duration = 1.6): void {
    this.banner = { text, t: duration, max: duration };
  }

  /* ---------------- loop ---------------- */

  private update(dt: number): void {
    this.time += dt;

    // fps watchdog
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      const fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      if (this.fsm.is("playing")) {
        if (fps < QUALITY.DEGRADE_FPS) this.lowFpsTime += 0.5;
        else this.lowFpsTime = Math.max(0, this.lowFpsTime - 0.5);
        if (this.lowFpsTime >= 2 && !this.qualityLow) {
          this.qualityLow = true;
          this.particles = new Particles(QUALITY.PARTICLES_LOW);
        }
      }
    }

    if (this.scorePulse > 0) this.scorePulse = Math.max(0, this.scorePulse - dt * 3);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.4);
    if (this.banner) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.banner = null;
    }

    // reservoir pulse decay (visual only)
    for (const res of this.board.reservoirs) {
      if (res.pulse > 0) res.pulse = Math.max(0, res.pulse - dt * 2);
    }

    this.particles.update(dt);

    if (this.fsm.is("playing")) {
      if (this.placeTimer > 0) this.placeTimer -= dt;
      if (this.startGrace > 0) {
        this.startGrace -= dt;
      } else {
        this.flowTimer += dt;
        while (this.flowTimer >= this.board.flowTick) {
          this.flowTimer -= this.board.flowTick;
          this.board.flowStep();
        }
      }
      this.processEvents();
      // belt-and-braces: never stay in "playing" with a dead board even if the
      // gameover event was dropped (event pool exhausted under extreme burst load)
      if (this.board.gameOver) this.fsm.transition("gameover");
      this.ambienceTimer += dt;
      if (this.ambienceTimer > 0.25) {
        this.ambienceTimer = 0;
        this.audio.setAmbience(this.renderer.getWaterLevel());
      }
    }
  }

  private render(): void {
    if (!window.__GAME_READY__) window.__GAME_READY__ = true;
    const vm: ViewModel = {
      board: this.board,
      particles: this.particles,
      screen: this.fsm.state as GameScreen,
      time: this.time,
      cursor: this.cursor,
      pointer: this.pointer,
      scorePulse: this.scorePulse,
      best: this.stats.best,
      muted: this.audio.muted,
      shake: this.shake,
      stats: { games: this.stats.games, delivered: this.stats.delivered },
      banner: this.banner,
      cooldownFrac: this.startGrace > 0 ? 0 : Math.max(0, Math.min(1, this.placeTimer / (this.board.flowTick * 0.7))),
    };
    this.renderer.render(vm, 1 / 60);
  }

  /* ---------------- event juice ---------------- */

  private processEvents(): void {
    this.board.drainEvents(this.events);
    if (this.events.length === 0) return;
    this.renderer.notifyEvents(this.events);

    for (const e of this.events) {
      const rc = e.row >= 0 && e.row < ROWS && e.col >= 0 && e.col < COLS
        ? this.renderer.cellRect(e.col, e.row)
        : null;
      const cx = rc ? rc.x + rc.w / 2 : this.renderer.layout.w / 2;
      const cy = rc ? rc.y + rc.h / 2 : this.renderer.layout.h / 2;
      const color = e.color >= 0 ? SCORING.COLORS[e.color] ?? "#4fc3f7" : "#8d7a5f";

      switch (e.type) {
        case "place":
          this.audio.sfx("place");
          hapticImpact("light");
          this.renderer.markDirty();
          break;
        case "rotate":
          if (e.col >= 0) {
            this.audio.sfx("rotate");
            hapticImpact("light");
          }
          break;
        case "remove":
          this.audio.sfx("remove");
          this.renderer.markDirty();
          break;
        case "swap":
          this.audio.sfx("swap");
          break;
        case "deny":
          this.audio.sfx("deny");
          break;
        case "deliver": {
          const res = this.renderer.layout.reservoirs.find((r) => Math.abs(r.x + r.w / 2 - cx) < 4) ?? this.renderer.layout.reservoirs[0];
          const px = res ? res.x + res.w / 2 : cx;
          const py = res ? res.y : cy;
          const mismatch = e.color === -3;
          this.particles.burst(px, py, mismatch ? "#7a93ad" : color, this.qualityLow ? 5 : 10, () => this.board.rng.next(), 80);
          this.audio.sfx("deliver", e.combo);
          this.scorePulse = 1;
          const pts = Math.round(e.amount);
          if (mismatch) {
            this.particles.text(px, py - 8, `ПЕРЕЛИВ +${pts}`, "#f87171", 12);
          } else {
            this.particles.text(px, py - 8, `+${pts}`, e.color === -1 ? "#c9b99a" : color, e.combo > 2 ? 17 : 13);
          }
          break;
        }
        case "order": {
          this.bannerMsg(`ЗАКАЗ ВЫПОЛНЕН +${Math.round(e.amount)}`);
          this.audio.sfx("order");
          hapticNotify("success");
          this.scorePulse = 1;
          this.shake = Math.min(1, this.shake + 0.25);
          break;
        }
        case "leak":
          if (rc) this.particles.burst(cx, cy, "#7a93ad", this.qualityLow ? 3 : 7, () => this.board.rng.next(), 110);
          this.shake = Math.min(1, this.shake + (e.color === -1 ? 0.45 : 0.18));
          if (e.color === -1) {
            this.audio.sfx("leak");
            hapticImpact("medium");
            if (rc) this.particles.text(cx, cy, "ПРОТЕЧКА!", "#f87171", 14);
          } else if (this.time - this.lastErodeSfx > 0.4) {
            this.audio.sfx("leak");
            this.lastErodeSfx = this.time;
          }
          break;
        case "erode":
          if (this.time - this.lastErodeSfx > 0.25) {
            this.audio.sfx("erode");
            this.lastErodeSfx = this.time;
          }
          this.renderer.markDirty();
          break;
        case "collapse":
          if (rc) this.particles.rubble(cx, cy, this.qualityLow ? 6 : 14, () => this.board.rng.next());
          this.audio.sfx("collapse");
          hapticImpact("heavy");
          this.shake = Math.min(1, this.shake + 0.6);
          this.renderer.markDirty();
          break;
        case "levelup":
          this.bannerMsg(e.level === 2 ? "ЗАКАЗЫ ИЗМЕНИЛИСЬ!" : `УРОВЕНЬ ${e.level}`);
          this.audio.sfx("levelup");
          hapticNotify("success");
          break;
        case "gameover": {
          this.stats.delivered += Math.floor(this.board.delivered);
          this.saveStats();
          this.fsm.transition("gameover");
          break;
        }
      }
    }
  }

  /** direction probe for scripts/verify-game.mjs: the keyboard cursor is the player position */
  probe(): { x: number; y: number; z: number } {
    return { x: this.cursor.col, y: 0, z: this.cursor.row };
  }

  /** debug/testing hook: number of live particles */
  debugStats(): { fps: number; qualityLow: boolean } {
    return { fps: this.fpsFrames > 0 ? Math.round(1 / (this.fpsAccum / Math.max(1, this.fpsFrames))) : 0, qualityLow: this.qualityLow };
  }

  /** automation/testing hook — no visible traces in normal play */
  debugApi(): Record<string, unknown> {
    return {
      board: this.board,
      renderer: this.renderer,
      state: () => this.fsm.state,
      start: () => this.startRun(),
      place: (c: number, r: number) => this.tryPlace(c, r),
      rotateAt: (c: number, r: number) => this.board.rotateAt(c, r),
      rotateHead: () => this.rotateHead(),
      tick: (n: number) => {
        for (let i = 0; i < n; i++) this.board.flowStep();
      },
      flood: () => this.board.flood,
      score: () => this.board.score,
    };
  }
}
