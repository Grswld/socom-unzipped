import type { Chain } from './dma';
import { unpackVif, type VuPacket } from './vif';
import type { MeshData } from './meshData';

/**
 * Turns an unpacked VU1 packet into triangles without running VU1.
 *
 * Every rule and every constant below comes from `SEMANTICS.md` in this package (Task 11's decode of the
 * VU1 microprogram's own translation, cross-checked against Frostfire's 416 drawn packets); the section and
 * table row is cited at each one. The short version, SEMANTICS §1:
 *
 * - position = `int16 xyz / 16 + header[3].xyz`, y up, model space;
 * - the primitive is an **indexed triangle list**, three byte offsets per tail entry, `index = byte / 3`;
 * - UV = `int16 / 4096`, normalised;
 * - the per-vertex normal is `(a.w, b.z, b.w) / 32768`, the per-face normal the tail's `V3-16` quadword.
 *
 * That is the **triangle** packet, the one a relocation-type 2 chain tag carries (36 §3). A chain tag of
 * relocation type **1** carries a second, much smaller packet shape — a GS `LINE_STRIP` — which is not a
 * mesh at all and which `interpretLinePacket` below decodes instead. See `lineStripOf` for the layout and
 * the measurement behind it.
 */

/** VU data memory is 1024 quadwords of four lanes; `VuPacket.mem` is that memory flattened. */
const VU_QUADWORDS = 1024;
const LANES = 4;
const X = 0, Y = 1, Z = 2, W = 3;

/** SEMANTICS §2/§3: `TOP+0 … TOP+3` are two GIFtag templates, the counts and the position bias. */
const HEADER_QUADWORDS = 4;
/** SEMANTICS §3 `TOP+2`: .x the index-list quadword offset, .z the vertex count, .w the triangle count. */
const COUNTS_QW = 2;
/** SEMANTICS §3 `TOP+3`: .xyz the float position bias, added after the `ITOF4`. */
const BIAS_QW = 3;
/** SEMANTICS §2: the vertex block starts at `TOP+4`, three quadwords a vertex. */
const VERTEX_BASE = 4;
const VERTEX_QUADWORDS = 3;
/** SEMANTICS §5: two quadwords a triangle, the index entry then the face normal. */
const TAIL_QUADWORDS = 2;

/** SEMANTICS §4 quadword a x,y,z: `ITOF4`, so the stored int16 is sixteenths of a unit. */
const POSITION_SCALE = 16;
/** Research 15 §0 item 1: command `0x70` converts the position lanes with `ITOF15`, 1.15 fixed point. */
const POSITION_SCALE_ITOF15 = 32768;

/**
 * How a packet's position lanes become model space, which is the one thing the two drawing commands disagree on
 * (research 15 §0 item 1: `0x70` is `0x68` with two instructions changed; SEMANTICS §3 `TOP+3`):
 *
 * - `'bias'`, command `0x68`: `int16 / 16 + TOP+3.xyz` (`ITOF4`, then `ADD.xyz`). The world and the map's props.
 * - `'scale'`, command `0x70`: `int16 / 32768 * TOP+3.w` (`ITOF15`, then `MULw.xyz`). The weapons, the fittings and
 *   the turrets (web/docs/research/79 §2): every visual node of `WEAP_MDL`, `FLIB_MDL` and `TURR_MDL` lands inside
 *   its own `nparams` bbox this way and none the other, and their `TOP+3.xyz` is zero in every packet.
 *
 * The command list that picks one is the EE's (SEMANTICS §9), not the packet's, so the caller says which.
 */
export type PositionForm = 'bias' | 'scale';
/** SEMANTICS §4 quadword b x,y: `ITOF12`, normalised texture coordinates (§7 — TW/TH do not enter). */
const UV_SCALE = 4096;
/** SEMANTICS §4 (a.w, b.z, b.w) and §5 entry [1]: `ITOF15`, 1.15 fixed point. */
const NORMAL_SCALE = 32768;
/** SEMANTICS §5 entry [0]: a vertex is named by its quadword offset from `TOP+4`, stride 3. */
const INDEX_STRIDE = 3;
/**
 * SEMANTICS §4 quadword c: **128 is unity on every lane**, RGB included.
 *
 * Every texture in the three extracted maps binds `TEX0.TFX = MODULATE` (241 of 241 TEX0 register
 * writes, `TEX0_1` and `TEX0_2` both, over the 240 textures research/72 counts; measured with
 * `tools/dump-bindpacket.ts`), and MODULATE is `C = (Ct * Cf) >> 7` — so a vertex lane of 128 leaves the
 * texel unchanged and 255 would double it. Alpha's 128-is-opaque is the same unity point, not a separate
 * convention; what differs is only that the blend equation has nowhere to put a value above opaque.
 *
 * RGB is therefore c/128 and is **not** clamped: the GS clamps the product, so a lane above 128 would
 * legitimately overbrighten. None of the three maps contains one — the measured maximum is exactly 128 —
 * but the decode does not assume it. Alpha is clamped, because there is no more opaque than opaque.
 */
const PS2_UNITY = 128;

/** A packet whose lanes do not hold what SEMANTICS says a map geometry packet holds. */
export class MeshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshError';
  }
}

/**
 * The GS `PRIM` field of a GIFtag template quadword: bits 47-57 of the tag, i.e. bits 15-25 of lane `y`
 * (SEMANTICS §2 `TOP+0`). Its low three bits are the primitive type.
 */
const PRIM_SHIFT = 15, PRIM_MASK = 0x7ff, PRIM_TYPE_MASK = 7;
/** Inside `PRIM`: IIP bit 3, TME bit 4, **FGE bit 5**, ABE bit 6. */
const PRIM_FGE = 1 << 5;
/**
 * The GS primitive types map geometry names: prim type 5 `TRIANGLE_FAN` and 3 `TRIANGLE` in a mesh
 * packet's two templates (SEMANTICS §2), and 2 `LINE_STRIP` in both of a line packet's.
 */
const PRIM_LINE_STRIP = 2;
/** The GIFtag low word: `NLOOP` is bits 0-14 (SEMANTICS §2 `TOP+0.x`). */
const NLOOP_MASK = 0x7fff;

/**
 * A `LINE_STRIP` packet's two header quadwords: the per-primitive template, then the whole-object one
 * whose `NLOOP` states the point count. There is no counts quadword and no position bias.
 */
const LINE_HEADER_QUADWORDS = 2;
/** A `LINE_STRIP` packet's points start at `TOP+2`, three quadwords a point, same stride as a vertex. */
const LINE_VERTEX_BASE = 2;
/** A strip of one point draws nothing; the shortest one on disc is two points, one segment. */
const MIN_STRIP_POINTS = 2;

/**
 * One `LINE_STRIP` a chain draws: a polyline of `positions.length / 3` points, segment `k` running from
 * point `k` to point `k + 1`. This is **not** a `MeshData`: the GS draws it as one-pixel-wide lines, and
 * widening it into geometry is a renderer's choice (a width and a facing), not a decode.
 *
 * Lanes carry exactly what SEMANTICS §4 names for a triangle vertex, only already in floats rather than
 * fixed point, and with no position bias to add — see `lineStripOf`.
 */
export interface LineStrip {
  /** xyz per point, model space, in strip order. */
  positions: Float32Array;
  /** uv per point; unlike a mesh's these run well outside 0..1, so the texture repeats along the strip. */
  uvs: Float32Array;
  /** rgba per point, on the same scale `MeshData.colors` uses: 1.0 is the PS2's unity, the byte over 128. */
  colors: Float32Array;
  /** xyz per point, unit length or exactly zero, as for a mesh vertex. */
  normals: Float32Array;
  /** The texture in force for the packet, as the chain's reloc-6 citation named it. */
  textureName: string | null;
  /** The `TOP+0` template's `FGE`, as for a mesh. */
  fog: boolean;
}

/** Whether the `TOP+0` template asks the GS to fog the packet (`PRIM.FGE`). See `MeshData.fog`. */
export function packetFogged(packet: VuPacket): boolean {
  return (((packet.mem[Y]! >>> PRIM_SHIFT) & PRIM_MASK) & PRIM_FGE) !== 0;
}

/** The primitive type of one of a packet's GIFtag templates, or null when that quadword never unpacked. */
export function packetPrimitive(packet: VuPacket, quadword = 0): number | null {
  if (packet.written[quadword] !== 1) return null;
  return ((packet.mem[quadword * LANES + Y]! >>> PRIM_SHIFT) & PRIM_MASK) & PRIM_TYPE_MASK;
}

/**
 * Whether this packet is a `LINE_STRIP` rather than a mesh. **[data]** over the three shipped maps: every
 * one of the 194 packets a relocation-type-1 tag carries has `PRIM = 122` in *both* templates — prim type
 * 2, `IIP|TME|FGE|ABE`, `NREG = 3`, `REGS = 0x412` — and no other packet in any map has prim type 2. The
 * mesh packets keep the `TRIANGLE_FAN`/`TRIANGLE` pair SEMANTICS §2 records.
 */
export function isLineStripPacket(packet: VuPacket): boolean {
  // Both templates, not just `TOP+0`: a mesh packet carries a TRIANGLE_FAN there and a TRIANGLE at
  // `TOP+1`, so requiring the pair to agree means a single mis-decoded quadword cannot send a mesh
  // down the line path and lose its triangles silently.
  return packetPrimitive(packet, 0) === PRIM_LINE_STRIP
    && packetPrimitive(packet, 1) === PRIM_LINE_STRIP;
}

/**
 * Turns one drawn `LINE_STRIP` packet into its polyline.
 *
 * **The layout**, measured over all 194 of them in Desert Glory and Crossroads (`TOP+n` are quadwords of
 * the packet's VU memory, `k` the point index):
 *
 * | quadword | lanes |
 * |---|---|
 * | `TOP+0` | GIFtag template, `PRIM` prim-type 2, `NLOOP = 0` in all 194 |
 * | `TOP+1` | GIFtag template, same `PRIM`, `NLOOP` = the point count in all 194, `EOP = 1` |
 * | `TOP+2 + 3k` | `V4-32` float `(x, y, z, normal.x)` |
 * | `TOP+3 + 3k` | `V4-32` float `(u, v, normal.y, normal.z)` |
 * | `TOP+4 + 3k` | `V4-8 USN` `(r, g, b, a)` |
 *
 * So it is the triangle vertex of SEMANTICS §4 lane for lane — position, UV, the split `(a.w, b.z, b.w)`
 * normal, RGBA — with three differences: the numbers arrive as 32-bit floats, so none of `ITOF4`,
 * `ITOF12` or `ITOF15` applies and nothing is divided; there is no `TOP+3` position bias to add, the
 * float position being final; and there is no index list, the points being drawn in the order stored.
 * The normal reads unit length or exactly zero over all 1,071 points, the same invariant §4 states.
 */
export function interpretLinePacket(packet: VuPacket): LineStrip {
  const { mem, f32, written } = packet;
  const lanesOf = (qw: number, what: string): number => {
    if (written[qw] !== 1) throw new MeshError(`${what} at TOP+${qw} was never unpacked, so this is not a drawn line packet`);
    return qw * LANES;
  };
  for (let q = 0; q < LINE_HEADER_QUADWORDS; q++) lanesOf(q, 'the GIFtag template');
  // The whole-object template's NLOOP is the point count; there is no counts quadword to read it from.
  const count = mem[1 * LANES + X]! & NLOOP_MASK;
  if (count < MIN_STRIP_POINTS) throw new MeshError(`the GIFtag claims ${count} points, too few to draw a line strip`);
  const last = LINE_VERTEX_BASE + VERTEX_QUADWORDS * count;
  if (last > VU_QUADWORDS) throw new MeshError(`the GIFtag claims ${count} points reaching TOP+${last}, past the ${VU_QUADWORDS} quadwords of VU data memory`);

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 4);
  const normals = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    const base = LINE_VERTEX_BASE + VERTEX_QUADWORDS * k;
    const a = lanesOf(base, `point ${k}'s position quadword`);           // V4-32 float
    const b = lanesOf(base + 1, `point ${k}'s UV quadword`);             // V4-32 float
    const c = lanesOf(base + 2, `point ${k}'s colour quadword`);         // V4-8 USN, unsigned bytes
    positions[k * 3 + X] = f32[a + X]!;
    positions[k * 3 + Y] = f32[a + Y]!;
    positions[k * 3 + Z] = f32[a + Z]!;
    normals[k * 3 + X] = f32[a + W]!;
    normals[k * 3 + Y] = f32[b + Z]!;
    normals[k * 3 + Z] = f32[b + W]!;
    uvs[k * 2 + X] = f32[b + X]!;
    uvs[k * 2 + Y] = f32[b + Y]!;
    colors[k * 4 + X] = mem[c + X]! / PS2_UNITY;
    colors[k * 4 + Y] = mem[c + Y]! / PS2_UNITY;
    colors[k * 4 + Z] = mem[c + Z]! / PS2_UNITY;
    colors[k * 4 + W] = Math.min(mem[c + W]! / PS2_UNITY, 1);
  }
  return { positions, uvs, colors, normals, textureName: packet.textureName, fog: packetFogged(packet) };
}

/**
 * The index a tail lane names. SEMANTICS §5: the byte is a quadword offset from `TOP+4` at a stride of three
 * quadwords, so it is a multiple of 3 — true of every one of Frostfire's 8,765 triples.
 */
function vertexIndex(offset: number, vertexCount: number, lane: string): number {
  if (offset % INDEX_STRIDE !== 0) throw new MeshError(`index byte ${offset} (${lane}) is not a multiple of 3, so it names no vertex triple`);
  const index = offset / INDEX_STRIDE;
  if (index >= vertexCount) throw new MeshError(`index byte ${offset} (${lane}) names vertex ${index} of ${vertexCount}`);
  return index;
}

/**
 * Turns one drawn (`MSCNT`) packet into a mesh. Throws `MeshError` on anything SEMANTICS does not describe. `form`
 * is the position conversion the drawing command applies (`PositionForm`); every other lane is the same in both.
 */
export function interpretPacket(packet: VuPacket, form: PositionForm = 'bias'): MeshData {
  const { mem, f32, written } = packet;
  /** Where a quadword's lanes start in `mem`, once this packet is known to have unpacked it. */
  const lanesOf = (qw: number, what: string): number => {
    if (written[qw] !== 1) throw new MeshError(`${what} at TOP+${qw} was never unpacked, so this is not a drawn geometry packet`);
    return qw * LANES;
  };

  for (let q = 0; q < HEADER_QUADWORDS; q++) lanesOf(q, 'the header quadword');
  const counts = COUNTS_QW * LANES;
  const indexBase = mem[counts + X]! >>> 0;
  const vertexCount = mem[counts + Z]! >>> 0;
  const triangleCount = mem[counts + W]! >>> 0;
  const bias = [f32[BIAS_QW * LANES + X]!, f32[BIAS_QW * LANES + Y]!, f32[BIAS_QW * LANES + Z]!];
  // `PositionForm`: 0x68 divides by 16 and adds TOP+3.xyz; 0x70 divides by 32768 and multiplies by TOP+3.w.
  const scaled = form === 'scale';
  const divisor = scaled ? POSITION_SCALE_ITOF15 : POSITION_SCALE;
  const multiplier = scaled ? f32[BIAS_QW * LANES + W]! : 1;
  const add = scaled ? [0, 0, 0] : bias;
  // A count that cannot fit VU memory is not a count, and must not become an allocation.
  const fits = (last: number, what: string) => {
    if (last > VU_QUADWORDS) throw new MeshError(`the header claims ${what} reaching TOP+${last}, past the ${VU_QUADWORDS} quadwords of VU data memory`);
  };
  fits(VERTEX_BASE + VERTEX_QUADWORDS * vertexCount, `${vertexCount} vertices`);
  fits(indexBase + TAIL_QUADWORDS * triangleCount, `${triangleCount} triangles from TOP+${indexBase}`);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const normals = new Float32Array(vertexCount * 3);
  for (let k = 0; k < vertexCount; k++) {
    const base = VERTEX_BASE + VERTEX_QUADWORDS * k;
    const a = lanesOf(base, `vertex ${k}'s position quadword`);          // V4-16, signed
    const b = lanesOf(base + 1, `vertex ${k}'s UV quadword`);            // V4-16, signed
    const c = lanesOf(base + 2, `vertex ${k}'s colour quadword`);        // V4-8 USN, unsigned bytes
    positions[k * 3 + X] = (mem[a + X]! / divisor) * multiplier + add[X]!;
    positions[k * 3 + Y] = (mem[a + Y]! / divisor) * multiplier + add[Y]!;
    positions[k * 3 + Z] = (mem[a + Z]! / divisor) * multiplier + add[Z]!;
    normals[k * 3 + X] = mem[a + W]! / NORMAL_SCALE;
    normals[k * 3 + Y] = mem[b + Z]! / NORMAL_SCALE;
    normals[k * 3 + Z] = mem[b + W]! / NORMAL_SCALE;
    uvs[k * 2 + X] = mem[b + X]! / UV_SCALE;
    uvs[k * 2 + Y] = mem[b + Y]! / UV_SCALE;
    colors[k * 4 + X] = mem[c + X]! / PS2_UNITY;
    colors[k * 4 + Y] = mem[c + Y]! / PS2_UNITY;
    colors[k * 4 + Z] = mem[c + Z]! / PS2_UNITY;
    colors[k * 4 + W] = Math.min(mem[c + W]! / PS2_UNITY, 1);
  }

  // SEMANTICS §6: one triangle per tail pair, in index order, CCW front-facing. Entry [0].w is the runtime
  // cull result the VU rewrites every frame, not a hint on disc, so it is read by nothing here.
  const indices = new Uint32Array(triangleCount * 3);
  const faceNormals = new Float32Array(triangleCount * 3);
  let kept = 0;
  for (let t = 0; t < triangleCount; t++) {
    const entry = indexBase + TAIL_QUADWORDS * t;
    const e0 = lanesOf(entry, `triangle ${t}'s index quadword`);         // V4-8 USN, unsigned bytes
    const e1 = lanesOf(entry + 1, `triangle ${t}'s face normal`);        // V3-16, signed; lane w is stale
    const i0 = vertexIndex(mem[e0 + X]!, vertexCount, `triangle ${t} x`);
    const i1 = vertexIndex(mem[e0 + Y]!, vertexCount, `triangle ${t} y`);
    const i2 = vertexIndex(mem[e0 + Z]!, vertexCount, `triangle ${t} z`);
    if (isDegenerate(positions, i0, i1, i2)) continue;                   // SEMANTICS §6: they exist, drop them
    indices[kept * 3 + 0] = i0;
    indices[kept * 3 + 1] = i1;
    indices[kept * 3 + 2] = i2;
    faceNormals[kept * 3 + X] = mem[e1 + X]! / NORMAL_SCALE;
    faceNormals[kept * 3 + Y] = mem[e1 + Y]! / NORMAL_SCALE;
    faceNormals[kept * 3 + Z] = mem[e1 + Z]! / NORMAL_SCALE;
    kept++;
  }

  return {
    positions, uvs, colors, normals,
    // `slice`, not `subarray`: a dropped triangle must not leave a consumer a buffer longer than the mesh.
    faceNormals: kept === triangleCount ? faceNormals : faceNormals.slice(0, kept * 3),
    indices: kept === triangleCount ? indices : indices.slice(0, kept * 3),
    textureName: packet.textureName,
    fog: packetFogged(packet),
  };
}

/** Zero area: the two edges are parallel, so the triangle covers no pixels and has no usable normal. */
function isDegenerate(positions: Float32Array, i0: number, i1: number, i2: number): boolean {
  const ax = positions[i0 * 3]!, ay = positions[i0 * 3 + 1]!, az = positions[i0 * 3 + 2]!;
  const ux = positions[i1 * 3]! - ax, uy = positions[i1 * 3 + 1]! - ay, uz = positions[i1 * 3 + 2]! - az;
  const vx = positions[i2 * 3]! - ax, vy = positions[i2 * 3 + 1]! - ay, vz = positions[i2 * 3 + 2]! - az;
  return uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0;
}

/**
 * Everything one chunk draws, split by primitive: one entry per `MSCNT` packet, each with the texture the
 * chain cited for it. The `MSCAL 0` packets carry the two parameter quadwords VU1 entry 0 reads
 * (SEMANTICS §9) and no geometry, so they contribute nothing.
 *
 * A chunk may hold both kinds — Crossroads' `tent_beige` draws its canvas as meshes and its guy ropes as
 * line strips — so which decode a packet gets is decided per packet, by the `PRIM` its own GIFtag
 * template states, not by anything the chunk or the chain says.
 */
export function interpretChainParts(chain: Chain): { meshes: MeshData[]; lines: LineStrip[] } {
  return interpretChainPartsAs(chain, 'bias');
}

/**
 * `interpretChainParts` with the position form the drawing command applies (`PositionForm`): `'scale'` for the
 * weapons' chains (web/docs/research/79 §2). A separate name so `interpretChainParts` stays a one-argument callback.
 */
export function interpretChainPartsAs(chain: Chain, form: PositionForm): { meshes: MeshData[]; lines: LineStrip[] } {
  const meshes: MeshData[] = [];
  const lines: LineStrip[] = [];
  const packets = unpackVif(chain);
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i]!;
    if (packet.kind !== 'mscnt') continue;
    try {
      if (isLineStripPacket(packet)) lines.push(interpretLinePacket(packet));
      else meshes.push(interpretPacket(packet, form));
    } catch (e) {
      if (!(e instanceof MeshError)) throw e;
      throw new MeshError(`chunk ${chain.nodeName} packet ${i}: ${e.message}`);
    }
  }
  return { meshes, lines };
}

/**
 * Every mesh one chunk draws. A chunk's line strips are not meshes and are not returned here; ask
 * `interpretChainLines` or `interpretChainParts` for those.
 */
export function interpretChain(chain: Chain): MeshData[] {
  return interpretChainParts(chain).meshes;
}

/** Every line strip one chunk draws, in packet order. */
export function interpretChainLines(chain: Chain): LineStrip[] {
  return interpretChainParts(chain).lines;
}
