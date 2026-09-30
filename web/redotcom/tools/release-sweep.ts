/**
 * The release-readiness sweep (web research 90 §9): every map the served tree lists, in both presentations (Modern,
 * PS2) and on both backends (WebGPU, WebGL2 -- the latter by hiding `navigator.gpu`, so three's `WebGPURenderer` falls
 * back), each in a fresh page on the host's GPU. Per run it measures and records, evidence not opinion:
 *
 * - the load (wall clock to the first triangles and the hull, and the page's own `stats().loadMs`), the audio unlock's
 *   cost on the first gesture (`audio().timing.unlockMs`), the untextured draws and the page's diagnostics;
 * - the walk's entry (the frames for 3 s after `setMode('walk')`, standing) and a 10 s walk at full stick with a slow
 *   turn and a jump every 2 s (frame time p50/p95/max; the feet: NaN, the feet under the floor the walk picks under
 *   them -- a fall through the map (`./sweepFall`) -- the longest airborne spell, and the descent from the spawn's floor
 *   as information);
 * - the smoke: `C` tapped (crouch), held (prone), tapped (crouch); the zoom stepped in three times and out three times
 *   (the views seen: first person must be unreachable); the pistol (`2`, and `3`), the zoom with it, the rifle back
 *   (`1`); a reload; a magazine in AUTO held down the heading whose first strikable surface is nearest (`./sweepHeading`:
 *   the frames, the rounds, the marks); a grenade (`4`,
 *   R1 held: the yellow arc sampled while held; the frames from the release to 2 s after the blast, the blast's
 *   freeze #19 read as the longest frame in the 1.5 s after it);
 * - the console's errors and warnings and the uncaught page errors, and every screenshot's blankness (the share of
 *   near-black pixels and the luminance's spread; a frame is blank at 97 % near-black or a spread under 3).
 *
 *   npx vite --config packages/viewer/vite.config.ts --port 5208   # another shell
 *   npx tsx tools/release-sweep.ts [url] [--maps MP2,MP6] [--looks modern,ps2] [--backends webgpu,webgl2] [--channel chrome] [--out <dir>]
 *
 * Output: `web/test-fixtures/screens/release-sweep/` (git-ignored): `sweep.json` and a folder of PNGs a run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import type {} from '../packages/viewer/src/hook';
import { descentBelow, fallThroughs, type FallFrame } from './sweepFall';
import { levelDirection, SWEEP_YAWS, sweepHeading, type HeadingCandidate } from './sweepHeading';

const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle') as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5208/';
const OUT = opt('--out') ?? fileURLToPath(new URL('../test-fixtures/screens/release-sweep', import.meta.url));
const index = JSON.parse(readFileSync(fileURLToPath(new URL('../public/maps/index.json', import.meta.url)), 'utf8')) as { maps: { archive: string; name: string }[] };
const MAPS = opt('--maps')?.split(',') ?? index.maps.map((m) => m.archive);
const LOOKS = (opt('--looks') ?? 'modern,ps2').split(',') as ('modern' | 'ps2')[];
const BACKENDS = (opt('--backends') ?? 'webgpu,webgl2').split(',') as ('webgpu' | 'webgl2')[];
/**
 * The browser: the installed Chrome by default. Playwright's bundled headless shell offers a WebGPU adapter but fails its
 * device (`dxil.dll` Windows Error 87), so three falls back to WebGL2 there -- every earlier playtest drew with WebGL2.
 */
const CHANNEL = opt('--channel') ?? 'chrome';
const EYE = 15.4, INIT_PITCH = -9.167;
const axis = (byte: number): number => (byte - 127.5) / 127.5;

/** The page's side: a fake pad, and a recorder of every frame's time, feet, view, stance, airborne and the blasts. */
const INIT = `
  window.__pad = { id: 'sweep pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) };
  navigator.getGamepads = () => [window.__pad];
  window.__sw = { on: false, rec: [], last: 0, shots: [], prev: null };
  requestAnimationFrame(function tick(t) {
    const s = window.__sw, v = window.__viewer;
    const feet = v ? v.feet() : null;
    if (s.on && v) {
      let g = null; try { g = v.grenade(); } catch (e) {}
      const z = v.zoom ? v.zoom() : null;
      const air = v.mover() ? v.mover().airborne : false;
      // The floor the walk picks under the feet (./sweepFall): from the feet as they were in the air, the feet on the ground.
      const floor = feet && v.floorUnder ? v.floorUnder(feet[0], feet[2], feet[1], air && s.prev ? s.prev[1] : feet[1]) : null;
      s.rec.push({ t, dt: t - s.last, feet, floor, view: v.stats().view.kind, zoomState: z ? z.state : null, zoomView: z ? z.view : null,
        stance: v.stance(), air, blasts: g ? g.explosions.length : 0,
        arc: g && g.arc ? { visible: g.arc.visible, color: g.arc.color } : null });
    }
    s.prev = feet;
    s.last = t;
    requestAnimationFrame(tick);
  });
`;
const HIDE_GPU = `Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });`;

interface Rec { t: number; dt: number; feet: number[] | null; floor: number | null; view: string; zoomState: number | null; zoomView: string | null; stance: string; air: boolean; blasts: number; arc: { visible: boolean; color: number[] } | null }
interface Frames { n: number; p50: number; p95: number; max: number; over50: number; over100: number; worst: string[] }
interface Shot { name: string; file: string; blackShare: number; lumaSd: number; blank: boolean }
interface Run {
  map: string; name: string; look: string; backendAsked: string; backend: string | null; ps2look: boolean | null;
  loadWallMs: number | null; sceneReadyWallMs: number | null; loadMs: number | null; scopeSideBlack: number | null; unlockMs: number | null; pumpMaxMs: number | null;
  untexturedDraws: number | null; diagnostics: string[]; triangles: number | null;
  entry: Frames | null; walk: Frames | null; walkNumbers: Record<string, unknown>;
  smoke: Record<string, unknown>; mag: Frames | null; grenade: Frames | null; blast: Record<string, unknown>;
  errors: string[]; warnings: string[]; shots: Shot[]; findings: string[]; seconds: number;
}

function frames(rec: Rec[], stalls: number[] = []): Frames {
  const stalled = (t: number): boolean => stalls.some((s) => t >= s && t - s < 1000);
  const ok = rec.slice(1).filter((r) => !stalled(r.t));
  const d = ok.map((r) => r.dt).sort((a, b) => a - b);
  const q = (p: number): number => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))]!.toFixed(1) : 0;
  const t0 = rec[0]?.t ?? 0;
  return {
    n: rec.length, p50: q(0.5), p95: q(0.95), max: +(d[d.length - 1] ?? 0).toFixed(1),
    over50: d.filter((x) => x > 50).length, over100: d.filter((x) => x > 100).length,
    worst: [...ok].sort((a, b) => b.dt - a.dt).slice(0, 3).filter((r) => r.dt > 50).map((r) => `${((r.t - t0) / 1000).toFixed(2)}s:${r.dt.toFixed(0)}ms`),
  };
}

function blankness(file: string): { blackShare: number; lumaSd: number } {
  const png = PNG.sync.read(readFileSync(file));
  let n = 0, black = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < png.data.length; i += 4 * 7) {              // every 7th pixel is plenty
    const l = 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!;
    n++; sum += l; sum2 += l * l; if (l < 8) black++;
  }
  const mean = sum / n;
  return { blackShare: +(black / n).toFixed(3), lumaSd: +Math.sqrt(Math.max(0, sum2 / n - mean * mean)).toFixed(1) };
}

class Sweep {
  readonly run: Run;
  private stalls: number[] = [];
  constructor(private readonly p: Page, map: string, name: string, look: string, backend: string, private readonly dir: string) {
    this.run = {
      map, name, look, backendAsked: backend, backend: null, ps2look: null, loadWallMs: null, sceneReadyWallMs: null, scopeSideBlack: null, loadMs: null, unlockMs: null, pumpMaxMs: null,
      untexturedDraws: null, diagnostics: [], triangles: null, entry: null, walk: null, walkNumbers: {}, smoke: {}, mag: null, grenade: null,
      blast: {}, errors: [], warnings: [], shots: [], findings: [], seconds: 0,
    };
    p.on('pageerror', (e) => this.run.errors.push(`pageerror: ${e.message}`));
    p.on('console', (m) => {
      if (m.type() === 'error') this.run.errors.push(`console: ${m.text().slice(0, 300)}${m.location().url ? ` @ ${new URL(m.location().url).pathname}` : ""}`);
      else if (m.type() === 'warning') this.run.warnings.push(m.text().slice(0, 300));
    });
    p.on('response', (res) => { if (res.status() >= 400) this.run.errors.push(`http ${res.status()}: ${new URL(res.url()).pathname}`); });
  }
  async pad(axes: number[], buttons: Record<number, boolean> = {}): Promise<void> {
    await this.p.evaluate(([ax, bt]) => {
      const pad = (window as unknown as { __pad: { axes: number[]; buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__pad;
      pad.axes = ax;
      for (const [i, on] of Object.entries(bt)) pad.buttons[Number(i)] = { pressed: on, value: on ? 1 : 0 };
      pad.timestamp++;
    }, [axes, buttons] as const);
  }
  async press(button: number, ms = 120): Promise<void> { await this.pad([0, 0, 0, 0], { [button]: true }); await this.p.waitForTimeout(ms); await this.pad([0, 0, 0, 0], { [button]: false }); }
  async record(): Promise<void> { this.stalls = []; await this.p.evaluate(() => { const s = (window as unknown as { __sw: { on: boolean; rec: unknown[] } }).__sw; s.rec = []; s.on = true; }); }
  async stop(): Promise<Rec[]> { return this.p.evaluate(() => { const s = (window as unknown as { __sw: { on: boolean; rec: Rec[] } }).__sw; s.on = false; return s.rec; }); }
  async peek(): Promise<Rec[]> { return this.p.evaluate(() => (window as unknown as { __sw: { rec: Rec[] } }).__sw.rec); }
  async shot(name: string): Promise<void> {
    this.stalls.push(await this.p.evaluate(() => performance.now()));
    const file = join(this.dir, `${name}.png`);
    await this.p.screenshot({ path: file });
    const b = blankness(file);
    const blank = b.blackShare > 0.97 || b.lumaSd < 3;
    this.run.shots.push({ name, file, ...b, blank });
    if (blank) this.run.findings.push(`blank frame at ${name} (near-black ${b.blackShare}, spread ${b.lumaSd})`);
  }
  get stallTimes(): number[] { return this.stalls; }
  async place(at: readonly number[], yaw: number, pitch = INIT_PITCH): Promise<void> {
    await this.p.evaluate(([x, y, z, yw, pt]) => { window.__viewer.setStance('stand'); window.__viewer.setCamera({ x, y, z, yaw: yw, pitch: pt }); }, [at[0]!, at[1]! + EYE, at[2]!, yaw, pitch] as [number, number, number, number, number]);
  }
}

async function sweep(browser: Browser, map: string, name: string, look: 'modern' | 'ps2', backend: 'webgpu' | 'webgl2'): Promise<Run> {
  const started = Date.now();
  const dir = join(OUT, `${map}-${look}-${backend}`);
  mkdirSync(dir, { recursive: true });
  const origin = new URL(BASE).origin;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 's2u.viewer.look', value: look }] }] },
  });
  const p = await ctx.newPage();
  const s = new Sweep(p, map, name, look, backend, dir);
  const r = s.run, f = r.findings;
  try {
    if (backend === 'webgl2') await p.addInitScript(HIDE_GPU);
    await p.addInitScript(INIT);
    const t0 = Date.now();
    await p.goto(`${BASE}?map=${map}&mode=play&fly&devmode`);
    await p.waitForFunction(() => (window.__viewer?.stats().triangles ?? 0) > 0 && (window.__viewer?.stats().collisionPolys ?? 0) > 0, undefined, { timeout: 180_000 });
    r.loadWallMs = Date.now() - t0;
    await p.waitForFunction(() => document.getElementById('loading')?.hidden === true, undefined, { timeout: 180_000 });
    r.sceneReadyWallMs = Date.now() - t0;
    const st = await p.evaluate(() => { const v = window.__viewer, x = v.stats(); return { backend: x.backend, loadMs: x.loadMs, diag: x.diagnostics, tri: x.triangles, ps2: v.toggles().ps2look ?? null }; });
    r.backend = st.backend; r.loadMs = Math.round(st.loadMs); r.diagnostics = st.diag; r.triangles = st.tri; r.ps2look = st.ps2;
    if (r.backend !== backend) f.push(`asked for ${backend}, the page drew with ${r.backend}`);
    if (r.ps2look !== (look === 'ps2')) f.push(`asked for the ${look} look, the toggle reads ps2look=${r.ps2look}`);
    await s.shot('00-loaded');
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.mouse.click(640, 360);                                           // the gesture the audio waits for
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const au = await p.evaluate(() => window.__viewer.audio().timing);
    r.unlockMs = +au.unlockMs.toFixed(2); r.pumpMaxMs = +au.pumpMaxMs.toFixed(2);

    // The walk's entry: 3 s standing, recorded from the frame before the switch.
    await s.record();
    if (!(await p.evaluate(() => window.__viewer.setMode('walk')))) throw new Error('walk refused');
    await p.waitForTimeout(3000);
    const entry = await s.stop();
    r.entry = frames(entry);
    await s.shot('01-walk-entry');
    const stand = await p.evaluate(() => window.__viewer.stats().stand);
    const spawn: number[] = stand ? [stand.position[0], stand.floor ?? stand.position[1], stand.position[2]] : (await p.evaluate(() => window.__viewer.feet()))!;
    r.walkNumbers['spawn'] = spawn.map((v) => +v.toFixed(1));

    // The open heading and the nearest wall: of eight, the headings 2.5 s of the run gets furthest and least far along.
    const reach: number[] = [];
    for (const yaw of SWEEP_YAWS) {
      await s.place(spawn, yaw);
      reach.push(await p.evaluate(() => { const a = window.__viewer.feet()!; window.__viewer.walkFor(2.5, { forward: 1 }); const b = window.__viewer.feet()!; return Math.hypot(b[0] - a[0], b[2] - a[2]); }));
    }
    const open = SWEEP_YAWS[reach.indexOf(Math.max(...reach))]!, wall = SWEEP_YAWS[reach.indexOf(Math.min(...reach))]!;
    r.walkNumbers['reach'] = reach.map((v) => +v.toFixed(0));
    // The mark heading: the nearest surface a round strikes, level from the spawn's eye (./sweepHeading) -- not the walk's
    // nearest wall, which may be invisible collision a round passes over by rule (MP71: INVISIBLE_DI, PENETRATION 1).
    const eye: [number, number, number] = [spawn[0]!, spawn[1]! + EYE, spawn[2]!];
    const candidates: HeadingCandidate[] = [];
    for (const yaw of SWEEP_YAWS) {
      const surfaces = await p.evaluate(([e, d]) => window.__viewer.surfacesAlong(e, d), [eye, levelDirection(yaw)] as const);
      candidates.push({ yaw, surfaces: surfaces ?? [] });
    }
    const mark = sweepHeading(candidates);

    // 10 s at full stick, a slow turn, a jump every 2 s.
    await s.place(spawn, open);
    await p.waitForTimeout(500);
    await s.record();
    await s.pad([0, axis(0), axis(170), 0]);
    for (let i = 0; i < 5; i++) {
      await p.waitForTimeout(1700);
      await p.keyboard.press('Space');
      if (i === 2) await s.shot('02-walking');
    }
    await p.waitForTimeout(300);
    await s.pad([0, 0, 0, 0]);
    const walk = await s.stop();
    r.walk = frames(walk, s.stallTimes);
    const nan = walk.some((w) => w.feet && w.feet.some((v) => !Number.isFinite(v)));
    let air = 0, airMax = 0;
    for (let i = 1; i < walk.length; i++) { air = walk[i]!.air ? air + walk[i]!.dt : 0; airMax = Math.max(airMax, air); }
    const end = walk[walk.length - 1]?.feet, begin = walk.find((w) => w.feet)?.feet;
    // Information only: terrain that drops away descends as far as a fall does (MP1, MP11). The fall-through is below.
    r.walkNumbers['minYBelowSpawn'] = descentBelow(spawn[1]!, walk);
    r.walkNumbers['travelled'] = end && begin ? +Math.hypot(end[0]! - begin[0]!, end[2]! - begin[2]!).toFixed(0) : null;
    r.walkNumbers['longestAirMs'] = Math.round(airMax);
    if (nan) f.push('NaN in the feet while walking');
    for (const [what, rec] of [['standing after the switch to walk', entry], ['walking', walk]] as [string, FallFrame[]][]) {
      const t0 = rec[0]?.t ?? 0, through = fallThroughs(rec);
      if (what === 'walking') r.walkNumbers['fallThroughs'] = through;
      for (const x of through) f.push(`feet ${x.depth} under the floor the walk picks, ${x.frames} frame(s) from ${((x.t - t0) / 1000).toFixed(2)} s ${what}${x.air ? ' (airborne)' : ''} (a fall through)`);
    }
    if (airMax > 2500) f.push(`airborne ${Math.round(airMax)} ms at a stretch while walking (a fall through?)`);
    if ((r.walkNumbers['travelled'] as number) < 20) f.push(`the 10 s walk travelled ${r.walkNumbers['travelled']} units (stuck?)`);

    // The stance: C tapped, held, tapped.
    await s.place(spawn, open);
    await p.waitForTimeout(400);
    const stances: string[] = [];
    const cKey = async (ms: number): Promise<void> => { await p.keyboard.down('KeyC'); await p.waitForTimeout(ms); await p.keyboard.up('KeyC'); await p.waitForTimeout(1300); stances.push(await p.evaluate(() => window.__viewer.stance())); };
    await cKey(80); await cKey(700); await cKey(80); await cKey(80);
    r.smoke['stanceTapHoldTapTap'] = stances;
    // In water over 2 deep the game turns a prone press into a crouch (FUN_00581660; research 86 section 6.4), so a
    // spawn in the water (MP62, MP64, MP71) reads crouch > crouch > stand > crouch -- the game's rule, not a fault.
    if (stances.join() === 'crouch,crouch,stand,crouch') r.smoke['stanceWaterRule'] = true;
    else if (stances.join() !== 'crouch,prone,crouch,stand') f.push(`C tap/hold/tap/tap gave ${stances.join(' > ')} (want crouch > prone > crouch > stand)`);
    await s.shot('03-stance-end');

    // The zoom: in three, out three; the views and the states seen.
    await s.place(spawn, open);
    await p.waitForTimeout(400);
    await s.record();
    const zoomSteps: string[] = [];
    for (const b of [12, 12, 12, 13, 13, 13]) {
      await s.press(b); await p.waitForTimeout(600);
      zoomSteps.push(await p.evaluate(() => { const z = window.__viewer.zoom(); return `${z.state}:${z.view}:${z.magnification.toFixed(2)}:${window.__viewer.stats().view.kind}`; }));
      if (zoomSteps.length === 1) {
        await s.shot('04-scope');
        // The scope's mask on a 16:9 frame: the share of near-black in the outer 8 % columns each side (1 = masked).
        const png = PNG.sync.read(readFileSync(join(dir, '04-scope.png')));
        let n = 0, black = 0;
        for (let y = 80; y < png.height - 80; y += 4) for (const x0 of [4, png.width - 100]) for (let x = x0; x < x0 + 96; x += 4) {
          const i = (y * png.width + x) * 4, l = 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!;
          n++; if (l < 12) black++;
        }
        r.scopeSideBlack = +(black / n).toFixed(2);
      }
    }
    const zr = await s.stop();
    r.smoke['zoomSteps'] = zoomSteps;
    const states = [...new Set(zr.map((z) => z.zoomState))], views = [...new Set(zr.map((z) => z.view))];
    r.smoke['zoomStatesSeen'] = states; r.smoke['viewsSeen'] = views;
    if (states.includes(1) || states.includes(2)) f.push(`first person reached (zoom state ${states.join(',')})`);
    if (!zoomSteps[0]!.includes('scope')) f.push(`zoom in from third did not reach the scope: ${zoomSteps[0]}`);
    if (!zoomSteps[5]!.endsWith(':third')) f.push(`zoom out three times left ${zoomSteps[5]}`);

    // The weapons: 2 (pistol), its zoom, 3, 1 (rifle).
    const weap = async (): Promise<string> => p.evaluate(() => `${window.__viewer.weapon().item}/${window.__viewer.kit().item}/${window.__viewer.grenade().held ?? '-'}`);
    const swap: Record<string, unknown> = { start: await weap() };
    await p.keyboard.press('Digit2'); await p.waitForTimeout(1500); swap['after2'] = await weap();
    await s.shot('05-pistol');
    await s.press(12); await p.waitForTimeout(700);
    swap['pistolZoomIn'] = await p.evaluate(() => { const z = window.__viewer.zoom(); return `${z.state}:${z.view}:${z.magnification.toFixed(2)}`; });
    await s.press(13); await p.waitForTimeout(500);
    await p.keyboard.press('Digit3'); await p.waitForTimeout(1500); swap['after3'] = await weap();
    await p.keyboard.press('Digit1'); await p.waitForTimeout(1500); swap['after1'] = await weap();
    r.smoke['swap'] = swap;
    if (!String(swap['after2']).startsWith('pistol')) f.push(`2 did not take the pistol up (${swap['after2']})`);
    if (!String(swap['after1']).startsWith('rifle')) f.push(`1 did not bring the rifle back (${swap['after1']})`);

    // A magazine in AUTO down the mark heading, level (with none strikable, the walk's nearest wall, and no mark owed).
    await s.place(spawn, mark?.yaw ?? wall, 0);
    await p.waitForTimeout(500);
    for (let i = 0; i < 4 && (await p.evaluate(() => window.__viewer.fireMode())) !== 'AUTO'; i++) await p.evaluate(() => window.__viewer.switchFireMode());
    const before = await p.evaluate(() => { const x = window.__viewer.fire(); return { shots: x.shots, decals: x.decals, mag: x.magazine }; });
    await s.record();
    await s.pad([0, 0, 0, 0], { 5: true });
    await p.waitForTimeout(3600);
    await s.pad([0, 0, 0, 0], { 5: false });
    await p.waitForTimeout(400);
    r.mag = frames(await s.stop());
    await s.shot('06-marks');
    const after = await p.evaluate(() => { const x = window.__viewer.fire(); return { shots: x.shots, decals: x.decals, mag: x.magazine, hit: x.lastHit }; });
    r.smoke['magazine'] = { fired: after.shots - before.shots, decalsAdded: after.decals - before.decals, before: before.mag, after: after.mag, lastHitDistance: after.hit ? +after.hit.distance.toFixed(1) : null, wallYaw: wall, wallReach: +Math.min(...reach).toFixed(0),
      markYaw: mark?.yaw ?? null, markDistance: mark ? +mark.distance.toFixed(1) : null, noSurface: mark === null };
    if (after.shots - before.shots < 20) f.push(`AUTO held 3.6 s fired ${after.shots - before.shots}`);
    // A round that meets nothing strikable marks nothing by the game's rule (FUN_003c9b70): no mark is owed then.
    if (mark && after.decals - before.decals <= 0) f.push(`a magazine at yaw ${mark.yaw} (a strikable surface ${mark.distance.toFixed(1)} out) left no mark`);

    // The reload (the magazine above is empty or near it).
    await p.waitForTimeout(3000);
    const m0 = await p.evaluate(() => window.__viewer.fire().magazine);
    await p.keyboard.press('KeyR');
    await p.waitForTimeout(3500);
    const m1 = await p.evaluate(() => window.__viewer.fire().magazine);
    r.smoke['reload'] = { before: m0, after: m1 };
    if (m1.rounds !== m1.capacity && m1.spare > 0) f.push(`reload left ${m1.rounds}/${m1.capacity}`);

    // The grenade: 4, R1 held 0.8 s, the arc sampled while held; the frames to 2 s after the blast.
    await s.place(spawn, open, INIT_PITCH);
    await p.waitForTimeout(500);
    await p.keyboard.press('Digit4');
    await p.waitForTimeout(700);
    await s.record();
    await s.pad([0, 0, 0, 0], { 5: true });
    await p.waitForTimeout(550);
    const arc = await p.evaluate(() => window.__viewer.grenade().arc);
    await s.shot('07-arc');
    await p.waitForTimeout(250);
    await s.pad([0, 0, 0, 0], { 5: false });
    for (let i = 0; i < 24; i++) { await p.waitForTimeout(250); if ((await p.evaluate(() => window.__viewer.grenade().explosions.length)) > 0) break; }
    await p.waitForTimeout(2000);
    const gr = await s.stop();
    r.grenade = frames(gr, s.stallTimes);
    const bi = gr.findIndex((g) => g.blasts > 0);
    if (bi >= 0) {
      const tb = gr[bi]!.t, win = gr.filter((g) => g.t > tb && g.t - tb < 1500);
      const worst = win.reduce((a, g) => (g.dt > a.dt ? g : a), { dt: 0, t: tb } as { dt: number; t: number });
      r.blast = { maxFrameMs: +worst.dt.toFixed(1), at: +((worst.t - tb) / 1000).toFixed(2), over50: win.filter((g) => g.dt > 50).length };
      if (worst.dt > 100) f.push(`a ${worst.dt.toFixed(0)} ms frame ${((worst.t - tb) / 1000).toFixed(2)} s after the blast`);
    } else {
      r.blast = { maxFrameMs: null };
      f.push('no grenade blast within 6 s of the throw');
    }
    const arcSeen = gr.filter((g) => g.arc?.visible);
    r.smoke['arc'] = arc ? { visible: arc.visible, segments: arc.segments, color: arc.color.map((c) => +c.toFixed(2)), framesVisible: arcSeen.length } : null;
    if (!arc?.visible) f.push('no arc while the throw was held');
    else if (!(arc.color[0]! > 0.6 && arc.color[1]! > 0.5 && arc.color[2]! < 0.4)) f.push(`the arc is not yellow: ${arc.color.join(',')}`);
    await s.shot('08-after-blast');
    await p.keyboard.press('Digit1');

    const tail = await p.evaluate(() => ({ untextured: window.__viewer.stats().untexturedDraws, mode: window.__viewer.mode(), feet: window.__viewer.feet(), missing: window.__viewer.audio().missing, unknown: window.__viewer.audio().unknownNames, fxMissing: window.__viewer.effects().missing }));
    r.untexturedDraws = tail.untextured;
    r.smoke['audioMissing'] = tail.missing; r.smoke['audioUnknown'] = tail.unknown; r.smoke['effectsMissing'] = tail.fxMissing;
    if (tail.mode !== 'walk') f.push(`the page left walk mode (${tail.mode})`);
    if (tail.untextured > 0) f.push(`${tail.untextured} untextured draws`);
  } catch (e) {
    f.push(`threw: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    r.seconds = Math.round((Date.now() - started) / 1000);
    r.errors = [...new Set(r.errors)]; r.warnings = [...new Set(r.warnings)];
    if (r.errors.length) f.push(`${r.errors.length} distinct page/console error(s)`);
    await ctx.close();
  }
  return r;
}

const names = new Map(index.maps.map((m) => [m.archive, m.name]));
const runs: Run[] = [];
mkdirSync(OUT, { recursive: true });
for (const backend of BACKENDS) {
  // A new browser a backend: the flags are the playtest's (the host's GPU through ANGLE on D3D11; WebGPU on by default).
  const browser = await chromium.launch({ ...(CHANNEL === 'headless-shell' ? {} : { channel: CHANNEL }), args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const map of MAPS) for (const look of LOOKS) {
      const r = await sweep(browser, map, names.get(map) ?? map, look, backend);
      runs.push(r);
      writeFileSync(join(OUT, 'sweep.json'), JSON.stringify(runs, null, 2));
      console.log(`${map.padEnd(5)} ${look.padEnd(6)} ${String(r.backend).padEnd(6)} load ${r.loadWallMs}/${r.sceneReadyWallMs} (${r.loadMs}) scopeSide ${r.scopeSideBlack} unlock ${r.unlockMs} entry ${r.entry?.p50}/${r.entry?.p95}/${r.entry?.max} walk ${r.walk?.p50}/${r.walk?.p95}/${r.walk?.max} mag ${r.mag?.p95}/${r.mag?.max} blast ${r.blast['maxFrameMs']} err ${r.errors.length} warn ${r.warnings.length} ${r.seconds}s${r.findings.length ? `\n      !! ${r.findings.join('\n      !! ')}` : ''}`);
    }
  } finally {
    await browser.close();
  }
}
