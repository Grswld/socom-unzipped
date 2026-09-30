import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type ConsoleMessage, type Page } from '@playwright/test';
import type {} from '../src/hook';

/**
 * The Online setting (owner, 2026-09-29; `../src/online.ts`): Local is the static server on this machine at port 8787
 * (`npm start -w @s2u/server`'s default), so this spec starts one there, as the multiplayer spec starts its own (the
 * fixtures' disc, Frostfire alone), and is skipped when the port is taken. A page in reCOM mode joins it as a player; a
 * page in the map viewer joins as a watcher and sees the player on the map. A server that is not there is shown as
 * unreachable and retried, without a page error.
 */

const WEB = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(WEB, 'test-fixtures');
const HAVE = existsSync(join(FIXTURES, 'RUN', 'MP2.ZDB'));
const LOCAL_PORT = 8787;

let server: ChildProcess | null = null;
let portFree = true;

const free = (port: number): Promise<boolean> => new Promise((ok) => {
  const probe = createServer();
  probe.once('error', () => ok(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
});

test.beforeAll(async () => {
  if (!HAVE) return;
  portFree = await free(LOCAL_PORT);
  if (!portFree) return;
  server = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/main.ts'], {
    cwd: WEB, env: { ...process.env, SOCOM_DISC: FIXTURES, PORT: String(LOCAL_PORT), HOST: '127.0.0.1', MAPS: 'MP2' }, stdio: 'pipe',
    detached: process.platform !== 'win32',
  });
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('the match server did not start')), 60_000);
    server!.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('"listening"')) { clearTimeout(timer); ok(); } });
    server!.on('exit', (code) => fail(new Error(`the match server exited ${code}`)));
  });
});

test.afterAll(() => {
  if (!server?.pid) return;
  try { if (process.platform === 'win32') server.kill(); else process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
});

/** A page with the Online setting on Local, in reCOM mode or the map viewer, on Frostfire. */
async function localPage(browser: Browser, name: string, recom: boolean): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await context.addInitScript(([n, r]) => {
    localStorage.setItem('s2u.viewer.panelOpen', '1');
    localStorage.setItem('s2u.mp.name', n);
    localStorage.setItem('s2u.viewer.online', 'local');
    localStorage.setItem('s2u.viewer.recom', r ? '1' : '0');
  }, [name, recom] as const);
  const page = await context.newPage();
  await page.goto(`/?devmode&fly&map=MP2`);
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  return page;
}

test.describe('Online: Local', () => {
  test.skip(!HAVE, 'fixtures absent: run npm run extract-maps');

  test('a reCOM page joins as a player; a map viewer page watches it, and the panel says online', async ({ browser }) => {
    test.skip(!portFree, `port ${LOCAL_PORT} is taken: Local cannot be started here`);
    const player = await localPage(browser, 'ALPHA', true);
    await expect(player.locator('#online [data-online="local"]')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => player.evaluate(() => window.__viewer.online!().state), { timeout: 60_000 }).toBe('online');
    expect(await player.evaluate(() => window.__viewer.net!()!.role)).toBe('player');
    expect(await player.evaluate(() => window.__viewer.online!().url)).toBe('ws://localhost:8787/ws');

    const watcher = await localPage(browser, 'WATCH', false);
    await expect.poll(() => watcher.evaluate(() => window.__viewer.online!().state), { timeout: 60_000 }).toBe('online');
    const w = await watcher.evaluate(() => ({ ...window.__viewer.online!(), role: window.__viewer.net!()!.role, queue: window.__viewer.net!()!.queue }));
    expect(w).toMatchObject({ watching: true, role: 'spectator', queue: 0 });
    await expect(watcher.locator('#online-text')).toContainText('online');
    await expect(watcher.locator('#online-text')).toContainText('watching');
    await expect(watcher.locator('#online-lamp')).toHaveClass(/is-up/);
    // The watcher draws the player.
    await expect.poll(() => watcher.evaluate(() => window.__viewer.net!()!.remotes), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => watcher.evaluate(() => window.__viewer.online!().players), { timeout: 30_000 }).toBe(1);
    // The player stays the only player: the watcher took no place.
    expect(await player.evaluate(() => window.__viewer.net!()!.remotes)).toBe(0);
    // PLAYERS ONLINE (../src/playersOnline.ts): with Online on Local the page reads the local server's /rooms -- one
    // player, the watcher not counted -- in the kicker and after Frostfire's name in the picker.
    await expect(watcher.locator('#players-online')).toHaveText('1', { timeout: 30_000 });
    await expect(watcher.locator('#maps option[value="RUN/MP2.ZDB"]')).toContainText('· 1 playing');
    expect(await watcher.evaluate(() => window.__viewer.playersOnline!())).toEqual({ total: 1, byMap: { MP2: 1 } });

    // Off leaves the match; the line says so.
    await watcher.locator('#online [data-online="off"]').click();
    await expect.poll(() => watcher.evaluate(() => window.__viewer.online!().state)).toBe('off');
    await expect(watcher.locator('#online-text')).toContainText('single player');
    expect(await watcher.evaluate(() => localStorage.getItem('s2u.viewer.online'))).toBe('off');
    await player.context().close();
    await watcher.context().close();
  });
});

test('a server that is not there: unreachable, retried slowly, no page error', async ({ page }) => {
  test.skip(!HAVE, 'fixtures absent: run npm run extract-maps');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sockets: ConsoleMessage[] = [];
  page.on('console', (m) => { if (/WebSocket/.test(m.text())) sockets.push(m); });
  await page.goto('/?devmode&fly&map=MP2&server=ws://127.0.0.1:9/ws');
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await expect.poll(() => page.evaluate(() => window.__viewer.online!().state), { timeout: 30_000 }).toBe('retrying');
  await expect(page.locator('#online-text')).toContainText('server unreachable');
  await expect(page.locator('#online-lamp')).toHaveClass(/is-down/);
  await page.waitForTimeout(5000);
  // 2 s, then 4 s: at most a handful of attempts in the first seconds, each one line from the browser at most.
  expect(sockets.length).toBeLessThanOrEqual(4);
  expect(errors).toEqual([]);
});
