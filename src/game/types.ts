/**
 * types.ts — shared game types for «Плотина».
 */

/** Poolable: avoid allocation in the hot loop. */
export interface Poolable {
  alive: boolean;
  reset(): void;
}

export class Pool<T extends Poolable> {
  private items: T[] = [];
  constructor(private factory: () => T, size: number) {
    for (let i = 0; i < size; i++) this.items.push(factory());
  }
  obtain(): T | null {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.alive) {
        it.alive = true;
        it.reset();
        return it;
      }
    }
    return null;
  }
  each(fn: (it: T) => void): void {
    for (const it of this.items) if (it.alive) fn(it);
  }
}

/* ---------- board ---------- */

/** connection mask bits */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

export type PipeKind = "straight" | "elbow" | "tee" | "cross" | "stone" | "gold";

export interface Cell {
  /** terrain hp; 0 = collapsed pit (permanent) */
  terrain: number;
  kind: PipeKind | null;
  /** rotation 0..3 (quarter turns clockwise from base orientation) */
  rot: number;
  /** water amount in the cell */
  water: number;
  /** water color index, -1 = muddy (mixed) */
  color: number;
  /** pipe wear 0..1 — muddy water is gritty and grinds pipes down until they burst */
  wear: number;
}

export interface Source {
  col: number;
  /** color index this source currently emits */
  color: number;
}

export interface Reservoir {
  col: number;
  /** order color index the reservoir accepts at full value */
  order: number;
  fill: number;
  capacity: number;
  /** pulse animation timer after a delivery */
  pulse: number;
}

/** pooled game event emitted by the simulation, consumed by renderer/audio */
export interface GameEvent extends Poolable {
  type: "deliver" | "leak" | "erode" | "collapse" | "order" | "levelup" | "gameover" | "place" | "rotate" | "remove" | "swap" | "deny";
  col: number;
  row: number;
  amount: number;
  color: number;
  combo: number;
  level: number;
}
