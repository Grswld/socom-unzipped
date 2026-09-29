import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';

/**
 * The page's chrome (owner, 2026-09-28): the settings panel starts folded and the cog beside GitHub opens it; the bar's
 * tabs are one size; the Fly / Walk switch is the Modern / PS2 switch's own markup; the Controls popover names the
 * current mode's controls; and the play (walk, the SEAL, the touch stance and fire) exists only behind `?redotcom&fly`.
 *
 * A clean context: none of the specs' remembered "panel open" (`playwright.config.ts`), so the first-visit default shows.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const loaded = async (page: Page, query = ''): Promise<void> => {
  await page.goto(query ? `/${query}&devmode` : '/?devmode');   // the served maps: the developer's switch (`./src/source.ts`)
  await expect(page.locator('#status')).toContainText(/triangles|tris/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
};

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

test('a first visit has the settings folded; the cog beside GitHub opens and folds them', async ({ page }) => {
  await loaded(page);
  const cog = page.locator('#panel-toggle');
  await expect(page.locator('#panel')).toBeHidden();
  await expect(cog).toHaveAttribute('aria-expanded', 'false');
  await expect(cog).toHaveAttribute('aria-controls', 'panel-body');
  await expect(cog).toHaveAttribute('title', /^show the settings/);
  // The map is on screen and the loading state is not stuck: the page is a canvas and a bar.
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#status')).toContainText('FROSTFIRE');           // the text is there, the panel just does not show it
  // Beside GitHub: the same row, cog directly before the link.
  const [c, g] = [await box(page, '#panel-toggle'), await box(page, '#source')];
  expect(Math.abs(c.y - g.y)).toBeLessThan(1);
  expect(g.x - (c.x + c.width)).toBeGreaterThan(0);
  expect(g.x - (c.x + c.width)).toBeLessThan(16);
  await cog.click();
  await expect(page.locator('#panel')).toBeVisible();
  await expect(cog).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#maps')).toBeVisible();
  await cog.click();
  await expect(page.locator('#panel')).toBeHidden();
  await expect(cog).toHaveAttribute('aria-expanded', 'false');
});

test('the bar tabs share one height, one padding and one gap, at a desktop width and at 375px', async ({ browser }) => {
  for (const [width, height, touch] of [[1280, 800, false], [375, 700, true]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch });
    const page = await ctx.newPage();
    await page.goto('/?devmode');
    const [ctl, cog, git, home] = [await box(page, '#controls-toggle'), await box(page, '#panel-toggle'), await box(page, '#source'), await box(page, '#home')];
    for (const b of [cog, git]) {
      expect(Math.round(b.height), `${width}px height`).toBe(Math.round(ctl.height));
      expect(Math.abs(b.y - ctl.y), `${width}px row`).toBeLessThan(1);
    }
    // One gap between neighbours.
    expect(Math.round(cog.x - (ctl.x + ctl.width))).toBe(Math.round(git.x - (cog.x + cog.width)));
    // The brand is on the tabs' centre line.
    expect(Math.abs((home.y + home.height / 2) - (ctl.y + ctl.height / 2))).toBeLessThan(1.5);
    // The tabs sit inside the bar.
    const bar = await box(page, '#site-links');
    expect(git.x + git.width).toBeLessThanOrEqual(bar.x + bar.width);
    // Under 480px each is its mark alone, and the same size.
    if (width < 480) {
      expect(Math.round(ctl.width)).toBe(Math.round(cog.width));
      expect(Math.round(cog.width)).toBe(Math.round(git.width));
      await expect(page.locator('#controls-word')).toBeHidden();
    } else {
      await expect(page.locator('#controls-word')).toBeVisible();
    }
    // The frame counter clears the bar.
    const fps = await box(page, '#fps');
    expect(fps.x).toBeGreaterThanOrEqual(bar.x + bar.width);
    await ctx.close();
  }
});

test('without ?redotcom there is no walking anywhere on the page', async ({ page }) => {
  await loaded(page);
  for (const id of ['mode', 'walk', 'body-row', 'player-body', 'ammo', 'touch-stance', 'touch-fire', 'sound-section', 'look-section', 'mute', 'volume', 'mouselaw', 'sensitivity']) await expect(page.locator(`#${id}`)).toHaveCount(0);
  // G does nothing, and the hook cannot walk.
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(false);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  // Open everything the page has and read all of it.
  await page.locator('#panel-toggle').click();
  await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
  await page.locator('#controls-toggle').click();
  await expect(page.locator('#controls')).toBeVisible();
  await expect(page.locator('#keys-list')).toContainText('W A S Dfly');
  await expect(page.locator('#keys-list')).not.toContainText(/walk|jump|stance|fire|reload|peek|zoom/i);
  await expect(page.locator('#hint')).not.toContainText(/walk/i);
  const text = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll('[title],[aria-label]')]
    .map((e) => `${e.getAttribute('title')} ${e.getAttribute('aria-label')}`).join(' '));
  expect(text).not.toMatch(/\b(walk\w*|stance|crouch\w*|prone)\b/i);
  // "redotcom" is the project's name (the owner's), no longer the walk flag's word: the kicker says it on every page,
  // the fly-only one included (index.html:83; the unit twin is test/modes.test.ts). Never flip it back (b1eb349b).
  await expect(page.locator('#panel-kicker')).toHaveText('redotcom · SOCOM II multiplayer');
});

test.describe('with ?redotcom&fly', () => {
  test('the Fly / Walk switch is the Modern / PS2 switch\'s own markup, and the two look alike', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    await page.locator('#panel-toggle').click();
    const look = page.locator('#look'), mode = page.locator('#mode');
    await expect(mode).toBeVisible();
    expect(await mode.evaluate((el) => el.className)).toBe(await look.evaluate((el) => el.className));
    expect(await mode.locator('button').evaluateAll((els) => els.map((e) => e.className))).toEqual(
      await look.locator('button').evaluateAll((els) => els.map((e) => e.className)));
    expect(await mode.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await look.evaluate((el) => getComputedStyle(el).backgroundColor));
    // The chosen segment is filled, the other is not.
    const fill = (selector: string): Promise<string> => page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill('#mode button[data-mode="fly"]')).not.toBe(await fill('#mode button[data-mode="walk"]'));
    expect(await fill('#look button[data-look="modern"]')).not.toBe(await fill('#look button[data-look="ps2"]'));
    // Keyboard focus shows a ring.
    await page.locator('#mode button[data-mode="walk"]').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await page.locator('#mode button[data-mode="walk"]').evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  });

  test('the Controls popover opens on hover and on click, lists the mode you are in, and Esc closes it', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    const tab = page.locator('#controls-toggle'), pop = page.locator('#controls'), hint = page.locator('#keys-list');
    await expect(pop).toBeHidden();
    await expect(tab).toHaveAttribute('aria-haspopup', 'dialog');
    await tab.hover();
    await expect(pop).toBeVisible();
    await expect(tab).toHaveAttribute('aria-expanded', 'true');
    await expect(hint).toContainText('Double-tap W');
    await expect(hint).toContainText('walk');
    await expect(hint).not.toContainText('jump');
    // The mode changes under an open popover: the list follows.
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect(hint).toContainText('jump');
    await expect(hint).toContainText('Right click');
    for (const group of ['Move', 'Combat', 'Stance & action', 'Weapons']) await expect(hint.locator('.pad-group', { hasText: group })).toHaveCount(1);
    await expect(hint).not.toContainText('Double-tap W');
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();
    await expect(tab).toHaveAttribute('aria-expanded', 'false');
    // Away from the tab it stays shut; a click pins it; a click on the map lets it go.
    await page.mouse.move(700, 500);
    await expect(pop).toBeHidden();
    await tab.click();
    await page.mouse.move(700, 500);
    await page.waitForTimeout(400);
    await expect(pop).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(pop).toBeHidden();
  });

  test('the Controls popover has two tabs, Controller and Mouse & Keyboard, player words only, and remembers the one chosen', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    await page.locator('#controls-toggle').click();
    const padTab = page.locator('#controls-tab-pad'), keysTab = page.locator('#controls-tab-keys');
    await expect(padTab).toHaveText('Controller');
    await expect(keysTab).toHaveText('Mouse & Keyboard');
    await expect(keysTab).toHaveAttribute('aria-selected', 'true');             // no pad: Mouse & Keyboard first
    await expect(page.locator('#keys-list')).toBeVisible();
    await expect(page.locator('#pad-list')).toBeHidden();
    await padTab.click();
    await expect(page.locator('#pad-list')).toBeVisible();
    await expect(page.locator('#keys-list')).toBeHidden();
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect(page.locator('#pad-list')).toContainText('R3reload');
    const words = await page.locator('#controls').innerText();
    expect(words).not.toMatch(/research|decomp|FUN_|0x|\.md|stub|reading|assumed|placeholder|owner|debug/i);
    await page.reload();
    await expect(page.locator('#status')).toContainText('triangles');
    await page.locator('#controls-toggle').click();
    await expect(page.locator('#controls-tab-pad')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#pad-list')).toBeVisible();
  });

  test('a key pressed with the Controls tab focused still reaches the game, and the popover took no focus', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    await page.locator('#controls-toggle').hover();
    await expect(page.locator('#controls')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement?.id !== 'controls')).toBe(true);
    await page.keyboard.press('KeyG');                                          // G is the walk's, wherever the focus is
    expect(await page.evaluate(() => window.__viewer.mode())).toBe('walk');
    await page.keyboard.press('KeyG');
    expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  });

  test('the Sound and Mouse look sections drive the audio and the look, and are remembered', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#sound-section')).toBeVisible();
    await expect(page.locator('#look-section')).toBeVisible();
    expect(await page.evaluate(() => window.__viewer.audio().volume)).toBe(1);
    expect(await page.evaluate(() => window.__viewer.audio().muted)).toBe(false);
    // Sound: the slider is the mix's volume, the switch its mute.
    await page.locator('#volume').fill('0.5');
    await expect(page.locator('#volume-out')).toHaveText('50%');
    expect(await page.evaluate(() => window.__viewer.audio().volume)).toBe(0.5);
    await page.locator('#mute').setChecked(true);
    expect(await page.evaluate(() => window.__viewer.audio().muted)).toBe(true);
    // Mouse look: the law, the sensitivity, the pitch.
    const look = (): Promise<Record<string, unknown>> => page.evaluate(() => ({ ...window.__viewer.setLook({}) }));
    expect(await look()).toMatchObject({ mouse: 'raw', sensitivity: 1, pitchRatio: 'game', invertPitch: false });
    await page.locator('#mouselaw button[data-law="stick"]').click();
    await page.locator('#sensitivity').fill('2');
    await page.locator('#invertpitch').setChecked(true);
    await page.locator('#uniformpitch').setChecked(true);
    expect(await look()).toMatchObject({ mouse: 'stick', sensitivity: 2, pitchRatio: 'uniform', invertPitch: true });
    // Reloaded, the same page comes back as it was left, in the panel and in the game.
    await page.reload();
    await expect(page.locator('#status')).toContainText(/triangles|tris/);
    expect(await page.evaluate(() => window.__viewer.audio())).toMatchObject({ volume: 0.5, muted: true });
    expect(await look()).toMatchObject({ mouse: 'stick', sensitivity: 2, pitchRatio: 'uniform', invertPitch: true });
    await page.locator('#panel-toggle').click();
    await expect(page.locator('#mute')).toBeChecked();
    await expect(page.locator('#volume')).toHaveValue('0.5');
    await expect(page.locator('#mouselaw button[data-law="stick"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('while walking the fullscreen button leaves the bottom-right corner of the HUD (the range readout) for the left edge', async ({ page }) => {
    await loaded(page, '?redotcom&fly');
    const flying = (await page.locator('#fullscreen').boundingBox())!;
    const size = page.viewportSize()!;
    expect(flying.x).toBeGreaterThan(size.width / 2);
    expect(flying.y).toBeGreaterThan(size.height / 2);                            // flying: its old corner, bottom right
    await page.evaluate(() => window.__viewer.setMode('walk'));
    await expect.poll(async () => (await page.locator('#fullscreen').boundingBox())!.x).toBeLessThan(60);
    const walking = (await page.locator('#fullscreen').boundingBox())!;
    expect(walking.y + walking.height).toBeLessThan(size.height / 2);             // and clear of the bottom strip at any height
    await page.evaluate(() => window.__viewer.setMode('fly'));
    await expect.poll(async () => (await page.locator('#fullscreen').boundingBox())!.x).toBeGreaterThan(size.width / 2);
  });
});
