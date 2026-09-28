import { describe, expect, it } from 'vitest';
import { fixture } from '../../archive/test/fixtures';
import { CONSOLE, consoleMoveStick, lightByte } from '../../../tools/feel/console';
import { fitHold, parseRows, parseSchedule, type Row } from '../../../tools/feel/fit';
import { feelTable, formatTable, sealSpeedRows, type FeelRow } from '../../../tools/feel/harness';
import { FeelRig } from '../../../tools/feel/rig';
import { moveStick } from '../src/moveStick';

/**
 * The feel-parity table (web research 88, `tools/feel-parity.ts`): the viewer's whole walk driven through scripted
 * inputs and read against the console's numbers. The rows this workstream owns -- the mover and the camera's geometry
 * -- must be within their tolerance; every other row must be within its tolerance too, or be one of the divergences
 * research 88 reports to its owner (`REPORTED`), so a new divergence anywhere fails here and a fixed one is noticed.
 */

/** Research 88 section 2's divergences owned elsewhere, by row id: each is the owner's to close. */
const REPORTED = new Set([
  'look.axis176',        // look: a single-byte edge of the dead zone (research 83 section 1's "one miss")
  'look.turn1s@30',      // look: the law runs per display frame; the console's 60 Hz staircase turns 1 deg less at 30 fps
  'look.turn1s@144',     // look: ... and 0.6 deg more at 144 fps
  'look.corner',         // look / pad: ./gamepad clamps the pair to the rim before the law's circle
  'cam.hfov169',         // presentation: the native view widens the horizontal angle with the window
  'jump.rise',           // motion: the jump is the clip's root, not jumpImpulse's placeholder
  'jump.apex',           // motion: ... and tops at 0.66 s, not 0.28
  'cam.runTarget',       // motion (the camera's root input): the run's root is 10.305, the target 20.3 not 21.5
  'cam.proneRoot',       // motion (the camera's root input): seal_prone's root is 2.168, not the 1.8 estimate
  'anim.strafeFactor',   // motion: a full strafe plays seal_run_90r, not seal_rstrafe at the 3x cap
]);

const pack = fixture('RUN/MOTION_P.ZAR'), readerc = fixture('RUN/READERC.ZAR');

describe('the feel-parity table', () => {
  let rows: FeelRow[] = [];

  it('builds, every row with a console source and a number from the viewer', () => {
    rows = feelTable(pack && readerc ? { pack, readerc } : null);
    console.log(formatTable(rows));
    expect(rows.length).toBeGreaterThanOrEqual(pack && readerc ? 55 : 48);
    for (const r of rows) {
      expect(r.source.length, r.id).toBeGreaterThan(10);
      expect(Number.isFinite(r.viewer), r.id).toBe(true);
    }
  }, 180_000);

  it('the mover and the camera\'s geometry are within tolerance of the console', () => {
    const mine = rows.filter((r) => r.owner === 'mover' || r.owner === 'camera');
    expect(mine.length).toBeGreaterThan(30);
    for (const r of mine) expect(r.pass, `${r.id}: console ${r.console}, viewer ${r.viewer}`).toBe(true);
  });

  it('every other divergence is one research 88 reports to its owner, and nothing unreported diverges', () => {
    const diverging = rows.filter((r) => !r.pass).map((r) => r.id);
    for (const id of diverging) expect(REPORTED.has(id), `${id} diverges and is not in research 88's list`).toBe(true);
  });
});

describe('the fitter (a port of seal_speed_fit.py\'s core)', () => {
  it('reads the probe\'s rows and schedule, and fits the viewer\'s own run: 65, t90 on the 0.18 s ramp', () => {
    const rig = new FeelRig('stand');
    const rest = rig.run(1);
    const run = rig.hold(4, { keys: ['KeyW'] });
    const text = ['# seal_speed_probe revision=r0001', '# guest_t x y z root_y move_scale host_t',
      ...[...rest, ...run].map((s) => `${s.t.toFixed(6)} ${s.feet[0].toFixed(4)} ${s.feet[1].toFixed(4)} ${s.feet[2].toFixed(4)} ${s.camera.rootY.toFixed(4)} 1.000000 0.000`)].join('\n');
    const rows = parseRows(text);
    expect(rows.length).toBe(rest.length + run.length);
    const t0 = rest[rest.length - 1]!.t;
    const [hold] = parseSchedule(JSON.stringify([
      { name: 'rest0', kind: 'rest', t_start: 0, t_end: t0 },
      { name: 'fwd#1', kind: 'hold', buttons: ['W'], t_start: t0, t_end: t0 + 4, stance: 'stand', direction: 'fwd' },
    ]));
    expect(hold).toMatchObject({ name: 'fwd#1', group: 'fwd', stance: 'stand', buttons: ['W'] });
    const fit = fitHold(rows, hold!);
    expect(fit.status).toBe('OK');
    expect(fit.speed).toBeCloseTo(65, 2);
    expect(fit.t90).toBeGreaterThan(0.15);
    expect(fit.t90).toBeLessThan(0.2);
    expect(fit.rootYRest).toBeCloseTo(11.484, 3);
    // A row whose MoveScale is not 1 rejects the hold (research 18 section 3.13).
    const stalled: Row[] = rows.map((r, i) => (i === rows.length - 5 ? { ...r, moveScale: 0.5 } : r));
    expect(fitHold(stalled, hold!).status).toMatch(/^REJECTED/);
  });

  it('replays a console run hold by hold: a synthetic console at the decompilation\'s law reads back as the viewer', () => {
    // A console that runs the law exactly: 60 rows a second, the stick 5 a second to full, 65 forward along -z.
    const lines: string[] = [];
    let z = 0;
    for (let n = 0; n <= 60 * 5; n++) {
      const t = n / 60;
      if (t > 1) z -= Math.min(1, Math.round((t - 1) * 60) * 5 / 60) * 65 / 60;
      lines.push(`${t.toFixed(6)} 0 0 ${z.toFixed(4)} 11.484 1`);
    }
    const holds = parseSchedule(JSON.stringify([{ name: 'fwd#1', kind: 'hold', buttons: ['W'], t_start: 1, t_end: 5, stance: 'stand' }]));
    const table = sealSpeedRows(parseRows(lines.join('\n')), holds);
    expect(table.map((r) => r.id)).toEqual(['r79.fwd#1.speed', 'r79.fwd#1.t90', 'r79.fwd#1.root']);
    for (const r of table) expect(r.pass, `${r.id}: console ${r.console}, viewer ${r.viewer}`).toBe(true);
  });
});

describe('the console side of the table', () => {
  it('the harness\'s own copy of the move stick is the viewer\'s law, and the spawn camera reads off the logs', () => {
    for (const v of [0, 0.2, 0.31, 0.498, 0.6, 0.749, 0.795, 1]) {
      expect(consoleMoveStick(0, v)[1]).toBeCloseTo(moveStick(0, v)[1], 12);
      expect(consoleMoveStick(v, v)).toEqual(moveStick(v, v));
    }
    expect(lightByte(0.5)).toEqual({ byte: 64, value: (127.5 - 64) * 0.007843138 });
    expect(lightByte(0.75).byte).toBe(32);
    expect(CONSOLE.spawnEyeUp.value).toBeCloseTo(19.603, 3);          // research 17 section 1: 19.603 up
    expect(CONSOLE.spawnEyeBehind.value).toBeCloseTo(24.906, 3);      // and 24.906 behind
    expect(CONSOLE.vfovDeg.value).toBeCloseTo(49, 1);                 // the map's authored 24.5-degree half-angle
    expect(CONSOLE.hfovDeg.value).toBeCloseTo(70, 1);
  });
});
