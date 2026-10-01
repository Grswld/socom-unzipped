import {
  ClampToEdgeWrapping, CustomBlending, DataTexture, Group, InstancedMesh, SkinnedMesh, LessEqualDepth, LinearFilter, Matrix4, Mesh,
  NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, RGBAFormat, Sphere, SrcAlphaFactor, Vector3, ZeroFactor,
  type Object3D,
} from 'three';
import { MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  abs, cameraPosition, clamp, cross, dFdx, dFdy, dot, max, min, normalize, positionWorld, select, texture as textureNode,
  float, renderGroup, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { lightRange, type ZAnimLight } from '@s2u/scene';
import { effectBrighten } from './effectMaterials';
import type { EffectTexture } from './effectData';

/**
 * The zAnim `LIGHT` command's dynamic light, drawn as the engine draws it (web/redotcom/docs/research/89 §10): not a light on the
 * vertex colours but **a second pass of every lit visual in its reach** -- `FUN_00339660` gives a node the world's
 * lights whose sphere meets its own (at most six), `FUN_003b5b90` emits VU1 command 0x3a once a light, and the VU1
 * handler at 0x23d8 re-draws the node's triangles with `light_map.tif` (`EFFE_TXR`, a white spot, alpha 0.94 at its
 * centre to 0 at its rim) projected on the surface:
 *
 * - `L = light − P`, `h = max(L·N, 0)`, the falloff `f = 0.5 clamp((max − h)/(max − min))`, the gate `min(h, 1)`;
 * - the spot's uv `0.5 + (L·T, L·B)/max` on the surface's own axes: a spot `max/2` in radius under the light;
 * - `MODULATE` against the white texel: `Cs = min(1, 2 rgb/255 f)`, `As = At · opacity f gate / 128`;
 * - blended by the light's ALPHA: 0x48 (the explosions) `dst += Cs As`, 0x44 (the muzzles) `dst = lerp(dst, Cs, As)`.
 *
 * The surface's own texture and baked colour never enter it. The viewer draws the pass as overlays sharing the lit
 * world's own geometry and matrices (`setReceivers`), depth-tested equal-or-nearer, writing no depth. Readings: every
 * opaque mesh of the world and the held weapon takes it (the game's gate is the visual flags 0x4000 and 0x10, 140 of
 * MP2's 177 visuals, which the viewer's merged meshes no longer carry); the normal is the face's own (the screen
 * derivatives), where the VU reads the vertex's. The SEAL's skinned body is re-drawn on its own skeleton.
 */

type Vec3 = [number, number, number];

/** The lights drawn at once (the engine's per-node limit). */
export const MAX_LIGHTS = 6;

/**
 * A uniform of the render's shared group: one buffer for every overlay, set once a render -- not TSL's default object
 * group, a buffer an overlay, which the pre-warm paid for over 1,200 overlays.
 */
const shared = <U extends { setGroup(g: typeof renderGroup): unknown }>(u: U): U => { u.setGroup(renderGroup); return u; };

/**
 * One light's uniforms: where it is, its range now, its colour and opacity, and whether it adds (0x48: 1) or lerps
 * (0x44: 0). A slot without a light has a range of 0, which draws nothing.
 */
const lightUniforms = () => ({
  at: shared(uniform(new Vector3())), rMin: shared(uniform(0)), rMax: shared(uniform(0)), rgb: shared(uniform(new Vector3(1, 1, 1))),
  opacity: shared(uniform(0)), adds: shared(uniform(1)),
});
type LightUniforms = ReturnType<typeof lightUniforms>;

interface LivePass {
  light: ZAnimLight;
  /** Where it is, world. */
  at: Vector3;
  t: number;
  alive: () => boolean;
  /** Its uniforms' slot. */
  slot: number;
  /** The receiver meshes its widest sphere meets. */
  reach: Mesh[];
  /** Its range is open now. */
  on: boolean;
}

/** An overlay pair: the receiver re-drawn in the additive pass and in the lerped one. */
interface Pair { add: Mesh; mix: Mesh }

/** A light's reach at its widest over its keys (for choosing what it re-draws). */
export function lightReach(light: Pick<ZAnimLight, 'ranges'>): number {
  return light.ranges.reduce((m, k) => Math.max(m, k[2]), 0);
}

/**
 * An overlay re-drawing `m` with `material`, hidden: the same geometry (a skinned body on its own skeleton, so the pass
 * bends with the pose; an instanced mesh on its instances).
 */
function overlayOf(m: Mesh, material: MeshBasicNodeMaterial): Mesh {
  let overlay: Mesh;
  if (m instanceof SkinnedMesh) {
    const sk = new SkinnedMesh(m.geometry, material);
    sk.bind(m.skeleton, m.bindMatrix);
    sk.bindMode = m.bindMode;
    overlay = sk;
  } else if (m instanceof InstancedMesh) {
    const im = new InstancedMesh(m.geometry, material, m.count);
    im.instanceMatrix = m.instanceMatrix;
    overlay = im;
  } else overlay = new Mesh(m.geometry, material);
  overlay.userData.effectLightPass = true;
  overlay.frustumCulled = false;
  overlay.renderOrder = 10;
  overlay.visible = false;
  return overlay;
}

/**
 * The lights' passes, pooled (research 90 item 19: a new material and ~170 new overlays a blast cost a 300-850 ms
 * frame, every blast). The six lights' uniforms are fixed slots; two materials a map -- the additive pass and the
 * lerped one -- each sum every slot of their blend in one draw; a receiver mesh gets its two overlays once, at the map's
 * pre-warm (or the first light to reach a mesh made later) and keeps them. A light then sets uniforms and shows the
 * overlays in its reach: no program, no object is made during play.
 */
export class EffectLights {
  readonly object = new Group();
  private receivers: () => Object3D[] = () => [];
  private map: DataTexture | null = null;
  private readonly slots: LightUniforms[] = Array.from({ length: MAX_LIGHTS }, lightUniforms);
  private materials: { add: MeshBasicNodeMaterial; mix: MeshBasicNodeMaterial } | null = null;
  private pairs = new Map<Mesh, Pair>();
  private live: LivePass[] = [];
  /** The overlays shown now (by the lights, or by the pre-warm). */
  private shown = new Set<Mesh>();
  private warming = false;
  /** Lights begun, for the hook. */
  started = 0;

  constructor() {
    this.object.name = 'effect lights';
  }

  /** What the lights re-draw: the world's group, the held weapon, the SEAL's body (their opaque meshes). */
  setReceivers(roots: () => Object3D[]): void {
    this.receivers = roots;
  }

  /** `light_map.tif` off the map's `EFFE_TXR` (null: a spot computed to the same falloff); the materials made anew. */
  setTexture(t: EffectTexture | null): void {
    this.clear();
    for (const { add, mix } of this.pairs.values()) { add.removeFromParent(); mix.removeFromParent(); }
    this.pairs.clear();
    this.shown.clear();
    this.materials?.add.dispose();
    this.materials?.mix.dispose();
    this.map?.dispose();
    const rgba = t?.rgba ?? spot();
    const tex = new DataTexture(new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length), rgba.width, rgba.height, RGBAFormat);
    tex.colorSpace = NoColorSpace;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.map = tex;
    this.materials = { add: passMaterial(tex, true, this.slots), mix: passMaterial(tex, false, this.slots) };
  }

  /** The receivers' opaque meshes, each once (the held weapon hangs in the body); with `hidden`, the hidden ones too. */
  private receiverMeshes(hidden = false): Mesh[] {
    const out: Mesh[] = [];
    const seen = new Set<Object3D>();
    for (const root of this.receivers()) {
      root.updateWorldMatrix(true, true);
      (hidden ? root.traverse : root.traverseVisible).call(root, (o) => {
        const m = o as Mesh;
        if (seen.has(m) || !m.isMesh || !m.parent || !m.geometry?.getAttribute('position') || m.userData.effectLightPass) return;
        seen.add(m);
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        if (!mat?.transparent) out.push(m);
      });
    }
    return out;
  }

  /**
   * `m`'s overlays, made once and kept beside it -- the same parent and place, so they walk with the SEAL and turn with
   * the rifle (the characters take the lights as the world does: research 89 §10).
   */
  private pair(m: Mesh): Pair {
    let p = this.pairs.get(m);
    if (!p) {
      p = { add: overlayOf(m, this.materials!.add), mix: overlayOf(m, this.materials!.mix) };
      this.pairs.set(m, p);
    }
    for (const o of [p.add, p.mix]) {
      if (o.parent !== m.parent) m.parent?.add(o);
      o.position.copy(m.position);
      o.quaternion.copy(m.quaternion);
      o.scale.copy(m.scale);
      o.matrixAutoUpdate = m.matrixAutoUpdate;
      if (!m.matrixAutoUpdate) o.matrix.copy(m.matrix);
    }
    return p;
  }

  /**
   * The pre-warm (`Effects.warmUp`, compiled with the scene by `ViewerRenderer.warm`): every receiver's overlays made
   * now and shown for the call where the receiver's parents are shown (a LOD copy out of range hides itself alone; the
   * renderer's stand-ins take the rest). With no light every slot's range is 0, so the call's frames look the same.
   * `warmDone` hides them.
   */
  warmMeshes(): void {
    if (!this.materials) this.setTexture(null);
    this.warming = true;
    for (const m of this.receiverMeshes(true)) {
      const p = this.pair(m);
      let shown = true;
      for (let o: Object3D | null = m.parent; o; o = o.parent) if (!o.visible) { shown = false; break; }
      if (!shown) continue;
      for (const o of [p.add, p.mix]) { o.visible = true; this.shown.add(o); }
    }
  }

  /**
   * The compile call has taken its list (the renderer's projection is synchronous): the overlays leave the scene, so
   * no frame drawn while the programs build draws one -- a frame that did built them itself, synchronously (MP6: a
   * 1.7 s frame). A light puts back the ones it reaches (`pair`).
   */
  warmHide(): void {
    for (const { add, mix } of this.pairs.values()) { add.visible = false; mix.visible = false; add.removeFromParent(); mix.removeFromParent(); }
    this.shown.clear();
  }

  /** The pre-warm is over: the overlays show only where a light is. */
  warmDone(): void {
    this.warming = false;
    for (const pass of this.live) for (const m of pass.reach) this.pair(m);
    this.refresh();
  }

  /** A `LIGHT` command begins at `at` (world); it lives while `alive` answers true, its last key held. */
  begin(light: ZAnimLight, at: Vec3, alive: () => boolean): void {
    if (!this.materials) this.setTexture(null);
    if (this.live.length >= MAX_LIGHTS) this.end(this.live[0]!, false);
    const used = new Set(this.live.map((p) => p.slot));
    const slot = this.slots.findIndex((_, i) => !used.has(i));
    const u = this.slots[slot]!;
    u.at.value.set(...at);
    u.rgb.value.set(light.rgb[0] / 255, light.rgb[1] / 255, light.rgb[2] / 255);
    u.opacity.value = light.opacity / 128;
    u.adds.value = light.blend === 0x48 ? 1 : 0;
    // What its widest sphere meets (a skinned body always: its bounds do not follow the pose).
    const sphere = new Sphere(new Vector3(...at), lightReach(light));
    const reach = this.receiverMeshes().filter((m) => {
      const s = m instanceof SkinnedMesh ? null : boundsOf(m);
      return !s || s.intersectsSphere(sphere);
    });
    const pass: LivePass = { light, at: sphere.center, t: 0, alive, slot, reach, on: false };
    for (const m of reach) this.pair(m);
    this.live.push(pass);
    this.started++;
    this.step(pass, 0);
    this.refresh();
  }

  update(dt: number): void {
    if (this.live.length === 0) return;
    for (const pass of [...this.live]) {
      if (!pass.alive()) { this.end(pass, false); continue; }
      this.step(pass, dt);
    }
    this.refresh();
  }

  clear(): void {
    for (const pass of [...this.live]) this.end(pass, false);
    this.refresh();
  }

  stats(): { live: number; started: number; overlays: number; pooled: number; ranges: [number, number][] } {
    return {
      live: this.live.length, started: this.started, overlays: this.warming ? 0 : this.shown.size, pooled: this.pairs.size * 2,
      ranges: this.live.map((p) => [this.slots[p.slot]!.rMin.value as number, this.slots[p.slot]!.rMax.value as number]),
    };
  }

  private step(pass: LivePass, dt: number): void {
    pass.t += dt;
    const [lo, hi] = lightRange(pass.light, pass.t);
    const u = this.slots[pass.slot]!;
    u.rMin.value = lo;
    u.rMax.value = hi;
    pass.on = hi > 0;
  }

  /** The overlays shown: those of an open light's reach, in its blend's pass. */
  private refresh(): void {
    if (this.warming) return;
    const want = new Set<Mesh>();
    for (const pass of this.live) {
      if (!pass.on) continue;
      const add = pass.light.blend === 0x48;
      for (const m of pass.reach) { const p = this.pairs.get(m); if (p) want.add(add ? p.add : p.mix); }
    }
    for (const o of this.shown) if (!want.has(o)) o.visible = false;
    for (const o of want) o.visible = true;
    this.shown = want;
  }

  private end(pass: LivePass, refresh = true): void {
    const u = this.slots[pass.slot]!;
    u.rMin.value = 0;
    u.rMax.value = 0;
    u.opacity.value = 0;
    this.live = this.live.filter((p) => p !== pass);
    if (refresh) this.refresh();
  }
}

/** A mesh's bounding sphere in the world, or null when it has none. */
function boundsOf(m: Mesh): Sphere | null {
  if (m instanceof InstancedMesh) {
    if (!m.boundingSphere) m.computeBoundingSphere();
    return m.boundingSphere ? m.boundingSphere.clone().applyMatrix4(m.matrixWorld) : null;
  }
  if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
  return m.geometry.boundingSphere ? m.geometry.boundingSphere.clone().applyMatrix4(m.matrixWorld) : null;
}

/**
 * A pass's material: the VU1 handler's arithmetic per fragment (the header) for every light slot of its blend, in one
 * draw. The additive pass sums `Cs As` over its lights; the lerped one folds its lights in turn,
 * `C = C (1 − As) + Cs As`, `keep = keep (1 − As)`. Either goes out as the colour `C / A` at the alpha `A` (the
 * additive's `A = min(ΣAs, 1)`, the lerped's `1 − keep`) under `SrcAlpha`: one light is the old single pass exactly.
 */
function passMaterial(map: DataTexture, additive: boolean, lights: readonly LightUniforms[]): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const P = positionWorld;
  // The face's normal, turned to the camera (a surface seen is a surface facing it).
  const flat = normalize(cross(dFdx(P), dFdy(P)));
  const N = select(dot(flat, cameraPosition.sub(P)).lessThan(0), flat.negate(), flat);
  // The surface's own axes: any pair square to N (the spot is round).
  const helper = select(abs(N.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
  const T = normalize(cross(helper, N));
  const B = cross(N, T);
  let colour: Node<'vec3'> = vec3(0, 0, 0);
  let alpha: Node<'float'> = float(0);
  let keep: Node<'float'> = float(1);
  for (const u of lights) {
    const L = u.at.sub(P);
    const h = max(dot(L, N), 0);
    const f = clamp(u.rMax.sub(h).div(max(u.rMax.sub(u.rMin), 1e-4)), 0, 1).mul(0.5);
    const gate = min(h, 1);
    const uv = vec2(dot(L, T), dot(L, B)).div(max(u.rMax, 1e-4)).add(0.5);
    const texel = textureNode(map, uv).level(float(0));   // no mips: a plain fetch, no derivatives (a cheaper program)
    const cs = min(u.rgb.mul(f).mul(2), 1).mul(effectBrighten);
    const mine = additive ? u.adds : float(1).sub(u.adds);
    const as = clamp(texel.a.mul(u.opacity).mul(f).mul(gate).mul(mine), 0, 1);
    if (additive) {
      colour = colour.add(cs.mul(as));
      alpha = alpha.add(as);
    } else {
      colour = colour.mul(float(1).sub(as)).add(cs.mul(as));
      keep = keep.mul(float(1).sub(as));
    }
  }
  const a = additive ? min(alpha, 1) : float(1).sub(keep);
  m.colorNode = vec4(colour.div(max(a, 1e-4)), a);
  m.transparent = true;
  m.depthWrite = false;
  m.depthFunc = LessEqualDepth;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  m.blending = CustomBlending;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = additive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = ZeroFactor;
  m.blendDstAlpha = OneFactor;
  m.fog = true;
  m.toneMapped = false;
  return m;
}

/** `light_map.tif`'s spot when the library lacks it: alpha `0.94 (1 − smoothstep(0, 0.5, r))`, white. */
function spot(): { width: number; height: number; data: Uint8ClampedArray } {
  const n = 64, data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5);
      const k = Math.min(1, r / 0.5), s = k * k * (3 - 2 * k);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * 0.94 * (1 - s));
    }
  }
  return { width: n, height: n, data };
}

/** The world's matrix a light sits at, as a point. */
export function pointOf(m: Matrix4 | null): Vec3 | null {
  return m ? [m.elements[12]!, m.elements[13]!, m.elements[14]!] : null;
}
