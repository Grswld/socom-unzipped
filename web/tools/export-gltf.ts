import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseZdb, zdbMember, Zar, type ZarKey } from '@s2u/archive';
import { decodeTexture, parseTextureRecord, PaletteTable, type TextureRecord } from '@s2u/gs';
import { bounds, interpretChain, mergeMeshes, modelNodes, walkModel, type MeshData } from '@s2u/mesh';
import { encodePng } from './png';
import {
  ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, GlbWriter, LINEAR, NEAREST, REPEAT, UNSIGNED_BYTE, UNSIGNED_INT,
  type AccessorType, type Json,
} from './gltf';

/**
 * Exports one map's world mesh to a glTF 2.0 binary (`.glb`) — the debugging aid for eyes other than the
 * viewer's: Blender, three.js's editor, the Khronos sample viewer, a validator.
 *
 * Usage: `npm run export-gltf -- [ARCHIVE] [OUT.glb]`
 *   ARCHIVE  path under `web/test-fixtures/`, default `RUN/MP2.ZDB` (Frostfire, R36 §0)
 *   OUT.glb  path relative to the current directory (or absolute),
 *            default `web/test-fixtures/<map>-world.glb`
 * e.g. from the repository root: `npm --prefix web run export-gltf -- RUN/MP2.ZDB`
 *
 * Coordinates: the decoded geometry is MODEL space (SEMANTICS §4). SEMANTICS §8 measures the Frostfire
 * worldmodel's placement as one shared, pure translation of (960, 0, 800), so that is the root node's
 * `translation` and the glb is in world units. The frame is already y-up, right-handed, CCW front faces
 * (§8, §6) — glTF's own convention — so nothing is negated or swapped.
 */
const web = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const archive = args[0] ?? 'RUN/MP2.ZDB';
const stem = basename(archive, '.ZDB');                     // MP2, MP6, ... -- the prefix its members are named with
const map = stem === 'MP2' ? 'frostfire' : stem.toLowerCase();   // R36 §0 names MP2 Frostfire
const outPath = args[1] ? resolve(args[1]) : join(web, 'test-fixtures', `${map}-world.glb`);

/** SEMANTICS §8: every `worldmodel` child of MP2_GEO.ZED carries the same nparams, identity 3x3 at (960, 0, 800). */
const WORLD_TRANSLATION: [number, number, number] = [960, 0, 800];

const zdbPath = join(web, 'test-fixtures', archive);
if (!existsSync(zdbPath)) { console.error(`no ${archive} at ${zdbPath} (run npm run extract-maps)`); process.exit(2); }
const zdb = new Uint8Array(readFileSync(zdbPath));
const toc = parseZdb(zdb);

// --- geometry: WORL_MDL.ZED -> worldmodel -> one chain a chunk -> one MeshData a drawn packet (R36 §2, §3)
const worl = Zar.parse(zdbMember(zdb, toc, 'WORL_MDL.ZED'));
const world = worl.find('worldmodel');
if (!world) { console.error(`WORL_MDL.ZED in ${archive} has no 'worldmodel' key`); process.exit(2); }
const parts = walkModel(worl.data(world), modelNodes(worl, world)).flatMap(interpretChain);

// --- textures: the records and palettes the chains' reloc-6 citations name (R36 §5)
const txr = Zar.parse(zdbMember(zdb, toc, `${stem}_TXR.ZED`));
const palettes = PaletteTable.fromZars([Zar.parse(zdbMember(zdb, toc, `${stem}_PAL.ZED`))]);
const records = new Map<string, TextureRecord>();
for (const key of txr.find('textures')?.children ?? [] as ZarKey[]) {
  const texdat = txr.child(key, 'texdat');
  if (texdat) records.set(key.name, parseTextureRecord(key.name, txr.data(texdat)));
}

const glb = new GlbWriter(`s2u export-gltf (${map})`);
glb.useExtension('KHR_materials_unlit');                    // the map's colour is baked into COLOR_0; no lighting
const diagnostics: string[] = [];

/** One accessor over its own tightly packed buffer view. */
/**
 * `MeshData.colors` on glTF's terms: unity (1.0) -> 255, and anything the PS2 wrote above unity
 * flattened to white. COLOR_0 is a 0..1 multiplier with no room above it, so an overbright cannot
 * travel. The three shipped maps contain none, so for them this is lossless.
 */
function clampColors(colors: Float32Array): Uint8Array {
  const out = new Uint8Array(colors.length);
  for (let i = 0; i < colors.length; i++) out[i] = Math.round(Math.min(Math.max(colors[i]!, 0), 1) * 255);
  return out;
}

function accessor(data: ArrayBufferView, componentType: number, type: AccessorType, count: number,
                  opts: { normalized?: boolean; min?: number[]; max?: number[]; target?: number } = {}): number {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return glb.addAccessor(glb.addBufferView(bytes, opts.target), componentType, count, type, opts);
}

/** One unlit, double-sided material per distinct texture; an untextured group gets a plain white one. */
function material(textureName: string | null): number {
  const pbr: Json = { metallicFactor: 0, roughnessFactor: 1 };
  const rec = textureName === null ? undefined : records.get(textureName);
  if (textureName !== null && !rec) diagnostics.push(`${textureName}: cited by the geometry but absent from ${stem}_TXR.ZED; drawn untextured`);
  if (rec) {
    const decoded = decodeTexture(rec, palettes);
    diagnostics.push(...decoded.diagnostics);
    // The V convention, the viewer's (spec §9, M3): the decoder's rows are in memory order, V = 0 the first
    // row, and the UVs are `int16 / 4096` unflipped (SEMANTICS §7). glTF also maps V = 0 to the PNG's first
    // row, so the rows are written out as they are decoded and the UVs go into the accessor verbatim --
    // exactly what the viewer draws with `flipY = false`. (R36 §5's "so a viewer flips V" is superseded.)
    const image = glb.addImage(encodePng(decoded.rgba.width, decoded.rgba.height, decoded.rgba.data), rec.name);
    const filter = rec.bilinear ? LINEAR : NEAREST;         // R36 §5: the record's own bilinear flag
    const sampler = glb.samplers.push({ magFilter: filter, minFilter: filter, wrapS: REPEAT, wrapT: REPEAT }) - 1;
    pbr['baseColorTexture'] = { index: glb.textures.push({ source: image, sampler }) - 1 };
  }
  // R36 §5's `transparent` flag is the record's own; without the .rdr blend state, MASK at 0.5 is the
  // honest reading of a keyed texture and keeps the glb free of draw-order questions.
  const transparent = rec?.transparent ?? false;
  const mat: Json = {
    name: textureName ?? 'untextured',
    pbrMetallicRoughness: pbr,
    alphaMode: transparent ? 'MASK' : 'OPAQUE',
    doubleSided: true,                                      // §6's winding is trusted but not yet eye-checked
    extensions: { KHR_materials_unlit: {} },
  };
  if (transparent) mat['alphaCutoff'] = 0.5;
  return glb.materials.push(mat) - 1;
}

/** How many of a mesh's vertex normals are exactly zero (SEMANTICS §4 allows it, glTF does not). */
function zeros(normals: Float32Array | null): number {
  if (!normals) return 0;
  let n = 0;
  for (let i = 0; i < normals.length; i += 3) if (normals[i] === 0 && normals[i + 1] === 0 && normals[i + 2] === 0) n++;
  return n;
}

// --- one primitive per distinct texture: merge that texture's parts, then lay out its attributes
const groups = new Map<string | null, MeshData[]>();
for (const part of parts) {
  const key = part.textureName;
  const group = groups.get(key);
  if (group) group.push(part); else groups.set(key, [part]);
}

const primitives: Json[] = [];
let triangles = 0, vertices = 0;
const min: [number, number, number] = [Infinity, Infinity, Infinity];
const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

for (const [textureName, group] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  const mesh = mergeMeshes(group);
  const count = mesh.positions.length / 3;
  if (count === 0 || mesh.indices.length === 0) continue;
  const box = bounds(mesh);
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis]!, box.min[axis]!);
    max[axis] = Math.max(max[axis]!, box.max[axis]!);
  }
  const attributes: Json = {
    POSITION: accessor(mesh.positions, FLOAT, 'VEC3', count, { target: ARRAY_BUFFER, min: [...box.min], max: [...box.max] }),
    TEXCOORD_0: accessor(mesh.uvs, FLOAT, 'VEC2', count, { target: ARRAY_BUFFER }),
    // `MeshData.colors` is float RGBA with 1.0 as the PS2's unity (the stored byte over 128, SEMANTICS
    // §4). glTF's COLOR_0 is a plain 0..1 multiplier, so the lane is clamped on the way out. Note the
    // .glb carries the *material* colour: the viewer's `lit` multiply is not applied here, so a .glb is
    // darker than the viewer and is meant to be, being the geometry rather than a picture of it.
    COLOR_0: accessor(clampColors(mesh.colors), UNSIGNED_BYTE, 'VEC4', count, { target: ARRAY_BUFFER, normalized: true }),
  };
  // SEMANTICS §11.5: 16 of Frostfire's vertex normals are exactly zero, which glTF forbids
  // (ACCESSOR_VECTOR3_NON_UNIT). Rather than invent a direction, the primitive that holds one ships without
  // NORMAL, and a reader computes flat normals -- which §6 vouches for, the CCW cross product in index order
  // being the stored face normal. Nothing is lost: these materials are unlit.
  const zeroNormals = zeros(mesh.normals);
  if (zeroNormals > 0) diagnostics.push(`${textureName ?? 'untextured'}: ${zeroNormals} zero vertex normal(s) (SEMANTICS §11.5); NORMAL omitted, flat normals implied`);
  if (mesh.normals && zeroNormals === 0) attributes['NORMAL'] = accessor(mesh.normals, FLOAT, 'VEC3', count, { target: ARRAY_BUFFER });
  primitives.push({
    attributes,
    indices: accessor(mesh.indices, UNSIGNED_INT, 'SCALAR', mesh.indices.length, { target: ELEMENT_ARRAY_BUFFER }),
    material: material(textureName),
    mode: 4,                                                // TRIANGLES
  });
  triangles += mesh.indices.length / 3;
  vertices += count;
}

const meshIndex = glb.meshes.push({ name: `${map}-worldmodel`, primitives }) - 1;
glb.roots.push(glb.nodes.push({ name: `${map} world`, mesh: meshIndex, translation: WORLD_TRANSLATION }) - 1);

const bytes = glb.finish();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);

const worldMin = min.map((v, i) => v + WORLD_TRANSLATION[i]!);
const worldMax = max.map((v, i) => v + WORLD_TRANSLATION[i]!);
const box = (v: number[]) => `(${v.map((n) => n.toFixed(1)).join(', ')})`;
console.log(`${map}: ${primitives.length} primitives, ${triangles} triangles, ${vertices} vertices, ${glb.images.length} textures`);
console.log(`bounds (world, after the (${WORLD_TRANSLATION.join(', ')}) node translation): ${box(worldMin)} .. ${box(worldMax)}`);
console.log(`wrote ${outPath} (${bytes.byteLength} bytes)`);
for (const d of new Set(diagnostics)) console.log(`diagnostic: ${d}`);

/**
 * Self-check: re-read what was written and walk it as a reader would. `npx gltf-validator` and
 * `npx @gltf-transform/cli` both need the network, so this stands in for them: the container is parsed from
 * the bytes on disk, and every accessor is checked to fit its buffer view and every buffer view the BIN chunk.
 */
const COMPONENT_BYTES: Record<number, number> = { [UNSIGNED_BYTE]: 1, [FLOAT]: 4, [UNSIGNED_INT]: 4 };
const ELEMENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const problems: string[] = [];
{
  const file = new Uint8Array(readFileSync(outPath));
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) problems.push('magic is not "glTF"');
  if (dv.getUint32(4, true) !== 2) problems.push(`version ${dv.getUint32(4, true)}, expected 2`);
  if (dv.getUint32(8, true) !== file.byteLength) problems.push(`header length ${dv.getUint32(8, true)} != file ${file.byteLength}`);
  const jsonLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) problems.push('chunk 0 is not JSON');
  if (jsonLength % 4 !== 0) problems.push(`JSON chunk ${jsonLength} B is not 4-aligned`);
  const doc = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength))) as {
    bufferViews: { byteOffset?: number; byteLength: number }[];
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[];
    buffers: { byteLength: number }[];
  };
  const binHeader = 20 + jsonLength;
  const binLength = dv.getUint32(binHeader, true);
  if (dv.getUint32(binHeader + 4, true) !== 0x004e4942) problems.push('chunk 1 is not BIN');
  if (binHeader + 8 + binLength !== file.byteLength) problems.push(`BIN chunk ${binLength} B does not reach the end of the file`);
  if (doc.buffers[0]!.byteLength > binLength) problems.push(`buffer 0 (${doc.buffers[0]!.byteLength} B) exceeds the BIN chunk (${binLength} B)`);
  doc.bufferViews.forEach((v, i) => {
    if ((v.byteOffset ?? 0) + v.byteLength > binLength) problems.push(`bufferView ${i} runs past the BIN chunk`);
    if ((v.byteOffset ?? 0) % 4 !== 0) problems.push(`bufferView ${i} starts at ${v.byteOffset ?? 0}, not 4-aligned`);
  });
  doc.accessors.forEach((a, i) => {
    const view = doc.bufferViews[a.bufferView];
    if (!view) { problems.push(`accessor ${i} cites missing bufferView ${a.bufferView}`); return; }
    const need = a.count * ELEMENTS[a.type]! * COMPONENT_BYTES[a.componentType]!;
    if ((a.byteOffset ?? 0) + need > view.byteLength) problems.push(`accessor ${i} needs ${need} B at ${a.byteOffset ?? 0} in a ${view.byteLength} B bufferView`);
    if (((view.byteOffset ?? 0) + (a.byteOffset ?? 0)) % COMPONENT_BYTES[a.componentType]! !== 0) problems.push(`accessor ${i} is not aligned to its component size`);
  });
}
for (const p of problems) console.error(`self-check: ${p}`);
console.log(`self-check: ${problems.length === 0 ? 'passed' : `${problems.length} problem(s)`} (${glb.accessors.length} accessors, ${glb.bufferViews.length} buffer views)`);
if (problems.length > 0) process.exit(1);
