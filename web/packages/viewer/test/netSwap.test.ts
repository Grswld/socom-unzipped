import { describe, expect, it } from 'vitest';
import { FlyCamera } from '../src/camera';
import { packGround, WalkMode, type GroundData } from '../src/walk';
import { Button, type Command } from '../src/net/protocol';

/**
 * The swap on the wire (web sprint 3's merge review): `WalkMode.swapWeapon` replicates a swap only when the mover took
 * it. A refused one -- in the air, while another swap plays, while a move holds the mover -- must neither send the
 * `Swap` press nor change the weapon every later command reports in hand, or the other screens and the server's
 * shots read a weapon the SEAL never drew.
 */

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

function rig() {
  const fly = new FlyCamera(canvas());
  const walk = new WalkMode(fly);
  walk.setGround(GROUND, [0, 0, 0]);
  fly.setPose({ x: 5, y: 40, z: 6, yaw: 0, pitch: 0 });
  walk.setMode('walk');
  fly.groundWish = () => ({ forward: 0, right: 0, boost: false });
  const sent: Omit<Command, 'seq'>[] = [];
  walk.setNetTap((cmd) => sent.push(cmd));
  /** One 60 Hz frame; the commands it sent. */
  const tick = (): Omit<Command, 'seq'>[] => { const from = sent.length; walk.frame(1 / 60); return sent.slice(from); };
  for (let i = 0; i < 10; i++) tick();                           // settled on the floor
  return { walk, tick, dispose: () => walk.unbindKey() };
}

describe('the swap is replicated only when the mover takes it', () => {
  it('an accepted swap sends the press and the new weapon', () => {
    const { walk, tick, dispose } = rig();
    expect(walk.swapWeapon('pistol')).not.toBeNull();
    const [cmd] = tick();
    expect(cmd!.buttons & Button.Swap).toBe(Button.Swap);
    expect(cmd!.weapon).toBe(1);
    dispose();
  });

  it('a swap refused mid-swap sends no press and keeps the weapon in hand', () => {
    const { walk, tick, dispose } = rig();
    expect(walk.swapWeapon('pistol')).not.toBeNull();
    tick();
    expect(walk.swapWeapon('rifle')).toBeNull();                   // one at a time: the mover refuses
    const cmds = [...tick(), ...tick()];
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.buttons & Button.Swap).toBe(0);
      expect(c.weapon).toBe(1);
    }
    dispose();
  });

  it('a swap refused through a jump sends no press and keeps the rifle', () => {
    const { walk, tick, dispose } = rig();
    expect(walk.jump()).toBe(true);
    tick();
    expect(walk.swapWeapon('pistol')).toBeNull();                  // the jump (its action, then the air) refuses it
    const cmds = [...tick(), ...tick()];
    for (const c of cmds) {
      expect(c.buttons & Button.Swap).toBe(0);
      expect(c.weapon).toBe(0);
    }
    dispose();
  });
});
