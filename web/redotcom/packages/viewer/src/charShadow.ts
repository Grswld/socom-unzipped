import {
  Box3, Color, Matrix4, NearestFilter, Object3D, OrthographicCamera, RenderTarget, Scene, Vector3, type Texture,
} from 'three';
import { MeshBasicNodeMaterial, type Node, type WebGPURenderer } from 'three/webgpu';
import { float, normalWorld, positionWorld, select, texture as textureNode, uniform, vec2, vec4 } from 'three/tsl';

/**
 * The characters' shadow as the engine draws it: a render map, not a blob (web/redotcom/docs/research/82, round 4).
 *
 * **Who casts one.** Only the node flagged at `+0xa1` bit 5, and one place sets it: the character spawn (`FUN_00599f00`),
 * when the shadows are on (`DAT_003df138`), the character answers its controller's `+0x2c` query, and the world has no
 * map yet (`+0x56c == 0`) -- the first such character, the local player. Grenades, claymores and the other SEALs cast
 * none.
 *
 * **The map.** `CWorld::AddChild` (`FUN_0031f240`) gives every child flagged for a shadow a `CRenderMap`
 * (`FUN_0031a9a0`, 0x2e0 bytes) drawing into one of the world's four 256x256 targets `ShadowX_%d` (made at the world's
 * init, `FUN_003553a0`). Each frame the map's update (`FUN_0031a180`) takes the actor's bounds, puts its camera at their
 * centre looking down the world root's `ShadowVector` (a look-at on the basis the constructor built from it), sets the
 * far range to 1.5x the bounds' largest side (30 in the constructor, near 1), and fits an orthographic frustum to the
 * eight corners projected into the light's frame, a texel of margin each side (`size - 2`). The actor is drawn into it
 * with VU1 `0x40`: its own triangles, untextured and unfogged (research 15 §3) -- a silhouette, alpha where it covers.
 *
 * **The projection** (VU1 `0x3c`/`0x3e`, disassembled at `0x2b80`; the block `FUN_003b5730` builds per map, 14 qwords):
 * over every visual whose `vparams` carry bit 15, a second pass whose ST is the vertex through the map's matrix (an
 * orthographic projection: the ST is multiplied by the vertex's own Q, so the GS's divide leaves it affine), whose
 * colour is the map's (+0xd8..0xe0; zero) and whose alpha is
 *
 *   `a = W * clamp(dot(-D, N)) * clamp(dot(P - v, N)) * clamp((far - dot(P - v, N)) / (far - near))`
 *
 * with `W` = `ShadowWeight * 255` (0.25 when the root names none -- none of the 22 does -- the world's constructor
 * default at `+0x680`), `D` the shadow vector, `P` the map's camera (the actor's centre) and `N` the surface's normal:
 * a surface facing the light, under the actor, fading out as it lies further below. Modulated by the map's texel and
 * blended source-alpha, black over what is there: the receiver darkens by `a * coverage`, at most 0.5 of it.
 *
 * The viewer renders the SEAL -- the body, its gear and the rifle in its hand -- on a layer of its own into a
 * `RenderTarget` of the same size, and puts the darkening in the world's shading graph (`shadowFactor`) rather than as
 * a second draw of every visual; on an opaque surface the two are the same, `Cd * (1 - a)`.
 */

/** The layer the shadow camera sees: the SEAL's meshes are put on it, and nothing else is. */
export const SHADOW_LAYER = 7;
/** `ShadowX_%d`: 256 by 256 (`FUN_00320310`'s `FUN_003553a0(..., 0x100, 0x100, 2)`). */
export const SHADOW_MAP_SIZE = 256;
/** `CWorld`'s constructor default at `+0x680`, the weight when the root names no `ShadowWeight` (no map does). */
export const SHADOW_WEIGHT = 0.25;
/** The map camera's near plane (`+0xc8`, 1.0 in `FUN_0031a9a0`). */
const NEAR = 1;
/** The GS's unity: `ShadowWeight * 255` is the alpha in 0..128 terms. */
const UNITY = 128;

/** The uniforms every receiver's shading reads (`shadowFactor`), shared by all the world's materials. */
const toLight = uniform(new Matrix4());
const centre = uniform(new Vector3());
const toward = uniform(new Vector3(0, 1, 0));   // -D: the direction a lit surface faces
const far = uniform(30);
const strength = uniform(0);                    // W * 255 / 128, and 0 while there is no shadow to draw
/** The map itself, one for the page: the world's graphs sample it, `CharacterShadow` draws into it. */
const target = new RenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, { samples: 0, depthBuffer: true });
target.texture.minFilter = NearestFilter;
target.texture.magFilter = NearestFilter;

/**
 * The receiver's darkening, 0..1, for the world's graph: `a * coverage` of the header's formula. The normal is the
 * surface's own where the draw carries one and the flat triangle's otherwise (three derives it for a geometry with no
 * normal lane), as the VU reads each vertex's.
 */
export function shadowFactor(map: Texture = target.texture): Node<'float'> {
  const light = toLight.mul(vec4(positionWorld, 1));
  // A render target's texel rows run top-down in three's node textures (WebGPU's convention, kept by the WebGL2 backend).
  const uv = vec2(light.x.mul(0.5).add(0.5), light.y.mul(-0.5).add(0.5));
  const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
  const coverage = select(inside, textureNode(map, uv).a, float(0));
  const n = normalWorld;
  const facing = n.dot(toward).clamp(0, 1);
  const height = centre.sub(positionWorld).dot(n);
  const under = height.clamp(0, 1);
  const fade = far.sub(height).div(far.sub(NEAR)).clamp(0, 1);
  return strength.mul(facing).mul(under).mul(fade).mul(coverage).clamp(0, 1) as unknown as Node<'float'>;
}

/**
 * `FUN_0031a180`'s camera for one actor's bounds: at their centre looking down `direction`, the orthographic frustum
 * fitted to the eight corners in the light's frame with a texel of margin each side (the corners land within
 * `(size - 2) / size` of the edges), the depth range +-1.5x the largest side. Returns that range (the map's far).
 */
export function fitShadowCamera(cam: OrthographicCamera, box: Box3, direction: Vector3): number {
  const mid = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const range = Math.max(size.x, size.y, size.z) * 1.5;          // +0xc4: 1.5 x the largest side
  cam.position.copy(mid);
  const vertical = Math.abs(direction.y) > 0.99;
  cam.up.set(vertical ? 1 : 0, vertical ? 0 : 1, 0);
  cam.lookAt(mid.clone().add(direction));
  cam.updateMatrixWorld(true);
  const view = cam.matrixWorldInverse;
  const corner = new Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(view);
    minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
    minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
  }
  const margin = SHADOW_MAP_SIZE / (SHADOW_MAP_SIZE - 2);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const hx = ((maxX - minX) / 2) * margin, hy = ((maxY - minY) / 2) * margin;
  cam.left = cx - hx; cam.right = cx + hx; cam.bottom = cy - hy; cam.top = cy + hy;
  cam.near = -range; cam.far = range;
  cam.updateProjectionMatrix();
  return range;
}

/**
 * Puts the actor's own meshes on the map's layer and takes everything else under it off: VU1 `0x40` draws the actor's
 * triangles, once. An effect light's overlay (`./effectLights`, `userData.effectLightPass`: the receiver re-drawn in the
 * light's pass, hung beside it) is not the actor's -- drawn into the map it only repeated the silhouette, and at the
 * first blast its own silhouette program linked in the frame (research 90 #23: 47-50 ms on WebGL2).
 */
export function markCasters(actor: Object3D): void {
  actor.traverse((o) => {
    if (o.userData['effectLightPass'] === true) o.layers.disable(SHADOW_LAYER);
    else o.layers.enable(SHADOW_LAYER);
  });
}

/** The strength the receivers' formula scales by: `ShadowWeight * 255` in the GS's 0..128 alpha. */
export function shadowStrength(weight: number): number { return (weight * 255) / UNITY; }

export class CharacterShadow {
  readonly target = target;
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private readonly silhouette = new MeshBasicNodeMaterial();
  private readonly box = new Box3();
  private direction = new Vector3(1, -1, 1).normalize();
  private weight = SHADOW_WEIGHT;

  constructor() {
    this.silhouette.colorNode = vec4(0, 0, 0, 1);   // VU1 0x40: untextured, the actor's own triangles
    this.silhouette.fog = false;
    this.camera.layers.set(SHADOW_LAYER);
  }

  get texture(): Texture { return this.target.texture; }

  /** The map's shadow vector (the world root's `ShadowVector`; the constructor's (1,-1,1) when there is none). */
  setVector(v: readonly [number, number, number] | null, weight = SHADOW_WEIGHT): void {
    this.direction = new Vector3(...(v ?? [1, -1, 1])).normalize();
    if (this.direction.lengthSq() === 0) this.direction.set(1, -1, 1).normalize();
    this.weight = weight;
    toward.value.copy(this.direction).negate();
  }

  /** No actor to shadow this frame (fly mode with the body hidden): the receivers take none. */
  clear(): void { strength.value = 0; }

  /**
   * `FUN_0031a180` for one actor, then its silhouette: the camera on the bounds' centre down the shadow vector, the
   * frustum fitted to the eight corners with a texel's margin, the actor drawn black on its layer into the map.
   */
  update(renderer: WebGPURenderer, scene: Scene, actor: Object3D): void {
    actor.updateMatrixWorld(true);
    this.box.setFromObject(actor, true);
    if (this.box.isEmpty()) { this.clear(); return; }
    markCasters(actor);
    const range = fitShadowCamera(this.camera, this.box, this.direction);
    const cam = this.camera;
    const mid = this.box.getCenter(new Vector3());
    toLight.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    centre.value.copy(mid);
    far.value = range;
    strength.value = shadowStrength(this.weight);

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    const previousBackground = scene.background;
    const previousClear = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    scene.overrideMaterial = this.silhouette;
    scene.background = null;                         // the map starts empty: alpha 0 but where the actor covers it
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setClearColor(previousClear, previousAlpha);
    renderer.setRenderTarget(previousTarget);
    scene.overrideMaterial = previousOverride;
    scene.background = previousBackground;
  }

  /**
   * What compiles the map's programs ahead of the first frame that draws it (research 90 item 17: the silhouette of
   * the SEAL's gear linked 100 ms of programs on entering the walk), for `ViewerRenderer.prepare`: the actor put on
   * the map's layer, the camera fitted to it, the map as the target and the silhouette as the override.
   */
  warmSetup(actor: Object3D): { camera: OrthographicCamera; target: RenderTarget; override: MeshBasicNodeMaterial } {
    actor.updateMatrixWorld(true);
    markCasters(actor);
    this.box.setFromObject(actor, true);
    if (this.box.isEmpty()) this.box.setFromCenterAndSize(actor.getWorldPosition(new Vector3()), new Vector3(1, 1, 1));
    fitShadowCamera(this.camera, this.box, this.direction);
    return { camera: this.camera, target: this.target, override: this.silhouette };
  }

  dispose(): void {
    this.silhouette.dispose();
  }
}
