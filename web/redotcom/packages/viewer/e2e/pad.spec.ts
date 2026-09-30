import { expect, test, type Page } from '@playwright/test';
// `src/hook.ts` is types only; its `declare global` is what makes `window.__viewer` exist inside `page.evaluate`.
import type {} from '../src/hook';
import { shortTurn } from '../src/yaw';

/**
 * The controller on Frostfire (web sprint 2, W2.7; ruling W2.R5; the owner's layout of 2026-09-28): a fake
 * `navigator.getGamepads` hands the page one pad in the standard mapping (W3C Gamepad, "Remapping"), which the test
 * plugs in, pushes and unplugs. The toast names it, the layout table appears with the flying controls only (the walking
 * ones once walking), the left stick walks the mover and flies the camera, Square is the jump on foot and up in the
 * air, R1 fires, Triangle is the stance (a tap crouches, a hold goes prone, a tap from prone stands), d-pad Up is the
 * scope's lane, Start is `G`, the right stick looks. The page is loaded with `?mode=play&fly`, which walking needs.
 *
 * Held inputs are held for real time, as `walk.spec.ts` holds W: the mover's distance then depends on the host's frame
 * rate, so the checks are that it moved, the right way and on the right floor, not how far.
 */

/** The fake: a `Gamepad`'s shape, 17 buttons and 4 axes, at rest. */
interface FakePad {
  id: string; index: number; connected: boolean; mapping: string; timestamp: number;
  axes: number[]; buttons: { pressed: boolean; touched: boolean; value: number }[];
}
type FakeWindow = Window & { __fakePad: FakePad };

const PAD_ID = 'Test pad (STANDARD GAMEPAD)';
/** The standard mapping's indices the test presses (`src/gamepad.ts`, `PAD_BUTTON`). */
const SQUARE = 2, TRIANGLE = 3, R1 = 5, START = 9, DPAD_UP = 12;

/** A's spawn on Frostfire (KNOWN section 1), the feet, and the eye 15.4 over them (W1.R2), as `walk.spec.ts` has them. */
const SPAWN_A: [number, number, number] = [796, 100, 614];
const EYE = 15.4;
/** Facing research 24 section 6.1's first waypoint, (806, 665), from A: the floor at 100 runs all the way. */
const YAW_TO_1 = Math.atan2(-(806 - 796), -(665 - 614)) * 180 / Math.PI;

/** Puts the pad's sticks and buttons where the test wants them; anything not named is at rest. */
const setPad = (page: Page, state: { axes?: number[]; press?: number[] }): Promise<void> => page.evaluate(({ axes, press }) => {
  const pad = (window as unknown as FakeWindow).__fakePad;
  pad.axes = axes ?? [0, 0, 0, 0];
  pad.buttons.forEach((b, i) => {
    const on = press?.includes(i) ?? false;
    b.pressed = on; b.touched = on; b.value = on ? 1 : 0;
  });
  pad.timestamp = performance.now();
}, state);

/**
 * Plugs the pad in or out, and says so the way a browser does. A `GamepadEvent` cannot be built around a fake (its
 * constructor wants a real `Gamepad`), so the event is a plain one carrying the pad as its `gamepad`.
 */
const plug = (page: Page, on: boolean): Promise<void> => page.evaluate((connected) => {
  const pad = (window as unknown as FakeWindow).__fakePad;
  pad.connected = connected;
  const e = new Event(connected ? 'gamepadconnected' : 'gamepaddisconnected');
  Object.defineProperty(e, 'gamepad', { value: pad });
  window.dispatchEvent(e);
}, on);

const pose = (page: Page) => page.evaluate(() => window.__viewer.pose());
const feet = (page: Page) => page.evaluate(() => window.__viewer.feet());
/** The Controller list's row whose key cell reads exactly `keys` (a glyph row's cell holds the svg and the name). */
const padRow = (page: Page, keys: string) => page.locator('#pad-list tbody tr:not(.pad-group)')
  .filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${keys}$`) }) });

test('a pad on the PS2 layout: the toast, the layout, the walk and the fly camera (W2.7)', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && /GL_INVALID|WebGPU.*(error|fail)/i.test(m.text()))) {
      problems.push(`console: ${m.text()}`);
    }
  });

  // The fake, before the page's own script runs: unplugged, so `getGamepads` lists nothing until the test plugs it in.
  await page.addInitScript((id) => {
    const pad = {
      id, index: 0, connected: false, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { __fakePad: typeof pad }).__fakePad = pad;
    Object.defineProperty(Navigator.prototype, 'getGamepads', {
      configurable: true,
      value: () => [pad.connected ? pad : null, null, null, null],
    });
  }, PAD_ID);

  await page.goto('/?mode=play&fly&devmode');
  const status = page.locator('#status');
  await expect(status).toContainText('triangles');
  await page.locator('#maps').selectOption('RUN/MP2.ZDB');
  await expect(status).toContainText('FROSTFIRE (MP2)');
  await expect(status).toContainText('triangles');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Nothing plugged in: no toast, no layout, no pad.
  const toast = page.locator('#toast');
  await expect(toast).toBeHidden();
  await expect(page.locator('#pad-status')).toContainText('No controller connected');
  await expect(page.locator('#controls-pad')).toHaveJSProperty('hidden', true);          // the popover opens on Mouse & Keyboard
  expect(await page.evaluate(() => window.__viewer.pad().id)).toBeNull();

  // Plugged in: the toast names it, the Controls popover moves to its Controller tab (nothing chosen yet) with the flying
  // controls, and its status line says so.
  await plug(page, true);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText(`Controller connected: ${PAD_ID}`);
  await expect(page.locator('#pad-status')).toHaveText('Controller connected');
  await page.locator('#controls-toggle').hover();                              // the list lives in the Controls popover
  await expect(page.locator('#controls-pad')).toBeVisible();
  await expect(page.locator('#controls-tab-pad')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 500);
  // The flying controls: five flying rows, and (the play flag is on under ?fly&devmode) General's `Start = walk`
  // (`padControlGroups('fly', true)`, pinned in test/controlsTabs.test.ts).
  await expect(page.locator('#pad-list tbody tr:not(.pad-group)')).toHaveCount(6);
  await expect(padRow(page, 'Start').locator('td').nth(1)).toHaveText('walk');
  await expect(page.locator('#pad-list tbody')).toContainText('up');
  await expect(page.locator('#pad-list tbody')).not.toContainText('fire');
  expect(await page.evaluate(() => window.__viewer.pad().id)).toBe(PAD_ID);

  // Walk: the left stick held forward for a second walks the feet toward the first waypoint, on the floor at 100.
  expect(await page.evaluate(() => window.__viewer.setMode('walk'))).toBe(true);
  await page.evaluate(([x, y, z, eye, yaw]) => window.__viewer.setCamera({ x, y: y + eye, z, yaw, pitch: 0 }), [...SPAWN_A, EYE, YAW_TO_1] as const);
  const start = (await feet(page))!;
  expect(start).toEqual(SPAWN_A);
  await setPad(page, { axes: [0, -1, 0, 0] });
  await page.waitForTimeout(1000);
  expect((await page.evaluate(() => window.__viewer.pad().input)).moveY).toBe(1);
  await setPad(page, {});
  await page.waitForTimeout(600);                  // the glide runs out
  const walked = (await feet(page))!;
  expect(Math.hypot(walked[0] - start[0], walked[2] - start[2])).toBeGreaterThan(2);
  expect(walked[2]).toBeGreaterThan(start[2]);
  expect(walked[1]).toBeCloseTo(100, 3);

  // On foot the list names the walking controls: R1's fire, the zoom, R3's reload, the fire mode, Cross's action, the
  // d-pad's peek, the weapon slots (L1, L2, R2), Select's scoreboard, no boost.
  await expect(page.locator('#pad-list tbody tr:not(.pad-group)')).toHaveCount(15);
  await expect(page.locator('#pad-list tbody')).toContainText('scoreboard');
  await expect(page.locator('#pad-list tbody')).toContainText('action: doors, climb, ladders');
  await expect(page.locator('#pad-list tbody')).toContainText('R3reload');
  await expect(page.locator('#pad-list tbody')).toContainText('fire');
  await expect(page.locator('#pad-list tbody')).not.toContainText('boost');
  await expect(page.locator('#keys-list')).toContainText('Left clickfire');

  // L2 is the game's SwapWeapon2 -- the controller's slot 1.0, the kit's Mark 23 (WEAPON: `./kit`) -- and a second press
  // does nothing (no toggle back); R2 its Inventory, one slot a press (the rifle, the Mark 23, the throwables); L1 its
  // SwapWeapon1, the rifle.
  const item = (): Promise<string> => page.evaluate(() => (window.__viewer.grenade().equipped
    ? window.__viewer.grenade().item : window.__viewer.kit().swap?.to ?? window.__viewer.kit().item));
  const settled = (): Promise<boolean> => page.evaluate(() => window.__viewer.kit().swap === null);
  const tap = async (button: number, lane: 'swap1' | 'swap2' | 'inventory'): Promise<void> => {
    await setPad(page, { press: [button] });
    await expect.poll(() => page.evaluate((l) => window.__viewer.pad().input[l], lane)).toBe(true);
    await setPad(page, {});
    await expect.poll(() => page.evaluate((l) => window.__viewer.pad().input[l], lane)).toBe(false);
  };
  await tap(6, 'swap2');
  await expect.poll(item).toBe('pistol');
  await expect.poll(settled).toBe(true);                               // the swap's clip played out
  await tap(6, 'swap2');
  await expect.poll(item).toBe('pistol');                              // already in the hand: nothing
  await tap(4, 'swap1');
  await expect.poll(item).toBe('rifle');
  await expect.poll(settled).toBe(true);
  await tap(7, 'inventory');
  await expect.poll(item).toBe('pistol');
  await expect.poll(settled).toBe(true);
  await tap(7, 'inventory');
  await expect.poll(item).toBe('M67');
  await tap(7, 'inventory');
  await expect.poll(item).toBe('HE');
  for (const next of ['AN-M8', 'Mark141', 'Claymore', 'rifle']) {      // the smoke, the flashbang, the claymore, round
    await tap(7, 'inventory');
    await expect.poll(item).toBe(next);
  }
  await expect.poll(settled).toBe(true);

  // Square is the jump on foot (the mover's jump is W2.3a's): what reaches the page is the jump; Cross is the action
  // (web research 86), not a jump.
  await setPad(page, { press: [0] });
  await expect.poll(() => page.evaluate(() => window.__viewer.pad().input.action)).toBe(true);
  expect((await page.evaluate(() => window.__viewer.pad().input)).jump).toBe(false);
  await setPad(page, {});
  await page.waitForTimeout(200);
  await setPad(page, { press: [SQUARE] });
  await expect.poll(() => page.evaluate(() => window.__viewer.pad().input.jump)).toBe(true);
  await setPad(page, {});
  await expect.poll(() => page.evaluate(() => window.__viewer.pad().input.jump)).toBe(false);
  await page.waitForTimeout(1500);                 // the jump lands

  // R1 is the trigger: held, the rifle fires at its rate; let go, it stops.
  const shots = (): Promise<number> => page.evaluate(() => window.__viewer.fire().shots);
  const shotsBefore = await shots();
  await setPad(page, { press: [R1] });
  await expect.poll(shots).toBeGreaterThan(shotsBefore);
  await setPad(page, {});
  await page.waitForTimeout(200);
  const after = await shots();
  await page.waitForTimeout(400);
  expect(await shots()).toBe(after);

  // Triangle is the stance: a tap crouches, a tap again stands, a hold goes prone, a tap from prone stands.
  const stance = (): Promise<string> => page.evaluate(() => window.__viewer.stance());
  expect(await stance()).toBe('stand');
  await setPad(page, { press: [TRIANGLE] });
  await page.waitForTimeout(120);
  await setPad(page, {});
  await expect.poll(stance).toBe('crouch');
  await setPad(page, { press: [TRIANGLE] });
  await page.waitForTimeout(120);
  await setPad(page, {});
  await expect.poll(stance).toBe('stand');
  await setPad(page, { press: [TRIANGLE] });
  await expect.poll(stance, { timeout: 5000 }).toBe('prone');      // acts at the hold's threshold, button still down
  await setPad(page, {});
  await page.waitForTimeout(300);
  expect(await stance()).toBe('prone');                             // the release after a hold is not a tap
  await setPad(page, { press: [TRIANGLE] });
  await page.waitForTimeout(120);
  await setPad(page, {});
  await expect.poll(stance).toBe('stand');

  // D-pad Up is the scope's lane (the zoom itself is the accuracy workstream's).
  await setPad(page, { press: [DPAD_UP] });
  await expect.poll(() => page.evaluate(() => window.__viewer.pad().input.zoom)).toBe(true);
  await setPad(page, {});

  // Start is G: held across frames it toggles once, walk to fly, and the panel's switch follows.
  await setPad(page, { press: [START] });
  await expect.poll(() => page.evaluate(() => window.__viewer.mode())).toBe('fly');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__viewer.mode())).toBe('fly');
  await setPad(page, {});
  await expect(page.locator('#walk')).not.toBeChecked();
  await expect(page.locator('#mode button[data-mode="fly"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pad-list tbody tr:not(.pad-group)')).toHaveCount(6);           // and the list is the flying controls again
  await expect(padRow(page, 'Start').locator('td').nth(1)).toHaveText('walk');

  // Fly: the same stick flies along the look (yaw 0 looks down -z) and does not turn it.
  await page.evaluate(() => window.__viewer.setCamera({ x: 796, y: 160, z: 614, yaw: 0, pitch: 0 }));
  const before = await pose(page);
  await setPad(page, { axes: [0, -1, 0, 0] });
  await page.waitForTimeout(1000);
  await setPad(page, {});
  await page.waitForTimeout(600);
  const flown = await pose(page);
  expect(before.z - flown.z).toBeGreaterThan(5);
  expect(shortTurn(before.yaw, flown.yaw)).toBeCloseTo(0, 6);

  // Square is up in the air.
  await setPad(page, { press: [SQUARE] });
  await page.waitForTimeout(500);
  await setPad(page, {});
  await page.waitForTimeout(600);
  expect((await pose(page)).y - flown.y).toBeGreaterThan(5);

  // The right stick looks: pushed right, the view turns right (a smaller yaw, as the right arrow gives), and stops.
  const facing = await pose(page);
  await setPad(page, { axes: [0, 0, 1, 0] });
  await page.waitForTimeout(500);
  await setPad(page, {});
  const turned = await pose(page);
  expect(shortTurn(facing.yaw, turned.yaw)).toBeLessThan(-5);            // the yaw is stored in [0, 360): the turn, signed
  await page.waitForTimeout(300);
  expect(shortTurn(turned.yaw, (await pose(page)).yaw)).toBeCloseTo(0, 1);

  // Unplugged: the toast says so, once, and the status line lets it go.
  await plug(page, false);
  await expect(toast).toHaveText('Controller disconnected');
  await expect(toast).toBeVisible();
  await expect(page.locator('#pad-status')).toContainText('No controller connected');
  expect(await page.evaluate(() => window.__viewer.pad().id)).toBeNull();

  expect(problems).toEqual([]);
});
