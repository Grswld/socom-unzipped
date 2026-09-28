/**
 * The walk's feel against the console, number by number (web research 88): scripted inputs through the viewer's
 * whole walk -- the keys and the pad into the fly camera, the look law, the mover's 60 Hz ticks, the game's camera --
 * compared with what the console recorded (`tools/feel/console.ts`, every value with its log line or note), as a
 * markdown table: quantity, console, viewer, error, and who owns a divergence.
 *
 *   npx tsx tools/feel-parity.ts                           # headless: the synthetic world, the fixtures' clips if extracted
 *   npx tsx tools/feel-parity.ts --json feel.json          # the rows as JSON too
 *   npx tsx tools/feel-parity.ts --browser [url]           # also the page on Frostfire through window.__viewer
 *                                                          #   (default http://localhost:5192/?redotcom; start the dev server)
 *   npx tsx tools/feel-parity.ts --seal-speed <rows.txt> <schedule.json>
 *                                                          # research 79's console run, every hold replayed on the viewer
 *                                                          #   and both fitted by one fitter (tools/feel/fit.ts)
 *
 * Exit status 1 when a row this workstream owns (the mover, the camera's geometry) diverges; the others are reported.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture } from '../packages/archive/test/fixtures';
import { browserRows } from './feel/browser';
import { parseRows, parseSchedule } from './feel/fit';
import { feelTable, formatTable, sealSpeedRows, type FeelRow } from './feel/harness';

const args = process.argv.slice(2);
const flag = (name: string): number => args.indexOf(name);

const pack = fixture('RUN/MOTION_P.ZAR'), readerc = fixture('RUN/READERC.ZAR');
const rows: FeelRow[] = feelTable(pack && readerc ? { pack, readerc } : null);
if (!pack || !readerc) console.error('feel-parity: MOTION_P.ZAR / READERC.ZAR not in web/test-fixtures: the motion rows are left out');

const seal = flag('--seal-speed');
if (seal >= 0) {
  const [rowsPath, schedulePath] = [args[seal + 1], args[seal + 2]];
  if (!rowsPath || !schedulePath) throw new Error('--seal-speed <rows.txt> <schedule.json>');
  rows.push(...sealSpeedRows(parseRows(readFileSync(rowsPath, 'utf8')), parseSchedule(readFileSync(schedulePath, 'utf8'))));
}

const page = flag('--browser');
if (page >= 0) {
  const next = args[page + 1];
  rows.push(...await browserRows(next && !next.startsWith('--') ? next : 'http://localhost:5192/?redotcom'));
}

console.log(formatTable(rows));
const json = flag('--json');
if (json >= 0 && args[json + 1]) writeFileSync(args[json + 1]!, JSON.stringify(rows, null, 2));

const mine = rows.filter((r) => !r.pass && (r.owner === 'mover' || r.owner === 'camera'));
const others = rows.filter((r) => !r.pass && r.owner !== 'mover' && r.owner !== 'camera');
console.error(`feel-parity: ${rows.length} rows, ${rows.filter((r) => r.pass).length} within tolerance; `
  + `${mine.length} divergent in the mover/camera, ${others.length} reported to their owners (${[...new Set(others.map((r) => r.owner))].join(', ') || 'none'})`);
process.exitCode = mine.length ? 1 : 0;
