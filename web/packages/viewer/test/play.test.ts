import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4 } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { partMatrix, type MotionClip, type MotionPart } from '@s2u/scene';
import { fixture } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { buildBody } from '../src/bodyView';
import { DEFAULT_LIGHTING } from '../src/lighting';
import { loadMap, type LoadedMap } from '../src/loadMap';
import { packGround, WalkMode, EYE_HEIGHT, type GroundData } from '../src/walk';
import { bodySkeleton, bodyVisible, eyePoint, Play, playActions } from '../src/play';
import { noInput } from '../src/gamepad';
import { existsSync } from 'node:fs';

/**
 * W2.2b: the play mode is the walk mode with the body. Entering walk shows the SEAL at the mover's feet, facing the
 * look; the clips drive its skeleton; leaving hides it unless the panel's body switch asks for it in fly mode.
 */

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};

/** A flat floor at y 0 over x, z -200..200, as the probe receives it. */
const GROUND: GroundData = packGround(
  { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
  [{
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
  }],
  [{ modelName: 'worldmodel', path: 'worldmodel/floor', first: 0, count: 1 }],
);

describe('the mover as the body reads it (WalkMode.snapshot)', () => {
  const made: WalkMode[] = [];
  afterEach(() => { for (const m of made.splice(0)) m.unbindKey(); });
  const setUp = () => {
    const fly = new FlyCamera(canvas());
    const mode = new WalkMode(fly);
    mode.setGround(GROUND, [0, 0, 0]);
    made.push(mode);
    return { fly, mode };
  };

  it('is null in fly mode; walking, the drawn feet under the eye, the look\'s yaw, the velocity and the stance', () => {
    const { fly, mode } = setUp();
    expect(mode.snapshot()).toBeNull();
    fly.setPose({ x: 10, y: 50, z: 20, yaw: 30, pitch: -5 });
    mode.setMode('walk');
    const s = mode.snapshot()!;
    expect(s).toMatchObject({ feet: [10, 0, 20], yaw: expect.closeTo(30, 9), vx: 0, vz: 0, vy: 0, airborne: false, crouched: false, landing: null, jumps: 0 });
    // a part tick in hand: the feet are drawn where the eye is, between the last two ticks
    mode.walkFor(0.5, { forward: 1, right: 0, boost: false });
    mode.frame(0.004);
    const t = mode.snapshot()!;
    expect(t.feet[1] + EYE_HEIGHT).toBeCloseTo(fly.pose().y, 9);
    expect(t.feet[0]).toBeCloseTo(fly.pose().x, 9);
    expect(t.feet[2]).toBeCloseTo(fly.pose().z, 9);
    expect(Math.hypot(t.vx, t.vz)).toBeGreaterThan(30);
  });

  it('counts the jumps it takes, so a take-off is seen even between two frames', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 50, z: 0, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    expect(mode.jump()).toBe(true);
    const s = mode.snapshot()!;
    expect(s).toMatchObject({ airborne: true, jumps: 1 });
    expect(s.vy).toBeGreaterThan(0);
    expect(mode.jump()).toBe(false);                     // no footing in the air: not counted
    expect(mode.snapshot()!.jumps).toBe(1);
    mode.crouch(true);
    expect(mode.snapshot()!.crouched).toBe(true);
  });
});

describe('who sees the body (W2.2b, W2.R1)', () => {
  it('shows it in the third-person play view, hides it in the aim view, and in fly mode only when the switch asks', () => {
    expect(bodyVisible('third', false)).toBe(true);
    expect(bodyVisible('third', true)).toBe(true);
    expect(bodyVisible('aim', true)).toBe(false);
    expect(bodyVisible('fly', false)).toBe(false);
    expect(bodyVisible('fly', true)).toBe(true);
  });
});

describe('the pad\'s lanes in play (W2.R5): jump on the press, crouch on the release, aim held', () => {
  it('jumps when the jump lane goes down, once however long it is held', () => {
    const up = { ...noInput(), jump: true };
    expect(playActions(noInput(), up)).toMatchObject({ jump: true, crouch: false, aim: false });
    expect(playActions(up, up).jump).toBe(false);
    expect(playActions(up, noInput()).jump).toBe(false);
  });

  it('crouches when the crouch lane comes up (docs/PLAYTEST.md step 8: the game acts on the release)', () => {
    const held = { ...noInput(), crouch: true };
    expect(playActions(noInput(), held).crouch).toBe(false);
    expect(playActions(held, held).crouch).toBe(false);
    expect(playActions(held, noInput()).crouch).toBe(true);
  });

  it('aims while the aim lane is held', () => {
    const aim = { ...noInput(), aim: true };
    expect(playActions(noInput(), aim).aim).toBe(true);
    expect(playActions(aim, aim).aim).toBe(true);
    expect(playActions(aim, noInput()).aim).toBe(false);
  });
});

const MP2 = fixture('RUN/MP2.ZDB');
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');

describe.skipIf(MP2 === null)('the SEAL on the mover (Frostfire\'s fixture)', () => {
  let map: LoadedMap;
  const loaded = async (): Promise<LoadedMap> => (map ??= await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB'));

  it('builds the scene skeleton from the body\'s parts: the same 26 slots and bind pose the page\'s bones have', async () => {
    const body = (await loaded()).body!;
    const sk = bodySkeleton(body);
    expect(sk.parts.map((p) => p.name)).toEqual(body.parts.map((p) => p.name));
    body.parts.forEach((p, i) => {
      for (let k = 0; k < 16; k++) expect(sk.bindWorld[i]![k]!).toBeCloseTo(p.bindWorld[k]!, 4);
    });
  });

  it('puts a pose on the bones part by part, and stands the body at the feet facing the yaw', async () => {
    const map = await loaded();
    const view = buildBody(map.body!, map, DEFAULT_LIGHTING);
    const sk = bodySkeleton(map.body!);
    const turn = partMatrix([Math.sin(0.3), 0, 0, Math.cos(0.3)], [1, 2, 3]);
    sk.setLocal('rthigh', turn);
    view.setPose(sk.local);
    const bone = view.group.getObjectByName('rthigh')!;
    bone.updateMatrix();
    const want = new Matrix4().fromArray(turn);
    for (let k = 0; k < 16; k++) expect(bone.matrix.elements[k]!).toBeCloseTo(want.elements[k]!, 5);
    view.place([100, 42, -7], 90);
    expect(view.group.position.toArray()).toEqual([100, 42, -7]);
    expect(view.group.rotation.y).toBeCloseTo(Math.PI / 2, 9);           // the look's yaw, in three's turn about y
    expect(view.stats.at).toEqual([100, 42, -7]);
    expect(view.stats.yaw).toBeCloseTo(Math.PI / 2, 9);
    view.dispose();
  });

  it('lights the body again when it turns: the rig is the world\'s, so a SEAL facing about is lit from its other side', async () => {
    const map = await loaded();
    const view = buildBody(map.body!, map, { ...DEFAULT_LIGHTING, rig: map.lightRig });
    const skin = view.group.children.find((o) => o.type === 'SkinnedMesh') as unknown as { geometry: { getAttribute(n: string): { array: Float32Array } } };
    const colours = (): number[] => Array.from(skin.geometry.getAttribute('color').array);
    const atA = colours();
    const yawA = (map.body!.at!.yaw * 180) / Math.PI;
    view.place(map.body!.at!.position, yawA + 5);                   // under the step: not lit again
    expect(colours()).toEqual(atA);
    view.place(map.body!.at!.position, yawA + 180);
    const about = colours();
    expect(about.some((v, i) => Math.abs(v - atA[i]!) > 0.05)).toBe(true);
    view.place(map.body!.at!.position, yawA);
    colours().forEach((v, i) => expect(v).toBeCloseTo(atA[i]!, 5));
    view.dispose();
  });

  it('plays: walking shows the body at the feet in its clip, fly hides it unless switched on, and the bind stays at A until played', async () => {
    const map = await loaded();
    const fly = new FlyCamera(canvas());
    const walk = new WalkMode(fly);
    walk.setGround(GROUND, [0, 0, 0]);
    const view = buildBody(map.body!, map, DEFAULT_LIGHTING);
    const play = new Play();
    play.setBody(view, map.body!);
    play.setClips({ clips: [still('seal_stand', 10), still('seal_walk', 10)], table: null });
    const slotA = [...view.group.position.toArray()];
    play.frame(1 / 60, walk);
    expect(view.group.visible).toBe(false);                 // fly mode, switch off
    expect(view.group.position.toArray()).toEqual(slotA);  // not played yet: W2.1's bind pose at slot A
    expect(play.animStats()).toBeNull();
    play.setFlyToggle(true);
    play.frame(1 / 60, walk);
    expect(view.group.visible).toBe(true);
    fly.setPose({ x: 5, y: 40, z: 6, yaw: -45, pitch: 0 });
    walk.setMode('walk');
    play.frame(1 / 60, walk);
    expect(view.group.visible).toBe(true);
    expect(view.group.position.toArray()).toEqual([5, 0, 6]);
    expect(view.group.rotation.y).toBeCloseTo(-Math.PI / 4, 9);
    expect(play.animStats()).toMatchObject({ clip: 'seal_stand' });
    play.setFlyToggle(false);
    walk.setMode('fly');
    play.frame(1 / 60, walk);
    expect(view.group.visible).toBe(false);
    play.setFlyToggle(true);
    play.frame(1 / 60, walk);
    expect(view.group.visible).toBe(true);
    expect(view.group.position.toArray()).toEqual([5, 0, 6]);  // where the play left it
    view.dispose();
    walk.unbindKey();
  });

  it('draws the frame over the shoulder in play, from the eye when aiming, with the fly camera in fly mode (W2.6)', async () => {
    const map = await loaded();
    const fly = new FlyCamera(canvas());
    fly.setClipPlanes(4, 5000);
    const walk = new WalkMode(fly);
    walk.setGround(GROUND, [0, 0, 0]);
    const view = buildBody(map.body!, map, DEFAULT_LIGHTING);
    const play = new Play();
    play.setBody(view, map.body!);
    play.setClips({ clips: [still('seal_stand', 10)], table: null });
    expect(play.frame(1 / 60, walk, fly.camera)).toBe(fly.camera);
    expect(play.viewStats()).toMatchObject({ kind: 'fly', rig: 'measured' });
    fly.setPose({ x: 5, y: 40, z: 6, yaw: 0, pitch: 0 });
    walk.setMode('walk');
    const third = play.frame(1 / 60, walk, fly.camera);
    expect(third).not.toBe(fly.camera);
    expect(play.viewStats().kind).toBe('third');
    expect(third.far).toBe(5000);                                        // the fly camera's projection
    // the measured rig over the stand clip's root at 11: 25 up, 23.1 behind, riding the root's 11 - 11.4845
    expect(third.position.x).toBeCloseTo(5, 6);
    expect(third.position.z).toBeCloseTo(6 + 23.1, 6);
    expect(third.position.y).toBeCloseTo(25 + 11 - 11.4845, 4);
    expect(view.group.visible).toBe(true);
    // the disc's rig is a switch, refused until the table is read
    expect(play.useDiscRig(true)).toBe(false);
    play.setCameraTable({ side: 0, height: 30, dist: 10, aim: [0, 30, -2] }, 1);
    expect(play.useDiscRig(true)).toBe(true);
    play.frame(1 / 60, walk, fly.camera);
    expect(play.viewStats().rig).toBe('disc');
    expect(third.position.z).toBeCloseTo(6 + 10, 6);
    play.useDiscRig(false);
    // aiming: the view from the eye, along the look; the body hidden. A bare fixture has no eye gear: the walk's eye.
    // A fixture that carries READERC.ZAR is dressed (as body.test.ts allows): the eye gear through the stand pose.
    play.setAimLane(true);
    const aim = play.frame(1 / 60, walk, fly.camera);
    expect(play.viewStats().kind).toBe('aim');
    expect(view.group.visible).toBe(false);
    if (map.body!.eye === null) {
      expect(aim.position.toArray()).toEqual(fly.camera.position.toArray());
    } else {
      const sk = bodySkeleton(map.body!);
      // the stand clip's root: its bind x and z, the clip's 11 for y
      const bind = map.body!.parts.find((p) => p.name === 'skel_root')!.bindLocal;
      sk.setLocal('skel_root', partMatrix([0, 0, 0, 1], [bind[12]!, 11, bind[14]!]));
      sk.update();
      const eye = eyePoint(map.body!, sk.palette())!;
      const feet = fly.camera.position.toArray();
      feet[1] -= EYE_HEIGHT;
      expect(aim.position.x).toBeCloseTo(feet[0]! + eye[0], 4);             // yaw 0: the actor's axes are the world's
      expect(aim.position.y).toBeCloseTo(feet[1]! + eye[1], 4);
      expect(aim.position.z).toBeCloseTo(feet[2]! + eye[2], 4);
    }
    play.setAimLane(false);
    expect(play.setAimForced(true)).toBe('aim');                         // the hook's, over the lanes
    play.frame(1 / 60, walk, fly.camera);
    expect(play.viewStats().kind).toBe('aim');
    expect(play.setAimForced(null)).toBe('third');
    walk.setMode('fly');
    expect(play.frame(1 / 60, walk, fly.camera)).toBe(fly.camera);
    expect(play.viewStats().kind).toBe('fly');
    view.dispose();
    walk.unbindKey();
  });
});

const SERVED = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps');
const dressed = existsSync(resolve(SERVED, 'RUN/READERC.ZAR')) && existsSync(resolve(SERVED, 'RUN/MP2.ZDB'));

describe.skipIf(!dressed)('the aim view\'s eye on the dressed SEAL (served tree)', () => {
  it('is the eye gear through the pose: 18.16 over the feet in the bind pose (research 78 §6.3), lower crouched', async () => {
    const map = await loadMap(new FsAssetSource(SERVED), 'RUN/MP2.ZDB');
    const sk = bodySkeleton(map.body!);
    const eye = eyePoint(map.body!, sk.palette())!;
    expect(eye[1]).toBeCloseTo(map.body!.eye!, 4);
    expect(eye[1]).toBeCloseTo(18.16, 2);
    expect(eye[2]).toBeLessThan(0);                                       // ahead of the head joint, along -z
    sk.setLocal('skel_root', partMatrix([0, 0, 0, 1], [0, 5.504, 0.5334]));   // the root down at the crouch's height
    sk.update();
    expect(eyePoint(map.body!, sk.palette())![1]).toBeCloseTo(18.16 - (11.67 - 5.504), 1);
  });
});

/** A clip holding the root at 11 and every other part at the bind. */
function still(name: string, frames: number): MotionClip {
  const parts: MotionPart[] = [{
    index: 0, name: 'skel_root', flags: 0x3c, translations: Float32Array.of(0, 11, 0), rotations: Float32Array.of(0, 0, 0, 1),
  }];
  return { name, version: 5, duration: frames / 30, frameCount: frames, rate: 30, unknown10: -1, unknown14: 1, parts };
}
