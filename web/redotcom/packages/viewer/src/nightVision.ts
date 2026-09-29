import { Vector4 } from 'three';
import type { Node } from 'three/webgpu';
import { float, select, uniform, vec4 } from 'three/tsl';

/**
 * The night vision's colour as the engine applies it (research 84 section 14; web/docs/research/82, round 4).
 *
 * Going into the goggles (`FUN_005c1800`, zoom state 3) the game calls `FUN_003b78d0(0, LensFX_NVG)`: four rows at
 * `0x4b4c70`, each `(0.33 r, 0.33 g, 0.33 b, 3.0303 a)` of the map's lens -- `(0.2, 0.898, 0.2, 0.24)` on every map --
 * and the flag `0x4b4a68`. While the flag is up every world and character packet (`FUN_003b41d0`, `FUN_003b5f20`) puts
 * VU1 command `0x5c` (`0x5e`/`0x60` for the other colour buffers) after the lighting (`0x18`, or the flat `0x54`) and
 * before the output (`0x28`), with the draw's row in its header (qword 13, `FUN_003b6870`, stored to VU `328`). The
 * command (`0x4d8`) rewrites each lit vertex colour in place:
 *
 *   `ACC = row * c.x; ACC += row * c.y; ACC += row * c.z; c.xyz = ACC + row * row.w`
 *
 * i.e. `c' = row.rgb * (R + G + B + row.a)`, alpha kept, in the lane's 0..255 units (128 the GS's unity) -- a lens-green
 * monochrome of the lit colour at about its brightness, which the textures then modulate. The fog's colour becomes the
 * lens's times its own (`cam+0xd0`). Leaving, `FUN_003b78d0(0.25, (1, 1, 1, 0))` sets the neutral rows, which drop the
 * flag (`FUN_003b7170`, once a frame: every row `(0.33, 0.33, 0.33, 0)`).
 *
 * The viewer's lit colours are in units of the GS's unity (1 = 128), so the row's `a` term is divided by 128.
 */

/** `FUN_003b78d0`'s scale of the lens into a row. */
export const ROW_RGB = 0.33;
export const ROW_A = 3.030303;
/** The lane's unity: the row's constant term is in 0..255 units, the viewer's colours in units of 128. */
const UNITY = 128;

/** 1 while the goggles are on. */
const on = uniform(0);
/** The row: `0.33 x lens.rgb`, and the constant `3.03 x lens.a` in the viewer's units. */
const row = uniform(new Vector4(ROW_RGB, ROW_RGB, ROW_RGB, 0));

/** The row `FUN_003b78d0` builds from a lens (the constant still in the lane's 0..255 units). */
export function nightRow(lens: readonly [number, number, number, number]): [number, number, number, number] {
  return [lens[0] * ROW_RGB, lens[1] * ROW_RGB, lens[2] * ROW_RGB, lens[3] * ROW_A];
}

/** Command `0x5c` on one lit colour (RGBA, 1 = the GS's unity), for tests and the CPU side. */
export function nightColour(c: readonly [number, number, number, number], lens: readonly [number, number, number, number]): [number, number, number, number] {
  const r = nightRow(lens);
  const sum = c[0] + c[1] + c[2] + r[3] / UNITY;
  return [r[0] * sum, r[1] * sum, r[2] * sum, c[3]];
}

/** The goggles on (`lens`, the map's `LensFX_NVG`) or off (null). */
export function setNightVision(lens: readonly [number, number, number, number] | null): void {
  on.value = lens ? 1 : 0;
  if (lens) {
    const r = nightRow(lens);
    row.value.set(r[0], r[1], r[2], r[3] / UNITY);
  }
}

/** The row in use, or null with the goggles off (the page's stats). */
export function nightVisionRow(): [number, number, number, number] | null {
  if (on.value === 0) return null;
  const v = row.value;
  return [v.x, v.y, v.z, v.w * UNITY];
}

/** A lit colour through command `0x5c` while the goggles are on, unchanged otherwise: the world's and the SEAL's graphs. */
export function nightLit(lit: Node<'vec4'>): Node<'vec4'> {
  const sum = lit.r.add(lit.g).add(lit.b).add(row.w);
  const green = vec4(row.xyz.mul(sum), lit.a);
  return select(on.greaterThan(float(0.5)), green, lit) as unknown as Node<'vec4'>;
}
