import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Group } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
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
 * The owner's playtest (2026-09-29): the pistol -> rifle swap snapped the rifle in front of the SEAL at its start and
 * up at its end. The whole chain on the disc's own clips -- the walk's swap action or overlay, the kit's mounts, the
 * animator's pose, the play's weapon matrices -- run frame by frame, the rifle's grip may move no further in one
 * 60 Hz frame than the clip itself moves it: no frame's step more than a few units, both ways, still and moving.
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

/**
 * A run's measures, the muzzles' per-frame steps in the body's frame (units): `ends` the rifle's largest on the frames
 * its mount changes and the two after (the swap's start and end), `clip` its largest on the others, `pistol` the
 * pistol's anywhere; `worst` where `ends` was; `unsynced` the frames the rifle's mount and the walk's clip disagree.
 */
interface Run { ends: number; clip: number; pistol: number; worst: string; unsynced: number }

/** A point through a weapon's matrix (row-major, row-vector: three's column-major layout). */
const through = (m: ArrayLike<number>, p: readonly number[]): number[] =>
  [0, 1, 2].map((k) => p[0]! * m[k]! + p[1]! * m[4 + k]! + p[2]! * m[8 + k]! + m[12 + k]!);
const RIFLE_MUZZLE = [7.7854, 0.8338, 0], PISTOL_MUZZLE = [1.4723, 0.5647, 0];

describe.skipIf(absent)('the swap is continuous on the disc\'s clips (the owner\'s playtest, 2026-09-29)', () => {
  const rig = async () => {
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
      item: (item) => play.setItem(item),
      swapProgress: () => walk.swapProgress(),
    });
    fly.setPose({ x: 5, y: 40, z: 6, yaw: 0, pitch: 0 });
    walk.setMode('walk');
    let input = { forward: 0, right: 0 };
    fly.groundWish = () => ({ forward: input.forward, right: input.right, boost: false });
    const step = (): void => {
      walk.frame(1 / 60);
      kit.frame(1 / 60);
      play.setMounts(kit.state().mounts);
      play.frame(1 / 60, walk, fly.camera);
    };
    /** Runs `frames` frames, measuring the muzzles' steps; `at` changes the stick on a frame. */
    const run = (frames: number, at: Record<number, number> = {}): Run => {
      const out: Run = { ends: 0, clip: 0, pistol: 0, worst: '', unsynced: 0 };
      const muzzles = () => ({ rifle: through(rifle.matrix.elements, RIFLE_MUZZLE), pistol: through(pistol.matrix.elements, PISTOL_MUZZLE) });
      const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
      let last = muzzles(), since = -1;              // the first frame is the swap's start (`select` just ran)
      for (let f = 0; f < frames; f++) {
        if (at[f] !== undefined) input = { forward: at[f]!, right: 0 };
        const before = kit.state().mounts.rifle;
        step();
        const now = muzzles(), after = kit.state().mounts.rifle;
        since = before !== after ? 0 : since + 1;
        const d = dist(now.rifle, last.rifle);
        if (since <= 2) { if (d > out.ends) { out.ends = d; out.worst = `frame ${f}: the rifle ${before} -> ${after}`; } }
        else out.clip = Math.max(out.clip, d);
        out.pistol = Math.max(out.pistol, dist(now.pistol, last.pistol));
        // The rifle on the swap mount exactly while a swap clip plays (the kit on the walk's clock).
        if ((kit.state().mounts.rifle === 'swap') !== (walk.swapProgress() !== null)) out.unsynced++;
        last = now;
      }
      return out;
    };
    return { kit, run, dispose: () => { view.dispose(); walk.unbindKey(); } };
  };

  /**
   * The largest step of the rifle's muzzle at the swap's ends: the bug's were 2.4 to 6 units in one 60 Hz frame (the
   * rifle drawn where a cross-fade of two frames' tracks put it, then the jump to the clip's key); the clips' own swing
   * mid-swap reaches about 1.9 (`clip`, measured, not asserted).
   */
  const END_STEP = 0.9;
  /** The clips' own fastest swing of the muzzle mid-swap, about 1.9 a frame, with a margin (the cut's jump was 3.5). */
  const CLIP_STEP = 2.4;

  /** From the idle (or the run, `forward` 1), to `to` -- the pistol drawn first for the rifle -- measured. */
  const swap = async (to: Firearm, forward: number, at: Record<number, number> = {}): Promise<Run> => {
    const r = await rig();
    r.run(90, { 0: forward });                                  // settle into the idle (or the run)
    if (to === 'rifle') {
      expect(r.kit.select('pistol')).toBe(true);
      r.run(150);                                               // the pistol drawn, the swap over, the blend out settled
      expect(r.kit.state()).toMatchObject({ item: 'pistol', swap: null });
    }
    expect(r.kit.select(to)).toBe(true);
    const out = r.run(150, at);
    expect(r.kit.state()).toMatchObject({ item: to, swap: null });
    r.dispose();
    return out;
  };

  it('pistol -> rifle standing: the rifle leaves the back and comes to the hand without a jump at either end', async () => {
    const out = await swap('rifle', 0);
    expect(out.ends, out.worst).toBeLessThan(END_STEP);
    expect(out.unsynced).toBe(0);
  }, 60_000);

  it('rifle -> pistol standing: the rifle goes from the hand to the back without a jump', async () => {
    const out = await swap('pistol', 0);
    expect(out.ends, out.worst).toBeLessThan(END_STEP);
    expect(out.unsynced).toBe(0);
  }, 60_000);

  it('on the move (the overlay), both ways, and a standing swap the stick turns into the overlay', async () => {
    for (const [to, forward, at] of [['rifle', 1, {}], ['pistol', 1, {}], ['rifle', 0, { 25: 1 }], ['pistol', 0, { 25: 1 }]] as const) {
      const out = await swap(to, forward, at);
      expect(out.ends, `${to} ${forward} ${JSON.stringify(at)}: ${out.worst}`).toBeLessThan(END_STEP);
      expect(out.unsynced, `${to} ${forward} ${JSON.stringify(at)}`).toBe(0);
      // The cut: the standing clip and the moving one hold the rifle apart at the same phase (3.5 in a frame, eased).
      expect(out.clip, `${to} ${forward} ${JSON.stringify(at)}`).toBeLessThan(CLIP_STEP);
    }
  }, 120_000);
});
