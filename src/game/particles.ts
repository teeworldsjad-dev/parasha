/**
 * particles.ts — pooled splash droplets + floating score texts. Zero allocation
 * while the game runs: two fixed pools, everything reused.
 */

import { Pool, type Poolable } from "./types";

export interface Particle extends Poolable {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  color: string;
  gravity: number;
  reset(): void;
}

export interface FloatText extends Poolable {
  x: number; y: number;
  life: number; maxLife: number;
  text: string;
  color: string;
  size: number;
  reset(): void;
}

function makeParticle(): Particle {
  return {
    alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: "#fff", gravity: 1,
    reset() { this.life = 0; this.vx = 0; this.vy = 0; },
  };
}

function makeText(): FloatText {
  return {
    alive: false, x: 0, y: 0, life: 0, maxLife: 1, text: "", color: "#fff", size: 14,
    reset() { this.life = 0; },
  };
}

export class Particles {
  readonly pool: Pool<Particle>;
  readonly texts: Pool<FloatText>;

  constructor(maxParticles: number, maxTexts = 24) {
    this.pool = new Pool<Particle>(makeParticle, maxParticles);
    this.texts = new Pool<FloatText>(makeText, maxTexts);
  }

  /** splash burst at (x, y); count scaled by quality tier */
  burst(x: number, y: number, color: string, count: number, rng: () => number, speed = 90): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool.obtain();
      if (!p) return;
      const a = rng() * Math.PI * 2;
      const s = speed * (0.4 + rng() * 0.8);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s - speed * 0.6;
      p.maxLife = p.life = 0.35 + rng() * 0.4;
      p.size = 1.5 + rng() * 2.5;
      p.color = color;
      p.gravity = 320;
    }
  }

  /** crumbling rock chunks: slower, grey, heavier */
  rubble(x: number, y: number, count: number, rng: () => number): void {
    for (let i = 0; i < count; i++) {
      const p = this.pool.obtain();
      if (!p) return;
      const a = -Math.PI / 2 + (rng() - 0.5) * 1.8;
      const s = 40 + rng() * 70;
      p.x = x + (rng() - 0.5) * 18;
      p.y = y + (rng() - 0.5) * 10;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.maxLife = p.life = 0.5 + rng() * 0.5;
      p.size = 2 + rng() * 3;
      p.color = rng() > 0.5 ? "#6b7280" : "#4b5563";
      p.gravity = 500;
    }
  }

  text(x: number, y: number, text: string, color: string, size = 15): void {
    const t = this.texts.obtain();
    if (!t) return;
    t.x = x;
    t.y = y;
    t.text = text;
    t.color = color;
    t.size = size;
    t.maxLife = t.life = 1.1;
  }

  update(dt: number): void {
    this.pool.each((p) => {
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        return;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    });
    this.texts.each((t) => {
      t.life -= dt;
      t.y -= 34 * dt;
      if (t.life <= 0) t.alive = false;
    });
  }

  clear(): void {
    this.pool.each((p) => (p.alive = false));
    this.texts.each((t) => (t.alive = false));
  }
}
