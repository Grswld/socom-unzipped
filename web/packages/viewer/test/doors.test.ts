import { describe, expect, it } from 'vitest';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { simMapFromBytes } from '../src/simMap';
import { DoorSet, pickDoor } from '../src/doors';
import { groundGrid, Walker, TICK, BODY_RADIUS, type WalkInput } from '../src/mover';

/**
 * The doors (web/docs/research/92-doors.md): the owner's play test of 2026-09-29 -- "opening doors: I can see the
 * action but they do not open or close". Frostfire's `bdoor_4` is research 24's leaf between B's region and the
 * building (x 576-589, z 1117-1118): shut it stops the SEAL (walk.test.ts pins that); the action on it must swing it
 * open and let the SEAL through, and a second action must shut it again.
 */

const MP2 = fixture('RUN/MP2.ZDB');
const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };
/** The yaw that faces from (x, z) toward (tx, tz) (`camera.ts`: the camera looks down its own -z). */
const facing = (x: number, z: number, tx: number, tz: number): number => Math.atan2(-(tx - x), -(tz - z)) * 180 / Math.PI;

const MP6 = fixture('RUN/MP6.ZDB');
describe.skipIf(!MP6)(`Desert Glory's door${MP6 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('cdoor1 swings open with the metal door\'s sound and shuts again', () => {
    const map = simMapFromBytes(MP6!, 'RUN/MP6.ZDB');
    const sounds: string[] = [];
    const doors = new DoorSet(map.doors ?? [], map.ground, { sound: (name) => sounds.push(name) });
    expect(doors.specs.map((d) => d.node)).toEqual(['cdoor1']);
    const rest = doors.leaf(0).map((p) => Float32Array.from(p));
    expect(doors.use(0)).toBe(true);
    for (let k = 0; k < 10 / TICK && doors.state(0).busy; k++) doors.step(TICK);
    expect(doors.state(0).open).toBe(true);
    expect(sounds[0]).toBe('.DOOR_METAL_OPN');
    const far = Math.max(...doors.leaf(0).flatMap((p, a) => Array.from(p, (v, k) => Math.abs(v - rest[a]![k]!))));
    expect(far).toBeGreaterThan(10);
    doors.use(0);
    for (let k = 0; k < 10 / TICK && doors.state(0).busy; k++) doors.step(TICK);
    expect(doors.state(0).open).toBe(false);
    doors.leaf(0).forEach((p, a) => p.forEach((v, k) => expect(v).toBeCloseTo(rest[a]![k]!, 3)));
  });
});

describe.skipIf(!MP2)(`Frostfire's doors${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  const map = MP2 ? simMapFromBytes(MP2, 'RUN/MP2.ZDB') : null;

  it('are its three DOOR actions, each on its node with the leaf\'s polygons, a valve and its swing', () => {
    const doors = map!.doors ?? [];
    expect(doors.map((d) => d.node)).toEqual(['bdoor_4', 'wdoor_1', 'wdoor_2']);
    for (const d of doors) {
      expect(d.owners.length, d.node).toBeGreaterThan(0);
      expect(d.programs.length, d.node).toBeGreaterThan(0);
      expect(d.valve, d.node).not.toBe('');
      expect(d.range).toBe(30);
    }
  });

  it('bdoor_4 stops the SEAL shut; used, it swings open and lets it through; used again it shuts, and stops it again', () => {
    const doors = new DoorSet(map!.doors ?? [], map!.ground);
    const i = doors.specs.findIndex((d) => d.node === 'bdoor_4');
    const walkAt = (): Walker => {
      const w = new Walker(groundGrid(map!.ground));
      expect(w.place(582.5, 142 + 15.4, 1135)).toBe(true);
      w.state.yaw = facing(582.5, 1135, 582.5, 1000);
      return w;
    };
    // Shut: the leaf stops it a body's radius short (walk.test.ts's check).
    let w = walkAt();
    for (let k = 0; k < 120; k++) w.tick(FORWARD);
    expect(w.state.z).toBeGreaterThan(1118);
    expect(w.state.z).toBeLessThan(1118 + BODY_RADIUS + 1);
    expect(doors.state(i).open).toBe(false);

    // The action, from where the SEAL stands: the swing runs, then the door is open and at rest.
    expect(doors.use(i, [w.state.x, w.state.y, w.state.z])).toBe(true);
    expect(doors.state(i).busy).toBe(true);
    expect(doors.use(i, [w.state.x, w.state.y, w.state.z])).toBe(false);          // refused mid-swing (FUN_002b44e0)
    for (let k = 0; k < 10 / TICK && doors.state(i).busy; k++) doors.step(TICK);
    expect(doors.state(i)).toMatchObject({ open: true, busy: false });
    w = walkAt();
    for (let k = 0; k < 180; k++) w.tick(FORWARD);
    expect(w.state.z).toBeLessThan(1110);                                           // through the doorway

    // Again: it shuts, and the leaf stops the SEAL once more.
    expect(doors.use(i, [582.5, 142, 1130])).toBe(true);
    for (let k = 0; k < 10 / TICK && doors.state(i).busy; k++) doors.step(TICK);
    expect(doors.state(i)).toMatchObject({ open: false, busy: false });
    w = walkAt();
    for (let k = 0; k < 120; k++) w.tick(FORWARD);
    expect(w.state.z).toBeGreaterThan(1118);
  });

  it('the swing plays the door\'s sound and moves the drawn leaf with the hull, back to where it was when shut', () => {
    const sounds: string[] = [];
    let last: Float32Array | null = null;
    const doors = new DoorSet(map!.doors ?? [], map!.ground, { sound: (name) => sounds.push(name), moved: (_d, m) => { last = m; } });
    const i = doors.specs.findIndex((d) => d.node === 'bdoor_4');
    doors.use(i, [582.5, 142, 1130]);
    for (let k = 0; k < 10 / TICK && doors.state(i).busy; k++) doors.step(TICK);
    expect(sounds.length).toBeGreaterThan(0);
    expect(last).not.toBeNull();
    const open = Array.from(last!);
    expect(open.some((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0)) > 0.1)).toBe(true);   // not the identity: it turned
    doors.use(i, [582.5, 142, 1130]);
    for (let k = 0; k < 10 / TICK && doors.state(i).busy; k++) doors.step(TICK);
    Array.from(last!).forEach((v, k) => expect(v).toBeCloseTo(k % 5 === 0 ? 1 : 0, 3));   // shut: the identity again
  });

  it('is picked as the game picks it: the reticle on the leaf, the SEAL within its range', () => {
    const doors = new DoorSet(map!.doors ?? [], map!.ground);
    const grid = groundGrid(map!.ground);
    const i = doors.specs.findIndex((d) => d.node === 'bdoor_4');
    // From B's side, the eye at 1135 looking north at the leaf: picked.
    expect(pickDoor(doors, grid, [582.5, 157.4, 1135], [582.5, 157.4, 135], [582.5, 142, 1135])).toBe(i);
    // Looking away (south): nothing.
    expect(pickDoor(doors, grid, [582.5, 157.4, 1135], [582.5, 157.4, 2135], [582.5, 142, 1135])).toBeNull();
    // Looking at it from past its range (60 units back): nothing.
    expect(pickDoor(doors, grid, [582.5, 157.4, 1178], [582.5, 157.4, 178], [582.5, 142, 1178])).toBeNull();
    // hud.spec.ts's stand before wdoor_2: 20 short of its node, looking along +z.
    const w2 = doors.specs.findIndex((d) => d.node === 'wdoor_2');
    expect(pickDoor(doors, grid, [897.5, 115.4, 975], [897.5, 115.4, 1975], [897.5, 100, 975])).toBe(w2);
    // Mid-swing it is not offered (FUN_002b46f0).
    doors.use(i, [582.5, 142, 1135]);
    doors.step(TICK);
    expect(pickDoor(doors, grid, [582.5, 157.4, 1135], [582.5, 157.4, 135], [582.5, 142, 1135])).toBeNull();
  });

  it('carries its state on the wire: the server\'s doors, applied on a page, stand where the server\'s do', () => {
    const server = new DoorSet(map!.doors ?? [], map!.ground);
    const page = new DoorSet(map!.doors ?? [], null);
    const i = server.specs.findIndex((d) => d.node === 'bdoor_4');
    expect(server.wire().every((d) => d.valve === 0 && d.phase === 255)).toBe(true);
    server.use(i, [582.5, 142, 1130]);
    server.step(TICK * 6);
    const mid = server.wire()[i]!;
    expect(mid.valve === 1 || mid.phase < 255).toBe(true);
    for (let k = 0; k < 10 / TICK && server.state(i).busy; k++) server.step(TICK);
    page.applyWire(server.wire());
    for (let k = 0; k < 10 / TICK && page.state(i).busy; k++) page.step(TICK);
    expect(page.state(i).open).toBe(true);
    expect(page.wire()).toEqual(server.wire());
  });
});
