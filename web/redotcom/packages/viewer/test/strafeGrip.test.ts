import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Group, Matrix4, Vector3 } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import type { Skeleton } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { buildBody } from '../src/bodyView';
import { DEFAULT_LIGHTING } from '../src/lighting';
import { loadMap } from '../src/loadMap';
import { packGround, WalkMode, type GroundData } from '../src/walk';
import { Play } from '../src/play';
import { Kit, type Firearm } from '../src/kit';
import { PLAY_CLIPS } from '../src/animator';
import { WEAPON_CLIPS } from '../src/weaponPose';
import { playFromDisc } from '../src/motionTable';

/**
 * The owner's playtest (2026-09-29): with the gun hot (raised) the SEAL strafing left or right did not keep it in his
 * hands. The whole chain on the disc's own clips -- the walk, the kit, the raise, the animator, the play's weapon
 * matrices -- frame by frame, the weapon measured against the drawn hands: its muzzle in the right hand's frame (the
 * node hangs from `rhand`; each clip holds it its own way, and the hold may change only as fast as the arms do), and
 * the off hand in the weapon's own frame, which may leave where the clips put it no further mid-blend than they do.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const absent = fixture('RUN/MP2.ZDB') === null || fixture('RUN/MOTION_P.ZAR') === null;

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};

const GROUND: GroundData = packGround(
  { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
  [{
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
  }],
  [{ modelName: 'worldmodel', path: 'worldmodel/floor', first: 0, count: 1 }],
);

/** A point of the part's frame `m` (row-major, row-vector: three's layout) in the frame of `of`. */
const inFrame = (of: ArrayLike<number>, m: ArrayLike<number>): Vector3 =>
  new Vector3(m[12], m[13], m[14]).applyMatrix4(new Matrix4().fromArray(Array.from(of)).invert());

/**
 * A sweep's measures (units): `holdStep` the largest step in one 60 Hz frame of the weapon's muzzle in the right hand's
 * frame (the hold changing under the hand), `offSettled` the largest distance of the off hand, in the weapon's frame,
 * from where the raised fire stand puts it once a clip has played past its cross-fade, `offAll` that on every frame.
 */
interface Sweep { holdStep: number; offSettled: number; offAll: number; where: string; whereStep: string }

const RIFLE_MUZZLE = [7.7854, 0.8338, 0], PISTOL_MUZZLE = [1.4723, 0.5647, 0];
/** A point of the weapon's own frame through its matrix (row-major, row-vector: three's column-major layout). */
const through = (m: ArrayLike<number>, p: readonly number[]): Vector3 =>
  new Vector3(...[0, 1, 2].map((k) => p[0]! * m[k]! + p[1]! * m[4 + k]! + p[2]! * m[8 + k]! + m[12 + k]!) as [number, number, number]);

describe.skipIf(absent)('a hot weapon stays in the hands while strafing (the owner\'s playtest, 2026-09-29)', () => {
  const rig = async (item: Firearm) => {
    const source = new FsAssetSource(FIXTURES);
    const map = await loadMap(source, 'RUN/MP2.ZDB');
    const data = (await playFromDisc(source, [...PLAY_CLIPS, ...WEAPON_CLIPS]))!;
    const fly = new FlyCamera(canvas());
    const walk = new WalkMode(fly);
    walk.setGround(GROUND, [0, 0, 0]);
    const view = buildBody(map.body!, map, DEFAULT_LIGHTING);
    const play = new Play();
    play.setBody(view, map.body!);
    const rifle = new Group(), pistol = new Group();
    play.setWeapon(rifle, [{ name: 'firepoint', at: [7.7854, 0.8338, 0] }]);
    play.setSidearm(pistol, [{ name: 'firepoint', at: [1.4723, 0.5647, 0] }]);
    play.setClips(data);
    const kit = new Kit({
      swapClip: (to) => walk.swapWeapon(to), canSwap: () => true,
      item: (i) => play.setItem(i),
      swapProgress: () => walk.swapProgress(),
    });
    fly.setPose({ x: 5, y: 40, z: 6, yaw: 0, pitch: 0 });
    walk.setMode('walk');
    let input = { forward: 0, right: 0 };
    fly.groundWish = () => ({ forward: input.forward, right: input.right, boost: false });
    play.setWeaponInput(() => ({ trigger: false, aiming: true }));
    const skeleton = (): Skeleton => (play as unknown as { skeleton: Skeleton }).skeleton;
    const step = (): void => {
      walk.frame(1 / 60);
      kit.frame(1 / 60);
      play.setMounts(kit.state().mounts);
      play.frame(1 / 60, walk, fly.camera);
    };
    const weapon = item === 'rifle' ? rifle : pistol;
    const muzzle = item === 'rifle' ? RIFLE_MUZZLE : PISTOL_MUZZLE;
    /** The muzzle in the right hand's frame (the hold), and the off hand in the weapon's frame, this frame. */
    const measure = (): { hold: Vector3; off: Vector3 } => {
      const s = skeleton();
      const rhand = s.world[s.indexOf('rhand')]!, lhand = s.world[s.indexOf('lhand')]!;
      const w = weapon.matrix.elements;
      return { hold: through(w, muzzle).applyMatrix4(new Matrix4().fromArray(Array.from(rhand)).invert()), off: inFrame(w, lhand) };
    };
    if (item === 'pistol') {
      expect(kit.select('pistol')).toBe(true);
      for (let f = 0; f < 150; f++) step();
      expect(kit.state()).toMatchObject({ item: 'pistol', swap: null });
    }
    return {
      play, step, measure, stance: (c: boolean) => walk.crouch(c),
      stick: (forward: number, right: number) => { input = { forward, right }; },
      dispose: () => { view.dispose(); walk.unbindKey(); },
    };
  };

  /**
   * The gun hot (the aim held: the raise at 1) from the fire stand, then every strafe -- right and left, at a walk, a jog
   * and a run, standing and crouched -- its start from the stand, a turn to the diagonal and back (the forward and the
   * strafe sets shared by the stick), and its stop, each measured frame by frame.
   */
  const sweep = async (item: Firearm): Promise<Sweep> => {
    const r = await rig(item);
    for (let f = 0; f < 120; f++) r.step();                    // raised, standing still
    const ref = r.measure().off;
    const out: Sweep = { holdStep: 0, offSettled: 0, offAll: 0, where: '', whereStep: '' };
    let last = r.measure().hold;
    const watch = (label: string, frames: number): void => {
      for (let f = 0; f < frames; f++) {
        r.step();
        const m = r.measure();
        const step = m.hold.distanceTo(last), off = m.off.distanceTo(ref);
        last = m.hold;
        if (step > out.holdStep) { out.holdStep = step; out.whereStep = `${label} frame ${f}: the hold moved ${step.toFixed(2)}`; }
        if (off > out.offAll) { out.offAll = off; out.where = `${label} frame ${f}: the off hand ${off.toFixed(2)} from the fire stand's`; }
        if (f >= SETTLED) out.offSettled = Math.max(out.offSettled, off);
      }
    };
    for (const crouched of [false, true]) {
      r.stance(crouched);
      watch(`${crouched ? 'crouch' : 'stand'} settle`, 60);
      for (const speed of [0.35, 0.7, 1]) {
        for (const side of [1, -1]) {
          const label = `${crouched ? 'crouch' : 'stand'} ${side > 0 ? 'right' : 'left'} ${speed}`;
          r.stick(0, side * speed); watch(`${label} start`, 90);
          r.stick(0.7, side * speed); watch(`${label} diagonal`, 60);
          r.stick(0, side * speed); watch(`${label} back to the strafe`, 60);
          r.stick(0, 0); watch(`${label} stop`, 60);
        }
      }
    }
    r.dispose();
    return out;
  };

  /** Frames after a stick change past every cross-fade (the clips' `BlendTime`s, 0.4 s at most: 24 frames). */
  const SETTLED = 40;
  /**
   * The largest step of the muzzle in the hand in one frame. The clips hold the weapon in the hand differently -- the
   * run left's rifle turned 35 degrees from the stand's, the pistol's 90-degree run 0.7 further out -- and the hold
   * must go from one to the other as the arms do. Before the fix: 5.6 at a strafe's stop (the hold taken from the clip
   * coming while the arms cross-faded) and 3.8 on the turn to the diagonal (the Fire set switched on whole when a
   * forward clip became the main one). What remains is the stick's own step: a key from the strafe to the diagonal puts
   * the forward set in at 15% in one frame (`FUN_00583030` shares the sets by the stick's angle, with no ease), and its
   * hold with it -- 1.0 at the rifle's muzzle, 0.2 at the pistol's (1.5 from its grip; its snap was 0.9).
   */
  const HOLD_STEP = { rifle: 1.5, pistol: 0.5 } as const;
  /**
   * How far past the settled clips' own spread the rifle's off hand may leave it mid-blend: the clips put it within
   * 0.8 of the fire stand's place (measured); the bug's blends left it 1.1 to 2.1 away. The pistol is held in the right
   * hand alone while it strafes (its off hand 12.9 from the fire stand's), so only its hold is measured.
   */
  const OFF_MARGIN = 0.3;

  for (const item of ['rifle', 'pistol'] as const) {
    it(`the ${item}: the hold changes with the arms${item === 'rifle' ? ', the off hand stays on it' : ''}, every strafe frame`, async () => {
      const out = await sweep(item);
      expect(out.holdStep, out.whereStep).toBeLessThan(HOLD_STEP[item]);
      if (item === 'rifle') expect(out.offAll, out.where).toBeLessThan(out.offSettled + OFF_MARGIN);
    }, 120_000);
  }
});
