import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const path of ['/', '/story.html']) {
  test.describe(`the page ${path}`, () => {
    test('never scrolls sideways, never asks Google, matches its golden on Windows', async ({ page }, info) => {
      const google: string[] = [];
      page.on('request', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) google.push(r.url()); });
      await page.goto(path);
      // the hero's video loop is a different frame on every run: hidden for the golden rather than masked, so the
      // hero title and the wheel over it stay in the picture
      await page.addStyleTag({ content: '#bg { visibility: hidden; }' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      const width = info.project.use.viewport!.width;
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(google).toEqual([]);
      test.skip(process.platform !== 'win32', 'goldens are cut on Windows');
      await expect(page).toHaveScreenshot(`${path === '/' ? 'home' : 'story'}-${width}.png`, { fullPage: true, maxDiffPixelRatio: 0.002, animations: 'disabled', mask: [page.locator('#stats-status'), page.locator('#stats-games'), page.locator('#stats-players'), page.locator('#stats-updated'), page.locator('#hero-status'), page.locator('#foot-fine')] });
    });
    test('has no serious or critical accessibility violation', async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    });
  });
}

test('the home page: the sound button draws the cross until pressed, then the waves', async ({ page }) => {
  // only the drawing is asserted: the autoplay policy may keep the audio itself muted
  await page.goto('/');
  await expect(page.locator('#sound .x')).toBeVisible();
  await expect(page.locator('#sound .wave')).toBeHidden();
  await page.locator('#sound').click();
  await expect(page.locator('#sound .wave')).toBeVisible();
  await expect(page.locator('#sound .x')).toBeHidden();
});

test('the home page: the current nav link lights, the bar toggles solid, the tiles load', async ({ page }) => {
  await page.goto('/#server');
  await page.waitForTimeout(600);
  await expect(page.locator('.s2u-bar__nav a.is-on')).toHaveAttribute('href', '#server');
  await expect(page.locator('#bar')).toHaveClass(/is-solid/);
  await expect(page.locator('#story-latest .s2u-tile')).toHaveCount(4, { timeout: 8000 });
  // the server section lights at least one stat tile (the live value is masked in the golden, so it is asserted here)
  await expect(page.locator('#stats-status .s2u-stat')).not.toHaveCount(0, { timeout: 8000 });
});
