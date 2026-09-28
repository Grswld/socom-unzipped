import {
  Bone, BufferAttribute, DoubleSide, FrontSide, Group, Matrix4, Mesh, Skeleton, SkinnedMesh, Uint16BufferAttribute,
  BufferGeometry, type Texture,
} from 'three';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import { materialReference, uniform, vec4, vertexColor } from 'three/tsl';
import type { BodyStats, FittingMesh, LoadedBody } from './body';
import { applyLighting, brightenOf, type Lightable, type Lighting } from './lighting';
import type { LoadedMap } from './loadMap';
import { drawState, materialSpec } from './materialSpec';
import { blendFactorsFor, makeTexture } from './world';

/**
 * The player's body on the page (W2.1): a three `SkinnedMesh` per sub-mesh on one `Skeleton` built from the
 * character's parts, the fittings hung off their bones, the whole stood at slot A (`./body`, `LoadedBody.at`).
 *
 * **Skinned, not CPU-posed.** The palette semantics are settled (web/docs/research/78 §3): the mesh was exported
 * against the bind palette, every bone's own copy of every vertex landing on one point, so one bind-space
 * position per vertex with the bind matrices' inverses as `boneInverses` is exactly the game's weighted sum for
 * any pose -- up to the four-influence cut (`topInfluences`; 1 vertex of seal_A_scuba's 2,094 has five). The
 * bind pose is the identity pose: every bone matrix is the placement itself (`test/body.test.ts`), so the
 * vertices drawn are the decoded ones.
 *
 * **Shaded as the world is** (`./world`): the GS's MODULATE, clamped, times the frame brighten, each texture's
 * own state from its bind packet (`materialSpec`). The vertex colour is `record2 * lit`, the rig of the map's
 * `GlobalLighting` (`./lighting`) on a unity material: the character's colour lane is a constant the EE
 * uploads (data quadword 338, research 15 §4.4), not on the disc -- read as unity, the value every fitting vertex
 * stores (78 §5.1) -- and lit, as a unity material only makes sense lit. Both are named placeholders (78 §6.2).
 */

export interface BodyView {
  group: Group;
  /** What `stats().body` reports for the controller's pose check. */
  stats: BodyStats & {
    character: string | null; model: string; dressedBy: string; fittingNames: string[]; missing: string[];
    height: number; eye: number | null; at: [number, number, number] | null; yaw: number | null;
  };
  setVisible(on: boolean): void;
  setLighting(light: Lighting): void;
  dispose(): void;
}

/**
 * `CLIB_GEO.ZED` `vparams` word 0 bit 3, the visual's backface cull (`VISUAL_FLAG_CULL`): set on every `CMesh` and
 * `CSubMesh` visual of the 411 characters (78 §2.5), and the winding is CCW-front as on the map (78 §2.3). A gear
 * mesh carries its own visual's bit (`FittingMesh.cull`).
 */
const CULL = true;
/** 78 §6.2: the character's colour lane, a placeholder for the EE's quadword 338: the PS2's unity, 128. */
const UNITY = 1;

export function buildBody(body: LoadedBody, map: Pick<LoadedMap, 'textures' | 'textureFlags'>, lighting: Lighting): BodyView {
  const group = new Group();
  group.name = `body ${body.model}`;
  group.visible = false;                        // off by default in W2.1: the play mode switches it (W2.R1)

  // The skeleton: one bone per part, its local matrix the part's `nparams` (row-major row-vector storage is
  // three's column-major storage, `toColumnMajor` in @s2u/scene), and the bind matrices' inverses.
  const bones = body.parts.map((p) => {
    const bone = new Bone();
    bone.name = p.name;
    new Matrix4().fromArray(p.bindLocal).decompose(bone.position, bone.quaternion, bone.scale);
    return bone;
  });
  body.parts.forEach((p, i) => (p.parent < 0 ? group : bones[p.parent]!).add(bones[i]!));
  const skeleton = new Skeleton(bones, body.parts.map((p) => new Matrix4().fromArray(p.bindWorld).invert()));

  const brighten = uniform(brightenOf(lighting));
  const texel = materialReference('map', 'texture') as unknown as Node<'vec4'>;
  const modulated = vec4(texel.mul(vertexColor())).clamp(0, 1);
  const shaded = vec4(modulated.rgb.mul(brighten), modulated.a);
  const plain = vec4(vertexColor()).clamp(0, 1);
  const shadedPlain = vec4(plain.rgb.mul(brighten), plain.a);

  const textures = new Map<string, Texture>();
  const materials = new Map<string, MeshBasicNodeMaterial>();
  const materialFor = (name: string | null, fog: boolean, cull: boolean): MeshBasicNodeMaterial => {
    const key = `${name ?? ''}|${fog ? 1 : 0}|${cull ? 1 : 0}`;
    const cached = materials.get(key);
    if (cached) return cached;
    const flags = name === null ? undefined : map.textureFlags[name];
    const spec = materialSpec(flags, fog, true, cull);
    const rgba = name === null ? undefined : map.textures[name];
    let texture = name === null ? undefined : textures.get(name);
    if (!texture && name !== null && rgba) textures.set(name, texture = makeTexture(rgba, spec));
    const state = drawState(spec, false);
    const material = new MeshBasicNodeMaterial();
    material.name = `body ${name ?? 'untextured'}`;
    material.map = texture ?? null;
    material.vertexColors = false;              // the graph reads the attribute itself, as the world's does
    material.colorNode = texture ? shaded : shadedPlain;
    material.transparent = state.transparent;
    material.depthWrite = state.depthWrite;
    Object.assign(material, blendFactorsFor(state.factors));
    material.alphaTest = spec.alphaTest;
    material.side = spec.cull ? FrontSide : DoubleSide;
    material.fog = spec.fog;
    materials.set(key, material);
    return material;
  };

  /** Every lit part beside its colour buffer and the rotation its normals are lit through. */
  const lit: { part: Lightable; attribute: BufferAttribute }[] = [];
  const colour = (count: number, normals: Float32Array, turn: Matrix4, material: Float32Array | null): BufferAttribute => {
    const part: Lightable = { colors: material ?? new Float32Array(count * 4).fill(UNITY), normals: turnNormals(normals, turn), lit: true };
    const out = new Float32Array(count * 4);
    applyLighting(part, lighting, out);
    const attribute = new BufferAttribute(out, 4);
    lit.push({ part, attribute });
    return attribute;
  };

  // The rig's directions are the world's, so a normal is lit where the placement turns it.
  const yaw = body.at?.yaw ?? 0;
  const placementTurn = new Matrix4().makeRotationY(yaw);
  for (const sub of body.subMeshes) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(sub.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(sub.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(sub.uvs, 2));
    geometry.setAttribute('color', colour(sub.positions.length / 3, sub.normals, placementTurn, null));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(sub.skinIndex, 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(sub.skinWeight, 4));
    geometry.setIndex(new BufferAttribute(sub.indices, 1));
    const mesh = new SkinnedMesh(geometry, materialFor(sub.textureName, sub.fog, CULL));
    mesh.name = `${body.model} ${sub.textureName ?? 'untextured'}`;
    mesh.frustumCulled = false;                 // one small body; its bind-pose bounds would not follow a pose
    group.add(mesh);
    mesh.bind(skeleton, new Matrix4());         // bound at the model origin: the bind pose is the identity pose
  }

  // The fittings hang off their parts under `offset` (78 §5), so they follow the bone when a motion moves it.
  for (const fitting of body.fittings) {
    const holder = new Group();
    holder.name = fitting.name;
    new Matrix4().fromArray(fitting.offset).decompose(holder.position, holder.quaternion, holder.scale);
    bones[fitting.part]!.add(holder);
    const turn = placementTurn.clone().multiply(new Matrix4().fromArray(body.parts[fitting.part]!.bindWorld))
      .multiply(new Matrix4().fromArray(fitting.offset));
    for (const m of fitting.meshes) {
      const mesh = new Mesh(fittingGeometry(m, colour(m.positions.length / 3, m.normals ?? new Float32Array(m.positions.length), turn, m.colors)),
        materialFor(m.textureName, m.fog, m.cull));
      mesh.name = `${fitting.name} ${m.textureName ?? 'untextured'}`;
      holder.add(mesh);
    }
  }

  if (body.at) {
    group.position.set(...body.at.position);
    group.rotation.y = body.at.yaw;
  }

  return {
    group,
    stats: {
      ...body.stats, character: body.character, model: body.model, dressedBy: body.dressedBy,
      fittingNames: body.fittings.map((f) => f.name), missing: body.missing, height: body.height, eye: body.eye,
      at: body.at ? [...body.at.position] : null, yaw: body.at?.yaw ?? null,
    },
    setVisible: (on) => { group.visible = on; },
    setLighting: (next) => {
      brighten.value = brightenOf(next);
      for (const l of lit) {
        applyLighting(l.part, next, l.attribute.array as Float32Array);
        l.attribute.needsUpdate = true;
      }
    },
    dispose: () => {
      group.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose(); });
      for (const m of materials.values()) m.dispose();
      for (const t of textures.values()) t.dispose();
      skeleton.dispose();
    },
  };
}

/** A fitting's geometry: its own positions and uvs, and the lit colour. */
function fittingGeometry(m: FittingMesh, color: BufferAttribute): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(m.positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2));
  geometry.setAttribute('color', color);
  geometry.setIndex(new BufferAttribute(m.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Normals through a matrix's 3x3 (column-major, as three stores it), renormalised; a zero normal stays zero. */
function turnNormals(normals: Float32Array, m: Matrix4): Float32Array {
  const e = m.elements;
  const out = new Float32Array(normals.length);
  for (let i = 0; i < out.length; i += 3) {
    const x = normals[i]!, y = normals[i + 1]!, z = normals[i + 2]!;
    const nx = x * e[0]! + y * e[4]! + z * e[8]!, ny = x * e[1]! + y * e[5]! + z * e[9]!, nz = x * e[2]! + y * e[6]! + z * e[10]!;
    const len = Math.hypot(nx, ny, nz);
    const k = len > 1e-6 ? 1 / len : 0;
    out[i] = nx * k; out[i + 1] = ny * k; out[i + 2] = nz * k;
  }
  return out;
}
