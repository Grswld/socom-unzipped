/**
 * One fitter for both sides of the feel table: the console's rows (research 79's `seal_speed_probe` output) and the
 * viewer's own (the harness samples the mover a tick at a time). A port of the core of
 * `tools_py/parity/seal_speed_fit.py` -- the same rules, so a number the two sides disagree on is the game's and not
 * the fitters':
 *
 * - rows sharing a clock value collapse to the last read; a backwards row is dropped;
 * - a hold whose rows are not all MoveScale 1.0 is REJECTED (judged before the merge); under 1 s it is RAMPING;
 * - the steady speed is a least-squares line through x(t) and z(t) over the last 60 % of the hold's rows;
 * - t90 runs from the hold's start to the first row whose smoothed speed (a local line over +-2 rows) reaches 0.9 x
 *   steady and stays there on the next row, interpolated from the row before.
 */

/** One sampled row: the guest clock (seconds), the feet, the skeleton root's height, the movement scale. */
export interface Row { t: number; x: number; y: number; z: number; rootY: number; moveScale: number }

/** A hold of the schedule: its span on the same clock, and what the probe knew of it. */
export interface Hold {
  name: string; tStart: number; tEnd: number; group: string;
  stance?: string | null; direction?: string | null; push?: number | null; buttons?: string[];
}

export interface HoldFit {
  name: string; group: string; n: number;
  speed: number; vx: number; vz: number; headingDeg: number; residRms: number; t90: number; distance: number;
  rootYRest: number; status: string;
}

const STEADY_FRACTION = 0.6;
const SMOOTH_HALF = 2;
const RESOLVE_DT = 0.1;
const MIN_ROWS = 5;
const MIN_HOLD_S = 1;
const RAMP_MULTIPLE = 3;
const NOISY_ROWS = 1.5;
const NOISY_FLOOR = 0.1;

export const groupOf = (name: string): string => name.split('#', 1)[0]!;

/** The rows file `seal_speed_probe` writes: `guest_t x y z root_y move_scale host_t`, `#` comments. */
export function parseRows(text: string): Row[] {
  const out: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const p = s.split(/\s+/).slice(0, 6).map(Number);
    if (p.length < 6 || p.some((v) => !Number.isFinite(v))) continue;
    out.push({ t: p[0]!, x: p[1]!, y: p[2]!, z: p[3]!, rootY: p[4]!, moveScale: p[5]! });
  }
  return out;
}

/** The schedule JSON `seal_speed_probe` writes: the entries of kind `hold`. */
export function parseSchedule(json: string): Hold[] {
  const data = JSON.parse(json) as Record<string, unknown>[];
  return data.filter((e) => e['kind'] === 'hold').map((e) => ({
    name: String(e['name']), tStart: Number(e['t_start']), tEnd: Number(e['t_end']),
    group: typeof e['group'] === 'string' ? e['group'] : groupOf(String(e['name'])),
    stance: (e['stance'] as string | undefined) ?? null, direction: (e['direction'] as string | undefined) ?? null,
    push: typeof e['push'] === 'number' ? e['push'] : null,
    buttons: Array.isArray(e['buttons']) ? (e['buttons'] as unknown[]).map(String) : [],
  }));
}

export function dedupe(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && r.t === last.t) out[out.length - 1] = r;
    else if (!last || r.t > last.t) out.push(r);
  }
  return out;
}

function linfit(ts: readonly number[], vs: readonly number[]): [number, number] {
  const n = ts.length;
  const mt = ts.reduce((a, b) => a + b, 0) / n, mv = vs.reduce((a, b) => a + b, 0) / n;
  let stt = 0, stv = 0;
  for (let i = 0; i < n; i++) { stt += (ts[i]! - mt) ** 2; stv += (ts[i]! - mt) * (vs[i]! - mv); }
  if (stt === 0) return [0, mv];
  const a = stv / stt;
  return [a, mv - a * mt];
}

function median(vs: readonly number[]): number {
  const s = [...vs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const k = s.length >> 1;
  return s.length % 2 ? s[k]! : 0.5 * (s[k - 1]! + s[k]!);
}

function smoothedSpeed(rows: readonly Row[], i: number): number {
  const win = rows.slice(i - SMOOTH_HALF, i + SMOOTH_HALF + 1), ts = win.map((r) => r.t);
  return Math.hypot(linfit(ts, win.map((r) => r.x))[0], linfit(ts, win.map((r) => r.z))[0]);
}

function t90Of(rows: readonly Row[], hold: Hold, steady: number): number {
  if (!(steady > 1e-6)) return NaN;
  const idx = rows.flatMap((r, i) => (r.t >= hold.tStart && r.t <= hold.tEnd ? [i] : []));
  if (idx.length < 3) return NaN;
  if (median(idx.slice(0, -1).map((i) => rows[i + 1]!.t - rows[i]!.t)) > RESOLVE_DT) return NaN;
  const cand: number[] = [];
  for (let i = Math.max(SMOOTH_HALF, idx[0]! - SMOOTH_HALF); i < idx[idx.length - 1]!; i++) if (i + SMOOTH_HALF < rows.length) cand.push(i);
  const speeds = new Map(cand.map((i) => [i, smoothedSpeed(rows, i)] as const));
  const thr = 0.9 * steady;
  let prev: [number, number] | null = null;
  for (let k = 0; k < cand.length; k++) {
    const i = cand[k]!, v = speeds.get(i)!;
    const next = k + 1 < cand.length ? speeds.get(cand[k + 1]!)! : v;
    if (v >= thr && next >= thr) {
      if (!prev) return NaN;
      const [tp, vp] = prev, ti = rows[i]!.t;
      const tc = v === vp ? ti : tp + (ti - tp) * (thr - vp) / (v - vp);
      return Math.max(0, tc - hold.tStart);
    }
    prev = [rows[i]!.t, v];
  }
  return NaN;
}

/** One hold's fit over the rows (deduped here; MoveScale judged on the raw rows). */
export function fitHold(raw: readonly Row[], hold: Hold): HoldFit {
  const rows = dedupe(raw);
  const inside = rows.filter((r) => r.t >= hold.tStart && r.t <= hold.tEnd);
  const insideRaw = raw.filter((r) => r.t >= hold.tStart && r.t <= hold.tEnd);
  const rootYRest = median(rows.filter((r) => r.t >= hold.tStart - 1 && r.t < hold.tStart).map((r) => r.rootY));
  const base = { name: hold.name, group: hold.group, n: inside.length, rootYRest };
  const empty = { speed: NaN, vx: NaN, vz: NaN, headingDeg: NaN, residRms: NaN, t90: NaN, distance: NaN };
  if (!insideRaw.length || insideRaw.some((r) => r.moveScale !== 1)) return { ...base, ...empty, status: 'REJECTED: MoveScale != 1.0' };
  const duration = hold.tEnd - hold.tStart;
  if (duration < MIN_HOLD_S) return { ...base, ...empty, status: 'RAMPING' };
  if (inside.length < MIN_ROWS) return { ...base, ...empty, status: `REJECTED: ${inside.length} rows` };
  const k = Math.max(3, Math.round(inside.length * STEADY_FRACTION));
  const steady = inside.slice(-k), ts = steady.map((r) => r.t);
  const [vx, bx] = linfit(ts, steady.map((r) => r.x)), [vz, bz] = linfit(ts, steady.map((r) => r.z));
  const residRms = Math.sqrt(steady.reduce((a, r) => a + (r.x - (vx * r.t + bx)) ** 2 + (r.z - (vz * r.t + bz)) ** 2, 0) / steady.length);
  const speed = Math.hypot(vx, vz);
  const t90 = t90Of(rows, hold, speed);
  if (!Number.isNaN(t90) && duration < RAMP_MULTIPLE * t90) return { ...base, ...empty, t90, status: 'RAMPING' };
  const rowDt = median(inside.slice(1).map((r, i) => r.t - inside[i]!.t));
  const first = inside[0]!, last = inside[inside.length - 1]!;
  return {
    ...base, speed, vx, vz, residRms, t90,
    headingDeg: speed > 1e-6 ? Math.atan2(vz, vx) * 180 / Math.PI : NaN,
    distance: Math.hypot(last.x - first.x, last.z - first.z),
    status: residRms > NOISY_ROWS * speed * rowDt + NOISY_FLOOR ? 'NOISY' : 'OK',
  };
}
