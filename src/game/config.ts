/**
 * config.ts — global tuning for «Плотина». All pacing numbers live here so the
 * game feel can be tuned in one place.
 */

export const INPUT_CONFIG = {
  MOUSE_SENS_X: 0.0026,
  MOUSE_SENS_Y: 0.0022,
  INVERT_X: false,
  INVERT_Y: false,
} as const;

export const BOARD = {
  COLS: 7,
  ROWS: 10,
  /** source columns (fixed, top) and reservoir columns (bottom) */
  SRC_COLS: [1, 3, 5],
  /** terrain hit points of an unpaved cell before it collapses into a pit */
  TERRAIN_HP: 2,
  /** max water a cell can hold (backpressure) */
  CAPACITY: 1,
  /** water moved per flow tick between two cells */
  FLOW_RATE: 0.5,
  /** erosion done to bare terrain per tick while water stands on it */
  ERODE_RATE: 0.25,
} as const;

export const WEAR = {
  /** pipe wear per tick while carrying muddy water (bursts at 1.0) */
  MUDDY: 0.06,
  GOLD: 0.03,
} as const;

export const PACING = {
  /** seconds between flow ticks at level 1 */
  FLOW_TICK_START: 0.62,
  /** flow tick multiplier per level */
  FLOW_TICK_PER_LEVEL: 0.94,
  /** flow tick never drops below this — keeps the endgame playable */
  FLOW_TICK_MIN: 0.15,
  /** reservoir capacity (units of water) at level 1 */
  RES_CAPACITY_START: 8,
  RES_CAPACITY_PER_LEVEL: 1.5,
  /** delivered water needed for the next level */
  DELIVER_PER_LEVEL: 40,
  /** flood meter max — game over */
  FLOOD_MAX: 100,
  /** flood added per leaked unit */
  FLOOD_PER_LEAK: 4,
  /** flood drained per delivered unit (reward for good play) */
  FLOOD_DRAIN_PER_DELIVER: 0.5,
  /** combo multiplier per consecutive streak, capped */
  COMBO_STEP: 0.25,
  COMBO_CAP: 8,
  /** piece queue length */
  QUEUE_SIZE: 3,
} as const;

export const SCORING = {
  DELIVER_MATCH: 10,
  DELIVER_MUDDY: 3,
  ORDER_BONUS: 150,
  ORDER_BONUS_PER_LEVEL: 60,
  GOLD_MULT: 2,
  /** chance weights for the piece deck (level 1) */
  DECK: [
    ["straight", 30],
    ["elbow", 34],
    ["tee", 16],
    ["cross", 6],
    ["stone", 12],
    ["gold", 6],
  ] as Array<readonly [string, number]>,
  /** colors unlocked by level: index 0..3 */
  COLORS: ["#4fc3f7", "#69f0ae", "#ffd54f", "#ce93d8"] as const,
  COLOR_NAMES: ["вода", "тайфун", "янтарь", "ирис"] as const,
} as const;

export const QUALITY = {
  PARTICLES_HIGH: 420,
  PARTICLES_LOW: 140,
  DEGRADE_FPS: 45,
} as const;
