/**
 * A blast's ringing ears on the page (`./net/blast`; `FUN_005a0e70` L459221-459227): `.RINGING_EARS` played, and every
 * sound channel held at `volume` (0.35) for `seconds` (5) -- `FUN_003412f0(5.0, 0.35, ...)` -- then back. A second blast
 * inside the five seconds starts them again from its own time. RING_VOLUME_READING: the page has one mix, so the whole
 * mix is held (the game lowers its channels 0-6); the volume set on the panel while ringing is overwritten at the end.
 */

export interface RingAudio {
  volume(): number;
  setVolume(volume: number): void;
  onAnimCallback(name: string, at: null): unknown;
}

export class RingingEars {
  private base: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly audio: RingAudio) {}

  get ringing(): boolean {
    return this.base !== null;
  }

  start(seconds: number, volume: number): void {
    if (this.base === null) this.base = this.audio.volume();
    this.audio.setVolume(this.base * volume);
    this.audio.onAnimCallback('.RINGING_EARS', null);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), seconds * 1000);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.base !== null) this.audio.setVolume(this.base);
    this.base = null;
  }
}
