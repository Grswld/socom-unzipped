import { chromium, type Page } from '@playwright/test';
// `hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../../packages/viewer/src/hook';
import { CONSOLE, type ConsoleValue } from './console';
import { row, type FeelRow } from './harness';

/**
 * The feel table's page path: the same questions asked of the running viewer through `window.__viewer` on Frostfire
 * -- the real hull, the real body and its clips -- rather than of the synthetic world `./rig` builds. Needs a dev
 * server (`npx vite --config packages/viewer/vite.config.ts --port 5192`) and the extracted maps.
 *
 * The mover is driven a tick at a time with `walkFor(1 / 60)`, which runs its 60 Hz ticks at once rather than over
 * frames (under SwiftShader a frame can take longer than the page's 0.1 s cap); the clip is read with the key really
 * held, because the animator steps with the page's frames.
 */

/** Frostfire's spawn A (KNOWN section 1): the feet; a pose 15.4 over them drops the mover there. */
const SPAWN_A: [number, number, number] = [796, 100, 614];
/** The 142 deck east of A, its open edge at x ~675 onto the 100 floor (the walk tests' walk-off). */
const DECK: [number, number, number] = [660, 142, 725];
const EYE = 15.4;
const TICK = 1 / 60;

type AnimNow = ReturnType<Window['__viewer']['stats']>['anim'];

/** Ticks of `walkFor(1/60)` with this stick from the pose `yaw`, facing it: the feet after each tick. */
function ticks(page: Page, n: number, input: { forward?: number; right?: number }): Promise<[number, number, number][]> {
  return page.evaluate(([count, inp]) => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
      window.__viewer.walkFor(1 / 60, inp);
      out.push(window.__viewer.feet()!);
    }
    return out;
  }, [n, input] as const);
}

function place(page: Page, at: readonly [number, number, number], yaw: number, stance: 'stand' | 'crouch' | 'prone' = 'stand'): Promise<void> {
  return page.evaluate(([x, y, z, eye, yw, st]) => {
    window.__viewer.setStance(st);
    window.__viewer.setCamera({ x, y: y + eye, z, yaw: yw, pitch: -9.167 });
  }, [...at, EYE, yaw, stance] as const);
}

const speeds = (feet: readonly [number, number, number][], from: readonly number[]): number[] =>
  feet.map((f, i) => {
    const p = i === 0 ? from : feet[i - 1]!;
    return Math.hypot(f[0] - p[0]!, f[2] - p[2]!) / TICK;
  });
const tail = (v: readonly number[]): number => {
  const t = v.slice(Math.floor(v.length * 0.6));
  return t.reduce((a, b) => a + b, 0) / t.length;
};

/** The rows the page answers, on Frostfire. */
export async function browserRows(url: string): Promise<FeelRow[]> {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const out: FeelRow[] = [];
  try {
    const page = await browser.newPage();
    const at = new URL(url);
    at.searchParams.set('map', 'MP2');                       // Frostfire, by `main.ts`'s `?map=`
    if (!at.searchParams.has('devmode')) at.searchParams.set('devmode', '');   // the served maps (`src/source.ts`)
    await page.goto(at.href);
    await page.waitForFunction(() => {
      const s = window.__viewer?.stats();
      return s !== undefined && s.map === 'FROSTFIRE' && s.triangles > 0 && s.collisionPolys > 0;
    }, undefined, { timeout: 180_000 });
    if (!(await page.evaluate(() => window.__viewer.setMode('walk')))) throw new Error('feel-parity: walk refused on Frostfire');
    const page_ = 'Frostfire via window.__viewer';

    // Facing +z from A, research 24's route's first leg: open ground for the two seconds of the run.
    await place(page, SPAWN_A, 180);
    const start = (await page.evaluate(() => window.__viewer.feet()))!;
    const run = await ticks(page, 90, { forward: 1 });
    const v = speeds(run, start), steadyRun = tail(v);
    out.push(row('page.fwd', `${page_}: forward run`, 'u/s', CONSOLE.runForward, steadyRun, 'mover'));
    const i90 = v.findIndex((s) => s >= 0.9 * steadyRun);
    out.push(row('page.t90', `${page_}: time to 90 % of the run`, 's', CONSOLE.t90, i90 < 0 ? null : (i90 + 1) * TICK, 'mover', { toleranceAbs: TICK / 2 }));
    const stop = await ticks(page, 10, { forward: 0 });
    out.push(row('page.stop', `${page_}: ticks still moving after the stick is let go`, 'ticks', CONSOLE.stopTicks,
      speeds(stop, run[run.length - 1]!).filter((s) => s > 1e-6).length, 'mover', { toleranceAbs: 0 }));
    await place(page, SPAWN_A, 180);
    const back = await ticks(page, 120, { forward: -1 });
    out.push(row('page.back', `${page_}: back run`, 'u/s', CONSOLE.runBack, tail(speeds(back, SPAWN_A)), 'mover'));

    // The camera standing at rest on the real hull.
    await place(page, SPAWN_A, 180);
    const cam = (await page.evaluate(() => window.__viewer.camera()))!;
    const feet = (await page.evaluate(() => window.__viewer.feet()))!;
    const up: ConsoleValue = { value: 25.709, kind: 'decomp', source: 'FUN_0029a950 standing (root 11.484) at the rest pitch; web spec section 7 W2.1' };
    out.push(row('page.eyeUp', `${page_}: standing, rest pitch: eye over the feet`, 'u', up, cam.eye[1] - feet[1], 'camera', { toleranceAbs: 0.01 }));
    out.push(row('page.eyeBehind', `${page_}: eye behind the feet`, 'u', { ...up, value: 24.906 },
      Math.hypot(cam.eye[0] - feet[0], cam.eye[2] - feet[2]), 'camera', { toleranceAbs: 0.01 }));

    // The body's clips, the key really held so the page's frames step the animator (and hand the camera its root).
    const held = async (key: string): Promise<{ anim: AnimNow; target: number | null }> => {
      await place(page, SPAWN_A, 180);
      await ticks(page, 30, key === 'KeyW' ? { forward: 1 } : { right: 1 });
      await page.keyboard.down(key);
      await page.waitForTimeout(600);
      const got = await page.evaluate(() => {
        const cam = window.__viewer.camera(), feet = window.__viewer.feet();
        return { anim: window.__viewer.stats().anim, target: cam && feet ? cam.target[1] - feet[1] : null };
      });
      await page.keyboard.up(key);
      return got;
    };
    const fwd = await held('KeyW');
    if (fwd.anim) {
      out.push(row('page.runClip', `${page_}: full run: the clip's keys a second / 30`, 'x', CONSOLE.runClipFactor,
        fwd.anim.clip === 'seal_run' ? fwd.anim.rate / 30 : null, 'motion', { note: `playing ${fwd.anim.clip}` }));
      out.push(row('page.runTarget', `${page_}: full run: look-at target over the feet`, 'u', { ...CONSOLE.runRootY, value: 20.305 },
        fwd.target, 'motion', { toleranceAbs: 0.1, note: 'the root of seal_run, 10.305, + 10' }));
    }
    const side = await held('KeyD');
    if (side.anim) {
      out.push(row('page.strafeClip', `${page_}: full right strafe: the clip's keys a second / 30`, 'x',
        { value: 1.1834, kind: 'decomp', source: 'seal_run_90r at 65 (as the headless anim.strafeFactor, web research 80 section 0)' },
        side.anim.clip === 'seal_run_90r' ? side.anim.rate / 30 : null, 'motion', { tolerancePct: 1, note: `playing ${side.anim.clip}` }));
    }
    // The standing jump: the clip on the floor; the camera's root rises with it.
    await place(page, SPAWN_A, 180);
    await page.waitForTimeout(700);
    // A string, so the bundler's helper names (tsx keeps function names with `__name`) never reach the page.
    const jump = await page.evaluate(`new Promise((done) => {
      const v = window.__viewer, y0 = v.feet()[1], start = performance.now();
      let top = -Infinity, feet = 0;
      v.jump();
      requestAnimationFrame(function step() {
        top = Math.max(top, v.camera()?.rootY ?? -Infinity);
        feet = Math.max(feet, v.feet()[1] - y0);
        if (performance.now() - start < 1500) requestAnimationFrame(step); else done({ top, feet });
      });
    })`) as { top: number; feet: number };
    out.push(row('page.jumpFeet', `${page_}: standing jump: the feet's rise`, 'u', CONSOLE.standJumpFeet, jump.feet, 'motion', { toleranceAbs: 1e-6 }));
    out.push(row('page.jumpRoot', `${page_}: standing jump: the camera's root at its top`, 'u', CONSOLE.standJumpRootTop, jump.top, 'motion',
      { toleranceAbs: 0.3, note: 'sampled at the frame rate of the page' }));

    // Off the 142 deck east of A onto the 100 floor.
    await place(page, DECK, -90);
    let airTime: number | null = null;
    for (let i = 0; i < 12 && airTime === null; i++) {
      await ticks(page, 10, { forward: 1 });
      airTime = (await page.evaluate(() => window.__viewer.mover()?.landing?.airTime)) ?? null;
    }
    out.push(row('page.fall', `${page_}: walk off the 142 deck: time in the air`, 's', CONSOLE.fallTime42, airTime, 'mover', { toleranceAbs: 2 * TICK }));
  } finally {
    await browser.close();
  }
  return out;
}
