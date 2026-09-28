import {
  footstepSound, landingClass, landingSounds, landSpeeds, panDegrees, parseBankFile, PAN_RESET, rangeGain, renderSound,
  SampleCache, type LandingClass, type Material, type RenderedSound, type SoundBank, type SoundParams, type StanceCode,
  type WeaponSounds,
} from '@s2u/sound';
import type { SoundData } from './soundData';

/**
 * The game's own sounds in the browser (web/docs/research/81): the map's 989snd banks decoded from the disc, each sound
 * rendered by `@s2u/sound`'s model of the IRX -- its grains, voices, pitches, envelopes, volumes and pans -- at the
 * moment the game would start it, and played through Web Audio.
 *
 * **Where a sound is heard from.** Where the game plays a sound at a place (`FUN_00342670`, research/81 §5), it takes
 * the source into the listener's frame (the camera, `0x48dd40`), scales the play volume by the sound's `RANGE`
 * (`rangeGain`) and pans by the azimuth (`panDegrees`) -- and 989snd then applies the pan table and the square law
 * inside the voice. So the pan and the distance are rendered into the buffer (`renderSound`'s `vol` and `pan`), not
 * left to a `PannerNode`, whose equal-power law and inverse-distance roll-off are not the console's. A sound the game
 * plays without a place (`vtable+0xc`, the player's own step in some views) is rendered at full volume and its own pan.
 *
 * **The events.** The other workstreams call the `on*` methods (`GameAudio`'s API below); `main.ts` wires the
 * walk's own signals to them until they do. Each names a sound the way the game names it -- a material's
 * `STEPSOUND`, a weapon's `FireSoundClose`, a zAnim callback's -- and a name the map's banks do not hold is silent,
 * as `FUN_00344f30` answers no handle for it on the console.
 *
 * **Unlock.** A browser starts no audio before a gesture: the `AudioContext` is made on the first pointer or key
 * press (`unlockOn`); an event before that is counted (`stats().dropped.locked`) and not played.
 */

/**
 * PLACEHOLDER (not the game's): the whole mix's gain on the way out. The console's mix of a sound effect peaks far
 * below full scale -- a step at about -30 dBFS, the M4A1 SD's report at -20 (research/81 §7) -- because the
 * television's volume knob did the rest; a browser tab has none, so the viewer lifts everything by 12 dB.
 * `setVolume(1)` is this level.
 */
export const LISTENING_GAIN_PLACEHOLDER = 4;
/** PLACEHOLDER (not the game's): the `RANGE` of a sound `sounds.rdr` does not list; the steps' own is 30-200. */
export const DEFAULT_RANGE_PLACEHOLDER: [number, number] = [30, 200];
/** How many plays `stats().recent` keeps. */
const RECENT = 16;

export type Vec3 = readonly [number, number, number];

/** What the hook reports (`window.__viewer.audio()`). */
export interface AudioStats {
  /** Whether a gesture has made the context, and its state (`running` once it plays). */
  unlocked: boolean;
  state: string;
  muted: boolean;
  volume: number;
  /** The map whose banks are loaded, and each bank's block name and sound count. */
  map: string | null;
  banks: { name: string; sounds: number }[];
  /** Samples decoded so far, over all banks. */
  decoded: number;
  /** Sounds rendered and started, in all, and by name. */
  played: number;
  byName: Record<string, number>;
  /** The events the page and the other workstreams sent, by kind. */
  events: Record<AudioEvent, number>;
  /** Plays that did not sound: before the unlock, out of range, a name no bank holds, muted. */
  dropped: { locked: number; range: number; unknown: number; muted: number };
  recent: { name: string; event: AudioEvent; vol: number; pan: number; seconds: number; voices: number }[];
  missing: string[];
}

export type AudioEvent = 'footstep' | 'fire' | 'reload' | 'jump' | 'land' | 'callback' | 'play';

/** A landing as the walk reports it: its contact speed (units a second), or its class name. */
export type LandingInput = number | 'soft' | 'hard' | 'harder' | 'deadly';

/** Where rendered sound goes: Web Audio in the page, a recorder in the tests. */
export interface AudioOut {
  /** Makes the output, on a gesture. */
  unlock(): void;
  readonly unlocked: boolean;
  readonly state: string;
  setGain(gain: number): void;
  play(sound: RenderedSound): void;
}

/** The page's output: an `AudioContext`, one gain node, a buffer source a sound. */
export class WebAudioOut implements AudioOut {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gain = LISTENING_GAIN_PLACEHOLDER;

  get unlocked(): boolean { return this.ctx !== null; }
  get state(): string { return this.ctx?.state ?? 'locked'; }

  unlock(): void {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.gain;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  setGain(gain: number): void {
    this.gain = gain;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  play(sound: RenderedSound): void {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master || sound.left.length === 0) return;
    const buffer = ctx.createBuffer(2, sound.left.length, sound.sampleRate);
    buffer.copyToChannel(sound.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(sound.right as Float32Array<ArrayBuffer>, 1);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(master);
    node.start();
  }
}

interface Loaded { bank: SoundBank; samples: SampleCache }

/**
 * The walk's sound: the loaded banks, the rules that pick a sound, the listener, the output. The `on*` methods are
 * the event API the motion and weapon workstreams call.
 */
export class GameAudio {
  private banks: Loaded[] = [];
  private readonly lookup = new Map<string, { loaded: Loaded; index: number }>();
  private params = new Map<string, SoundParams>();
  private materials: Material[] = [];
  private weapons = new Map<string, WeaponSounds>();
  private callbacks = new Map<string, string[]>();
  private map: string | null = null;
  private missing: string[] = [];
  /** RAND_PLAY's and PLAY_CYCLE's memory, which the IRX keeps in the grain across plays. */
  private readonly grainState = new Map<string, number>();
  /** The camera's world matrix, column-major (three.js `matrixWorld.elements`); null places nothing. */
  private listener: number[] | null = null;
  private volume_ = 1;
  private muted_ = false;
  private speeds: [number, number, number] | null = null;
  private played = 0;
  private readonly byName: Record<string, number> = {};
  private readonly events: Record<AudioEvent, number> = { footstep: 0, fire: 0, reload: 0, jump: 0, land: 0, callback: 0, play: 0 };
  private readonly dropped = { locked: 0, range: 0, unknown: 0, muted: 0 };
  private readonly recent: AudioStats['recent'] = [];

  constructor(private readonly out: AudioOut = new WebAudioOut(), private readonly random: () => number = Math.random) {
    this.out.setGain(this.gain());
  }

  /** The map's sound data from the worker (`./soundData`); null silences the walk. */
  setData(data: SoundData | null): void {
    this.banks = [];
    this.lookup.clear();
    this.grainState.clear();
    this.map = data?.archive ?? null;
    this.missing = data?.missing ?? [];
    for (const { file, bytes } of data?.banks ?? []) {
      try {
        const bank = parseBankFile(bytes);
        const loaded = { bank, samples: new SampleCache(bank.vag) };
        this.banks.push(loaded);
        for (const [name, index] of bank.names) if (!this.lookup.has(name)) this.lookup.set(name, { loaded, index });
      } catch (e) {
        this.missing.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.params = new Map(data?.params ?? []);
    this.materials = data?.materials ?? [];
    this.weapons = new Map((data?.weapons ?? []).map((w) => [w.name, w]));
    this.callbacks = new Map(data?.callbacks ?? []);
  }

  /**
   * The landing classes' speeds (`landSpeeds`): the table's gravity and `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` in units.
   */
  setFallTable(gravity: number, fallDistances: readonly [number, number, number]): void {
    this.speeds = landSpeeds(gravity, fallDistances);
  }

  /** Makes the output on the first pointer or key press on `target` (and resumes it on any later one). */
  unlockOn(target: EventTarget): void {
    const unlock = (): void => this.out.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchend']) target.addEventListener(type, unlock, { capture: true, passive: true });
  }

  /** The listener: the camera's world matrix (column-major, as three.js holds it), once a frame. */
  setListener(matrixWorld: ArrayLike<number> | null): void {
    this.listener = matrixWorld ? Array.from(matrixWorld) : null;
  }

  // ---- the controls the UI hooks up --------------------------------------------------------------------------

  /** The mix's volume, 0 up (1 is `LISTENING_GAIN_PLACEHOLDER`'s level). */
  setVolume(volume: number): void {
    this.volume_ = Math.max(0, Number.isFinite(volume) ? volume : 1);
    this.out.setGain(this.gain());
  }
  setMuted(muted: boolean): void {
    this.muted_ = muted;
    this.out.setGain(this.gain());
  }
  volume(): number { return this.volume_; }
  muted(): boolean { return this.muted_; }
  private gain(): number { return this.muted_ ? 0 : this.volume_ * LISTENING_GAIN_PLACEHOLDER; }

  // ---- the event API -----------------------------------------------------------------------------------------

  /**
   * A footfall (`FUN_005a39b0`): the material under the foot (the collision polygon's `material` byte), where the foot
   * came down, the stance and the stick's largest axis. Returns the sound's name, or null for a silent surface.
   */
  onFootstep(material: number, position: Vec3 | null, options: { stance?: StanceCode; stick?: number } = {}): string | null {
    this.events.footstep++;
    const name = footstepSound(this.materials[material], options.stance ?? 0, options.stick ?? 1);
    return name && this.play(name, position, 'footstep') ? name : null;
  }

  /**
   * One round of `weapon` (a `zweapon.rdr` `InternalName`, `M4A1 SD` by default) from `position`: its
   * `FireSoundClose`, or -- for a shooter out of that sound's `RANGE` -- its `FireSoundMed` then `FireSoundFar`
   * where the weapon has them (a reading: the script marks the variants `MED` and `FAR`; the chooser is not traced).
   */
  onFire(weapon = 'M4A1 SD', position: Vec3 | null = null): string | null {
    this.events.fire++;
    const w = this.weapons.get(weapon);
    if (!w?.fireClose) return null;
    let name = w.fireClose;
    if (position && this.listener) {
      const d = this.local(position)[0];
      for (const next of [w.fireMed, w.fireFar]) {
        const range = this.rangeOf(name);
        if (next && d > range[1]) name = next;
      }
    }
    return this.play(name, position, 'fire') ? name : null;
  }

  /** A reload of `weapon`: its `ReloadSound`. */
  onReload(weapon = 'M4A1 SD', position: Vec3 | null = null): string | null {
    this.events.reload++;
    const name = this.weapons.get(weapon)?.reload;
    return name && this.play(name, position, 'reload') ? name : null;
  }

  /** The jump: the `seal_jump` clip's `jump_whoosh` callback (`motion.rdr`, time 0.4), played now. */
  onJump(position: Vec3 | null = null): string | null {
    this.events.jump++;
    return this.callback('jump_whoosh', position);
  }

  /**
   * A landing (`FUN_005ac1f0`): its contact speed in units a second (classed against `setFallTable`'s speeds), or a
   * class by name -- `soft` and `hard` (the walk's `LandingKind`s) land soft, `harder` is the heavy class, `deadly`
   * the deadly -- the material under the feet, and where. Returns the sounds played.
   */
  onLand(landing: LandingInput, material: number, position: Vec3 | null = null): string[] {
    this.events.land++;
    let cls: LandingClass;
    if (typeof landing === 'number') cls = this.speeds ? landingClass(landing, this.speeds) : 0;
    else cls = landing === 'deadly' ? 3 : landing === 'harder' ? 2 : 0;
    return landingSounds(this.materials[material], cls).filter((name) => this.play(name, position, 'land'));
  }

  /**
   * A `zanim_callback` fired by a clip (`motion.rdr`): the sound its zAnim plays (the first, where it plays several:
   * all are started), or null when it plays none.
   */
  onAnimCallback(name: string, position: Vec3 | null = null): string | null {
    this.events.callback++;
    return this.callback(name, position);
  }

  private callback(name: string, position: Vec3 | null): string | null {
    const played = (this.callbacks.get(name) ?? []).filter((sound) => this.play(sound, position, 'callback'));
    return played[0] ?? null;
  }

  /**
   * Plays a sound by its bank name (`.STEP_STONE`) at `position` (null: without a place). False when it did not
   * sound: locked, muted, out of its range, or a name the map's banks do not hold.
   */
  play(name: string, position: Vec3 | null = null, event: AudioEvent = 'play'): boolean {
    if (event === 'play') this.events.play++;
    const found = this.lookup.get(name) ?? this.lookup.get(name.trim());
    if (!found) { this.dropped.unknown++; return false; }
    if (!this.out.unlocked) { this.dropped.locked++; return false; }
    if (this.muted_) { this.dropped.muted++; return false; }
    let vol = 0x400, pan = PAN_RESET;
    if (position && this.listener) {
      const [distance, right, forward] = this.local(position);
      vol = Math.round(0x400 * rangeGain(distance, this.rangeOf(name)));
      if (vol <= 0) { this.dropped.range++; return false; }
      pan = distance > 1e-6 ? panDegrees(right, forward) : 0;
    }
    const r = renderSound(found.loaded.bank, found.index, found.loaded.samples, { vol, pan, random: this.random, state: this.grainState });
    this.out.play(r);
    this.played++;
    this.byName[name] = (this.byName[name] ?? 0) + 1;
    this.recent.push({ name, event, vol, pan, seconds: r.left.length / r.sampleRate, voices: r.voices });
    if (this.recent.length > RECENT) this.recent.shift();
    return true;
  }

  private rangeOf(name: string): [number, number] {
    return this.params.get(name)?.range ?? DEFAULT_RANGE_PLACEHOLDER;
  }

  /** The distance to `p` and its components along the camera's right and forward (three.js: -z ahead). */
  private local(p: Vec3): [number, number, number] {
    const m = this.listener!;
    const dx = p[0] - m[12]!, dy = p[1] - m[13]!, dz = p[2] - m[14]!;
    const right = dx * m[0]! + dy * m[1]! + dz * m[2]!;
    const forward = -(dx * m[8]! + dy * m[9]! + dz * m[10]!);
    return [Math.hypot(dx, dy, dz), right, forward];
  }

  stats(): AudioStats {
    return {
      unlocked: this.out.unlocked, state: this.out.state, muted: this.muted_, volume: this.volume_, map: this.map,
      banks: this.banks.map((b) => ({ name: b.bank.name, sounds: b.bank.sounds.length })),
      decoded: this.banks.reduce((n, b) => n + b.samples.size, 0),
      played: this.played, byName: { ...this.byName }, events: { ...this.events }, dropped: { ...this.dropped },
      recent: this.recent.map((r) => ({ ...r })), missing: [...this.missing],
    };
  }
}

/**
 * The page's one `GameAudio`: `main.ts` feeds it the map's data, the listener and the walk's events; the UI's panel
 * calls `setVolume` / `setMuted` on it, and the motion and weapon workstreams its `on*` methods.
 */
export const gameAudio = new GameAudio();
