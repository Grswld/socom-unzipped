import {
  buildGrid, cellAt, isWallSurface, probeGround, ringCells, selectFloor, upNormal, PROBE_LIFT,
  type CollisionOwner, type Grid, type GridParams, type Hit, type WorldPoly,
} from '@s2u/scene';
import { ACCEL, BRAKE, glide, type GroundWish, type Pose } from './camera';

/**
 * Walk mode (web sprint 1, W1.4): a mover that stands on the floor the engine's probe finds, slides along the
 * walls research 24 names, and looks from the SEAL's eye height -- the first thing in `web/` that ticks.
 *
 * - **The tick.** `CGame::Tick` (`FUN_001E7040`) runs the game at 60 Hz (web/docs/research/71 section 1.5). The
 *   mover steps on that clock from a fixed-step accumulator the page feeds real time into, so it takes the same
 *   steps at 30 fps and at 240 fps; the eye is drawn between the last two steps (`eye`).
 * - **The motion.** The fly camera's velocity model (`camera.ts`, `glide`: a ramp up at `ACCEL`, a glide down at
 *   `BRAKE`, in closed form), on the ground plane, at the SEAL's run of about 40 units a second (research 18,
 *   Finding 3: "sustained forward speed is better estimated at ~40 units/s").
 * - **The floor.** After each step `probeGround` at the new (x, z) and `selectFloor` from the origin y + 5 with
 *   the feet at y (research 23 section 1.1-1.2, research 24 section 2), and the feet snap to it. No floor, and the
 *   step is refused.
 * - **The walls.** Research 24 section 2 step 3: a polygon with bit 1 set, bit 18 clear and `|n_y| < 0.7`, met by
 *   the body's column from y + 6 to y + 20 at radius 3.5 (W1.R2); the mover is pushed out along the wall until it
 *   is 3.5 from it, and keeps the part of its step that runs along it. The game's movement collision is not
 *   decompiled -- that walls stop the mover is research 24's inference from the 3c trails, which stand off wall
 *   planes at 4.4-5.8 (section 4.1).
 * - **The eye.** 15.4 over the feet (W1.R2): the console's look-at target, 15.38 over the actor at rest (research
 *   17 section 1). A first-person eye; the third-person camera's own offset and smoothing are not this.
 * - **Drops.** The game's selection takes a floor however far below it is -- the 20-unit window bounds a pick over
 *   the feet (research 23 section 1.1 item 9), and stepping off Frostfire's walkway deck is a 42-unit fall
 *   (research 24 section 7.4). The viewer does not model falling: a floor more than `MAX_DROP` under the feet
 *   refuses the step, the plan's conservative reading. The mirror of the 20 window is the viewer's choice, not the
 *   game's.
 */

/** Seconds per tick: `CGame::Tick` at 60 Hz (web/docs/research/71 section 1.5). */
export const TICK = 1 / 60;
/** The eye over the feet (W1.R2; research 17 section 1, the look-at target at 15.38). */
export const EYE_HEIGHT = 15.4;
/** The body's radius against walls (W1.R2; research 24 section 2 step 3, section 4.1). */
export const BODY_RADIUS = 3.5;
/** The body's column over the feet that a wall has to reach into (research 24 section 2 step 3: y + 6 to y + 20). */
export const BODY_LOW = 6, BODY_HIGH = 20;
/** Units a second at a run (research 18, Finding 3). */
export const WALK_SPEED = 40;
/** The boost's multiple on the ground: the viewer's convenience for crossing a large map, not a game speed. */
export const BOOST = 2.5;
/** A floor further than this under the feet refuses the step: the game would fall, the viewer stays. */
export const MAX_DROP = 20;
/** No step moves further than this at once, so a wall 3.5 away cannot be stepped through at any speed. */
const MAX_SUBSTEP = 1;
/** Ticks one `advance` may run: a stalled tab catches up this far and drops the rest (the page caps dt at 0.1 s). */
const MAX_TICKS = 30;
/** How many times the walls are revisited in one step, for a corner where one push leads into the next wall. */
const WALL_PASSES = 4;

/** What the mover is asked to do each tick: `camera.ts`'s ground-plane wish, from the keys or the touch stick. */
export type WalkInput = GroundWish;

/**
 * What the worker hands the page for the walk: the probe's polygon set (`worldCollision`, 3,318 on Frostfire,
 * research 24 section 1.1), its nodes (`collisionOwners`: the probe's per-model unit and the gate's flags) and the
 * map's `grid_params`. The polygons travel packed in two typed arrays the worker transfers: as objects, Guidance's
 * 18,464 took 44 ms to clone (measured 2026-09-28), part of it on the page's thread at every map load.
 */
export interface GroundData {
  grid: GridParams;
  owners: CollisionOwner[];
  /** Every polygon's points, xyz, polygon after polygon in `worldCollision` order. */
  points: Float32Array;
  /** Per polygon, `GROUND_FIELDS` words: ptcount, ditype, material, cameratype, region. */
  fields: Uint32Array;
}
const GROUND_FIELDS = 5;

/** Packs a map's hull for the trip from the worker (`GroundData`). */
export function packGround(grid: GridParams, polys: readonly WorldPoly[], owners: CollisionOwner[]): GroundData {
  let floats = 0;
  for (const p of polys) floats += p.points.length;
  const points = new Float32Array(floats);
  const fields = new Uint32Array(polys.length * GROUND_FIELDS);
  let at = 0;
  polys.forEach((p, i) => {
    points.set(p.points, at);
    at += p.points.length;
    fields.set([p.ptcount, p.ditype, p.material, p.cameratype, p.region >>> 0], i * GROUND_FIELDS);
  });
  return { grid, owners, points, fields };
}

/** The polygons back out of a `GroundData`, their points views on its buffer, named by the node that owns them. */
export function groundPolygons(ground: GroundData): WorldPoly[] {
  const count = ground.fields.length / GROUND_FIELDS;
  const owner: (CollisionOwner | undefined)[] = new Array(count);
  for (const o of ground.owners) for (let i = o.first; i < Math.min(count, o.first + o.count); i++) owner[i] = o;
  const out: WorldPoly[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const f = i * GROUND_FIELDS, ptcount = ground.fields[f]!;
    out.push({
      modelName: owner[i]?.modelName ?? 'worldmodel', path: owner[i]?.path ?? '',
      ptcount, ditype: ground.fields[f + 1]!, material: ground.fields[f + 2]!, cameratype: ground.fields[f + 3]!,
      region: ground.fields[f + 4]!, points: ground.points.subarray(at, at + ptcount * 3),
    });
    at += ptcount * 3;
  }
  return out;
}

/** The grid the probe walks, from what the worker sent: only the collision is linked, which is all it reads. */
export function groundGrid(ground: GroundData): Grid {
  return buildGrid(ground.grid, [], [], groundPolygons(ground), ground.owners);
}

/** The mover's state: feet position, look (degrees, as `Pose`), and velocity on the ground plane. */
export interface WalkState { x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vz: number }

/** A wall polygon with what the step needs of it computed once. */
interface Wall {
  poly: WorldPoly;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
  /** The unit normal's horizontal part, normalised: the direction a push leaves the wall along. */
  nx: number; nz: number;
}

function wallOf(poly: WorldPoly): Wall | null {
  const n = upNormal(poly);
  if (n === null) return null;
  const h = Math.hypot(n[0], n[2]);
  if (h < 1e-9) return null;
  const p = poly.points;
  const wall: Wall = { poly, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity, nx: n[0] / h, nz: n[2] / h };
  for (let i = 0; i < p.length; i += 3) {
    wall.minX = Math.min(wall.minX, p[i]!); wall.maxX = Math.max(wall.maxX, p[i]!);
    wall.minY = Math.min(wall.minY, p[i + 1]!); wall.maxY = Math.max(wall.maxY, p[i + 1]!);
    wall.minZ = Math.min(wall.minZ, p[i + 2]!); wall.maxZ = Math.max(wall.maxZ, p[i + 2]!);
  }
  return wall;
}

/**
 * The part of a polygon between two heights, as its footprint: Sutherland-Hodgman against y >= lo and y <= hi,
 * then the x and z of what is left, flattened. A vertical wall's footprint is a segment; a leaning one's has area.
 */
function bandFootprint(points: Float32Array, lo: number, hi: number): number[] {
  let poly: number[][] = [];
  for (let i = 0; i < points.length; i += 3) poly.push([points[i]!, points[i + 1]!, points[i + 2]!]);
  const clip = (inside: (y: number) => boolean, at: number): void => {
    const out: number[][] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const ina = inside(a[1]!), inb = inside(b[1]!);
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = (at - a[1]!) / (b[1]! - a[1]!);
        out.push([a[0]! + t * (b[0]! - a[0]!), at, a[2]! + t * (b[2]! - a[2]!)]);
      }
    }
    poly = out;
  };
  clip((y) => y >= lo, lo);
  if (poly.length) clip((y) => y <= hi, hi);
  const xz: number[] = [];
  for (const p of poly) xz.push(p[0]!, p[2]!);
  return xz;
}

/** The nearest point of a convex footprint (x, z pairs) to (x, z), and whether (x, z) is inside it. */
function nearest(xz: number[], x: number, z: number): { x: number; z: number; d: number; inside: boolean } {
  const n = xz.length / 2;
  let best = { x: xz[0]!, z: xz[1]!, d: Math.hypot(x - xz[0]!, z - xz[1]!) };
  let left = false, right = false, area = 0;
  for (let i = 0; i < n; i++) {
    const ax = xz[i * 2]!, az = xz[i * 2 + 1]!, bx = xz[((i + 1) % n) * 2]!, bz = xz[((i + 1) % n) * 2 + 1]!;
    const ex = bx - ax, ez = bz - az, len = ex * ex + ez * ez;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len)) : 0;
    const px = ax + t * ex, pz = az + t * ez, d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { x: px, z: pz, d };
    const cross = ex * (z - az) - ez * (x - ax);
    if (cross > 1e-9) left = true; else if (cross < -1e-9) right = true;
    area += ax * bz - bx * az;
  }
  return { ...best, inside: Math.abs(area) > 1e-6 && !(left && right) };
}

/**
 * The mover. `advance` is what the page calls each frame; `tick` is one 60 Hz step; `place` stands it on the floor
 * under a point. The page reads `eye` for the camera and writes `state.yaw` / `state.pitch` from the look.
 */
export class Walker {
  readonly state: WalkState = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0 };
  /** The feet before the last tick, for drawing the eye between ticks. */
  private prev = { x: 0, y: 0, z: 0 };
  /** Real time not yet stepped, in seconds, under one tick. */
  private accumulator = 0;
  private readonly wallsByCell = new Map<number, Wall[]>();
  /** The walls of the 3 x 3 cells around the mover's cell, kept until it changes cell. */
  private near: { cell: number; walls: Wall[] } | null = null;

  constructor(readonly grid: Grid) {}

  /**
   * Stands the mover on the floor under (x, fromY, z): the probe's highest floor at or under `fromY` + 1, else
   * the lowest within 20 over `fromY` - 5 -- the selection with the origin at `fromY`. Pass the camera's eye to
   * drop from where the camera is. False, and nothing moves, when there is no floor there.
   */
  place(x: number, fromY: number, z: number): boolean {
    const floor = selectFloor(probeGround(this.grid, x, z), fromY, fromY - PROBE_LIFT);
    if (!floor) return false;
    Object.assign(this.state, { x, y: floor.y, z, vx: 0, vz: 0 });
    this.prev = { x, y: floor.y, z };
    this.accumulator = 0;
    return true;
  }

  /** Feeds `seconds` of real time in and runs the whole ticks it makes; returns how many ran. */
  advance(seconds: number, input: WalkInput): number {
    this.accumulator += Math.max(0, seconds);
    let ticks = 0;
    while (this.accumulator >= TICK - 1e-9 && ticks < MAX_TICKS) {
      this.tick(input);
      this.accumulator -= TICK;
      ticks++;
    }
    if (this.accumulator >= TICK) this.accumulator = 0;          // a backlog past MAX_TICKS is dropped, not run
    return ticks;
  }

  /** Drops the part-tick in hand, so the eye is exactly over the feet: after a run of ticks driven by hand. */
  settle(): void {
    this.prev = { x: this.state.x, y: this.state.y, z: this.state.z };
    this.accumulator = 0;
  }

  /** The eye, 15.4 over the feet, drawn between the last two ticks by the time left over in the accumulator. */
  eye(): [number, number, number] {
    const s = this.state, t = Math.max(0, Math.min(1, this.accumulator / TICK));
    return [
      this.prev.x + (s.x - this.prev.x) * t,
      this.prev.y + (s.y - this.prev.y) * t + EYE_HEIGHT,
      this.prev.z + (s.z - this.prev.z) * t,
    ];
  }

  /** One 60 Hz step: the velocity model on the ground plane, then the move, the walls and the floor. */
  tick(input: WalkInput, dt: number = TICK): void {
    const s = this.state;
    this.prev = { x: s.x, y: s.y, z: s.z };
    const yaw = (s.yaw * Math.PI) / 180;
    // The camera looks down its own -z (`camera.ts`): forward is (-sin, -cos), right is (cos, -sin).
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let forward = input.forward, right = input.right;
    const length = Math.hypot(forward, right);
    if (length > 1) { forward /= length; right /= length; }
    const moving = length > 0;
    const cruise = WALK_SPEED * (input.boost ? BOOST : 1);
    const rate = moving ? ACCEL : BRAKE;
    const gx = glide(s.vx, (fx * forward + rx * right) * cruise, rate, dt);
    const gz = glide(s.vz, (fz * forward + rz * right) * cruise, rate, dt);
    s.vx = gx.velocity;
    s.vz = gz.velocity;
    if (!moving && s.vx * s.vx + s.vz * s.vz < 1e-4) { s.vx = 0; s.vz = 0; }
    const distance = Math.hypot(gx.moved, gz.moved);
    if (distance === 0) return;
    const parts = Math.ceil(distance / MAX_SUBSTEP);
    for (let i = 0; i < parts; i++) this.step(gx.moved / parts, gz.moved / parts);
  }

  /** The floor the feet would stand on at (x, z), or null: none, or one more than `MAX_DROP` under them. */
  private floorAt(x: number, z: number): Hit | null {
    const s = this.state;
    const floor = selectFloor(probeGround(this.grid, x, z), s.y + PROBE_LIFT, s.y);
    return floor && floor.y >= s.y - MAX_DROP ? floor : null;
  }

  /**
   * One sub-step: move, slide off the walls, then stand on the floor there. A step with no floor is tried again as
   * its part along x and its part along z, so a mover pressed diagonally against an edge runs along it rather
   * than stopping dead; with no floor for either, it stays where it was.
   */
  private step(dx: number, dz: number): void {
    const s = this.state;
    for (const [ax, az] of [[dx, dz], [dx, 0], [0, dz]] as const) {
      if (ax === 0 && az === 0) continue;
      const [x, z] = this.slide(s.x + ax, s.z + az, s.x, s.z);
      const floor = this.floorAt(x, z);
      if (!floor) continue;
      s.x = x; s.y = floor.y; s.z = z;
      return;
    }
  }

  /**
   * Pushes (x, z) out of every wall the body's column meets until it is `BODY_RADIUS` from each, and takes the
   * velocity's part into a wall away (research 24 section 2 step 3). A mover already inside a wall's footprint is
   * pushed out to the side it came from.
   */
  private slide(x: number, z: number, fromX: number, fromZ: number): [number, number] {
    const s = this.state;
    const lo = s.y + BODY_LOW, hi = s.y + BODY_HIGH, r = BODY_RADIUS;
    const walls = this.wallsNear(x, z);
    for (let pass = 0; pass < WALL_PASSES; pass++) {
      let pushed = false;
      for (const w of walls) {
        if (w.maxY <= lo || w.minY >= hi) continue;
        if (x < w.minX - r || x > w.maxX + r || z < w.minZ - r || z > w.maxZ + r) continue;
        const band = bandFootprint(w.poly.points, lo, hi);
        if (band.length < 4) continue;
        const near = nearest(band, x, z);
        if (near.d >= r && !near.inside) continue;
        let ux: number, uz: number, push: number;
        if (near.d > 1e-9 && !near.inside) {
          ux = (x - near.x) / near.d; uz = (z - near.z) / near.d; push = r - near.d;
        } else {
          const side = (fromX - near.x) * w.nx + (fromZ - near.z) * w.nz;
          ux = side >= 0 ? w.nx : -w.nx; uz = side >= 0 ? w.nz : -w.nz;
          let far = 0;
          for (let i = 0; i < band.length; i += 2) far = Math.max(far, (band[i]! - x) * ux + (band[i + 1]! - z) * uz);
          push = far + r;
        }
        x += ux * push; z += uz * push;
        const into = s.vx * ux + s.vz * uz;
        if (into < 0) { s.vx -= into * ux; s.vz -= into * uz; }
        pushed = true;
      }
      if (!pushed) break;
    }
    return [x, z];
  }

  /** The wall polygons of the mover's cell and its eight neighbours (`ringCells`' square ring 1), each once. */
  private wallsNear(x: number, z: number): Wall[] {
    const cell = cellAt(this.grid, x, z).index;
    if (this.near?.cell === cell) return this.near.walls;
    const seen = new Set<WorldPoly>();
    const walls: Wall[] = [];
    for (const { cell: c } of ringCells(this.grid, x, z, 1, 'square')) {
      for (const w of this.wallsOf(c.index)) {
        if (seen.has(w.poly)) continue;
        seen.add(w.poly);
        walls.push(w);
      }
    }
    this.near = { cell, walls };
    return walls;
  }

  private wallsOf(index: number): Wall[] {
    const known = this.wallsByCell.get(index);
    if (known) return known;
    const walls: Wall[] = [];
    for (const atom of this.grid.cells[index]!.atoms) {
      if (atom.object.kind !== 'collision') continue;
      for (const poly of atom.object.polys) {
        if (!isWallSurface(poly)) continue;
        const w = wallOf(poly);
        if (w) walls.push(w);
      }
    }
    this.wallsByCell.set(index, walls);
    return walls;
  }
}

/** The half of `FlyCamera` walk mode drives: the look it reads, the position it writes, the wish it steps by. */
export interface WalkCamera {
  pose(): Pose;
  setPose(pose: Partial<Pose>): void;
  moveTo(x: number, y: number, z: number): void;
  setWalking(on: boolean): void;
  groundWish(): GroundWish;
}

/**
 * Walk and fly, one switch (W1.4 step 5): `G` toggles it (nothing on Ctrl -- `camera.ts` says why), the panel's
 * "walk" box mirrors it through `onChange`, and the hook drives it for Playwright. Entering walk stands the mover on
 * the floor under the camera, or on spawn A when there is none there; the touch stick drives the mover because
 * the mover reads the camera's own wish (`groundWish`). `setCamera` from the hook sets the mover too.
 */
export class WalkMode {
  /** The map's ground, and the mover on it once walk is first asked for: the grid costs 15 ms on Guidance. */
  private ground: GroundData | undefined;
  private walker: Walker | null = null;
  private spawn: [number, number, number] | null = null;
  private walking = false;
  private bound: EventTarget | null = null;

  constructor(private readonly camera: WalkCamera, private readonly onChange: (walking: boolean) => void = () => undefined) {}

  /**
   * A map's ground and a point on the floor at its spawn A, or none: `main.ts` passes A's (x, z) at the opening
   * stand's floor (W1.4b, `./stand`), A's recorded y where the probe found none. A mover already walking is stood
   * again on the new map, under wherever the page has put the camera; with nothing to stand on it goes back to flying.
   */
  setGround(ground: GroundData | undefined, spawn: [number, number, number] | null): void {
    this.ground = ground;
    this.walker = null;
    this.spawn = spawn;
    if (!this.walking) return;
    if (this.stand()) this.follow();
    else this.leave();
  }

  mode(): 'walk' | 'fly' {
    return this.walking ? 'walk' : 'fly';
  }

  /** Walk or fly. False when walk was asked for and there is no floor to stand on: the mode stays fly. */
  setMode(mode: 'walk' | 'fly'): boolean {
    if (mode === 'fly') {
      if (this.walking) this.leave();
      return true;
    }
    if (this.walking) return true;
    if (!this.stand()) return false;
    this.walking = true;
    this.camera.setWalking(true);
    this.follow();
    this.onChange(true);
    return true;
  }

  /** One frame: the look goes to the mover, real time goes in, and the camera goes to the eye. */
  frame(dt: number): void {
    const w = this.walker;
    if (!this.walking || !w) return;
    const look = this.camera.pose();
    w.state.yaw = look.yaw;
    w.state.pitch = look.pitch;
    w.advance(dt, this.camera.groundWish());
    this.follow();
  }

  /**
   * The hook's pose, in walk mode as in fly: the look is taken as given, and a position is the eye to drop the mover
   * from, onto the floor under it. With no floor there the pose is honoured and the mode goes back to fly.
   */
  setCamera(pose: Partial<Pose>): void {
    this.camera.setPose(pose);
    const w = this.walker;
    if (!this.walking || !w) return;
    if (pose.x === undefined && pose.y === undefined && pose.z === undefined) { this.follow(); return; }
    const at = this.camera.pose();
    if (w.place(at.x, at.y, at.z)) this.follow();
    else this.leave();
  }

  /**
   * `seconds` of ticks with this input, run now rather than over frames, facing the camera's yaw -- the
   * frame-rate-proof way for a test to walk (`e2e/walk.spec.ts`). Returns the camera's pose at the end.
   */
  walkFor(seconds: number, input: WalkInput): Pose {
    const w = this.walker;
    if (!this.walking || !w) return this.camera.pose();
    const look = this.camera.pose();
    w.state.yaw = look.yaw;
    w.state.pitch = look.pitch;
    for (let i = Math.round(seconds / TICK); i > 0; i--) w.tick(input);
    w.settle();
    this.follow();
    return this.camera.pose();
  }

  /** The mover's feet while walking, else null. */
  feet(): [number, number, number] | null {
    const w = this.walker;
    return this.walking && w ? [w.state.x, w.state.y, w.state.z] : null;
  }

  /** `G` on `target`, ignored with a modifier, on auto-repeat, and while a control has the keyboard. */
  bindKey(target: EventTarget = globalThis): void {
    this.unbindKey();
    target.addEventListener('keydown', this.onKey as EventListener);
    this.bound = target;
  }

  unbindKey(): void {
    this.bound?.removeEventListener('keydown', this.onKey as EventListener);
    this.bound = null;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'KeyG' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    e.preventDefault();
    this.setMode(this.walking ? 'fly' : 'walk');
  };

  /** The floor under the camera, else spawn A's. */
  private stand(): boolean {
    if (!this.walker && this.ground) this.walker = new Walker(groundGrid(this.ground));
    const w = this.walker;
    if (!w) return false;
    const at = this.camera.pose();
    if (w.place(at.x, at.y, at.z)) return true;
    return this.spawn !== null && w.place(this.spawn[0], this.spawn[1] + EYE_HEIGHT, this.spawn[2]);
  }

  private leave(): void {
    this.walking = false;
    this.camera.setWalking(false);
    this.onChange(false);
  }

  private follow(): void {
    const [x, y, z] = this.walker!.eye();
    this.camera.moveTo(x, y, z);
  }
}
