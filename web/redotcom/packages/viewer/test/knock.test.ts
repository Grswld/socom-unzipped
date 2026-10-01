import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, WorldPoly } from '@s2u/scene';
import { ACTION_CODES, applyKnock, groundGrid, MoverSim, packGround, SEAL_ANIMS, Walker, type Knock } from '../src/sim';

/**
 * The blast's knock on the shared mover (`FUN_0057e770` L440940-441092, `FUN_005807d0` L442057-442137, the landing on
 * a knock `FUN_005805b0` via L441960-441985, the get-up on its end L446653-446700): off the ground at the push, in
 * `Fall forward` / `Fall backwards`; on the ground `Land forward` / `Land backwards`, then `Get up forward` /
 * `Get up backwards`. The server's room and the page's prediction run the same `Walker`, so the two agree.
 */

function flat(): Walker {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
  const floor: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-1000, 0, -1000, 1000, 0, -1000, 1000, 0, 1000, -1000, 0, 1000]),
  };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
  const w = new Walker(groundGrid(packGround(params, [floor], owners)));
  w.place(0, 20, 0);
  w.settle();
  return w;
}

const still = { forward: 0, right: 0, boost: false };
const PUSH: Knock = { velocity: [11.3, 48.8, 0], fall: 'fallForward' };

describe('the knock on the mover', () => {
  it('leaves the ground at the push in `Fall forward`, lands in `Land forward`, then gets up forward', () => {
    const w = flat();
    expect(w.knock(PUSH.velocity, PUSH.fall)).toBe(true);
    expect(w.action?.name).toBe('fallForward');
    const seen: string[] = [];
    let air = 0, landedAt = Number.NaN;
    for (let i = 0; i < 6 * 60; i++) {
      w.tick(still);
      if (w.airborne) air++;
      const n = w.action?.name ?? 'none';
      if (seen[seen.length - 1] !== n) { seen.push(n); if (n === 'landDeath') landedAt = w.state.x; }
    }
    // 48.8 up at g 235: about 0.42 s in the air.
    expect(air / 60).toBeGreaterThan(0.3);
    expect(air / 60).toBeLessThan(0.5);
    expect(seen).toEqual(['fallForward', 'landDeath', 'getUp', 'none']);
    expect(landedAt).toBeGreaterThan(4);                         // carried along the push while in the air (11.3 x ~0.42 s)
    expect(w.state.y).toBeCloseTo(0, 6);
  });

  it('falls backwards into `Land backwards` and `Get up backwards`', () => {
    const w = flat();
    w.knock([-5, 40, 0], 'fallBackwards');
    const seen: string[] = [];
    for (let i = 0; i < 6 * 60; i++) {
      w.tick(still);
      const n = w.action?.name ?? 'none';
      if (seen[seen.length - 1] !== n) seen.push(n);
    }
    expect(seen).toEqual(['fallBackwards', 'landBackwards', 'getUpBackwards', 'none']);
  });

  it('dead (the server\'s `kill`), the knocked SEAL stays down in its landing: no get-up follows', () => {
    for (const fall of ['fallForward', 'fallBackwards'] as const) {
      const w = flat();
      w.knock([fall === 'fallForward' ? 5 : -5, 40, 0], fall);
      w.dead = true;
      const seen: string[] = [];
      for (let i = 0; i < 6 * 60; i++) {
        w.tick(still);
        const n = w.action?.name ?? 'none';
        if (seen[seen.length - 1] !== n) seen.push(n);
      }
      expect(seen).toEqual([fall, fall === 'fallForward' ? 'landDeath' : 'landBackwards']);
    }
  });

  it('a kill heard after the get-up began puts the landing back', () => {
    const w = flat();
    w.knock([-5, 40, 0], 'fallBackwards');
    for (let i = 0; i < 6 * 60 && w.action?.name !== 'getUpBackwards'; i++) w.tick(still);
    expect(w.action?.name).toBe('getUpBackwards');
    w.dead = true;
    expect(w.action?.name).toBe('landBackwards');
  });

  it('holds the SEAL: no jump while knocked', () => {
    const w = flat();
    w.knock(PUSH.velocity, PUSH.fall);
    expect(w.jump()).toBe(false);
  });

  it('is the same on two movers fed the same ticks (the room and the page agree)', () => {
    const a = flat(), b = flat();
    applyKnock(a, null, PUSH);
    applyKnock(b, null, PUSH);
    for (let i = 0; i < 120; i++) { a.tick({ forward: 1, right: 0, boost: false }); b.tick({ forward: 1, right: 0, boost: false }); }
    expect([a.state.x, a.state.y, a.state.z]).toEqual([b.state.x, b.state.y, b.state.z]);
  });

  it('is refused while a traversal move holds the mover (KNOCK_IN_MOVE_PLACEHOLDER)', () => {
    const w = flat();
    expect(applyKnock(w, { busy: () => true }, PUSH)).toBe(false);
    expect(w.action).toBeNull();
    const sim = new MoverSim(w, null);
    expect(applyKnock(sim.walker, sim.moves, PUSH)).toBe(true);
  });

  it('sends the four clips on the wire and asks the pack for them', () => {
    for (const name of ['fallForward', 'fallBackwards', 'landBackwards', 'getUpBackwards'] as const) expect(ACTION_CODES).toContain(name);
    expect(SEAL_ANIMS).toMatchObject({
      fallForward: 'seal_fallforward01', fallBackwards: 'seal_fallbackwards01',
      landBackwards: 'seal_landbackwards01', getUpBackwards: 'seal_getupbackwards01',
    });
  });
});
