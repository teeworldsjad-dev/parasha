/**
 * board.ts — «Плотина» simulation core: grid, gravity water flow with backpressure,
 * terrain erosion, reservoirs/orders, combo, flood meter, levels.
 *
 * Pure logic + pooled events; all drawing lives in renderer.ts. Runs on the fixed
 * timestep: game.ts calls flowStep() every flowTick seconds.
 */

import { BOARD, PACING, SCORING, WEAR } from "./config";
import { dealPiece, maskOf, rotatePiece, isFixed, type Piece } from "./pieces";
import { Rng } from "./rng";
import { Pool, N, E, S, W, type Cell, type GameEvent, type PipeKind, type Reservoir, type Source } from "./types";

const { COLS, ROWS, SRC_COLS, CAPACITY, FLOW_RATE, ERODE_RATE } = BOARD;

export class Board {
  cells: Cell[] = [];
  sources: Source[] = [];
  reservoirs: Reservoir[] = [];
  queue: Piece[] = [];

  score = 0;
  level = 1;
  combo = 0;
  flood = 0;
  delivered = 0;
  leaked = 0;
  gameOver = false;

  /** seconds between flow ticks (shrinks with level) */
  flowTick: number = PACING.FLOW_TICK_START;

  private events = new Pool<GameEvent>(
    () => ({
      alive: false, type: "place", col: 0, row: 0, amount: 0, color: -2, combo: 0, level: 1,
      reset() { /* fields are overwritten on emit */ },
    }),
    160,
  );

  rng!: Rng;

  constructor(seed: number) {
    this.reset(seed);
  }

  /** restart with a fresh seed */
  reset(seed: number): void {
    this.rng = new Rng(seed);
    this.cells.length = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        this.cells.push({
          // row 0 is packed harder (source banks hold longer)
          terrain: BOARD.TERRAIN_HP + (r === 0 ? 2 : 0),
          kind: null,
          rot: 0,
          water: 0,
          color: -2, // -2 = no water yet
          wear: 0,
        });
      }
    }
    const palette = this.unlockedColors();
    this.sources = SRC_COLS.map((col, i) => ({ col, color: palette[i % palette.length] }));
    this.reservoirs = SRC_COLS.map((col, i) => ({
      col,
      // level 1: orders match the column's own source (gentle onboarding);
      // level 2+ rewires them cross-wise — routing becomes the game
      order: palette[i % palette.length],
      fill: 0,
      capacity: PACING.RES_CAPACITY_START,
      pulse: 0,
    }));
    this.queue.length = 0;
    for (let i = 0; i < PACING.QUEUE_SIZE; i++) this.queue.push(dealPiece(this.rng, 1));

    this.score = 0;
    this.level = 1;
    this.combo = 0;
    this.flood = 0;
    this.delivered = 0;
    this.leaked = 0;
    this.gameOver = false;
    this.flowTick = PACING.FLOW_TICK_START;
    this.events.each((e) => (e.alive = false));
  }

  at(col: number, row: number): Cell | null {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return this.cells[row * COLS + col];
  }

  /** colors available at the current level */
  unlockedColors(): number[] {
    const n = Math.min(SCORING.COLORS.length, 2 + Math.floor((this.level - 1) / 2));
    return Array.from({ length: n }, (_, i) => i);
  }

  /* ---------- player actions ---------- */

  canPlace(col: number, row: number): boolean {
    const cell = this.at(col, row);
    return !!cell && !this.gameOver && cell.kind === null && cell.terrain > 0;
  }

  /** place the head of the queue; returns false if illegal */
  place(col: number, row: number): boolean {
    if (!this.canPlace(col, row)) {
      this.emit("deny", col, row, 0, -2);
      return false;
    }
    const cell = this.at(col, row)!;
    const piece = this.queue.shift()!;
    cell.kind = piece.kind;
    cell.rot = piece.rot;
    cell.wear = 0;
    this.queue.push(dealPiece(this.rng, this.level));
    this.emit("place", col, row, 0, -2);
    return true;
  }

  rotateAt(col: number, row: number): boolean {
    const cell = this.at(col, row);
    if (!cell || cell.kind === null || isFixed(cell.kind) || this.gameOver) return false;
    const p: Piece = { kind: cell.kind, rot: cell.rot };
    if (!rotatePiece(p)) return false;
    cell.rot = p.rot;
    this.emit("rotate", col, row, 0, -2);
    return true;
  }

  removeAt(col: number, row: number): boolean {
    const cell = this.at(col, row);
    if (!cell || cell.kind === null || this.gameOver) return false;
    cell.kind = null;
    cell.rot = 0;
    cell.wear = 0;
    this.emit("remove", col, row, 0, -2);
    return true;
  }

  /** swap queue head with the next piece */
  swapQueue(): boolean {
    if (this.queue.length < 2) return false;
    const a = this.queue[0];
    this.queue[0] = this.queue[1];
    this.queue[1] = a;
    this.emit("swap", 0, 0, 0, -2);
    return true;
  }

  /** rotate the queue head piece */
  rotateQueueHead(): boolean {
    const ok = rotatePiece(this.queue[0]);
    if (ok) this.emit("rotate", -1, -1, 0, -2);
    return ok;
  }

  /* ---------- simulation ---------- */

  /** one flow tick — call every flowTick seconds while playing */
  flowStep(): void {
    if (this.gameOver) return;
    this.emitSources();
    this.moveWater();
    this.drainBottomRow();
    this.erodeTerrain();
    this.wearPipes();
    this.checkLevel();
    if (this.flood >= PACING.FLOOD_MAX) {
      this.gameOver = true;
      this.emit("gameover", 0, 0, this.flood, -2);
    }
  }

  private emitSources(): void {
    for (const src of this.sources) {
      const cell = this.at(src.col, 0);
      if (!cell) continue;
      if (cell.terrain <= 0) {
        // source runs straight into a pit — a guaranteed leak
        this.addLeak(src.col, 0, FLOW_RATE);
        continue;
      }
      this.addWater(cell, FLOW_RATE, src.color);
    }
  }

  /** gravity pass: water prefers S, then sideways toward the emptier cell, then N (pipe pressure) */
  private moveWater(): void {
    // bottom-up so water moving down isn't re-processed in the same tick
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.cells[r * COLS + c];
        if (cell.water <= 0.001) continue;
        if (cell.terrain <= 0) {
          // pit: everything seeps into the ground
          this.addLeak(c, r, cell.water);
          cell.water = 0;
          continue;
        }

        const open = this.openings(cell);
        let available = cell.water;

        // try each direction in preference order, at most one move per direction
        available = this.tryMove(cell, c, r, S, open, available);
        if (available > 0.001) {
          // sideways: emptier side first (compare W vs E fill)
          const wFill = this.fillOf(c - 1, r);
          const eFill = this.fillOf(c + 1, r);
          if (wFill <= eFill) {
            available = this.tryMove(cell, c, r, W, open, available);
            available = this.tryMove(cell, c, r, E, open, available);
          } else {
            available = this.tryMove(cell, c, r, E, open, available);
            available = this.tryMove(cell, c, r, W, open, available);
          }
        }
        if (available > 0.001) {
          available = this.tryMove(cell, c, r, N, open, available);
        }
      }
    }
  }

  /**
   * How freely water leaves this cell. Over bare ground water only ever falls
   * straight down — shaping the flow is the player's job (pipes). Sideways
   * movement exists only through pipe openings, which is what makes elbows and
   * T-junctions the heart of the game.
   */
  private openings(cell: Cell): number {
    if (cell.kind !== null) return maskOf(cell.kind as PipeKind, cell.rot);
    return S;
  }

  private fillOf(col: number, row: number): number {
    const cell = this.at(col, row);
    if (!cell) return Number.POSITIVE_INFINITY;
    if (cell.terrain <= 0) return -1; // pit drains freely
    return cell.water;
  }

  /** move water in direction dir if the cell opens that way and the neighbour accepts */
  private tryMove(cell: Cell, col: number, row: number, dir: number, open: number, available: number): number {
    if (available <= 0.001 || !(open & dir)) return available;
    const dc = dir === E ? 1 : dir === W ? -1 : 0;
    const dr = dir === S ? 1 : dir === N ? -1 : 0;
    const nb = this.at(col + dc, row + dr);
    if (!nb || nb.terrain <= 0) {
      if (nb && nb.terrain <= 0) {
        // pit next door: water pours straight in and is lost
        const lost = Math.min(available, FLOW_RATE);
        this.addLeak(col + dc, row + dr, lost);
        cell.water -= lost;
        return available - lost;
      }
      return available;
    }
    // pipes only accept through their own openings
    if (nb.kind !== null) {
      const nbOpen = maskOf(nb.kind as PipeKind, nb.rot);
      const back = dir === N ? S : dir === S ? N : dir === E ? W : E;
      if (!(nbOpen & back)) return available;
    }
    if (dir === N && nb.water >= cell.water - 0.001) return available; // no upward pressure gain
    const room = CAPACITY - nb.water;
    if (room <= 0.001) return available;
    const move = Math.min(available, FLOW_RATE, room);
    this.transferWater(nb, move, cell.color);
    cell.water -= move;
    return available - move;
  }

  /** bottom row is bedrock: standing water flows off — into a reservoir (deliver) or out (leak) */
  private drainBottomRow(): void {
    const r = ROWS - 1;
    for (let c = 0; c < COLS; c++) {
      const cell = this.cells[r * COLS + c];
      if (cell.water <= 0.001) continue;
      const amount = cell.water;
      cell.water = 0;
      const res = this.reservoirs.find((x) => x.col === c);
      if (res) this.deliver(res, cell, amount);
      else this.addLeak(c, r, amount);
    }
  }

  private deliver(res: Reservoir, cell: Cell, amount: number): void {
    const match = cell.color === res.order;
    const gold = cell.kind === "gold";
    const mult = Math.min(1 + this.combo * PACING.COMBO_STEP, PACING.COMBO_CAP);
    const goldMult = gold ? SCORING.GOLD_MULT : 1;
    let pts: number;
    let accepted: number;
    if (match) {
      pts = amount * SCORING.DELIVER_MATCH * mult * goldMult;
      accepted = amount;
    } else {
      // wrong color: the reservoir takes only a third, the rest overflows — leaks
      accepted = amount * 0.35;
      pts = accepted * SCORING.DELIVER_MUDDY * mult * goldMult;
      this.addLeak(res.col, ROWS - 1, amount - accepted);
    }
    res.fill += accepted;
    this.flood = Math.max(0, this.flood - PACING.FLOOD_DRAIN_PER_DELIVER * accepted);
    this.score += pts;
    this.combo++;
    this.delivered += amount;
    res.pulse = 1;
    // color: source color on match, -1 muddy, -3 wrong-color overflow
    this.emit("deliver", res.col, ROWS - 1, pts, match ? cell.color : cell.color === -1 ? -1 : -3, mult);

    if (res.fill >= res.capacity) {
      const bonus = SCORING.ORDER_BONUS + this.level * SCORING.ORDER_BONUS_PER_LEVEL;
      this.score += bonus;
      res.fill = 0;
      const palette = this.unlockedColors();
      const prev = res.order;
      let next = prev;
      while (next === prev) next = this.rng.pick(palette);
      res.order = next;
      res.capacity = PACING.RES_CAPACITY_START + this.level * PACING.RES_CAPACITY_PER_LEVEL;
      this.emit("order", res.col, ROWS - 1, bonus, next);
    }
  }

  private addLeak(col: number, row: number, amount: number): void {
    if (amount <= 0.001) return;
    this.flood += amount * PACING.FLOOD_PER_LEAK;
    this.leaked += amount;
    if (this.combo > 0) {
      this.combo = 0;
      this.emit("leak", col, row, amount, -1);
    } else {
      this.emit("leak", col, row, amount, -2); // -2 = quiet leak (combo was already 0)
    }
  }

  /** standing water grinds bare terrain down; collapse turns the cell into a permanent pit */
  private erodeTerrain(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell.kind !== null || cell.terrain <= 0 || cell.water <= 0.001) continue;
      cell.terrain -= ERODE_RATE;
      if (cell.terrain <= 0) {
        cell.terrain = 0;
        const c = i % COLS;
        const r = (i / COLS) | 0;
        if (cell.water > 0.001) {
          this.addLeak(c, r, cell.water);
          cell.water = 0;
        }
        this.emit("collapse", c, r, 0, -2);
      } else {
        this.emit("erode", i % COLS, (i / COLS) | 0, cell.terrain, -2);
      }
    }
  }

  /**
   * Muddy water is gritty: it slowly grinds pipes carrying it until they burst.
   * This is what kills the "pave three straight channels and idle" strategy —
   * straight-down water is always the wrong color, hence muddy, hence destructive.
   * Gold pipes resist wear twice as well.
   */
  private wearPipes(): void {
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (cell.kind === null || cell.kind === "stone" || cell.color !== -1 || cell.water <= 0.001) continue;
      cell.wear += cell.kind === "gold" ? WEAR.GOLD : WEAR.MUDDY;
      if (cell.wear >= 1) {
        cell.kind = null;
        cell.rot = 0;
        cell.wear = 0;
        cell.terrain = Math.max(1, cell.terrain - 1); // burst scars the ground
        this.emit("collapse", i % COLS, (i / COLS) | 0, 0, -2);
      }
    }
  }

  private checkLevel(): void {
    const lvl = 1 + Math.floor(this.delivered / PACING.DELIVER_PER_LEVEL);
    if (lvl > this.level) {
      this.level = lvl;
      this.flowTick = Math.max(
        PACING.FLOW_TICK_MIN,
        PACING.FLOW_TICK_START * Math.pow(PACING.FLOW_TICK_PER_LEVEL, lvl - 1),
      );
      // re-tint sources from the freshly unlocked palette
      const palette = this.unlockedColors();
      for (const src of this.sources) src.color = this.rng.pick(palette);
      // levels 2..4: orders change one by one — routing pressure ramps up gradually
      if (lvl >= 2 && lvl <= 4) {
        const i = lvl - 2;
        let next = this.reservoirs[i].order;
        let guard = 0;
        while (next === this.reservoirs[i].order && guard++ < 8) next = this.rng.pick(palette);
        this.reservoirs[i].order = next;
      }
      this.emit("levelup", 0, 0, 0, -2, 0, lvl);
    }
  }

  private addWater(cell: Cell, amount: number, color: number): void {
    this.transferWater(cell, amount, color);
  }

  private transferWater(cell: Cell, amount: number, color: number): void {
    if (cell.water <= 0.001) {
      cell.color = color;
    } else if (cell.color !== color && cell.color !== -1) {
      cell.color = -1; // muddy
    }
    cell.water = Math.min(CAPACITY, cell.water + amount);
  }

  /* ---------- events ---------- */

  private emit(type: GameEvent["type"], col: number, row: number, amount: number, color: number, combo = 0, level = 0): void {
    const e = this.events.obtain();
    if (!e) return;
    e.type = type;
    e.col = col;
    e.row = row;
    e.amount = amount;
    e.color = color;
    e.combo = combo;
    e.level = level;
  }

  /** drain pooled events into out[] (cleared first); call once per frame */
  drainEvents(out: GameEvent[]): void {
    out.length = 0;
    this.events.each((e) => {
      out.push(e);
      e.alive = false;
    });
  }
}
