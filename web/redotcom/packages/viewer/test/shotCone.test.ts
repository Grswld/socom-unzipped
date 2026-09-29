import { describe, expect, it } from 'vitest';
import { HELD_RIFLE, HELD_SIDEARM, PROBE_LIFT, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import { Accuracy, perturb, tangentPerPixel, type Cone } from '../src/accuracy';
import { FlyCamera } from '../src/camera';
import { CAM_FAR, localCamera, toWorld } from '../src/cameraRig';
import { rootY, Walker } from '../src/mover';
import { MoverSim } from '../src/net/moverSim';
import { Button, type Command } from '../src/net/protocol';
import {
  aheadOf, bound, cameraLook, centreClaim, coneCoords, faceToward, pointSegment, ShotCone, type AimMover,
  CONE_SLACK_PX_PLACEHOLDER, CONE_WINDOW_PLACEHOLDER, ROOT_POSE_SLACK_PLACEHOLDER, STANCE_CHANGE_TICKS_PLACEHOLDER,
} from '../src/net/shotCone';
import { PlayerCamera } from '../src/playerCamera';
import { Traversal } from '../src/traversal';
import { groundGrid, groundPolygons, packGround, WalkMode, type GroundData } from '../src/walk';

/**
 * The server's accuracy cone (OWNER-3 of the launch review, `src/net/shotCone.ts`): the page's `Accuracy` run from the
 * commands, the eye the page's camera could have had, the aim inside the cone, and the round down the eye's ray.
 */

type V3 = [number, number, number];
const unit = (a: readonly number[]): V3 => { const l = Math.hypot(a[0]!, a[1]!, a[2]!); return [a[0]! / l, a[1]! / l, a[2]! / l]; };

describe('the cone read backwards (FUN_00592260 inverted)', () => {
  it('coneCoords returns the offsets perturb put a ray at, at any look but straight up', () => {
    let seed = 7;
    const rand = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 200; i++) {
      const look = unit([rand() * 2 - 1, rand() * 1.6 - 0.8, rand() * 2 - 1]);
      const a = (rand() * 2 - 1) * 0.2, b = (rand() * 2 - 1) * 0.2;
      const ray = unit(perturb(look, { offsetX: a, offsetY: b, radius: 0 }));
      const got = coneCoords(look, ray)!;
      expect(got[0]).toBeCloseTo(a, 9);
      expect(got[1]).toBeCloseTo(b, 9);
    }
    expect(coneCoords([0, 0, -1], [0, 0, 1])).toBeNull();          // behind the look
    expect(coneCoords([0, 1, 0], [0, 1, 0])).toBeNull();           // straight up: no axes
  });

  it('a round is bound to the eye\'s ray when its segment passes through that ray ahead of both', () => {
    const eye: V3 = [0, 20, 30], aim = unit([0, -0.1, -1]);
    const point: V3 = [eye[0] + aim[0] * 200, eye[1] + aim[1] * 200, eye[2] + aim[2] * 200];
    const from: V3 = [3, 14, -2];
    expect(bound({ eye, aim, from, dir: unit([point[0] - from[0], point[1] - from[1], point[2] - from[2]]) })).toBe(true);
    expect(bound({ eye, aim, from: eye, dir: aim })).toBe(true);                               // no muzzle: the eye's ray
    expect(bound({ eye, aim, from, dir: unit([point[0] + 5 - from[0], point[1] - from[1], point[2] - from[2]]) })).toBe(false);
    expect(bound({ eye, aim, from, dir: unit([from[0] - point[0], from[1] - point[1], from[2] - point[2]]) })).toBe(false);   // backwards
  });

  it('the geometry helpers: a point to a segment, the pitched ahead', () => {
    expect(pointSegment([0, 1, 0], [-1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12);
    expect(pointSegment([3, 0, 0], [-1, 0, 0], [1, 0, 0])).toBeCloseTo(2, 12);
    const a = aheadOf(90, 0);                                      // yaw 90 looks down -x (camera.ts)
    expect(a[0]).toBeCloseTo(-1, 12); expect(a[2]).toBeCloseTo(0, 12);
  });
});

describe('the camera the server reads is the page\'s (the geometry moved to cameraRig.ts)', () => {
  it('cameraLook is PlayerCamera\'s eye line in the open: the eye on it, the far point FUN_00297410\'s', () => {
    for (const [pitch, posture] of [[0, 'stand'], [-20, 'crouch'], [15, 'prone'], [-9.167, 'stand']] as const) {
      const cam = new PlayerCamera(null);
      const feet = [100, 5, -40], yaw = 37;
      cam.tick(feet, yaw, pitch, rootY(posture));
      const view = cam.view(1);
      const { eye, look } = cameraLook({ feet, yaw, pitch, posture });
      // The page's eye: the goal eye, the pass's 0.75 further back in the open -- on cameraLook's line.
      const back = unit([view.eye[0] - eye[0], view.eye[1] - eye[1], view.eye[2] - eye[2]]);
      expect(Math.abs(back[0] * look[0] + back[1] * look[1] + back[2] * look[2])).toBeCloseTo(1, 6);
      const far = unit([view.far[0] - view.eye[0], view.far[1] - view.eye[1], view.far[2] - view.eye[2]]);
      for (let i = 0; i < 3; i++) expect(far[i]).toBeCloseTo(look[i]!, 6);
      const local = localCamera(rootY(posture), pitch);
      const farW = toWorld(feet, yaw, [local.target[0] + local.ahead[0] * CAM_FAR, local.target[1] + local.ahead[1] * CAM_FAR, local.target[2] + local.ahead[2] * CAM_FAR]);
      for (let i = 0; i < 3; i++) expect(view.far[i]).toBeCloseTo(farW[i]!, 6);
    }
  });

  it('faceToward turns the look onto a point', () => {
    const body = { feet: [0, 0, 0], posture: 'stand' as const };
    const target: V3 = [100, 30, 0];
    const f = faceToward(body, target);
    const { eye, look } = cameraLook({ ...body, ...f });
    const u = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    for (let i = 0; i < 3; i++) expect(u[i]).toBeCloseTo(look[i]!, 6);
    expect(f.yaw).toBeCloseTo(270, 9);
  });
});

/** A flat floor 800 across at y 0. */
function flat(): GroundData {
  const floor: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-400, 0, -400, 400, 0, -400, 400, 0, 400, -400, 0, 400]),
  };
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 4, cellsZ: 4, originX: -400, originZ: -400 };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
  return packGround(params, [floor], owners);
}

/** The server's mover data after a command. */
function moverOf(sim: MoverSim): AimMover {
  const w = sim.walker, s = w.state;
  return {
    feet: [s.x, s.y, s.z], velocity: [s.vx, s.vy, s.vz], airborne: w.airborne, posture: w.posture,
    moveRoot: sim.moves?.rootY() ?? null, peek: sim.moves?.peek() ?? 0, weapon: sim.weapon,
  };
}

/**
 * The page and the server side by side: the page's `WalkMode` on a flat floor sends its commands; the server's own mover
 * (the room's make: a `Walker` and the traversal moves) runs them and feeds a `ShotCone`.
 */
function pageAndServer() {
  const ground = flat();
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  const fly = new FlyCamera(c);
  const walk = new WalkMode(fly);
  walk.setGround(ground, [0, 0, 0]);
  fly.setPose({ x: 5, y: 15.4, z: 6, yaw: 0, pitch: 0 });
  walk.setMode('walk');
  let wish = { forward: 0, right: 0, boost: false };
  fly.groundWish = () => wish;
  const grid = groundGrid(ground);
  const pageWalker = (walk as unknown as { walker: Walker }).walker;
  const w = new Walker(grid);
  const sim = new MoverSim(w, new Traversal(grid, groundPolygons(ground)));
  w.place(pageWalker.state.x, pageWalker.state.y + PROBE_LIFT, pageWalker.state.z);
  const cone = new ShotCone(HELD_RIFLE);
  let seq = 0, count = 0;
  walk.setNetTap((cmd) => {
    const full: Command = { ...cmd, seq: ++seq };
    sim.apply(full);
    cone.tick(full, moverOf(sim), ++count);
  });
  return {
    walk, fly, cone, sim, seq: () => seq,
    setWish: (v: typeof wish) => { wish = v; },
    dispose: () => walk.unbindKey(),
  };
}

/** A ray off `look` at the cone's offset plus `k` of its radius on each axis (k = +-1: the square's corner). */
function corner(look: readonly number[], cone: Cone, kx: number, ky: number): V3 {
  return unit(perturb([look[0]!, look[1]!, look[2]!], { offsetX: cone.offsetX + cone.radius * kx, offsetY: cone.offsetY + cone.radius * ky, radius: 0 }));
}

describe('the page\'s own rounds pass the server\'s cone; rounds outside it do not (OWNER-3)', () => {
  it('walking, turning and drawn between ticks: every corner of the cone passes, twice the radius past it does not', () => {
    const rig = pageAndServer();
    rig.setWish({ forward: 1, right: 0.4, boost: false });
    let yaw = 0, checked = 0, refused = 0;
    for (let f = 0; f < 240; f++) {
      yaw += 0.35;                                               // a steady turn: the bloom opens
      rig.fly.setPose({ yaw, pitch: -4 });
      rig.walk.frame(1 / 144);                                   // frames between the ticks: the view is drawn part-way
      if (f < 30 || f % 7 !== 0) continue;
      const aimAt = rig.walk.fireAim()!;
      const seq = rig.seq();
      const look = unit([aimAt.far[0] - aimAt.eye[0], aimAt.far[1] - aimAt.eye[1], aimAt.far[2] - aimAt.eye[2]]);
      const cone = rig.cone.frame(seq)!.cone;
      const rays = [corner(look, cone, 1, 1), corner(look, cone, -1, 1), corner(look, cone, 1, -1), corner(look, cone, -1, -1), corner(look, cone, 0, 0)];
      const tp = tangentPerPixel();
      const outside = corner(look, { ...cone, radius: cone.radius * 2 + 4 * CONE_SLACK_PX_PLACEHOLDER * tp.y + 0.01 }, 1, 0);
      // The server decides once the next command has run (the page's look may run a tick ahead).
      while (rig.seq() < seq + 1) rig.walk.frame(1 / 144);
      for (const aim of rays) {
        expect(rig.cone.check(seq, { eye: aimAt.eye, aim, from: aimAt.eye, dir: aim }), `f${f}`).toBeNull();
        checked++;
      }
      if (rig.cone.check(seq, { eye: aimAt.eye, aim: outside, from: aimAt.eye, dir: outside }) === 'cone') refused++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(refused).toBe(checked / 5);
    rig.dispose();
  });

  it('the page\'s own cone (its Accuracy fed by frames, as main.ts gunFrame feeds it) passes at 144 and at 30 frames a second', () => {
    for (const dt of [1 / 144, 1 / 30]) {
      const rig = pageAndServer();
      const page = new Accuracy(HELD_RIFLE);
      let yaw = 0, pitch = -4, last: { yaw: number; pitch: number } | null = null, checked = 0;
      for (let f = 0; f * dt < 4; f++) {
        const t = f * dt;
        rig.setWish({ forward: t < 2 ? 1 : 0, right: t > 1 && t < 3 ? -0.6 : 0, boost: false });
        yaw += (t < 1.5 ? 90 : t < 3 ? -30 : 0) * dt;             // a fast turn, a slow one back, still
        pitch = -4 + 3 * Math.sin(t * 2);
        rig.fly.setPose({ yaw, pitch });
        rig.walk.frame(dt);
        // gunFrame: the rates from the look's change this frame, the mover's snapshot, the stick.
        const snap = rig.walk.snapshot()!, pose = rig.fly.pose();
        let yawRate = 0, pitchRate = 0;
        if (last) {
          const dy = ((pose.yaw - last.yaw + 540) % 360) - 180, dp = pose.pitch - last.pitch;
          yawRate = (dy * Math.PI / 180) / dt; pitchRate = (dp * Math.PI / 180) / dt;
        }
        last = { yaw: pose.yaw, pitch: pose.pitch };
        const wish = rig.fly.groundWish();
        page.update(dt, {
          stance: snap.stance, velocity: [snap.vx, snap.vy, snap.vz], airborne: snap.airborne, yawRate, pitchRate, zoomState: 0,
          sticks: { forward: wish.forward, right: wish.right, turn: yawRate / 2, pitch: Math.min(1, Math.abs(pitchRate) / 0.95) },
        });
        if (t < 0.3 || f % 5 !== 0) continue;
        const aimAt = rig.walk.fireAim()!, seq = rig.seq();
        const look = unit([aimAt.far[0] - aimAt.eye[0], aimAt.far[1] - aimAt.eye[1], aimAt.far[2] - aimAt.eye[2]]);
        const cone = page.cone(0, 1);
        const rays = [corner(look, cone, 1, 1), corner(look, cone, -1, -1), corner(look, cone, 1, -1), corner(look, cone, -1, 1)];
        const next = rig.seq() + 1;
        while (rig.seq() < next) {
          rig.walk.frame(dt);
          page.update(dt, { stance: snap.stance, velocity: [snap.vx, snap.vy, snap.vz], airborne: snap.airborne, yawRate, pitchRate, zoomState: 0 });
        }
        for (const aim of rays) {
          expect(rig.cone.check(seq, { eye: aimAt.eye, aim, from: aimAt.eye, dir: aim }), `dt ${dt} t ${t.toFixed(3)}`).toBeNull();
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(40);
      rig.dispose();
    }
  });

  it('an eye off the camera\'s line, or a round not down the eye\'s ray, is refused', () => {
    const rig = pageAndServer();
    for (let f = 0; f < 20; f++) rig.walk.frame(1 / 60);
    const aimAt = rig.walk.fireAim()!, seq = rig.seq();
    rig.walk.frame(1 / 60);
    const look = unit([aimAt.far[0] - aimAt.eye[0], aimAt.far[1] - aimAt.eye[1], aimAt.far[2] - aimAt.eye[2]]);
    expect(rig.cone.check(seq, { eye: aimAt.eye, aim: look, from: aimAt.eye, dir: look })).toBeNull();
    const aside: V3 = [aimAt.eye[0] + 12, aimAt.eye[1], aimAt.eye[2]];
    expect(rig.cone.check(seq, { eye: aside, aim: look, from: aside, dir: look })).toBe('eye');
    // From a muzzle 10 ahead of the feet, at a point 300 along the eye's ray: bound; 20 units off that point: not.
    const s = rig.sim.walker.state, from: V3 = [s.x, s.y + 15.4, s.z - 10];
    const point = [aimAt.eye[0] + look[0] * 300, aimAt.eye[1] + look[1] * 300, aimAt.eye[2] + look[2] * 300];
    expect(rig.cone.check(seq, { eye: aimAt.eye, aim: look, from, dir: unit([point[0]! - from[0], point[1]! - from[1], point[2]! - from[2]]) })).toBeNull();
    expect(rig.cone.check(seq, { eye: aimAt.eye, aim: look, from, dir: unit([point[0]! + 20 - from[0], point[1]! - from[1], point[2]! - from[2]]) })).toBe('bind');
    expect(rig.cone.check(seq + 500, { eye: aimAt.eye, aim: look, from, dir: look })).toBe('stale');
    rig.dispose();
  });

  it('scoped (the view from the head): the sway\'s limits, not the bloom; the head\'s eye', () => {
    const rig = pageAndServer();
    rig.walk.setScoped(true);
    rig.walk.setScopedMove(true);
    for (let f = 0; f < 30; f++) { rig.fly.setPose({ yaw: 10, pitch: 2 }); rig.walk.frame(1 / 60); }
    const aimAt = rig.walk.fireAim()!, seq = rig.seq();
    rig.walk.frame(1 / 60);
    const frame = rig.cone.frame(seq)!;
    expect(frame.scoped && frame.lens).toBe(true);
    expect(frame.cone.radius).toBe(0);
    const look = unit([aimAt.far[0] - aimAt.eye[0], aimAt.far[1] - aimAt.eye[1], aimAt.far[2] - aimAt.eye[2]]);
    const at = (kx: number): V3 => corner(look, { offsetX: frame.sway[0] * kx, offsetY: 0, radius: 0 }, 0, 0);
    expect(rig.cone.check(seq, { eye: aimAt.eye, aim: at(0.99), from: aimAt.eye, dir: at(0.99) })).toBeNull();
    const tp = tangentPerPixel();
    const past = at(1 + (3 * CONE_SLACK_PX_PLACEHOLDER * tp.x) / frame.sway[0]);
    expect(rig.cone.check(seq, { eye: aimAt.eye, aim: past, from: aimAt.eye, dir: past })).toBe('cone');
    rig.dispose();
  });
});

describe('the server runs the page\'s Accuracy from the commands', () => {
  const still: AimMover = { feet: [0, 0, 0], velocity: [0, 0, 0], airborne: false, posture: 'stand', moveRoot: null, peek: 0, weapon: 0 };
  const cmd = (seq: number, over: Partial<Command> = {}): Command =>
    ({ seq, forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0, ...over });

  it('at rest the cone closes to TargetMin; a run opens it as the page\'s does for the same inputs', () => {
    const cone = new ShotCone(HELD_RIFLE), page = new Accuracy(HELD_RIFLE);
    for (let i = 1; i <= 120; i++) {
      const v: V3 = i > 60 ? [60, 0, 0] : [0, 0, 0];
      cone.tick(cmd(i, { forward: i > 60 ? 1 : 0 }), { ...still, velocity: v }, i);
      page.tick(1 / 60, { stance: 'stand', velocity: v, airborne: false, yawRate: 0, pitchRate: 0, zoomState: 0, sticks: { forward: i > 60 ? 1 : 0, right: 0, turn: 0, pitch: 0 } });
      if (i === 60) expect(cone.state().size).toBe(HELD_RIFLE.stances.stand.targetMin);
    }
    expect(cone.state().size).toBeCloseTo(page.state().size, 12);
    expect(cone.state().size).toBeGreaterThan(HELD_RIFLE.stances.stand.targetMin);
    expect(cone.state().exertion).toBeCloseTo(page.state().exertion, 12);
  });

  it('a round knocks and blooms it as the page\'s does; the trigger\'s edges restart the pull; a swap takes the other record', () => {
    const cone = new ShotCone(HELD_RIFLE), page = new Accuracy(HELD_RIFLE);
    cone.tick(cmd(1, { buttons: Button.Trigger }), still, 1);
    page.trigger();
    page.tick(1 / 60, { stance: 'stand', velocity: [0, 0, 0], airborne: false, yawRate: 0, pitchRate: 0, zoomState: 0, sticks: { forward: 0, right: 0, turn: 0, pitch: 0 } });
    for (let r = 0; r < 3; r++) { cone.round(1); page.round(0, 'stand'); }
    expect(cone.state()).toEqual(page.state());
    cone.tick(cmd(2), still, 2);                                   // the trigger let go: the pull's count restarts
    expect(cone.state().burst).toBe(0);
    cone.setWeapon(HELD_SIDEARM);
    cone.tick(cmd(3), still, 3);
    expect(cone.state().size).toBe(HELD_SIDEARM.stances.stand.targetMin);
  });

  it('pins its tolerances (research 91 section 16 lists them)', () => {
    expect(CONE_WINDOW_PLACEHOLDER).toBe(6);
    expect(CONE_SLACK_PX_PLACEHOLDER).toBe(2);
    expect(ROOT_POSE_SLACK_PLACEHOLDER).toBe(4);
    expect(STANCE_CHANGE_TICKS_PLACEHOLDER).toBe(60);
  });

  it('a posture change widens the root slack by the two stances\' roots for STANCE_CHANGE_TICKS_PLACEHOLDER ticks, then not', () => {
    const cone = new ShotCone(HELD_RIFLE);
    const span = Math.abs(rootY('crouch') - rootY('stand'));
    expect(span).toBeGreaterThan(0);
    cone.tick(cmd(1), still, 1);
    expect(cone.frame(1)!.rootSlack).toBe(ROOT_POSE_SLACK_PLACEHOLDER);
    cone.tick(cmd(2), { ...still, posture: 'crouch' }, 2);                   // the change, at count 2
    const last = 2 + STANCE_CHANGE_TICKS_PLACEHOLDER;
    for (let c = 3; c <= last + 1; c++) cone.tick(cmd(c), { ...still, posture: 'crouch' }, c);
    expect(cone.frame(2)!.rootSlack).toBeCloseTo(ROOT_POSE_SLACK_PLACEHOLDER + span, 12);
    expect(cone.frame(last)!.rootSlack).toBeCloseTo(ROOT_POSE_SLACK_PLACEHOLDER + span, 12);
    expect(cone.frame(last + 1)!.rootSlack).toBe(ROOT_POSE_SLACK_PLACEHOLDER);
  });
});

describe('centreClaim: a round down the cone\'s centre', () => {
  it('is bound, and its aim is the look', () => {
    const b = { feet: [0, 0, 0], yaw: 30, pitch: -3, posture: 'stand' as const };
    const claim = centreClaim(b, [0, 15.4, 0], 250);
    expect(bound(claim)).toBe(true);
    const { look } = cameraLook(b);
    for (let i = 0; i < 3; i++) expect(claim.aim[i]).toBeCloseTo(look[i]!, 12);
  });
});
