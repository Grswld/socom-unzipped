/**
 * The walk's entry and a grenade's blast, frame by frame, with the program links each caused (research 90 §9, issues
 * #21 and #23): the longest frames after `setMode('walk')` and after the blast, and every link a frame waited for
 * (`sync`, from the page's `links()` hook, `packages/viewer/src/linkLog.ts`) with the object and material that asked,
 * the main thread's long tasks in each window (a long frame with none was spent outside the page's JavaScript), and
 * when each warm-up of the map ended against the entry (`walk`, `rehearsed`, `props`, `world`; negative: before it).
 *
 * The page is driven as `tools/release-sweep.ts` drives it: the installed Chrome, 1280 x 720, WebGL2 by hiding
 * `navigator.gpu` (the default here), a click and Escape at scene-ready, 0.3 s, then the walk; after 3 s standing, `4`
 * and R1 held 0.8 s, then 2 s past the blast. A fresh page a run.
 *
 *   npx tsx tools/entry-links.ts [url] [--maps MP10,MP9] [--looks modern,ps2] [--backends webgl2,webgpu] [--repeat 2] [--out f.json]
 *
 * Needs a dev server on the url (`npm run dev -- --port 5204`). Host rule: only when the loop lock is FREE or a build's.
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import type {} from '../packages/viewer/src/hook';
import type { LinkRecord } from '../packages/viewer/src/linkLog';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5204/';
const MAPS = (opt('--maps') ?? 'MP10,MP9,MP2').split(',');
const LOOKS = (opt('--looks') ?? 'modern').split(',') as ('modern' | 'ps2')[];
const BACKENDS = (opt('--backends') ?? 'webgl2').split(',') as ('webgpu' | 'webgl2')[];
const REPEAT = Number(opt('--repeat') ?? 1);
const OUT = opt('--out');
const CHANNEL = opt('--channel') ?? 'chrome';

const HIDE_GPU = `Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });`;
const INIT = `
  window.__pad = { id: 'links pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) };
  navigator.getGamepads = () => [window.__pad];
  window.__fr = { on: false, rec: [], last: 0 };
  // The main thread's long tasks: a long frame with none is time spent outside the page's JavaScript (the GPU process).
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  requestAnimationFrame(function tick(t) {
    const s = window.__fr;
    if (s.on) s.rec.push({ t, dt: t - s.last });
    s.last = t;
    requestAnimationFrame(tick);
  });
`;

interface Frame { t: number; dt: number }
interface Window_ { worst: { at: number; ms: number }[]; longTasks: { at: number; ms: number }[]; sync: (LinkRecord & { at: number })[]; asyncLinks: number; pendingAtEntry?: number; warmed?: Record<string, number>; throwSync?: number }
interface Result { map: string; look: string; backend: string; entry: Window_ | null; blast: Window_ | null; error?: string }

function windowOf(rec: Frame[], links: LinkRecord[], t0: number, span: number, tasks: [number, number][]): Window_ {
  const win = rec.filter((r) => r.t > t0 && r.t - t0 < span);
  return {
    longTasks: tasks.filter(([t, d]) => t + d > t0 && t < t0 + span).map(([t, d]) => ({ at: +((t - t0) / 1000).toFixed(2), ms: +d.toFixed(0) })),
    worst: [...win].sort((a, b) => b.dt - a.dt).slice(0, 3).map((r) => ({ at: +((r.t - t0) / 1000).toFixed(2), ms: +r.dt.toFixed(0) })),
    sync: links.filter((l) => l.sync).map((l) => ({ ...l, at: +((l.t - t0) / 1000).toFixed(3) })),
    asyncLinks: links.filter((l) => !l.sync).length,
  };
}

async function run(browser: Browser, map: string, look: 'modern' | 'ps2', backend: 'webgpu' | 'webgl2'): Promise<Result> {
  const origin = new URL(BASE).origin;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 's2u.viewer.look', value: look }] }] },
  });
  const p = await ctx.newPage();
  const r: Result = { map, look, backend, entry: null, blast: null };
  try {
    if (backend === 'webgl2') await p.addInitScript(HIDE_GPU);
    await p.addInitScript(INIT);
    await p.goto(`${BASE}?map=${map}&redotcom&fly`);
    await p.waitForFunction(() => document.getElementById('loading')?.hidden === true && (window.__viewer?.stats().triangles ?? 0) > 0, undefined, { timeout: 180_000 });
    const drew = await p.evaluate(() => window.__viewer.stats().backend);
    if (drew !== backend) throw new Error(`asked for ${backend}, drew with ${drew}`);
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.mouse.click(640, 360);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const recOn = (): Promise<number> => p.evaluate(() => { const s = (window as unknown as { __fr: { on: boolean; rec: Frame[] } }).__fr; s.rec = []; s.on = true; return performance.now(); });
    const recOff = (): Promise<Frame[]> => p.evaluate(() => { const s = (window as unknown as { __fr: { on: boolean; rec: Frame[] } }).__fr; s.on = false; return s.rec; });

    // The entry: 3 s standing.
    const pendingAtEntry = await p.evaluate(() => window.__viewer.links().pending);
    const t0 = await recOn();
    if (!(await p.evaluate(() => window.__viewer.setMode('walk')))) throw new Error('walk refused');
    await p.waitForTimeout(3000);
    const entryFrames = await recOff();
    const el = await p.evaluate((s) => window.__viewer.links(s), t0);
    const tasks = (): Promise<[number, number][]> => p.evaluate(() => (window as unknown as { __lt: [number, number][] }).__lt);
    r.entry = windowOf(entryFrames, el.records, t0, 3000, await tasks());
    r.entry.pendingAtEntry = pendingAtEntry;
    // Each warm-up's end against the entry (negative: done before it).
    r.entry.warmed = Object.fromEntries(Object.entries(el.warmed).map(([k, v]) => [k, +((v - t0) / 1000).toFixed(2)]));

    // The blast: 4, R1 held 0.8 s, 2 s past it.
    await p.keyboard.press('Digit4');
    await p.waitForTimeout(700);
    const tThrow = await recOn();
    await p.evaluate(() => { const pad = (window as unknown as { __pad: { buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__pad; pad.buttons[5] = { pressed: true, value: 1 }; pad.timestamp++; });
    await p.waitForTimeout(800);
    await p.evaluate(() => { const pad = (window as unknown as { __pad: { buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__pad; pad.buttons[5] = { pressed: false, value: 0 }; pad.timestamp++; });
    let tb: number | null = null;
    for (let i = 0; i < 40 && tb === null; i++) {
      await p.waitForTimeout(100);
      if ((await p.evaluate(() => window.__viewer.grenade().explosions.length)) > 0) tb = await p.evaluate(() => performance.now());
    }
    await p.waitForTimeout(2000);
    const gr = await recOff();
    const links = (await p.evaluate((s) => window.__viewer.links(s), tThrow)).records;
    if (tb !== null) {
      // The blast's first frame: the poll saw it within 100 ms; the window starts 0.1 s before.
      r.blast = windowOf(gr, links, tb - 100, 1600, await p.evaluate(() => (window as unknown as { __lt: [number, number][] }).__lt));
      r.blast.throwSync = links.filter((l) => l.sync && l.t < tb! - 100).length;
    } else r.error = 'no blast';
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
  } finally {
    await ctx.close();
  }
  return r;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ ...(CHANNEL === 'headless-shell' ? {} : { channel: CHANNEL }), args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const all: Result[] = [];
  try {
    for (let k = 0; k < REPEAT; k++) for (const map of MAPS) for (const look of LOOKS) for (const backend of BACKENDS) {
      const r = await run(browser, map, look, backend);
      all.push(r);
      const fmt = (w: Window_ | null): string => w ? `${w.worst.map((x) => `${x.ms}ms@${x.at}s`).join(' ')} sync ${w.sync.length} async ${w.asyncLinks} longtasks ${w.longTasks.map((x) => `${x.ms}ms@${x.at}s`).join(' ') || 'none'}` : '-';
      console.log(`${map.padEnd(5)} ${look.padEnd(6)} ${backend.padEnd(6)} entry ${fmt(r.entry)} | blast ${fmt(r.blast)}${r.error ? ` !! ${r.error}` : ''}`);
      console.log(`    warmed (s from entry) ${JSON.stringify(r.entry?.warmed ?? {})}, async links in flight at entry ${r.entry?.pendingAtEntry ?? '-'}`);
      for (const [name, w] of [['entry', r.entry], ['blast', r.blast]] as const) {
        for (const l of w?.sync ?? []) console.log(`    ${name} ${l.kind} @${l.at}s ${l.ms.toFixed(1)}ms pending ${l.pending}: ${l.material} | ${l.object} | ${l.target}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(all, null, 2));
}

void main();
