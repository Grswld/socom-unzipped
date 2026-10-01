import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { FlyCamera } from '../src/camera';
import { controlGroups, padControlGroups } from '../src/controlsList';
import { FLY_PARAM, flyAccess, mayEnter } from '../src/flyAccess';
import { writeShare } from '../src/shareUrl';
import { Ui } from '../src/ui';
import { packGround, WalkMode, type GroundData } from '../src/walk';

/**
 * Owner, 2026-09-29: "Block the fly automatically and disable it while in play mode." In Play the free camera is not a
 * player's: no Fly / Walk switch, `G` and the pad's Start unbound, `&fly` ignored and taken out of the address, the
 * hook's `setMode('fly')` refused -- unless the developer's `?devmode` is there (`../src/flyAccess.ts`). Explore is the
 * free camera.
 */
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const main = readFileSync(resolve(here, '../src/main.ts'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };

describe('flyAccess: who may reach the free camera', () => {
  it('a player (no devmode) has no toggle, never starts in fly, and a fly in the address is to be dropped', () => {
    for (const q of ['', '?mode=play', '?mode=play&fly', '?fly', '?map=MP2&fly=1', '?Devmode&fly']) {
      const a = flyAccess(q);
      expect(a.toggle, q).toBe(false);
      expect(a.startInFly, q).toBe(false);
      expect(a.dropFly, q).toBe(/fly/.test(q));
    }
  });
  it('the developer (devmode) keeps the toggle, and &fly opens Play in the free camera', () => {
    expect(flyAccess('?mode=play&fly&devmode')).toEqual({ toggle: true, startInFly: true, dropFly: false });
    expect(flyAccess('?devmode')).toEqual({ toggle: true, startInFly: false, dropFly: false });
  });
  it('never throws on a malformed query', () => {
    expect(() => flyAccess('?%E0%A4%A&fly')).not.toThrow();
  });
  it('the dropped fly leaves the address and nothing else does', () => {
    expect(writeShare('?mode=play&map=MP2&fly&lag=50', { drop: [FLY_PARAM] })).toBe('?mode=play&map=MP2&lag=50');
  });
});

describe('mayEnter: the hook, the pad and G ask the same rule', () => {
  const player = { toggle: false }, dev = { toggle: true };
  it('in Play a player cannot fly; the developer can', () => {
    expect(mayEnter('fly', true, player)).toBe(false);
    expect(mayEnter('fly', true, dev)).toBe(true);
    expect(mayEnter('walk', true, player)).toBe(true);
  });
  it('Explore is the free camera: fly is where it is, and walking is not offered', () => {
    expect(mayEnter('fly', false, player)).toBe(true);
    expect(mayEnter('walk', false, player)).toBe(false);
    expect(mayEnter('walk', false, dev)).toBe(false);
  });
});

describe('G on the keyboard (WalkMode.modeKey)', () => {
  const GROUND: GroundData = packGround(
    { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
    [{
      modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
      points: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
    }],
    [{ modelName: 'worldmodel', path: 'worldmodel/floor', first: 0, count: 1 }],
  );
  const canvas = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.setPointerCapture = () => undefined;
    c.releasePointerCapture = () => undefined;
    c.hasPointerCapture = () => false;
    return c;
  };
  let walk: WalkMode;
  const press = (): void => { globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG' })); };
  beforeEach(() => {
    const fly = new FlyCamera(canvas());
    fly.setPose({ x: 0, y: 50, z: 0, yaw: 0, pitch: 0 });
    walk = new WalkMode(fly);
    walk.setGround(GROUND, [0, 0, 0]);
    walk.bindKey(globalThis);
  });
  afterEach(() => { walk.unbindKey(); });

  it('a player: G neither leaves the walk nor enters it', () => {
    walk.modeKey = false;
    expect(walk.setMode('walk')).toBe(true);
    press();
    expect(walk.mode()).toBe('walk');
    walk.setMode('fly');
    press();
    expect(walk.mode()).toBe('fly');
  });

  it('the developer: G toggles, as before', () => {
    walk.modeKey = true;
    walk.setMode('walk');
    press();
    expect(walk.mode()).toBe('fly');
    press();
    expect(walk.mode()).toBe('walk');
  });
});

describe('the page wires the rule', () => {
  it('main.ts: the Fly / Walk switch removed, G, Start and the hook gated, &fly read through flyAccess', () => {
    expect(main).toMatch(/if \(!FLY\.toggle\) document\.getElementById\('mode'\)\?\.remove\(\)/);
    expect(main).toMatch(/walk\.modeKey = FLY\.toggle/);
    expect(main).toMatch(/playOn && FLY\.toggle && pressedSince\(padLast, pad\)\.includes\('mode'\)/);
    expect(main).toMatch(/setMode: \(mode\) => \(mayEnter\(mode, playOn, FLY\)/);
    expect(main).toMatch(/FLY\.dropFly \? \{ drop: \[FLY_PARAM\] \}/);
    expect(main).not.toMatch(/\.has\('fly'\)/);                    // nothing reads &fly but flyAccess
  });
});

describe('the Controls lists in Play name no fly toggle for a player', () => {
  beforeEach(load);
  const keys = (): string => [...document.querySelectorAll('#keys-list tbody tr')].map((r) => r.textContent).join(' | ');
  const pad = (): string => [...document.querySelectorAll('#pad-list tbody tr')].map((r) => r.textContent).join(' | ');

  it('walking and flying: no G, no Start, no "fly camera"', () => {
    const ui = new Ui();
    ui.setPlay(true);
    ui.setWalk(true);
    expect(keys()).not.toMatch(/\bG\b|fly camera/);
    expect(pad()).not.toMatch(/Start|fly camera/);
    ui.setWalk(false);
    expect(keys()).not.toMatch(/\bGwalk\b/);
    expect(pad()).not.toMatch(/Start/);
  });

  it('with the developer toggle they do, as before', () => {
    const ui = new Ui();
    ui.setFlyToggle(true);
    ui.setPlay(true);
    ui.setWalk(true);
    expect(keys()).toMatch(/Gfly camera/);
    expect(pad()).toMatch(/Startfly camera/);
    ui.setWalk(false);
    expect(keys()).toMatch(/Gwalk/);
  });

  it('the lists themselves: G and Start only with the toggle', () => {
    for (const mode of ['walk', 'fly'] as const) {
      expect(JSON.stringify(controlGroups(mode, false)), mode).not.toMatch(/"G"/);
      expect(JSON.stringify(padControlGroups(mode, false)), mode).not.toMatch(/"Start"/);
      expect(JSON.stringify(controlGroups(mode, true)), mode).toMatch(/"G"/);
      expect(JSON.stringify(padControlGroups(mode, true)), mode).toMatch(/"Start"/);
    }
  });
});
