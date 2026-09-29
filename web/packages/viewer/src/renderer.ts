import type { Camera, Object3D } from 'three';
import { Color, InstancedMesh, LinearSRGBColorSpace, LineSegments, Mesh, NearestFilter, RenderTarget, Scene, SkinnedMesh } from 'three';
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from 'three/webgpu';
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
}

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
      // The PS2 frame's target is set only for the call's synchronous part, where the renderer takes its list and its
      // render context: held across the awaits, the frames drawn meanwhile rendered into the target they then read
      // (a WebGL feedback loop, research 90 item 19's warm-ups made it show).
      const compile = (target: Object3D): Promise<void> => {
        const previous = renderer.getRenderTarget();
        if (mode === 'ps2') renderer.setRenderTarget(frame);
        try { return renderer.compileAsync(target, camera); } finally { renderer.setRenderTarget(previous); }
      };
      // What is shown: the scene itself, with the frustum test off for the call -- the picture is the same, every
      // shown object is compiled whichever way the camera faces. The live objects, not stand-ins: a program is
      // specific to more than the material and the geometry (stand-ins left the jungle's trees to compile later).
      const culled: { object: Object3D; culled: boolean }[] = [];
      scene.traverseVisible((o) => { culled.push({ object: o, culled: o.frustumCulled }); o.frustumCulled = false; });
      let shownCompiled: Promise<void>;
      try {
        shownCompiled = compile(scene);
      } finally {
        for (const { object, culled: c } of culled) object.frustumCulled = c;   // the list is taken
      }
      await shownCompiled;
      // What is hidden -- a LOD copy out of range, the SEAL in fly mode, a pass switched off, the fading twins
      // (`extras`) -- through stand-ins in a scene of their own, so nothing hidden is ever drawn while this runs.
      const proxies = new Scene();
      proxies.fog = scene.fog;
      proxies.fogNode = scene.fogNode;
      const shown = new Set<Object3D>();
      scene.traverseVisible((o) => shown.add(o));
      const add = (o: Object3D): void => {
        if (shown.has(o)) return;
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
      scene.traverse(add);
      for (const e of extras) e.traverse(add);
      await compile(proxies);
    },
    setClearColor: ([r, g, b]) => {
      // setRGB on the working space, not setHex: FOGCOL is a raw register value and must not be decoded.
      renderer.setClearColor(new Color().setRGB(r / 255, g / 255, b / 255), 1);
    },
  };
}
