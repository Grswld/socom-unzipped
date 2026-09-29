import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The match in two browsers (web sprint 3, M4/M5; the bar's item 6 "new multi-client e2e"): a real match server
 * (`@s2u/server`, from the fixtures' disc) and two pages on Frostfire with `?redotcom&fly&mp`. Each page joins, is stood
 * on its side's spawn by the server, and draws the other; a page walking is seen walking on the other, and its own
 * prediction takes no correction.
 */

const WEB = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(WEB, 'test-fixtures');
const SCREENS = join(FIXTURES, 'screens', 'multiplayer');
/** The match server's port: any free one (the server logs it), so an orphan from an earlier run cannot collide. */
let MP_PORT = 0;
const HAVE = existsSync(join(FIXTURES, 'RUN', 'MP2.ZDB'));

let server: ChildProcess | null = null;

/** Starts the match server (on any free port the first time, on the same one after a restart). */
async function startServer(port: number): Promise<void> {
  // Node itself with tsx's loader, one process: `npx` is `npx.cmd` on Windows, which `spawn` cannot start unshelled.
  server = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/main.ts'], {
    cwd: WEB, env: { ...process.env, SOCOM_DISC: FIXTURES, PORT: String(port), HOST: '127.0.0.1', MAPS: 'MP2' }, stdio: 'pipe',
    detached: process.platform !== 'win32',          // its own process group on POSIX, so anything under it stops too
  });
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('the match server did not start')), 60_000);
    server!.stdout!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.includes('"listening"')) continue;
        MP_PORT = (JSON.parse(line) as { port: number }).port;
        clearTimeout(timer);
        ok();
      }
    });
    server!.on('exit', (code) => fail(new Error(`the match server exited ${code}`)));
  });
}

test.beforeAll(async () => { if (HAVE) await startServer(0); });

/** Stops the server: its process group on POSIX; on Windows (no groups to signal) the one node process. */
function stopServer(): void {
  if (!server?.pid) return;
  try { if (process.platform === 'win32') server.kill(); else process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
}

test.afterAll(() => { stopServer(); });

async function joinPage(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await context.addInitScript((n) => { localStorage.setItem('s2u.viewer.panelOpen', '1'); localStorage.setItem('s2u.mp.name', n); }, name);
  const page = await context.newPage();
  await page.goto(`/?redotcom&fly&mp&server=ws://127.0.0.1:${MP_PORT}/ws&map=MP2`);
  await expect.poll(() => page.evaluate(() => window.__viewer?.net?.()?.feet ?? null), { timeout: 120_000 }).not.toBeNull();
  return page;
}

test.skip(!HAVE, 'fixtures absent: run npm run extract-maps');

test('two pages on Frostfire: each joins its side, draws the other, and sees the other walk', async ({ browser }) => {
  mkdirSync(SCREENS, { recursive: true });
  const a = await joinPage(browser, 'ALPHA');
  const b = await joinPage(browser, 'BRAVO');
  const na = await a.evaluate(() => window.__viewer.net!()!);
  const nb = await b.evaluate(() => window.__viewer.net!()!);
  expect(na).toMatchObject({ state: 'open', role: 'player', team: 'terrorist' });   // both empty -> Terrorists (research 91 §7)
  expect(nb).toMatchObject({ state: 'open', role: 'player', team: 'seal' });
  // Each draws the other: one body, the other's id.
  await expect.poll(() => a.evaluate(() => window.__viewer.net!()!.remotes), { timeout: 30_000 }).toBe(1);
  await expect.poll(() => b.evaluate(() => window.__viewer.net!()!.remotes), { timeout: 30_000 }).toBe(1);
  const seen = async (): Promise<number[]> => (await b.evaluate(() => window.__viewer.net!()!.bodies[0]!.feet));
  const before = await seen();
  const own = (await a.evaluate(() => window.__viewer.net!()!.feet))!;
  expect(Math.hypot(before[0]! - own[0]!, before[2]! - own[2]!)).toBeLessThan(2);   // B draws A where A stands
  // A walks forward for a second and a half: B sees it move by the same distance A went.
  await a.bringToFront();
  // Held until it has gone 20 units, not for a fixed time: under SwiftShader a frame can pass the page's 0.1 s cap.
  await a.keyboard.down('KeyW');
  await expect.poll(async () => { const f = (await a.evaluate(() => window.__viewer.net!()!.feet))!; return Math.hypot(f[0]! - own[0]!, f[2]! - own[2]!); }, { timeout: 30_000 }).toBeGreaterThan(20);
  await a.keyboard.up('KeyW');
  await a.waitForTimeout(800);
  const after = (await a.evaluate(() => window.__viewer.net!()!.feet))!;
  const went = Math.hypot(after[0]! - own[0]!, after[2]! - own[2]!);
  expect(went).toBeGreaterThan(10);
  await expect.poll(async () => { const f = await seen(); return Math.hypot(f[0]! - after[0]!, f[2]! - after[2]!); }, { timeout: 5000 }).toBeLessThan(1);
  // The prediction agreed with the server: no correction.
  expect((await a.evaluate(() => window.__viewer.net!()!.corrections)).snapped).toBe(0);
  expect((await a.evaluate(() => window.__viewer.net!()!.corrections)).largest).toBeLessThan(0.01);
  await b.screenshot({ path: join(SCREENS, 'bravo-sees-alpha.png') });
  await a.screenshot({ path: join(SCREENS, 'alpha.png') });
  await a.context().close();
  await b.context().close();
});

test('a server restart mid-round: both pages join again and see each other (M9)', async ({ browser }) => {
  const a = await joinPage(browser, 'ALPHA');
  const b = await joinPage(browser, 'BRAVO');
  await expect.poll(() => a.evaluate(() => window.__viewer.net!()!.remotes), { timeout: 30_000 }).toBe(1);
  const port = MP_PORT;
  const old = server!;
  old.removeAllListeners('exit');
  const gone = new Promise((ok) => old.once('exit', ok));
  stopServer();
  await gone;
  await expect.poll(() => a.evaluate(() => window.__viewer.net!()!.state), { timeout: 10_000 }).toBe('closed');
  await startServer(port);
  for (const p of [a, b]) {
    await expect.poll(() => p.evaluate(() => window.__viewer.net!()!.state), { timeout: 30_000 }).toBe('open');
    await expect.poll(() => p.evaluate(() => window.__viewer.net!()!.remotes), { timeout: 30_000 }).toBe(1);
  }
  await a.context().close();
  await b.context().close();
});
