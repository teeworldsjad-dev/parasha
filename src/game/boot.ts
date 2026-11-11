/**
 * boot.ts — mounts «Плотина» onto the canvas and exposes the verification hooks:
 *   startGame(canvas) / stopGame()   — lifecycle (React shell calls these)
 *   window.__GAME_READY__            — raised on the first rendered frame
 *   window.__gameProbe()             — keyboard-cursor position for direction assertions
 */

import { Game } from "./game";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
    /** automation hook for the self-check playtest; undefined in normal play */
    __gameDebug?: () => Record<string, unknown> | null;
  }
}

let game: Game | null = null;

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();
  game = new Game(canvas);
  window.__gameProbe = () => game!.probe();
  window.__gameDebug = () => game!.debugApi();
  window.__GAME_READY__ = false;
  game.start();
}

export function stopGame(): void {
  if (!game) return;
  game.dispose();
  game = null;
  window.__gameProbe = undefined;
  window.__GAME_READY__ = false;
}
