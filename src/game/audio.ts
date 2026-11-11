/**
 * audio.ts — Web Audio synthesized SFX for «Плотина» + a gentle water ambience.
 * No audio files: everything is synthesized at runtime; autoplay-compliant (starts
 * on first user gesture); mute persisted in localStorage.
 */

export type SfxId =
  | "place" | "rotate" | "remove" | "swap" | "deny" | "ui"
  | "deliver" | "order" | "levelup" | "leak" | "erode" | "collapse"
  | "win" | "lose";

const MUTE_KEY = "game.muted";

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeMuted(v: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, v ? "1" : "0");
  } catch {
    // in-memory flag still works
  }
}

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private disposed = false;
  muted = false;

  private readonly unlock = () => {
    this.ensureCtx();
    this.detachUnlock();
  };

  constructor() {
    this.muted = readMuted();
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  private detachUnlock(): void {
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachUnlock();
    this.stopAmbience();
    this.master?.disconnect();
    this.master = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    writeMuted(this.muted);
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  /** short synth blip helper */
  private blip(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** filtered noise burst helper (water, rock) */
  private noise(dur: number, gain: number, freq: number, q = 1, delay = 0): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
  }

  sfx(id: SfxId, intensity = 1): void {
    if (this.disposed || this.muted) return;
    const ctx = this.ensureCtx();
    if (!this.master) return;
    void ctx;
    const k = Math.min(1.6, Math.max(0.4, intensity));
    switch (id) {
      case "place":
        this.blip("triangle", 180, 120, 0.09, 0.22);
        this.noise(0.06, 0.1, 900);
        break;
      case "rotate":
        this.blip("square", 420, 560, 0.045, 0.07);
        break;
      case "remove":
        this.blip("triangle", 300, 140, 0.1, 0.15);
        break;
      case "swap":
        this.blip("sine", 500, 700, 0.06, 0.12);
        break;
      case "deny":
        this.blip("square", 140, 110, 0.09, 0.12);
        break;
      case "ui":
        this.blip("sine", 600, 720, 0.05, 0.1);
        break;
      case "deliver": {
        // rising plop, pitch climbs with combo
        const base = 480 + 60 * k;
        this.blip("sine", base, base * 1.5, 0.1, 0.2);
        this.noise(0.08, 0.08, 1400, 0.8);
        break;
      }
      case "order":
        [523, 659, 784, 1046].forEach((f, i) => this.blip("sine", f, f, 0.14, 0.16, i * 0.07));
        this.noise(0.25, 0.06, 2000, 0.6);
        break;
      case "levelup":
        [392, 523, 659, 880].forEach((f, i) => this.blip("triangle", f, f * 1.01, 0.16, 0.15, i * 0.08));
        break;
      case "leak":
        this.noise(0.3, 0.2, 300, 0.7);
        this.blip("sawtooth", 90, 50, 0.25, 0.14);
        break;
      case "erode":
        this.noise(0.12, 0.06, 500, 1.2);
        break;
      case "collapse":
        this.noise(0.45, 0.25, 180, 0.8);
        this.blip("triangle", 120, 45, 0.4, 0.2);
        break;
      case "win":
        [523, 659, 784, 1046, 1318].forEach((f, i) => this.blip("sine", f, f, 0.2, 0.14, i * 0.09));
        break;
      case "lose":
        [330, 262, 196, 131].forEach((f, i) => this.blip("sawtooth", f, f * 0.94, 0.26, 0.13, i * 0.16));
        break;
    }
  }

  /** gentle water hiss that swells while a lot of water is on the board */
  startAmbience(): void {
    if (this.disposed || this.ambience) return;
    const ctx = this.ensureCtx();
    if (!this.master) return;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // pink-ish noise: softer than white
      const white = Math.random() * 2 - 1;
      last = last * 0.94 + white * 0.06;
      data[i] = last * 6;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    const gain = ctx.createGain();
    gain.gain.value = 0.0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    this.ambience = { src, gain, filter };
  }

  /** waterLevel 0..1 scales the ambience volume */
  setAmbience(waterLevel: number): void {
    if (!this.ambience || !this.ctx) return;
    const target = this.muted ? 0 : 0.025 + waterLevel * 0.05;
    this.ambience.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
    this.ambience.filter.frequency.setTargetAtTime(420 + waterLevel * 500, this.ctx.currentTime, 0.4);
  }

  stopAmbience(): void {
    if (!this.ambience) return;
    try {
      this.ambience.src.stop();
    } catch {
      // already stopped
    }
    this.ambience = null;
  }
}
