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

    // The body's clip at a full run: the key really held, so the page's frames step the animator.
    await place(page, SPAWN_A, 180);
    await ticks(page, 30, { forward: 1 });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(400);
    const anim = await page.evaluate(() => window.__viewer.stats().anim);
    await page.keyboard.up('KeyW');
    if (anim) {
      out.push(row('page.runClip', `${page_}: full run, ${anim.clip}: keys a second / 30`, 'x', CONSOLE.runClipFactor, anim.rate / 30, 'motion',
        { note: `clip ${anim.clip}` }));
    }

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
