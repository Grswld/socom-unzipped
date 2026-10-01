/**
 * The SPU2's reverb, as SOCOM II sets it (web/redotcom/docs/research/81 §9): `snd_SetReverbType(2, 3)` -- core 1, libsd mode 3
 * (`SD_REV_MODE_STUDIO_B`; `FUN_0033f2a0(2, 3)` at decomp 55186, 243346, 243386) -- with the depth `snd_AutoReverb`
 * ramps to per place (`./rules`'s reverb zones, from `mission.rdr`).
 *
 * **The preset** is libsd's own register table, read at run time out of the disc's `RUN/IRX/LIBSD.IRX`
 * (`findReverbPresets`): nine 0x44-byte blocks, modes 1 (Room) to 9 (Pipe), each the 32 reverb registers
 * (`dAPF1, dAPF2, vIIR, vCOMB1-4, vWALL, vAPF1, vAPF2, mLSAME, mRSAME, mLCOMB1, mRCOMB1, mLCOMB2, mRCOMB2, dLSAME,
 * dRSAME, mLDIFF, mRDIFF, mLCOMB3, mRCOMB3, mLCOMB4, mRCOMB4, dLDIFF, dRDIFF, mLAPF1, mRAPF1, mLAPF2, mRAPF2, vLIN,
 * vRIN`) and four bytes after -- found by their shape (every block ends `vLIN = vRIN = 0x8000` and a zero word), not by
 * any value copied here. Mode 3's block begins `dAPF1 0xB1, dAPF2 0x7F`, the PS1 "Studio Medium" preset's.
 *
 * **The algorithm** is the SPU's (psx-spx "SPU Reverb Formula", which PCSX2's SPU2 `Reverb.cpp` follows for the PS2):
 * same-side and cross reflections through an IIR, four comb taps, two all-pass stages, over a circular work area,
 * run at half the output rate (24 kHz), both sides a step. Addresses are in 8-byte units (four 16-bit samples); a
 * `[m - 2]` is the sample before. The volumes are signed 1.15. It is linear and time-invariant at a fixed depth, so
 * `reverbImpulse` runs it once on an impulse into each input and the page convolves (a `ConvolverNode`'s four-channel
 * "true stereo" response); the depth (`EVOL`, `vLOUT/vROUT`) is a gain after it, as it is on the SPU.
 */

/** libsd's mode numbers (`SD_REV_MODE_*`): the table's first block is mode 1. */
export const REVERB_MODE_ROOM = 1;
export const REVERB_MODE_STUDIO_B = 3;
/** The mode SOCOM II sets (`FUN_0033f2a0(2, 3)`). */
export const SOCOM_REVERB_MODE = REVERB_MODE_STUDIO_B;

const BLOCK = 0x44, REGS = 32, MODES = 9;

/** The nine presets of a libsd image, modes 1..9 at [0..8], or null when the table is not found. */
export function findReverbPresets(irx: Uint8Array): Uint16Array[] | null {
  const dv = new DataView(irx.buffer, irx.byteOffset, irx.byteLength);
  const tail = (o: number): boolean =>
    o + BLOCK <= irx.byteLength && dv.getUint16(o + 60, true) === 0x8000 && dv.getUint16(o + 62, true) === 0x8000 &&
    dv.getUint32(o + 64, true) === 0 && dv.getUint16(o, true) !== 0;
  for (let o = 0; o + BLOCK * MODES <= irx.byteLength; o += 2) {
    let all = true;
    for (let m = 0; m < MODES && all; m++) all = tail(o + BLOCK * m);
    if (!all) continue;
    const out: Uint16Array[] = [];
    for (let m = 0; m < MODES; m++) {
      const regs = new Uint16Array(REGS);
      for (let r = 0; r < REGS; r++) regs[r] = dv.getUint16(o + BLOCK * m + 2 * r, true);
      out.push(regs);
    }
    return out;
  }
  return null;
}

/** The four responses of the reverb to a unit impulse, at `sampleRate`: left in to left and right out, right in likewise. */
export interface ReverbImpulse { ll: Float32Array; lr: Float32Array; rl: Float32Array; rr: Float32Array; sampleRate: number }

const s16 = (v: number): number => ((v & 0xffff) << 16) >> 16;

/**
 * Runs the preset's reverb on an impulse into each input (the output rate's one sample: half of it in the 24 kHz tick
 * that averages two) and holds each tick's output for two output samples, until the tail falls under -80 dB of its
 * peak or `maxSeconds`. The depth is not applied (`vLOUT = vROUT = 1`).
 */
export function reverbImpulse(preset: Uint16Array, sampleRate = 48_000, maxSeconds = 4): ReverbImpulse {
  const r = Array.from(preset);
  const v = (i: number): number => s16(r[i]!) / 0x8000;
  const [dAPF1, dAPF2] = [r[0]! * 4, r[1]! * 4];
  const [vIIR, vCOMB1, vCOMB2, vCOMB3, vCOMB4, vWALL, vAPF1, vAPF2] = [v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9)];
  const a = (i: number): number => r[i]! * 4;
  const mLSAME = a(10), mRSAME = a(11), mLCOMB1 = a(12), mRCOMB1 = a(13), mLCOMB2 = a(14), mRCOMB2 = a(15);
  const dLSAME = a(16), dRSAME = a(17), mLDIFF = a(18), mRDIFF = a(19), mLCOMB3 = a(20), mRCOMB3 = a(21);
  const mLCOMB4 = a(22), mRCOMB4 = a(23), dLDIFF = a(24), dRDIFF = a(25), mLAPF1 = a(26), mRAPF1 = a(27);
  const mLAPF2 = a(28), mRAPF2 = a(29);
  const vLIN = v(30), vRIN = v(31);
  const size = Math.max(...r.slice(10, 30).map((x) => x * 4), dAPF1, dAPF2) + 8;
  const ticks = Math.ceil((maxSeconds * sampleRate) / 2);

  const run = (inL: number, inR: number): [Float32Array, Float32Array] => {
    const buf = new Float32Array(size);
    const outL = new Float32Array(ticks), outR = new Float32Array(ticks);
    let base = 0, peak = 0, last = 0;
    const at = (o: number): number => { const i = (base + o) % size; return i < 0 ? i + size : i; };
    const rd = (o: number): number => buf[at(o)]!;
    const wr = (o: number, x: number): void => { buf[at(o)] = x < -1 ? -1 : x > 0.99997 ? 0.99997 : x; };
    for (let t = 0; t < ticks; t++) {
      const Lin = t === 0 ? vLIN * inL * 0.5 : 0, Rin = t === 0 ? vRIN * inR * 0.5 : 0;
      wr(mLSAME, (Lin + rd(dLSAME) * vWALL - rd(mLSAME - 1)) * vIIR + rd(mLSAME - 1));
      wr(mRSAME, (Rin + rd(dRSAME) * vWALL - rd(mRSAME - 1)) * vIIR + rd(mRSAME - 1));
      wr(mLDIFF, (Lin + rd(dRDIFF) * vWALL - rd(mLDIFF - 1)) * vIIR + rd(mLDIFF - 1));
      wr(mRDIFF, (Rin + rd(dLDIFF) * vWALL - rd(mRDIFF - 1)) * vIIR + rd(mRDIFF - 1));
      let Lout = vCOMB1 * rd(mLCOMB1) + vCOMB2 * rd(mLCOMB2) + vCOMB3 * rd(mLCOMB3) + vCOMB4 * rd(mLCOMB4);
      let Rout = vCOMB1 * rd(mRCOMB1) + vCOMB2 * rd(mRCOMB2) + vCOMB3 * rd(mRCOMB3) + vCOMB4 * rd(mRCOMB4);
      Lout -= vAPF1 * rd(mLAPF1 - dAPF1); wr(mLAPF1, Lout); Lout = Lout * vAPF1 + rd(mLAPF1 - dAPF1);
      Rout -= vAPF1 * rd(mRAPF1 - dAPF1); wr(mRAPF1, Rout); Rout = Rout * vAPF1 + rd(mRAPF1 - dAPF1);
      Lout -= vAPF2 * rd(mLAPF2 - dAPF2); wr(mLAPF2, Lout); Lout = Lout * vAPF2 + rd(mLAPF2 - dAPF2);
      Rout -= vAPF2 * rd(mRAPF2 - dAPF2); wr(mRAPF2, Rout); Rout = Rout * vAPF2 + rd(mRAPF2 - dAPF2);
      outL[t] = Lout; outR[t] = Rout;
      const m = Math.max(Math.abs(Lout), Math.abs(Rout));
      if (m > peak) peak = m;
      if (m > peak * 1e-4) last = t;
      base = (base + 1) % size;
      if (peak > 0 && t - last > sampleRate / 2) break;     // half a second under -80 dB: the tail is over
    }
    const n = Math.min(ticks, last + 1);
    const hold = (x: Float32Array): Float32Array => {
      const y = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) { y[2 * i] = x[i]!; y[2 * i + 1] = x[i]!; }
      return y;
    };
    return [hold(outL), hold(outR)];
  };
  const [ll, lr] = run(1, 0);
  const [rl, rr] = run(0, 1);
  const len = Math.max(ll.length, rl.length);
  const pad = (x: Float32Array): Float32Array => { if (x.length === len) return x; const y = new Float32Array(len); y.set(x); return y; };
  return { ll: pad(ll), lr: pad(lr), rl: pad(rl), rr: pad(rr), sampleRate };
}
