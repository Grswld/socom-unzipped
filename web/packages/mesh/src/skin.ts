import { Reader, type Zar } from '@s2u/archive';
import { unpackVifStream, type VuPacket } from './vif';
import { packetFogged } from './interpret';

/**
 * The character-model chain form: `CLIB_MDL.ZED`'s `MESH_<name>` buffers, the `CMesh`/`CSubMesh` path
 * (reCOM `zVisual/vis_main.cpp:246-265` for the two `vtype`s, `:31-55` for `hookupMesh`). Research 72 §3
 * warned the map walker reads garbage here; web/docs/research/78 is the format this file decodes, and every
 * rule below cites the section it rests on.
 *
 * In one paragraph (78 §2): `MESH_<name>_START` is the byte offset of a count quadword whose low half is the
 * tag count (`ref_count`, and the `u16` `CMesh::SetMeshTextureSelects` loops over, `vis_mesh.cpp:5-24`).
 * The tags that follow draw the model in **batches**, one VU1 program each. A batch is, per bone it is
 * skinned to, a relocation-9 tag (`STCYCL 1,1; UNPACK V4-32 num=4 addr=0`, its ADDR the bone's palette slot:
 * the EE points it at that bone's matrix, which lands on `TOP+0..3`) and a relocation-10 tag (the bone's
 * vertex list, `V4-16` at `TOP+4`, then `MSCNT`); then one relocation-11 tag, the draw packet (the index
 * list, the two GIFtag templates and the counts, the uvs, `MSCNT`). Relocation-6 tags cite the texture.
 * The bone lists are exactly what VU1 command `0x52` reads (research 15 §4.1): `TOP+4` is
 * `(flags, triangles, palette slot, count)`, then two quadwords a vertex, `(x, y, z, destination)` and
 * `(nx, ny, nz, weight)`, all 1.15 fixed point, the position scaled by 10 (`LOI 10.0`, 15 §4.2).
 */

/** 78 §2: the count quadword's DMA id is `end` (7) on every mesh of the 22 maps, and its low half the count. */
const HEAD_ID = 7, COUNT_MASK = 0xffff;
const QUADWORD = 16;
/** 78 §2: the relocation types a mesh chain uses. 6 is the texture citation of 36 §3; 9, 10 and 11 are new. */
export const RELOC_TEXTURE = 6, RELOC_MATRIX = 9, RELOC_BONE = 10, RELOC_DRAW = 11;
const ID_CNT = 1, ID_REF = 3;
/** 78 §2: a matrix tag's two VIF codes, `STCYCL 1,1` and `UNPACK V4-32 num=4 addr=0 FLG`, on all 72,116 of them. */
const MATRIX_VIF0 = 0x01000101, MATRIX_VIF1 = 0x6c048000, MATRIX_QWC = 4;
const MAX_TEXTURE_NAME = 64;

/** 15 §4.1 / 78 §2: `TOP+4`, the bone list's header, and the vertex pairs from `TOP+5`. */
const BONE_HEADER_QW = 4, BONE_VERTEX_QW = 5;
/** 15 §4.1: the flags word. Bit 0 accumulate (not the first bone), bit 1 the first pass (78 §2), bit 2 the last bone. */
export const PASS_ACCUMULATE = 1, PASS_FIRST = 2, PASS_LAST = 4;
/** 15 §4.2: `ITOF15` then `MUL vf19, vf19, I` with `LOI 10.0` -- the position lanes, not the normal. */
const POSITION_SCALE = 10;
const ONE15 = 32768;
/** 15 §4.1: the destination lane counts staging quadwords, two a vertex (position, normal). */
const STAGING_STRIDE = 2;

/** SEMANTICS §2/§3 and 78 §2: the draw packet's header quadwords and its vertex triple. */
const COUNTS_QW = 2, VERTEX_BASE = 4, VERTEX_QUADWORDS = 3, UV_QW = 1;
const TAIL_QUADWORDS = 2, INDEX_STRIDE = 3, UV_SCALE = 4096;
const X = 0, Y = 1, Z = 2, W = 3, LANES = 4;

/** A mesh chain this decoder cannot account for, lane for lane. */
export class SkinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkinError';
  }
}

/** One tag of a mesh chain, as `CVisual::SetBuffer` would see it (36 §3's layout, 78 §2's meanings). */
export interface MeshTag {
  qwc: number; reloc: number; id: number; addr: number;
  /** Tag words 2 and 3: VIF codes on a matrix tag, `(slot, count)` on a bone tag, `(2 x bones, 0)` on a draw. */
  word2: number; word3: number;
  tagOffset: number;
}

/** One bone's contribution to a batch: the `0x52` pass VU1 runs for it (research 15 §4). */
export interface BonePass {
  /** The palette slot: the reloc-9 tag's ADDR and `TOP+4.z`, which `CLIB_GEO`'s `matrix_id` names (78 §3). */
  matrix: number;
  /** `TOP+4.x`: `PASS_FIRST`, `PASS_ACCUMULATE`, `PASS_LAST` (15 §4.1, 78 §2). */
  flags: number;
  /** How many vertices this bone moves. */
  count: number;
}

/** One VU1 batch: its bone passes, then the draw packet that consumes the staging they filled. */
export interface SkinnedBatch {
  textureName: string | null;
  passes: BonePass[];
  vertexCount: number;
  triangleCount: number;
  fog: boolean;
}

/**
 * The triangles one texture draws, with every vertex's influences: variable-length lists, flattened the way a
 * sparse matrix is (`influenceStart[v]` to `influenceStart[v + 1]`). Each influence carries the bone's own
 * copy of the vertex -- a position and a normal in that bone's frame -- because that is what the disc stores
 * and what VU1 multiplies (15 §4.2); `skinSubMesh` turns them into one position for a given palette.
 */
export interface SkinnedSubMesh {
  textureName: string | null;
  /** The `TOP+0` GIFtag template's `FGE`, as `MeshData.fog`. */
  fog: boolean;
  vertexCount: number;
  /** uv per vertex, `ITOF12`, normalised, unflipped (SEMANTICS §7). */
  uvs: Float32Array;
  /** Three per triangle, CCW front-facing (SEMANTICS §6), local to this sub-mesh. */
  indices: Uint32Array;
  influenceStart: Uint32Array;
  /** The palette slot of each influence. */
  influenceBone: Uint8Array;
  /** `ITOF15`; a vertex's weights sum to one, to a lane's last bit per influence. */
  influenceWeight: Float32Array;
  /** xyz per influence in its bone's frame: `ITOF15 x 10`. */
  influencePosition: Float32Array;
  /** xyz per influence in its bone's frame: `ITOF15`. */
  influenceNormal: Float32Array;
}

/** A character mesh, decoded: one sub-mesh per texture, the batches it was drawn in, and its counts. */
export interface SkinnedMeshData {
  name: string;
  subMeshes: SkinnedSubMesh[];
  batches: SkinnedBatch[];
  vertexCount: number;
  triangleCount: number;
  /** The most bones any one vertex is weighted to. */
  maxInfluences: number;
  /** The palette slots the passes name, ascending. */
  bones: number[];
  tagCount: number;
}

/** The tags of one mesh chain (78 §2): the count quadword at `start`, then that many tags. */
export function meshChainTags(buffer: Uint8Array, start: number, name: string): MeshTag[] {
  const r = new Reader(buffer);
  if (start + QUADWORD > buffer.byteLength) throw new SkinError(`${name}: _START 0x${start.toString(16)} is outside the ${buffer.byteLength}-byte buffer`);
  const head = r.u32(start);
  if (((head >>> 28) & 7) !== HEAD_ID || ((head >>> 16) & 0xfff) !== 0) {
    throw new SkinError(`${name}: the count quadword reads 0x${head.toString(16)}, not an end tag carrying the tag count (78 §2)`);
  }
  const count = head & COUNT_MASK;
  if (start + QUADWORD * (count + 1) > buffer.byteLength) throw new SkinError(`${name}: ${count} tags run past the buffer`);
  const tags: MeshTag[] = [];
  for (let i = 0; i < count; i++) {
    const o = start + QUADWORD * (i + 1);
    const w0 = r.u32(o);
    tags.push({
      qwc: w0 & 0xffff, reloc: (w0 >>> 16) & 0xff, id: (w0 >>> 28) & 7,
      addr: r.u32(o + 4), word2: r.u32(o + 8), word3: r.u32(o + 12), tagOffset: o,
    });
  }
  return tags;
}

/** A batch while it is being read: the passes and their vertices, before the draw packet closes it. */
interface OpenPass { pass: BonePass; triangles: number; vertices: { dst: number; p: number[]; n: number[]; w: number }[] }

/** The bytes a `ref` tag transfers, checked against the buffer. */
function payload(buffer: Uint8Array, tag: MeshTag, what: string): Uint8Array {
  if (tag.id !== ID_REF) throw new SkinError(`${what}: DMA id ${tag.id}, expected ref (78 §2)`);
  const bytes = tag.qwc * QUADWORD;
  if (tag.addr + bytes > buffer.byteLength) throw new SkinError(`${what}: ${bytes} bytes at 0x${tag.addr.toString(16)} run past the buffer`);
  return buffer.subarray(tag.addr, tag.addr + bytes);
}

/** The one `MSCNT` packet a bone or draw payload unpacks into (78 §2: each ends in exactly one). */
function onePacket(bytes: Uint8Array, what: string): VuPacket {
  let packets: VuPacket[];
  try {
    packets = unpackVifStream(bytes);
  } catch (e) {
    throw new SkinError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (packets.length !== 1 || packets[0]!.kind !== 'mscnt') throw new SkinError(`${what}: ${packets.length} packets, expected one closed by MSCNT`);
  return packets[0]!;
}

const lanes = (packet: VuPacket, qw: number, what: string): number => {
  if (packet.written[qw] !== 1) throw new SkinError(`${what}: TOP+${qw} was never unpacked`);
  return qw * LANES;
};

/** Reads one bone list (15 §4.1, 78 §2): the header at `TOP+4`, then `count` vertex pairs. */
function readPass(buffer: Uint8Array, tag: MeshTag, matrixTag: MeshTag | null, what: string): OpenPass {
  if (!matrixTag) throw new SkinError(`${what}: a bone list with no matrix tag in front of it (78 §2)`);
  const packet = onePacket(payload(buffer, tag, what), what);
  const u = packet.unpacks;
  if (u.length !== 1 || u[0]!.vn !== 3 || u[0]!.vl !== 1 || u[0]!.addr !== BONE_HEADER_QW || u[0]!.cl !== 1 || u[0]!.wl !== 1) {
    throw new SkinError(`${what}: not the one V4-16 unpack at TOP+4 a bone list is (78 §2)`);
  }
  const { mem } = packet;
  const h = lanes(packet, BONE_HEADER_QW, what);
  const flags = mem[h + X]!, triangles = mem[h + Y]!, matrix = mem[h + Z]!, count = mem[h + W]!;
  if (matrix !== matrixTag.addr) throw new SkinError(`${what}: TOP+4 names slot ${matrix}, its matrix tag slot ${matrixTag.addr}`);
  if (matrix !== tag.word2 || count !== tag.word3) {
    throw new SkinError(`${what}: TOP+4 says slot ${matrix}, ${count} vertices; its tag says ${tag.word2}, ${tag.word3}`);
  }
  if (u[0]!.num !== 1 + 2 * count) throw new SkinError(`${what}: ${u[0]!.num} quadwords unpacked for ${count} vertices`);
  const vertices: OpenPass['vertices'] = [];
  for (let k = 0; k < count; k++) {
    const a = lanes(packet, BONE_VERTEX_QW + 2 * k, what), b = lanes(packet, BONE_VERTEX_QW + 2 * k + 1, what);
    vertices.push({
      dst: mem[a + W]!,
      p: [mem[a + X]! / ONE15 * POSITION_SCALE, mem[a + Y]! / ONE15 * POSITION_SCALE, mem[a + Z]! / ONE15 * POSITION_SCALE],
      n: [mem[b + X]! / ONE15, mem[b + Y]! / ONE15, mem[b + Z]! / ONE15],
      w: mem[b + W]! / ONE15,
    });
  }
  return { pass: { matrix, flags, count }, triangles, vertices };
}

/**
 * Decodes one `MESH_<name>` buffer from its `_START` offset. Throws `SkinError` on anything 78 §2 does not
 * describe: the decode reads every lane it relies on and checks each count against the other place it is
 * stated, so a chain that decodes here is a chain that was understood.
 */
export function decodeSkinnedMesh(buffer: Uint8Array, start: number, name: string): SkinnedMeshData {
  const tags = meshChainTags(buffer, start, name);
  const r = new Reader(buffer);
  let texture: string | null = null;
  let matrixTag: MeshTag | null = null;
  let open: OpenPass[] = [];
  const batches: { batch: SkinnedBatch; passes: OpenPass[]; uvs: Float32Array; indices: Uint32Array }[] = [];

  tags.forEach((tag, i) => {
    const what = `${name} tag ${i}`;
    switch (tag.reloc) {
      case RELOC_TEXTURE:
        // 36 §3: a citation, `cnt` with QWC 0, ADDR a name inside the same buffer.
        if (tag.id !== ID_CNT || tag.qwc !== 0) throw new SkinError(`${what}: a texture citation that transfers ${tag.qwc} quadwords`);
        if (tag.addr >= buffer.byteLength) throw new SkinError(`${what}: texture name outside the buffer`);
        texture = r.cstr(tag.addr, Math.min(MAX_TEXTURE_NAME, buffer.byteLength - tag.addr));
        return;
      case RELOC_MATRIX:
        if (tag.id !== ID_REF || tag.qwc !== MATRIX_QWC || tag.word2 !== MATRIX_VIF0 || tag.word3 !== MATRIX_VIF1) {
          throw new SkinError(`${what}: not the STCYCL 1,1 / UNPACK V4-32 num=4 addr=0 a matrix tag is (78 §2)`);
        }
        if (matrixTag) throw new SkinError(`${what}: two matrix tags with no bone list between`);
        matrixTag = tag;
        return;
      case RELOC_BONE:
        open.push(readPass(buffer, tag, matrixTag, what));
        matrixTag = null;
        return;
      case RELOC_DRAW:
        if (matrixTag) throw new SkinError(`${what}: a matrix tag with no bone list before the draw`);
        batches.push(closeBatch(buffer, tag, open, texture, what));
        open = [];
        return;
      default:
        throw new SkinError(`${what}: relocation type ${tag.reloc} is not part of a mesh chain (78 §2)`);
    }
  });
  if (open.length || matrixTag) throw new SkinError(`${name}: the chain ends inside a batch`);

  // 78 §2: one sub-mesh per (texture, fog), in the order the chain first draws each.
  const groups = new Map<string, typeof batches>();
  for (const b of batches) {
    const key = `${b.batch.textureName ?? ''}|${b.batch.fog ? 1 : 0}`;
    const list = groups.get(key);
    if (list) list.push(b);
    else groups.set(key, [b]);
  }
  const subMeshes = [...groups.values()].map(mergeBatches);
  const bones = new Set<number>();
  for (const b of batches) for (const p of b.batch.passes) bones.add(p.matrix);
  let maxInfluences = 0;
  for (const s of subMeshes) {
    for (let v = 0; v < s.vertexCount; v++) maxInfluences = Math.max(maxInfluences, s.influenceStart[v + 1]! - s.influenceStart[v]!);
  }
  return {
    name,
    subMeshes,
    batches: batches.map((b) => b.batch),
    vertexCount: subMeshes.reduce((n, s) => n + s.vertexCount, 0),
    triangleCount: subMeshes.reduce((n, s) => n + s.indices.length / 3, 0),
    maxInfluences,
    bones: [...bones].sort((a, b) => a - b),
    tagCount: tags.length,
  };
}

/** Reads a draw packet (78 §2) and checks it against the passes that filled its staging. */
function closeBatch(buffer: Uint8Array, tag: MeshTag, passes: OpenPass[], texture: string | null, what: string):
{ batch: SkinnedBatch; passes: OpenPass[]; uvs: Float32Array; indices: Uint32Array } {
  if (passes.length === 0) throw new SkinError(`${what}: a draw packet with no bone list before it`);
  if (tag.word2 !== 2 * passes.length || tag.word3 !== 0) throw new SkinError(`${what}: the draw tag says ${tag.word2 / 2} bones, the batch has ${passes.length}`);
  const packet = onePacket(payload(buffer, tag, what), what);
  const { mem } = packet;
  for (let q = 0; q < VERTEX_BASE; q++) lanes(packet, q, what);
  const indexBase = mem[COUNTS_QW * LANES + X]!, vertexCount = mem[COUNTS_QW * LANES + Z]!, triangleCount = mem[COUNTS_QW * LANES + W]!;
  if (indexBase !== VERTEX_BASE + VERTEX_QUADWORDS * vertexCount) throw new SkinError(`${what}: index base ${indexBase} is not 4 + 3 x ${vertexCount}`);

  // 15 §4.2-4.4: the first pass writes every staging slot, the rest add to it, the last is flagged; the
  // repack at 0x33c8 then loops over the first pass's count, so that is the batch's vertex count.
  const first = passes[0]!;
  if (!(first.pass.flags & PASS_FIRST) || first.pass.flags & PASS_ACCUMULATE) throw new SkinError(`${what}: the first pass has flags ${first.pass.flags}`);
  passes.forEach((p, i) => {
    const last = i === passes.length - 1;
    if (i > 0 && (p.pass.flags & (PASS_ACCUMULATE | PASS_FIRST)) !== PASS_ACCUMULATE) throw new SkinError(`${what}: pass ${i} has flags ${p.pass.flags}`);
    if (!!(p.pass.flags & PASS_LAST) !== last) throw new SkinError(`${what}: pass ${i} has flags ${p.pass.flags}, ${last ? '' : 'not '}the last`);
    if (p.triangles !== triangleCount) throw new SkinError(`${what}: pass ${i} says ${p.triangles} triangles, the draw ${triangleCount}`);
  });
  if (first.vertices.length !== vertexCount) throw new SkinError(`${what}: the first pass moves ${first.vertices.length} vertices, the draw ${vertexCount}`);
  const seen = new Uint8Array(vertexCount);
  for (const p of passes) {
    for (const v of p.vertices) {
      if (v.dst % STAGING_STRIDE !== 0 || v.dst < 0 || v.dst / STAGING_STRIDE >= vertexCount) {
        throw new SkinError(`${what}: slot ${p.pass.matrix} writes staging ${v.dst}, outside ${vertexCount} vertices`);
      }
      if (p === first) seen[v.dst / STAGING_STRIDE] = seen[v.dst / STAGING_STRIDE]! + 1;
    }
  }
  if (seen.some((n) => n !== 1)) throw new SkinError(`${what}: the first pass does not write every vertex exactly once`);

  const uvs = new Float32Array(vertexCount * 2);
  for (let k = 0; k < vertexCount; k++) {
    const b = lanes(packet, VERTEX_BASE + VERTEX_QUADWORDS * k + UV_QW, `${what} vertex ${k}'s uv`);
    uvs[k * 2] = mem[b + X]! / UV_SCALE;
    uvs[k * 2 + 1] = mem[b + Y]! / UV_SCALE;
  }
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const e = lanes(packet, indexBase + TAIL_QUADWORDS * t, `${what} triangle ${t}`);
    for (let c = 0; c < 3; c++) {
      const byte = mem[e + c]!;
      if (byte % INDEX_STRIDE !== 0 || byte / INDEX_STRIDE >= vertexCount) {
        throw new SkinError(`${what}: triangle ${t} names vertex ${byte / INDEX_STRIDE} of ${vertexCount}`);
      }
      indices[t * 3 + c] = byte / INDEX_STRIDE;
    }
  }
  return {
    batch: { textureName: texture, passes: passes.map((p) => p.pass), vertexCount, triangleCount, fog: packetFogged(packet) },
    passes, uvs, indices,
  };
}

/** One sub-mesh out of the batches that share a texture: vertices concatenated, indices re-based. */
function mergeBatches(list: { batch: SkinnedBatch; passes: OpenPass[]; uvs: Float32Array; indices: Uint32Array }[]): SkinnedSubMesh {
  const vertexCount = list.reduce((n, b) => n + b.batch.vertexCount, 0);
  const influences = list.reduce((n, b) => n + b.passes.reduce((m, p) => m + p.vertices.length, 0), 0);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(list.reduce((n, b) => n + b.indices.length, 0));
  const influenceStart = new Uint32Array(vertexCount + 1);
  const influenceBone = new Uint8Array(influences);
  const influenceWeight = new Float32Array(influences);
  const influencePosition = new Float32Array(influences * 3);
  const influenceNormal = new Float32Array(influences * 3);
  let vertex = 0, index = 0, k = 0;
  for (const b of list) {
    uvs.set(b.uvs, vertex * 2);
    for (let i = 0; i < b.indices.length; i++) indices[index + i] = b.indices[i]! + vertex;
    index += b.indices.length;
    // Per vertex, its influences in pass order: the order VU1 accumulates them in (15 §4.3).
    const per: { bone: number; w: number; p: number[]; n: number[] }[][] = Array.from({ length: b.batch.vertexCount }, () => []);
    for (const p of b.passes) for (const v of p.vertices) per[v.dst / STAGING_STRIDE]!.push({ bone: p.pass.matrix, w: v.w, p: v.p, n: v.n });
    for (let v = 0; v < per.length; v++) {
      influenceStart[vertex + v] = k;
      for (const inf of per[v]!) {
        influenceBone[k] = inf.bone;
        influenceWeight[k] = inf.w;
        influencePosition.set(inf.p, k * 3);
        influenceNormal.set(inf.n, k * 3);
        k++;
      }
    }
    vertex += b.batch.vertexCount;
  }
  influenceStart[vertexCount] = k;
  const first = list[0]!.batch;
  return {
    textureName: first.textureName, fog: first.fog, vertexCount, uvs, indices,
    influenceStart, influenceBone, influenceWeight, influencePosition, influenceNormal,
  };
}

/**
 * The game's skinning, for a palette of row-major row-vector matrices (the engine's convention, 24 §1.1) indexed
 * by slot: per vertex, `sum of w * (p x M)` with the translation weighted too, and the normal through the 3x3
 * alone -- exactly the `0x52` arithmetic (research 15 §4.2-4.3). The normal is not renormalised; VU1 does not.
 */
export function skinSubMesh(sub: SkinnedSubMesh, palette: ArrayLike<ArrayLike<number>>): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(sub.vertexCount * 3);
  const normals = new Float32Array(sub.vertexCount * 3);
  for (let v = 0; v < sub.vertexCount; v++) {
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let k = sub.influenceStart[v]!; k < sub.influenceStart[v + 1]!; k++) {
      const m = palette[sub.influenceBone[k]!];
      if (!m) throw new SkinError(`palette has no slot ${sub.influenceBone[k]}`);
      const w = sub.influenceWeight[k]!;
      const x = sub.influencePosition[k * 3]!, y = sub.influencePosition[k * 3 + 1]!, z = sub.influencePosition[k * 3 + 2]!;
      const a = sub.influenceNormal[k * 3]!, b = sub.influenceNormal[k * 3 + 1]!, c = sub.influenceNormal[k * 3 + 2]!;
      px += w * (x * m[0]! + y * m[4]! + z * m[8]! + m[12]!);
      py += w * (x * m[1]! + y * m[5]! + z * m[9]! + m[13]!);
      pz += w * (x * m[2]! + y * m[6]! + z * m[10]! + m[14]!);
      nx += w * (a * m[0]! + b * m[4]! + c * m[8]!);
      ny += w * (a * m[1]! + b * m[5]! + c * m[9]!);
      nz += w * (a * m[2]! + b * m[6]! + c * m[10]!);
    }
    positions[v * 3] = px; positions[v * 3 + 1] = py; positions[v * 3 + 2] = pz;
    normals[v * 3] = nx; normals[v * 3 + 1] = ny; normals[v * 3 + 2] = nz;
  }
  return { positions, normals };
}

/**
 * How far apart a vertex's copies land once each is carried through its own bone's matrix: the largest distance,
 * over every vertex, from any one copy to their weighted mean. Zero for a palette the mesh was exported against,
 * whole units for any other -- which is how the bind palette is proved (78 §3), and what makes a single
 * bind-space position plus inverse bind matrices (three's `SkinnedMesh`) reproduce the game's sum exactly.
 */
export function influenceSpread(sub: SkinnedSubMesh, palette: ArrayLike<ArrayLike<number>>): number {
  const { positions } = skinSubMesh(sub, palette);
  let worst = 0;
  for (let v = 0; v < sub.vertexCount; v++) {
    for (let k = sub.influenceStart[v]!; k < sub.influenceStart[v + 1]!; k++) {
      const m = palette[sub.influenceBone[k]!]!;
      const x = sub.influencePosition[k * 3]!, y = sub.influencePosition[k * 3 + 1]!, z = sub.influencePosition[k * 3 + 2]!;
      const qx = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
      const qy = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
      const qz = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
      worst = Math.max(worst, Math.hypot(qx - positions[v * 3]!, qy - positions[v * 3 + 1]!, qz - positions[v * 3 + 2]!));
    }
  }
  return worst;
}

/**
 * A renderer's fixed-width influences: the `n` largest per vertex, renormalised to sum to one, padded with
 * weight 0 on slot 0. `droppedMax` is the largest weight any vertex lost, the size of the approximation --
 * a disc vertex has up to six influences (78 §4) and three's skinning takes four.
 */
export function topInfluences(sub: SkinnedSubMesh, n = 4): { index: Uint16Array; weight: Float32Array; droppedMax: number } {
  const index = new Uint16Array(sub.vertexCount * n);
  const weight = new Float32Array(sub.vertexCount * n);
  let droppedMax = 0;
  for (let v = 0; v < sub.vertexCount; v++) {
    const list: { bone: number; w: number }[] = [];
    for (let k = sub.influenceStart[v]!; k < sub.influenceStart[v + 1]!; k++) list.push({ bone: sub.influenceBone[k]!, w: sub.influenceWeight[k]! });
    list.sort((a, b) => b.w - a.w);
    const kept = list.slice(0, n);
    for (const d of list.slice(n)) droppedMax = Math.max(droppedMax, d.w);
    const sum = kept.reduce((s, x) => s + x.w, 0) || 1;
    kept.forEach((x, i) => { index[v * n + i] = x.bone; weight[v * n + i] = x.w / sum; });
  }
  return { index, weight, droppedMax };
}

/** One `MESH_*` key of a `CLIB_MDL.ZED`, and what became of it. */
export interface MeshLibraryEntry {
  /** The model's name: the key without `MESH_`, as `CLIB_GEO.ZED`'s `models` names it. */
  name: string;
  start: number;
  /** `ref_count`: the chain's tag count on every mesh of the 22 maps (78 §4). */
  refCount: number;
  /** `mtx_count`: the palette's size, 26 on every mesh of the 22 maps (78 §3). */
  mtxCount: number;
  tagCount: number;
  mesh: SkinnedMeshData | null;
  /** Why it did not decode, or null. */
  error: string | null;
}

/** `sprintf(buf, "MESH_%s", model->m_name)` -- `hookupMesh`, `vis_main.cpp:36`. */
const MESH_PREFIX = 'MESH_', START_SUFFIX = '_START';

/** The model names a `CLIB_MDL.ZED` holds, in key order, without decoding any of them. */
export function meshNames(zar: Zar): string[] {
  return zar.root.children.filter((k) => k.name.startsWith(MESH_PREFIX)).map((k) => k.name.slice(MESH_PREFIX.length));
}

/**
 * Every character mesh of a `CLIB_MDL.ZED`, in key order, or only those named in `only`. A mesh that will not
 * decode is an entry with its error, not an exception: one bad model must not cost the others.
 */
export function readMeshLibrary(zar: Zar, only?: readonly string[]): MeshLibraryEntry[] {
  const out: MeshLibraryEntry[] = [];
  for (const key of zar.root.children) {
    if (!key.name.startsWith(MESH_PREFIX)) continue;
    const name = key.name.slice(MESH_PREFIX.length);
    if (only && !only.includes(name)) continue;
    const u32Of = (child: string): number | null => {
      const k = zar.child(key, child);
      return k && k.size === 4 ? new Reader(zar.data(k)).u32(0) : null;
    };
    const start = u32Of(key.name + START_SUFFIX), refCount = u32Of('ref_count'), mtxCount = u32Of('mtx_count');
    const entry: MeshLibraryEntry = { name, start: start ?? -1, refCount: refCount ?? -1, mtxCount: mtxCount ?? -1, tagCount: 0, mesh: null, error: null };
    try {
      if (start === null || refCount === null || mtxCount === null) throw new SkinError(`${key.name}: missing ${key.name}${START_SUFFIX}, ref_count or mtx_count`);
      const mesh = decodeSkinnedMesh(zar.data(key), start, name);
      entry.tagCount = mesh.tagCount;
      if (mesh.tagCount !== refCount) throw new SkinError(`${name}: ${mesh.tagCount} tags, ref_count ${refCount}`);
      const over = mesh.bones.find((b) => b >= mtxCount);
      if (over !== undefined) throw new SkinError(`${name}: palette slot ${over} past mtx_count ${mtxCount}`);
      entry.mesh = mesh;
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }
    out.push(entry);
  }
  return out;
}
