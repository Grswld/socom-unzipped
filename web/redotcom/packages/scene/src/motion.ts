import { Reader, type Zar } from '@s2u/archive';

/**
 * The skeletal motion format: one clip per key of a `MOTION_*.ZAR`. `MOTION_S.ZAR` in every map archive carries
 * seven (`victory_backflip` ... `victory_rodeo`); `RUN/MOTION_P.ZAR`, the player's pack, carries 334 in the same
 * format -- `seal_stand`, `seal_walk`, `seal_run`, `seal_jump` ... -- and research 25's in-memory reads of it are
 * this layout (77 §12). Every field read here is laid out in web/docs/research/77 and checked there on all 341
 * clips; the reader consumes a clip to its last byte and throws where a count, an offset, a flag or the length
 * disagrees.
 *
 * The clip is keyed, not reduced: every channel stores a key per frame plus a closing one, as int16 fixed point,
 * and a channel the writer found constant is stored once (77 §5). What the clip does not say -- whether it loops,
 * how long it plays in game, and how the engine blends between keys -- is the caller's: the first two are
 * `motion.rdr`'s (`looped`, `playback`, in `RUN/READERC.ZAR`, 77 §7), the third is named where it is chosen.
 */

/** 77 §2: the head's first word, 5 on all 341 clips. */
export const MOTION_VERSION = 5;
/**
 * 77 §6: a translation key is three int16 in 1/256 unit steps -- the decomp's root-key scale `0x3b800000`
 * (docs/research/25 §8.2), and seal_A_scuba's bind translations within one step of every constant key.
 */
export const MOTION_TRANSLATION_SCALE = 1 / 256;
/** 77 §6: a rotation key is x, y, z, w as int16 over 32767 -- the writer's Q15 (norms 32764.8-32767.8). */
export const MOTION_ROTATION_SCALE = 1 / 32767;
/**
 * 77 §5: the track flag word. 0x0c is set on every track read; 0x10 and 0x20 mark a channel stored once -- the
 * loader's `m_constRot` and `m_constPos`, which research 25 §8.2 read as "bit 1: no root motion" (77 §3).
 */
export const MOTION_TRACK_BASE = 0x0c, MOTION_CONST_ROTATION = 0x10, MOTION_CONST_TRANSLATION = 0x20;
/**
 * PLACEHOLDER (W2.R2), the blend between two keys: translations lerp, rotations slerp on the shorter arc. The
 * engine carries `CQuat_Slerp` 0x306ae0 and `CQuat_SlerpFaster` 0x306890 (recomp/socom2_names.csv), and its time
 * function keeps the fractional frame (`node+0x1c = t*n`, docs/research/25 §2), but the pose sampler that would
 * say which blend, if any, is not in the tree: `CZSealBody_Tick_0` calls it through `FUN_0028c4f0`, `FUN_0028c380`
 * and `FUN_0028c250`, whose bodies are not on hand, and `zAnimObjectMotionBegin` is zAnim's object-motion command,
 * not this sampler (77 §7, §11). The shorter arc is not optional for any blend: 4,632 of the pack's 156,771 adjacent
 * key pairs are stored in opposite hemispheres (77 §6).
 */
export const MOTION_BLEND = 'slerp' as const;

const HEAD = 0x20, RECORD = 16, PAD = 0x2d;   // 77 §2-§4: the head, a CZSIObject record, the names' '-' fill

/** One part's channels. A constant channel holds one key; an animated one `frameCount + 1` (77 §5). */
export interface MotionPart {
  /** Its position in the clip: the track order, which is not the skeleton's node order (77 §4). */
  index: number;
  /**
   * The part's name as the clip spells it -- `skel_root`, `hips` ... `ltoe`, and the props `weapon`, `rifle`,
   * `pistol`, `launcher`, `back`, `rifle_out`, `do_not_use` -- the key to match on. A clip may carry any subset:
   * the pack's upper-body layers carry 14-16 parts and no root (77 §4, §12).
   */
  name: string;
  /** The track's flag word: `MOTION_TRACK_BASE`, plus `MOTION_CONST_ROTATION` / `MOTION_CONST_TRANSLATION`. */
  flags: number;
  /** x y z per key, in world units, local to the part's parent. */
  translations: Float32Array;
  /** x y z w per key, a unit quaternion, local to the part's parent; three.js's order (77 §6). */
  rotations: Float32Array;
}

/** One clip (77 §2). */
export interface MotionClip {
  /** The ZAR key's name; the clip itself carries none (`''` when parsed bare). */
  name: string;
  version: number;
  /** Seconds, the f32 at +0x04: `frameCount / 30` on all 341 clips. `motion.rdr`'s `playback` can set another. */
  duration: number;
  /** Frames: key `i` sits at `i * duration / frameCount` seconds, key `frameCount` at the end (77 §7). */
  frameCount: number;
  /** Keys a second, `frameCount / duration`: the clip's own rate, 30 on all 341. */
  rate: number;
  /** The f32s at +0x10 and +0x14: -1 and 1 on every clip; not decoded (77 §2). */
  unknown10: number;
  unknown14: number;
  parts: MotionPart[];
}

/** One part at one time: plain data, for the skeleton to put on its node of the same name. */
export interface PartPose {
  index: number;
  name: string;
  /** x y z w, unit. */
  rotation: [number, number, number, number];
  translation: [number, number, number];
}

/** Every part of a clip at one time. */
export interface Pose {
  /** Seconds into the clip, as asked. */
  time: number;
  /** The fractional frame sampled: in `[0, frameCount)` when looping, `[0, frameCount]` when not. */
  frame: number;
  parts: PartPose[];
}

/** How `sampleClip` reads time. */
export interface SampleOptions {
  /**
   * Wrap time into the clip (the default) or clamp it at the last key. The loop bit is the loaded clip's `+0x49`
   * bit 6 (docs/research/25 §2), from `motion.rdr`'s `looped`, not the clip: `seal_run` 1, `seal_jump` 0, the victory
   * clips 0 (77 §7). Every channel closes on its first key, so a wrap is seamless (77 §5).
   */
  loop?: boolean;
  /** Hold the key at or before the time instead of blending (the other reading of 77 §7). */
  hold?: boolean;
}

/** Reads one clip -- a key's bytes -- to its last byte (77 §2-§5). */
export function parseMotionClip(bytes: Uint8Array, name = ''): MotionClip {
  const r = new Reader(bytes);
  const where = name ? `motion clip ${name}` : 'motion clip';
  const version = r.u32(0);
  if (version !== MOTION_VERSION) throw new Error(`${where}: version ${version}, expected ${MOTION_VERSION}`);
  const duration = r.f32(4), frameCount = r.u32(8), count = r.u32(12);
  const namesAt = r.u32(0x18), dataAt = r.u32(0x1c);
  if (frameCount < 1) throw new Error(`${where}: frame count ${frameCount}`);
  if (!(duration > 0) || !Number.isFinite(duration)) throw new Error(`${where}: duration ${duration}`);
  // 77 §3: `count` 16-byte CZSIObject records follow the head, then the name table. The records hold the writer's
  // heap pointers and uninitialised words; the loader rebuilds them (CZSIObject_Read 0x289380), so they are skipped.
  if (namesAt !== HEAD + RECORD * count) throw new Error(`${where}: name table at 0x${namesAt.toString(16)}, expected 0x${(HEAD + RECORD * count).toString(16)} after ${count} records`);
  if (dataAt < namesAt || dataAt > bytes.length) throw new Error(`${where}: name table ends at 0x${dataAt.toString(16)}, outside the clip`);

  // 77 §4: one NUL-terminated name per track, each padded with '-' to four bytes, filling [namesAt, dataAt).
  const names: string[] = [];
  let o = namesAt;
  for (let i = 0; i < count; i++) {
    if (o >= dataAt) throw new Error(`${where}: the name table ends before part ${i}`);
    const s = r.cstr(o, dataAt - o);
    o += s.length + 1;
    if (o > dataAt) throw new Error(`${where}: name ${i} runs past the name table`);
    while (o % 4) {
      if (r.u8(o) !== PAD) throw new Error(`${where}: name ${i} padded with 0x${r.u8(o).toString(16)}, expected '-'`);
      o++;
    }
    names.push(s);
  }
  if (o !== dataAt) throw new Error(`${where}: the name table holds ${count} names in ${o - namesAt} bytes, the head gives ${dataAt - namesAt}`);

  // 77 §5: per track a flag word, then the translation channel, then the rotation channel.
  const keys = frameCount + 1;
  const parts: MotionPart[] = names.map((partName, index) => {
    const flags = r.u32(o);
    if ((flags & ~(MOTION_CONST_ROTATION | MOTION_CONST_TRANSLATION)) !== MOTION_TRACK_BASE) {
      throw new Error(`${where}: part ${index} (${partName}) has flags 0x${flags.toString(16)}; only 0x0c, 0x1c, 0x2c, 0x3c are known`);
    }
    o += 4;
    let translations: Float32Array;
    if (flags & MOTION_CONST_TRANSLATION) {
      // Four int16: x y z and a fourth the writer left from its own vector, not read (77 §5).
      translations = Float32Array.of(r.i16(o) * MOTION_TRANSLATION_SCALE, r.i16(o + 2) * MOTION_TRANSLATION_SCALE, r.i16(o + 4) * MOTION_TRANSLATION_SCALE);
      o += 8;
    } else {
      translations = new Float32Array(3 * keys);
      for (let i = 0; i < 3 * keys; i++) translations[i] = r.i16(o + 2 * i) * MOTION_TRANSLATION_SCALE;
      o += 6 * keys;
      o = (o + 3) & ~3;                          // 77 §5: an odd key count leaves the stream two bytes short of 4
    }
    const rotationKeys = flags & MOTION_CONST_ROTATION ? 1 : keys;
    const rotations = new Float32Array(4 * rotationKeys);
    for (let i = 0; i < 4 * rotationKeys; i++) rotations[i] = r.i16(o + 2 * i) * MOTION_ROTATION_SCALE;
    o += 8 * rotationKeys;
    return { index, name: partName, flags, translations, rotations };
  });
  if (o !== bytes.length) throw new Error(`${where}: ${bytes.length - o} bytes after the last track`);
  return { name, version, duration, frameCount, rate: frameCount / duration, unknown10: r.f32(0x10), unknown14: r.f32(0x14), parts };
}

/** Every clip of a `MOTION_*.ZAR`, named by its key (77 §2: one flat key per clip, no children). */
export function parseMotionZar(zar: Zar): MotionClip[] {
  return zar.root.children.map((key) => parseMotionClip(zar.data(key), key.name));
}

/** Spherical interpolation on the shorter arc, normalised (the named placeholder `MOTION_BLEND`). */
function slerp(a: Float32Array, ia: number, b: Float32Array, ib: number, t: number): [number, number, number, number] {
  let bx = b[ib]!, by = b[ib + 1]!, bz = b[ib + 2]!, bw = b[ib + 3]!;
  const ax = a[ia]!, ay = a[ia + 1]!, az = a[ia + 2]!, aw = a[ia + 3]!;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  let wa = 1 - t, wb = t;
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot)), s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = wa * ax + wb * bx, y = wa * ay + wb * by, z = wa * az + wb * bz, w = wa * aw + wb * bw;
  const len = Math.hypot(x, y, z, w) || 1;
  return [x / len, y / len, z / len, w / len];
}

/**
 * The clip's pose at `time` seconds (77 §7): key `i` at `i * duration / frameCount`, the time wrapped into the clip
 * (or clamped at its last key), and each animated channel blended between the keys either side by
 * `MOTION_BLEND` -- or held at the earlier one. A constant channel is its one key at every time.
 */
export function sampleClip(clip: MotionClip, time: number, options: SampleOptions = {}): Pose {
  const n = clip.frameCount;
  let frame = (time * n) / clip.duration;
  if (options.loop ?? true) frame = ((frame % n) + n) % n;
  else frame = Math.min(Math.max(frame, 0), n);
  let i = Math.floor(frame), t = frame - i;
  if (i >= n) { i = n - 1; t = 1; }            // exactly at the end of a one-shot clip: the closing key
  if (options.hold) t = t >= 1 ? 1 : 0;
  const parts = clip.parts.map((p): PartPose => {
    let translation: [number, number, number];
    if (p.translations.length === 3) translation = [p.translations[0]!, p.translations[1]!, p.translations[2]!];
    else {
      const a = 3 * i, b = a + 3, T = p.translations;
      translation = [T[a]! + (T[b]! - T[a]!) * t, T[a + 1]! + (T[b + 1]! - T[a + 1]!) * t, T[a + 2]! + (T[b + 2]! - T[a + 2]!) * t];
    }
    let rotation: [number, number, number, number];
    if (p.rotations.length === 4) rotation = [p.rotations[0]!, p.rotations[1]!, p.rotations[2]!, p.rotations[3]!];
    else if (t === 0) rotation = [p.rotations[4 * i]!, p.rotations[4 * i + 1]!, p.rotations[4 * i + 2]!, p.rotations[4 * i + 3]!];
    else rotation = slerp(p.rotations, 4 * i, p.rotations, 4 * i + 4, t);
    return { index: p.index, name: p.name, rotation, translation };
  });
  return { time, frame, parts };
}

/**
 * A part's local matrix in the engine's convention -- 16 floats, row-major, row vectors, translation in the fourth
 * row -- the layout `SceneNode.matrix` holds and three.js's `Matrix4.elements` already is (sceneGraph.ts,
 * `toColumnMajor`). 77 §6 shows the quaternion needs no conjugation: rtoe's and ltoe's constant keys give
 * seal_A_scuba's bind rows through exactly this.
 */
export function partMatrix(rotation: readonly [number, number, number, number], translation: readonly [number, number, number]): Float32Array {
  const [x, y, z, w] = rotation;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  // Row r is the image of basis vector r: column r of the column-vector rotation matrix.
  return Float32Array.of(
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    translation[0], translation[1], translation[2], 1,
  );
}
