/**
 * pieces.ts — pipe piece model: connection masks, rotation, deal queue.
 */

import { N, E, S, W, type PipeKind } from "./types";
import { SCORING } from "./config";
import type { Rng } from "./rng";

/** base orientation masks, rotated clockwise per rot step */
const BASE_MASK: Record<PipeKind, number> = {
  straight: N | S,
  elbow: N | E,
  tee: N | E | S,
  cross: N | E | S | W,
  stone: 0,
  gold: N | S, // golden straight
};

const ROT_BITS = [N, E, S, W];

/** rotate a mask n quarter-turns clockwise */
export function rotateMask(mask: number, rot: number): number {
  let m = mask;
  for (let i = 0; i < (rot & 3); i++) {
    let n = 0;
    if (m & N) n |= E;
    if (m & E) n |= S;
    if (m & S) n |= W;
    if (m & W) n |= N;
    m = n;
  }
  return m;
}

export function maskOf(kind: PipeKind, rot: number): number {
  return rotateMask(BASE_MASK[kind], rot);
}

/** true when the pipe kind has a fixed orientation (stone) — rotating is a no-op */
export function isFixed(kind: PipeKind): boolean {
  return kind === "stone";
}

export interface Piece {
  kind: PipeKind;
  rot: number;
}

/** deal a fresh piece for the given level (more colors/colors don't change shapes, deck does slightly) */
export function dealPiece(rng: Rng, level: number): Piece {
  const deck = SCORING.DECK;
  // from level 4 stones get a touch rarer, elbows stay the backbone
  const boost = level >= 4 ? 0.85 : 1;
  const entries = deck.map(([k, w]) => [k, k === "stone" ? w * boost : w] as const);
  const kind = rng.weighted(entries) as PipeKind;
  const fixed = isFixed(kind);
  return { kind, rot: fixed ? 0 : rng.int(0, 3) };
}

/** rotate a piece in place; returns false if the kind is orientation-fixed */
export function rotatePiece(p: Piece): boolean {
  if (isFixed(p.kind)) return false;
  p.rot = (p.rot + 1) & 3;
  return true;
}

/** rotate mask back to the canonical base orientation (for drawing) */
export function baseMaskOf(kind: PipeKind): number {
  return BASE_MASK[kind];
}

export { ROT_BITS, BASE_MASK };
