import type { GlobalLighting } from '@s2u/scene';

/** Everything the lighting needs: the material colours, the normals if they survived, and whether the engine lights it. */
export interface Lightable {
  colors: Float32Array;
  normals: Float32Array | null;
  /** `PlacedModel.lit`: the node asked for the VU1 light command. Most did not. */
  lit: boolean;
}

/**
 * How the PS2 lights a multiplayer map, which is mostly that it does not.
 *
 * **The world is drawn unlit.** The EE builds each object's VU1 command list per frame
 * (`FUN_003b5f20`, decomp 307800-308038) and emits the light command (`0x54`/`0x18`, or `0x56`/`0x1a`)
 * only when the node, or the model node it instances, carries `m_dynamic_motion` or `m_dynamic_light`
 * (`FUN_003b6d10`, decomp 308333-308357; `NODE_FLAGS_LIT` in `@s2u/scene`). Frostfire has no such node
 * among its 448 drawn ones; Desert Glory and Crossroads none; a few maps flag a handful of ferns,
 * palms and flares. For everything else command `0x08` copies the material colour (`record2`) into
 * `RGBAQ` untouched, and what reaches the GS is the vertex colour the exporter baked -- the
 * `prelight` the nodes are flagged with -- times the texel.
 *
 * **Then the frame is brightened.** The game's post-process copies the frame at half size and draws it
 * back with `ALPHA = (Cd - 0) * FIX + Cd`, `out = Cd * (1 + FIX / 128)` on every pixel, the fog colour
 * included. `FIX` comes from the auto-exposure thread's readback of a column of frame pixels
 * (`FUN_003b24c0`); the console dump measured 93, a lift of 1.73x (`docs/research/31` sections 12-13).
 * The defaults cap it at 100.
 *
 * That is the "factor of eight" the earlier spec could not place: the viewer lit every vertex with the
 * rig (about 0.21 at a ground normal on Frostfire, so five times too dark) and then applied no
 * brighten (1.73x more). The rig itself is exact -- it reproduces the captured VU1 quadwords bit for
 * bit -- and is still applied where the engine applies it.
 *
 * For a lit part the VU computes (`socom2_dispatch_0x1b50.cpp` command `0x18` -> `0x1440`):
 *
 * ```
 *   lit = C0*max(dot(D0,N),0) + C1*max(dot(D1,N),0) + C2*max(dot(D2,N),0) + ambient
 *   staging + 1 = record2 * lit
 * ```
 *
 * three directional lights and an ambient out of `MP*.ZED/GlobalLighting`, with the three directions
 * in the *columns* of `vf5`-`vf7`. The `params.y`/`params.z` lanes are a per-node scale
 * (`customGlobalLight / 127`, `vis_main.cpp:389-403`) that is 1.0 on every node of the corpus.
 */
export interface Lighting {
  /** The map's own rig, or null before a map is loaded. */
  rig: GlobalLighting | null;
  /** The auto-exposure `FIX`, 0..255: the frame is multiplied by `1 + FIX / 128`. */
  brighten: number;
  /** Apply the rig to every part, flagged or not: the viewer's earlier reading, kept for comparison. */
  rigEverywhere: boolean;
}

/** The frame multiplier the brighten pass applies: `1 + FIX / 128`. */
export const brightenOf = (light: Lighting): number => 1 + light.brighten / 128;

/** What the viewer opens with: the console-measured `FIX` of 93, and the rig only where the engine puts it. */
export const DEFAULT_LIGHTING: Lighting = { rig: null, brighten: 93, rigEverywhere: false };

/**
 * The rig a lit part falls back to when a map has no `GlobalLighting` key: one white light from above
 * and a little ambient. Nothing on the disc reads this -- all 34 maps carry the key -- it exists so
 * that a broken archive draws something shaded rather than black.
 */
export const FALLBACK_RIG: GlobalLighting = {
  directions: [[0, 1, 0], [0, 0, 0], [0, 0, 0]],
  colours: [[0.7, 0.7, 0.7], [0, 0, 0], [0, 0, 0]],
  ambient: [0.3, 0.3, 0.3],
};

/**
 * The drawn vertex colour for one part, into `out` (rgba, 4 floats a vertex): `record2 * brighten` for
 * a part the engine does not light, `record2 * lit * brighten` for one it does.
 *
 * RGB is left unclamped: the GS clamps the product of texel and vertex, not the vertex, so a lit
 * colour above 1 legitimately overbrightens and the framebuffer is where it stops. Alpha is copied
 * through -- the VU takes the w lane from the staging quad rather than from `lit`, and the brighten
 * pass does not touch it either.
 */
export function applyLighting(part: Lightable, light: Lighting, out: Float32Array): void {
  const material = part.colors;
  const count = material.length / 4;

  if (!part.lit && !light.rigEverywhere) {
    out.set(material);                                   // command 0x08: record2 into RGBAQ, untouched
    return;
  }

  const normals = part.normals;
  const rig = light.rig ?? FALLBACK_RIG;
  // A merge can lose the normals (`mergeMeshes` drops them when a part has none). Without a normal
  // there is no direction to dot against, so the surface takes the ambient plus half of each light --
  // the mean of `max(dot(d, n), 0)` over a sphere is a half -- rather than a black hole.
  const flatR = rig.ambient[0] + rig.colours.reduce((s, c) => s + c[0] / 2, 0);
  const flatG = rig.ambient[1] + rig.colours.reduce((s, c) => s + c[1] / 2, 0);
  const flatB = rig.ambient[2] + rig.colours.reduce((s, c) => s + c[2] / 2, 0);

  for (let i = 0; i < count; i++) {
    let r = flatR, g = flatG, b = flatB;
    if (normals) {
      const nx = normals[i * 3]!, ny = normals[i * 3 + 1]!, nz = normals[i * 3 + 2]!;
      r = rig.ambient[0]; g = rig.ambient[1]; b = rig.ambient[2];
      for (let k = 0; k < 3; k++) {
        const d = rig.directions[k]!;
        // `max(..., 0)`, exactly as the microcode clamps the transformed normal before it is used.
        const t = d[0] * nx + d[1] * ny + d[2] * nz;
        if (t <= 0) continue;
        const c = rig.colours[k]!;
        r += c[0] * t; g += c[1] * t; b += c[2] * t;
      }
    }
    out[i * 4] = material[i * 4]! * r;
    out[i * 4 + 1] = material[i * 4 + 1]! * g;
    out[i * 4 + 2] = material[i * 4 + 2]! * b;
    out[i * 4 + 3] = material[i * 4 + 3]!;            // alpha is not lit
  }
}
