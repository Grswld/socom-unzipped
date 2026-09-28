"""Fit the SEAL's speed, ramp, heading and stance height from sampled console rows (web sprint 2, Task W2.2c).

Pure functions over rows `(guest_clock_s, x, y, z, root_y, move_scale)` -- what `seal_speed_probe` writes -- and a
schedule of holds `(name, t_start, t_end[, group, stance, direction])` on the same guest clock. Per hold:

  * MoveScale: every row inside the hold exactly 1.0, else the hold is REJECTED (research/18 section 3.13: a hold
    through a MoveScale stall measures the stall; zero rows is not ok either). Checked on the RAW rows, before
    duplicate clock values merge, so a discarded duplicate still counts;
  * RAMPING: a hold shorter than max(1 s, 3 x t90) has no steady segment and gets no steady number;
  * steady speed: a least-squares line through x(t) and z(t) over the LAST 60 % of the hold's rows; the speed is
    the length of the fitted xz velocity, in units per GUEST second (never per host second, never per 4 Hz peek
    row: research/25 section 5); NOISY when the RMS residual exceeds 1.5 x one row's motion (speed / row rate)
    + 0.1 units -- relative, so a game that moves the actor on every second clock tick (a staircase, residual
    about half a row's motion) still reads OK;
  * t90: from t_start to the first row whose SMOOTHED speed (a local linear fit over +-2 rows) reaches 0.9 x
    steady and stays there for the next row, interpolated with the row before; NaN when the rows are too sparse
    to resolve a 0.2 s ramp (median spacing over 0.1 s), when the speed never gets there, or when the hold is at
    speed on its first row. `t90_ok` is False when the steady residual exceeds one row's motion at the fitted
    speed -- the t90 is then marked "t90?" in the report. ADVISORY only: a deterministic staircase (exact floats
    that move on every second clock tick, about half a row's motion of residual) carries no flag;
  * heading: atan2(vz, vx) in degrees (the xz plane, research/22's convention); with a facing (explicit, or the
    heading of the hold named or grouped `facing_hold`, "fwd" by default) also the velocity along it, across it
    (positive = +90 deg in the same atan2 sense) and the heading relative to it -- a back hold reads about -37;
  * root Y at rest: the median root_y over the 1 s before t_start; the stance is the probe's measured one when the
    schedule carries it, else the one this root reads (`stance_of`), else the one the name plans;
  * expected: the spec's band for (direction, stance) (web sprint 2 design section 7: stand fwd/left/right 65,
    back 37; prone 11). Every crouch hold here is a FULL push, which stands the SEAL up and runs while the stance
    stays crouch, so a crouch hold expects the STANDING band; the crouch walk (14.0 ahead, 12.8 back, 14.2
    sideways) needs a push under 0.838, a light stick the keyboard cannot give;
  * blocked: the xz distance under half the median of its group's (research/18 section 3.13's rule; the group is
    the name before a '#', so "fwd#1".."fwd#3" are one group), OR the steady speed under half the expected band.

Rows sharing a guest-clock value (PINE polls faster than the game's frame) collapse to the LAST read of that
value; a row whose clock runs backwards is dropped.

Run: python -m tools_py.parity.seal_speed_fit <rows.txt> <schedule.json>
"""
import collections
import json
import math
import sys

Row = collections.namedtuple("Row", "t x y z root_y move_scale")
Hold = collections.namedtuple("Hold", "name t_start t_end group stance direction", defaults=(None, None))
HoldFit = collections.namedtuple(
    "HoldFit", "name group stance n speed vx vz heading_deg resid_rms t90 t90_ok root_y_rest move_scale_ok "
               "distance expected under_expected blocked along lateral rel_heading_deg status")

NAN = float("nan")
STEADY_FRACTION = 0.6
NOISY_ROWS = 1.5         # NOISY above this many rows' motion of RMS residual ...
NOISY_FLOOR = 0.1        # ... plus this many units
T90_NOISE = 1.0          # t90 is low-confidence (advisory) above this many rows' motion of steady residual
RESOLVE_DT = 0.1         # s: a median row spacing above this cannot resolve a 0.2 s ramp
SMOOTH_HALF = 2          # rows each side of the local linear fit behind the t90 speed
MIN_ROWS = 5
MIN_HOLD_S = 1.0
RAMP_MULTIPLE = 3.0

# Standing root 11.484, crouched 5.504 (W2.R9), each +-0.5. Prone is ANY root under the crouch band (< 5.004): the
# prone root is what the run measures, so no guess at it (the design's estimate 1.8) may decide the stance. What
# fits nothing -- 6.004 < root < 10.984 between the bands, or above the stand band -- reads "unknown".
STANCE_ROOTS = (("stand", 11.484, 0.5), ("crouch", 5.504, 0.5))
PRONE_BELOW = 5.504 - 0.5
_STAND = {"fwd": 65.0, "back": 37.0, "left": 65.0, "right": 65.0, "fwd_left": 65.0, "fwd_right": 65.0}
_CROUCH_WALK = {"fwd": 14.0, "back": 12.8, "left": 14.2, "right": 14.2}
EXPECTED = {("stand", d): v for d, v in _STAND.items()}
EXPECTED.update({("crouch", d): _STAND[d] for d in _CROUCH_WALK})     # a full push in crouch runs the standing band
EXPECTED[("prone", "fwd")] = 11.0
EXPECTED_NOTE = {("crouch", d): "full push stands up; the %.1f crouch walk needs a light stick" % v
                 for d, v in _CROUCH_WALK.items()}


def group_of(name):
    return name.split("#", 1)[0]


def planned_stance(group):
    for s in ("crouch", "prone"):
        if group.startswith(s + "_"):
            return s
    return "stand"


def direction_of(group):
    for s in ("crouch_", "prone_"):
        if group.startswith(s):
            return group[len(s):]
    return group


def stance_of(root_y):
    """The stance a skeleton root at rest reads: stand, crouch, prone or unknown."""
    if root_y is None or math.isnan(root_y):
        return "unknown"
    for name, centre, tol in STANCE_ROOTS:
        if abs(root_y - centre) <= tol:
            return name
    return "prone" if root_y < PRONE_BELOW else "unknown"


def expected_speed(direction, stance):
    return EXPECTED.get((stance, direction), NAN)


def expected_label(direction, stance):
    """The expected band as the report prints it, with the full-push caveat on a crouch hold."""
    v = expected_speed(direction, stance)
    if math.isnan(v):
        return "--"
    note = EXPECTED_NOTE.get((stance, direction))
    return "%.0f (%s)" % (v, note) if note else "%.1f" % v


def as_hold(h):
    if isinstance(h, Hold):
        return h
    name, a, b = h[0], float(h[1]), float(h[2])
    group = h[3] if len(h) > 3 and h[3] else group_of(name)
    stance = h[4] if len(h) > 4 else None
    direction = h[5] if len(h) > 5 else None
    return Hold(name, a, b, group, stance, direction)


def dedupe(rows):
    """Rows in clock order, one per guest-clock value (the last read of it); a backwards clock row is dropped."""
    out = []
    for r in rows:
        r = Row(*[float(v) for v in r[:6]])
        if out and r.t == out[-1].t:
            out[-1] = r
        elif not out or r.t > out[-1].t:
            out.append(r)
    return out


def _linfit(ts, vs):
    """Slope, intercept of the least-squares line v = a t + b."""
    n = len(ts)
    mt = sum(ts) / n
    mv = sum(vs) / n
    stt = sum((t - mt) ** 2 for t in ts)
    if stt == 0:
        return 0.0, mv
    a = sum((t - mt) * (v - mv) for t, v in zip(ts, vs)) / stt
    return a, mv - a * mt


def _median(vs):
    s = sorted(vs)
    if not s:
        return NAN
    k = len(s) // 2
    return s[k] if len(s) % 2 else 0.5 * (s[k - 1] + s[k])


def _smoothed_speed(rows, i, half=SMOOTH_HALF):
    """The xz speed at row i from a local linear fit over rows i-half..i+half (a Savitzky-Golay-like slope)."""
    win = rows[i - half:i + half + 1]
    ts = [r.t for r in win]
    vx, _ = _linfit(ts, [r.x for r in win])
    vz, _ = _linfit(ts, [r.z for r in win])
    return math.hypot(vx, vz)


def _t90(rows, hold, steady):
    if not (steady > 1e-6):
        return NAN
    idx = [i for i, r in enumerate(rows) if hold.t_start <= r.t <= hold.t_end]
    if len(idx) < 3:
        return NAN
    gaps = [rows[i + 1].t - rows[i].t for i in idx[:-1]]
    if _median(gaps) > RESOLVE_DT:
        return NAN
    h = SMOOTH_HALF
    cand = [i for i in range(max(h, idx[0] - h), idx[-1]) if i + h < len(rows)]
    speeds = {i: _smoothed_speed(rows, i) for i in cand}
    thr = 0.9 * steady
    prev = None
    for k, i in enumerate(cand):
        v = speeds[i]
        nxt = speeds.get(cand[k + 1]) if k + 1 < len(cand) else v
        if v >= thr and nxt >= thr:
            if prev is None:
                return NAN            # already at speed on the first resolvable row
            tp, vp = prev
            ti = rows[i].t
            tc = ti if v == vp else tp + (ti - tp) * (thr - vp) / (v - vp)
            return max(0.0, tc - hold.t_start)
        prev = (rows[i].t, v)
    return NAN


def _row_dt(rows):
    gaps = [b.t - a.t for a, b in zip(rows, rows[1:])]
    return _median(gaps) if gaps else NAN


def fit_hold(rows, hold, raw=None, steady_fraction=STEADY_FRACTION):
    """One hold's fit over deduped `rows`; MoveScale is judged on `raw` (the rows before the merge; default
    `rows`). along/lateral/blocked are left for fit_holds."""
    hold = as_hold(hold)
    raw = rows if raw is None else raw
    inside = [r for r in rows if hold.t_start <= r.t <= hold.t_end]
    inside_raw = [r for r in raw if hold.t_start <= float(r[0]) <= hold.t_end]
    rest = [r.root_y for r in rows if hold.t_start - 1.0 <= r.t < hold.t_start]
    root_rest = _median(rest)
    ms_ok = bool(inside_raw) and all(float(r[5]) == 1.0 for r in inside_raw)
    stance = hold.stance or (stance_of(root_rest) if stance_of(root_rest) != "unknown" else
                             planned_stance(hold.group))
    direction = hold.direction or direction_of(hold.group)
    expected = expected_speed(direction, stance)
    base = dict(name=hold.name, group=hold.group, stance=stance, n=len(inside), root_y_rest=root_rest,
                move_scale_ok=ms_ok, expected=expected, under_expected=False, blocked=False, along=NAN,
                lateral=NAN, rel_heading_deg=NAN)
    empty = dict(speed=NAN, vx=NAN, vz=NAN, heading_deg=NAN, resid_rms=NAN, t90=NAN, t90_ok=False, distance=NAN)
    duration = hold.t_end - hold.t_start
    if not ms_ok:
        return HoldFit(status="REJECTED: MoveScale != 1.0", **empty, **base)
    if duration < MIN_HOLD_S:
        return HoldFit(status="RAMPING", **empty, **base)
    if len(inside) < MIN_ROWS:
        return HoldFit(status="REJECTED: %d rows" % len(inside), **empty, **base)
    k = max(3, int(round(len(inside) * steady_fraction)))
    steady = inside[-k:]
    ts = [r.t for r in steady]
    vx, bx = _linfit(ts, [r.x for r in steady])
    vz, bz = _linfit(ts, [r.z for r in steady])
    resid = math.sqrt(sum((r.x - (vx * r.t + bx)) ** 2 + (r.z - (vz * r.t + bz)) ** 2 for r in steady) / len(steady))
    speed = math.hypot(vx, vz)
    t90 = _t90(rows, hold, speed)
    if not math.isnan(t90) and duration < RAMP_MULTIPLE * t90:
        return HoldFit(status="RAMPING", **dict(empty, t90=t90), **base)
    row_motion = speed * _row_dt(inside)
    heading = math.degrees(math.atan2(vz, vx)) if speed > 1e-6 else NAN
    distance = math.hypot(inside[-1].x - inside[0].x, inside[-1].z - inside[0].z)
    t90_ok = not math.isnan(t90) and resid <= T90_NOISE * row_motion
    status = "NOISY" if resid > NOISY_ROWS * row_motion + NOISY_FLOOR else "OK"
    return HoldFit(speed=speed, vx=vx, vz=vz, heading_deg=heading, resid_rms=resid, t90=t90, t90_ok=t90_ok,
                   distance=distance, status=status, **base)


def _wrap(deg):
    return (deg + 180.0) % 360.0 - 180.0


def _measured(f):
    return not (f.status.startswith("REJECTED") or f.status == "RAMPING")


def fit_holds(rows, holds, facing_deg=None, facing_hold="fwd", steady_fraction=STEADY_FRACTION):
    """Every hold's HoldFit, with the blocked flag (per group and per expected band) and the velocity along/across
    the facing."""
    raw = list(rows)
    rows = dedupe(raw)
    holds = [as_hold(h) for h in holds]
    fits = [fit_hold(rows, h, raw, steady_fraction) for h in holds]
    usable = [f for f in fits if _measured(f)]
    groups = collections.defaultdict(list)
    for f in usable:
        groups[f.group].append(f.distance)
    if facing_deg is None:
        ref = next((f for f in usable if f.name == facing_hold or f.group == facing_hold), None)
        facing_deg = ref.heading_deg if ref is not None else None
    out = []
    for f in fits:
        upd = {}
        if _measured(f):
            by_group = f.distance < 0.5 * _median(groups[f.group])
            under = not math.isnan(f.expected) and f.speed < 0.5 * f.expected
            upd["under_expected"] = under
            if by_group or under:
                upd["blocked"] = True
                upd["status"] = "BLOCKED"
            if facing_deg is not None and not math.isnan(facing_deg):
                c, s = math.cos(math.radians(facing_deg)), math.sin(math.radians(facing_deg))
                upd["along"] = f.vx * c + f.vz * s
                upd["lateral"] = -f.vx * s + f.vz * c
                if not math.isnan(f.heading_deg):
                    upd["rel_heading_deg"] = _wrap(f.heading_deg - facing_deg)
        out.append(f._replace(**upd))
    return out


def _num(v, fmt):
    return "--" if v is None or (isinstance(v, float) and math.isnan(v)) else fmt % v


def _expected_cell(f):
    if math.isnan(f.expected):
        return "--"
    d = next((dd for (st, dd), v in EXPECTED.items() if st == f.stance and v == f.expected
              and dd == direction_of(f.group)), None)
    return expected_label(d, f.stance) if d else "%.1f" % f.expected


def report(fits):
    """A markdown table of the fits, one row per hold."""
    lines = ["| hold | stance | rows | speed u/s | expected | along | across | heading deg | rel. deg | "
             "t90 s (flag advisory: residual over one row's motion) | "
             "rootY at rest | distance | resid | status |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    for f in fits:
        t90 = _num(f.t90, "%.3f")
        if t90 != "--" and not f.t90_ok:
            t90 += " (t90?)"
        lines.append("| %s | %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            f.name, f.stance, f.n, _num(f.speed, "%.2f"), _expected_cell(f), _num(f.along, "%.2f"),
            _num(f.lateral, "%.2f"), _num(f.heading_deg, "%.1f"), _num(f.rel_heading_deg, "%.1f"), t90,
            _num(f.root_y_rest, "%.3f"), _num(f.distance, "%.1f"), _num(f.resid_rms, "%.3f"), f.status))
    return "\n".join(lines)


def format_row(r):
    """One rows-file line: guest_t x y z root_y move_scale (the probe's writer and this module's reader)."""
    return "%.6f %.4f %.4f %.4f %.4f %.6f" % tuple(float(v) for v in r[:6])


def parse_rows(lines):
    rows = []
    for ln in lines:
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        parts = ln.split()
        try:
            rows.append(Row(*[float(p) for p in parts[:6]]))
        except (ValueError, TypeError):
            continue
    return rows


def load_rows(path):
    with open(path) as f:
        return parse_rows(f)


def load_schedule(path):
    """The holds of a schedule file the probe wrote: every entry of kind "hold" with its guest-clock span and, when
    the probe measured it, the stance its rest root read."""
    with open(path) as f:
        data = json.load(f)
    return [Hold(e["name"], float(e["t_start"]), float(e["t_end"]), e.get("group") or group_of(e["name"]),
                 e.get("stance"), e.get("direction"))
            for e in data if e.get("kind") == "hold"]


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2:
        print("usage: python -m tools_py.parity.seal_speed_fit <rows.txt> <schedule.json>", file=sys.stderr)
        return 2
    fits = fit_holds(load_rows(argv[0]), load_schedule(argv[1]))
    print(report(fits))
    return 0


if __name__ == "__main__":
    sys.exit(main())
