/**
 * Opens the viewer and prints whatever the page complains about: uncaught errors, console errors, and
 * the status line it settles on. The quickest way to tell a blank canvas caused by a module-level throw
 * from one caused by a decode failure.
 *
 *   npx tsx tools/page-errors.ts          # against the dev server
 *   VIEWER_URL=... npx tsx tools/page-errors.ts
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => console.log(`console.${m.type()}:`, m.text()));
await page.goto(process.env.VIEWER_URL ?? 'http://localhost:5173/');
await page.waitForTimeout(6000);
console.log('status text:', await page.locator('#status').textContent());
await browser.close();
