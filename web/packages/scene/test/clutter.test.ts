import { describe, expect, it } from 'vitest';
import { clutterMatrix, isAffineRowVector } from '../src/clutter';

/**
 * The guard that decides whether a clutter record's 96 bytes are the affine matrix the format
 * describes. It exists because Abandoned's records are something else in the same bytes, and composing
 * one as a matrix drew basis rows thousands of units long across the map while reporting nothing.
 *
 * The fixtures are real records, read off the disc with `web/tools/probe-clutter.ts`.
 */

/** Row-major, row-vector: rows 0-2 are basis vectors with a zero fourth lane, row 3 the translation. */
const m = (...v: number[]): Float32Array => Float32Array.from(v);

/** MP6 Desert Glory, `afghan2r_clutter_rocksmall`, instance 0. Places correctly. */
const DESERT_GLORY_ROCK = m(
  1.047, 0, -0.245, 0,
  0, 1.075, 0, 0,
  0.245, 0, 1.047, 0,
  1536.068, 0, 1771.973, 1,
);

/** MP5 Abandoned, `bamboo5`, instance 0: a unit quaternion in row 0 and a position in row 2. */
const ABANDONED_BAMBOO = m(
  0.067, 0.135, 0.051, 0.987,
  0, 0, 0, 1,
  1072, 56.339, 2205.6, 1,
  0.251, 0, 0, 1,
);

const IDENTITY = m(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

describe('isAffineRowVector', () => {
  it('accepts a real record that places correctly', () => {
    expect(isAffineRowVector(DESERT_GLORY_ROCK)).toBe(true);
    expect(isAffineRowVector(IDENTITY)).toBe(true);
  });

  it('rejects the record shape that drew Abandoned\'s streaks', () => {
    expect(isAffineRowVector(ABANDONED_BAMBOO)).toBe(false);
  });

  it('rejects a non-zero last column, which is what gives the quaternion form away', () => {
    for (const lane of [3, 7, 11]) {
      const bad = Float32Array.from(DESERT_GLORY_ROCK);
      bad[lane] = 0.987;
      expect(isAffineRowVector(bad), `lane ${lane}`).toBe(false);
    }
  });

  it('requires the homogeneous one', () => {
    const bad = Float32Array.from(DESERT_GLORY_ROCK);
    bad[15] = 0;
    expect(isAffineRowVector(bad)).toBe(false);
  });

  it('rejects a basis row that is degenerate or enormous', () => {
    const flat = Float32Array.from(DESERT_GLORY_ROCK);
    flat[4] = 0; flat[5] = 0; flat[6] = 0;              // row 1 collapsed
    expect(isAffineRowVector(flat)).toBe(false);

    const huge = Float32Array.from(DESERT_GLORY_ROCK);
    huge[8] = 2452.96;                                  // the scale the composed streaks showed
    expect(isAffineRowVector(huge)).toBe(false);
  });

  it('rejects anything non-finite', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      const bad = Float32Array.from(DESERT_GLORY_ROCK);
      bad[0] = v;
      expect(isAffineRowVector(bad), String(v)).toBe(false);
    }
  });

  it('tolerates the float noise a real record carries', () => {
    // The stored floats are not exact: a zero lane can read 1e-8 and the one can read 0.9999999.
    const noisy = Float32Array.from(DESERT_GLORY_ROCK);
    noisy[3] = 1e-8; noisy[7] = -2e-8; noisy[11] = 5e-9; noisy[15] = 0.99999994;
    expect(isAffineRowVector(noisy)).toBe(true);
  });

  it('accepts the full range of uniform scales the maps actually use', () => {
    // Desert Glory's scale_inverse runs about 0.93..1.08, so the basis rows run about 0.92..1.08.
    for (const s of [0.5, 0.93, 1, 1.075, 4, 49]) {
      const scaled = m(s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 100, 200, 300, 1);
      expect(isAffineRowVector(scaled), `scale ${s}`).toBe(true);
    }
    // ... but not the thousands the malformed records compose into.
    const absurd = m(51, 0, 0, 0, 0, 51, 0, 0, 0, 0, 51, 0, 0, 0, 0, 1);
    expect(isAffineRowVector(absurd)).toBe(false);
  });
});

/**
 * The two record forms, composed. The bytes are built here rather than read off a disc because the two
 * maps that would prove it, Abandoned and Enowapi, are not among the three archives the fixtures carry;
 * the field offsets and the flag bit come from the engine's own selector, `FUN_002d9490`, which reads
 * byte +76, tests bit 1, and returns the position at +48 or at +32 accordingly.
 */
function record(fill: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(96);
  fill(new DataView(bytes.buffer));
  return bytes;
}

describe('clutterMatrix', () => {
  it('takes the matrix form as it stands, all 16 floats, when bit 1 is clear', () => {
    const bytes = record((v) => {
      DESERT_GLORY_ROCK.forEach((f, i) => v.setFloat32(i * 4, f, true));
      v.setUint32(76, 0x8001, true);                          // the real flag word of a matrix record
    });
    expect([...clutterMatrix(bytes)].map((f) => Number(f.toFixed(3))))
      .toEqual([...DESERT_GLORY_ROCK].map((f) => Number(f.toFixed(3))));
  });

  it('composes the decomposed form: a quarter turn about y, scaled, at its own position', () => {
    const h = Math.SQRT1_2;                                   // sin/cos of 45 degrees: a 90 degree yaw
    const bytes = record((v) => {
      v.setFloat32(0, 0, true); v.setFloat32(4, h, true); v.setFloat32(8, 0, true); v.setFloat32(12, h, true);
      v.setFloat32(32, 1072, true); v.setFloat32(36, 56.339, true); v.setFloat32(40, 2205.6, true);
      v.setFloat32(44, 2, true);                              // uniform scale
      v.setUint32(76, 0x8003, true);                          // the real flag word of a dynamic record
    });
    const m = [...clutterMatrix(bytes)].map((f) => Number(f.toFixed(4)));
    // Row-vector convention: the rows are the rotated basis, so x maps to -z and z maps to +x.
    expect(m.slice(0, 4)).toEqual([0, 0, -2, 0]);
    expect(m.slice(4, 8)).toEqual([0, 2, 0, 0]);
    expect(m.slice(8, 12)).toEqual([2, 0, 0, 0]);
    expect(m.slice(12, 16)).toEqual([1072, 56.339, 2205.6001, 1]);   // the f32 round trip of 2205.6
    expect(isAffineRowVector(clutterMatrix(bytes))).toBe(true);
  });

  it('normalises the stored quaternion, which is not a unit one: |q| runs 0.92 to 1.41', () => {
    const bytes = record((v) => {
      v.setFloat32(0, 0, true); v.setFloat32(4, 0, true); v.setFloat32(8, 0, true); v.setFloat32(12, 1.41, true);
      v.setFloat32(44, 1, true);
      v.setUint32(76, 0x2, true);
    });
    const m = clutterMatrix(bytes);
    // Unnormalised, w = 1.41 would scale the basis by about two. Normalised it is the identity.
    for (let r = 0; r < 3; r++) expect(Math.hypot(m[r * 4]!, m[r * 4 + 1]!, m[r * 4 + 2]!)).toBeCloseTo(1, 5);
  });

  it('reads the dynamic position from +32, not from the matrix translation row at +48', () => {
    const bytes = record((v) => {
      v.setFloat32(12, 1, true); v.setFloat32(44, 1, true);
      v.setFloat32(32, 10, true); v.setFloat32(36, 20, true); v.setFloat32(40, 30, true);
      v.setFloat32(48, 0.35, true);                           // the repel angle lives where +48 would
      v.setUint32(76, 0x2, true);
    });
    expect([...clutterMatrix(bytes).slice(12, 15)]).toEqual([10, 20, 30]);
  });
});
