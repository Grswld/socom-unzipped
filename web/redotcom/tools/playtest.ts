/**
 * A scripted playtest of the walk, as the owner plays it (web research 90): the page on a real GPU, the keys and a
 * pad (a fake `navigator.getGamepads` the page polls like any other) held in real time, on Frostfire and two more
 * maps -- the run at three pad bytes, the strafe, the diagonal and the back run, the stance button tapped and held, both
 * jumps, a turn, the fire modes, the zoom, a reload, a grenade, and on Frostfire the walk-off, the ladder, the crate,
 * a jump-grab and the peek. Every frame of every scenario is sampled through `window.__viewer` (the feet, the camera,
 * the clip and its blend, the traversal, the audio's counters, the frame time), screenshots are taken at the moments
 * worth looking at, and each scenario is scored for what reads wrong: frame-time spikes, camera jumps, root pops,
 * clips that snap without a blend, a body running in place or sliding, sounds missing or doubled.
 *
 *   npx vite --config packages/viewer/vite.config.ts --port 5192   # another shell
 *   npx tsx tools/playtest.ts [url] [--maps MP2,MP6,MP72] [--out <dir>] [--channel chrome]
 *
 * `--channel` picks the browser: `chrome` (the default, the installed Chrome) draws with WebGPU; Playwright's own headless
 * shell (`--channel headless-shell`) offers an adapter but fails the device (`dxil.dll`), so it draws with WebGL2 -- as
 * every run before round 6 did. The backend each map drew with is printed and kept in `playtest.json`.
 *
 * Screenshots and `playtest.json` go to `web/test-fixtures/screens/playtest/` (git-ignored: evidence, not fixtures).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import type {} from '../packages/viewer/src/hook';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5192/';
const MAPS = (opt('--maps') ?? 'MP2,MP6,MP72,MP10,MP7,MP61,MP82').split(',');
const CHANNEL = opt('--channel') ?? 'chrome';
const OUT = opt('--out') ?? fileURLToPath(new URL('../test-fixtures/screens/playtest', import.meta.url));
const EYE = 15.4, INIT_PITCH = -9.167, DEG = Math.PI / 180;

/** One frame of the page, as the recorder in the page takes it. */
interface Frame {
  t: number; dt: number; feet: number[] | null; eye: number[] | null; rootY: number | null;
  clip: string | null; blend: number | null; from: string | null; rate: number | null; play: string | null;
  trav: string | null; stance: string; air: boolean; view: string;
}

/**
 * The page's side, as a string so the bundler's helper names never reach it: a fake standard pad the page polls, and a
 * recorder that samples the hook once a frame while `__pt.on`.
 */
const INIT = `
  window.__pad = { id: 'playtest pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })) };
  navigator.getGamepads = () => [window.__pad];
  window.__pt = { on: false, rec: [], last: 0, shots: [] };
  requestAnimationFrame(function tick(t) {
    const pt = window.__pt, v = window.__viewer;
    if (pt.on && v && v.mode() === 'walk') {
      const c = v.camera(), a = v.stats().anim, tr = v.traversal(), m = v.mover();
      pt.rec.push({ t, dt: t - pt.last, feet: v.feet(), eye: c ? c.eye : null, rootY: c ? c.rootY : null,
        clip: a ? a.clip : null, blend: a ? a.blend : null, from: a ? a.from : null, rate: a ? a.rate : null, play: a ? a.play : null,
        trav: tr ? tr.kind : null, stance: v.stance(), air: m ? m.airborne : false, view: v.stats().view.kind });
    }
    pt.last = t;
    requestAnimationFrame(tick);
  });
`;

/** A PS2 byte on a Gamepad API axis: -1 at 0, 1 at 255. */
const axis = (byte: number): number => (byte - 127.5) / 127.5;

interface Scenario { map: string; name: string; numbers: Record<string, unknown>; findings: string[]; shots: string[]; frames: FrameStats }
interface FrameStats {
  n: number; dtMedian: number; dtP95: number; dtMax: number; spikes: number; cameraJump: number; rootPop: number; snaps: string[]; clips: string[];
  /** Where the largest camera move was: seconds into the scenario, the clip, in the air, the traversal. */
  jumpAt: string | null;
  /** Frames in the air playing an idle, and frames on the floor moving over 20 u/s while an idle plays. */
  idleInAir: number; idleMoving: number;
  /** The frames over 50 ms: seconds in, milliseconds, the clip and the feet. */
  spikesAt: string[];
}
const IDLES = new Set(['seal_stand', 'seal_crouch', 'seal_crouch_alert01', 'seal_crouch_alert02', 'seal_prone']);

const clipsSeq = (rec: Frame[]): string[] => rec.reduce<string[]>((out, f) => {
  if (f.clip && out[out.length - 1] !== f.clip) out.push(f.clip);
  return out;
}, []);

/**
 * What the frames say: the frame times (a screenshot's own stall left out), the largest camera move not the feet's (a
 * teleport -- the feet over 5 in a frame -- and the two frames after it left out), the root's largest step, the snaps,
 * and an idle clip in the air or under a moving body.
 */
function score(rec: Frame[], shots: number[]): FrameStats {
  const stalled = (t: number): boolean => shots.some((s) => t >= s && t - s < 1000);
  const dts = rec.slice(1).filter((f) => !stalled(f.t)).map((f) => f.dt).sort((a, b) => a - b);
  let cameraJump = 0, rootPop = 0, jumpAt: string | null = null, idleInAir = 0, idleMoving = 0, teleport = -10;
  const snaps: string[] = [];
  for (let i = 3; i < rec.length; i++) {
    const a = rec[i - 1]!, b = rec[i]!;
    const feetStep = a.feet && b.feet ? Math.hypot(b.feet[0]! - a.feet[0]!, b.feet[1]! - a.feet[1]!, b.feet[2]! - a.feet[2]!) : 0;
    if (feetStep > 5) teleport = i;
    if (a.eye && b.eye && a.feet && b.feet && i - teleport > 2 && a.view === b.view) {
      const d = Math.hypot(b.eye[0]! - a.eye[0]! - (b.feet[0]! - a.feet[0]!), b.eye[1]! - a.eye[1]! - (b.feet[1]! - a.feet[1]!), b.eye[2]! - a.eye[2]! - (b.feet[2]! - a.feet[2]!));
      if (d > cameraJump) {
        cameraJump = d;
        const moved = Math.hypot(b.eye[0]! - a.eye[0]!, b.eye[1]! - a.eye[1]!, b.eye[2]! - a.eye[2]!);
        jumpAt = `${((b.t - rec[0]!.t) / 1000).toFixed(2)} s, ${b.clip}, ${b.air ? 'airborne' : 'on the floor'}, ${b.trav}, feet ${b.feet.map((v) => v.toFixed(1)).join(' ')}, eye moved ${moved.toFixed(1)}, view ${b.view}`;
      }
    }
    if (a.rootY !== null && b.rootY !== null && i - teleport > 2) rootPop = Math.max(rootPop, Math.abs(b.rootY - a.rootY));
    // A new play (its key) arriving with no cross-fade; the main clip changing inside one locomotion play is its nodes blending.
    if (b.clip && a.clip && b.clip !== a.clip && b.play !== a.play && b.blend !== null && b.blend >= 0.999 && b.from === null) snaps.push(`${a.clip} -> ${b.clip}`);
    if (b.air && b.clip && IDLES.has(b.clip)) idleInAir++;
    if (!b.air && b.clip && IDLES.has(b.clip) && feetStep < 5 && b.trav === 'none' && feetStep / Math.max(1e-3, b.dt / 1000) > 20) idleMoving++;
  }
  const q = (p: number): number => dts.length ? dts[Math.min(dts.length - 1, Math.floor(dts.length * p))]! : 0;
  return {
    n: rec.length, dtMedian: q(0.5), dtP95: q(0.95), dtMax: dts[dts.length - 1] ?? 0, spikes: dts.filter((d) => d > 50).length,
    cameraJump, rootPop, snaps, clips: clipsSeq(rec), jumpAt, idleInAir, idleMoving,
    spikesAt: rec.slice(1).filter((f) => f.dt > 50 && !stalled(f.t)).slice(0, 6).map((f) => `${((f.t - rec[0]!.t) / 1000).toFixed(2)} s ${f.dt.toFixed(0)} ms ${f.clip} ${f.feet?.map((v) => v.toFixed(0)).join(" ")}`),
  };
}

/** Steady speed over the last `seconds` of the frames: the feet's travel across the ground over the time. */
function speedOf(rec: Frame[], seconds = 0.5): number {
  const end = rec[rec.length - 1];
  if (!end?.feet) return NaN;
  const start = [...rec].reverse().find((f) => end.t - f.t >= seconds * 1000 && f.feet);
  if (!start?.feet) return NaN;
  return Math.hypot(end.feet[0]! - start.feet[0]!, end.feet[2]! - start.feet[2]!) / ((end.t - start.t) / 1000);
}

class Session {
  readonly scenarios: Scenario[] = [];
  readonly problems: string[] = [];
  private spawn: [number, number, number] = [0, 0, 0];
  private open = 0;
  constructor(private readonly page: Page, readonly map: string, private readonly dir: string) {
    page.on('pageerror', (e) => this.problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') this.problems.push(`console: ${m.text()}`); });
  }

  async load(): Promise<void> {
    const p = this.page;
    await p.addInitScript(INIT);
    await p.goto(`${BASE}?map=${this.map}&mode=play&fly&devmode`);
    await p.waitForFunction(() => (window.__viewer?.stats().triangles ?? 0) > 0 && (window.__viewer?.stats().collisionPolys ?? 0) > 0, undefined, { timeout: 180_000 });
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.mouse.click(640, 360);                                        // the gesture the audio waits for
    await p.keyboard.press('Escape');
    if (!(await p.evaluate(() => window.__viewer.setMode('walk')))) throw new Error(`${this.map}: walk refused`);
    const stand = await p.evaluate(() => window.__viewer.stats().stand);
    this.spawn = stand ? [stand.position[0], stand.floor ?? stand.position[1], stand.position[2]] : (await p.evaluate(() => window.__viewer.feet()))!;
    // The open heading from the spawn: of eight, the one 2.5 s of the run gets furthest along.
    let best = -1;
    for (let yaw = 0; yaw < 360; yaw += 45) {
      await this.place(this.spawn, yaw);
      const d = await p.evaluate(() => { const a = window.__viewer.feet()!; window.__viewer.walkFor(2.5, { forward: 1 }); const b = window.__viewer.feet()!; return Math.hypot(b[0] - a[0], b[2] - a[2]); });
      if (d > best) { best = d; this.open = yaw; }
    }
    await this.place(this.spawn, this.open);
    await p.waitForTimeout(800);
  }

  async place(at: readonly number[], yaw: number, stance: 'stand' | 'crouch' | 'prone' = 'stand'): Promise<void> {
    await this.page.evaluate(([x, y, z, e, yw, pitch, st]) => {
      window.__viewer.setStance(st as 'stand');
      window.__viewer.setCamera({ x: x as number, y: (y as number) + (e as number), z: z as number, yaw: yw as number, pitch: pitch as number });
    }, [at[0]!, at[1]!, at[2]!, EYE, yaw, INIT_PITCH, stance] as const);
  }

  private async record(): Promise<void> {
    await this.page.evaluate(() => { const w = window as unknown as { __pt: { on: boolean; rec: unknown[]; shots: number[] } }; w.__pt.rec = []; w.__pt.shots = []; w.__pt.on = true; });
  }
  private async stop(): Promise<{ rec: Frame[]; shots: number[] }> {
    return this.page.evaluate(() => { const w = window as unknown as { __pt: { on: boolean; rec: Frame[]; shots: number[] } }; w.__pt.on = false; return { rec: w.__pt.rec, shots: w.__pt.shots }; });
  }
  async pad(axes: number[], buttons: Record<number, boolean> = {}): Promise<void> {
    await this.page.evaluate(([ax, bt]) => {
      const pad = (window as unknown as { __pad: { axes: number[]; buttons: { pressed: boolean; value: number }[]; timestamp: number } }).__pad;
      pad.axes = ax;
      for (const [i, on] of Object.entries(bt)) pad.buttons[Number(i)] = { pressed: on, value: on ? 1 : 0 };
      pad.timestamp++;
    }, [axes, buttons] as const);
  }
  async shot(name: string): Promise<string> {
    await this.page.evaluate(() => { (window as unknown as { __pt: { shots: number[] } }).__pt.shots.push(performance.now()); });
    const file = join(this.dir, `${name}.png`);
    await this.page.screenshot({ path: file });
    return file;
  }
  async audio(): Promise<{ events: Record<string, number>; byName: Record<string, number>; played: number; dropped: Record<string, number>; missing: string[]; state: string }> {
    return this.page.evaluate(() => { const a = window.__viewer.audio(); return { events: a.events, byName: a.byName, played: a.played, dropped: a.dropped, missing: a.missing, state: a.state }; });
  }

  /** Runs one scenario: the recorder on around `body`, the audio's counters before and after, the frames scored. */
  async scenario(name: string, body: (s: Session, numbers: Record<string, unknown>, findings: string[], shots: string[]) => Promise<void>): Promise<void> {
    const numbers: Record<string, unknown> = {}, findings: string[] = [], shots: string[] = [];
    const before = await this.audio();
    await this.record();
    try {
      await body(this, numbers, findings, shots);
    } catch (e) {
      findings.push(`scenario threw: ${(e as Error).message}`);
    }
    const { rec, shots: shotTimes } = await this.stop();
    const after = await this.audio();
    const delta = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
      Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v - (a[k] ?? 0)]).filter(([, v]) => v !== 0));
    numbers['audio'] = { events: delta(before.events, after.events), byName: delta(before.byName, after.byName), dropped: delta(before.dropped, after.dropped), state: after.state };
    if (after.missing.length) numbers['audioMissing'] = after.missing;
    const frames = score(rec, shotTimes);
    if (frames.spikes) findings.push(`${frames.spikes} frame(s) over 50 ms (max ${frames.dtMax.toFixed(0)} ms): ${frames.spikesAt.join("; ")}`);
    if (frames.cameraJump > 4) findings.push(`camera moved ${frames.cameraJump.toFixed(1)} units in one frame beyond the feet (${frames.jumpAt})`);
    if (frames.idleInAir) findings.push(`${frames.idleInAir} frame(s) in the air playing an idle clip`);
    if (frames.idleMoving > 3) findings.push(`${frames.idleMoving} frame(s) moving over 20 u/s on the floor while an idle clip plays`);
    if (frames.rootPop > 1.5) findings.push(`posed root stepped ${frames.rootPop.toFixed(2)} in one frame`);
    if (frames.snaps.length) findings.push(`clip switched with no blend: ${[...new Set(frames.snaps)].join(', ')}`);
    this.scenarios.push({ map: this.map, name, numbers, findings, shots, frames });
    // Back to the spawn, standing, every input let go.
    await this.pad([0, 0, 0, 0], Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i, false])));
    await this.place(this.spawn, this.open);
    await this.page.waitForTimeout(500);
  }

  spawnAt(): [number, number, number] { return this.spawn; }
  openYaw(): number { return this.open; }
  get p(): Page { return this.page; }
}

const read = <T>(page: Page, fn: () => T): Promise<T> => page.evaluate(fn);

async function playMap(s: Session): Promise<void> {
  const p = s.p, yaw = s.openYaw();
  await s.scenario('run at three pad bytes', async (x, n, f, shots) => {
    for (const [byte, want] of [[64, 26.0], [32, 58.97], [0, 65]] as const) {
      await x.place(x.spawnAt(), yaw);
      await x.pad([0, axis(byte), 0, 0]);
      await p.waitForTimeout(1500);
      const rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.slice(-40));
      const v = speedOf(rec, 0.4);
      n[`speed@byte${byte}`] = +v.toFixed(2);
      n[`clip@byte${byte}`] = rec[rec.length - 1]?.clip;
      n[`padMoveY@byte${byte}`] = await read(p, () => window.__viewer.pad().input.moveY);
      if (Math.abs(v - want) > want * 0.05) f.push(`pad byte ${byte}: ${v.toFixed(1)} u/s against ${want}`);
      if (byte === 0) shots.push(await x.shot(`${x.map}-run-full`));
      await x.pad([0, 0, 0, 0]);
      await p.waitForTimeout(300);
    }
  });
  await s.scenario('strafe, diagonal, back', async (x, n, f, shots) => {
    const cases = [['right', yaw + 90, [axis(255), 0, 0, 0], 65, 'seal_run_90r'], ['diagonal', yaw + 45, [axis(255), axis(0), 0, 0], 65, null], ['back', yaw + 180, [0, axis(255), 0, 0], 37, 'seal_run_bw']] as const;
    for (const [name, yw, ax, want, clip] of cases) {
      await x.place(x.spawnAt(), yw);
      await x.pad([...ax]);
      await p.waitForTimeout(1500);
      const rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.slice(-40));
      const v = speedOf(rec, 0.4), last = rec[rec.length - 1];
      n[`speed.${name}`] = +v.toFixed(2);
      n[`clip.${name}`] = last?.clip;
      if (Math.abs(v - want) > want * 0.05) f.push(`${name}: ${v.toFixed(1)} u/s against ${want}`);
      if (clip && last?.clip !== clip) f.push(`${name}: plays ${last?.clip}, the game's set gives ${clip}`);
      shots.push(await x.shot(`${x.map}-${name}`));
      await x.pad([0, 0, 0, 0]);
      await p.waitForTimeout(300);
    }
  });
  await s.scenario('turn in place, right stick full', async (x, n, _f, shots) => {
    await x.pad([0, 0, axis(255), 0]);
    await p.waitForTimeout(1000);
    n['turnRateDegS'] = +((await read(p, () => window.__viewer.look().turnRate)) / DEG).toFixed(2);
    n['clip'] = (await read(p, () => window.__viewer.stats().anim?.clip)) ?? null;
    shots.push(await x.shot(`${x.map}-turning`));
    await x.pad([0, 0, 0, 0]);
  });
  await s.scenario('stance: Triangle tap, crouch walk, hold, crawl, hold', async (x, n, f, shots) => {
    const tri = async (ms: number): Promise<void> => { await x.pad([0, 0, 0, 0], { 3: true }); await p.waitForTimeout(ms); await x.pad([0, 0, 0, 0], { 3: false }); };
    await tri(120);
    await p.waitForTimeout(1200);
    n['afterTap'] = await read(p, () => window.__viewer.stance());
    shots.push(await x.shot(`${x.map}-crouched`));
    await x.pad([0, axis(64), 0, 0]);
    await p.waitForTimeout(1200);
    let rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.slice(-30));
    n['crouchWalk'] = +speedOf(rec, 0.4).toFixed(2);
    n['crouchWalkClip'] = rec[rec.length - 1]?.clip;
    shots.push(await x.shot(`${x.map}-crouch-walk`));
    await x.pad([0, 0, 0, 0]);
    await p.waitForTimeout(400);
    await tri(700);
    await p.waitForTimeout(1800);
    n['afterHold'] = await read(p, () => window.__viewer.stance());
    shots.push(await x.shot(`${x.map}-prone`));
    await x.pad([0, axis(0), 0, 0]);
    await p.waitForTimeout(1200);
    rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.slice(-30));
    n['crawl'] = +speedOf(rec, 0.4).toFixed(2);
    n['crawlClip'] = rec[rec.length - 1]?.clip;
    await x.pad([0, 0, 0, 0]);
    await p.waitForTimeout(300);
    await tri(700);
    await p.waitForTimeout(1800);
    n['afterSecondHold'] = await read(p, () => window.__viewer.stance());
    if (n['afterTap'] !== 'crouch') f.push(`Triangle tap from standing gave ${n['afterTap']}`);
    if (n['afterHold'] !== 'prone') f.push(`Triangle hold from crouch gave ${n['afterHold']}`);
    if (Math.abs((n['crouchWalk'] as number) - 14) > 0.7) f.push(`crouch walk at byte 64: ${n['crouchWalk']} against 14.0`);
    if (Math.abs((n['crawl'] as number) - 11) > 0.6) f.push(`crawl: ${n['crawl']} against 11`);
  });
  await s.scenario('standing jump, then running jump', async (x, n, f, shots) => {
    const floor = (await read(p, () => window.__viewer.feet()))![1];
    await p.keyboard.press('Space');
    await p.waitForTimeout(560);
    shots.push(await x.shot(`${x.map}-jump-standing`));
    await p.waitForTimeout(1200);
    let rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec);
    n['standing.feetTop'] = +(Math.max(...rec.map((r) => r.feet?.[1] ?? -1e9)) - floor).toFixed(3);
    n['standing.rootTop'] = +Math.max(...rec.map((r) => r.rootY ?? -1e9)).toFixed(3);
    if ((n['standing.feetTop'] as number) > 0.01) f.push(`the standing jump lifted the feet ${n['standing.feetTop']}`);
    if ((n['standing.rootTop'] as number) < 14.5) f.push(`the standing jump's root topped at ${n['standing.rootTop']} (the clip's 15.08)`);
    await x.place(x.spawnAt(), yaw);
    await p.waitForTimeout(600);
    const start = (await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.length));
    await p.keyboard.down('KeyW');
    await p.waitForTimeout(900);
    await p.keyboard.press('Space');
    await p.waitForTimeout(380);
    shots.push(await x.shot(`${x.map}-jump-running`));
    await p.waitForTimeout(900);
    await p.keyboard.up('KeyW');
    await p.waitForTimeout(500);
    rec = (await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec)).slice(start);
    const air = rec.filter((r) => r.air);
    n['running.airFrames'] = air.length;
    n['running.airSeconds'] = air.length ? +((air[air.length - 1]!.t - air[0]!.t) / 1000).toFixed(3) : 0;
    n['running.clips'] = clipsSeq(rec);
    n['landing'] = await read(p, () => window.__viewer.mover()?.landing ?? null);
  });
  await s.scenario('fire: semi, burst, auto', async (x, n, f, shots) => {
    for (let i = 0; i < 3; i++) {
      const mode = await read(p, () => window.__viewer.fireMode());
      const before = await read(p, () => ({ shots: window.__viewer.fire().shots, effects: window.__viewer.effects().played, fireEvents: window.__viewer.audio().events.fire }));
      await x.pad([0, 0, 0, 0], { 5: true });
      await p.waitForTimeout(700);
      if (i === 2) shots.push(await x.shot(`${x.map}-firing-${mode}`));
      await x.pad([0, 0, 0, 0], { 5: false });
      await p.waitForTimeout(600);
      const after = await read(p, () => ({ shots: window.__viewer.fire().shots, effects: window.__viewer.effects().played, fireEvents: window.__viewer.audio().events.fire, acc: window.__viewer.accuracy() }));
      const fired = after.shots - before.shots, sounds = after.fireEvents - before.fireEvents;
      const muzzle = Object.entries(after.effects).reduce((a, [k, v]) => a + (v - (before.effects[k] ?? 0)), 0);
      n[`${mode}.shots`] = fired;
      n[`${mode}.fireSounds`] = sounds;
      n[`${mode}.effects`] = muzzle;
      n[`${mode}.reticle`] = +after.acc.size.toFixed(1);
      if (sounds !== fired) f.push(`${mode}: ${fired} rounds and ${sounds} fire sounds`);
      if (mode === 'SEMI' && fired !== 1) f.push(`SEMI held 0.7 s fired ${fired}`);
      if (mode === 'BURST' && fired !== 3) f.push(`BURST held 0.7 s fired ${fired}`);
      await x.pad([0, 0, 0, 0], { 10: true });                              // L3: the next fire mode
      await p.waitForTimeout(100);
      await x.pad([0, 0, 0, 0], { 10: false });
      await p.waitForTimeout(200);
    }
    n['magazine'] = await read(p, () => window.__viewer.fire().magazine);
    n['effectSounds'] = await read(p, () => [...new Set(window.__viewer.effects().sounds)]);
    // A name the effects asked for that never played is one the map's banks do not hold (the audio drops it as unknown).
    const heard = await read(p, () => Object.keys(window.__viewer.audio().byName));
    const unheard = (n['effectSounds'] as string[]).filter((s) => !heard.includes(s));
    if (unheard.length) f.push(`effect sounds never heard (not in the map's banks): ${unheard.join(', ')}`);
  });
  await s.scenario('reload', async (x, n, f, shots) => {
    const before = await read(p, () => ({ mag: window.__viewer.fire().magazine, reload: window.__viewer.audio().events.reload }));
    await p.keyboard.press('KeyR');
    await p.waitForTimeout(700);
    shots.push(await x.shot(`${x.map}-reload`));
    n['during'] = await read(p, () => ({ mag: window.__viewer.fire().magazine, pose: window.__viewer.weapon().pose, hud: window.__viewer.hud().model.reloading }));
    await p.waitForTimeout(3000);
    const after = await read(p, () => ({ mag: window.__viewer.fire().magazine, reload: window.__viewer.audio().events.reload }));
    n['before'] = before.mag;
    n['after'] = after.mag;
    n['reloadSounds'] = after.reload - before.reload;
    if (before.mag.rounds < before.mag.capacity && after.mag.rounds !== after.mag.capacity) f.push(`reload left ${after.mag.rounds}/${after.mag.capacity}`);
    if (before.mag.rounds < before.mag.capacity && after.reload === before.reload) f.push('no reload sound');
  });
  await s.scenario('zoom in twice, out twice', async (x, n, _f, shots) => {
    for (const [i, button] of [[1, 12], [2, 12], [3, 13], [4, 13]] as const) {
      await x.pad([0, 0, 0, 0], { [button]: true });
      await p.waitForTimeout(120);
      await x.pad([0, 0, 0, 0], { [button]: false });
      await p.waitForTimeout(700);
      n[`step${i}`] = await read(p, () => { const z = window.__viewer.zoom(), r = window.__viewer.reticle(); return { ...z, reticle: r.visible, hud: window.__viewer.hud().model.zoom }; });
      if (i <= 2) shots.push(await x.shot(`${x.map}-zoom-${i}`));
    }
  });
  await s.scenario('grenade: equip, throw, explosion', async (x, n, f, shots) => {
    await p.keyboard.press('Digit4');
    await p.waitForTimeout(600);
    n['equipped'] = await read(p, () => ({ ...window.__viewer.grenade(), live: undefined, bounces: undefined, explosions: undefined }));
    await x.pad([0, 0, 0, 0], { 5: true });
    await p.waitForTimeout(700);
    await x.pad([0, 0, 0, 0], { 5: false });
    await p.waitForTimeout(250);
    shots.push(await x.shot(`${x.map}-grenade-throw`));
    let exploded = 0;
    for (let i = 0; i < 16 && !exploded; i++) { await p.waitForTimeout(250); exploded = (await read(p, () => window.__viewer.grenade().explosions.length)); }
    shots.push(await x.shot(`${x.map}-grenade-explosion`));
    const g = await read(p, () => { const s = window.__viewer.grenade(); return { thrown: s.thrown, left: s.left, lastThrow: s.lastThrow, bounces: s.bounces.length, explosions: s.explosions }; });
    n['grenade'] = g;
    const heard = await read(p, () => window.__viewer.audio().byName);
    n['heard'] = Object.fromEntries(Object.entries(heard).filter(([k]) => !/STEP|M4A1|BUL/.test(k)));
    if (g.lastThrow && !heard[g.lastThrow.sound]) n['throwSoundUnheard'] = g.lastThrow.sound;
    if (!g.thrown) f.push('R1 with the grenade up threw nothing');
    if (!exploded) f.push('no explosion within 4 s of the throw');
    await p.keyboard.press('Digit1');
    await p.waitForTimeout(500);
  });
}

/**
 * Blood Lake's water: the lake's surface is one liquid polygon at y 12, its bed 7-10 a few units under it west of
 * x 700 at z 1100, the shore rising to 23 at x 660 -- walked in from the shore, then out into the lake and back.
 */
async function playBloodLake(s: Session): Promise<void> {
  const p = s.p;
  await s.scenario('wade into the lake from the west shore', async (x, n, f, shots) => {
    await x.place([640, 31, 1100], -90);
    await p.waitForTimeout(600);
    await p.keyboard.down('KeyW');
    const track: { t: number; x: number; y: number; depth: number; speed: number; clip: string | null }[] = [];
    let last: number[] | null = null;
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(100);
      const r = await read(p, () => ({ feet: window.__viewer.feet()!, depth: window.__viewer.traversal()?.depth ?? 0, clip: window.__viewer.stats().anim?.clip ?? null }));
      track.push({ t: i / 10, x: +r.feet[0].toFixed(1), y: +r.feet[1].toFixed(2), depth: +r.depth.toFixed(2), speed: last ? +(Math.hypot(r.feet[0] - last[0]!, r.feet[2] - last[2]!) * 10).toFixed(1) : 0, clip: r.clip });
      last = r.feet;
      if (i === 15) shots.push(await x.shot('MP10-wading'));
    }
    await p.keyboard.up('KeyW');
    n['track'] = track.filter((_, i) => i % 3 === 0);
    const wet = track.filter((r) => r.depth > 0);
    n['maxDepth'] = Math.max(0, ...track.map((r) => r.depth));
    n['speedDry'] = track.find((r) => r.depth === 0 && r.speed > 0)?.speed ?? null;
    n['speedWet'] = wet.length ? wet[wet.length - 1]!.speed : null;
    if (!wet.length) f.push('walked 3 s into the lake and the traversal never read a depth');
  });
}

/**
 * Sujo's glass: the panes of `worldmodel/g1890` stand in the plane z 537 at x 995-999, y 155-186 (the hull's
 * material 9, `GLASS`, 0.99 of a round through by `projectile.ts`'s table). From 60 south of them, the view pitched onto
 * the pane's middle, one SEMI round: what it hits, whether it goes through, what sounds.
 */
async function playSujo(s: Session): Promise<void> {
  const p = s.p;
  await s.scenario('a round through a glass pane', async (x, n, f, shots) => {
    await x.place([997, 200, 477], 180);
    await p.waitForTimeout(800);
    const eye = (await read(p, () => window.__viewer.camera()?.eye))!;
    const pitch = Math.atan2(170 - eye[1]!, 537 - eye[2]!) * 180 / Math.PI;
    await p.evaluate((pt) => window.__viewer.setCamera({ yaw: 180, pitch: pt }), pitch);
    await p.waitForTimeout(500);
    while ((await read(p, () => window.__viewer.fireMode())) !== 'SEMI') await read(p, () => window.__viewer.switchFireMode());
    const before = await read(p, () => ({ played: { ...window.__viewer.audio().byName }, fx: { ...window.__viewer.effects().played } }));
    await read(p, () => window.__viewer.shoot());
    await p.waitForTimeout(700);
    shots.push(await x.shot('MP61-glass-shot'));
    const after = await read(p, () => ({ played: window.__viewer.audio().byName, fx: window.__viewer.effects().played, hit: window.__viewer.fire().lastHit }));
    n['feet'] = await read(p, () => window.__viewer.feet());
    n['pitch'] = +pitch.toFixed(2);
    n['lastHit'] = after.hit;
    n['sounds'] = Object.fromEntries(Object.entries(after.played).filter(([k, v]) => v !== (before.played[k] ?? 0)));
    n['effects'] = Object.fromEntries(Object.entries(after.fx).filter(([k, v]) => v !== (before.fx[k] ?? 0)));
    const hit = after.hit as unknown as Record<string, unknown> | null;
    if (!hit) f.push('the round aimed at the pane hit nothing');
  });
}

/**
 * Guidance's ice: the hull's material 16 (`ICE`) on `worldmodel/terrain_167` / `_80` around (1266, -28, 2334), about
 * 600 from spawn A. Stood on it, the run for 1.5 s each way along x: the steps' sound and the speed across it.
 */
async function playGuidance(s: Session): Promise<void> {
  const p = s.p;
  await s.scenario('run on the ice', async (x, n, _f, shots) => {
    for (const [name, yaw] of [['east', -90], ['west', 90]] as const) {
      await x.place([1266, -28, 2334], yaw);
      await p.waitForTimeout(600);
      const before = await read(p, () => ({ ...window.__viewer.audio().byName }));
      await p.keyboard.down('KeyW');
      await p.waitForTimeout(1500);
      const rec = await p.evaluate(() => (window as unknown as { __pt: { rec: Frame[] } }).__pt.rec.slice(-30));
      if (name === 'east') shots.push(await x.shot('MP82-ice'));
      await p.keyboard.up('KeyW');
      const after = await read(p, () => window.__viewer.audio().byName);
      n[`${name}.speed`] = +speedOf(rec, 0.4).toFixed(1);
      n[`${name}.feet`] = rec[rec.length - 1]?.feet?.map((v) => +v.toFixed(1));
      n[`${name}.sounds`] = Object.fromEntries(Object.entries(after).filter(([k, v]) => v !== (before[k] ?? 0)));
      await p.waitForTimeout(400);
    }
  });
}

async function playFrostfire(s: Session): Promise<void> {
  const p = s.p;
  await s.scenario('walk off the 142 deck', async (x, n, f, shots) => {
    await x.place([660, 142, 725], -90);
    await p.waitForTimeout(500);
    await p.keyboard.down('KeyW');
    for (let i = 0; i < 20; i++) { await p.waitForTimeout(100); if (await read(p, () => window.__viewer.mover()?.airborne)) break; }
    await p.waitForTimeout(250);
    shots.push(await x.shot('MP2-falling'));
    await p.waitForTimeout(800);
    await p.keyboard.up('KeyW');
    n['landing'] = await read(p, () => window.__viewer.mover()?.landing ?? null);
    n['feet'] = await read(p, () => window.__viewer.feet());
    const air = (n['landing'] as { airTime: number } | null)?.airTime;
    if (air === undefined || Math.abs(air - 0.598) > 0.05) f.push(`the 42 fall took ${air}`);
  });
  await s.scenario('ladder up to the 160 deck', async (x, n, f, shots) => {
    await x.place([547.5, 100, 869], 0);
    await p.waitForTimeout(400);
    await p.keyboard.down('KeyW');
    for (let i = 0; i < 30; i++) { await p.waitForTimeout(100); if ((await read(p, () => window.__viewer.traversal()?.kind)) === 'ladder') break; }
    await p.waitForTimeout(1500);
    shots.push(await x.shot('MP2-ladder-mid'));
    n['mid'] = await read(p, () => ({ t: window.__viewer.traversal()?.kind, clip: window.__viewer.stats().anim?.clip, feet: window.__viewer.feet(), hud: window.__viewer.hud().model.action }));
    for (let i = 0; i < 80; i++) { await p.waitForTimeout(100); if ((await read(p, () => window.__viewer.traversal()?.kind)) === 'none' && (await read(p, () => window.__viewer.feet()![1])) > 150) break; }
    await p.keyboard.up('KeyW');
    await p.waitForTimeout(600);
    shots.push(await x.shot('MP2-ladder-top'));
    n['top'] = await read(p, () => ({ feet: window.__viewer.feet(), t: window.__viewer.traversal()?.kind, events: window.__viewer.traversal()?.events.map((e) => e.type) }));
    const y = (n['top'] as { feet: number[] }).feet[1]!;
    if (Math.abs(y - 160) > 0.5) f.push(`the ladder left the feet at y ${y.toFixed(2)}, not the 160 deck`);
  });
  await s.scenario('crate climb (X)', async (x, n, f, shots) => {
    await x.place([938, 100, 795], 0);
    await p.waitForTimeout(400);
    await p.keyboard.down('KeyW');
    await p.waitForTimeout(700);
    await p.keyboard.up('KeyW');
    n['prompt'] = await read(p, () => window.__viewer.traversal()?.prompt ?? null);
    n['hudAction'] = await read(p, () => window.__viewer.hud().model.action);
    await p.keyboard.press('KeyX');
    await p.waitForTimeout(500);
    shots.push(await x.shot('MP2-climb-mid'));
    await p.waitForTimeout(2000);
    n['feet'] = await read(p, () => window.__viewer.feet());
    const y = (n['feet'] as number[])[1]!;
    if (Math.abs(y - 111.85) > 0.3) f.push(`the crate climb ended at y ${y.toFixed(2)} (its top 111.85)`);
  });
  await s.scenario('jump-grab onto the crate', async (x, n, f, shots) => {
    await x.place([938, 100, 845], 0);
    await p.waitForTimeout(500);
    // In the page, a frame at a time: W held, the jump 8 short of the crate's face at a full run, so the face is met low in the leap, X on the first frame
    // the climb icon shows while airborne.
    await p.keyboard.down('KeyW');
    const got = await p.evaluate(`new Promise((done) => {
      const v = window.__viewer, key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
      let jumped = false, frames = 0, air = 0;
      requestAnimationFrame(function step() {
        frames++;
        const f = v.feet(), m = v.mover(), t = v.traversal();
        if (m.airborne) air++;
        if (!jumped && f[2] < 790) { key('keydown', 'Space'); key('keyup', 'Space'); jumped = true; }
        if (jumped && m.airborne && t.prompt && t.prompt.visible) {
          key('keydown', 'KeyX'); key('keyup', 'KeyX');
          done({ frames, air, airPrompt: true, at: f, prompt: t.prompt });
          return;
        }
        if (frames > 90) { done({ frames, air, airPrompt: false, at: f, prompt: t.prompt, kind: t.kind }); return; }
        requestAnimationFrame(step);
      });
    })`) as { frames: number; air: number; airPrompt: boolean };
    await p.keyboard.up('KeyW');
    n['grab'] = got;
    await p.waitForTimeout(250);
    shots.push(await x.shot('MP2-jump-grab'));
    await p.waitForTimeout(2200);
    n['feet'] = await read(p, () => window.__viewer.feet());
    n['events'] = await read(p, () => window.__viewer.traversal()?.events.slice(-4).map((e) => e.type));
    // Met low in the leap, the crate's face is in reach from the air: taken by X on the icon, or on its own (a step-up).
    n['grabbedBy'] = got.airPrompt ? 'X on the airborne icon' : 'itself (no icon: an automatic climb from the air)';
    if (Math.abs((n['feet'] as number[])[1]! - 111.85) > 0.3) f.push(`the jump-grab ended at y ${(n['feet'] as number[])[1]!.toFixed(2)}, not on the crate (${got.air} frames airborne)`);
  });
  await s.scenario('peek right (E) and left (Q)', async (x, n, _f, shots) => {
    await x.place([796, 100, 614], 180);
    await p.waitForTimeout(400);
    for (const k of ['KeyE', 'KeyQ']) {
      await p.keyboard.down(k);
      await p.waitForTimeout(900);
      n[k] = await read(p, () => ({ peek: window.__viewer.traversal()?.peek, clip: window.__viewer.stats().anim?.clip, target: window.__viewer.camera()?.target, feet: window.__viewer.feet() }));
      shots.push(await x.shot(`MP2-peek-${k === 'KeyE' ? 'right' : 'left'}`));
      await p.keyboard.up(k);
      await p.waitForTimeout(700);
    }
  });
}

const browser = await chromium.launch({ ...(CHANNEL === 'headless-shell' ? {} : { channel: CHANNEL }), args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const all: Scenario[] = [];
const problems: Record<string, string[]> = {};
const backends: Record<string, string> = {};
try {
  for (const map of MAPS) {
    const dir = join(OUT, map);
    mkdirSync(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const s = new Session(page, map, dir);
    await s.load();
    backends[map] = await page.evaluate(() => window.__viewer.stats().backend);
    console.error(`${map} (${backends[map]}): spawn ${s.spawnAt().map((v) => v.toFixed(1)).join(', ')}, open heading ${s.openYaw()}`);
    await playMap(s);
    if (map === 'MP2') await playFrostfire(s);
    if (map === 'MP10') await playBloodLake(s);
    if (map === 'MP61') await playSujo(s);
    if (map === 'MP82') await playGuidance(s);
    all.push(...s.scenarios);
    problems[map] = s.problems;
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'playtest.json'), JSON.stringify({ channel: CHANNEL, backends, scenarios: all, problems }, null, 2));
for (const sc of all) {
  console.log(`\n## ${sc.map} -- ${sc.name}`);
  console.log(`camera jump at: ${sc.frames.jumpAt}; idle in air ${sc.frames.idleInAir}, idle moving ${sc.frames.idleMoving}`);
  console.log(`frames ${sc.frames.n}, dt median ${sc.frames.dtMedian.toFixed(1)} p95 ${sc.frames.dtP95.toFixed(1)} max ${sc.frames.dtMax.toFixed(1)} ms; camera jump ${sc.frames.cameraJump.toFixed(2)}; root step ${sc.frames.rootPop.toFixed(2)}`);
  console.log(`clips: ${sc.frames.clips.join(' > ')}`);
  console.log(`numbers: ${JSON.stringify(sc.numbers)}`);
  for (const f of sc.findings) console.log(`  !! ${f}`);
}
for (const [map, list] of Object.entries(problems)) if (list.length) console.log(`\n${map} page problems:\n  ${[...new Set(list)].join('\n  ')}`);
