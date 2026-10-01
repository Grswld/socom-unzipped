// Menu sound effects, decoded once and played through Web Audio so repeats overlap cleanly.

export type SfxName = 'dink' | 'thunk' | 'slide' | 'back' | 'neg' | 'type';
const ALL: SfxName[] = ['dink', 'thunk', 'slide', 'back', 'neg', 'type'];

export class Sfx {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private _level = 0.7;

  constructor(private readonly version = '') {}

  /** Master level for every effect, 0..1 (0 = muted). See volume.ts. */
  get level(): number { return this._level; }
  set level(v: number) {
    this._level = Math.min(1, Math.max(0, v));
    if (this.gain) this.gain.gain.value = this._level;
  }

  /** Must be called from a user gesture so the context is allowed to run. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this._level;
      this.gain.connect(this.ctx.destination);
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') await ctx.resume();
    await Promise.all(
      ALL.map(async (name) => {
        if (this.buffers.has(name)) return;
        const res = await fetch(`/sfx/${name}.ogg?v=${this.version}`);
        const data = await res.arrayBuffer();
        this.buffers.set(name, await ctx.decodeAudioData(data));
      }),
    );
  }

  play(name: SfxName, volume = 1): void {
    const buf = this.buffers.get(name);
    if (!this.ctx || !this.gain || !buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (volume === 1) src.connect(this.gain);
    else {
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.gain);
    }
    src.start();
  }

  /** Seconds a sound lasts (0 until it is loaded): how often a chatter may retrigger without piling up. */
  duration(name: SfxName): number {
    return this.buffers.get(name)?.duration ?? 0;
  }
}
