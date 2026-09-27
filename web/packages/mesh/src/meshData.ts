/**
 * The triangles one drawn VU1 packet becomes, in the layout a browser renderer wants: parallel per-vertex
 * arrays plus an index list. `SEMANTICS.md` is the authority for what every lane means; this file only says
 * how the decoded values are laid out and combined.
 *
 * Positions are **model space** — `int16/16 + header[3].xyz`, SEMANTICS §4 — not world space. The object's
 * placement lives in `MP*_GEO.ZED`'s `nparams` (SEMANTICS §8), which this package deliberately does not read.
 */
export interface MeshData {
  /** xyz per vertex, model space. */
  positions: Float32Array;
  /** uv per vertex, normalised (SEMANTICS §7), unflipped. */
  uvs: Float32Array;
  /**
   * rgba per vertex as floats, **1.0 being the PS2's unity on every lane** — the stored byte over 128.
   * Every texture binds `TEX0.TFX = MODULATE` (241 of 241 TEX0 register writes over the three extracted
   * maps), which is `C = (Ct * Cf) >> 7`, so 128 leaves the texel
   * alone (SEMANTICS §4). RGB is not clamped, because the GS clamps the *product* rather than the
   * vertex; alpha is, because nothing is more opaque than opaque.
   *
   * **This is a material colour, not a lit one.** The draw path multiplies it by a computed light colour
   * on the VU before the GS sees it (`staging+1 = record2 * lit`, NAT:1615). Measured across Frostfire,
   * Desert Glory and Crossroads the stored byte averages 37 of 128 (0.29 of unity) and never exceeds
   * 128, so a consumer that renders it as if it were the final light draws a world roughly a third as
   * bright as it should be. Emulating `lit` is the fix; the viewer does, in `viewer/src/lighting.ts`.
   */
  colors: Float32Array;
  /** xyz per vertex, unit length or exactly zero (§4); null when a merge lost them. */
  normals: Float32Array | null;
  /** xyz per triangle, the stored face normal (§5 entry [1]); null when a merge lost them. */
  faceNormals: Float32Array | null;
  /** Three vertex indices per triangle, in the order SEMANTICS §6 calls front-facing: CCW, right-handed. */
  indices: Uint32Array;
  /** The texture in force for the packet, as the chain's reloc-6 citation named it. */
  textureName: string | null;
  /**
   * Whether the GS fogs this packet: the `FGE` bit of the `TOP+0` GIFtag template's `PRIM` (SEMANTICS §3).
   * It is clear on the skies, the moons and stars, the water, and every self-lit surface -- lamp glows,
   * light bulbs, monitors -- on every map (`tools/dump-fge.ts`), which is what makes a horizon show
   * through the fog. `TOP+1` keeps it set on every packet of every map; `TOP+0` is the template the
   * partially-visible path fills, and a dome or a water plane is always partially visible.
   */
  fog: boolean;
}

/** The axis-aligned extent of a mesh's positions. An empty mesh has the empty extent, min > max. */
export function bounds(m: MeshData): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = m.positions[i + axis]!;
      if (v < min[axis]!) min[axis] = v;
      if (v > max[axis]!) max[axis] = v;
    }
  }
  return { min, max };
}

/**
 * Concatenates meshes into one, re-basing each part's indices onto the vertices it contributed. An optional
 * array survives only when every part has it, and the texture name only when every part names the same one —
 * a merged mesh that spans two textures can no longer say which is its.
 */
export function mergeMeshes(parts: MeshData[]): MeshData {
  const vertexCount = parts.reduce((n, p) => n + p.positions.length / 3, 0);
  const triangleCount = parts.reduce((n, p) => n + p.indices.length / 3, 0);
  const keepNormals = parts.every((p) => p.normals !== null);
  const keepFaceNormals = parts.every((p) => p.faceNormals !== null);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const normals = keepNormals ? new Float32Array(vertexCount * 3) : null;
  const faceNormals = keepFaceNormals ? new Float32Array(triangleCount * 3) : null;
  const indices = new Uint32Array(triangleCount * 3);

  let vertex = 0, triangle = 0;
  for (const p of parts) {
    positions.set(p.positions, vertex * 3);
    uvs.set(p.uvs, vertex * 2);
    colors.set(p.colors, vertex * 4);
    normals?.set(p.normals!, vertex * 3);
    faceNormals?.set(p.faceNormals!, triangle * 3);
    for (let i = 0; i < p.indices.length; i++) indices[triangle * 3 + i] = p.indices[i]! + vertex;
    vertex += p.positions.length / 3;
    triangle += p.indices.length / 3;
  }

  const first = parts[0]?.textureName ?? null;
  const textureName = parts.length > 0 && parts.every((p) => p.textureName === first) ? first : null;
  // Off only when every part is off: one fogged part in a merge is a fogged merge, never a hole in the fog.
  const fog = parts.length === 0 || parts.some((p) => p.fog);
  return { positions, uvs, colors, normals, faceNormals, indices, textureName, fog };
}
