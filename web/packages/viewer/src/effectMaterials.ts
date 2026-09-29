import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Group, Mesh, type Object3D } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform, vec4, vertexColor, materialReference } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GsState } from '@s2u/gs';
import { drawState, materialSpec } from './materialSpec';
import { blendFactorsFor, makeTexture } from './world';
import type { EffectModelData, EffectTexture } from './effectData';

/**
 * The effects' materials, in the world's GS arithmetic (`./world`'s shading, web/docs/research/89 §6): the texel times
 * the vertex colour, clamped (`MODULATE`, then `COLCLAMP`), times the frame's brighten (`1 + FIX/128`, `./lighting`),
 * blended by the texture's own `ALPHA_1` -- `effect_muzzle01.tif` additive, `cloudpuff01.tif` and the casing's
 * `shell_gold.tif` source alpha (its bind packet, `@s2u/gs`'s `GsState`). Blended effects go to three's transparent
 * list and write no depth (three's order, `./materialSpec`'s `drawState`); an opaque one (the casing) writes depth.
 */

/** The frame's brighten, one uniform every effect material reads (the world keeps its own). */
export const effectBrighten = uniform(1);

const texel = materialReference('map', 'texture') as unknown as Node<'vec4'>;
const MODULATED = vec4(texel.mul(vertexColor())).clamp(0, 1);
const SHADED = vec4(MODULATED.rgb.mul(effectBrighten), MODULATED.a);

/** A material for a texture of the effects (or untextured: the vertex colour), with its GS blend. */
export function effectMaterial(texture: EffectTexture | null, options: { cull?: boolean; fog?: boolean; opaque?: boolean } = {}): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const gs: GsState | null = texture?.gs ?? null;
  const spec = materialSpec(
    texture ? { bilinear: gs?.bilinear ?? true, transparent: true, graded: true, opaque: options.opaque ?? false, gs } : undefined,
    options.fog ?? true, true, options.cull ?? false,
  );
  if (texture) m.map = makeTexture(texture.rgba, spec);
  // The destination brighten (`(Cd - 0) As + Cd`: `gen_water_rings.tif`) reads only the source's alpha, which the
  // shader hands on in every channel for the `Cs Cd + Cd` blend (as the world's carrier does, `./world`).
  m.colorNode = !texture ? vec4(vec4(vertexColor()).clamp(0, 1).rgb.mul(effectBrighten), 1)
    : spec.blend === 'destination' ? vec4(MODULATED.a, MODULATED.a, MODULATED.a, MODULATED.a) : SHADED;
  m.vertexColors = false;
  const state = drawState(spec, false);
  m.transparent = state.transparent;
  m.depthWrite = state.depthWrite;
  Object.assign(m, blendFactorsFor(state.factors));
  m.side = options.cull ? FrontSide : DoubleSide;
  m.fog = options.fog ?? true;
  m.toneMapped = false;
  return m;
}

/**
 * A bullet mark's material (`./fire`'s marks, research 89 §5): the bitmap as it is -- the mark carries no vertex colour
 * -- brightened with the frame, blended by its bind packet (source alpha on all six `bullet_mark_*.tif`), no depth
 * write, pulled toward the camera so it does not fight the wall.
 */
export function markMaterial(texture: EffectTexture): MeshBasicNodeMaterial {
  const m = effectMaterial(texture, { fog: true });
  const t = materialReference('map', 'texture') as unknown as Node<'vec4'>;
  m.colorNode = vec4(t.rgb.mul(effectBrighten), t.a);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  return m;
}

/** An effect model as a three group: one mesh a packet, each node's parts under a group named by its path. */
export function buildEffectModel(model: EffectModelData, textures: ReadonlyMap<string, EffectTexture>, cache: Map<string, MeshBasicNodeMaterial>): Group {
  const root = new Group();
  root.name = model.name;
  const nodes = new Map<string, Object3D>([[model.name, root]]);
  /** The group at a path, made with its parents (the effects move `scale` and `rotate` nodes: `node(path)`). */
  const at = (path: string): Object3D => {
    const known = nodes.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const parent = cut < 0 ? root : at(path.slice(0, cut));
    const g = new Group();
    g.name = path.slice(cut + 1);
    parent.add(g);
    nodes.set(path, g);
    return g;
  };
  for (const part of model.parts) {
    const holder = at(part.path.slice(0, part.path.lastIndexOf('/')) || model.name);
    for (const mesh of part.meshes) {
      const name = mesh.textureName?.toLowerCase() ?? null;
      const tex = name ? textures.get(name) ?? null : null;
      const key = `${name}|${mesh.cull}|${mesh.fog}`;
      let material = cache.get(key);
      if (!material) {
        material = effectMaterial(tex, { cull: mesh.cull, fog: mesh.fog, opaque: tex?.gs?.blend === 'source' && isSolid(tex) });
        cache.set(key, material);
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
      g.setAttribute('uv', new BufferAttribute(mesh.uvs, 2));
      g.setAttribute('color', new BufferAttribute(mesh.colors, 4));
      g.setIndex(new BufferAttribute(mesh.indices, 1));
      g.computeBoundingSphere();
      const m = new Mesh(g, material);
      m.name = `${part.node} (${name ?? 'untextured'})`;
      m.frustumCulled = false;
      holder.add(m);
    }
  }
  return root;
}

/** Every texel solid: a texture with no alpha to blend (the casing's gold). */
function isSolid(t: EffectTexture): boolean {
  const a = t.rgba.data;
  for (let i = 3; i < a.length; i += 4) if (a[i]! < 247) return false;
  return true;
}
