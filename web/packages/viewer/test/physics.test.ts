import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetSource, RdrNode } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';
import {
  alongSurfaceVy, contactSpeed, contactTime, dynamicsFromArchive, dynamicsFromDisc, fall, jumpImpulse, jumpSpeed,
  landingKind, readDynamics, sealTuning, slideAcceleration, standable, DYNAMICS_FIELDS, DYNAMICS_PATH,
  JUMP_PLACEHOLDER, MIN_JUMP_HEIGHT_PLACEHOLDER, SEAL_TUNING_DEFAULTS, SEAL_TUNING_OFFSETS, WORLD_SCALE,
  type SealTuning,
} from '../src/physics';

/**
 * The seal tuning table (web sprint 2, W2.3a; W2.R2, W2.R6): research 17 section 8's nine printed values as the
 * defaults, every other field null, and the reader that fills the table from the disc's `dynamics.rdr` by name at
 * run time. No value of the file is written here beyond the nine the note prints (W2.R6): the fixture test holds the
 * nine to the file and asks only that the rest be there.
 */

/** Research 17 section 8's printed values, by name. */
const PRINTED = {
  gravity: 235, DamageToNewtons: 360, jump_factor: 0.85, land_fall_rate: 40, land_hard_fall_rate: 115,
  ground_touch_distance: 8, max_slope: 0.642788, step_height: 6.5, vertical_blast_boost: 3,
};

describe('the seal tuning table (research 17 section 8, W2.R2, W2.R6)', () => {
  it('defaults to the nine values research 17 section 8 prints, at their offsets; every other field is null', () => {
    expect(Object.fromEntries(Object.entries(SEAL_TUNING_DEFAULTS).filter(([, v]) => v !== null))).toEqual(PRINTED);
    expect(Object.entries(SEAL_TUNING_DEFAULTS).filter(([, v]) => v === null).map(([k]) => k)).toEqual([
      'FALLING_DAMAGE_LIGHT', 'FALLING_DAMAGE_HEAVY', 'FALLING_DAMAGE_DEATH', 'stand_turn_factor', 'turn_maxrate',
      'lower_x_accel', 'upper_x_accel', 'lower_z_accel', 'upper_z_accel', 'fb_accel', 'lr_accel', 'throt_exp',
      'low_climb_height', 'med_climb_height', 'high_climb_height', 'min_stand_height', 'min_jump_height',
    ]);
    expect(Object.keys(SEAL_TUNING_OFFSETS)).toEqual(Object.keys(SEAL_TUNING_DEFAULTS));
    expect(Object.values(SEAL_TUNING_OFFSETS)).toEqual([
      0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x2c, 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x50,
      0x110, 0x114, 0x118, 0x178, 0x17c, 0x180, 0x184, 0x188,
    ]);
    expect(Object.isFrozen(SEAL_TUNING_DEFAULTS)).toBe(true);
    // max_slope is the cosine of 50 degrees: the loader keeps the cosine of the file's degrees (reCOM
    // zCharacter/char_dyn.cpp:18-19, whose RAD_TO_DEG is pi / 180, zMath/zmath.h:18).
    expect(Math.cos((50 * Math.PI) / 180)).toBeCloseTo(SEAL_TUNING_DEFAULTS.max_slope, 6);
  });

  it('names every field the reader looks up by the file\'s own name, with its unit rule', () => {
    expect(Object.keys(DYNAMICS_FIELDS)).toEqual(Object.keys(SEAL_TUNING_DEFAULTS));
    expect(Object.entries(DYNAMICS_FIELDS).filter(([, u]) => u !== 'as-is')).toEqual([
      ['max_slope', 'degrees'], ['FALLING_DAMAGE_LIGHT', 'metres'], ['FALLING_DAMAGE_HEAVY', 'metres'],
      ['FALLING_DAMAGE_DEATH', 'metres'], ['low_climb_height', 'metres'], ['med_climb_height', 'metres'],
      ['high_climb_height', 'metres'], ['min_stand_height', 'metres'], ['min_jump_height', 'metres'],
    ]);
    expect(WORLD_SCALE).toBe(10);                                   // 1 / MetersPerUnit 0.1
    expect(DYNAMICS_PATH).toBe('RUN/READERC.ZAR');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A synthetic `dynamics.rdr` and READERC.ZAR, written with made-up numbers (never the file's), through the real
// parsers: the compiled script format of research 36 section 6, the v2 archive of section 1.

const T_FLOAT = 2, T_STRING = 3, T_LIST = 4;

/** A compiled script whose root is one flat record: each key string followed by a one-float value list. */
function rdrBytes(record: [string, number][]): Uint8Array {
  const strings = record.map(([k]) => k);
  const offsets: number[] = [];
  let size = 0;
  for (const s of strings) { offsets.push(size); size += s.length + 1; }
  const table = new Uint8Array(size);
  strings.forEach((s, i) => { for (let c = 0; c < s.length; c++) table[offsets[i]! + c] = s.charCodeAt(c); });
  const nodesAt = Math.ceil((12 + table.length) / 16) * 16;
  // Node 0 the root list, nodes 1..2n its key/value children, then n floats; byte offsets from `nodesAt`.
  const n = record.length, out = new Uint8Array(nodesAt + 8 * (1 + 3 * n));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, true); dv.setUint32(4, table.length, true); dv.setUint32(8, nodesAt, true);
  out.set(table, 12);
  const node = (i: number, type: number, length: number, value: number): void => {
    dv.setUint32(nodesAt + 8 * i, type | (length << 16), true);
    dv.setUint32(nodesAt + 8 * i + 4, value, true);
  };
  node(0, T_LIST, 2 * n, 8);
  record.forEach(([, v], i) => {
    node(1 + 2 * i, T_STRING, 0, offsets[i]!);
    node(2 + 2 * i, T_LIST, 1, 8 * (1 + 2 * n + i));
    node(1 + 2 * n + i, T_FLOAT, 0, 0);
    dv.setFloat32(nodesAt + 8 * (1 + 2 * n + i) + 4, v, true);
  });
  return out;
}

/** A v2 ZAR whose root holds these files (research 36 section 1; as `archive/test/zar.test.ts` builds one). */
function zarBytes(files: [string, Uint8Array][]): Uint8Array {
  const names = files.map(([name]) => name);
  const nameOfs: number[] = [];
  let p = 0;
  for (const s of names) { nameOfs.push(p); p += s.length + 1; }
  const stable = new Uint8Array(p);
  names.forEach((s, i) => { for (let c = 0; c < s.length; c++) stable[nameOfs[i]! + c] = s.charCodeAt(c); });
  const blob: number[] = [];
  const keys: [number, number, number, number][] = [[0, 0, 0, files.length]];
  files.forEach(([, bytes], i) => {
    while (blob.length % 16) blob.push(0);
    keys.push([0x1000 + nameOfs[i]!, blob.length, bytes.length, 0]);
    blob.push(...bytes);
  });
  const keysAt = 100 + stable.length, padding = 16;
  const dataAt = Math.ceil((keysAt + 16 * keys.length) / padding) * padding;
  const out = new Uint8Array(dataAt + blob.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, keys.length, true); dv.setUint32(8, stable.length, true); dv.setUint32(12, 0x1000, true);
  dv.setUint32(16, padding, true); dv.setUint32(84, blob.length, true); dv.setUint32(96, 0x20002, true);
  out.set(stable, 100);
  keys.forEach(([name, ofs, size, children], i) => {
    const o = keysAt + 16 * i;
    dv.setInt32(o, name, true); dv.setUint32(o + 4, ofs, true); dv.setUint32(o + 8, size, true); dv.setInt32(o + 12, children, true);
  });
  out.set(blob, dataAt);
  return out;
}

/** A source holding only these paths; any other read fails as a served tree's 404 does. */
const sourceOf = (files: Record<string, Uint8Array>): AssetSource => ({
  list: async () => Object.keys(files),
  read: async (path) => { const f = files[path]; if (!f) throw new Error(`HTTP 404 ${path}`); return f; },
});

describe('reading dynamics.rdr by name (W2.R6)', () => {
  it('takes each field by the file\'s name, metres times 10, max_slope\'s degrees to their cosine; skips the rest', () => {
    const rdr: RdrNode = [
      'gravity', ['100'], 'max_slope', ['60'], 'min_jump_height', ['1.5'], 'FALLING_DAMAGE_DEATH', ['3'],
      'turn_maxrate', ['4'], 'step_height', ['not a number'], 'no_such_field', ['7'], '//', 'a comment',
    ];
    const read = readDynamics(rdr);
    expect(read).toEqual({ gravity: 100, max_slope: Math.cos(Math.PI / 3), min_jump_height: 15, FALLING_DAMAGE_DEATH: 30, turn_maxrate: 4 });
    expect(readDynamics([])).toEqual({});
  });

  it('lays the disc\'s fields over the defaults; the rest stay research 17\'s or null', () => {
    expect(sealTuning(null)).toEqual(SEAL_TUNING_DEFAULTS);
    const t = sealTuning({ gravity: 100, min_jump_height: 15, turn_maxrate: undefined });
    expect(t).toEqual({ ...SEAL_TUNING_DEFAULTS, gravity: 100, min_jump_height: 15 });
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('reads RUN/READERC.ZAR through the archive and script parsers; a missing file or reader is null, silently', async () => {
    const rdr = rdrBytes([['gravity', 100], ['max_slope', 60], ['min_jump_height', 1.5], ['land_fall_rate', 30]]);
    const zar = zarBytes([['other.rdr', rdrBytes([['gravity', 1]])], ['dynamics.rdr', rdr]]);
    const expected = { gravity: 100, max_slope: Math.cos(Math.PI / 3), min_jump_height: 15, land_fall_rate: 30 };
    const fromArchive = dynamicsFromArchive(zar)!;
    for (const [k, v] of Object.entries(expected)) expect(fromArchive[k as keyof SealTuning], k).toBeCloseTo(v, 6);
    expect(await dynamicsFromDisc(sourceOf({ [DYNAMICS_PATH]: zar }))).toEqual(fromArchive);
    expect(dynamicsFromArchive(zarBytes([['other.rdr', rdr]]))).toBeNull();
    expect(await dynamicsFromDisc(sourceOf({}))).toBeNull();                         // a 404
    expect(await dynamicsFromDisc(sourceOf({ [DYNAMICS_PATH]: new Uint8Array(64) }))).toBeNull();   // not an archive
  });
});

/** The served tree's `RUN/READERC.ZAR` (the owner's handoff; git-ignored, never committed). */
const SERVED = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps');
const noReaderc = !existsSync(resolve(SERVED, 'RUN/READERC.ZAR'));

describe.skipIf(noReaderc)(`dynamics.rdr on the disc${noReaderc ? ' (READERC.ZAR absent from public/maps/RUN)' : ''}`, () => {
  it('holds research 17\'s nine printed values, and every other field of the table but throt_exp, each a number', async () => {
    const disc = (await dynamicsFromDisc(new FsAssetSource(SERVED)))!;
    expect(disc).not.toBeNull();
    for (const [k, v] of Object.entries(PRINTED)) expect(disc[k as keyof SealTuning], k).toBeCloseTo(v, 6);
    const others = (Object.keys(DYNAMICS_FIELDS) as (keyof SealTuning)[]).filter((k) => !(k in PRINTED));
    expect(others.filter((k) => !(k in disc))).toEqual(['throt_exp']);
    for (const k of others) if (k in disc) expect(Number.isFinite(disc[k]), k).toBe(true);
    // The mover's table from it: the nine as research 17 prints them, the rest filled.
    const tuning = sealTuning(disc);
    expect(Object.entries(tuning).filter(([, v]) => v === null).map(([k]) => k)).toEqual(['throt_exp']);
  });
});

describe('gravity and the landing classes (W2.3a)', () => {
  const TICK = 1 / 60;

  it('a fall is the closed form of gravity 235: the same wherever the time is cut, 42 units in 0.598 s at 140.5', () => {
    const whole = fall(42, 0, 0.5);
    let cut = { y: 42, vy: 0 };
    for (let i = 0; i < 30; i++) cut = fall(cut.y, cut.vy, 0.5 / 30);
    expect(cut.y).toBeCloseTo(whole.y, 9);
    expect(cut.vy).toBeCloseTo(whole.vy, 9);
    expect(whole).toEqual({ y: 42 - 0.5 * 235 * 0.25, vy: -235 * 0.5 });
    // Off a 42-unit deck (research 24 section 7.4): t = sqrt(2 * 42 / 235), v = sqrt(2 * 235 * 42).
    expect(contactTime(42, 0, 0)).toBeCloseTo(Math.sqrt((2 * 42) / 235), 12);
    expect(contactTime(42, 0, 0)).toBeCloseTo(0.598, 3);
    expect(contactSpeed(42, 0, 0)).toBeCloseTo(Math.sqrt(2 * 235 * 42), 9);
    expect(contactSpeed(42, 0, 0)).toBeCloseTo(140.5, 1);
    // At 60 Hz steps the contact falls inside the 36th tick: 35 ticks leave it over the floor, 36 put it under.
    let s = { y: 42, vy: 0 }, ticks = 0;
    while (s.y > 0) { s = fall(s.y, s.vy, TICK); ticks++; }
    expect(ticks).toBe(36);
    // Going up first, the contact is on the way down: a body thrown up at 50 from 0 meets 0 again at 2 * 50 / 235.
    expect(contactTime(0, 50, 0)).toBeCloseTo(100 / 235, 12);
    expect(contactSpeed(0, 50, 0)).toBeCloseTo(50, 12);
    expect(contactTime(0, 50, 10)).toBeNull();                        // 5.3 is as high as it gets: 10 is never met
  });

  it('a landing is soft under land_fall_rate 40, hard from it, harder from land_hard_fall_rate 115', () => {
    expect(landingKind(0)).toBe('soft');
    expect(landingKind(39.99)).toBe('soft');
    expect(landingKind(40)).toBe('hard');
    expect(landingKind(114.99)).toBe('hard');
    expect(landingKind(115)).toBe('harder');
    expect(landingKind(contactSpeed(42, 0, 0))).toBe('harder');
  });
});

describe('the slope (W2.3a; max_slope 0.642788, the cosine of 50 degrees)', () => {
  const up = (degrees: number): [number, number, number] => {
    const a = (degrees * Math.PI) / 180;
    return [-Math.sin(a), Math.cos(a), 0];                          // a floor rising along +x, its normal turned up
  };

  it('stands on a floor whose normal\'s y is at or over max_slope: 49 degrees is, 51 is not', () => {
    expect(standable(up(0)[1])).toBe(true);
    expect(standable(up(49)[1])).toBe(true);
    expect(standable(SEAL_TUNING_DEFAULTS.max_slope)).toBe(true);
    expect(standable(up(51)[1])).toBe(false);
    expect(standable(0)).toBe(false);
  });

  it('slides down the tangent under gravity: g sin(a) along the fall line, g sin(a) cos(a) of it across the ground', () => {
    const [ax, az] = slideAcceleration(up(51));
    const a = (51 * Math.PI) / 180;
    expect(ax).toBeCloseTo(-235 * Math.sin(a) * Math.cos(a), 9);   // down the slope: toward -x
    expect(az).toBe(0);
    expect(slideAcceleration([0, 1, 0])).toEqual([0, 0]);
    // Moving along the plane, the height changes by the slope: up it at 10 across the ground is up 10 tan(a).
    expect(alongSurfaceVy(up(51), 10, 0)).toBeCloseTo(10 * Math.tan(a), 9);
    expect(alongSurfaceVy([0, 1, 0], 10, 5)).toBe(0);
  });
});


describe('the jump (W2.3a; W2.3b waits on the impulse)', () => {
  it('pins a placeholder: the impulse that reaches min_jump_height under gravity, v0 = sqrt(2 g h), h 10 with no disc', () => {
    expect(jumpSpeed(10)).toBeCloseTo(Math.sqrt(2 * 235 * 10), 12);
    expect(MIN_JUMP_HEIGHT_PLACEHOLDER).toBe(10);                  // PLACEHOLDER: when the disc's is not read
    expect(JUMP_PLACEHOLDER).toBe(jumpImpulse(SEAL_TUNING_DEFAULTS));
    expect(JUMP_PLACEHOLDER).toBeCloseTo(68.56, 2);                 // PLACEHOLDER: jump_factor 0.85 is not applied
    expect(JUMP_PLACEHOLDER ** 2 / (2 * 235)).toBeCloseTo(MIN_JUMP_HEIGHT_PLACEHOLDER, 9);
    expect(landingKind(JUMP_PLACEHOLDER)).toBe('hard');
    // With a min_jump_height from the disc, the same rule reaches that instead (a made-up 16 here).
    const t = sealTuning({ min_jump_height: 16 });
    expect(jumpImpulse(t) ** 2 / (2 * t.gravity)).toBeCloseTo(16, 9);
  });
});
