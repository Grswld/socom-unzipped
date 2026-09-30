import { bankTone, GRAIN, type BankSound, type Grain, type SoundBank, type Tone } from './bank';
import { decodeVag, type VagSample } from './vag';

/**
 * One 989snd sound rendered to PCM: the grain sequencer (the IRX's `BlockSoundHandler`), its voices (a tone's sample
 * at its pitch under the SPU's ADSR) and the volume and pan arithmetic, run offline into a stereo buffer the page then
 * plays (web/redotcom/docs/research/81 §3). It is a transliteration of the repository's own model of the IRX,
 * `third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp` (research/32 §3 and §5, research/36): `doGrain` and
 * `stepGrain`, `startTone`, `note2Pitch`/`sceSdNote2Pitch`, `makeVolume`, the square-law `adjustVolToGroup`, the SPU's
 * half-scale voice (`>> 1`) and the psx-spx ADSR `Envelope`, at the same 240 Hz tick and 48 kHz output. What it does
 * not model, as that mixer does not: LFO, XREF and plugin grains (none of the sounds the walk plays carries one);
 * the global registers read 0 here (the game sets them for the mission ambience, not for these).
 *
 * The one difference in kind: the console's mixer runs the sound against the live clock, this renders it whole at
 * the moment it starts -- with the volume and the pan the game computed at that moment (`FUN_00342670`, §5). A
 * one-shot the game never re-pans (a step, a shot, a landing) comes out the same.
 */

/** The SPU2's output rate: pitch 0x1000 plays a sample at 48 kHz (research/32 §3). */
export const OUTPUT_RATE = 48_000;
/** The grain clock (research/32 §3, the mixer's `kTickHz`). */
export const TICK_HZ = 240;
/** `PAN_RESET` (research/32 §2): the play call's pan -1 takes the sound's own. */
export const PAN_RESET = -1;
/**
 * PLACEHOLDER (not the game's): the longest a one-shot is rendered before its voices are keyed off -- a guard for a
 * sample that loops with no KEY_OFF grain, which on the console plays until the game stops it.
 */
export const MAX_RENDER_SECONDS_PLACEHOLDER = 4;

/** The decoded samples of one bank, by VAG offset: decoded once, rendered from many times. */
export class SampleCache {
  private readonly cache = new Map<number, VagSample | null>();
  constructor(private readonly vag: Uint8Array) {}
  get(offset: number): VagSample | null {
    let s = this.cache.get(offset);
    if (s === undefined) {
      s = offset < this.vag.byteLength ? decodeVag(this.vag, offset) : null;
      if (s && s.pcm.length === 0) s = null;
      this.cache.set(offset, s);
    }
    return s;
  }
  get size(): number { return this.cache.size; }
}

export interface RenderOptions {
  /** The play call's volume, 0..0x400 (1024 = the sound's own; research/32 §2). */
  vol?: number;
  /** The play call's pan in degrees, 0 ahead, 90 right, 270 left; `PAN_RESET` for the sound's own. */
  pan?: number;
  /** The play call's pitch modulation, 1/128 semitone. */
  pitchMod?: number;
  /** A generator in [0, 1): the grains' `rand()`. */
  random?: () => number;
  /** RAND_PLAY's last pick and PLAY_CYCLE's index, kept per grain across plays as the IRX keeps them in the grain. */
  state?: Map<string, number>;
  maxSeconds?: number;
  /**
   * A looping bed or emitter: rendered exactly `maxSeconds` long with nothing keyed off at the end, for the page to
   * loop (`./audio`'s ambience) -- a one-shot's voices are released at `maxSeconds` and their release rendered.
   */
  loop?: boolean;
  /**
   * `snd_SetSFXGlobalReg`'s 32 global registers (1-based in the game's call; `globals[0]` is global 1): a grain names
   * global N as register -N, a tone's volume or pan sentinel -6 on as global 1 on. SOCOM sets global 2 every frame from
   * the camera's height (`FUN_00341a60`, `globalRegister2`); the rest read 0.
   */
  globals?: readonly number[];
}

export interface RenderedSound {
  /** The dry mix: every voice but a tone flagged reverb-only (flags bit 4). */
  left: Float32Array;
  right: Float32Array;
  /**
   * The reverb send: the voices whose tone carries flags bit 0 (web/redotcom/docs/research/81 §9: SOCOM's IRX sets the voice's
   * VMIXEL/VMIXER effect-input bits from it, `989SND.IRX` decomp 14339-14345), at their volumes; null with none.
   */
  sendLeft: Float32Array | null;
  sendRight: Float32Array | null;
  sampleRate: number;
  /** Voices the grains started. */
  voices: number;
  /** The tones' sample offsets, in the order they started. */
  samples: number[];
  /** The loudest sample, 0..1. */
  peak: number;
}

// ---- pitch -------------------------------------------------------------------------------------------------

const NOTE_PITCH: number[] = (() => {
  const t: number[] = [];
  for (let i = 0; i < 12; i++) t.push(Math.round(32768 * 2 ** (i / 12)));
  for (let i = 0; i < 128; i++) t.push(Math.round(32768 * 2 ** (i / 1536)));
  return t;
})();

const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** `sceSdNote2Pitch` as the mixer transliterates it: the SPU pitch word, 0x1000 = the output rate. */
export function sdNote2Pitch(centerNote: number, centerFine: number, note: number, fine: number): number {
  const _fine = fine + centerFine;
  let _fine2 = _fine;
  if (_fine < 0) _fine2 = _fine + 127;
  _fine2 = idiv(_fine2, 128);
  const _note = note + _fine2 - centerNote;
  let val3 = idiv(_note, 6);
  if (_note < 0) val3--;
  const offset2 = _fine - _fine2 * 128;
  let val2 = _note < 0 ? -1 : 0;
  if (val3 < 0) val3--;
  val2 = idiv(val3, 2) - val2;
  let val = val2 - 2;
  let offset1 = _note - val2 * 12;
  if (offset1 < 0 || (offset1 === 0 && offset2 < 0)) { offset1 += 12; val = val2 - 3; }
  let off2 = offset2;
  if (off2 < 0) { offset1 = offset1 - 1 + _fine2; off2 += (_fine2 + 1) * 128; }
  offset1 = Math.min(11, Math.max(0, offset1));
  off2 = Math.min(127, Math.max(0, off2));
  let ret = Math.floor((NOTE_PITCH[offset1]! * NOTE_PITCH[off2 + 12]!) / 0x10000);
  if (val < 0) ret = Math.floor((ret + 2 ** (-val - 1)) / 2 ** -val);
  else if (val > 0) ret = ret * 2 ** val;
  return Math.min(0xffff, Math.max(0, ret));
}

/** `note2Pitch` (`PS1Note2Pitch`): a non-negative centre note is a PS1 tone and its pitch is scaled by 44100/48000. */
export function note2Pitch(centerNote: number, centerFine: number, note: number, fine: number): number {
  const ps1 = centerNote >= 0;
  const pitch = sdNote2Pitch(ps1 ? centerNote : -centerNote, centerFine & 0xff, note, fine);
  return ps1 ? idiv(44100 * pitch, 48000) : pitch;
}

// ---- volume and pan ----------------------------------------------------------------------------------------

const PAN_TABLE: [number, number][] = (() => {
  const t: [number, number][] = [];
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * (Math.PI / 2);
    t.push([Math.round(0x3fff * Math.cos(a)), Math.round(0x3fff * Math.sin(a))]);
  }
  return t;
})();

/** `VoiceManager::MakeVolume(vol1, pan1, vol2, pan2, vol3, pan3)`: the stereo pair, 0..0x7ffe each. */
export function makeVolume(vol1: number, pan1: number, vol2: number, pan2: number, vol3: number, pan3: number): [number, number] {
  let vol = vol1 * 258;
  vol = idiv(vol * vol2, 0x7f);
  vol = idiv(vol * vol3, 0x7f);
  if (vol <= 0) return [0, 0];
  let total = pan1 + pan3 + pan2;
  while (total >= 360) total -= 360;
  while (total < 0) total += 360;
  total = total >= 270 ? total - 270 : total + 90;
  if (total < 180) return [idiv(PAN_TABLE[total]![0] * vol, 0x3fff), idiv(PAN_TABLE[total]![1] * vol, 0x3fff)];
  const t = PAN_TABLE[total - 180]!;
  return [idiv(t[1] * vol, 0x3fff), idiv(t[0] * vol, 0x3fff)];
}

/**
 * `snd_AdjustVolToGroup` (research/36 Q6 item 1): the group master (0x400, the default) scales, then the SQUARE law
 * -- `v * v / 0x7ffe` -- then the SPU voice's half scale. The voice level a pair becomes, 0..0x3fff.
 */
export function voiceLevel(vol14: number, modifier = 0x400): number {
  const v = idiv(Math.min(vol14, 0x7ffe) * modifier, 0x400);
  return idiv(v * v, 0x7ffe) >> 1;
}

// ---- the SPU ADSR (psx-spx, the mixer's Envelope) ----------------------------------------------------------

const enum Phase { Attack, Decay, Sustain, Release, Off }

class Envelope {
  phase = Phase.Attack;
  level = 0;
  private cycles = 0;
  constructor(private readonly adsr1: number, private readonly adsr2: number) {}
  keyOff(): void { if (this.phase !== Phase.Off) this.phase = Phase.Release; this.cycles = 0; }
  private rate(shift: number, stepValue: number, exponential: boolean, decrease: boolean): [number, number] {
    let cyc = 1 << Math.max(0, shift - 11);
    let step = stepValue * (1 << Math.max(0, 11 - shift));
    if (exponential && !decrease && this.level > 0x6000) cyc *= 4;
    if (exponential && decrease) step = idiv(step * this.level, 0x8000);
    return [step, cyc];
  }
  /** One sample; false once the voice is off. */
  tick(): boolean {
    if (this.phase === Phase.Off) return false;
    if (this.cycles > 0) { this.cycles--; return true; }
    let step = 0, cyc = 1;
    const a1 = this.adsr1, a2 = this.adsr2;
    switch (this.phase) {
      case Phase.Attack:
        [step, cyc] = this.rate((a1 >> 10) & 0x1f, 7 - ((a1 >> 8) & 3), (a1 & 0x8000) !== 0, false);
        this.level += step;
        if (this.level >= 0x7fff) { this.level = 0x7fff; this.phase = Phase.Decay; }
        break;
      case Phase.Decay: {
        [step, cyc] = this.rate((a1 >> 4) & 0x0f, -8, true, true);
        this.level += step;
        const sustain = ((a1 & 0x0f) + 1) * 0x800;
        if (this.level <= sustain) { this.level = Math.max(this.level, 0); this.phase = Phase.Sustain; }
        break;
      }
      case Phase.Sustain: {
        const decrease = (a2 & 0x4000) !== 0;
        const stepValue = decrease ? -(8 - ((a2 >> 6) & 3)) : 7 - ((a2 >> 6) & 3);
        [step, cyc] = this.rate((a2 >> 8) & 0x1f, stepValue, (a2 & 0x8000) !== 0, decrease);
        this.level = Math.min(0x7fff, Math.max(0, this.level + step));
        break;
      }
      case Phase.Release:
        [step, cyc] = this.rate(a2 & 0x1f, -8, (a2 & 0x20) !== 0, true);
        this.level += step;
        if (this.level <= 0) { this.level = 0; this.phase = Phase.Off; }
        break;
      default: break;
    }
    this.cycles = Math.max(0, cyc - 1);
    return this.phase !== Phase.Off;
  }
}

// ---- the sequencer -----------------------------------------------------------------------------------------

interface Voice {
  handler: Handler;
  sample: VagSample;
  step: number;
  pos: number;
  left: number;   // 0..0x3fff after the group stage and the SPU's half
  right: number;
  env: Envelope;
  /** The output frame the voice starts on. */
  start: number;
  /** The frame a KEY_OFF_VOICES (or the length guard) releases it on; the frame a KILL_VOICES stops it dead on. */
  keyOffAt: number;
  killAt: number;
  /** When its sample runs out at its pitch, for WAIT_FOR_ALL_VOICES: a looping sample's is its key-off. */
  endsAt: number;
  /** Tone flags bit 0: into the reverb; bit 4: into the reverb only (the dry mix's VMIXL/VMIXR bits cleared). */
  reverb: boolean;
  dry: boolean;
}

interface Handler {
  sound: number;
  countdown: number;
  nextGrain: number;
  done: boolean;
  /** The play call's volume (0..0x400), or a child's share of its parent's; the sound's (or child spec's) own Vol. */
  appVolume: number;
  origVolume: number;
  curVolume: number;
  curPan: number;
  curPb: number;
  curPm: number;
  regs: number[];
  skipGrains: boolean;
  grainsToPlay: number;
  grainsToSkip: number;
  parent: Handler | null;
}

const param8 = (g: Grain, i: number): number => (((g.arg >> (8 * i)) & 0xff) << 24) >> 24;

/**
 * Renders sound `index` of `bank` from its first grain until its grains and voices are done. The buffers are the
 * console's mix of that sound alone, as floats of full scale.
 */
export function renderSound(bank: SoundBank, index: number, samples: SampleCache, options: RenderOptions = {}): RenderedSound {
  const random = options.random ?? Math.random;
  const rand = (): number => Math.floor(random() * 0x8000);   // rand(): 0..RAND_MAX, RAND_MAX 0x7fff
  const state = options.state ?? new Map<string, number>();
  const maxFrames = Math.round((options.maxSeconds ?? MAX_RENDER_SECONDS_PLACEHOLDER) * OUTPUT_RATE);
  const framesPerTick = OUTPUT_RATE / TICK_HZ;
  const sound = bank.sounds[index];
  if (!sound) throw new Error(`bank ${bank.name}: no sound ${index}`);
  const voices: Voice[] = [];
  const handlers: Handler[] = [];
  const started: number[] = [];
  let frame = 0;

  const makeHandler = (i: number, snd: BankSound, vol: number, orig: number, pan: number, parent: Handler | null): Handler => ({
    sound: i, countdown: snd.grains[0]?.delay ?? 0, nextGrain: 0, done: snd.grains.length === 0,
    appVolume: vol, origVolume: orig, curVolume: Math.min(127, Math.max(0, (vol * orig) >> 10)), curPan: pan,
    curPb: parent?.curPb ?? 0, curPm: parent?.curPm ?? options.pitchMod ?? 0,
    regs: parent ? [...parent.regs] : [0, 0, 0, 0], skipGrains: false, grainsToPlay: 0, grainsToSkip: 0, parent,
  });
  const spawned: Handler[] = [];
  const normPan = (p: number): number => ((p % 360) + 360) % 360;
  const appVol = Math.max(0, Math.min(0x7fff, Math.round(options.vol ?? 0x400)));
  const appPan = options.pan === undefined || options.pan === PAN_RESET ? sound.pan : normPan(options.pan);
  handlers.push(makeHandler(index, sound, appVol, sound.vol, normPan(appPan), null));

  const globals = options.globals ?? [];
  const globalReg = (i: number): number => globals[i] ?? 0;   // 0-based: global 1 is [0]
  const readReg = (h: Handler, reg: number): number => (reg < 0 ? globalReg(-reg - 1) : reg < 4 ? h.regs[reg]! : 0);
  const writeReg = (h: Handler, reg: number, value: number): void => {
    if (reg >= 0 && reg < 4) h.regs[reg] = Math.max(-128, Math.min(127, value));
  };
  const resolveVol = (h: Handler, vol: number): number => {
    if (vol >= 0) return vol;
    if (vol >= -4) return Math.max(0, h.regs[-vol - 1]!);
    if (vol === -5) return rand() % 0x7f;
    return Math.max(0, globalReg(-vol - 6));
  };
  const resolvePan = (h: Handler, pan: number): number => {
    if (pan < 0) {
      if (pan === -5) return rand() % 360;
      pan = idiv(360 * (pan >= -4 ? h.regs[-pan - 1]! : globalReg(-pan - 6)), 127);
    }
    return normPan(pan);
  };

  const startTone = (h: Handler, tone: Tone): void => {
    const sample = samples.get(tone.sampleOffset);
    if (!sample) return;
    const v9 = (60 << 7) + 0 + h.curPm;   // the handler's note 60, fine 0 (the mixer's Handler defaults)
    const v7 = h.curPb >= 0 ? idiv(tone.pbHigh * (h.curPb * 128), 0x7fff) + v9 : idiv(tone.pbLow * (h.curPb * 128), 0x8000) + v9;
    const pitch = note2Pitch(tone.centerNote, tone.centerFine, idiv(v7, 128), v7 % 128);
    const [l, r] = makeVolume(127, 0, h.curVolume, h.curPan, resolveVol(h, tone.vol), resolvePan(h, tone.pan));
    const step = pitch / 4096;
    voices.push({
      handler: h, sample, step, pos: 0, left: voiceLevel(l), right: voiceLevel(r),
      env: new Envelope(tone.adsr1, tone.adsr2), start: frame, keyOffAt: Infinity, killAt: Infinity,
      reverb: (tone.flags & 1) !== 0, dry: (tone.flags & 0x10) === 0,
      endsAt: sample.loops || step <= 0 ? Infinity : frame + Math.ceil(sample.pcm.length / step),
    });
    started.push(tone.sampleOffset);
  };
  const keyOff = (h: Handler): void => {
    for (const v of voices) if (v.handler === h && v.keyOffAt === Infinity) { v.keyOffAt = frame; v.endsAt = Math.min(v.endsAt, frame); }
  };
  const slotKey = (h: Handler, grain: number): string => `${bank.name}:${h.sound}:${grain}`;
  const gotoMarker = (h: Handler, snd: BankSound, target: number): void => {
    const i = snd.grains.findIndex((g) => g.type === GRAIN.MARKER && param8(g, 0) === target);
    if (i >= 0) h.nextGrain = i - 1;
  };
  const voicesPlaying = (h: Handler): boolean => voices.some((v) => v.handler === h && frame < Math.min(v.endsAt, v.killAt));
  const childSpec = (g: Grain): { vol: number; soundId: number } | null => {
    if (g.arg + 16 > bank.grainData.byteLength) return null;
    const dv = new DataView(bank.grainData.buffer, bank.grainData.byteOffset + g.arg, 16);
    return { vol: dv.getInt32(0, true), soundId: dv.getInt32(12, true) };
  };

  const doGrain = (h: Handler, snd: BankSound, g: Grain): number => {
    switch (g.type) {
      case GRAIN.TONE: case GRAIN.TONE2: { const t = bankTone(bank, g); if (t) startTone(h, t); break; }
      case GRAIN.STARTCHILDSOUND: {
        const spec = childSpec(g);
        const child = spec && bank.sounds[spec.soundId];
        if (spec && child && child.grains.length > 0) {
          // The mixer's startChild: the spec's volume (magnitude, 0..127) under the parent's app x orig / 127.
          const orig = Math.min(127, Math.abs(resolveVol(h, spec.vol)));
          spawned.push(makeHandler(spec.soundId, child, idiv(h.appVolume * h.origVolume, 127), orig, h.curPan, h));
        }
        break;
      }
      case GRAIN.STOPCHILDSOUND: {
        const spec = childSpec(g);
        for (const c of handlers) {
          if (c.parent !== h || !spec || c.sound !== spec.soundId) continue;
          c.done = true;
          for (const v of voices) if (v.handler === c) v.killAt = Math.min(v.killAt, frame);   // erased: stopped dead
        }
        break;
      }
      case GRAIN.RAND_DELAY: return rand() % ((g.arg & 0xffffff) + 1);
      case GRAIN.RAND_PB: h.curPb = idiv(param8(g, 0) * (idiv(0xffff * (rand() % 0x7fff), 0x7fff) - 0x8000), 100); break;
      case GRAIN.PB: { const pb = param8(g, 0); h.curPb = pb >= 0 ? idiv(0x7fff * pb, 127) : idiv(-0x8000 * pb, -128); break; }
      case GRAIN.ADD_PB: h.curPb = Math.max(-32768, Math.min(32767, h.curPb + idiv(0x7fff * param8(g, 0), 127))); break;
      case GRAIN.LOOP_END:
        for (let i = h.nextGrain - 1; i >= 0; i--) if (snd.grains[i]!.type === GRAIN.LOOP_START) { h.nextGrain = i - 1; break; }
        break;
      case GRAIN.LOOP_CONTINUE:
        for (let i = h.nextGrain + 1; i < snd.grains.length; i++) if (snd.grains[i]!.type === GRAIN.LOOP_END) { h.nextGrain = i; break; }
        break;
      case GRAIN.STOP: h.done = true; break;
      case GRAIN.RAND_PLAY: {
        const options_ = param8(g, 0), count = param8(g, 1);
        if (options_ <= 0) break;
        const key = slotKey(h, h.nextGrain);
        const previous = state.get(key) ?? param8(g, 2);
        let pick = rand() % options_;
        if (pick === previous && ++pick >= options_) pick = 0;
        state.set(key, pick);
        h.nextGrain += pick * count;
        h.grainsToPlay = count + 1;
        h.grainsToSkip = (options_ - 1 - pick) * count;
        h.skipGrains = true;
        break;
      }
      case GRAIN.PLAY_CYCLE: {
        const size = param8(g, 0), groupCount = param8(g, 1);
        if (size <= 0) break;
        const key = slotKey(h, h.nextGrain);
        const a = state.get(key) ?? param8(g, 2);
        state.set(key, a + 1 >= size ? 0 : a + 1);
        h.nextGrain += groupCount * a;
        h.grainsToPlay = groupCount + 1;
        h.grainsToSkip = (size - 1 - a) * groupCount;
        h.skipGrains = true;
        break;
      }
      case GRAIN.SET_REGISTER: writeReg(h, param8(g, 0), param8(g, 1)); break;
      case GRAIN.SET_REGISTER_RAND: {
        const lo = param8(g, 1), range = param8(g, 2) - lo + 1;
        if (range > 0) writeReg(h, param8(g, 0), (rand() % range) + lo);
        break;
      }
      case GRAIN.INC_REGISTER: writeReg(h, param8(g, 0), readReg(h, param8(g, 0)) + 1); break;
      case GRAIN.DEC_REGISTER: writeReg(h, param8(g, 0), readReg(h, param8(g, 0)) - 1); break;
      case GRAIN.ADD_REGISTER: writeReg(h, param8(g, 1), readReg(h, param8(g, 1)) + param8(g, 0)); break;
      case GRAIN.COPY_REGISTER: writeReg(h, param8(g, 1), readReg(h, param8(g, 0))); break;
      case GRAIN.TEST_REGISTER: {
        const value = readReg(h, param8(g, 0)), action = param8(g, 1), cmp = param8(g, 2);
        if (action === 0 ? value >= cmp : action === 1 ? value !== cmp : cmp >= value) h.nextGrain++;
        break;
      }
      case GRAIN.GOTO_MARKER: gotoMarker(h, snd, param8(g, 0)); break;
      case GRAIN.GOTO_RANDOM_MARKER: {
        const lo = param8(g, 0), range = param8(g, 1) - lo + 1;
        if (range > 0) gotoMarker(h, snd, (rand() % range) + lo);
        break;
      }
      case GRAIN.WAIT_FOR_ALL_VOICES:
        if (voicesPlaying(h)) { h.nextGrain--; return 1; }
        break;
      case GRAIN.ON_STOP_MARKER: h.nextGrain = snd.grains.length - 1; break;
      case GRAIN.KEY_OFF_VOICES: keyOff(h); break;
      case GRAIN.KILL_VOICES: for (const v of voices) if (v.handler === h) v.killAt = Math.min(v.killAt, frame); break;
      default: break;   // LFO, XREF, plugins, markers: not modelled (the header)
    }
    return 0;
  };

  const stepGrain = (h: Handler): void => {
    const snd = bank.sounds[h.sound]!;
    if (h.nextGrain < 0 || h.nextGrain >= snd.grains.length) { h.done = true; return; }
    const ret = doGrain(h, snd, snd.grains[h.nextGrain]!);
    if (h.skipGrains && --h.grainsToPlay === 0) { h.nextGrain += h.grainsToSkip; h.skipGrains = false; }
    h.nextGrain++;
    if (h.nextGrain >= snd.grains.length) { h.done = true; return; }
    if (h.nextGrain < 0) h.nextGrain = 0;
    h.countdown = snd.grains[h.nextGrain]!.delay + ret;
  };
  const runGrains = (h: Handler): void => { for (let guard = 0; h.countdown <= 0 && !h.done && guard < 256; guard++) stepGrain(h); };

  // The grains, tick by tick, until every handler is done (or the guard): a voice records the frame it starts on.
  // Children a grain starts join after the walk and run their first grains at once (the mixer's flushSpawned).
  const flush = (): void => {
    for (let guard = 0; spawned.length > 0 && guard < 64; guard++) {
      for (const c of spawned.splice(0)) { handlers.push(c); runGrains(c); }
    }
  };
  runGrains(handlers[0]!);
  flush();
  let tickAt = 0;
  while (handlers.some((h) => !h.done) && frame < maxFrames) {
    frame = Math.round((tickAt += framesPerTick));
    for (const h of handlers) {
      if (h.done) continue;
      h.countdown--;
      runGrains(h);
    }
    flush();
  }
  // A looping sample nothing keyed off is released at the guard -- or, for a loop, simply cut there.
  const cap = maxFrames;
  if (!options.loop) for (const v of voices) if (v.keyOffAt === Infinity && v.sample.loops) v.keyOffAt = cap;

  // The voices, sample by sample: the envelope, the linear interpolation, the pair.
  let length = options.loop ? cap : 0;
  const rendered: { v: Voice; l: Float32Array }[] = [];
  const limit = options.loop ? cap : cap + OUTPUT_RATE;   // a one-shot's release after the cap still ends
  for (const v of voices) {
    const out = new Float32Array(Math.max(0, limit - v.start));
    const pcm = v.sample.pcm;
    let n = 0;
    for (; v.start + n < limit; n++) {
      if (v.start + n >= v.killAt) break;
      if (v.start + n === v.keyOffAt) v.env.keyOff();
      if (!v.env.tick()) break;
      let i0 = Math.floor(v.pos);
      if (i0 >= pcm.length) {
        if (v.sample.loops && v.sample.loopStart < pcm.length) { v.pos = v.sample.loopStart + (v.pos - pcm.length); i0 = Math.floor(v.pos); }
        else break;
      }
      const i1 = Math.min(i0 + 1, pcm.length - 1), frac = v.pos - i0;
      out[n] = (pcm[i0]! * (1 - frac) + pcm[i1]! * frac) * (v.env.level / 32767);
      v.pos += v.step;
    }
    rendered.push({ v, l: out.subarray(0, n) });
    if (!options.loop) length = Math.max(length, v.start + n);
  }
  const left = new Float32Array(length), right = new Float32Array(length);
  const anySend = rendered.some(({ v }) => v.reverb);
  const sendLeft = anySend ? new Float32Array(length) : null, sendRight = anySend ? new Float32Array(length) : null;
  let peak = 0;
  for (const { v, l } of rendered) {
    const gl = v.left / 0x7ffe / 32768, gr = v.right / 0x7ffe / 32768;
    const m = Math.min(l.length, length - v.start);
    if (v.dry) {
      for (let n = 0; n < m; n++) { left[v.start + n]! += l[n]! * gl; right[v.start + n]! += l[n]! * gr; }
    }
    if (v.reverb && sendLeft && sendRight) {
      for (let n = 0; n < m; n++) { sendLeft[v.start + n]! += l[n]! * gl; sendRight[v.start + n]! += l[n]! * gr; }
    }
  }
  for (let n = 0; n < length; n++) peak = Math.max(peak, Math.abs(left[n]!), Math.abs(right[n]!));
  return { left, right, sendLeft, sendRight, sampleRate: OUTPUT_RATE, voices: voices.length, samples: started, peak };
}

/**
 * A looping sound (a bed, an emitter) rendered `seconds + fade` long and folded -- its last `fade` seconds crossed
 * equal-power into its first -- so the buffer repeats with no seam. The console runs such a sound's grains for ever;
 * a buffer of a few seconds' worth repeats past notice (the page's `LOOP_SECONDS_PLACEHOLDER`).
 */
export function renderLoop(bank: SoundBank, index: number, samples: SampleCache, seconds: number, fade: number, options: RenderOptions = {}): RenderedSound {
  const r = renderSound(bank, index, samples, { ...options, vol: options.vol ?? 0x400, pan: options.pan ?? 0, loop: true, maxSeconds: seconds + fade });
  const loopFrames = Math.round(seconds * OUTPUT_RATE), fadeFrames = Math.round(fade * OUTPUT_RATE);
  const fold = (x: Float32Array | null): Float32Array | null => {
    if (!x) return null;
    const y = x.slice(0, loopFrames);
    for (let i = 0; i < fadeFrames && loopFrames + i < x.length; i++) {
      const t = i / fadeFrames;
      y[i] = x[i]! * Math.sin((t * Math.PI) / 2) + x[loopFrames + i]! * Math.cos((t * Math.PI) / 2);
    }
    return y;
  };
  return { ...r, left: fold(r.left)!, right: fold(r.right)!, sendLeft: fold(r.sendLeft), sendRight: fold(r.sendRight) };
}

/**
 * A loop whose first voice comes late -- the crickets' conductor waits `RAND_DELAY` up to 4000 ticks (16.7 s) before a
 * burst of chirps (a local register counts the burst: not a game register) -- rendered over `longSeconds` and halved to
 * 24 kHz so the buffer stays small; its reverb send is dropped. A loop that starts a voice in `seconds` is as `renderLoop`.
 */
export function renderLoopAtLeastOneVoice(bank: SoundBank, index: number, samples: SampleCache, seconds: number, fade: number,
  longSeconds: number, options: RenderOptions = {}): RenderedSound {
  const r = renderLoop(bank, index, samples, seconds, fade, options);
  if (r.voices > 0 || longSeconds <= seconds) return r;
  const long = renderLoop(bank, index, samples, longSeconds, fade, options);
  const half = (x: Float32Array): Float32Array => {
    const y = new Float32Array(Math.floor(x.length / 2));
    for (let i = 0; i < y.length; i++) y[i] = (x[2 * i]! + x[2 * i + 1]!) / 2;
    return y;
  };
  return { ...long, left: half(long.left), right: half(long.right), sendLeft: null, sendRight: null, sampleRate: OUTPUT_RATE / 2 };
}

/**
 * `FUN_00341a60`'s global register 2 (decomp 241580-241600): the camera's height through the mission's `elevation`
 * (`FUN_002aca30`: 0 under the lower, 1 over the higher, linear between; the two swapped into order), times 255,
 * minus 128, clamped to a signed byte -- `snd_SetSFXGlobalReg(2, x)`, 989snd call 0x67, each frame. The outdoor beds of
 * Foxhunt, Enowapi, Fish Hook, The Mixer and Requiem test it (their wind at height).
 */
export function globalRegister2(height: number, elevation: readonly [number, number]): number {
  const hi = Math.max(elevation[0], elevation[1]), lo = Math.min(elevation[0], elevation[1]);
  const f = height > hi ? 1 : height < lo ? 0 : hi - lo !== 0 ? (height - lo) / (hi - lo) : 0.5;
  return Math.max(-128, Math.min(127, Math.trunc(f * 255 - 128)));
}
