import {
  Box3, BufferAttribute, BufferGeometry, ClampToEdgeWrapping, CustomBlending, DataTexture, DoubleSide, DstColorFactor,
  FrontSide, Group, type Object3D, InstancedMesh, LinearFilter, LinearMipmapLinearFilter, LineSegments, Matrix4, Mesh,
  NearestFilter, NoBlending, NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, RGBAFormat, RepeatWrapping, SrcAlphaFactor,
  Texture, Vector2, Vector3, ZeroFactor,
} from 'three';
import type { Camera } from 'three';
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, type Node } from 'three/webgpu';
import { materialReference, texture as textureNode, uniform, uv, vec4, vertexColor } from 'three/tsl';
import { lodVisible } from '@s2u/scene';
import { drawState, materialSpec, type Factor, type MaterialSpec, type TextureFlags } from './materialSpec';
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
  triangles: number;
  /** The extent of everything queued, accumulated as it was built rather than read off the group. */
  box: Box3;
  /** How many of the group's draws are drawing without a texture: the highlight's subject, counted. */
  untextured: number;
  /** How many draws are drop shadows, and how many are alternate states -- what the two toggles govern. */
  shadowDraws: number;
  alternateDraws: number;
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
   * Whether every draw goes out in scene-graph order writing depth as it goes, or blended draws are
   * handed to three to sort back to front by object centre with no depth written under them
   * (`drawState` in `./materialSpec`). **Off by default, and experimental**: the engine's real order
   * is a walk of its grid outward from the camera (`CPipe::RenderWorld`, `StartTraversalOrdered`)
   * with decals and shadows in passes of their own, which the graph order does not reproduce -- on,
   * a shadow quad or a flare drawn before the wall behind it shows the clear colour through itself.
   */
  setDiscOrder(on: boolean): void;
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
   * The per-frame work, called once a frame before the render: turns the facades to the camera,
   * picks each LOD pair's copy by range, and advances the scrolling textures.
   *
   * A flare on disc is a single quad on a single plane -- `lightcage`'s `lightrays.tif` node is 4
   * vertices and 2 triangles, normal (0, 0.96, -0.24) -- so a fixed quad that nearly faces the sky is
   * edge-on from a standing player. The engine turns the nodes flagged `m_facade` (`facadeOf`); so
   * does this. `CVisual::DrawLOD` shows one copy of a LOD pair by the camera's range; so does this,
   * at the middle of each fade. A `TextureScroll_Object` band adds its `du, dv` to a node's uvs; so does
   * this, at `SCROLL_TICKS_PER_SECOND` steps a second (1: the step is per second, see the constant).
   */
  frame(camera: Camera, dt: number): void;
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
  dispose(): void;
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
}

/** A drawn object with the facts its visibility and its place in the draw order depend on. */
interface Drawn {
  object: Object3D;
  order: number;
  alternate: boolean;
  shadow: boolean;
  line: boolean;
  /** Shown only in its LOD band's range; null for everything drawn at every range. */
  lod: { band: import('@s2u/scene').LodBand; at: Vector3; visible: boolean } | null;
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
  let discOrder = false;
  let highlight = false;
  let lineStripsOn = true;
  let wireframeOn = false;
  let shadowsOn = true;
  let alternateOn = false;
  const built: Built[] = [];
  /** Every drawn object, for `setDiscOrder` and for the visibility switches. */
  const drawn: Drawn[] = [];
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
  const modulated = vec4(texel.mul(vertexColor())).clamp(0, 1);
  const plain = vec4(vertexColor()).clamp(0, 1);
  const SHADED: ColorNode = vec4(modulated.rgb.mul(brighten), modulated.a);
  const SHADED_PLAIN: ColorNode = vec4(plain.rgb.mul(brighten), plain.a);
  const CARRIER: ColorNode = vec4(modulated.a, modulated.a, modulated.a, modulated.a);
  const CARRIER_PLAIN: ColorNode = vec4(plain.a, plain.a, plain.a, plain.a);
  /** The colour an untextured mesh takes when the highlight is on: nothing in the game is this. */
  const MAGENTA: ColorNode = vec4(1, 0, 1, 1);

  /** Puts a spec on a material: the shading graph, the blend, the test, the depth write, the cull and the fog. */
  const apply = (b: Built): void => {
    const spec = materialSpec(b.flags, b.fog, blendGraded, b.cull);
    // A shadow is a decal: blended over whatever is under it, after the world, writing no depth, and
    // never in the graph-order list where a quad drawn before its ground would show the sky through.
    const state = b.shadow
      ? { transparent: true, depthWrite: false, factors: { src: 'srcAlpha' as const, dst: 'oneMinusSrcAlpha' as const } }
      : drawState(spec, discOrder);
    const { material } = b;
    const carrier = spec.blend === 'destination';
    material.polygonOffset = b.shadow;                  // off the ground it lies on, so it cannot z-fight it
    material.polygonOffsetFactor = b.shadow ? -1 : 0;
    material.polygonOffsetUnits = b.shadow ? -1 : 0;
    material.colorNode = highlight && !b.textured ? MAGENTA
      : carrier ? (b.textured ? CARRIER : CARRIER_PLAIN)
      : b.scrollNode ?? (b.textured ? SHADED : SHADED_PLAIN);
    material.transparent = state.transparent;
    material.depthWrite = state.depthWrite;
    if (state.factors) {
      material.blending = CustomBlending;
      material.blendSrc = FACTOR[state.factors.src];
      material.blendDst = FACTOR[state.factors.dst];
      material.blendSrcAlpha = null;
      material.blendDstAlpha = null;
    } else {
      material.blending = NoBlending;
    }
    material.alphaTest = spec.alphaTest;
    // A shadow decal has no back to cull: its quad carries the cull flag like the prop it belongs to,
    // and culled by its winding it vanished from above, which is the only place it is ever seen from.
    material.side = spec.cull && !b.shadow ? FrontSide : DoubleSide;
    // A destination brighten reads only `As`, which the GS does not fog; fogging the carrier would fog it.
    material.fog = spec.fog && !carrier;
    material.needsUpdate = true;
  };

  /**
   * One material per (texture, fog, kind). The texture's own state block -- blend, alpha test, wrap,
   * filtering (`./materialSpec`) -- is the same for every draw of it; what varies per packet is the
   * `PRIM.FGE` fog bit, so a sky texture drawn fogged in one chunk and clear in another gets two.
   */
  const materialCache = new Map<string, Basic>();
  const materialFor = (name: string | null, fog: boolean, kind: 'mesh' | 'line', cull: boolean, scroll: [number, number] | null = null): Basic => {
    const cacheKey = `${kind}|${name ?? ''}|${fog ? 1 : 0}|${cull ? 1 : 0}|${scroll ? `${scroll[0]},${scroll[1]}` : ''}`;
    const cached = materialCache.get(cacheKey);
    if (cached) return cached;
    const rgba = name === null ? undefined : map.textures[name];
    const flags = name === null ? undefined : map.textureFlags[name];
    const spec = materialSpec(flags, fog, blendGraded, cull);
    let texture = name === null ? undefined : textures.get(name);
    if (!texture && name !== null && rgba) {
      texture = makeTexture(rgba, spec);
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
    const entry: Built = { material, flags, fog, textured: !!texture, cull, shadow: name !== null && SHADOW_TEXTURE.test(name), scrollNode: null };
    if (scroll && texture) {
      // A scrolling texture gets a graph of its own: the same modulate, with the uv pushed along by an
      // offset that `frame` advances. One program per scrolling texture, a handful per map at most.
      const offset = vec2Uniform(0, 0);
      const moved = vec4(textureNode(texture, uv().add(offset)).mul(vertexColor())).clamp(0, 1);
      entry.scrollNode = vec4(moved.rgb.mul(brighten), moved.a);
      scrolling.push({ offset, du: scroll[0], dv: scroll[1] });
    }
    apply(entry);
    built.push(entry);
    materialCache.set(cacheKey, material);
    return material;
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
  const box = new Box3();
  /** Queues an object at its place in the walk, and grows the map's extent by it. */
  const later = (
    queue: (() => void)[], object: Object3D, order: number, alternate: boolean, texture: string | null,
    line = false, lod: Drawn['lod'] = null,
  ): void => {
    object.updateWorldMatrix(false, false);
    // An alternate state is not part of the extent the camera frames: it sits where its twin sits.
    if (!alternate) box.expandByObject(object);
    const shadow = texture !== null && SHADOW_TEXTURE.test(texture);
    drawn.push({ object, order, alternate, shadow, line, lod });
    object.renderOrder = discOrder ? order : 0;
    object.visible = (!alternate || alternateOn) && (!shadow || shadowsOn) && (!line || (lineStripsOn && !wireframeOn))
      && (lod === null || lod.visible);
    queue.push(() => group.add(object));
  };

  for (const part of map.world) {
    const mesh = new Mesh(geometryOf(part, lighting, lit), materialFor(part.textureName, part.fog, 'mesh', part.cull, part.scroll));
    mesh.name = part.textureName ?? 'untextured';
    if (!part.textureName) untexturedDraws++;
    mesh.frustumCulled = false;                           // one mesh spans the whole map; culling it hides it
    later(revealWorld, mesh, part.order, part.alternate, part.textureName);
    triangles += part.indices.length / 3;
  }

  for (const prop of map.props) {
    const count = prop.matrices.length / 16;
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
          later(revealProps, mesh, part.order, prop.alternate, part.textureName);
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
        for (let i = 0; i < count; i++) {
          const mesh = new Mesh(geometry, material);
          mesh.name = `${prop.modelName} (lod)`;
          const m = new Matrix4().fromArray(prop.matrices, i * 16);
          mesh.applyMatrix4(m);
          const at = new Vector3().setFromMatrixPosition(m);
          later(revealProps, mesh, part.order, prop.alternate, part.textureName, false, { band: prop.lod, at, visible: lodVisible(prop.lod, 0) });
        }
        triangles += (part.indices.length / 3) * count;
        continue;
      }
      if (count === 1) {
        const mesh = new Mesh(geometry, material);
        mesh.name = prop.modelName;
        mesh.applyMatrix4(new Matrix4().fromArray(prop.matrices, 0));
        later(revealProps, mesh, part.order, prop.alternate, part.textureName);
      } else {
        const mesh = new InstancedMesh(geometry, material, count);
        mesh.name = prop.modelName;
        for (let i = 0; i < count; i++) mesh.setMatrixAt(i, new Matrix4().fromArray(prop.matrices, i * 16));
        mesh.instanceMatrix.needsUpdate = true;
        later(revealProps, mesh, part.order, prop.alternate, part.textureName);
      }
      triangles += (part.indices.length / 3) * count;
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
    later(revealProps, segments, strip.order, false, null, true);
  }

  return {
    group,
    revealWorld,
    revealProps,
    triangles,
    box,
    untextured: untexturedDraws,
    shadowDraws: drawn.filter((d) => d.shadow).length,
    alternateDraws: drawn.filter((d) => d.alternate).length,
    setWireframe: (on) => {
      // `needsUpdate` as well as the flag: three's WebGPU renderer builds a geometry's wireframe index
      // the first time a render object is refreshed in full, and a bare flag change is not a refresh.
      // Without it the index is never uploaded, every wireframe draw goes out with no index type, and
      // the frame is the clear colour and nothing else until the page is reloaded.
      for (const { material } of built) {
        if (material instanceof MeshBasicNodeMaterial) { material.wireframe = on; material.needsUpdate = true; }
      }
      // A line has no faces to show through, so it simply steps aside while the topology is on view.
      wireframeOn = on;
      refreshVisibility();
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
      let lodChanged = false;
      for (const d of drawn) {
        if (d.lod === null) continue;
        const visible = lodVisible(d.lod.band, d.lod.at.distanceTo(camera.position));
        if (visible !== d.lod.visible) { d.lod.visible = visible; lodChanged = true; }
      }
      if (lodChanged) refreshVisibility();
      for (const s of scrolling) {
        const v = s.offset.value;
        // Kept in 0..1: a uv offset of 3.04 samples the same texel as 0.04 and drifts in precision.
        v.x = (v.x + s.du * dt * SCROLL_TICKS_PER_SECOND) % 1;
        v.y = (v.y + s.dv * dt * SCROLL_TICKS_PER_SECOND) % 1;
      }
    },
    flarePositions: () => billboards.map((m) => [m.position.x, m.position.y, m.position.z]),
    lineGroups: () => lineObjects.map((line) => {
      const b = new Box3().setFromBufferAttribute(line.geometry.getAttribute('position') as BufferAttribute);
      return { texture: line.name, min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    }),
    setBillboards: (on) => {
      billboardsOn = on;
      if (!on) for (const mesh of billboards) mesh.quaternion.identity();   // back to the pose on disc
    },
    setLineStrips: (on) => { lineStripsOn = on; refreshVisibility(); },
    setShadows: (on) => { shadowsOn = on; refreshVisibility(); },
    setAlternate: (on) => { alternateOn = on; refreshVisibility(); },
    setBlendGraded: (on) => {
      if (on === blendGraded) return;
      blendGraded = on;
      for (const b of built) apply(b);
    },
    setDiscOrder: (on) => {
      if (on === discOrder) return;
      discOrder = on;
      for (const b of built) apply(b);
      for (const { object, order } of drawn) object.renderOrder = on ? order : 0;
    },
    dispose: () => {
      for (const child of group.children) {
        if (!(child instanceof Mesh) && !(child instanceof LineSegments)) continue;   // an InstancedMesh is a Mesh too
        child.geometry.dispose();
        if (child instanceof InstancedMesh) child.dispose();
      }
      for (const { material } of built) material.dispose();
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

function makeTexture(rgba: Rgba, spec: MaterialSpec): DataTexture {
  const texture = new DataTexture(new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length), rgba.width, rgba.height, RGBAFormat);
  texture.flipY = FLIP_Y;
  // NoColorSpace is the GS's own reading: the stored byte *is* the value, and the modulate happens on
  // it -- `(texel * vertex) >> 7` on 8-bit values. Decoding the texel to linear first, as an sRGB
  // texture would be, turned a vertex at half brightness into 0.73 of the pixel and washed every
  // shaded surface out; the renderer's output is left unconverted to match.
  texture.colorSpace = NoColorSpace;
  // `TEX1` off the disc: bilinear on every texture in the corpus, and a mipmap chain on the ground and
  // detail textures that ask for one (`MMIN = LINEAR_MIPMAP_LINEAR`). The hardware was given one or
  // two levels; three generates the whole chain, which is the same picture near and a calmer one far.
  texture.magFilter = spec.bilinear ? LinearFilter : NearestFilter;
  texture.minFilter = spec.mipmaps ? LinearMipmapLinearFilter : spec.bilinear ? LinearFilter : NearestFilter;
  texture.generateMipmaps = spec.mipmaps;
  // `CLAMP` off the disc, per axis. A glow's quad clamps so the bilinear tap at u = 1 cannot fetch
  // u = 0 and draw the quad's outline; a tiling wall repeats.
  texture.wrapS = spec.wrapS === 'clamp' ? ClampToEdgeWrapping : RepeatWrapping;
  texture.wrapT = spec.wrapT === 'clamp' ? ClampToEdgeWrapping : RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
