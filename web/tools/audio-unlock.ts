/**
 * The audio unlock's cost, re-measured (web research 90 §9.3): maps measured 36-466 ms, audio < 1 ms. The unlock's
 * listener (`GameAudio.unlockOn`) makes the `AudioContext` itself when the map's banks have not yet landed (`prepare`
 * runs when they do); otherwise it only resumes the context made at load. So the cost depends on when the first
 * gesture comes. Per map, two fresh pages: the click at once when the scene is built (the banks maybe not in), and the
 * click 2 s after the banks are in. Each records whether the context existed before the click (`audio().state` and the
 * banks), the listener's own `timing.unlockMs`, and the frame that carried the click.
 *
 *   npx tsx tools/audio-unlock.ts [url] [--maps MP2,MP6] [--channel chrome]
 */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {} from '../packages/viewer/src/hook';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const BASE = args[0] && !args[0].startsWith('--') ? args[0] : 'http://localhost:5208/';
const index = JSON.parse(readFileSync(fileURLToPath(new URL('../public/maps/index.json', import.meta.url)), 'utf8')) as { maps: { archive: string }[] };
const MAPS = opt('--maps')?.split(',') ?? index.maps.map((m) => m.archive);

const REC = `window.__fr = []; window.__last = 0; requestAnimationFrame(function f(t) { window.__fr.push([t, t - window.__last]); window.__last = t; requestAnimationFrame(f); });`;
const channel = opt('--channel') ?? 'chrome';
const browser = await chromium.launch({ ...(channel === 'headless-shell' ? {} : { channel }), args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const rows: string[] = [];
try {
  for (const map of MAPS) {
    for (const when of ['at scene ready', 'banks in + 2 s'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.addInitScript(REC);
      await page.goto(`${BASE}?map=${map}&redotcom`);
      await page.waitForFunction(() => document.getElementById('loading')?.hidden === true && (window.__viewer?.stats().collisionPolys ?? 0) > 0, undefined, { timeout: 180_000 });
      if (when !== 'at scene ready') {
        await page.waitForFunction(() => window.__viewer.audio().banks.length > 0, undefined, { timeout: 60_000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
      }
      const pre = await page.evaluate(() => { const a = window.__viewer.audio(); return { banks: a.banks.length, decoded: a.decoded }; });
      const tClick = await page.evaluate(() => performance.now());
      await page.mouse.click(640, 360);
      await page.waitForTimeout(600);
      const post = await page.evaluate((tc) => {
        const a = window.__viewer.audio();
        const fr = (window as unknown as { __fr: [number, number][] }).__fr.filter(([t]) => t > tc && t < tc + 500);
        return { unlockMs: a.timing.unlockMs, state: a.state, frameMax: Math.max(0, ...fr.map(([, d]) => d)) };
      }, tClick);
      rows.push(`${map.padEnd(5)} ${when.padEnd(15)} banks-before ${String(pre.banks).padStart(2)} unlock ${post.unlockMs.toFixed(2).padStart(8)} ms  state ${post.state.padEnd(8)} click-frame max ${post.frameMax.toFixed(1)} ms`);
      console.log(rows[rows.length - 1]);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
