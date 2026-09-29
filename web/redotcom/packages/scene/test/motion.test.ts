import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  MOTION_BLEND, MOTION_ROTATION_SCALE, MOTION_TRANSLATION_SCALE, parseMotionClip, parseMotionZar, parseSceneGraph,
  partMatrix, sampleClip, type MotionClip, type SceneNode,
} from '../src/index';
import { buildZar, cat, f32, i16, u32 } from './syntheticZar';

/**
 * The skeletal motion format of `MOTION_S.ZAR` (web/docs/research/77): a hand-built clip first, which is what CI
 * runs, then Frostfire's seven victory clips, then every map's.
 */

/** One track of a hand-built clip: int16 keys exactly as the file stores them (77 §5). */
interface TrackSpec { name: string; flags: number; t: number[][]; r: number[][]; pad?: number }

/** A clip as 77 §2-§5 lay it out: head, 16-byte object records (writer residue), '-'-padded names, tracks. */
function buildClip(frameCount: number, duration: number, tracks: TrackSpec[], version = 5): Uint8Array {
  const names: number[] = [];
  for (const t of tracks) {
    for (const ch of t.name) names.push(ch.charCodeAt(0));
    names.push(0);
    while (names.length % 4) names.push(0x2d);
  }
  const namesAt = 0x20 + 16 * tracks.length, dataAt = namesAt + names.length;
  const head = cat(u32(version), f32(duration), u32(frameCount, tracks.length), f32(-1, 1), u32(namesAt, dataAt));
  // The writer's heap pointers and an uninitialised word: the reader must not depend on any of it (77 §3).
  const records = cat(...tracks.map((_, i) => u32(0x11cf2010 + 0x9c8 * i, 0x11c68450 + 0x9c8 * i, 0x80100, 0x118fcbe0)));
  const body: Uint8Array[] = [];
  let at = dataAt;
  const push = (b: Uint8Array): void => { body.push(b); at += b.length; };
  for (const t of tracks) {
    push(u32(t.flags));
    if (t.flags & 0x20) push(i16(...t.t[0]!, t.pad ?? 0));
    else { push(i16(...t.t.flat())); if (at % 4) push(new Uint8Array(4 - (at % 4))); }
    push(i16(...(t.flags & 0x10 ? t.r[0]! : t.r.flat())));
  }
  return cat(head, records, Uint8Array.from(names), ...body);
}

const ID = [0, 0, 0, 32767];
const Y90 = [0, 23170, 0, 23170];          // 90 degrees about +y, Q15
const Z90_FLIPPED = [0, 0, -23170, -23170]; // 90 degrees about +z, stored in the far hemisphere

/** n = 2, so three keys a channel: the root moves, the hips turn, the toe is constant, the hand crosses hemispheres. */
const TRACKS: TrackSpec[] = [
  { name: 'skel_root', flags: 0x1c, t: [[0, 2560, 0], [256, 2560, -512], [512, 2560, -1024]], r: [ID] },
  { name: 'hips', flags: 0x0c, t: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r: [ID, Y90, ID] },
  { name: 'ltoe', flags: 0x3c, t: [[168, -416, -11]], r: [[237, 237, -23168, 23169]], pad: 434 },
  { name: 'lhand', flags: 0x2c, t: [[725, 0, 0]], r: [ID, Z90_FLIPPED, ID], pad: 0 },
];
const DURATION = 2 / 30;
const synthetic = (): Uint8Array => buildClip(2, DURATION, TRACKS);

const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number): boolean =>
  a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]!) <= eps);
/** The same rotation: q and -q are one rotation, so compare up to sign. */
const sameRotation = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number): boolean =>
  near(a, b, eps) || near(a, Array.from(b).map((v) => -v), eps);
const part = (pose: ReturnType<typeof sampleClip>, name: string) => pose.parts.find((p) => p.name === name)!;
const norm = (q: ArrayLike<number>): number => Math.hypot(...Array.from(q));

describe('parseMotionClip on a hand-built clip (77 §2-§6)', () => {
  const clip = parseMotionClip(synthetic(), 'victory_test');

  it('reads the head: version 5, the duration, the frame count, the part count; the rate is frames over duration', () => {
    expect(clip.name).toBe('victory_test');
    expect(clip.version).toBe(5);
    expect(clip.frameCount).toBe(2);
    expect(clip.duration).toBeCloseTo(DURATION, 7);
    expect(clip.rate).toBeCloseTo(30, 4);
    expect([clip.unknown10, clip.unknown14]).toEqual([-1, 1]);
    expect(clip.parts.map((p) => [p.index, p.name, p.flags])).toEqual([
      [0, 'skel_root', 0x1c], [1, 'hips', 0x0c], [2, 'ltoe', 0x3c], [3, 'lhand', 0x2c],
    ]);
  });

  it('reads an animated channel as frameCount + 1 keys and a constant one as a single key (77 §5)', () => {
    const [root, hips, toe, hand] = clip.parts;
    expect(root!.translations.length).toBe(3 * 3);
    expect(root!.rotations.length).toBe(4);
    expect(hips!.rotations.length).toBe(3 * 4);
    expect(toe!.translations.length).toBe(3);
    expect(toe!.rotations.length).toBe(4);
    expect(hand!.translations.length).toBe(3);
    expect(hand!.rotations.length).toBe(3 * 4);
  });

  it('scales translations by 1/256 and rotations by 1/32767, x y z w (77 §6)', () => {
    expect(MOTION_TRANSLATION_SCALE).toBe(1 / 256);
    expect(MOTION_ROTATION_SCALE).toBe(1 / 32767);
    expect(Array.from(clip.parts[0]!.translations)).toEqual([0, 10, 0, 1, 10, -2, 2, 10, -4]);
    expect(near(clip.parts[2]!.translations, [168 / 256, -416 / 256, -11 / 256], 1e-7)).toBe(true);
    expect(near(clip.parts[1]!.rotations.subarray(4, 8), [0, 23170 / 32767, 0, 23170 / 32767], 1e-7)).toBe(true);
    expect(Array.from(clip.parts[0]!.rotations)).toEqual([0, 0, 0, 1]);
  });

  it('pads the stream to 4 bytes after an odd-length translation run, and reads past the pad (77 §5)', () => {
    // skel_root's three keys are 18 bytes: two pad bytes follow before its constant rotation.
    // head, four records, the names (12 + 8 + 8 + 8), then the four tracks.
    expect(synthetic().length).toBe(0x20 + 16 * 4 + 36 + (4 + 18 + 2 + 8) + (4 + 18 + 2 + 24) + (4 + 8 + 8) + (4 + 8 + 24));
    expect(Array.from(clip.parts[0]!.rotations)).toEqual([0, 0, 0, 1]);
  });

  it('ignores the 16-byte object records: they are the writer\'s pointers (77 §3)', () => {
    const other = synthetic();
    other.fill(0xee, 0x20, 0x20 + 16 * 4);
    expect(parseMotionClip(other, 'victory_test')).toEqual(clip);
  });

  it('refuses a wrong version, an unknown flag bit, a short or long file and a misplaced name table', () => {
    expect(() => parseMotionClip(buildClip(2, DURATION, TRACKS, 4))).toThrow(/version 4/);
    expect(() => parseMotionClip(buildClip(2, DURATION, [{ ...TRACKS[0]!, flags: 0x5c }]))).toThrow(/flags 0x5c/);
    expect(() => parseMotionClip(buildClip(2, DURATION, [{ ...TRACKS[1]!, flags: 0x08 }]))).toThrow(/flags 0x8/);
    const good = synthetic();
    expect(() => parseMotionClip(good.subarray(0, good.length - 2))).toThrow();
    expect(() => parseMotionClip(cat(good, u32(0)))).toThrow(/4 bytes after the last track/);
    const moved = good.slice();
    new DataView(moved.buffer).setUint32(0x18, 0x24, true);
    expect(() => parseMotionClip(moved)).toThrow(/name table/);
    const short = good.slice();
    new DataView(short.buffer).setUint32(0x1c, 0x20 + 64 + 16, true);  // the data offset inside the name table
    expect(() => parseMotionClip(short)).toThrow(/name table/);
    expect(() => parseMotionClip(buildClip(0, DURATION, TRACKS))).toThrow(/frame count 0/);
    expect(() => parseMotionClip(buildClip(2, 0, TRACKS))).toThrow(/duration 0/);
  });

  it('names each clip of a MOTION_*.ZAR by its key (77 §2)', () => {
    const zar = Zar.parse(buildZar([{ name: 'victory_a', data: synthetic() }, { name: 'victory_b', data: buildClip(1, 1 / 30, [TRACKS[2]!]) }]));
    const clips = parseMotionZar(zar);
    expect(clips.map((c) => [c.name, c.frameCount, c.parts.length])).toEqual([['victory_a', 2, 4], ['victory_b', 1, 1]]);
  });
});

describe('sampleClip: the pose at a time (77 §7)', () => {
  const clip = parseMotionClip(synthetic(), 'victory_test');

  it('lands on the keys at whole frames: key i at i / rate seconds', () => {
    const p0 = sampleClip(clip, 0), p1 = sampleClip(clip, 1 / 30);
    expect(p0.frame).toBe(0);
    expect(p1.frame).toBeCloseTo(1, 5);
    expect(near(part(p0, 'skel_root').translation, [0, 10, 0], 1e-6)).toBe(true);
    expect(near(part(p1, 'skel_root').translation, [1, 10, -2], 1e-4)).toBe(true);
    expect(sameRotation(part(p1, 'hips').rotation, [0, Math.SQRT1_2, 0, Math.SQRT1_2], 1e-4)).toBe(true);
    expect(part(p1, 'ltoe').translation).toEqual(Array.from(clip.parts[2]!.translations));
  });

  it('gives the pose as plain data: name, index, a unit quaternion and a translation per part', () => {
    const pose = sampleClip(clip, 0.01);
    expect(pose.parts.map((p) => [p.index, p.name])).toEqual([[0, 'skel_root'], [1, 'hips'], [2, 'ltoe'], [3, 'lhand']]);
    for (const p of pose.parts) {
      expect(p.rotation).toHaveLength(4);
      expect(p.translation).toHaveLength(3);
      expect(Math.abs(norm(p.rotation) - 1)).toBeLessThan(1e-3);
    }
  });

  it('PLACEHOLDER (W2.R2): between keys, translations lerp and rotations slerp on the shorter arc', () => {
    expect(MOTION_BLEND).toBe('slerp');
    const half = sampleClip(clip, 0.5 / 30);
    expect(half.frame).toBeCloseTo(0.5, 5);
    expect(near(part(half, 'skel_root').translation, [0.5, 10, -1], 1e-4)).toBe(true);
    const s = Math.sin(Math.PI / 8), c = Math.cos(Math.PI / 8);
    expect(sameRotation(part(half, 'hips').rotation, [0, s, 0, c], 1e-4)).toBe(true);
    // lhand's next key is stored as -q: the shorter arc is 45 degrees about +z, not 135 about -z.
    expect(sameRotation(part(half, 'lhand').rotation, [0, 0, s, c], 1e-4)).toBe(true);
  });

  it('wraps a looping clip, clamps a one-shot one at its last key, and holds on request', () => {
    expect(near(part(sampleClip(clip, clip.duration), 'skel_root').translation, [0, 10, 0], 1e-4)).toBe(true);
    expect(near(part(sampleClip(clip, -0.5 / 30), 'skel_root').translation, [1.5, 10, -3], 1e-4)).toBe(true);
    expect(near(part(sampleClip(clip, 5, { loop: false }), 'skel_root').translation, [2, 10, -4], 1e-6)).toBe(true);
    expect(near(part(sampleClip(clip, 0.5 / 30, { hold: true }), 'skel_root').translation, [0, 10, 0], 1e-6)).toBe(true);
  });

  it('builds the part\'s local matrix in the engine\'s row-major, row-vector convention (sceneGraph.ts)', () => {
    const m = partMatrix([0, 0, 0, 1], [1, 2, 3]);
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
    const z = partMatrix([0, 0, Math.SQRT1_2, Math.SQRT1_2], [0, 0, 0]);
    expect(near(z.subarray(0, 3), [0, 1, 0], 1e-6)).toBe(true);    // row 0: the image of x, turned onto +y
    expect(near(z.subarray(4, 7), [-1, 0, 0], 1e-6)).toBe(true);
  });
});

/** Frostfire's seven victory clips (web/test-fixtures/RUN/MP2.ZDB). */
const MP2 = fixture('RUN/MP2.ZDB');
const absent = !MP2;

/** The 26 names every clip carries, in its order (77 §4). */
const PART_NAMES = [
  'skel_root', 'hips', 'aimnodes', 'spinelo', 'spinehi', 'neck', 'head', 'lshoulder_wgt', 'lscap', 'rscap',
  'rshoulder_wgt', 'rbicep', 'rforearm', 'rhand', 'weapon', 'lbicep', 'lforearm', 'lhand', 'rthigh', 'rcalf', 'rfoot',
  'rtoe', 'lthigh', 'lcalf', 'lfoot', 'ltoe',
];
/** `CZSealBody`'s 25 body-part members, `m_root` ... `m_rtoe` (reCOM zSeal/zseal.h:534-558, research 50). */
const SEAL_PARTS = [
  'root', 'lfoot', 'rfoot', 'lhand', 'spinelo', 'rhand', 'hips', 'head', 'neck', 'spinehi', 'lthigh', 'rthigh', 'rcalf',
  'rbicep', 'rforearm', 'lbicep', 'lforearm', 'lscap', 'rscap', 'lshoulder_wgt', 'rshoulder_wgt', 'lcalf', 'aimnodes',
  'ltoe', 'rtoe',
];
/** Two flag patterns: spinehi (index 4) is constant in four clips and animated in three (77 §5). */
const FLAGS = (spinehi: number): number[] => [
  0x1c, 0x0c, 0x2c, 0x2c, spinehi, 0x2c, 0x2c, 0x0c, 0x2c, 0x2c, 0x0c, 0x0c, 0x2c, 0x2c, 0x0c, 0x0c, 0x2c, 0x2c, 0x2c,
  0x2c, 0x2c, 0x3c, 0x2c, 0x2c, 0x2c, 0x3c,
];
const CLIPS: [string, number, number, number][] = [   // name, key size in bytes, frame count, spinehi's flags
  ['victory_backflip', 36224, 155, 0x2c], ['victory_break', 21904, 95, 0x3c], ['victory_chicken', 44148, 190, 0x2c],
  ['victory_face', 33676, 149, 0x3c], ['victory_funky', 19724, 85, 0x3c], ['victory_macarena', 45884, 205, 0x3c],
  ['victory_rodeo', 35772, 153, 0x2c],
];

function openClips(bytes: Uint8Array): { zar: Zar; clips: MotionClip[] } {
  const zar = Zar.parse(zdbMember(bytes, parseZdb(bytes), 'MOTION_S.ZAR'));
  return { zar, clips: parseMotionZar(zar) };
}

describe(`MOTION_S.ZAR on Frostfire${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('holds the seven victory clips, each read to its last byte: frame counts, 30 keys a second, 26 parts', () => {
    const { zar, clips } = openClips(MP2!);
    expect(zar.root.children.map((k) => [k.name, k.size, k.children.length])).toEqual(CLIPS.map(([n, s]) => [n, s, 0]));
    for (const [i, [name, , frames, spinehi]] of CLIPS.entries()) {
      const clip = clips[i]!;
      expect(clip.name).toBe(name);
      expect(clip.version).toBe(5);
      expect(clip.frameCount).toBe(frames);
      expect(clip.duration).toBeCloseTo(frames / 30, 5);
      expect(clip.rate).toBeCloseTo(30, 4);
      expect([clip.unknown10, clip.unknown14]).toEqual([-1, 1]);
      expect(clip.parts.map((p) => p.name)).toEqual(PART_NAMES);
      expect(clip.parts.map((p) => p.flags), name).toEqual(FLAGS(spinehi));
    }
  });

  it.skipIf(absent)('carries CZSealBody\'s 25 parts by name, m_root as skel_root, and the weapon as the 26th', () => {
    const names = new Set(openClips(MP2!).clips[0]!.parts.map((p) => p.name));
    for (const p of SEAL_PARTS) expect(names.has(p === 'root' ? 'skel_root' : p), p).toBe(true);
    expect([...names].filter((n) => n !== 'skel_root' && !SEAL_PARTS.includes(n))).toEqual(['weapon']);
  });

  it.skipIf(absent)('closes every animated channel on its first key: key n is key 0 (77 §5)', () => {
    for (const clip of openClips(MP2!).clips) {
      const n = clip.frameCount;
      for (const p of clip.parts) {
        if (p.translations.length > 3) expect(Array.from(p.translations.subarray(3 * n)), `${clip.name} ${p.name} T`).toEqual(Array.from(p.translations.subarray(0, 3)));
        if (p.rotations.length > 4) expect(Array.from(p.rotations.subarray(4 * n)), `${clip.name} ${p.name} R`).toEqual(Array.from(p.rotations.subarray(0, 4)));
      }
    }
  });

  it.skipIf(absent)('stores unit quaternions: every key within 1e-4 of length 1, no NaN (77 §6)', () => {
    let keys = 0, worst = 0;
    for (const clip of openClips(MP2!).clips) {
      for (const p of clip.parts) {
        expect(p.translations.every(Number.isFinite)).toBe(true);
        for (let k = 0; k < p.rotations.length; k += 4) {
          worst = Math.max(worst, Math.abs(norm(p.rotations.subarray(k, k + 4)) - 1));
          keys++;
        }
      }
    }
    expect(keys).toBe(23384);
    expect(worst).toBeLessThan(1e-4);
  });

  it.skipIf(absent)('plays every clip at the game\'s 60 Hz tick without a NaN, every rotation unit (research 71 §1.5)', () => {
    for (const clip of openClips(MP2!).clips) {
      for (let tick = 0; tick <= Math.ceil(clip.duration * 60); tick++) {
        for (const p of sampleClip(clip, tick / 60).parts) {
          expect([...p.rotation, ...p.translation].every(Number.isFinite), `${clip.name} ${p.name} tick ${tick}`).toBe(true);
          expect(Math.abs(norm(p.rotation) - 1), `${clip.name} ${p.name} tick ${tick}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it.skipIf(absent)('agrees with seal_A_scuba\'s bind skeleton: victory_backflip\'s constant translations and rotations are the nodes\' own (77 §6)', () => {
    const bytes = MP2!;
    const models = parseSceneGraph(Zar.parse(zdbMember(bytes, parseZdb(bytes), 'CLIB_GEO.ZED')));
    const nodes = new Map<string, SceneNode>();
    const walk = (n: SceneNode): void => { nodes.set(n.name, n); n.children.forEach(walk); };
    walk(models.find((m) => m.name === 'seal_A_scuba')!);
    const clip = openClips(bytes).clips[0]!;
    let translations = 0, rotations = 0;
    for (const p of clip.parts) {
      const node = nodes.get(p.name);
      if (!node) { expect(p.name).toBe('weapon'); continue; }
      if (p.translations.length === 3) {
        // The writer truncated toward zero: the file's value is within one step (1/256) of the node's -- on all seven
        // clips (worst 0.94 step); the constant rotations are the bind's on this clip only, the others pose the toes.
        expect(near(p.translations, node.matrix.subarray(12, 15), 1 / 256 + 1e-6), `${p.name} ${Array.from(p.translations)}`).toBe(true);
        translations++;
      }
      if (p.rotations.length === 4) {
        const m = partMatrix(Array.from(p.rotations) as [number, number, number, number], [0, 0, 0]);
        for (const row of [0, 1, 2]) {
          expect(near(m.subarray(4 * row, 4 * row + 3), node.matrix.subarray(4 * row, 4 * row + 3), 2e-3), `${p.name} row ${row}`).toBe(true);
        }
        rotations++;
      }
    }
    expect([translations, rotations]).toEqual([19, 3]);
  });
});

/**
 * All 22 maps, from the served copy `npm run extract-maps` writes to the git-ignored `public/maps` (skipped where it
 * is absent, as on CI): every map's `MOTION_S.ZAR` holds the same seven clips, decoded identically.
 */
const MAPS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN');
const noMaps = !existsSync(MAPS) || absent;

describe.skipIf(noMaps)(`MOTION_S.ZAR on every map${noMaps ? ' (public/maps or the fixtures absent)' : ''}`, () => {
  it.skipIf(noMaps)('decodes the same seven clips on all 22 maps, byte for byte outside the writer\'s records', () => {
    const reference = openClips(MP2!).clips;
    const files = readdirSync(MAPS).filter((f) => /^MP\d+\.ZDB$/i.test(f)).sort((a, b) => Number(a.slice(2, -4)) - Number(b.slice(2, -4)));
    expect(files.length).toBe(22);
    // Compared as bytes: vitest's element-wise equality over 23,384 keys a map is what the time goes on.
    const bytesOf = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const same = (a: MotionClip, b: MotionClip): boolean =>
      a.frameCount === b.frameCount && a.duration === b.duration && a.parts.length === b.parts.length
      && a.parts.every((p, i) => {
        const q = b.parts[i]!;
        return p.name === q.name && p.flags === q.flags && Buffer.compare(bytesOf(p.translations), bytesOf(q.translations)) === 0
          && Buffer.compare(bytesOf(p.rotations), bytesOf(q.rotations)) === 0;
      });
    const rows: string[] = [`map    ${CLIPS.map(([n]) => n.replace('victory_', '').padStart(9)).join(' ')}   (frames/parts)`];
    const differ: string[] = [];
    for (const file of files) {
      const { clips } = openClips(new Uint8Array(readFileSync(resolve(MAPS, file))));
      expect(clips.map((c) => c.name), file).toEqual(CLIPS.map(([n]) => n));
      clips.forEach((c, i) => { if (!same(c, reference[i]!)) differ.push(`${file} ${c.name}`); });
      rows.push(`${file.replace('.ZDB', '').padEnd(6)} ${clips.map((c) => `${c.frameCount}/${c.parts.length}`.padStart(9)).join(' ')}`);
    }
    console.log(`MOTION_S.ZAR, 22 maps:\n${rows.join('\n')}`);
    expect(differ).toEqual([]);
  }, 60_000);
});

/**
 * The player's pack, `RUN/MOTION_P.ZAR`: the owner's file, beside the maps in the git-ignored `public/maps/RUN`
 * (skipped where it is absent, as on CI). The reader was written against the seven victory clips alone; the 334
 * clips here are the test that the format is the pack's too (77 §12).
 */
const PACK = resolve(MAPS, 'MOTION_P.ZAR');
const noPack = !existsSync(PACK);

describe.skipIf(noPack)(`MOTION_P.ZAR, the player's clips${noPack ? ' (public/maps/RUN/MOTION_P.ZAR absent)' : ''}`, () => {
  const pack = (): MotionClip[] => parseMotionZar(Zar.parse(new Uint8Array(readFileSync(PACK))));

  it.skipIf(noPack)('reads all 334 clips to the last byte: 30 keys a second, the four flag words, unit keys, every channel closed', () => {
    const clips = pack();
    expect(clips.length).toBe(334);
    let keys = 0, worst = 0, channels = 0;
    const flags = new Set<number>(), open: string[] = [];
    for (const c of clips) {
      expect(c.version, c.name).toBe(5);
      expect(c.rate, c.name).toBeCloseTo(30, 3);
      expect([c.unknown10, c.unknown14], c.name).toEqual([-1, 1]);
      const n = c.frameCount;
      for (const p of c.parts) {
        flags.add(p.flags);
        for (let k = 0; k < p.rotations.length; k += 4) { keys++; worst = Math.max(worst, Math.abs(norm(p.rotations.subarray(k, k + 4)) - 1)); }
        for (const [a, w] of [[p.translations, 3], [p.rotations, 4]] as const) {
          if (a.length === w) continue;
          channels++;
          if (!a.subarray(w * n).every((v, i) => v === a[i])) open.push(`${c.name} ${p.name}`);
        }
      }
    }
    expect([...flags].sort((a, b) => a - b)).toEqual([0x0c, 0x1c, 0x2c, 0x3c]);
    expect(keys).toBe(165028);
    expect(worst).toBeLessThan(1e-4);
    expect([channels, open]).toEqual([7309, []]);
    const table = clips.map((c) => `${c.name} ${c.frameCount}/${c.parts.length}`);
    console.log(`MOTION_P.ZAR, 334 clips (frames/parts):\n${Array.from({ length: Math.ceil(table.length / 4) }, (_, i) => table.slice(4 * i, 4 * i + 4).map((s) => s.padEnd(40)).join('')).join('\n')}`);
  }, 60_000);

  it.skipIf(noPack)('carries the cycles a walk, a run and a jump need, by name (motion.rdr names the same clips)', () => {
    const byName = new Map(pack().map((c) => [c.name, c] as const));
    const frames = (name: string): number => byName.get(name)?.frameCount ?? -1;
    expect({
      stand: frames('seal_stand'), walk: frames('seal_walk'), jog: frames('seal_jog'), run: frames('seal_run'),
      walkBack: frames('seal_walk_bw'), runBack: frames('seal_run_bw'), strafeL: frames('seal_lstrafe'), strafeR: frames('seal_rstrafe'),
      crouch: frames('seal_crouch'), crouchWalk: frames('seal_crouchwalk'), prone: frames('seal_prone'), crawl: frames('seal_prone_crawl'),
      jump: frames('seal_jump'), launch: frames('seal_runningjump_launch'), inAir: frames('seal_runningjump_in_air'),
      landSoft: frames('seal_land_soft'), landHard: frames('seal_land_hard'), recoil: frames('seal_recoil'), reload: frames('seal_reload'),
      fpStand: frames('seal_fp_stand'), fpWalk: frames('seal_fp_walk'), fpRun: frames('seal_fp_run'),
    }).toEqual({
      stand: 16, walk: 25, jog: 22, run: 19, walkBack: 16, runBack: 18, strafeL: 22, strafeR: 23,
      crouch: 21, crouchWalk: 28, prone: 10, crawl: 26, jump: 20, launch: 25, inAir: 14,
      landSoft: 20, landHard: 20, recoil: 2, reload: 45, fpStand: 8, fpWalk: 25, fpRun: 18,
    });
  });

  it.skipIf(noPack)('names parts beyond the victory clips\' 26 -- the weapon props -- and carries partial bodies', () => {
    const clips = pack();
    const extra = new Set<string>();
    for (const c of clips) for (const p of c.parts) if (!PART_NAMES.includes(p.name)) extra.add(p.name);
    expect([...extra].sort()).toEqual(['back', 'do_not_use', 'launcher', 'pistol', 'rifle', 'rifle_out']);
    const counts = [...new Set(clips.map((c) => c.parts.length))].sort((a, b) => a - b);
    expect(counts).toEqual([4, 7, 11, 14, 15, 16, 25, 26, 27, 28]);
    // An upper-body layer: the pistol walk carries the spine, the arms, the head and the pistol, no root or legs.
    expect(clips.find((c) => c.name === 'seal_p_walk')!.parts.map((p) => p.name)).not.toContain('skel_root');
  });

  it.skipIf(noPack)('is the pack research 25 read in memory: seal_run\'s root keys, seal_crouch_step\'s constant root', () => {
    const byName = new Map(pack().map((c) => [c.name, c] as const));
    // docs/research/25 §7.3: the "walk" clip's keys (41, 2638, 7233 - 492.5 i), n = 19 in 0.633 s -- seal_run's.
    const run = byName.get('seal_run')!;
    expect([run.frameCount, Number(run.duration.toFixed(3))]).toEqual([19, 0.633]);
    expect(Array.from(run.parts[0]!.translations.subarray(0, 9)).map((v) => Math.round(v * 256))).toEqual([41, 2638, 7233, 41, 2638, 6741, 41, 2638, 6248]);
    // docs/research/25 §8.2: seal_crouch_step's descriptor has no root motion -- flags 0x3c, both root channels constant.
    const step = byName.get('seal_crouch_step')!;
    expect([step.parts[0]!.name, step.parts[0]!.flags, step.frameCount]).toEqual(['skel_root', 0x3c, 19]);
  });
});
