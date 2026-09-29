import {
  footstepSound, landingClass, landingHurts, landingSounds, landSpeeds, makeVolume, panDegrees, parseBankFile,
  passingSound, PAN_RESET, rangeGain, renderLoop, renderSound, reverbImpulse, SampleCache, voiceLevel, type LandingClass,
  type Material, type RenderedSound, type ReverbImpulse, type SoundBank, type SoundParams, type StanceCode,
  type WeaponSounds,
} from '@s2u/sound';
import type { SoundData } from './soundData';
import { LOOP_FADE_SECONDS_PLACEHOLDER, LOOP_SECONDS_PLACEHOLDER } from './loopLength';
import { soundFor } from './soundNames';

/**
 * The game's own sounds in the browser (web/docs/research/81): the map's 989snd banks decoded from the disc, each sound
 * rendered by `@s2u/sound`'s model of the IRX -- its grains, voices, pitches, envelopes, volumes and pans -- at the
 * moment the game would start it, and played through Web Audio.
 *
 * **Where a sound is heard from.** Where the game plays a sound at a place (`FUN_00342670`, research/81 §3), it takes
 * the source into the listener's frame (the camera, `0x48dd40`), scales the play volume by the sound's `RANGE`
 * (`rangeGain`) and pans by the azimuth (`panDegrees`) -- and 989snd then applies the pan table and the square law
 * inside the voice. So the pan and the distance are rendered into the buffer (`renderSound`'s `vol` and `pan`), not
 * left to a `PannerNode`, whose equal-power law and inverse-distance roll-off are not the console's. A sound the game
 * plays without a place (`vtable+0xc`, the player's own step in some views) is rendered at full volume and its own pan.
 *
 * **The reverb** (§9): the SPU2's own, libsd's mode 3 preset out of the disc's `LIBSD.IRX`, run once on an impulse
 * (`reverbImpulse`) and convolved on a bus every voice whose tone asks for it sends to; its depth ramps to the
 * mission's `IndoorReverb`/`OutdoorReverb` entry for the polygon under the camera (`setEnvironment`), as
 * `FUN_00341a60` does each frame with `snd_AutoReverb`.
 *
 * **The ambience** (§10): the mission's beds (`~OUTDOOR_AMB` outdoors, `~INDOOR_AMB` indoors, crossed as the camera
 * goes in and out) and its emitters (a `~` loop at a scene node, heard by its `RANGE` and azimuth as the camera moves),
 * each rendered once for `LOOP_SECONDS_PLACEHOLDER` and looped.
 *
 * **The events.** The other workstreams call the `on*` methods (`GameAudio`'s API below). Each names a sound the way
 * the game names it -- a material's `STEPSOUND`, a weapon's `FireSoundClose`, a zAnim callback's -- and a name the
 * map's banks do not hold is silent, as `FUN_00344f30` answers no handle for it on the console.
 *
 * **Unlock.** A browser starts no audio before a gesture: the `AudioContext` is made on the first pointer or key
 * press (`unlockOn`); an event before that is counted (`stats().dropped.locked`) and not played.
 */

/**
 * PLACEHOLDER (not the game's): the whole mix's gain on the way out. The console's mix of a sound effect peaks far
 * below full scale -- a step at about -30 dBFS, the M4A1 SD's report at -20 (research/81 §11) -- because the
 * television's volume knob did the rest; a browser tab has none, so the viewer lifts everything by 12 dB.
 * `setVolume(1)` is this level.
 */
export const LISTENING_GAIN_PLACEHOLDER = 4;
/** PLACEHOLDER (not the game's): the `RANGE` of a sound `sounds.rdr` does not list; the steps' own is 30-200. */
export const DEFAULT_RANGE_PLACEHOLDER: [number, number] = [30, 200];
export { LOOP_FADE_SECONDS_PLACEHOLDER, LOOP_SECONDS_PLACEHOLDER } from './loopLength';
/**
 * PLACEHOLDER (not the game's): how long a bed takes to go as the camera goes in or out. The mission script stops one
 * zAnim and starts the other (`check_camera_inside_state1`), the stopped sound releasing by its envelope.
 */
export const BED_FADE_SECONDS_PLACEHOLDER = 0.5;
/** `FUN_00341a60`'s ramp to 0 when the zone's list has no entry: 0xf0 ticks at 240 Hz, one second. */
export const REVERB_OFF_SECONDS = 1;
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
  banks: { name: string; sounds: number; borrowed?: true }[];
  /** Samples decoded so far, over all banks. */
  decoded: number;
  /** Sounds rendered and started, in all, and by name. */
  played: number;
  byName: Record<string, number>;
  /** The events the page and the other workstreams sent, by kind. */
  events: Record<AudioEvent, number>;
  /** Plays that did not sound: before the unlock, out of range, a name no bank holds, muted. */
  dropped: { locked: number; range: number; unknown: number; muted: number; silent: number };
  /** The names asked for that no bank holds, and how often (a misspelt name, a sound the map's banks lack). */
  unknownNames: Record<string, number>;
  recent: { name: string; event: AudioEvent; vol: number; pan: number; seconds: number; voices: number }[];
  /** The map's `DefaultMaterial` (the SOILS name a material byte 0 is heard as). */
  defaultMaterial: string | null;
  /** The reverb: the preset loaded, the camera's place (indoors, zone) and the depth ramped to (0..1). */
  reverb: { loaded: boolean; inside: boolean; zone: number; depth: number };
  /** The ambience: running, the beds and which is up, the emitters playing and their gains. */
  ambience: { on: boolean; beds: { outside: string[]; inside: string[] }; bed: 'outside' | 'inside' | null; emitters: { sound: string; node: string; gain: number }[] };
  missing: string[];
}

export type AudioEvent = 'footstep' | 'fire' | 'reload' | 'jump' | 'land' | 'callback' | 'passing' | 'play';

/** A landing as the walk reports it: its contact speed (units a second), or its class name. */
export type LandingInput = number | 'soft' | 'hard' | 'harder' | 'deadly';

/** A looping sound playing: its two channel gains, set as the listener moves; stopped at the map's end. */
export interface LoopHandle { setGains(left: number, right: number, seconds?: number): void; stop(): void }

/** Where rendered sound goes: Web Audio in the page, a recorder in the tests. */
export interface AudioOut {
  /** Makes the output, on a gesture. */
  unlock(): void;
  readonly unlocked: boolean;
  readonly state: string;
  setGain(gain: number): void;
  play(sound: RenderedSound): void;
  /** The reverb's response (null: none), and its depth ramped to over `seconds`. */
  setReverb(ir: ReverbImpulse | null): void;
  rampReverb(depth: number, seconds: number): void;
  /** A buffer played round and round, silent until its gains are set. */
  loop(sound: RenderedSound): LoopHandle | null;
}

/** The page's output: an `AudioContext`, a master gain, the reverb bus, a buffer source a sound. */
export class WebAudioOut implements AudioOut {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wet: GainNode | null = null;
  private gain = LISTENING_GAIN_PLACEHOLDER;
  private ir: ReverbImpulse | null = null;
  private depth = 0;

  get unlocked(): boolean { return this.ctx !== null; }
  get state(): string { return this.ctx?.state ?? 'locked'; }

  unlock(): void {
    if (!this.ctx) {
      const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.gain;
      this.master.connect(ctx.destination);
      this.reverbIn = ctx.createGain();
      this.wet = ctx.createGain();
      this.wet.gain.value = this.depth;
      this.wet.connect(this.master);
      this.setReverb(this.ir);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  setGain(gain: number): void {
    this.gain = gain;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
  }

  setReverb(ir: ReverbImpulse | null): void {
    this.ir = ir;
    const ctx = this.ctx;
    if (!ctx || !this.reverbIn || !this.wet) return;
    this.convolver?.disconnect();
    this.reverbIn.disconnect();
    this.convolver = null;
    if (!ir) return;
    // Four channels: a "true stereo" response -- left in to left and right out, right in to left and right out -- at
    // the context's own rate (a ConvolverNode refuses any other), linearly resampled from the SPU's 48 kHz.
    const rate = ctx.sampleRate, ratio = ir.sampleRate / rate;
    const length = Math.max(1, Math.floor(ir.ll.length / ratio));
    const at = (x: Float32Array): Float32Array<ArrayBuffer> => {
      if (ratio === 1) return x as Float32Array<ArrayBuffer>;
      const y = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const p = i * ratio, i0 = Math.floor(p), f = p - i0;
        y[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
      }
      return y;
    };
    const buffer = ctx.createBuffer(4, length, rate);
    buffer.copyToChannel(at(ir.ll), 0);
    buffer.copyToChannel(at(ir.lr), 1);
    buffer.copyToChannel(at(ir.rl), 2);
    buffer.copyToChannel(at(ir.rr), 3);
    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = buffer;
    this.reverbIn.connect(convolver);
    convolver.connect(this.wet);
    this.convolver = convolver;
  }

  rampReverb(depth: number, seconds: number): void {
    this.depth = depth;
    const ctx = this.ctx, wet = this.wet;
    if (!ctx || !wet) return;
    const now = ctx.currentTime;
    wet.gain.cancelScheduledValues(now);
    wet.gain.setValueAtTime(wet.gain.value, now);
    wet.gain.linearRampToValueAtTime(depth, now + Math.max(0.01, seconds));
  }

  /** A buffer of the dry pair and, when the sound sends to the reverb, the send pair: channels 0-1 and 2-3. */
  private buffer(sound: RenderedSound): AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx || sound.left.length === 0) return null;
    const send = sound.sendLeft && sound.sendRight && this.convolver ? 4 : 2;
    const buffer = ctx.createBuffer(send, sound.left.length, sound.sampleRate);
    buffer.copyToChannel(sound.left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(sound.right as Float32Array<ArrayBuffer>, 1);
    if (send === 4) {
      buffer.copyToChannel(sound.sendLeft as Float32Array<ArrayBuffer>, 2);
      buffer.copyToChannel(sound.sendRight as Float32Array<ArrayBuffer>, 3);
    }
    return buffer;
  }

  /** Routes a source's channels: 0-1 through `gains[0..1]` to the master, 2-3 through `gains[2..3]` to the reverb. */
  private route(source: AudioBufferSourceNode, channels: number, gains: GainNode[] | null): void {
    const ctx = this.ctx!;
    if (channels === 2 && !gains) { source.connect(this.master!); return; }
    const split = ctx.createChannelSplitter(channels);
    source.connect(split);
    const dry = ctx.createChannelMerger(2);
    dry.connect(this.master!);
    const pair = (from: number, to: AudioNode, g: [GainNode | undefined, GainNode | undefined]): void => {
      for (let c = 0; c < 2; c++) {
        const gain = g[c];
        if (gain) { split.connect(gain, from + c); gain.connect(to, 0, c); } else split.connect(to, from + c, c);
      }
    };
    pair(0, dry, [gains?.[0], gains?.[1]]);
    if (channels === 4 && this.reverbIn) {
      const wet = ctx.createChannelMerger(2);
      wet.connect(this.reverbIn);
      pair(2, wet, [gains?.[2], gains?.[3]]);
    }
  }

  play(sound: RenderedSound): void {
    const buffer = this.buffer(sound);
    if (!buffer) return;
    const node = this.ctx!.createBufferSource();
    node.buffer = buffer;
    this.route(node, buffer.numberOfChannels, null);
    node.start();
  }

  loop(sound: RenderedSound): LoopHandle | null {
    const ctx = this.ctx, buffer = this.buffer(sound);
    if (!ctx || !buffer) return null;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    const gains = Array.from({ length: buffer.numberOfChannels }, () => { const g = ctx.createGain(); g.gain.value = 0; return g; });
    this.route(node, buffer.numberOfChannels, gains);
    node.start();
    return {
      setGains: (left, right, seconds = 0.05) => {
        const now = ctx.currentTime;
        gains.forEach((g, i) => g.gain.setTargetAtTime(i % 2 === 0 ? left : right, now, Math.max(0.005, seconds / 3)));
      },
      stop: () => { try { node.stop(); } catch { /* already stopped */ } node.disconnect(); },
    };
  }
}

interface Loaded { bank: SoundBank; samples: SampleCache; borrowed: boolean }

/** The pan table's pair at `pan` against the centre's, after the square law: what a centred loop is scaled by. */
export function panGains(pan: number): [number, number] {
  const [cl] = makeVolume(127, 0, 127, 0, 127, 0);
  const centre = voiceLevel(cl);
  const [l, r] = makeVolume(127, 0, 127, pan, 127, 0);
  return [voiceLevel(l) / centre, voiceLevel(r) / centre];
}

interface Emitter { sound: string; node: string; position: [number, number, number]; handle: LoopHandle | null; gain: number }

/**
 * The walk's sound: the loaded banks, the rules that pick a sound, the listener, the reverb, the ambience, the output.
 * The `on*` methods are the event API the motion, weapon, grenade and traversal workstreams call.
 */
export class GameAudio {
  private banks: Loaded[] = [];
  private readonly lookup = new Map<string, { loaded: Loaded; index: number }>();
  private params = new Map<string, SoundParams>();
  private materials: Material[] = [];
  private defaultMaterial = 0;
  private weapons = new Map<string, WeaponSounds>();
  private callbacks = new Map<string, string[]>();
  private damageVoice: string | null = null;
  private map: string | null = null;
  private missing: string[] = [];
  private data: SoundData | null = null;
  /** RAND_PLAY's and PLAY_CYCLE's memory, which the IRX keeps in the grain across plays. */
  private readonly grainState = new Map<string, number>();
  /** The camera's world matrix, column-major (three.js `matrixWorld.elements`); null places nothing. */
  private listener: number[] | null = null;
  private volume_ = 1;
  private muted_ = false;
  private speeds: [number, number, number] | null = null;
  private played = 0;
  private readonly byName: Record<string, number> = {};
  private readonly events: Record<AudioEvent, number> = { footstep: 0, fire: 0, reload: 0, jump: 0, land: 0, callback: 0, passing: 0, play: 0 };
  private readonly dropped = { locked: 0, range: 0, unknown: 0, muted: 0, silent: 0 };
  private readonly unknownNames: Record<string, number> = {};
  private readonly recent: AudioStats['recent'] = [];
  private env: { inside: boolean; zone: number } | null = null;
  private depth = 0;
  private reverbLoaded = false;
  private ambienceWanted = false;
  private ambienceOn = false;
  private beds: { outside: LoopHandle[]; inside: LoopHandle[] } = { outside: [], inside: [] };
  private bed: 'outside' | 'inside' | null = null;
  private emitters: Emitter[] = [];
  /** The loops the worker rendered (`setLoops`), by sound name; while `loopsFollow`, the ambience waits for them. */
  private loops = new Map<string, RenderedSound>();
  private loopsFollow = false;
  /** Whether the one warning about a tree with no sound archives has been given. */
  private warned = false;

  constructor(private readonly out: AudioOut = new WebAudioOut(), private readonly random: () => number = Math.random) {
    this.out.setGain(this.gain());
  }

  /** The map's sound data from the worker (`./soundData`); null silences the walk. */
  setData(data: SoundData | null): void {
    this.stopAmbience();
    this.data = data;
    this.banks = [];
    this.lookup.clear();
    this.grainState.clear();
    this.map = data?.archive ?? null;
    this.missing = [...(data?.missing ?? [])];
    for (const { file, bytes, only } of data?.banks ?? []) {
      try {
        const bank = parseBankFile(bytes);
        const loaded = { bank, samples: new SampleCache(bank.vag), borrowed: !!only };
        this.banks.push(loaded);
        for (const [name, index] of bank.names) {
          if (only && !only.includes(name) && !only.includes(name.trim())) continue;   // a borrowed bank lends only these
          if (!this.lookup.has(name)) this.lookup.set(name, { loaded, index });
          // A bank name can carry trailing blanks the zAnims do not (MP2_am's `.THROW_OBJECT `): found by either.
          const bare = name.trim();
          if (bare !== name && !this.lookup.has(bare)) this.lookup.set(bare, { loaded, index });
        }
      } catch (e) {
        this.missing.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (data && data.banks.length === 0 && !this.warned) {
      this.warned = true;
      console.warn(`audio: no sound for ${data.archive}: ${data.missing.join('; ')}`);
    }
    this.params = new Map(data?.params ?? []);
    this.materials = data?.materials ?? [];
    this.defaultMaterial = data?.defaultMaterial ?? 0;
    this.weapons = new Map((data?.weapons ?? []).map((w) => [w.name, w]));
    this.callbacks = new Map(data?.callbacks ?? []);
    this.damageVoice = data?.damageVoice ?? null;
    this.reverbLoaded = false;
    this.env = null;
    this.loops.clear();
    this.loopsFollow = data?.loopsFollow ?? false;
    this.loadReverb();
    if (this.ambienceWanted) this.startAmbience();
  }

  /**
   * The landing classes' speeds (`landSpeeds`): the table's gravity and `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` in units.
   */
  setFallTable(gravity: number, fallDistances: readonly [number, number, number]): void {
    this.speeds = landSpeeds(gravity, fallDistances);
  }

  /** Makes the output on the first pointer or key press on `target` (and resumes it on any later one). */
  unlockOn(target: EventTarget): void {
    const unlock = (): void => {
      const was = this.out.unlocked;
      this.out.unlock();
      if (!was && this.out.unlocked) { this.loadReverb(); if (this.ambienceWanted) this.startAmbience(); }
    };
    for (const type of ['pointerdown', 'keydown', 'touchend']) target.addEventListener(type, unlock, { capture: true, passive: true });
  }

  /** The listener: the camera's world matrix (column-major, as three.js holds it), once a frame; the emitters follow. */
  setListener(matrixWorld: ArrayLike<number> | null): void {
    this.listener = matrixWorld ? Array.from(matrixWorld) : null;
    this.updateEmitters();
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

  /** A polygon's material byte as the game reads it (`FUN_002dc1d0`): 0 is the map's `DefaultMaterial`. */
  materialOf(byte: number): Material | undefined {
    return this.materials[byte === 0 ? this.defaultMaterial : byte];
  }

  // ---- the place: reverb and beds ----------------------------------------------------------------------------

  private loadReverb(): void {
    if (this.reverbLoaded || !this.out.unlocked) return;
    const preset = this.data?.reverb.preset;
    this.out.setReverb(preset ? reverbImpulse(Uint16Array.from(preset)) : null);
    this.reverbLoaded = !!preset;
    if (this.env) { const e = this.env; this.env = null; this.setEnvironment(e.inside, e.zone); }
  }

  /**
   * Where the camera is (`FUN_00341a60`, decomp 241509-241560): over a polygon flagged inside (`m_inside`, bit 23) or
   * not, and its reverb zone (bit 27). On a change the reverb's depth ramps to the zone's `IndoorReverb` or
   * `OutdoorReverb` entry over its `Seconds` (`snd_AutoReverb(2, depth x 32767, seconds x 240, 3)`), or to 0 over one
   * second when the list has no such entry; and the beds cross.
   */
  setEnvironment(inside: boolean, zone: number): void {
    if (this.env && this.env.inside === inside && this.env.zone === zone) return;
    this.env = { inside, zone };
    const list = inside ? this.data?.reverb.indoor : this.data?.reverb.outdoor;
    const entry = list?.[zone];
    this.depth = entry ? entry[0] : 0;
    this.out.rampReverb(this.depth, entry ? entry[1] : REVERB_OFF_SECONDS);
    this.crossBeds();
  }

  // ---- the ambience ------------------------------------------------------------------------------------------

  /**
   * The beds and emitters as the worker rendered them (`renderAmbienceLoops`), so no loop is rendered on the page's
   * thread (the insects' 37 voices take the better part of a second); the ambience starts once they are in.
   */
  setLoops(loops: readonly { name: string; sound: RenderedSound }[]): void {
    for (const l of loops) this.loops.set(l.name, l.sound);
    this.loopsFollow = false;
    if (this.ambienceWanted) this.startAmbience();
  }

  /** The ambience on (walking) or off: the beds and the emitters, started once the output is unlocked. */
  setAmbience(on: boolean): void {
    this.ambienceWanted = on;
    if (on) this.startAmbience();
    else this.stopAmbience();
  }

  /**
   * Renders a looping sound once (per ambience start: emitters of one sound share the render) and starts it silent;
   * null when the bank lacks it or the output is locked.
   */
  private startLoop(name: string, cache: Map<string, RenderedSound>): LoopHandle | null {
    const found = this.lookup.get(name) ?? this.lookup.get(name.trim());
    if (!found || !this.out.unlocked) return null;
    let r = cache.get(name) ?? this.loops.get(name);
    if (!r) {
      r = renderLoop(found.loaded.bank, found.index, found.loaded.samples, LOOP_SECONDS_PLACEHOLDER, LOOP_FADE_SECONDS_PLACEHOLDER,
        { random: this.random, state: this.grainState });
      cache.set(name, r);
    }
    this.byName[name] = (this.byName[name] ?? 0) + 1;
    return this.out.loop(r);
  }

  private startAmbience(): void {
    if (this.ambienceOn || !this.data || !this.out.unlocked || this.loopsFollow) return;
    this.ambienceOn = true;
    const cache = new Map<string, RenderedSound>();
    for (const side of ['outside', 'inside'] as const) {
      this.beds[side] = this.data.beds[side].map((s) => this.startLoop(s, cache)).filter((h): h is LoopHandle => h !== null);
    }
    this.bed = null;
    this.crossBeds();
    this.emitters = this.data.emitters.map((e) => ({ sound: e.sound, node: e.node, position: e.position, handle: this.startLoop(e.sound, cache), gain: 0 }));
    this.updateEmitters();
  }

  private stopAmbience(): void {
    for (const h of [...this.beds.outside, ...this.beds.inside]) h.stop();
    for (const e of this.emitters) e.handle?.stop();
    this.beds = { outside: [], inside: [] };
    this.emitters = [];
    this.bed = null;
    this.ambienceOn = false;
  }

  /** The bed for the camera's place up, the other down (`check_camera_inside_state1`: stop one zAnim, start the other). */
  private crossBeds(): void {
    if (!this.ambienceOn) return;
    const bed = this.env?.inside ? 'inside' : 'outside';
    if (bed === this.bed) return;
    this.bed = bed;
    for (const h of this.beds.outside) h.setGains(bed === 'outside' ? 1 : 0, bed === 'outside' ? 1 : 0, BED_FADE_SECONDS_PLACEHOLDER);
    for (const h of this.beds.inside) h.setGains(bed === 'inside' ? 1 : 0, bed === 'inside' ? 1 : 0, BED_FADE_SECONDS_PLACEHOLDER);
  }

  /** Each emitter's gains from the camera: its `RANGE` fall-off (squared by 989snd's law) and its azimuth's pan pair. */
  private updateEmitters(): void {
    if (!this.ambienceOn || !this.listener) return;
    for (const e of this.emitters) {
      if (!e.handle) continue;
      const [distance, right, forward] = this.local(e.position);
      const g = rangeGain(distance, this.rangeOf(e.sound));
      e.gain = g * g;
      const [l, r] = panGains(distance > 1e-6 ? panDegrees(right, forward) : 0);
      e.handle.setGains(e.gain * l, e.gain * r);
    }
  }

  // ---- the event API -----------------------------------------------------------------------------------------

  /**
   * A footfall (`FUN_005a39b0`): the material under the foot (the collision polygon's `material` byte, 0 the map's
   * `DefaultMaterial`), where the foot came down, the stance and the stick's largest axis. Returns the sound's name,
   * or null for a silent surface.
   */
  onFootstep(material: number, position: Vec3 | null, options: { stance?: StanceCode; stick?: number } = {}): string | null {
    this.events.footstep++;
    const name = footstepSound(this.materialOf(material), options.stance ?? 0, options.stick ?? 1);
    if (!name) { this.dropped.silent++; return null; }                  // a surface with no step sound (INVISIBLE_DI ...)
    return this.play(name, position, 'footstep') ? name : null;
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

  /**
   * A reload of `weapon`: its `ReloadSound`, at the reload's start -- `FUN_005c2a90` plays it at the actor
   * (`+0x1c`) in the same step that takes the next magazine and starts the reload (decomp 477484-477537).
   */
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
   * the deadly -- the material under the feet (0 the map's `DefaultMaterial`), and where. A landing that hurts adds the
   * SEAL's `CHRSND_DAMAGE` (`landingHurts`). Returns the sounds played.
   */
  onLand(landing: LandingInput, material: number, position: Vec3 | null = null): string[] {
    this.events.land++;
    let cls: LandingClass;
    if (typeof landing === 'number') cls = this.speeds ? landingClass(landing, this.speeds) : 0;
    else cls = landing === 'deadly' ? 3 : landing === 'harder' ? 2 : 0;
    const names = landingSounds(this.materialOf(material), cls);
    if (names.length === 0) this.dropped.silent++;
    if (landingHurts(cls) && this.damageVoice) names.push(this.damageVoice);
    return names.filter((name) => this.play(name, position, 'land'));
  }

  /**
   * A `zanim_callback` fired by a clip (`motion.rdr`), or any zAnim by name (a grenade's `frag_grenade_stone`): the
   * sounds it plays, through the animations it starts (the first returned; all are started), or null when none.
   */
  onAnimCallback(name: string, position: Vec3 | null = null): string | null {
    this.events.callback++;
    return this.callback(name, position);
  }

  /**
   * A round's path this tick, `from` to `to`, against the SEAL at `actor` (`FUN_00598000`): `.BUL_PASSING` at the
   * path's nearest point when that is within 20 units (`.ROCKET_BY` within 100 for a rocket). For another shooter's
   * rounds only -- the player's own leave from the player (`passingSound`).
   */
  onRoundPast(from: Vec3, to: Vec3, actor: Vec3, rocket = false): string | null {
    this.events.passing++;
    const hit = passingSound(actor, from, to, rocket);
    return hit && this.play(hit.sound, hit.at, 'passing') ? hit.sound : null;
  }

  private callback(name: string, position: Vec3 | null): string | null {
    const sounds = this.callbacks.get(name);
    if (!sounds) { this.dropped.silent++; return null; }                // a zAnim that plays no sound, or no such zAnim
    // Through the effects' name table (`./soundNames`): a casing's `.BUL_CASE_METAL` is the banks' `.BUL_CAS_METAL`.
    const played = sounds.map((sound) => soundFor(sound, (n) => this.has(n))).filter((sound) => this.play(sound, position, 'callback'));
    return played[0] ?? null;
  }

  /** Whether the map's loaded banks hold a sound of that name (the effects' casing fallbacks ask it). */
  has(name: string): boolean {
    return this.lookup.has(name) || this.lookup.has(name.trim());
  }

  /**
   * Plays a sound by its bank name (`.STEP_STONE`) at `position` (null: without a place). False when it did not
   * sound: locked, muted, out of its range, or a name the map's banks do not hold.
   */
  play(name: string, position: Vec3 | null = null, event: AudioEvent = 'play'): boolean {
    if (event === 'play') this.events.play++;
    const found = this.lookup.get(name) ?? this.lookup.get(name.trim());
    if (!found) { this.dropped.unknown++; this.unknownNames[name] = (this.unknownNames[name] ?? 0) + 1; return false; }
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
    return (this.params.get(name) ?? this.params.get(name.trim()))?.range ?? DEFAULT_RANGE_PLACEHOLDER;
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
      banks: this.banks.map((b) => ({ name: b.bank.name, sounds: b.bank.sounds.length, ...(b.borrowed ? { borrowed: true } : {}) })),
      decoded: this.banks.reduce((n, b) => n + b.samples.size, 0),
      played: this.played, byName: { ...this.byName }, events: { ...this.events }, dropped: { ...this.dropped },
      unknownNames: { ...this.unknownNames },
      recent: this.recent.map((r) => ({ ...r })),
      defaultMaterial: this.materials[this.defaultMaterial]?.name ?? null,
      reverb: { loaded: this.reverbLoaded, inside: this.env?.inside ?? false, zone: this.env?.zone ?? 0, depth: this.depth },
      ambience: {
        on: this.ambienceOn, beds: { outside: [...(this.data?.beds.outside ?? [])], inside: [...(this.data?.beds.inside ?? [])] }, bed: this.bed,
        emitters: this.emitters.filter((e) => e.handle).map((e) => ({ sound: e.sound, node: e.node, gain: e.gain })),
      },
      missing: [...this.missing],
    };
  }
}

/**
 * The page's one `GameAudio`: `main.ts` feeds it the map's data, the listener and the walk's events; the UI's panel
 * calls `setVolume` / `setMuted` on it, and the motion, weapon, grenade and traversal workstreams its `on*` methods.
 */
export const gameAudio = new GameAudio();
