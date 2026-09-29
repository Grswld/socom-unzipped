import {
  Box3, BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CustomBlending, DataTexture, DoubleSide, DstColorFactor,
  FrontSide, Group, type Object3D, InstancedMesh, LessEqualDepth, LinearFilter, LinearMipmapLinearFilter, LineSegments, Matrix4, Mesh,
  NearestFilter, NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, RGBAFormat, RepeatWrapping, SrcAlphaFactor,
  Texture, Vector2, Vector3, ZeroFactor,
} from 'three';
import type { Blending, BlendingDstFactor, BlendingSrcFactor, Camera } from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import {
  cameraPosition, float, log2, materialReference, normalWorld, positionView, positionWorld, select, texture as textureNode, uniform, uv, varying, vec3,
  vec4, vertexColor,
} from 'three/tsl';
import { buildGrid, cellAt, lodIsLast, lodOpacity, lodVisible, type LodBand } from '@s2u/scene';
import {
  detailDrawState, detailRenderOrder, drawState, gsMipLod, materialSpec, mipChain, type GsMipLod,
  type DetailSpec, type DrawState, type Factor, type MaterialSpec, type TextureFlags,
} from './materialSpec';
import { engineOrder } from './engineOrder';
import { shadowFactor } from './charShadow';
import { nightLit } from './nightVision';
import { fadeMaterial, fadePhase } from './lodFade';
import type { Rgba } from '@s2u/gs';
import { applyLighting, brightenOf, DEFAULT_LIGHTING, type Lightable, type Lighting } from './lighting';
import type { LoadedMap, LoadedMesh } from './loadMap';

/**
 * `gs` decodes a texture's rows bottom-up, which is also what GL calls V = 0, so the data goes to the GPU
 * as it comes out of the decoder and the UVs go up unchanged. `DataTexture` defaults to this; the constant
 * is here so the one thing to change, if a screenshot ever comes out mirrored top to bottom, is visible.
 */
const FLIP_Y = false;

/** A drawn map: the placed group, what it cost, and the extent the camera can frame. */
export interface WorldView {
  /**
   * The group, **empty** when `buildWorld` returns. Every drawn object is waiting in one of the two
   * reveal queues below, because the expensive part of showing a map is not building it -- it is the
   * first frame that draws it, when three uploads each texture and geometry and compiles each program.
   */
  group: Group;
  /** The world's own meshes, one task each. What the first paint of a new map waits for. */
  revealWorld: (() => void)[];
  /** The props, the flares and the line strips. These arrive behind the world, over further frames. */
  revealProps: (() => void)[];
  /**
   * The objects `revealWorld` and `revealProps` add, in their order: what the page compiles off-screen before each
   * reveal (`ViewerRenderer.prepare`), so no program is linked by the draw that first meets it.
   */
  worldObjects: Object3D[];
  propObjects: Object3D[];
  triangles: number;
  /** The extent of everything queued, accumulated as it was built rather than read off the group. */
  box: Box3;
  /** How many of the group's draws are drawing without a texture: the highlight's subject, counted. */
  untextured: number;
  /** How many draws are drop shadows, and how many are alternate states -- what the two toggles govern. */
  shadowDraws: number;
  alternateDraws: number;
  /** How many draws carry a detail pass (`setDetail`): what `tools/map-health.ts` lists per map. */
  detailDraws: number;
  /** Every material at once, for seeing the topology through the skin. */
  setWireframe(on: boolean): void;
  /**
   * Paints the meshes that are drawing without a texture magenta -- the ones whose name was not in the
   * map's `TXR` archive, and the ones whose packets cited no name at all. Both are invisible faults
   * otherwise: an untextured mesh in vertex colour alone looks like dim geometry, not like a diagnostic.
   */
  setUntexturedHighlight(on: boolean): void;
  /**
   * Whether a texture whose alpha is a *ramp* is blended with the equation its bind packet asks for
   * rather than punched out at a threshold (`./materialSpec`). On by default; off restores the cutout,
   * which sorts perfectly and looks wrong.
   */
  setBlendGraded(on: boolean): void;
  /**
   * The engine's draw order (W1.2), or three's. On, every draw goes out in the order `CPipe::RenderWorld`
   * issues it -- the grid walked ring by ring outward from the camera's cell, the drop shadows after the
   * last ring (`./engineOrder`) -- as its `renderOrder`, in the opaque list, writing depth under every
   * blend as the console did (research 26 section 2; `drawState` in `./materialSpec`). The order is
   * recomputed when the camera crosses into another cell, not every frame. Off, blended draws go to
   * three's back-to-front sort with no depth written. **Off by default** until the sweep and the poses
   * clear it (W1.R3). The LOD fade twins stay in the transparent list either way (W1.3, `./lodFade`),
   * and a detail pass is drawn right after its base in either (`detailRenderOrder`).
   */
  setEngineOrder(on: boolean): void;
  /**
   * The drop shadows: the quads under props and the baked shadow patches on the ground, every draw
   * whose texture is a `shadow*.tif`. Drawn as the engine's decal pass draws them -- source alpha,
   * no depth written, after the world, nudged off the ground by a polygon offset -- whatever the
   * draw-order mode. On by default.
   */
  setShadows(on: boolean): void;
  /**
   * The alternate states (`LoadedMesh.alternate`): a destructible's remains and debris, a lamp's
   * unlit copy, the far LOD copies. Hidden by default, because drawn over the state the map opens in
   * they z-fight with it; on shows what else the graph holds.
   */
  setAlternate(on: boolean): void;
  /**
   * Whether the GS `LINE_STRIP` geometry is drawn (SEMANTICS section 12). On by default: a strip is
   * drawn one pixel wide with the packet's texture running along it, which is what the hardware did.
   */
  setLineStrips(on: boolean): void;
  /**
   * The detail pass (W1.6): a second draw over every surface whose texture's `mp<N>_lib.rdr` entry
   * carries a `detail` record -- the detail texture at `uv` times the surface's own, blended by the
   * record's `bmode`, fading out over its range, drawn after its base without writing depth
   * (`./materialSpec`, `DetailSpec`). The console's grain on the ground close up. On by default.
   */
  setDetail(on: boolean): void;
  /**
   * The per-frame work, called once a frame before the render: turns the facades to the camera,
   * picks each LOD pair's copy by range, advances the scrolling textures, and -- with the engine order
   * on -- walks the grid again when the camera has crossed into another cell (`setEngineOrder`).
   *
   * A flare on disc is a single quad on a single plane -- `lightcage`'s `lightrays.tif` node is 4
   * vertices and 2 triangles, normal (0, 0.96, -0.24) -- so a fixed quad that nearly faces the sky is
   * edge-on from a standing player. The engine turns the nodes flagged `m_facade` (`facadeOf`); so
   * does this. `CVisual::DrawLOD` scales a LOD copy's opacity by the camera's range across its fades,
   * so a pair crosses over rather than switching; so does this (`lodOpacity`, `./lodFade`). A
   * `TextureScroll_Object` band adds its `du, dv` to a node's uvs; so does
   * this, at `SCROLL_TICKS_PER_SECOND` steps a second (1: the step is per second, see the constant).
   */
  frame(camera: Camera, dt: number): void;
  /**
   * DOORS (`./doors`): moves every prop placement at or under the scene node `path` (its own path, or one starting
   * `path/` or `path=`) by `delta`, a column-major 4x4 applied after the placement's own matrix from the disc -- the
   * door leaf's swing. The identity puts them back. Returns how many placements it moved.
   */
  moveNode(path: string, delta: ArrayLike<number>): number;
  /** Whether the flares are turned at all, for seeing the pose the disc actually holds. */
  setBillboards(on: boolean): void;
  /** Where the flares are, in world space -- for aiming a camera at one. */
  flarePositions(): [number, number, number][];
  /** Each line-strip group's texture and world-space extent -- for aiming a camera at a rope. */
  lineGroups(): { texture: string | null; min: [number, number, number]; max: [number, number, number] }[];
  /**
   * The lighting. The brighten is a uniform on every material and costs nothing to move; a change of
   * rig, or of whether the rig is applied everywhere, re-runs the VU's lighting over every vertex
   * (`record2 * lit`, see `./lighting`), about a millisecond on the largest map.
   */
  setLighting(light: Lighting): void;
  /**
   * The held weapon (W2.4, `LoadedMap.weapon`), in its own frame and outside `group`: `./shot` puts it at the fire
   * point every frame. Drawn with the world's own materials, so the same GS path shades it. Null when the map
   * decoded none.
   */
  weapon: Group | null;
  /** WEAPON: the sidearm (`LoadedMap.sidearm`, the kit's Mark 23), built as the weapon is; `./play` hangs it. */
  sidearm: Group | null;
  /**
   * The throwables' models by model name (`grenade`, `HEgrenade`; `LoadedMap.grenade`), built as the weapon is, outside
   * `group`: `./grenade` clones them for the hand and for each grenade in flight. Empty when the map decoded none.
   */
  grenades: Record<string, Group>;
  dispose(): void;
  /**
   * What `ViewerRenderer.warm` should compile besides the scene: a stand-in mesh per LOD copy's fading twin, made now
   * rather than on the first fade (`fadeTo`), so a copy crossing its band does not pay a compile in that frame.
   */
  warmExtras(): Object3D[];
}

/** The two material kinds the world is drawn with, which share every property this file sets. */
type Basic = MeshBasicNodeMaterial | LineBasicNodeMaterial;
/** A TSL node that yields a colour: what `colorNode` takes. */
type ColorNode = NonNullable<MeshBasicNodeMaterial['colorNode']>;

/** A material together with what it was built from, so a switch can rebuild it from the disc's state. */
interface Built {
  material: Basic;
  flags: TextureFlags | undefined;
  fog: boolean;
  textured: boolean;
  cull: boolean;
  /** A `shadow*.tif`: drawn as a decal, see `setShadows`. */
  shadow: boolean;
  /** A scrolling texture's own shading graph, which `apply` must keep rather than replace. */
  scrollNode: ColorNode | null;
  /** Takes the characters' shadow (`./charShadow`): the world and its props; not the held rifle or a grenade. */
  receive: boolean;
}

/** Two LOD copies within half a metre (5 units at 0.1 m/unit) share a placement. */
const LOD_SAME_SPOT_SQ = 5 * 5;

/** A drawn object with the facts its visibility and its place in the draw order depend on. */
interface Drawn {
  object: Object3D;
  order: number;
  /** The grid cells of the placements it draws (`LoadedMesh.cells`): where the engine order files it. */
  cells: readonly number[];
  alternate: boolean;
  shadow: boolean;
  line: boolean;
  /** Shown only in its LOD band's range; null for everything drawn at every range. */
  lod: { band: import('@s2u/scene').LodBand; at: Vector3; visible: boolean; last: boolean } | null;
}

/** The textures that are drop shadows: `shadow.tif`, `shadow_square.tif`, `t_shadow*`, and their kin. */
const SHADOW_TEXTURE = /shadow/i;
/**
 * The unit of a band's `du, dv`. `CScrollingTexture_band` holds a uv step and nothing about time, and the
 * engine's own update is not read yet. Taken as one step per engine tick at the 60 Hz field rate, Frostfire's
 * ocean (0.04) crossed 2.4 texture widths a second and its horizon (0.02) half that -- plainly faster than the
 * console (the owner, 2026-09-27). It is now read as texture widths per SECOND: the ocean drifts a width every
 * 25 s. Still an assumption; the one number to change is this multiplier, checked by eye against PCSX2.
 */
const SCROLL_TICKS_PER_SECOND = 1;

const FACTOR = {
  zero: ZeroFactor, one: OneFactor, srcAlpha: SrcAlphaFactor, oneMinusSrcAlpha: OneMinusSrcAlphaFactor, dstColor: DstColorFactor,
} as const satisfies Record<Factor, number>;

/** The blend a world material is given, colour and alpha, from its draw state's factors. */
export interface BlendFactors {
  blending: Blending;
  blendSrc: BlendingSrcFactor;
  blendDst: BlendingDstFactor;
  blendSrcAlpha: BlendingSrcFactor | null;
  blendDstAlpha: BlendingDstFactor | null;
}

/**
 * Pure, so the blend every world draw gets is pinned without a GPU (`test/blend.test.ts`).
 *
 * The colour is the draw state's blend, or a plain copy (One, Zero) for an unblended draw; the alpha is
 * always Zero, One. The GS's alpha never reached the television, and the canvas must stay opaque or the
 * page background shows through every cutout edge, alpha ramp and blended edge, unfogged (bluish in the
 * Modern look from `--bg`, black in PS2's) -- so no draw writes alpha, and the clear colour's 1 stays.
 */
export function blendFactorsFor(factors: DrawState['factors']): BlendFactors {
  return {
    blending: CustomBlending,
    blendSrc: factors ? FACTOR[factors.src] : OneFactor,
    blendDst: factors ? FACTOR[factors.dst] : ZeroFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  };
}

/**
 * Builds the scene objects for one decoded map: one `Mesh` per texture run for the world, whose vertices
 * `loadMap` has already placed, and one `InstancedMesh` per prop model-node -- a prop model is drawn in
 * up to 26 places, so it is uploaded once and instanced by the matrices `scene` produced.
 *
 * `map.origin` is zero whenever the scene graph could be read; it is only non-zero for the fallback,
 * where the whole group still shifts together the way it did before per-node placement.
 */
export function buildWorld(map: LoadedMap): WorldView {
  const group = new Group();
  group.name = `${map.archive} worldmodel`;
  group.position.set(map.origin[0], map.origin[1], map.origin[2]);

  const textures = new Map<string, Texture>();
  // The map's own rig, from its `GlobalLighting` record; the panel's trims arrive with `setLighting`.
  let lighting: Lighting = { ...DEFAULT_LIGHTING, rig: map.lightRig };
  let lastRig = lighting.rig;
  let lastEverywhere = lighting.rigEverywhere;
  const lineObjects: LineSegments[] = [];
  const billboards: Mesh[] = [];
  let billboardsOn = true;
  let blendGraded = false;
  /** The engine order (`setEngineOrder`): on, `renderOrder` is each draw's place in the grid walk. */
  let engineOn = false;
  let highlight = false;
  let lineStripsOn = true;
  let wireframeOn = false;
  let shadowsOn = true;
  let alternateOn = false;
  const built: Built[] = [];
  /** Every drawn object, for `setEngineOrder` and for the visibility switches. */
  const drawn: Drawn[] = [];
  /** The map's grid, cells only: what the engine order walks (`LoadedMap.grid`). */
  const grid = buildGrid(map.grid, [], [], []);
  /** The camera's cell the engine order was last computed for; -1 when it is stale. */
  let orderCell = -1;
  /** Where `frame` last saw the camera, in the group's frame, so switching the order on can order at once. */
  const lastCamera = { x: 0, z: 0, seen: false };
  const refreshVisibility = (): void => {
    for (const d of drawn) {
      d.object.visible = (!d.alternate || alternateOn) && (!d.shadow || shadowsOn) && (!d.line || (lineStripsOn && !wireframeOn))
        && (d.lod === null || d.lod.visible);
    }
  };
  /** The scrolling materials beside their offsets, advanced every frame. */
  const scrolling: { offset: ReturnType<typeof vec2Uniform>; du: number; dv: number }[] = [];
  // Every drawn part beside the buffer its lit colours go into, so a rig change can rewrite them in place.
  const lit: { part: Lightable; attribute: BufferAttribute }[] = [];
  /** How many drawn objects have no texture: the number the status line reports. */
  let untexturedDraws = 0;
  let triangles = 0;

  /**
   * The shading, as the GS does it, in four node graphs shared by every material (a shared graph is one
   * compiled program, not one per texture):
   *
   * - **MODULATE, then clamp, then brighten.** `(texel * vertex) >> 7`, the product clamped to 255 by
   *   `COLCLAMP` before the fog is mixed in -- so the clamp is here, ahead of the fog three applies to
   *   the output, and the post-process's `1 + FIX/128` comes after it as a uniform. Alpha is the same
   *   product, clamped, and is not brightened.
   * - The untextured variant of the same: the vertex colour alone.
   * - **The destination brighten**, `(Cd - 0) * As + Cd`: the source colour is never read, so the shader
   *   emits `As` in every channel for the `Cs * Cd + Cd` blend to multiply with (`./materialSpec`).
   * - **Magenta**, flat, for the untextured highlight.
   */
  const brighten = uniform(brightenOf(lighting));
  const vec2Uniform = (x: number, y: number) => uniform(new Vector2(x, y));
  // The typings do not know a material reference to a texture is a vec4, which is what the sampler yields.
  const texel = materialReference('map', 'texture') as unknown as Node<'vec4'>;
  // The lit colour through the night vision's command 0x5c while the goggles are on (`./nightVision`), before the GS.
  const lane = nightLit(vertexColor());
  const modulated = vec4(texel.mul(lane)).clamp(0, 1);
  const plain = vec4(lane).clamp(0, 1);
  // The characters' shadow (`./charShadow`, VU1 0x3c): black, source-alpha over the receiver, `Cd * (1 - a)`.
  const unshadowed = float(1).sub(shadowFactor());
  const SHADED: ColorNode = vec4(modulated.rgb.mul(brighten).mul(unshadowed), modulated.a);
  const SHADED_PLAIN: ColorNode = vec4(plain.rgb.mul(brighten).mul(unshadowed), plain.a);
  const SHADED_SELF: ColorNode = vec4(modulated.rgb.mul(brighten), modulated.a);
  const SHADED_PLAIN_SELF: ColorNode = vec4(plain.rgb.mul(brighten), plain.a);
  const CARRIER: ColorNode = vec4(modulated.a, modulated.a, modulated.a, modulated.a);
  const CARRIER_PLAIN: ColorNode = vec4(plain.a, plain.a, plain.a, plain.a);
  /** The colour an untextured mesh takes when the highlight is on: nothing in the game is this. */
  const MAGENTA: ColorNode = vec4(1, 0, 1, 1);

  // LOD fades (W1.3). `CVisual::DrawLOD` scales a LOD copy's opacity across its fades (`lodOpacity`,
  // reCOM `zVisual/vis_main.cpp:305-317`), and the engine draws a copy at 1 in place and one below it in
  // its alpha pass (`zRender/zrndr_pipe.cpp:344-364`). The copies share their texture's material, so the
  // opacity is not a material property: it is one uniform three refreshes per object as it draws it --
  // `uniform()` lives in the object group, whose bindings three clones per render object, and
  // `onObjectUpdate` reads the drawn object's own value -- and it sits only in the graph of a *fading
  // twin*, one per shared material, made the first time a copy drawn with it fades. At rest a copy is
  // drawn with its shared material, so its draw state is `materialSpec`'s and nothing else (`./lodFade`).
  // Cloning a material per copy would have cost a material per placement and a spec to keep in step on
  // each; an instance attribute would have needed the copies instanced, and each is its own mesh.
  const lodOpacityOf = new WeakMap<Object3D, number>();
  const fadeOpacity = uniform(1).onObjectUpdate(({ object }) => (object ? lodOpacityOf.get(object) ?? 1 : 1));
  const fades = new Map<Basic, MeshBasicNodeMaterial>();
  /** The shared material, with what it was built from, that a LOD copy is drawn with at rest. */
  const lodRest = new WeakMap<Object3D, Built>();
  /** Puts a fading twin in step with its shared material, as `apply` has just left that. */
  const applyFade = (b: Built, twin: MeshBasicNodeMaterial): void => {
    const fade = fadeMaterial(materialSpec(b.flags, b.fog, blendGraded, b.cull), b.shadow);
    const shared = b.material;
    // What `apply` chose -- shaded, carrier, scroll or magenta -- each built as a `vec4` above.
    const base = (shared.colorNode ?? SHADED) as Node<'vec4'>;
    twin.map = shared.map;
    twin.vertexColors = false;
    twin.colorNode = fade.mode === 'solid' ? vec4(base.rgb, fadeOpacity)
      : fade.mode === 'carrier' ? vec4(base.rgb.mul(fadeOpacity), base.a)
      : vec4(base.rgb, base.a.mul(fadeOpacity));
    twin.maskNode = fade.mask > 0 ? base.a.greaterThan(fade.mask) : null;
    twin.alphaTest = 0;                                  // the mask tests the unfaded alpha instead
    twin.transparent = fade.state.transparent;
    twin.depthWrite = fade.state.depthWrite;
    Object.assign(twin, blendFactorsFor(fade.state.factors));
    twin.polygonOffset = shared.polygonOffset;
    twin.polygonOffsetFactor = shared.polygonOffsetFactor;
    twin.polygonOffsetUnits = shared.polygonOffsetUnits;
    twin.side = shared.side;
    twin.fog = shared.fog;
    twin.wireframe = shared instanceof MeshBasicNodeMaterial && shared.wireframe;
    twin.needsUpdate = true;
  };
  /** Draws a LOD copy at `opacity`: with its shared material at rest (and hidden), its twin while fading. */
  const fadeTo = (object: Object3D, opacity: number): void => {
    const rest = lodRest.get(object);
    if (!rest || !(object instanceof Mesh)) return;
    lodOpacityOf.set(object, opacity);
    let want: Basic = rest.material;
    if (fadePhase(opacity) === 'fading') {
      let twin = fades.get(rest.material);
      if (!twin) {
        twin = new MeshBasicNodeMaterial();
        twin.name = 'lod fade';
        fades.set(rest.material, twin);
        applyFade(rest, twin);
      }
      want = twin;
    }
    if (object.material !== want) object.material = want;
  };

  /** Puts a spec on a material: the shading graph, the blend, the test, the depth write, the cull and the fog. */
  const apply = (b: Built): void => {
    const spec = materialSpec(b.flags, b.fog, blendGraded, b.cull);
    // A shadow is a decal: blended over whatever is under it, after the world, writing no depth, and
    // never in the engine order's opaque list, where a quad drawn before its ground would show the sky through.
    const state = b.shadow
      ? { transparent: true, depthWrite: false, factors: { src: 'srcAlpha' as const, dst: 'oneMinusSrcAlpha' as const } }
      : drawState(spec, engineOn);
    const { material } = b;
    const carrier = spec.blend === 'destination';
    material.polygonOffset = b.shadow;                  // off the ground it lies on, so it cannot z-fight it
    material.polygonOffsetFactor = b.shadow ? -1 : 0;
    material.polygonOffsetUnits = b.shadow ? -1 : 0;
    material.colorNode = highlight && !b.textured ? MAGENTA
      : carrier ? (b.textured ? CARRIER : CARRIER_PLAIN)
      : b.scrollNode ?? (b.receive ? (b.textured ? SHADED : SHADED_PLAIN) : (b.textured ? SHADED_SELF : SHADED_PLAIN_SELF));
    material.transparent = state.transparent;
    material.depthWrite = state.depthWrite;
    Object.assign(material, blendFactorsFor(state.factors));
    material.alphaTest = spec.alphaTest;
    // A shadow decal has no back to cull: its quad carries the cull flag like the prop it belongs to,
    // and culled by its winding it vanished from above, which is the only place it is ever seen from.
    material.side = spec.cull && !b.shadow ? FrontSide : DoubleSide;
    // A destination brighten reads only `As`, which the GS does not fog; fogging the carrier would fog it.
    material.fog = spec.fog && !carrier;
    material.needsUpdate = true;
    const twin = fades.get(material);                    // a LOD fade's twin follows every change (W1.3)
    if (twin) applyFade(b, twin);
  };

  /**
   * One material per (texture, fog, kind). The texture's own state block -- blend, alpha test, wrap,
   * filtering (`./materialSpec`) -- is the same for every draw of it; what varies per packet is the
   * `PRIM.FGE` fog bit, so a sky texture drawn fogged in one chunk and clear in another gets two.
   */
  const materialCache = new Map<string, Basic>();
  const materialFor = (name: string | null, fog: boolean, kind: 'mesh' | 'line', cull: boolean, scroll: [number, number] | null = null, receive = true): Basic => {
    const cacheKey = `${kind}|${name ?? ''}|${fog ? 1 : 0}|${cull ? 1 : 0}|${scroll ? `${scroll[0]},${scroll[1]}` : ''}|${receive ? 'r' : ''}`;
    const cached = materialCache.get(cacheKey);
    if (cached) return cached;
    const rgba = name === null ? undefined : map.textures[name];
    const flags = name === null ? undefined : map.textureFlags[name];
    const spec = materialSpec(flags, fog, blendGraded, cull);
    let texture = name === null ? undefined : textures.get(name);
    if (!texture && name !== null && rgba) {
      texture = makeTexture(rgba, spec, map.textureMips?.[name]);
      textures.set(name, texture);
    }
    // Backface culling is the visual's own flag on the disc (`VISUAL_FLAG_CULL`, `@s2u/scene`).
    //
    // SEMANTICS section 6: the right-handed cross product of a triangle's edges in index order *is*
    // the stored face normal, on all 8,764 non-degenerate Frostfire triangles, and VU1's cull handler
    // (`0x06`, research/13 section 4.2) keeps a triangle when the eye is on that side. So
    // counter-clockwise is front, which is three.js's default, and `FrontSide` is what the hardware
    // does -- for the visuals whose command list contains the cull, which the EE emits when bit 3 of
    // the visual's `vparams` is set (`FUN_003b5f20`, `flags & 8`). The flag is clear on exactly the
    // things drawn from both sides: Frostfire's ladders, whose rungs used to vanish from behind under
    // the old rule (cull where the texture is solid), grates, fan blades, Bitter Jungle's foliage,
    // Desert Glory's grass, rugs, the glow quads; and set on the solid objects, Crossroads' awning
    // included -- two coincident single-sided sheets that plaid when drawn double-sided.
    const material: Basic = kind === 'mesh' ? new MeshBasicNodeMaterial() : new LineBasicNodeMaterial();
    material.map = texture ?? null;
    material.vertexColors = false;                     // the shading graph reads the attribute itself
    const entry: Built = { material, flags, fog, textured: !!texture, cull, shadow: name !== null && SHADOW_TEXTURE.test(name), scrollNode: null, receive };
    const mip = gsMipLod(flags?.gs);
    if (texture && (scroll || mip)) {
      // A scrolling texture gets a graph of its own: the same modulate, with the uv pushed along by an
      // offset that `frame` advances. So does a mipmapped one, whose level is the GS's, off the depth
      // (`gsTexel`). One program each, a handful per map at most.
      let at: Node<'vec2'> = uv();
      if (scroll) {
        const offset = vec2Uniform(0, 0);
        at = at.add(offset);
        scrolling.push({ offset, du: scroll[0], dv: scroll[1] });
      }
      const moved = vec4(gsTexel(texture, at, mip).mul(nightLit(vertexColor()))).clamp(0, 1);
      entry.scrollNode = vec4(moved.rgb.mul(brighten).mul(receive ? unshadowed : float(1)), moved.a);
    }
    apply(entry);
    built.push(entry);
    materialCache.set(cacheKey, material);
    return material;
  };

  /**
   * The detail pass (W1.6). For every draw whose texture binds a detail record (`LoadedMap.detail`), a
   * second mesh over the same geometry -- a child of the base, so it moves, instances and hides with it --
   * drawn with the detail texture. What the console did (SEMANTICS §7, §11.6): VU1's `0x30`/`0x32` kick
   * the pass's GS state, multiply the staging `S`,`T` by the record's `uv` and re-run the draw handler over
   * the same vertices, colours and `PRIM`. So the graph is the base's modulate on a scaled uv, the fog bit
   * and the cull are the base's, and the blend is the record's (`detailDrawState`).
   *
   * One material and one graph per bound (texture, fog, cull), as the scrolling textures have: the scale
   * and the fade are uniforms, so the passes share a program. A few per map, twelve at most (MP53).
   * The facades take none (no facade is drawn with a bound texture) and nor do the line strips: the two
   * handlers re-run the triangle draw handlers `0x1780`/`0x1a78` (research 13 §4.8), and the two strip
   * groups that cite a bound texture (MP11's `ground.tif`, MP61's `wall_white.tif`) are one pixel wide.
   */
  let detailOn = true;
  const detailMaterials = new Map<string, { material: MeshBasicNodeMaterial; flags: TextureFlags | undefined; fog: boolean; cull: boolean; spec: DetailSpec }>();
  /** Each detail pass beside the draw it lies on, whose place in the order it follows. */
  const details: { mesh: Mesh; base: Object3D }[] = [];
  /** The pass's colour: `clamp(texel(uv * scale) * vertex)`, brightened; its alpha times the fade (`detailWeight`). */
  const detailColor = (texture: Texture, spec: DetailSpec): ColorNode => {
    const scale = uniform(spec.scale), fade = uniform(spec.fade);
    // The GS picks the detail's level off the depth as it does the base's; the uv scale does not enter it.
    const texel = vec4(gsTexel(texture, uv().mul(scale), gsMipLod(map.textureFlags[spec.texture]?.gs)).mul(nightLit(vertexColor()))).clamp(0, 1);
    const weight = float(1).sub(positionView.length().div(fade)).clamp(0, 1);
    return vec4(texel.rgb.mul(brighten).mul(unshadowed), texel.a.mul(weight));
  };
  /** Puts a detail pass's state on its material: its list follows its base's, which the two switches move. */
  const applyDetail = (entry: { material: MeshBasicNodeMaterial; flags: TextureFlags | undefined; fog: boolean; cull: boolean; spec: DetailSpec }): void => {
    const state = detailDrawState(entry.spec, drawState(materialSpec(entry.flags, entry.fog, blendGraded, entry.cull), engineOn));
    const { material } = entry;
    material.transparent = state.transparent;
    material.depthWrite = state.depthWrite;
    material.depthFunc = LessEqualDepth;
    Object.assign(material, blendFactorsFor(state.factors));
    material.side = entry.spec.cull ? FrontSide : DoubleSide;
    material.fog = entry.spec.fog;
    material.needsUpdate = true;
  };
  const detailMaterialFor = (base: string, fog: boolean, cull: boolean): MeshBasicNodeMaterial | null => {
    const key = `${base}|${fog ? 1 : 0}|${cull ? 1 : 0}`;
    const cached = detailMaterials.get(key);
    if (cached) return cached.material;
    const flags = map.textureFlags[base];
    const spec = materialSpec(flags, fog, blendGraded, cull, map.detail[base]).detail;
    const rgba = spec ? map.textures[spec.texture] : undefined;
    if (!spec || !rgba) return null;
    let texture = textures.get(spec.texture);
    if (!texture) {
      // A detail texture's own `CLAMP_1` is REPEAT on both axes on all 65 detail records whose texture is
      // on the disc; 62 of them ask `TEX1` for the mipmaps the minification at `uv` times needs.
      texture = makeTexture(rgba, { ...materialSpec(map.textureFlags[spec.texture], fog, true, false), wrapS: 'repeat', wrapT: 'repeat' },
        map.textureMips?.[spec.texture]);
      textures.set(spec.texture, texture);
    }
    const material = new MeshBasicNodeMaterial();
    material.vertexColors = false;                     // the graph reads the attribute itself
    material.colorNode = detailColor(texture, spec);
    const entry = { material, flags, fog, cull, spec };
    applyDetail(entry);
    detailMaterials.set(key, entry);
    return material;
  };
  const refreshDetail = (): void => {
    for (const d of details) d.mesh.visible = detailOn && !wireframeOn;
    for (const e of envPasses) e.mesh.visible = envOn && !wireframeOn;
  };

  /**
   * The environment-map pass (VU1 `0x34`/`0x36`, research 15 §6; `envVertex` in `./materialSpec` is its CPU twin):
   * over every draw whose visual names a reflection material (`LoadedMesh.reflect`), a second mesh on the same geometry
   * with the material's texture sampled at the sphere-map `st` of the reflection off the vertex's normal, coloured by
   * the material's base colour and faded by `(1 + a) * vertex alpha * rim` -- a faint sky on Blood Lake's, Fish Hook's
   * and Enowapi's water, the clouds on Sujo's glass. Computed per vertex, as the VU does, and interpolated. Its
   * `ALPHA` and `TEX1` are the texture's own (source-alpha, bilinear on all of them), it depth-tests less-or-equal
   * against its base (`TEST` GEQUAL on the console's Z16S) and writes none, fogged as its base is.
   */
  let envOn = true;
  const envPasses: { mesh: Mesh; base: Object3D }[] = [];
  const envMaterials = new Map<string, MeshBasicNodeMaterial>();
  const envByPalette = new Map((map.envMaterials ?? []).map((e) => [e.index + 1, e]));
  const envMaterialFor = (index: number, fog: boolean, cull: boolean): MeshBasicNodeMaterial | null => {
    const key = `${index}|${fog ? 1 : 0}|${cull ? 1 : 0}`;
    const cached = envMaterials.get(key);
    if (cached) return cached;
    const m = envByPalette.get(index);
    const rgba = m ? map.textures[m.texture] : undefined;
    if (!m || !rgba) return null;
    let texture = textures.get(m.texture);
    if (!texture) {
      texture = makeTexture(rgba, materialSpec(map.textureFlags[m.texture], fog, true, false), map.textureMips?.[m.texture]);
      textures.set(m.texture, texture);
    }
    const V = positionWorld.sub(cameraPosition);
    const R = V.sub(normalWorld.mul(V.dot(normalWorld).mul(2)));
    const turned = vec3(R.z, R.x, R.y);                          // the block's basis rows (0,1,0), (0,0,1), (1,0,0)
    const falls = turned.z.lessThan(0);
    const rim = select(falls, turned.z.add(m.rimOffset).mul(m.rimSlope).max(0), float(1));
    const clamped = vec3(turned.x, turned.y, turned.z.max(0));
    const length = select(falls, clamped.length(), V.length());
    const st = varying(clamped.xy.div(length).mul(m.uvScale).add(0.5));
    const alpha = varying(vertexColor().a.mul((1 + m.rgba[3]) / 128).mul(rim));
    const texel = textureNode(texture, st);
    const colour = texel.rgb.mul(vec3(m.rgba[0] / 128, m.rgba[1] / 128, m.rgba[2] / 128)).clamp(0, 1);
    const material = new MeshBasicNodeMaterial();
    material.name = `env ${m.texture}`;
    material.vertexColors = false;
    material.colorNode = vec4(colour.mul(brighten).mul(unshadowed), texel.a.mul(alpha).clamp(0, 1));
    material.transparent = true;
    material.depthWrite = false;
    material.depthFunc = LessEqualDepth;
    Object.assign(material, blendFactorsFor({ src: 'srcAlpha', dst: 'oneMinusSrcAlpha' }));
    material.side = cull ? FrontSide : DoubleSide;
    material.fog = fog;
    envMaterials.set(key, material);
    return material;
  };
  const addEnv = (base: Mesh, part: LoadedMesh): void => {
    if (!part.reflect || !part.normals) return;
    const material = envMaterialFor(part.reflect, part.fog, part.cull);
    if (!material) return;
    // The reflection needs the vertex normal the VU reads; the base draws never did. `part` is the chunk as
    // decoded -- a prop's normals in model space, which the instance matrix turns, a world part's already world.
    if (!base.geometry.getAttribute('normal')) base.geometry.setAttribute('normal', new BufferAttribute(part.normals, 3));
    let mesh: Mesh;
    if (base instanceof InstancedMesh) {
      const instanced = new InstancedMesh(base.geometry, material, base.count);
      instanced.instanceMatrix = base.instanceMatrix;
      mesh = instanced;
    } else mesh = new Mesh(base.geometry, material);
    mesh.name = `${base.name} (env)`;
    mesh.frustumCulled = base.frustumCulled;
    mesh.renderOrder = detailRenderOrder(base.renderOrder, engineOn) + 0.25;   // after the detail pass, as the list orders it
    mesh.visible = envOn && !wireframeOn;
    base.add(mesh);
    envPasses.push({ mesh, base });
  };
  /** Hangs a detail pass under a queued base draw, when its texture binds one. */
  const addDetail = (base: Mesh, part: LoadedMesh): void => {
    if (part.textureName === null || SHADOW_TEXTURE.test(part.textureName) || !map.detail[part.textureName]) return;
    const material = detailMaterialFor(part.textureName, part.fog, part.cull);
    if (!material) return;
    let mesh: Mesh;
    if (base instanceof InstancedMesh) {
      const instanced = new InstancedMesh(base.geometry, material, base.count);
      instanced.instanceMatrix = base.instanceMatrix;       // the same placements, uploaded once
      mesh = instanced;
    } else mesh = new Mesh(base.geometry, material);
    mesh.name = `${base.name} (detail)`;
    mesh.frustumCulled = base.frustumCulled;
    mesh.renderOrder = detailRenderOrder(base.renderOrder, engineOn);
    mesh.visible = detailOn && !wireframeOn;
    base.add(mesh);
    details.push({ mesh, base });
  };

  /**
   * Building an object is cheap; *drawing it the first time* is not, because that is when three uploads
   * its texture and geometry and compiles its program. So nothing is added to the group here. Each
   * object becomes a one-line task, and `main.ts` runs those across frames (`./scheduler`), which turns
   * one 1,700 ms frame into a few dozen short ones. The world's tasks come first and are what the first
   * paint waits for; the props follow behind it.
   */
  const revealWorld: (() => void)[] = [];
  const revealProps: (() => void)[] = [];
  const propObjects: Object3D[] = [];
  const worldObjects: Object3D[] = [];
  const box = new Box3();
  /**
   * Queues an object with its place in the scene walk and its grid cells, and grows the map's extent by it.
   * Its `renderOrder` stays three's 0 until the engine order numbers it (`reorder`).
   */
  const later = (
    queue: (() => void)[], object: Object3D, order: number, cells: readonly number[], alternate: boolean,
    texture: string | null, line = false, lod: Drawn['lod'] = null,
  ): void => {
    object.updateWorldMatrix(false, false);
    // An alternate state is not part of the extent the camera frames: it sits where its twin sits.
    if (!alternate) box.expandByObject(object);
    const shadow = texture !== null && SHADOW_TEXTURE.test(texture);
    drawn.push({ object, order, cells, alternate, shadow, line, lod });
    object.renderOrder = 0;
    object.visible = (!alternate || alternateOn) && (!shadow || shadowsOn) && (!line || (lineStripsOn && !wireframeOn))
      && (lod === null || lod.visible);
    queue.push(() => group.add(object));
    (queue === revealProps ? propObjects : worldObjects).push(object);
  };

  for (const part of map.world) {
    const mesh = new Mesh(geometryOf(part, lighting, lit), materialFor(part.textureName, part.fog, 'mesh', part.cull, part.scroll));
    mesh.name = part.textureName ?? 'untextured';
    if (!part.textureName) untexturedDraws++;
    mesh.frustumCulled = false;                           // one mesh spans the whole map; culling it hides it
    later(revealWorld, mesh, part.order, part.cells ?? [], part.alternate, part.textureName);
    addDetail(mesh, part);
    addEnv(mesh, part);
    triangles += part.indices.length / 3;
  }

  /** DOORS: every prop placement by its node's path, and how to put it at a matrix (`moveNode`). */
  const movable: { path: string; base: Matrix4; set: (m: Matrix4) => void }[] = [];
  const movableMesh = (path: string | undefined, mesh: Mesh, base: Matrix4): void => {
    if (!path) return;
    movable.push({ path, base: base.clone(), set: (m) => { m.decompose(mesh.position, mesh.quaternion, mesh.scale); mesh.updateMatrix(); } });
  };
  for (const prop of map.props) {
    const count = prop.matrices.length / 16;
    /** A placement's cells; an instanced draw is filed under all of its placements' (`LoadedMesh.cells`). */
    const cellsOf = (i: number): readonly number[] => prop.cells?.[i] ?? [];
    const allCells = [...new Set(prop.cells?.flat() ?? [])];
    // A world chunk's normals are rotated into world space by `loadMap` before they are lit; a prop's
    // are not, because the rotation lives in the placement matrix instead. Lighting them unrotated
    // would light a turned prop as though it faced the way it was modelled, so they are rotated here
    // by the first placement. A prop drawn in several placements that do not share a rotation is still
    // lit by the first one's: one `InstancedMesh` has one set of vertex colours, and splitting it into
    // a mesh per placement would cost 26 draws to fix a shading error of a few degrees.
    const rotation = new Matrix4().fromArray(prop.matrices, 0);
    for (const part of prop.parts) {
      if (prop.facade !== 0) {
        // A facade node -- a lamp flare, a star, the moon -- is turned to face the camera by the
        // engine every frame: left where it was modelled a flare is edge-on from most of the map and
        // a flat card from the rest. Each placement becomes its own mesh, centred on its geometry so
        // a spin about that centre keeps it where it belongs, and `frame` turns them every frame.
        // Both faces are kept: the facade matrix decides which way the quad ends up, not its winding.
        const flareMaterial = materialFor(part.textureName, part.fog, 'mesh', false);
        if (!part.textureName) untexturedDraws += count;
        for (let i = 0; i < count; i++) {
          const m = new Matrix4().fromArray(prop.matrices, i * 16);
          const { geometry: flat, centre: at } = centredQuad(rotateNormals(part, m), lighting, lit);
          const mesh = new Mesh(flat, flareMaterial);
          mesh.name = `${prop.modelName} (flare)`;
          mesh.position.copy(at.applyMatrix4(m));
          billboards.push(mesh);
          later(revealProps, mesh, part.order, cellsOf(i), prop.alternate, part.textureName);
        }
        triangles += (part.indices.length / 3) * count;
        continue;
      }
      const geometry = geometryOf(rotateNormals(part, rotation), lighting, lit);
      const material = materialFor(part.textureName, part.fog, 'mesh', part.cull);
      if (!part.textureName) untexturedDraws++;
      if (prop.lod) {
        // A model in a LOD band is shown by the camera's range to each placement, so every placement
        // is its own mesh -- there are tens of these per map, not the hundreds instancing is for.
        const rest = built.find((b) => b.material === material);   // what its fading twin is made from
        for (let i = 0; i < count; i++) {
          const mesh = new Mesh(geometry, material);
          mesh.name = `${prop.modelName} (lod)`;
          const m = new Matrix4().fromArray(prop.matrices, i * 16);
          mesh.applyMatrix4(m);
          movableMesh(prop.paths?.[i], mesh, m);
          const at = new Vector3().setFromMatrixPosition(m);
          later(revealProps, mesh, part.order, cellsOf(i), prop.alternate, part.textureName, false, { band: prop.lod, at, visible: lodVisible(prop.lod, 0), last: false });
          if (rest) lodRest.set(mesh, rest);
          addDetail(mesh, part);
          addEnv(mesh, part);
        }
        triangles += (part.indices.length / 3) * count;
        continue;
      }
      if (count === 1) {
        const mesh = new Mesh(geometry, material);
        mesh.name = prop.modelName;
        mesh.applyMatrix4(new Matrix4().fromArray(prop.matrices, 0));
        movableMesh(prop.paths?.[0], mesh, new Matrix4().fromArray(prop.matrices, 0));
        later(revealProps, mesh, part.order, cellsOf(0), prop.alternate, part.textureName);
        addDetail(mesh, part);
        addEnv(mesh, part);
      } else {
        const mesh = new InstancedMesh(geometry, material, count);
        mesh.name = prop.modelName;
        for (let i = 0; i < count; i++) mesh.setMatrixAt(i, new Matrix4().fromArray(prop.matrices, i * 16));
        mesh.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < count; i++) {
          const path = prop.paths?.[i];
          // The detail and env passes share `instanceMatrix` (`addDetail`, `addEnv`): one write moves them too.
          if (path) movable.push({ path, base: new Matrix4().fromArray(prop.matrices, i * 16), set: (m) => { mesh.setMatrixAt(i, m); mesh.instanceMatrix.needsUpdate = true; mesh.boundingSphere = null; } });
        }
        later(revealProps, mesh, part.order, allCells, prop.alternate, part.textureName);
        addDetail(mesh, part);
        addEnv(mesh, part);
      }
      triangles += (part.indices.length / 3) * count;
    }
  }

  // Which LOD copy is the last at its spot (`lodIsLast`): the copies of one object share a placement,
  // so the others at a placement are the bands within a stride of it. Tens of placements, once.
  {
    const lodDrawn = drawn.filter((d): d is Drawn & { lod: NonNullable<Drawn['lod']> } => d.lod !== null);
    for (const d of lodDrawn) {
      const bandsHere: LodBand[] = [];
      for (const o of lodDrawn) if (o !== d && o.lod.at.distanceToSquared(d.lod.at) < LOD_SAME_SPOT_SQ) bandsHere.push(o.lod.band);
      d.lod.last = lodIsLast(d.lod.band, bandsHere);
    }
  }

  // The GS LINE_STRIP geometry (SEMANTICS section 12): power lines, lamp brackets, guy ropes, light
  // filaments. The hardware draws these one pixel wide at any distance, textured (`TME`) along the
  // strip with uvs that run well outside 0..1, gouraud, fogged and blended -- `PRIM = IIP|TME|FGE|ABE`
  // on all 194 packets. A `LineSegments` per (texture, fog) with the same shading graph the meshes use
  // draws exactly that: the texture repeats along the rope, and the vertex colour shades it.
  for (const strip of map.lines ?? []) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(strip.positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(strip.uvs, 2));
    const colors = new Float32Array(strip.colors.length);
    const part: Lightable = { colors: strip.colors, normals: strip.normals, lit: false };
    applyLighting(part, lighting, colors);
    const attribute = new BufferAttribute(colors, 4);
    geometry.setAttribute('color', attribute);
    lit.push({ part, attribute });
    const segments = new LineSegments(geometry, materialFor(strip.textureName, strip.fog, 'line', false));
    segments.name = `line strips (${strip.textureName ?? 'untextured'})`;
    segments.frustumCulled = false;
    if (!strip.textureName) untexturedDraws++;
    lineObjects.push(segments);
    later(revealProps, segments, strip.order, strip.cells ?? [], false, null, true);
  }

  // W2.4: the held weapon, built like a prop placed once -- the world's materials, lit by the map's rig -- but kept
  // out of `group`, the reveal queues, the extent and the triangle count: it belongs to the player, not the map,
  // and `./shot` moves it every frame. Its normals are lit in the weapon's own frame, not re-lit as it turns.
  const heldModel = (held: LoadedMap['weapon']): Group | null => {
    if (!held) return null;
    const g = new Group();
    g.name = held.name;
    for (const part of held.parts) {
      const mesh = new Mesh(geometryOf(part, lighting, lit), materialFor(part.textureName, part.fog, 'mesh', part.cull));
      mesh.name = `${held.name} (${part.textureName ?? 'untextured'})`;
      g.add(mesh);
    }
    return g;
  };
  const sidearm = heldModel(map.sidearm);
  let weapon: Group | null = null;
  if (map.weapon) {
    weapon = new Group();
    weapon.name = map.weapon.name;
    for (const part of map.weapon.parts) {
      const mesh = new Mesh(geometryOf(part, lighting, lit), materialFor(part.textureName, part.fog, 'mesh', part.cull, null, false));
      mesh.name = `${map.weapon.name} (${part.textureName ?? 'untextured'})`;
      weapon.add(mesh);
    }
  }

  // The frag grenade, as the weapon: the world's materials and the map's rig; `./grenade` places its clones.
  const grenades: Record<string, Group> = {};
  for (const model of map.grenade?.models ?? []) {
    if (!model.parts.length) continue;
    const g = new Group();
    g.name = model.name;
    for (const part of model.parts) {
      const mesh = new Mesh(geometryOf(part, lighting, lit), materialFor(part.textureName, part.fog, 'mesh', part.cull, null, false));
      mesh.name = `${model.name} (${part.textureName ?? 'untextured'})`;
      g.add(mesh);
    }
    grenades[model.name] = g;
  }

  /**
   * Numbers every draw by its place in the engine order from a camera at (x, z) in the group's frame, and
   * each detail pass half a step behind its base (`detailRenderOrder`). three's opaque list sorts by
   * `renderOrder` first, so this is the order the draws go out in.
   */
  const reorder = (x: number, z: number): void => {
    orderCell = cellAt(grid, x, z).index;
    engineOrder(drawn, grid, x, z).forEach((d, i) => { d.object.renderOrder = i; });
    for (const { mesh, base } of details) mesh.renderOrder = detailRenderOrder(base.renderOrder, true);
    for (const { mesh, base } of envPasses) mesh.renderOrder = detailRenderOrder(base.renderOrder, true) + 0.25;
  };

  const warmExtras = (): Object3D[] => {
    const out: Object3D[] = [];
    const seen = new Set<Basic>();
    for (const d of drawn) {
      const rest = d.lod ? lodRest.get(d.object) : undefined;
      if (!rest || seen.has(rest.material) || !(d.object instanceof Mesh)) continue;
      seen.add(rest.material);
      let twin = fades.get(rest.material);
      if (!twin) {
        twin = new MeshBasicNodeMaterial();
        twin.name = 'lod fade';
        fades.set(rest.material, twin);
        applyFade(rest, twin);
      }
      out.push(new Mesh(d.object.geometry, twin));
    }
    return out;
  };

  return {
    group,
    warmExtras,
    revealWorld,
    revealProps,
    worldObjects,
    propObjects,
    triangles,
    box,
    untextured: untexturedDraws,
    shadowDraws: drawn.filter((d) => d.shadow).length,
    alternateDraws: drawn.filter((d) => d.alternate).length,
    detailDraws: details.length,
    setWireframe: (on) => {
      // `needsUpdate` as well as the flag: three's WebGPU renderer builds a geometry's wireframe index
      // the first time a render object is refreshed in full, and a bare flag change is not a refresh.
      // Without it the index is never uploaded, every wireframe draw goes out with no index type, and
      // the frame is the clear colour and nothing else until the page is reloaded.
      for (const { material } of built) {
        if (material instanceof MeshBasicNodeMaterial) { material.wireframe = on; material.needsUpdate = true; }
      }
      for (const twin of fades.values()) { twin.wireframe = on; twin.needsUpdate = true; }
      // A line has no faces to show through, so it simply steps aside while the topology is on view.
      wireframeOn = on;
      refreshVisibility();
      refreshDetail();                                  // a pass over a wireframe hides the topology it is for
    },
    setUntexturedHighlight: (on) => {
      if (on === highlight) return;
      highlight = on;
      for (const b of built) if (!b.textured) apply(b);
    },
    setLighting: (next) => {
      brighten.value = brightenOf(next);
      const rigChanged = next.rig !== lastRig || next.rigEverywhere !== lastEverywhere;
      lighting = next;
      lastRig = next.rig;
      lastEverywhere = next.rigEverywhere;
      if (!rigChanged) return;
      for (const { part, attribute } of lit) {
        applyLighting(part, lighting, attribute.array as Float32Array);
        attribute.needsUpdate = true;
      }
    },
    frame: (camera, dt) => {
      if (billboardsOn) for (const mesh of billboards) mesh.quaternion.copy(camera.quaternion);
      // The engine order follows the camera's cell: a new cell, a new walk; the same cell, the same order.
      lastCamera.x = camera.position.x - group.position.x;
      lastCamera.z = camera.position.z - group.position.z;
      lastCamera.seen = true;
      if (engineOn && cellAt(grid, lastCamera.x, lastCamera.z).index !== orderCell) reorder(lastCamera.x, lastCamera.z);
      let lodChanged = false;
      for (const d of drawn) {
        if (d.lod === null) continue;
        // `DrawLOD`'s opacity at the camera's range squared: drawn where it is above zero (`lodVisible`),
        // faded across each fade, at rest on the plateau.
        const opacity = lodOpacity(d.lod.band, d.lod.at.distanceToSquared(camera.position), d.lod.last);
        const visible = opacity > 0;
        if (visible !== d.lod.visible) { d.lod.visible = visible; lodChanged = true; }
        fadeTo(d.object, opacity);
      }
      if (lodChanged) refreshVisibility();
      for (const s of scrolling) {
        const v = s.offset.value;
        // Kept in 0..1: a uv offset of 3.04 samples the same texel as 0.04 and drifts in precision.
        v.x = (v.x + s.du * dt * SCROLL_TICKS_PER_SECOND) % 1;
        v.y = (v.y + s.dv * dt * SCROLL_TICKS_PER_SECOND) % 1;
      }
    },
    weapon,
    sidearm,
    grenades,
    flarePositions: () => billboards.map((m) => [m.position.x, m.position.y, m.position.z]),
    lineGroups: () => lineObjects.map((line) => {
      const b = new Box3().setFromBufferAttribute(line.geometry.getAttribute('position') as BufferAttribute);
      return { texture: line.name, min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }),
    moveNode: (path, delta) => {
      const d = new Matrix4().fromArray(Array.from(delta));
      const under = (p: string): boolean => p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}=`);
      let moved = 0;
      for (const m of movable) {
        if (!under(m.path)) continue;
        m.set(d.clone().multiply(m.base));
        moved++;
      }
      return moved;
    },
    setBillboards: (on) => {
      billboardsOn = on;
      if (!on) for (const mesh of billboards) mesh.quaternion.identity();   // back to the pose on disc
    },
    setLineStrips: (on) => { lineStripsOn = on; refreshVisibility(); },
    setShadows: (on) => { shadowsOn = on; refreshVisibility(); },
    setAlternate: (on) => { alternateOn = on; refreshVisibility(); },
    setDetail: (on) => { detailOn = on; refreshDetail(); },
    setBlendGraded: (on) => {
      if (on === blendGraded) return;
      blendGraded = on;
      for (const b of built) apply(b);
      for (const d of detailMaterials.values()) applyDetail(d);   // a pass's list follows its base's
    },
    setEngineOrder: (on) => {
      if (on === engineOn) return;
      engineOn = on;
      for (const b of built) apply(b);
      for (const d of detailMaterials.values()) applyDetail(d);
      orderCell = -1;
      if (on) {
        if (lastCamera.seen) reorder(lastCamera.x, lastCamera.z);   // else the next frame orders it
        return;
      }
      for (const { object } of drawn) object.renderOrder = 0;
      for (const { mesh } of details) mesh.renderOrder = detailRenderOrder(0, false);
      for (const { mesh } of envPasses) mesh.renderOrder = detailRenderOrder(0, false) + 0.25;
    },
    dispose: () => {
      for (const child of group.children) {
        if (!(child instanceof Mesh) && !(child instanceof LineSegments)) continue;   // an InstancedMesh is a Mesh too
        child.geometry.dispose();
        if (child instanceof InstancedMesh) child.dispose();
      }
      for (const { material } of built) material.dispose();
      for (const twin of fades.values()) twin.dispose();
      for (const { material } of detailMaterials.values()) material.dispose();
      for (const { mesh } of details) if (mesh instanceof InstancedMesh) mesh.dispose();
      for (const material of envMaterials.values()) material.dispose();
      for (const { mesh } of envPasses) if (mesh instanceof InstancedMesh) mesh.dispose();
      for (const child of weapon?.children ?? []) if (child instanceof Mesh) child.geometry.dispose();
      for (const child of sidearm?.children ?? []) if (child instanceof Mesh) child.geometry.dispose();
      for (const g of Object.values(grenades)) for (const child of g.children) if (child instanceof Mesh) child.geometry.dispose();
      for (const texture of textures.values()) texture.dispose();
    },
  };
}

/**
 * The part with its normals turned by a placement's 3x3, so the lighting sees where it really faces.
 *
 * Renormalised afterwards: a placement matrix is not always a pure rotation. Clutter carries a uniform
 * scale -- Desert Glory's rocks come through at about 0.93 -- and a scaled normal would dim every
 * surface of that prop by the same factor, which reads as the prop being in shadow rather than smaller.
 * A zero normal (SEMANTICS section 4 allows them, 16 of Frostfire's are exactly zero) stays zero.
 */
function rotateNormals(part: LoadedMesh, m: Matrix4): LoadedMesh {
  if (!part.normals) return part;
  const e = m.elements;                                 // column-major, as three stores it
  const out = new Float32Array(part.normals.length);
  for (let i = 0; i < out.length; i += 3) {
    const [x, y, z] = [part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!];
    const nx = x * e[0]! + y * e[4]! + z * e[8]!;
    const ny = x * e[1]! + y * e[5]! + z * e[9]!;
    const nz = x * e[2]! + y * e[6]! + z * e[10]!;
    const len = Math.hypot(nx, ny, nz);
    const k = len > 1e-6 ? 1 / len : 0;
    out[i] = nx * k;
    out[i + 1] = ny * k;
    out[i + 2] = nz * k;
  }
  return { ...part, normals: out };
}

/** A quad moved so its centre is the origin, with that centre, so a mesh can be spun about it. */
function centredQuad(
  part: LoadedMesh,
  light: Lighting,
  lit: { part: Lightable; attribute: BufferAttribute }[],
): { geometry: BufferGeometry; centre: Vector3 } {
  const centre = new Vector3();
  for (let i = 0; i < part.positions.length; i += 3) {
    centre.x += part.positions[i]!; centre.y += part.positions[i + 1]!; centre.z += part.positions[i + 2]!;
  }
  centre.divideScalar(part.positions.length / 3);
  const positions = new Float32Array(part.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = part.positions[i]! - centre.x;
    positions[i + 1] = part.positions[i + 1]! - centre.y;
    positions[i + 2] = part.positions[i + 2]! - centre.z;
  }
  return { geometry: geometryOf({ ...part, positions }, light, lit), centre };
}

/** The centre of a box, for framing a map whose spawns are not known. */
export function centre(box: Box3): [number, number, number] {
  const v = box.getCenter(new Vector3());
  return [v.x, v.y, v.z];
}

function geometryOf(
  part: LoadedMesh,
  light: Lighting,
  lit: { part: Lightable; attribute: BufferAttribute }[],
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(part.positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(part.uvs, 2));
  // The attribute is the *lit* colour, not the material colour on disc: `record2 * lit`, computed here
  // the way the VU computes it (see `./lighting`). Float rather than a normalised byte, because a lit
  // colour goes above 1 and the GS clamps the modulate, not the vertex.
  const colors = new Float32Array(part.colors.length);
  applyLighting(part, light, colors);
  const attribute = new BufferAttribute(colors, 4);
  geometry.setAttribute('color', attribute);
  lit.push({ part, attribute });
  geometry.setIndex(new BufferAttribute(part.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * A texel as the GS samples it. A mipmapped texture's level is `gsMipLod`'s -- `log2` of the depth, scaled by
 * `2^L`, plus `K`, clamped to `0..MXL` -- read per fragment from the view depth (the clip `w` the VU divides by),
 * not the GPU's derivative LOD, which took Vigilance's walls two levels down at 150 units where the console
 * draws them sharp. Anything else samples as it always did.
 */
function gsTexel(texture: Texture, at: Node<'vec2'>, lod: GsMipLod | null): Node<'vec4'> {
  const sampled = textureNode(texture, at);
  if (!lod) return sampled as unknown as Node<'vec4'>;
  const level = log2(positionView.z.negate().max(1e-3)).mul(lod.scale).add(lod.k).clamp(0, lod.max);
  return sampled.level(level) as unknown as Node<'vec4'>;
}

export function makeTexture(rgba: Rgba, spec: MaterialSpec, discMips?: readonly Rgba[]): DataTexture {
  const texture = new DataTexture(new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length), rgba.width, rgba.height, RGBAFormat);
  texture.flipY = FLIP_Y;
  // NoColorSpace is the GS's own reading: the stored byte *is* the value, and the modulate happens on
  // it -- `(texel * vertex) >> 7` on 8-bit values. Decoding the texel to linear first, as an sRGB
  // texture would be, turned a vertex at half brightness into 0.73 of the pixel and washed every
  // shaded surface out; the renderer's output is left unconverted to match.
  texture.colorSpace = NoColorSpace;
  // `TEX1` off the disc: bilinear on every texture in the corpus, and a mipmap chain on the ground and
  // detail textures that ask for one (`MMIN = LINEAR_MIPMAP_LINEAR`). The hardware was given one or two
  // levels, the records `MIPTBP1` names (`LoadedMap.textureMips`), and those are uploaded as they are --
  // a detail texture's are transparent, the pass's fade with distance -- with a filtered tail to 1x1 that
  // `gsTexel` never reaches. A texture whose levels did not resolve gets three's generated chain.
  texture.magFilter = spec.bilinear ? LinearFilter : NearestFilter;
  texture.minFilter = spec.mipmaps ? LinearMipmapLinearFilter : spec.bilinear ? LinearFilter : NearestFilter;
  if (spec.mipmaps && discMips && discMips.length > 0) {
    texture.mipmaps = mipChain(rgba, discMips).map((l) => ({ data: new Uint8Array(l.data.buffer, l.data.byteOffset, l.data.length), width: l.width, height: l.height }));
    texture.generateMipmaps = false;
  } else texture.generateMipmaps = spec.mipmaps;
  // `CLAMP` off the disc, per axis. A glow's quad clamps so the bilinear tap at u = 1 cannot fetch
  // u = 0 and draw the quad's outline; a tiling wall repeats.
  texture.wrapS = spec.wrapS === 'clamp' ? ClampToEdgeWrapping : RepeatWrapping;
  texture.wrapT = spec.wrapT === 'clamp' ? ClampToEdgeWrapping : RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
