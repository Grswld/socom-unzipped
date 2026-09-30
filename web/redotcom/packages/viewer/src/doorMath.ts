/**
 * The engine's quaternion and node-matrix algebra, as the door's zAnim uses it (`web/redotcom/docs/research/92-doors.md` §2).
 * A quaternion is `(x, y, z, w)`, `w` last, as the engine stores one; a node matrix is row-major, row vectors, the
 * translation in floats 12-14 (`@s2u/scene`'s `SceneNode.matrix`).
 *
 * - `quatOfMatrix` is `FUN_00308210` (decomp 206813): the matrix's rotation as a quaternion.
 * - `matrixOfQuat` is `FUN_00307170` (206170): the rotation block written from one, the translation kept.
 * - `quatMul` is `FUN_003070c0` (206148): the Hamilton product `a b`.
 * - `quatSlerp` is `FUN_00306ae0` (205927): `t <= 0` the first, `t >= 1` the second, the shorter way round, a
 *   normalised lerp above a cosine of 0.95.
 */

export type Quat = [number, number, number, number];
/** 16 floats, row-major, row vectors. */
export type RowMajor = Float32Array | number[];

/** `FUN_00308210`: the rotation of a row-major node matrix, as a quaternion. */
export function quatOfMatrix(m: RowMajor): Quat {
  const tr = m[0]! + m[5]! + m[10]!;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1), k = 0.5 / s;
    return [k * (m[6]! - m[9]!), k * (m[8]! - m[2]!), k * (m[1]! - m[4]!), s * 0.5];
  }
  // The largest diagonal, then the next two in turn (`DAT_003f64b0`: 1, 2, 0).
  let i = m[0]! < m[5]! ? 1 : 0;
  if (m[i * 5]! < m[10]!) i = 2;
  const j = (i + 1) % 3, k2 = (j + 1) % 3;
  const s = Math.sqrt(m[i * 5]! + 1 - m[j * 5]! - m[k2 * 5]!), k = 0.5 / s;
  const q: Quat = [0, 0, 0, 0];
  q[i] = s * 0.5;
  q[j] = k * (m[j * 4 + i]! + m[i * 4 + j]!);
  q[k2] = k * (m[k2 * 4 + i]! + m[i * 4 + k2]!);
  q[3] = k * (m[j * 4 + k2]! - m[k2 * 4 + j]!);
  return q;
}

/** `FUN_00307170` (and `FUN_00315790`'s use of it): the rotation block of `m` from `q`, the rest of `m` kept. */
export function matrixOfQuat(q: Quat, m: RowMajor): Float32Array {
  const [x, y, z, w] = q;
  const out = Float32Array.from(m);
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + w * z); out[2] = 2 * (x * z - w * y);
  out[4] = 2 * (x * y - w * z); out[5] = 1 - 2 * (x * x + z * z); out[6] = 2 * (y * z + w * x);
  out[8] = 2 * (x * z + w * y); out[9] = 2 * (y * z - w * x); out[10] = 1 - 2 * (x * x + y * y);
  return out;
}

/** `FUN_003070c0`: `a b`. */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + b[3] * a[0] + (a[1] * b[2] - a[2] * b[1]),
    a[3] * b[1] + b[3] * a[1] + (a[2] * b[0] - a[0] * b[2]),
    a[3] * b[2] + b[3] * a[2] + (a[0] * b[1] - a[1] * b[0]),
    a[3] * b[3] - (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
  ];
}

/** `FUN_00306ae0`. */
export function quatSlerp(a: Quat, b0: Quat, t: number): Quat {
  if (t <= 0) return [...a];
  if (t >= 1) return [...b0];
  let cos = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2] + a[3] * b0[3];
  let b: Quat = [...b0];
  if (cos < 0) { cos = -cos; b = [-b[0], -b[1], -b[2], -b[3]]; }
  if (cos > 0.95) {
    const q: Quat = [0, 1, 2, 3].map((i) => a[i]! * (1 - t) + b[i]! * t) as Quat;
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }
  const angle = Math.acos(cos), inv = 1 / Math.sin(angle);
  const ka = Math.sin((1 - t) * angle) * inv, kb = Math.sin(t * angle) * inv;
  return [0, 1, 2, 3].map((i) => a[i]! * ka + b[i]! * kb) as Quat;
}

/** `a b`, row-major 4x4 (a row vector goes through `a` first). */
export function mul4(a: RowMajor, b: RowMajor): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]! + a[r * 4 + 3]! * b[12 + c]!;
    }
  }
  return out;
}

/** The inverse of an affine row-major 4x4 (a general 3x3 block, the translation row). */
export function invertAffine(m: RowMajor): Float32Array {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const k = det !== 0 ? 1 / det : 0;
  const out = new Float32Array(16);
  out[0] = A * k; out[1] = -(b * i - c * h) * k; out[2] = (b * f - c * e) * k;
  out[4] = B * k; out[5] = (a * i - c * g) * k; out[6] = -(a * f - c * d) * k;
  out[8] = C * k; out[9] = -(a * h - b * g) * k; out[10] = (a * e - b * d) * k;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  out[12] = -(tx * out[0]! + ty * out[4]! + tz * out[8]!);
  out[13] = -(tx * out[1]! + ty * out[5]! + tz * out[9]!);
  out[14] = -(tx * out[2]! + ty * out[6]! + tz * out[10]!);
  out[15] = 1;
  return out;
}

/** A point through a row-major matrix. */
export function apply4(m: RowMajor, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
    x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
    x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
  ];
}
