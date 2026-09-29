import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CustomBlending, DataTexture, Group, InstancedMesh, LessEqualDepth, LinearFilter, Matrix4, Mesh,
  NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, RGBAFormat, Sphere, SrcAlphaFactor, Vector3, ZeroFactor,
  type Object3D,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs, cameraPosition, clamp, cross, dFdx, dFdy, dot, max, min, normalize, positionWorld, select, texture as textureNode,
  uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { lightRange, type ZAnimLight } from '@s2u/scene';
import { effectBrighten } from './effectMaterials';
import type { EffectTexture } from './effectData';

/**
 * The zAnim `LIGHT` command's dynamic light, drawn as the engine draws it (web/docs/research/89 §10): not a light on the
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
 * derivatives), where the VU reads the vertex's; the body (skinned) is not re-drawn.
 */

type Vec3 = [number, number, number];

/** The lights drawn at once (the engine's per-node limit). */
export const MAX_LIGHTS = 6;

interface LivePass {
  light: ZAnimLight;
  /** Where it is, world. */
  at: Vector3;
  t: number;
  alive: () => boolean;
  material: MeshBasicNodeMaterial;
  uniforms: PassUniforms;
  overlays: Mesh[];
}

const passUniforms = (at: Vec3) => ({
  at: uniform(new Vector3(...at)), rMin: uniform(0), rMax: uniform(1), rgb: uniform(new Vector3(1, 1, 1)), opacity: uniform(0.5),
});
type PassUniforms = ReturnType<typeof passUniforms>;

/** A light's reach at its widest over its keys (for choosing what it re-draws). */
export function lightReach(light: Pick<ZAnimLight, 'ranges'>): number {
  return light.ranges.reduce((m, k) => Math.max(m, k[2]), 0);
}

export class EffectLights {
  readonly object = new Group();
  private receivers: () => Object3D[] = () => [];
  private map: DataTexture | null = null;
  private live: LivePass[] = [];
  /** Lights begun, for the hook. */
  started = 0;

  constructor() {
    this.object.name = 'effect lights';
  }

  /** What the lights re-draw: the world's group and the held weapon (their opaque meshes). */
  setReceivers(roots: () => Object3D[]): void {
    this.receivers = roots;
  }

  /** `light_map.tif` off the map's `EFFE_TXR` (null: a spot computed to the same falloff). */
  setTexture(t: EffectTexture | null): void {
    this.clear();
    this.map?.dispose();
    this.map = null;
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
  }

  /** A `LIGHT` command begins at `at` (world); it lives while `alive` answers true, its last key held. */
  begin(light: ZAnimLight, at: Vec3, alive: () => boolean): void {
    if (!this.map) this.setTexture(null);
    while (this.live.length >= MAX_LIGHTS) this.end(this.live[0]!);
    const u = passUniforms(at);
    const material = passMaterial(this.map!, light, u);
    const pass: LivePass = { light, at: new Vector3(...at), t: 0, alive, material, uniforms: u, overlays: [] };
    // What its widest sphere meets.
    const reach = new Sphere(pass.at, lightReach(light));
    for (const root of this.receivers()) {
      root.updateWorldMatrix(true, true);
      root.traverseVisible((o) => {
        const m = o as Mesh;
        if (!m.isMesh || (m as { isSkinnedMesh?: boolean }).isSkinnedMesh || !m.geometry?.getAttribute('position')) return;
        const mat = Array.isArray(m.material) ? m.material[0] : m.material;
        if (mat?.transparent) return;
        const s = boundsOf(m);
        if (s && !s.intersectsSphere(reach)) return;
        const overlay = m instanceof InstancedMesh
          ? new InstancedMesh(m.geometry, material, m.count) : new Mesh(m.geometry, material);
        if (overlay instanceof InstancedMesh) overlay.instanceMatrix = (m as InstancedMesh).instanceMatrix;
        overlay.matrixAutoUpdate = false;
        overlay.matrix.copy(m.matrixWorld);
        overlay.matrixWorld.copy(m.matrixWorld);
        overlay.frustumCulled = false;
        overlay.renderOrder = 10;
        this.object.add(overlay);
        pass.overlays.push(overlay);
      });
    }
    this.live.push(pass);
    this.started++;
    this.step(pass, 0);
  }

  /**
   * The two programs a light pass can take (0x48 and 0x44) on a mesh of the world's vertex layout (position, uv, a
   * four-float colour), for the page to compile at the map's load (`Effects.warmUp`): the first flash then draws at once.
   */
  warmMeshes(): Mesh[] {
    if (!this.map) this.setTexture(null);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(12), 4));
    g.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    return [0x48, 0x44].map((blend) => {
      const light = { flags: 0, node: null, atContext: false, offset: [0, 0, 0], rgb: [255, 255, 255], opacity: 64, blend, ranges: [], duration: 0 } as ZAnimLight;
      const m = new Mesh(g, passMaterial(this.map!, light, passUniforms([0, 0, 0])));
      m.frustumCulled = false;
      return m;
    });
  }

  update(dt: number): void {
    for (const pass of [...this.live]) {
      if (!pass.alive()) { this.end(pass); continue; }
      this.step(pass, dt);
    }
  }

  clear(): void {
    for (const pass of [...this.live]) this.end(pass);
  }

  stats(): { live: number; started: number; overlays: number; ranges: [number, number][] } {
    return {
      live: this.live.length, started: this.started, overlays: this.live.reduce((n, p) => n + p.overlays.length, 0),
      ranges: this.live.map((p) => [p.uniforms.rMin.value as number, p.uniforms.rMax.value as number]),
    };
  }

  private step(pass: LivePass, dt: number): void {
    pass.t += dt;
    const [lo, hi] = lightRange(pass.light, pass.t);
    pass.uniforms.rMin.value = lo;
    pass.uniforms.rMax.value = hi;
    const on = hi > 0;
    for (const o of pass.overlays) o.visible = on;
  }

  private end(pass: LivePass): void {
    for (const o of pass.overlays) this.object.remove(o);
    pass.material.dispose();
    this.live = this.live.filter((p) => p !== pass);
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

/** The pass's material: the VU1 handler's arithmetic per fragment (the header). */
function passMaterial(map: DataTexture, light: ZAnimLight, u: LivePass['uniforms']): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const P = positionWorld;
  // The face's normal, turned to the camera (a surface seen is a surface facing it).
  const flat = normalize(cross(dFdx(P), dFdy(P)));
  const N = select(dot(flat, cameraPosition.sub(P)).lessThan(0), flat.negate(), flat);
  const L = u.at.sub(P);
  const h = max(dot(L, N), 0);
  const rMax = u.rMax, rMin = u.rMin;
  const f = clamp(rMax.sub(h).div(max(rMax.sub(rMin), 1e-4)), 0, 1).mul(0.5);
  const gate = min(h, 1);
  // The surface's own axes: any pair square to N (the spot is round).
  const helper = select(abs(N.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0));
  const T = normalize(cross(helper, N));
  const B = cross(N, T);
  const uv = vec2(dot(L, T), dot(L, B)).div(max(rMax, 1e-4)).add(0.5);
  const texel = textureNode(map, uv);
  // Uniforms, not constants: every light of a blend shares one program (the pre-warm compiles the two).
  u.rgb.value.set(light.rgb[0] / 255, light.rgb[1] / 255, light.rgb[2] / 255);
  u.opacity.value = light.opacity / 128;
  const rgb = u.rgb;
  const cs = min(rgb.mul(f).mul(2), 1).mul(effectBrighten);
  const as = texel.a.mul(u.opacity).mul(f).mul(gate);
  m.colorNode = vec4(cs, clamp(as, 0, 1));
  m.transparent = true;
  m.depthWrite = false;
  m.depthFunc = LessEqualDepth;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -1;
  m.blending = CustomBlending;
  m.blendSrc = SrcAlphaFactor;
  m.blendDst = light.blend === 0x48 ? OneFactor : OneMinusSrcAlphaFactor;
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
