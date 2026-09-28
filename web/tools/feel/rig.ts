import type { WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../../packages/viewer/src/camera';
import { padInput, type GamepadLike } from '../../packages/viewer/src/gamepad';
import { packGround, WalkMode, type GroundData, type Stance, type WalkCameraState } from '../../packages/viewer/src/walk';

/**
 * The viewer's walk, whole, with no page: the fly camera the keys, the pad and the look go through, and the walk mode
 * that ticks the mover and the game's camera -- the same objects `main.ts` makes, driven in its order (`fly.update`,
 * then `walk.frame`) at a chosen display rate. A synthetic world: a flat floor 4,000 across at y 0 and, far from the
 * origin, a 42-high deck (Frostfire's drop) to walk off.
 *
 * It runs under vitest's jsdom and under plain node (`feel-parity.ts`): `ensureDom` gives node the little the fly
 * camera asks of a page (a global event target for the keys, an `HTMLElement` for its focus test).
 */

/** Where the deck is: x and z from 1000 to 1200, its top at 42. */
export const DECK = { min: 1000, max: 1200, y: 42 } as const;

function floor(minX: number, minZ: number, maxX: number, maxZ: number, y: number): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]),
  };
}

/** The flat floor and the deck, as the worker hands a map's hull to the page. */
export function feelGround(): GroundData {
  return packGround(
    { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 20, cellsZ: 20, originX: -2000, originZ: -2000 },
    [floor(-2000, -2000, 2000, 2000, 0), floor(DECK.min, DECK.min, DECK.max, DECK.max, DECK.y)],
    [
      { modelName: 'worldmodel', path: 'worldmodel/ground', first: 0, count: 1 },
      { modelName: 'worldmodel', path: 'worldmodel/deck', first: 1, count: 1 },
    ],
  );
}

type Loose = Record<string, unknown>;

/** Node has no window: a global event target for the fly camera's key listeners, and an `HTMLElement` to test against. */
export function ensureDom(): void {
  const g = globalThis as unknown as Loose;
  if (typeof g['addEventListener'] !== 'function') {
    const bus = new EventTarget();
    g['addEventListener'] = bus.addEventListener.bind(bus);
    g['removeEventListener'] = bus.removeEventListener.bind(bus);
    g['dispatchEvent'] = bus.dispatchEvent.bind(bus);
  }
  if (typeof g['HTMLElement'] === 'undefined') g['HTMLElement'] = class {};
}

function canvas(): HTMLCanvasElement {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.setPointerCapture = () => undefined;
    c.releasePointerCapture = () => undefined;
    c.hasPointerCapture = () => false;
    return c;
  }
  return new EventTarget() as unknown as HTMLCanvasElement;
}

function key(type: 'keydown' | 'keyup', code: string): void {
  let e: Event;
  if (typeof KeyboardEvent !== 'undefined') e = new KeyboardEvent(type, { code });
  else {
    e = new Event(type);
    Object.defineProperty(e, 'code', { value: code });
  }
  globalThis.dispatchEvent(e);
}

/** What a hold presses: keyboard codes (`KeyW`, `ArrowLeft`), and a pad's four stick axes (the Gamepad API's). */
export interface HoldInput {
  keys?: readonly string[];
  /** The pad's axes: [left x, left y (up negative), right x, right y (up negative)], -1..1 as a browser reads them. */
  pad?: readonly number[];
}

/** One display frame after the walk's step: the mover and the camera as the page would draw them. */
export interface Sample {
  t: number;
  feet: [number, number, number];
  /** The feet as drawn this frame (between the last two ticks): what the camera was placed over. */
  drawn: [number, number, number];
  speed: number;
  yaw: number;
  pitch: number;
  airborne: boolean;
  camera: WalkCameraState;
  /** The look law's axes (x right, y up) and the turn, rad/s left positive. */
  axis: [number, number];
  turnRate: number;
}

/** The fly camera is made once per process (it has no way to let go of its listeners); every walk is new. */
let shared: FlyCamera | null = null;

export class FeelRig {
  readonly fly: FlyCamera;
  readonly walk: WalkMode;
  private held: string[] = [];
  private t = 0;

  constructor(stance: Stance = 'stand', at: { x: number; z: number; y?: number; yaw?: number } = { x: 0, z: 0 }) {
    ensureDom();
    shared ??= new FlyCamera(canvas());
    this.fly = shared;
    this.fly.setStick(0, 0);
    this.fly.setLook(0, 0);
    this.fly.setWalking(false);
    this.walk = new WalkMode(this.fly);
    this.walk.setGround(feelGround(), [0, 0, 0]);
    this.walk.setStance(stance);
    this.fly.setPose({ x: at.x, y: (at.y ?? 0) + 15.4, z: at.z, yaw: at.yaw ?? 0, pitch: 0 });
    if (!this.walk.setMode('walk')) throw new Error('feel rig: no floor to stand on');
  }

  /** Seconds of display frames at `fps` with this input held, then let go (unless `keep`); a sample per frame. */
  hold(seconds: number, input: HoldInput, fps = 60, keep = false): Sample[] {
    this.press(input);
    const out = this.run(seconds, fps);
    if (!keep) this.release();
    return out;
  }

  /** Seconds of frames with whatever is held. */
  run(seconds: number, fps = 60): Sample[] {
    const dt = 1 / fps, out: Sample[] = [];
    for (let i = Math.round(seconds * fps); i > 0; i--) {
      this.fly.update(dt);
      this.walk.frame(dt);
      this.t += dt;
      out.push(this.sample());
    }
    return out;
  }

  press(input: HoldInput): void {
    for (const code of input.keys ?? []) {
      if (!this.held.includes(code)) { key('keydown', code); this.held.push(code); }
    }
    if (input.pad) {
      const pad: GamepadLike = { axes: [...input.pad], buttons: [] };
      const i = padInput(pad);
      this.fly.setStick(i.moveX, i.moveY);
      this.fly.setLook(i.lookX, i.lookY);
    }
  }

  release(): void {
    for (const code of this.held.splice(0)) key('keyup', code);
    this.fly.setStick(0, 0);
    this.fly.setLook(0, 0);
  }

  sample(): Sample {
    const look = this.fly.lookState(), pose = this.fly.pose();
    return {
      t: this.t, feet: this.walk.feet()!, drawn: this.walk.drawnFeet()!, speed: this.walk.speed(), yaw: pose.yaw, pitch: pose.pitch,
      airborne: this.walk.mover()!.airborne, camera: this.walk.cameraState()!, axis: look.axis, turnRate: look.turnRate,
    };
  }
}

/** A browser's reading of a PS2 stick byte: -1 at 0, +1 at 255 (the pad reader's `(127.5 - b) / 127.5`, negated). */
export const axisOfByte = (byte: number): number => (byte - 127.5) / 127.5;
