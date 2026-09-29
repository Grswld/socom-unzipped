import { parseRdr, rdrGet, Zar, zdbMember, type RdrNode, type ZdbEntry } from '@s2u/archive';
import {
  decodeEffectProgram, flattenScene, NODE_CALLER, NODE_ROOT, parseAnimSets, segmentHits, SURFACE_SKIP, surfaceWord,
  type CollisionOwner, type EffectCondition, type EffectOp, type EffectProgram, type Footprint, type Grid, type SceneNode,
} from '@s2u/scene';
import { EffectRun, type EffectHost, type OpTick } from './effectRunner';
import { apply4, invertAffine, matrixOfQuat, mul4, quatMul, quatOfMatrix, quatSlerp, type Quat } from './doorMath';
import { groundPolygons, type GroundData } from './mover';
import type { DoorWire } from './net/protocol';

/**
 * The map's doors (web/docs/research/92-doors.md): what the action button does to one, headless -- the page and the
 * multiplayer server run this same code (`./sim`).
 *
 * **The game's door** is a `DOOR` record of `READERM.ZAR/actions.rdr` (`node`, `valve`, `anim`, `range`, `elevation`;
 * the loader is `FUN_002b4230`, registered as `EXECUTE_ACTION`): the scene node that swings, the `CValve` that holds
 * its state (the short at `+4`: 0 shut, 1 open, 99 locked -- `FUN_002b46f0`), the `MZANIM.ZAR` animations that swing
 * it, and the reach. The action button (`FUN_00592d50`'s `0x2000` branch, decomp 452002-452022) takes the action on
 * the node under the reticle (`FUN_005aa240`, 463830: that node or one of its parents names an action, and the SEAL is
 * within `range` of the reticle's point on the ground plane and inside `elevation` in height); `FUN_002b44e0` (156787)
 * refuses it while the door's last animation still runs, else starts the animation `FUN_005ec4e0` picks (the second
 * of two only under its side test) with the node and the valve as its context (`FUN_00272bb0(anim, 1, 3, node, 4,
 * valve, ...)`) and logs the use to the net (`FUN_002bb5b0`). The animation does the rest: reads the valve, swings the
 * node's rotation to the other stop (`OBJECT_MOTION_FROM_TO` with its rotation flag, a quaternion slerp:
 * `FUN_0025fe70` / `FUN_0025f9b0`), plays the door's sound and sets the valve. Nothing shuts a door by itself.
 *
 * **Here** a door is its node's matrices, the collision owners under the node -- the leaf's polygons, turned in place
 * in the hull (`CollisionOwner.sweep` readies the grid and the mover for that) -- and its animations decoded
 * (`decodeEffectProgram`), run by the effects' sequencer (`./effectRunner`) with a host that knows the door's node and
 * valves. The page draws the leaf where the hooks say (`WorldView.moveNode`); the server sends `wire` in its snapshots.
 */

/** One door of a map, as the worker hands it to the page and the server reads it: plain data. */
export interface DoorSpec {
  /** Its place among the map's doors (the `DOOR` records of `actions.rdr`, in order): its number on the wire. */
  index: number;
  /** The scene node that swings (`bdoor_4`), and its path in the scene walk (`WorldView.moveNode`). */
  node: string;
  path: string;
  /** The `CValve` that holds its state. */
  valve: string;
  /** `range`: how far from the reticle's point on the leaf the SEAL may stand, on the ground plane; `elevation` in height, -1 for any. */
  range: number;
  elevation: number;
  /** The animations `anim` names that the map holds, decoded, in its order: the first is the swing, a second the kick. */
  programs: EffectProgram[];
  /** The node's own matrix as the disc holds it (row-major, row vectors), and its parent's world matrix. */
  local: number[];
  parent: number[];
  /** Indices into the hull's owners (`GroundData.owners`): the polygons that swing with it. */
  owners: number[];
  /** The ground-plane box the leaf can reach: the square round the hinge through the leaf's farthest point. */
  sweep: Footprint;
}

/** The valve value that locks a door (`FUN_002b46f0`, `FUN_005aa240`: `*(short *)(valve + 4) != 99`). */
export const VALVE_LOCKED = 99;

const one = (r: RdrNode[], k: string): string => {
  const v = rdrGet(r, k);
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
};
const all = (r: RdrNode[], k: string): string[] => {
  const v = rdrGet(r, k);
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? (v.flat(4) as RdrNode[]).filter((s): s is string => typeof s === 'string') : [];
};

/**
 * The `DOOR` actions of a map archive, each on its scene node with its polygons and animations; none on a map without
 * `actions.rdr`. `owners` are the hull's (`collisionOwners(models)`, indexing `polys`); the doors mark theirs with
 * `sweep` as they are found, so pack the ground after this. Never throws: what does not read is a diagnostic.
 */
export function readDoors(
  bytes: Uint8Array, toc: ZdbEntry[], models: SceneNode[], owners: CollisionOwner[], polys: readonly { points: Float32Array }[],
): { doors: DoorSpec[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let records: RdrNode[][];
  try {
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const key = readerm.root.children.find((k) => k.name.toLowerCase() === 'actions.rdr');
    if (!key) return { doors: [], diagnostics };
    const script = parseRdr(readerm.data(key));
    const root = Array.isArray(script) && Array.isArray(script[0]) && typeof script[0][0] === 'string' ? script[0] : script;
    const list = (rdrGet(root, 'actions') ?? []) as RdrNode[];
    records = list.filter((r): r is RdrNode[] => Array.isArray(r) && rdrGet(r, 'node') !== undefined);
  } catch (e) {
    return { doors: [], diagnostics: [`doors: actions.rdr: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const doorRecords = records.filter((r) => one(r, 'type').toUpperCase() === 'DOOR');
  if (doorRecords.length === 0) return { doors: [], diagnostics };
  let programs = new Map<string, EffectProgram>();
  try {
    const archive = parseAnimSets(Zar.parse(zdbMember(bytes, toc, 'MZANIM.ZAR')));
    programs = new Map(archive.sets.flatMap((s) => s.anims).map((a) => [a.name.toLowerCase(), decodeEffectProgram(a)]));
  } catch (e) {
    diagnostics.push(`doors: MZANIM.ZAR: ${e instanceof Error ? e.message : String(e)}`);
  }
  const flat = flattenScene(models, 'worldmodel');
  const doors: DoorSpec[] = [];
  for (const r of doorRecords) {
    const node = one(r, 'node');
    const at = flat.find((f) => f.node.name.toLowerCase() === node.toLowerCase());
    if (!at) { diagnostics.push(`doors: node ${node} is not placed`); continue; }
    const names = all(r, 'anim');
    const anims = names.map((a) => programs.get(a.toLowerCase()));
    // The first swings it; a second is the kick (`kick_door`, `FUN_005ec4e0`), not run here: a missing one costs a line.
    if (!anims[0]) { diagnostics.push(`doors: ${node}: animation ${names[0] ?? '(none)'} not in MZANIM.ZAR`); continue; }
    names.forEach((a, k) => { if (k > 0 && !anims[k]) diagnostics.push(`doors: ${node}: animation ${a} not in MZANIM.ZAR`); });
    const under = (p: string): boolean => p === at.path || p.startsWith(`${at.path}/`) || p.startsWith(`${at.path}=`);
    const mine = owners.map((o, i) => (under(o.path) ? i : -1)).filter((i) => i >= 0);
    if (mine.length === 0) diagnostics.push(`doors: ${node} has no collision under it`);
    const hinge = apply4(at.world, 0, 0, 0);
    let reach = 0;
    for (const i of mine) {
      const o = owners[i]!;
      for (const p of polys.slice(o.first, o.first + o.count)) {
        for (let k = 0; k < p.points.length; k += 3) reach = Math.max(reach, Math.hypot(p.points[k]! - hinge[0], p.points[k + 2]! - hinge[2]));
      }
    }
    const sweep: Footprint = { minX: hinge[0] - reach, maxX: hinge[0] + reach, minZ: hinge[2] - reach, maxZ: hinge[2] + reach };
    for (const i of mine) owners[i]!.sweep = sweep;
    const elevation = Number(one(r, 'elevation'));
    doors.push({
      index: doors.length, node: at.node.name, path: at.path, valve: one(r, 'valve'),
      range: Number(one(r, 'range')) || 0, elevation: one(r, 'elevation') === '' || !Number.isFinite(elevation) ? -1 : elevation,
      programs: anims.filter((p): p is EffectProgram => p !== undefined),
      local: Array.from(at.node.matrix), parent: Array.from(mul4(invertAffine(at.node.matrix), at.world)),
      owners: mine, sweep,
    });
  }
  return { doors, diagnostics };
}

/** `FUN_00353fd0`'s tests (the `VALVE` condition). */
export function valveTest(value: number, operation: number, operand: number): boolean {
  switch (operation) {
    case 0: return true;
    case 1: return value !== operand;
    case 2: return value === operand;
    case 3: return value > operand;
    case 4: return value < operand;
    case 5: return value >= operand;
    case 6: return value <= operand;
    default: return false;
  }
}

/** `FUN_00353fd0`'s operations: 0x0b set, 0x0c add, 0x0d subtract (not below 0), 0x0e multiply; the tests leave it. */
export function valveApply(value: number, operation: number, operand: number): number {
  switch (operation) {
    case 0x0b: return operand;
    case 0x0c: return value + operand;
    case 0x0d: return Math.max(0, value - operand);
    case 0x0e: return value * operand;
    default: return value;
  }
}

/** What the page lends the doors: a sound at a place, and the leaf drawn where it is now (a column-major delta). */
export interface DoorHooks {
  sound?(name: string, at: [number, number, number]): void;
  /** The door's leaf moved: `delta` (16 floats, three's column-major order) after the disc's placement. */
  moved?(door: DoorSpec, delta: Float32Array): void;
}

interface Door {
  spec: DoorSpec;
  /** The node's rotation now. */
  q: Quat;
  /** The node's world matrix at rest (as on the disc) and its inverse. */
  world0: Float32Array;
  inv0: Float32Array;
  /** The leaf's polygons at rest, world space, and where they live in the hull's points. */
  rest: { offset: number; points: Float32Array }[];
  run: EffectRun | null;
  /** The rotation now running: its seconds and how far it is. */
  swing: { seconds: number; t: number } | null;
  /** Muted: a swing replayed to catch up with the server makes no sound. */
  quiet: boolean;
  /** The server's last word on it (`applyWire`), for telling a new swing from one already followed. */
  seen: DoorWire | null;
}

/** The wire's phase of a door at rest (`DoorWire.phase`). */
export const PHASE_REST = 255;

export class DoorSet {
  private readonly doors: Door[];
  private readonly valves = new Map<string, number>();

  /**
   * `ground` is the hull the doors' polygons live in (the one the movers' grids read: its `points` are rewritten in
   * place), or null for a set that only draws (a page following a server keeps its own hull, so it passes it too).
   */
  constructor(readonly specs: readonly DoorSpec[], ground: GroundData | null, private readonly hooks: DoorHooks = {}) {
    // Each polygon's points are a view on the packed hull (`groundPolygons`): where it starts is its offset there.
    const polys = ground ? groundPolygons(ground) : [];
    const base = ground ? ground.points.byteOffset : 0;
    this.doors = specs.map((spec) => {
      const world0 = mul4(spec.local, spec.parent);
      const rest: Door['rest'] = [];
      for (const o of spec.owners) {
        const owner = ground?.owners[o];
        if (!owner) continue;
        for (const p of polys.slice(owner.first, owner.first + owner.count)) {
          rest.push({ offset: (p.points.byteOffset - base) / 4, points: Float32Array.from(p.points) });
        }
      }
      return { spec, q: quatOfMatrix(spec.local), world0, inv0: invertAffine(world0), rest, run: null, swing: null, quiet: false, seen: null };
    });
    this.hull = ground?.points ?? null;
  }

  private readonly hull: Float32Array | null;

  get count(): number {
    return this.doors.length;
  }

  /** A door's valve now. */
  valve(i: number): number {
    const d = this.doors[i];
    return d ? this.valves.get(d.spec.valve) ?? 0 : 0;
  }

  /** Open (its valve set and not locked), and whether an animation of it is still running. */
  state(i: number): { open: boolean; busy: boolean; valve: number } {
    const v = this.valve(i), d = this.doors[i];
    return { open: v !== 0 && v !== VALVE_LOCKED, busy: !!d?.run && !d.run.finished, valve: v };
  }

  /**
   * The action on door `i` (`FUN_002b44e0`): refused while its last animation runs, or when locked; else its first
   * animation starts. True when it started. `FUN_005ec4e0` picks the second (the `kick_door` of Sandstorm, Guidance,
   * Requiem, Chain Reaction) only past a speed threshold, for a team and a side it does not say enough of to model
   * [not modelled]; `from` (the SEAL's feet) is kept for it.
   */
  use(i: number, from: readonly number[] | null = null): boolean {
    void from;
    const d = this.doors[i];
    if (!d || this.state(i).busy || this.valve(i) === VALVE_LOCKED) return false;
    const program = d.spec.programs[0];
    if (!program) return false;
    d.run = new EffectRun(program, this.host(d), d);
    d.run.update(0);                                              // the timeless head runs now, as the game's first tick
    return true;
  }

  /** One step of every running door animation, `dt` seconds. */
  step(dt: number): void {
    for (const d of this.doors) {
      if (!d.run || d.run.finished) { d.run = null; continue; }
      d.run.update(dt);
      if (d.run.finished) { d.run = null; d.swing = null; d.quiet = false; }
    }
  }

  /** Every door for the snapshot (`DoorWire`): its valve and its swing's phase. */
  wire(): DoorWire[] {
    return this.doors.map((d, i) => {
      const s = d.swing;
      // Running, before its swing (a wait, a sound first) it reads 0; at rest, `PHASE_REST`.
      const phase = !d.run ? PHASE_REST : s ? Math.min(PHASE_REST - 1, Math.floor((s.t / Math.max(s.seconds, 1e-6)) * PHASE_REST)) : 0;
      return { valve: Math.min(255, Math.max(0, this.valve(i))), phase };
    });
  }

  /**
   * A server's doors (`Snapshot.doors`): a door whose valve the server has changed swings here too -- its animation run
   * from this side's state, caught up to the server's phase (silently when the server's swing is already over).
   */
  applyWire(wire: readonly DoorWire[] | undefined): void {
    if (!wire) return;
    wire.forEach((w, i) => {
      const d = this.doors[i];
      if (!d) return;
      const seen = d.seen;
      d.seen = { ...w };
      if (d.run) return;
      // A swing the server began since the last snapshot (its phase left rest, or started over): run it here too,
      // caught up to the server's phase, heard.
      const began = w.phase < PHASE_REST && (!seen || seen.phase === PHASE_REST || w.phase < seen.phase);
      if (began) {
        if (!this.use(i, null)) return;
        const seconds = d.swing?.seconds ?? 0;
        if (seconds > 0 && w.phase > 0) { const s = d.swing!; s.t += (w.phase / PHASE_REST) * seconds - 1 / 60; }
        return;
      }
      // At rest on the server with another valve (a join mid-round, a lost swing): run it out now, silently.
      if (w.phase === PHASE_REST && this.valve(i) !== w.valve) {
        d.quiet = true;                                            // before the use: its head plays the sound at once
        if (!this.use(i, null)) { d.quiet = false; return; }
        for (let k = 0; k < 1200 && d.run; k++) this.step(1 / 60);
        d.quiet = false;
      }
    });
  }

  /** The door whose polygons `owner` is among, or -1 (`pickDoor`). */
  doorOf(ownerPath: string): number {
    const under = (path: string, p: string): boolean => p === path || p.startsWith(`${path}/`) || p.startsWith(`${path}=`);
    return this.doors.findIndex((d) => under(d.spec.path, ownerPath));
  }

  /** The leaf's polygons as they stand now, world space (for a reach test with no grid). */
  leaf(i: number): Float32Array[] {
    const d = this.doors[i];
    if (!d) return [];
    const m = this.delta(d);
    return d.rest.map((r) => {
      const out = new Float32Array(r.points.length);
      for (let k = 0; k < r.points.length; k += 3) out.set(apply4(m, r.points[k]!, r.points[k + 1]!, r.points[k + 2]!), k);
      return out;
    });
  }

  /** `inv(W0) W`: the leaf's move from rest to now, row-major. */
  private delta(d: Door): Float32Array {
    return mul4(d.inv0, mul4(matrixOfQuat(d.q, d.spec.local), d.spec.parent));
  }

  /** The node at rotation `q`: its polygons rewritten in the hull, and the page told. */
  private pose(d: Door, q: Quat): void {
    d.q = q;
    const m = this.delta(d);
    if (this.hull) {
      for (const r of d.rest) {
        for (let k = 0; k < r.points.length; k += 3) this.hull.set(apply4(m, r.points[k]!, r.points[k + 1]!, r.points[k + 2]!), r.offset + k);
      }
    }
    // A row-major row-vector matrix is, float for float, three's column-major column-vector one (`toColumnMajor`).
    this.hooks.moved?.(d.spec, m);
  }

  private host(d: Door): EffectHost {
    const nodeIs = (run: EffectRun, node: number): boolean => {
      if (node === NODE_CALLER || node === NODE_ROOT) return true;
      const name = run.program.nodes[node];
      return name !== undefined && name.toLowerCase() === d.spec.node.toLowerCase();
    };
    /** A `VALVE` command's valve: the context's (flag bit 0: the door's own, `FUN_00272bb0`'s type 4), or the one named. */
    const valveName = (v: { valve: string; context?: true }): string => (v.context ? d.spec.valve : v.valve);
    const where = (): [number, number, number] => apply4(mul4(matrixOfQuat(d.q, d.spec.local), d.spec.parent), 0, 0, 0);
    return {
      random: () => 0.5,
      test: (c: EffectCondition): boolean => (c.kind === 'valve' ? valveTest(this.valves.get(valveName(c)) ?? 0, c.operation, c.operand) : false),
      begin: (op: EffectOp, run: EffectRun): OpTick | void => {
        switch (op.op) {
          case 'valve': {
            const name = valveName(op);
            this.valves.set(name, valveApply(this.valves.get(name) ?? 0, op.operation, op.operand));
            return;
          }
          case 'sound':
            if (!d.quiet) this.hooks.sound?.(op.sound, where());
            return;
          case 'rotate': {
            if (!nodeIs(run, op.node)) return;
            // `FUN_00263730`: the euler angles (radians, applied y, x, z) set (flag 1) or added (flag 2) [reading].
            const e = eulerQuat(op.xyz);
            if (op.flags & 1) this.pose(d, e);
            else if (op.flags & 2) this.pose(d, quatMul(d.q, e));
            return;
          }
          case 'fromTo': {
            const rot = op.rotation;
            if (!rot || !nodeIs(run, op.node)) return;
            // `FUN_0025fe70`: from the node's rotation now (the command's own with 0x20, unless flag 1); to the command's
            // or, with flag 1, the command's turn after the start (`FUN_003070c0(+0x20, +0x10)`); `FUN_0025f9b0`: slerp
            // by the time over +0x34, the end set exactly. Frostfire's doors: flags 0x61, 100 degrees about y in 0.7 s.
            const from: Quat = (op.flags & 1) === 0 && (op.flags & 0x20) !== 0 ? rot.from : d.q;
            const to: Quat = op.flags & 1 ? quatMul(rot.to, from) : rot.to;
            const seconds = op.seconds;
            d.swing = { seconds, t: 0 };
            this.pose(d, from);
            return (dt: number): boolean => {
              const s = d.swing ?? { seconds, t: 0 };
              s.t += dt;
              const done = seconds <= 0 || s.t >= seconds;
              this.pose(d, done ? to : quatSlerp(from, to, s.t / seconds));
              return done;                                        // `d.swing` stays, at its end, until the run is over
            };
          }
          default: return;
        }
      },
    };
  }
}

/** Euler angles (radians) as the engine's node rotation takes them, y then x then z [reading, as `./effects` reads it]. */
function eulerQuat([x, y, z]: readonly [number, number, number]): Quat {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  // YXZ: q = qy qx qz (three's `Euler` order 'YXZ').
  return quatMul(quatMul([0, sy, 0, cy], [sx, 0, 0, cx]), [0, 0, sz, cz]);
}

/** Units along the view within which a door's polygon ties with the nearest hit (`pickDoor`). */
export const PICK_TIE = 0.05;

/**
 * The door the reticle is on (`FUN_005aa240`, and `FUN_002b46f0`'s gate: none while it swings or when locked): the
 * first polygon along the view from `eye` to `far` -- the movement's
 * skip surfaces (bit 18) passed over [reading: the reticle pick's own surface test is not traced] -- belongs to a door,
 * and `feet` is within the door's `range` of that point on the ground plane (`dx^2 + dz^2 < range^2`) and, when the
 * door has one, inside its `elevation` in height. The door's index, or null.
 */
export function pickDoor(doors: DoorSet, grid: Grid, eye: readonly number[], far: readonly number[], feet: readonly number[]): number | null {
  if (doors.count === 0) return null;
  // No door's swing within its range of the feet: no pick can take one, and the view's segment is not cast.
  const near = doors.specs.some((d) => {
    const s = d.sweep, r = d.range;
    return feet[0]! >= s.minX - r && feet[0]! <= s.maxX + r && feet[2]! >= s.minZ - r && feet[2]! <= s.maxZ + r;
  });
  if (!near) return null;
  const hits = segmentHits(grid, [eye[0]!, eye[1]!, eye[2]!], [far[0]!, far[1]!, far[2]!], (p) => (surfaceWord(p) & SURFACE_SKIP) === 0);
  const first = hits[0];
  if (!first) return null;
  // A leaf flush with its frame's wall meets the view at the same point as the wall's edge (Frostfire's wdoor_2 and
  // `warehouse/wintdi`, both at 20.0 along): a tie within `PICK_TIE` units goes to the door [reading].
  const length = Math.hypot(far[0]! - eye[0]!, far[1]! - eye[1]!, far[2]! - eye[2]!);
  const hit = hits.find((h) => (h.t - first.t) * length <= PICK_TIE && doors.doorOf(h.owner.path) >= 0);
  if (!hit) return null;
  const i = doors.doorOf(hit.owner.path);
  // `FUN_002b46f0`: offered only with no animation of it running and the valve not locked.
  if (doors.state(i).busy || doors.valve(i) === VALVE_LOCKED) return null;
  const spec = doors.specs[i]!;
  const dx = hit.point[0] - feet[0]!, dy = hit.point[1] - feet[1]!, dz = hit.point[2] - feet[2]!;
  if (dx * dx + dz * dz >= spec.range * spec.range) return null;
  if (spec.elevation !== -1 && spec.elevation * spec.elevation <= dy * dy) return null;
  return i;
}

/**
 * The server's reach check on a client's `door` event: the player's feet within the door's range (and elevation) of
 * the nearest point of its leaf as it stands, with `slack` for the pick's point and the view the server does not see.
 */
export function doorInReach(doors: DoorSet, i: number, feet: readonly number[], slack = 8): boolean {
  const spec = doors.specs[i];
  if (!spec) return false;
  let best = Infinity, bestDy = Infinity;
  for (const pts of doors.leaf(i)) {
    for (let k = 0; k < pts.length; k += 3) {
      const d = Math.hypot(pts[k]! - feet[0]!, pts[k + 2]! - feet[2]!);
      if (d < best) { best = d; bestDy = Math.abs(pts[k + 1]! - feet[1]!); }
    }
  }
  if (!Number.isFinite(best)) {                                   // no hull on this side: the node's origin
    const o = apply4(mul4(spec.local, spec.parent), 0, 0, 0);
    best = Math.hypot(o[0] - feet[0]!, o[2] - feet[2]!);
    bestDy = Math.abs(o[1] - feet[1]!);
  }
  return best <= spec.range + slack && (spec.elevation === -1 || bestDy <= spec.elevation + slack);
}
