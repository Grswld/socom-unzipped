// The goldens (goldens/gallery-{width}-win32.png) were cut on Windows 11 with Chromium on 2026-09-27; the compare runs only there.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('the design system gallery', () => {
  test('matches its golden, never scrolls sideways, never asks Google for a font', async ({ page }, info) => {
    const google: string[] = [];
    page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) google.push(r.url()); });
    await page.goto('/ds/');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('#typed-text')).toHaveText(/Sesseri Syndicate\.$/, { timeout: 8000 }); // the typed panel finishes
    const width = info.project.use.viewport!.width;
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scroll').toBeLessThanOrEqual(width);
    expect(google, 'no request to Google Fonts').toEqual([]);
    test.skip(process.platform !== 'win32', 'goldens are cut on Windows; the Ubuntu runner rasterises text differently');
    await expect(page).toHaveScreenshot(`gallery-${width}.png`, { fullPage: true, maxDiffPixelRatio: 0.002, animations: 'disabled' });
  });

  test('has no serious or critical accessibility violation', async ({ page }) => {
    await page.goto('/ds/');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  test('every control takes the cyan focus ring, the tile on its box', async ({ page }) => {
    await page.goto('/ds/#controls');
    const first = page.locator('#controls a.s2u-tab').first();
    await first.focus();
    expect(await first.evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(95, 179, 191)');
    const tileLink = page.locator('.s2u-tile h3 a').first();
    await tileLink.focus();
    expect(await tileLink.evaluate((el) => getComputedStyle(el.closest('.s2u-tile')!).outlineColor)).toBe('rgb(95, 179, 191)');
  });

  test('the CRT toggle adds and removes the scanlines', async ({ page }) => {
    await page.goto('/ds/');
    await expect(page.locator('.s2u-scan')).toBeHidden();
    await page.locator('#crt').check();
    await expect(page.locator('.s2u-scan')).toBeVisible();
    await page.locator('#crt').uncheck();
    await expect(page.locator('.s2u-scan')).toBeHidden();
  });

  test('the contrast readout shows every pair passing', async ({ page }) => {
    await page.goto('/ds/');
    await expect(page.locator('#contrast tr[data-pair]')).toHaveCount(44);
    await expect(page.locator('#contrast tr[data-pass="false"]')).toHaveCount(0);
  });

  test('the briefing grid lines DEPLOY up with the panel image', async ({ page }, info) => {
    test.skip(info.project.name === 'phone', 'the push is dropped under 720px by design');
    await page.goto('/ds/#briefing');
    // both boxes in one frame: two boundingBox() calls straddle the smooth scroll to #briefing and read apart
    const gap = await page.evaluate(() => {
      const deploy = [...document.querySelectorAll('.s2u-briefing__tabs-end .s2u-tab')].at(-1)!.getBoundingClientRect();
      const image = document.querySelector('.s2u-briefing__panel .s2u-panel--image')!.getBoundingClientRect();
      return Math.abs(deploy.bottom - image.bottom);
    });
    expect(gap).toBeLessThanOrEqual(1);
  });
});
