import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, WorldPoly } from '@s2u/scene';
import { noInput } from '../src/gamepad';
import type { ActionPrompt } from '../src/hud';
import { FALL_IN_WATER, LADDER_SLIDE_SOUND, TraversalPage } from '../src/traversalPage';
import { groundGrid, packGround, Walker, type GroundData, type TraversalHooks, type WalkInput, type WalkMode } from '../src/walk';

/**
 * The traversal on the page (web research 86 section 7): the pad's Cross presses the action and its d-pad sides hold the
 * peek, the HUD gets the climb prompt and the ladder slide's icon, and the sounds no clip carries go to the audio.
 */

const quad = (pts: number[], ditype: number, appflags = 0): WorldPoly => ({
  modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, appflags, points: Float32Array.from(pts),
});
const floor = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3);

/** A 12-high crate (appflags 4) at z -30..0, and a ladder (appflags 2) up a 40 wall at x 60 with a deck behind it. */
function ground(): GroundData {
  const polys = [
    floor(-100, 0, 100, 100, 0), floor(-100, -100, 50, 0, 0), floor(50, -100, 100, 0, 40),
    quad([-10, 0, 0, 10, 0, 0, 10, 12, 0, -10, 12, 0], 2, 4), floor(-10, -30, 10, 0, 12),
    quad([50, 0, 0, 100, 0, 0, 100, 40, 0, 50, 40, 0], 2),
    quad([57, 0, 0.2, 63, 0, 0.2, 63, 40, 0.2, 57, 40, 0.2], 2, 2), quad([63, 40, 0.2, 57, 40, 0.2, 57, 50, 0.2, 63, 50, 0.2], 2, 2),
    { ...floor(-100, 20, -60, 60, 6), material: 11 },               // a pool 6 deep (WATER)
  ];
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return packGround(params, polys, owners);
}

/** The part of `WalkMode` the page drives, over a real mover and the moves the page's factory makes. */
function page(sounds: ConstructorParameters<typeof TraversalPage>[1] = null) {
  const g = ground();
  const walker = new Walker(groundGrid(g));
  let moves: TraversalHooks | null = null;
  let actions = 0, lean = 0;
  const walk = {
    useTraversal(f: (w: Walker, g: GroundData) => TraversalHooks) { moves = f(walker, g); walker.driver = moves; },
    traversal: () => moves,
    action: () => { actions++; moves?.action(); return true; },
    mode: () => 'walk',
    lean: (side: -1 | 0 | 1) => { lean = side; moves?.lean(side); },
    drawnFeet: () => walker.drawnFeet(),
  } as unknown as WalkMode;
  const p = new TraversalPage(walk, sounds);
  return { p, walker, actions: () => actions, lean: () => lean };
}

const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };
const STILL: WalkInput = { forward: 0, right: 0, boost: false };

describe('the pad on the traversal (research 86 section 7.4)', () => {
  it('Cross takes the action on its release (the game\'s state 3), once; the d-pad sides hold the peek', () => {
    const { p, actions, lean } = page();
    const down = { ...noInput(), action: true };
    p.padLanes(noInput(), down);
    p.padLanes(down, down);                                         // held: nothing yet
    expect(actions()).toBe(0);
    p.padLanes(down, noInput());
    expect(actions()).toBe(1);
    p.padLanes(noInput(), down);
    p.padLanes(down, { ...noInput(), leanRight: true });
    p.input();
    expect(lean()).toBe(1);
    p.padLanes(noInput(), { ...noInput(), leanLeft: true });
    p.input();
    expect(lean()).toBe(-1);
    p.padLanes(noInput(), noInput());
    p.input();
    expect(lean()).toBe(0);
  });
});

describe('the HUD and the sounds (research 86 sections 3.4, 7.5)', () => {
  it('feeds the climb prompt as the HUD reads it (the one icon for every class)', () => {
    const { p, walker } = page();
    walker.place(0, 10, 12);
    walker.state.yaw = 0;
    expect(p.hudClimb()).toBeNull();
    for (let i = 0; i < 60; i++) walker.tick(FORWARD);
    expect(p.hudClimb()).toEqual({ visible: true, kind: 'low' });
  });

  it('shows the ladder slide icon on a ladder only, and sends the slide loop and its landing to the audio', () => {
    const played: string[] = [], landed: number[] = [];
    const { p, walker } = page({ play: (name) => { played.push(name); }, land: (speed) => { landed.push(speed); } });
    const slots: (ActionPrompt | null)[] = [];
    const hud = { setAction: (a: ActionPrompt | null) => { slots.push(a); } };
    walker.place(60, 10, 20);
    walker.state.yaw = 0;
    for (let i = 0; i < 240 && p.traversal()?.state().kind !== 'ladder'; i++) walker.tick(FORWARD);
    p.hudFrame(hud);
    expect(slots).toEqual(['ladder_slide']);
    for (let i = 0; i < 60; i++) walker.tick(FORWARD);
    p.hudFrame(hud);
    expect(slots).toEqual(['ladder_slide']);                        // set once, not every frame
    p.action();
    for (let i = 0; i < 240 && p.traversal()?.state().kind !== 'none'; i++) walker.tick(STILL);
    p.hudFrame(hud);
    expect(slots).toEqual(['ladder_slide', null]);
    expect(played).toEqual([LADDER_SLIDE_SOUND]);
    expect(landed.length).toBe(1);
    expect(landed[0]).toBeGreaterThan(0);
  });
});

describe('the water effects (research 86 section 5.4)', () => {
  it('keeps one ripple running, following the SEAL, a new one only when it ends; a fall into the pool splashes', () => {
    const { p, walker } = page();
    const spawned: string[] = [], played: string[] = [];
    let live = { finished: false, stopped: false };
    p.setEffects({
      spawn: (name) => { spawned.push(name); live = { finished: false, stopped: false }; const h = live; return { get finished() { return h.finished; }, stop: () => { h.stopped = true; h.finished = true; } }; },
      play: (name) => { played.push(name); return true; },
    });
    walker.place(-80, 10, 40);
    walker.tick(STILL);
    p.effectsFrame();
    p.effectsFrame();
    expect(spawned).toEqual(['big_ripple_anim']);                  // still: the anim pace; one at a time
    live.finished = true;
    p.effectsFrame();
    expect(spawned).toEqual(['big_ripple_anim', 'big_ripple_anim']);
    walker.place(-80, 40, 40);
    walker.setAirborne(true, 0);
    walker.state.y = 30;
    for (let i = 0; i < 120 && walker.airborne; i++) walker.tick(STILL);
    expect(played).toContain(FALL_IN_WATER);
  });
});
