import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RIFLE, HELD_RIFLE, type GridParams, type WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { Fire } from '../src/fire';
import { encodeCommands } from '../src/net/codec';
import { ShotCone, type AimMover } from '../src/net/shotCone';
import type { Command } from '../src/net/protocol';
import { Traversal } from '../src/traversal';
import { groundPolygons, packGround, WalkMode } from '../src/walk';
import { shortTurn, wrapYaw, wrapYawRad } from '../src/yaw';

/**
 * The yaw's winding (web research 86 section 3.8). SOCOM II keeps a facing as a rotation, never an angle, so it has no
 * winding: facing a way after two turns round is facing it. The page's camera added every turn to its yaw and never
 * wrapped it, so a look wound twice round reached the mover, the body and the climb's steer as 750 where 30 was meant,
 * and each hand-rolled `((a - b + 540) % 360) - 180` was one sign away from spinning the long way. Pinned here: the
 * one arithmetic (`yaw.ts`), the camera storing the canonical [0, 360) (the wire's range, `net/codec`), and -- spun two
 * turns either way -- the same look, the same round, the same bytes on the wire and the same climb as never turned.
 */

describe('the yaw arithmetic (yaw.ts)', () => {
  it('wrapYaw: [0, 360) for any winding; the same facing is the same number', () => {
    for (const [d, want] of [[0, 0], [30, 30], [390, 30], [750, 30], [-330, 30], [-690, 30], [360, 0], [-360, 0], [-0, 0], [359.5, 359.5], [-0.5, 359.5]] as const) {
      expect(wrapYaw(d), `${d}`).toBeCloseTo(want, 9);
    }
    expect(wrapYaw(-1e-14)).toBe(0);                                 // + 360 rounds to 360: still in range
    for (let d = -5000; d <= 5000; d += 13.7) {
      const w = wrapYaw(d);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(360);
      expect(Math.abs(Math.sin(((w - d) * Math.PI) / 180))).toBeLessThan(1e-9);
    }
  });

  it('wrapYawRad: [0, 2 pi) the same way', () => {
    expect(wrapYawRad(-1e-17)).toBe(0);
    expect(wrapYawRad(4 * Math.PI + 0.5)).toBeCloseTo(0.5, 9);
    expect(wrapYawRad(-0.5)).toBeCloseTo(2 * Math.PI - 0.5, 9);
    for (let r = -40; r <= 40; r += 0.37) {
      const w = wrapYawRad(r);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(2 * Math.PI);
    }
  });

  it('shortTurn: FUN_005b2d20\'s short way, signed, in [-180, 180); where the old wrap failed it holds', () => {
    expect(shortTurn(359, 1)).toBeCloseTo(2, 9);
    expect(shortTurn(1, 359)).toBeCloseTo(-2, 9);
    expect(shortTurn(0, -600)).toBeCloseTo(120, 9);                  // ((to - from + 540) % 360) - 180 gave -240
    expect(shortTurn(750, 30)).toBeCloseTo(0, 9);
    expect(shortTurn(0, 180)).toBe(-180);
    for (let from = -1000; from <= 1000; from += 41) for (let to = -1000; to <= 1000; to += 53) {
      const d = shortTurn(from, to);
      expect(d).toBeGreaterThanOrEqual(-180);
      expect(d).toBeLessThan(180);
      expect(d).toBeCloseTo(shortTurn(wrapYaw(from), wrapYaw(to)), 9);
    }
  });
});

const key = (type: 'keydown' | 'keyup', code: string): void => { globalThis.dispatchEvent(new KeyboardEvent(type, { code })); };

describe('the page camera stores its yaw canonical (camera.ts)', () => {
  afterEach(() => { key('keyup', 'ArrowLeft'); key('keyup', 'ArrowRight'); });

  it('a pose set at any winding reads back in [0, 360), the same view', () => {
    const at = (yaw: number): FlyCamera => { const f = new FlyCamera(document.createElement('canvas')); f.setPose({ x: 0, y: 0, z: 0, yaw, pitch: 10 }); return f; };
    const base = at(30);
    for (const yaw of [750, -330, -690, 1110]) {
      const f = at(yaw);
      expect(f.pose().yaw, `${yaw}`).toBeCloseTo(30, 9);
      expect(f.camera.quaternion.angleTo(base.camera.quaternion), `${yaw}`).toBeLessThan(1e-9);
    }
    expect(at(-90).pose().yaw).toBeCloseTo(270, 9);
  });

  for (const [arrow, sign] of [['ArrowLeft', 1], ['ArrowRight', -1]] as const) {
    it(`flying, ${arrow} held two turns and more: every frame's yaw in [0, 360), ending where the turn's total puts it`, () => {
      const fly = new FlyCamera(document.createElement('canvas'));
      fly.setPose({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
      key('keydown', arrow);
      for (let i = 0; i < 480; i++) {                                // 8 s at ARROW_LOOK 1.6 rad/s: 733 degrees
        fly.update(1 / 60);
        const y = fly.pose().yaw;
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(360);
      }
      key('keyup', arrow);
      const total = (sign * 1.6 * 8 * 180) / Math.PI;
      expect(shortTurn(wrapYaw(total), fly.pose().yaw)).toBeCloseTo(0, 6);
      const still = new FlyCamera(document.createElement('canvas'));
      still.setPose({ x: 0, y: 0, z: 0, yaw: total, pitch: 0 });
      expect(fly.camera.quaternion.angleTo(still.camera.quaternion)).toBeLessThan(1e-6);
    });
  }

  it('walking, the look law turned two turns and more: the look and the body\'s yaw stay in [0, 360)', () => {
    const fly = new FlyCamera(document.createElement('canvas'));
    fly.setWalking(true);
    fly.setPose({ x: 0, y: 0, z: 0, yaw: 350, pitch: 0 });
    key('keydown', 'ArrowLeft');
    let turned = 0, prev = fly.pose().yaw;
    for (let i = 0; i < 60 * 7; i++) {
      fly.update(1 / 60);
      const s = fly.lookState();
      expect(s.lookYaw).toBeGreaterThanOrEqual(0);
      expect(s.lookYaw).toBeLessThan(360);
      expect(s.bodyYaw).toBe(s.lookYaw);
      turned += shortTurn(prev, s.lookYaw);
      prev = s.lookYaw;
    }
    expect(turned).toBeGreaterThan(720);                              // it did go twice round
  });
});

// ---- the walk, spun two turns either way: the same look, round, wire and climb ------------------------------------

const quad = (pts: number[], ditype: number, appflags = 0): WorldPoly => ({
  modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, appflags, points: Float32Array.from(pts),
});
const flat = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3);
/** A floor, a 12 crate (x -10..10, z -30..0; its sides appflags 4, the climb's) and a wall far behind it to shoot at. */
const POLYS: WorldPoly[] = [
  flat(-100, -100, 100, 100, 0),
  quad([-10, 0, 0, 10, 0, 0, 10, 12, 0, -10, 12, 0], 2, 4), quad([-10, 0, -30, 10, 0, -30, 10, 12, -30, -10, 12, -30], 2, 4),
  quad([-10, 0, -30, -10, 0, 0, -10, 12, 0, -10, 12, -30], 2, 4), quad([10, 0, -30, 10, 0, 0, 10, 12, 0, 10, 12, -30], 2, 4),
  flat(-10, -30, 10, 0, 12),
  quad([-100, 0, -90, 100, 0, -90, 100, 80, -90, -100, 80, -90], 2),
];
const PARAMS: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
const GROUND = packGround(PARAMS, POLYS, POLYS.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 })));

interface Run {
  look: number; body: number; aim: { eye: number[]; far: number[] }; round: number[] | null; wire: number[];
  prompt: string | null; climbed: boolean; feet: number[]; endYaw: number;
}

/** Stand at (0, 6), look `yaw` (-20 + 360 k: toward the crate, 20 degrees right), then fire, send, walk in and climb. */
function spun(yaw: number): Run {
  const fly = new FlyCamera(document.createElement('canvas'));
  const walk = new WalkMode(fly);
  let t: Traversal | null = null;
  walk.useTraversal((w, g) => (t = new Traversal(w.grid, groundPolygons(g))));
  walk.setGround(GROUND, null);
  fly.setPose({ x: 0, y: 10, z: 6, yaw: 0, pitch: 0 });
  expect(walk.setMode('walk')).toBe(true);
  walk.setCamera({ yaw, pitch: 0 });
  const look = fly.pose().yaw, body = walk.snapshot()!.yaw;
  const aim = walk.fireAim()!;
  const shot = new Fire({ grid: () => walk.grid(), aim: () => walk.fireAim() }, DEFAULT_RIFLE, undefined, () => 0.5).shoot();
  const sent: Command[] = [];
  walk.setNetTap((cmd) => sent.push({ ...cmd, seq: sent.length + 1 }));
  for (let i = 0; i < 4; i++) walk.frame(1 / 30);
  walk.setNetTap(null);
  const wire = [...encodeCommands({ viewTick: 7, commands: sent })];
  let prompt: string | null = null;
  for (let i = 0; i < 60 && prompt === null; i++) { walk.walkFor(1 / 30, { forward: 1, right: 0, boost: false }); prompt = t!.climbPrompt()?.kind ?? null; }
  let climbed = false;
  if (prompt) {
    walk.action();
    for (let i = 0; i < 300 && t!.state().kind !== 'none' || i < 2; i++) {
      walk.walkFor(1 / 30, { forward: 0, right: 0, boost: false });
      if (t!.state().kind === 'climb') climbed = true;
    }
  }
  return {
    look, body, aim: { eye: [...aim.eye], far: [...aim.far] }, round: shot?.hit ? [...shot.hit.point] : null, wire, prompt, climbed,
    feet: walk.feet()!, endYaw: walk.snapshot()!.yaw,
  };
}

const near = (a: readonly number[], b: readonly number[], label: string, digits = 6): void => {
  expect(a.length, label).toBe(b.length);
  a.forEach((v, i) => expect(v, `${label}[${i}]`).toBeCloseTo(b[i]!, digits));
};

describe('spun two turns either way, the walk is the walk never turned (look, round, wire, climb)', () => {
  const base = spun(-20);

  it('the unturned run is the case: facing the crate 20 degrees off, a round on the wall, a climb onto the top', () => {
    expect(base.look).toBeCloseTo(340, 9);
    expect(base.body).toBeCloseTo(340, 9);
    expect(base.round).not.toBeNull();
    expect(base.wire.length).toBeGreaterThan(0);
    expect(base.prompt).toBe('low');
    expect(base.climbed).toBe(true);
    expect(base.feet[1]).toBeCloseTo(12, 6);
    expect(base.feet[2]).toBeLessThan(0);
  });

  for (const wind of [720, -720, 1080, 360 * 7]) {
    it(`look -20 + ${wind}: the same look and body yaw, aim, round, command bytes, climb and end`, () => {
      const r = spun(-20 + wind);
      expect(r.look).toBeCloseTo(base.look, 6);
      expect(r.body).toBeCloseTo(base.body, 6);
      near(r.aim.eye, base.aim.eye, 'eye');
      near(r.aim.far, base.aim.far, 'far', 4);
      near(r.round!, base.round!, 'round', 5);
      expect(r.wire).toEqual(base.wire);
      expect(r.prompt).toBe(base.prompt);
      expect(r.climbed).toBe(true);
      near(r.feet, base.feet, 'feet', 5);
      expect(r.endYaw).toBeGreaterThanOrEqual(0);
      expect(r.endYaw).toBeLessThan(360);
      expect(shortTurn(base.endYaw, r.endYaw)).toBeCloseTo(0, 5);
    });
  }
});

describe('the look rate across north: the shot cone sees a 2 degree turn, not 358 (research 84 section 17)', () => {
  const still: AimMover = { feet: [0, 0, 0], velocity: [0, 0, 0], airborne: false, posture: 'stand', moveRoot: null, peek: 0, weapon: 0 };
  /** The cone's state after a still SEAL turning through `yaws`, one command a tick. */
  const cone = (yaws: number[]): ReturnType<ShotCone['state']> => {
    const c = new ShotCone(HELD_RIFLE);
    yaws.forEach((yaw, i) => c.tick({ seq: i + 1, forward: 0, right: 0, yaw, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }, still, i + 1));
    return c.state();
  };
  const turning = [1, 3, 5, 7, 9, 11, 13, 15];

  it('commands at 355 .. 9 across north turn the cone as 1 .. 15 do; and it does turn it', () => {
    expect(cone([355, 357, 359, 1, 3, 5, 7, 9])).toEqual(cone(turning));
    expect(cone(turning).exertion).toBeGreaterThan(cone(turning.map(() => 1)).exertion);
  });

  it('the same look at any winding is the same cone', () => {
    expect(cone(turning.map((y, i) => y + (i % 2 ? 720 : -720)))).toEqual(cone(turning));
  });
});
