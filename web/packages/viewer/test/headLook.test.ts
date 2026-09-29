import { describe, expect, it } from 'vitest';
import { parseZdb, Zar, zdbMember } from '@s2u/archive';
import { IDENTITY, partMatrix, readSkeleton, SEAL_TUNING, Skeleton, type MotionClip, type MotionPart, type SkeletonPart } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { Animator, qmul, qrot, quatOfMatrix, type MoverSnapshot } from '../src/animator';
import { HEAD_LOOK_NODES, HEAD_LOOK_POSES, HeadLook, LOOK, LOOK_AXES, lookFractions, lookQuat } from '../src/headLook';

/**
 * The head look (motion round 4, research 80 §6c): `FUN_005ae980`'s axes from the nine captured poses, `FUN_00287210`'s
 * fractions, `FUN_005ae730`'s turn, the controller's request (`FUN_00596f10`, `FUN_00601400`, `FUN_00600550`), the
 * rotator (`FUN_005ad9d0`, `FUN_005ad920`) and `FUN_0057a330`'s gate on the rifle's raise weight.
 */

const deg = (r: number): number => (r * 180) / Math.PI;
const swing = (v: readonly number[]): number => deg(Math.asin(Math.min(1, Math.hypot(v[0]!, v[1]!, v[2]!))));
const TICK = 1 / 60;

describe("the look's axes and fractions (FUN_005ae980, FUN_00287210, FUN_005ae730)", () => {
  it('each node has nine captured poses; its axes are the swing of the forward from the rest pose to the edges', () => {
    for (const n of HEAD_LOOK_NODES) expect(HEAD_LOOK_POSES[n].length).toBe(27);
    // the forward's swing from the rest (pose 4) to the right (5) and the left (3): the head the most, the spine least
    expect(swing(LOOK_AXES.head.right)).toBeCloseTo(40.5, 0);
    expect(swing(LOOK_AXES.head.left)).toBeCloseTo(22.6, 0);
    expect(swing(LOOK_AXES.neck.right)).toBeCloseTo(20.2, 0);
    expect(swing(LOOK_AXES.spinehi.right)).toBeCloseTo(4.7, 0);
    expect(swing(LOOK_AXES.spinelo.left)).toBeCloseTo(6.7, 0);
    expect(swing(LOOK_AXES.head.up)).toBeCloseTo(7.9, 0);
    for (const n of HEAD_LOOK_NODES) for (const v of Object.values(LOOK_AXES[n])) expect(v[2]).toBeCloseTo(0, 9);   // forward x ...
  });

  it('the fractions: the yaw over 90 degrees (right positive), the pitch over 80 (up positive), each capped at 1', () => {
    const [a] = lookFractions([Math.sin(Math.PI / 4), 0, -Math.cos(Math.PI / 4)]);
    expect(a).toBeCloseTo(0.5, 9);
    expect(lookFractions([-Math.sin(Math.PI / 4), 0, -Math.cos(Math.PI / 4)])[0]).toBeCloseTo(-0.5, 9);
    expect(lookFractions([1, 0, 1])[0]).toBe(1);                   // behind the shoulder: capped
    const up = (40 * Math.PI) / 180;
    const [a2, b2] = lookFractions([0, Math.sin(up), -Math.cos(up)]);
    expect(a2).toBeCloseTo(0, 9);
    expect(b2).toBeCloseTo(0.5, 6);
  });

  it("a node's turn is |a| x its axis (the exponential map of |a| / 2 x E), the pitch left out within 0.01 of rest", () => {
    const q = lookQuat(LOOK_AXES.head, 1, 0);
    const angle = 2 * Math.acos(q[3]);
    expect(angle).toBeCloseTo(Math.hypot(...LOOK_AXES.head.right), 9);
    expect(lookQuat(LOOK_AXES.head, 0.5, 0.005)).toEqual(lookQuat(LOOK_AXES.head, 0.5, 0));
    expect(lookQuat(LOOK_AXES.head, 0, 0)).toEqual([0, 0, 0, 1]);
  });
});

describe("the controller's look and the rotator (FUN_00596f10, FUN_00600550, FUN_005ad9d0)", () => {
  const run = (look: HeadLook, seconds: number, axis: number): void => {
    for (let t = 0; t < seconds - 1e-9; t += TICK) { look.request(TICK, axis); look.advance(TICK); }
  };

  it('a turn leads the look into it: 1.5 x 0.349 x the axis, at 2.9 rad/s; at rest it comes back ahead', () => {
    const look = new HeadLook(() => 0);
    look.request(TICK, 0.02);                                       // within 0.05: at rest
    expect(look.priority).toBe(0);
    run(look, 0.5, 1);                                              // a full left turn (the axis left positive)
    expect(look.priority).toBe(1);
    expect(look.done).toBe(true);
    const lead = -LOOK.turnFactor * LOOK.angle;                      // 0.524 rad, 30 degrees
    expect(deg(lead)).toBeCloseTo(30, 1);
    expect(lookFractions(look.dir)[0]).toBeCloseTo(-lead / (Math.PI / 2), 6);   // to the left
    // the time it took: the angle over 3.5 x 0.8 + 0.5 x 0.2 = 2.9 rad/s
    const timed = new HeadLook(() => 0);
    let ticks = 0;
    timed.request(TICK, 1);
    while (!timed.done && ticks < 100) { timed.advance(TICK); ticks++; if (!timed.done) timed.request(TICK, 1); }
    expect(ticks).toBe(Math.ceil(lead / 2.9 / TICK - 1e-9));
    // the turn stops: priority 0, ahead, at 3.5 x 0.1 + 0.5 x 0.9 = 0.8 rad/s with a draw of 0
    run(look, 1, 0);
    expect(look.priority).toBe(0);
    expect(lookFractions(look.dir)[0]).toBeCloseTo(0, 6);
  });

  it('at rest a glance aside every 4 to 7 s, 0.349 x (0.8 to 1.1) rad, then the other side', () => {
    const look = new HeadLook(() => 0);                             // draws of 0: every 4 s, 0.8 of the angle
    run(look, 3.9, 0);
    expect(lookFractions(look.dir)[0]).toBe(0);
    run(look, 1, 0);
    const first = lookFractions(look.dir)[0];
    expect(Math.abs(first)).toBeCloseTo((LOOK.angle * 0.8) / (Math.PI / 2), 5);
    run(look, 4, 0);
    const second = lookFractions(look.dir)[0];
    expect(Math.sign(second)).toBe(-Math.sign(first));
    expect(Math.abs(second)).toBeCloseTo(Math.abs(first), 5);
  });
});

// ---- the animator's gate on the raise weight ------------------------------------------------------------------------

const Q_ID: [number, number, number, number] = [0, 0, 0, 1];
function chain(): Skeleton {
  const part = (index: number, name: string, parent: number, t: number[]): SkeletonPart => ({
    index, name, parent, bindLocal: partMatrix(Q_ID, t as [number, number, number]), bbox: new Float32Array(6), type: 0, flags: 0,
  });
  return new Skeleton('chain', IDENTITY, [
    part(0, 'skel_root', -1, [0, 11, 0]), part(1, 'spinelo', 0, [0, 1, 0]), part(2, 'spinehi', 1, [0, 3, 0]),
    part(3, 'neck', 2, [0, 4, 0]), part(4, 'head', 3, [0, 2, 0]),
  ]);
}
function still(name: string): MotionClip {
  const parts: MotionPart[] = ['skel_root', 'spinelo', 'spinehi', 'neck', 'head'].map((n, index) => ({
    index, name: n, flags: 0x0c | 0x10 | 0x20, translations: Float32Array.from(n === 'skel_root' ? [0, 11, 0] : [0, 1, 0]), rotations: Float32Array.from(Q_ID),
  }));
  return { name, version: 5, duration: 10 / 30, frameCount: 10, rate: 30, unknown10: -1, unknown14: 1, parts };
}
const REST: MoverSnapshot = { vx: 0, vz: 0, vy: 0, yaw: 0, airborne: false, crouched: false, landing: null, jumps: 0, stance: 'stand', action: null };
const headAngle = (sk: Skeleton): number => 2 * Math.acos(Math.min(1, Math.abs(quatOfMatrix(sk.local[sk.indexOf('head')]!)[3]!)));

describe("FUN_0057a330's gate: the head look with the rifle down or the rotator turning, the twist with it up", () => {
  const turning = { ...REST, turnRate: SEAL_TUNING.turnMaxRate };

  it('the rifle down: the look runs and turns the head into the turn; the twist is off', () => {
    const sk = chain();
    const anim = new Animator(sk, [still('seal_stand')], null, { random: () => 0 });
    for (let i = 0; i < 30; i++) anim.step(TICK, { ...turning, pitch: 30, aimWeight: 0 });
    expect(anim.stats().look.on).toBe(true);
    expect(anim.stats().look.priority).toBe(1);
    expect(anim.stats().look.yaw).toBeLessThan(-0.3);                // to the left
    expect(deg(headAngle(sk))).toBeGreaterThan(5);
    expect(anim.stats().twist).toBe(0);                              // FUN_0057a330 439192: only over 0
  });

  it('the rifle up: the look runs only while the rotator turns; the twist is scaled by the weight', () => {
    const sk = chain();
    const anim = new Animator(sk, [still('seal_stand')], null, { random: () => 0 });
    anim.step(TICK, { ...REST, pitch: 30, aimWeight: 1 });
    expect(anim.stats().look.on).toBe(false);                        // at rest, the rotator done
    expect(headAngle(sk)).toBeCloseTo(0, 9);
    const full = anim.stats().twist;
    expect(full).toBeGreaterThan(0);
    anim.step(TICK, { ...REST, pitch: 30, aimWeight: 0.5 });
    expect(anim.stats().twist).toBeCloseTo(full / 2, 3);
    anim.step(TICK, { ...turning, aimWeight: 1 });                   // a new direction: the rotator turns
    expect(anim.stats().look.on).toBe(true);
    for (let i = 0; i < 60; i++) anim.step(TICK, { ...turning, aimWeight: 1 });
    expect(anim.stats().look.on).toBe(false);                        // done: the head is the clip's again
    expect(headAngle(sk)).toBeCloseTo(0, 9);
  });

  it('not prone', () => {
    const sk = chain();
    const anim = new Animator(sk, [still('seal_prone')], null, { random: () => 0 });
    for (let i = 0; i < 30; i++) anim.step(TICK, { ...turning, stance: 'prone', aimWeight: 0 });
    expect(anim.stats().look.on).toBe(false);
  });
});

// ---- the SEAL's own skeleton (the owner's Frostfire) --------------------------------------------------------------

const SEAL = fixture('RUN/MP2.ZDB');

describe.skipIf(SEAL === null)(`seal_A_scuba's head turned by the look${SEAL === null ? ' (MP2 absent)' : ''}`, () => {
  it("a full yaw right turns the head's facing 64 degrees right, a full left 48 left: toward the look", () => {
    const sk = readSkeleton(Zar.parse(zdbMember(SEAL!, parseZdb(SEAL!), 'CLIB_GEO.ZED')), 'seal_A_scuba');
    const facing = (a: number): [number, number, number] => {
      let w: [number, number, number, number] = [0, 0, 0, 1];
      for (const name of ['skel_root', 'hips', 'aimnodes', 'spinelo', 'spinehi', 'neck', 'head']) {
        let l = quatOfMatrix(sk.parts[sk.indexOf(name)]!.bindLocal) as [number, number, number, number];
        if ((HEAD_LOOK_NODES as readonly string[]).includes(name)) l = qmul(l, lookQuat(LOOK_AXES[name as keyof typeof LOOK_AXES], a, 0)) as typeof l;
        w = qmul(w, l) as typeof w;
      }
      return w as unknown as [number, number, number];
    };
    const rest = facing(0) as unknown as number[], inv = [-rest[0]!, -rest[1]!, -rest[2]!, rest[3]!];
    const local = qrot(inv, [0, 0, -1]);
    const yawOf = (a: number): number => { const f = qrot(facing(a) as unknown as number[], local); return deg(Math.atan2(f[0], -f[2])); };
    expect(yawOf(1)).toBeCloseTo(64.3, 0);
    expect(yawOf(-1)).toBeCloseTo(-47.9, 0);
  });
});
