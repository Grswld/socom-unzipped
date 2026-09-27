import type { Camera, Scene } from 'three';
import { Color, LinearSRGBColorSpace } from 'three';
import { WebGPURenderer } from 'three/webgpu';

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
  const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: false });
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
  return {
    renderer,
    backend,
    render: (scene, camera) => renderer.render(scene, camera),
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
    setClearColor: ([r, g, b]) => {
      // setRGB on the working space, not setHex: FOGCOL is a raw register value and must not be decoded.
      renderer.setClearColor(new Color().setRGB(r / 255, g / 255, b / 255), 1);
    },
  };
}
