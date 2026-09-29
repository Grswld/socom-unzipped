import type { Camera, Material, Object3D } from 'three';
import { Color, Group, InstancedMesh, LinearSRGBColorSpace, LineSegments, Mesh, NearestFilter, RenderTarget, Scene, SkinnedMesh } from 'three';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
import { CompileQueue, firstOfEachKind } from './compileQueue';
import { texture as textureNode, uv, vec4 } from 'three/tsl';

/** Which GPU API the pictures actually came out of, for the status line and the screenshot record. */
export type Backend = 'webgpu' | 'webgl2';

/**
 * How the frame is put on the screen. `native` draws at the canvas's own size and pixel ratio. `ps2`
 * draws the frame the console drew -- 640 by 448, the size `zVid_Init` sets and the NTSC field mode
 * displays -- and lets the page stretch it onto a 4:3 box, which is what the television did (the
 * DISPLAY register's 640 visible pixels on a 4:3 set are 0.93 wide each).
 */
export type Presentation = 'native' | 'ps2';
export const PS2_FRAME = { width: 640, height: 448 } as const;

export interface ViewerRenderer {
  renderer: WebGPURenderer;
  backend: Backend;
  render(scene: Scene, camera: Camera): void;
  /** The canvas's CSS size; what the backing store becomes depends on the presentation and the pixel ratio. */
  resize(width: number, height: number): void;
  /** The device pixels per CSS pixel the native presentation draws at; clamped to the device's own. */
  setPixelRatio(ratio: number): void;
  pixelRatio(): number;
  setPresentation(mode: Presentation): void;
  presentation(): Presentation;
  /**
   * The background. reCOM clears to the fog colour (`zrndr_pipe.cpp:157`,
   * `zVid_ClearColor(camera->m_fog_color.xyz)`), so the horizon a map fades into is the same colour it
   * fades with; there is no separate sky colour, the sky is a textured dome.
   */
  setClearColor(rgb: [number, number, number]): void;
  /**
   * Compiles every program and uploads every texture and buffer the scene can draw, before it is asked to: each
   * object shown for the call whatever its visibility (a LOD copy out of range, the body in fly mode, a pass
   * switched off) and whatever the camera sees, plus `extras` (a map's fading twins, built only when a copy fades),
   * then everything put back. Without it the first frame that turns toward a new texture or brings a LOD copy or the
   * SEAL into view pays for its compile then: one frame of 250-1,550 ms on Desert Glory, 380 ms on Crossroads.
   */
  warm(scene: Scene, camera: Camera, extras?: readonly Object3D[]): Promise<void>;
  /**
   * Compiles `objects` as `scene` will draw them, off the draw's critical path: three's `compileAsync` links each
   * program with `KHR_parallel_shader_compile` and yields between objects, where the draw that first meets an object
   * links its program synchronously (20 ms a program on ANGLE's D3D11, 181 of them on Guidance: 3.6 s of stalls
   * through the first seconds of play, research 90 item 17). Every draw under `objects` is compiled as `scene` draws
   * it, shown for the call, a few at a time in the order asked (a page-wide queue, so what is asked first links
   * first); an object not yet in the scene is parked in a scratch group until it is added. `screen` compiles for the
   * canvas (the HUD's passes) rather than for the world's picture (the PS2 look's target), `target` for a target of
   * its own (the characters' shadow map) with `override` as the scene's override material; `stale` drops the jobs
   * of a map already replaced.
   */
  prepare(objects: readonly Object3D[], scene: Scene, camera: Camera, options?: PrepareOptions): Promise<void>;
}

/**
 * A guess at which draws share a program, for `prepare`'s order only: the object's kind, its material's class, name
 * stem (the viewer names a material by what builds it -- `body x.tif`, `env y.tif`) and cache key, and its geometry's
 * attributes. A wrong guess costs a later link, never a wrong picture.
 */
function kindOf(o: Object3D): string {
  const m = (o as Object3D & { material?: Material | Material[] }).material;
  const material = Array.isArray(m) ? m[0] : m;
  const g = (o as Object3D & { geometry?: { attributes: Record<string, unknown> } }).geometry;
  const stem = (material?.name ?? '').split(' ')[0];
  return [o.type, material?.type, stem, material?.customProgramCacheKey?.(), Object.keys(g?.attributes ?? {}).sort().join(',')].join('|');
}

/** How many of `prepare`'s compiles are in flight at once. */
const PREPARE_LANES = 2;

/** `prepare`'s options: where the draws will go, and when they are no longer wanted. */
export interface PrepareOptions {
  /** How many compiles may be in flight while this call's jobs lead the queue (`PREPARE_LANES` by default). */
  lanes?: number;
  screen?: boolean;
  target?: RenderTarget;
  override?: Material;
  stale?: () => boolean;
}

/** One draw for `prepare`'s queue. */
interface PrepareJob extends PrepareOptions {
  draw: Object3D;
  scene: Scene;
  camera: Camera;
}

/** What three draws: a mesh, a line, points or a sprite. */
const DRAWN = (o: Object3D): boolean => {
  const f = o as Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return f.isMesh === true || f.isLine === true || f.isPoints === true || f.isSprite === true;
};

/** three's own backend flag. The base `Backend` type does not carry it, so it is read through this shape. */
interface BackendFlags { isWebGPUBackend?: boolean }

const BACKGROUND = 0x14161a;

/**
 * three's `WebGPURenderer`, which picks WebGPU when the browser offers an adapter and falls back to WebGL2
 * on its own otherwise -- headless Chromium usually lands on WebGL2 through SwiftShader. The viewer asks
 * for nothing WebGPU-specific, so the two paths draw the same scene; only the reported backend differs.
 */
export async function createRenderer(canvas: HTMLCanvasElement): Promise<ViewerRenderer> {
  // An opaque WebGPU canvas; the WebGL2 fallback ignores it (three's WebGLBackend forces alpha on), so
  // the real fix is that no world draw writes alpha (`blendFactorsFor`, `world.ts`).
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: false, alpha: false });
  await renderer.init();
  let ratio = Math.min(globalThis.devicePixelRatio, 2);
  let mode: Presentation = 'native';
  let cssWidth = 1;
  let cssHeight = 1;
  const apply = (): void => {
    if (mode === 'ps2') {
      renderer.setPixelRatio(1);
      renderer.setSize(PS2_FRAME.width, PS2_FRAME.height, false);
    } else {
      renderer.setPixelRatio(ratio);
      renderer.setSize(cssWidth, cssHeight, false);
    }
  };
  renderer.setPixelRatio(ratio);
  // The GS wrote its 8-bit result straight to the framebuffer, so the shader's product goes out
  // unconverted; the textures are read the same way (`world.ts`, `makeTexture`).
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.setClearColor(BACKGROUND, 1);
  const backend: Backend = (renderer.backend as BackendFlags).isWebGPUBackend === true ? 'webgpu' : 'webgl2';
  // The PS2 presentation draws the world as the GS did, with no antialiasing (the GS has none; the static
  // packet at 0x3E0880 sets DTHE 0 and nothing else smooths an edge): into a 640x448 target with no samples,
  // copied texel for texel onto the canvas. The canvas keeps its multisampling for the Modern picture -- it
  // is fixed when the context is made under WebGL2 -- and the HUD passes that follow draw onto the copy.
  const frame = new RenderTarget(PS2_FRAME.width, PS2_FRAME.height, { samples: 0, depthBuffer: true });
  frame.texture.minFilter = NearestFilter;
  frame.texture.magFilter = NearestFilter;
  const copy = new MeshBasicNodeMaterial();
  copy.colorNode = vec4(textureNode(frame.texture, uv()).rgb, 1);   // opaque: the page must never show through
  copy.depthTest = false;
  copy.depthWrite = false;
  const blit = new QuadMesh(copy);
  // `prepare`'s queue (`./compileQueue`), and where it parks what is not yet in a scene.
  const scratch = new Group();
  const queue = new CompileQueue(PREPARE_LANES);
  const compileOne = (job: PrepareJob): Promise<void> => {
    const { draw, scene, camera, screen, target, override } = job;
    // Shown and unculled for the call, its children hidden (each is a job of its own): compileAsync gathers its list
    // synchronously, before its first await, so the flags are back before any frame can draw a hidden object. The
    // render context is fixed there too: the PS2 picture's target for the world, the canvas for the HUD's passes.
    const visible = draw.visible, culled = draw.frustumCulled;
    const kids = draw.children.filter((c) => c.visible);
    draw.visible = true;
    draw.frustumCulled = false;
    for (const c of kids) c.visible = false;
    const previous = renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    renderer.setRenderTarget(target ?? (mode === 'ps2' && !screen ? frame : null));
    if (override) scene.overrideMaterial = override;
    try {
      return renderer.compileAsync(draw, camera, scene);
    } finally {
      renderer.setRenderTarget(previous);
      scene.overrideMaterial = previousOverride;
      for (const c of kids) c.visible = true;
      draw.visible = visible;
      draw.frustumCulled = culled;
    }
  };
  return {
    renderer,
    backend,
    render: (scene, camera) => {
      if (mode !== 'ps2') { renderer.render(scene, camera); return; }
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(frame);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      blit.render(renderer);
    },
    resize: (width, height) => { cssWidth = width; cssHeight = height; apply(); },
    setPixelRatio: (r) => {
      const next = Math.max(0.25, Math.min(globalThis.devicePixelRatio || 1, r));
      if (next === ratio) return;
      ratio = next;
      apply();
    },
    pixelRatio: () => ratio,
    setPresentation: (m) => { if (m !== mode) { mode = m; apply(); } },
    presentation: () => mode,
    warm: async (scene, camera, extras = []) => {
      const previous = renderer.getRenderTarget();
      if (mode === 'ps2') renderer.setRenderTarget(frame);
      // Everything in the scene, the live objects in their own scene -- a program is specific to more than the
      // material and the geometry, and a stand-in in a scene of its own linked a different one (the SEAL's gear, the
      // jungle's trees). Shown for the call and the frustum test off: compileAsync gathers its list synchronously
      // before its first await, so the flags are put back before any frame can draw a hidden object.
      const flags: { object: Object3D; visible: boolean; culled: boolean }[] = [];
      scene.traverse((o) => { flags.push({ object: o, visible: o.visible, culled: o.frustumCulled }); o.visible = true; o.frustumCulled = false; });
      let live: Promise<void>;
      try {
        live = renderer.compileAsync(scene, camera);
      } finally {
        for (const { object, visible, culled } of flags) { object.visible = visible; object.frustumCulled = culled; }
      }
      // What is not in the scene at all -- the fading twins (`extras`) -- through stand-ins in a scene of their own.
      const proxies = new Scene();
      proxies.fog = scene.fog;
      proxies.fogNode = scene.fogNode;
      const add = (o: Object3D): void => {
        let proxy: Object3D | null = null;
        if (o instanceof SkinnedMesh) {
          const m = new SkinnedMesh(o.geometry, o.material);
          m.bind(o.skeleton, o.bindMatrix);
          proxy = m;
        } else if (o instanceof InstancedMesh) {
          const m = new InstancedMesh(o.geometry, o.material, o.count);
          m.instanceMatrix = o.instanceMatrix;
          proxy = m;
        } else if (o instanceof Mesh) proxy = new Mesh(o.geometry, o.material);
        else if (o instanceof LineSegments) proxy = new LineSegments(o.geometry, o.material);
        if (!proxy) return;
        o.updateWorldMatrix(true, false);
        proxy.matrixAutoUpdate = false;
        proxy.matrix.copy(o.matrixWorld);
        proxy.matrixWorld.copy(o.matrixWorld);
        proxy.frustumCulled = false;
        proxies.add(proxy);
      };
      for (const e of extras) e.traverse(add);
      let stand: Promise<void>;
      try {
        stand = renderer.compileAsync(proxies, camera);
      } finally {
        renderer.setRenderTarget(previous);
      }
      await Promise.all([live, stand]);
    },
    prepare: (objects, scene, camera, options = {}) => {
      const draws: Object3D[] = [];
      const parked: Object3D[] = [];
      for (const o of objects) {
        if (o !== scene && !o.parent) { scratch.add(o); parked.push(o); }   // not yet in a scene: parked for the call
        o.traverse((c) => { if (DRAWN(c)) draws.push(c); });
      }
      // One draw of each kind first: the SEAL's two dozen parts are a handful of programs.
      return queue.add(firstOfEachKind(draws, kindOf).map((draw) => {
        const job: PrepareJob = { ...options, draw, scene, camera };
        return { lanes: options.lanes, stale: options.stale, run: () => compileOne(job) };
      })).then(() => { for (const o of parked) if (o.parent === scratch) scratch.remove(o); });   // as they came
    },
    setClearColor: ([r, g, b]) => {
      // setRGB on the working space, not setHex: FOGCOL is a raw register value and must not be decoded.
      renderer.setClearColor(new Color().setRGB(r / 255, g / 255, b / 255), 1);
    },
  };
}
