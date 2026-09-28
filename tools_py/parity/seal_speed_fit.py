"""Fit the SEAL's speed, ramp, heading and stance height from sampled console rows (web sprint 2, Task W2.2c).

Pure functions over rows `(guest_clock_s, x, y, z, root_y, move_scale)` -- what `seal_speed_probe` writes -- and a
schedule of holds `(name, t_start, t_end)` on the same guest clock. Per hold:

  * steady speed: a least-squares line through x(t) and z(t) over the LAST 60 % of the hold's rows; the speed is
    the length of the fitted xz velocity, in units per GUEST second (never per host second, never per 4 Hz peek
    row: research/25 section 5, research/18 section 3.13); the RMS residual of that fit is checked (NOISY above
    `resid_tol` units);
  * t90: from t_start to the first row whose centred-difference xz speed reaches 0.9 x steady, interpolated between
    that row and the one before; NaN when the rows are too sparse to resolve a 0.2 s ramp (median spacing over
    0.1 s), when the speed never gets there, or when the hold is already at speed on its first row;
  * heading: atan2(vz, vx) in degrees (the xz plane, research/22's convention); with a facing (explicit, or the
    heading of the hold named `facing_hold`, "fwd" by default) also the velocity along it, across it (positive =
    +90 deg in the same atan2 sense) and the heading relative to it -- so a back hold reads about -37 along;
  * root Y at rest: the median root_y over the 1 s before t_start (the stance's skeleton root, spec W2.R9);
  * MoveScale: every row inside the hold exactly 1.0, else the hold is REJECTED (research/18 section 3.13: a hold
    through a MoveScale stall measures the stall; zero rows is not ok either);
  * blocked: the xz distance under half the median of its group's distances (research/18 section 3.13's rule);
    the group is the name before a '#', so "fwd#1".."fwd#3" are one group and a lone hold is never blocked.

Rows sharing a guest-clock value (PINE polls faster than the game's frame) collapse to the LAST read of that
value; a row whose clock runs backwards is dropped.

Run: python -m tools_py.parity.seal_speed_fit <rows.txt> <schedule.json>
"""
import collections
import json
import math
import sys

Row = collections.namedtuple("Row", "t x y z root_y move_scale")
Hold = collections.namedtuple("Hold", "name t_start t_end group")
HoldFit = collections.namedtuple(
    "HoldFit", "name group n speed vx vz heading_deg resid_rms t90 root_y_rest move_scale_ok distance blocked "
               "along lateral rel_heading_deg status")

NAN = float("nan")
STEADY_FRACTION = 0.6
RESID_TOL = 0.5          # units, RMS of the steady segment's xz residual
RESOLVE_DT = 0.1         # s: a median row spacing above this cannot resolve a 0.2 s ramp
MIN_ROWS = 5


def group_of(name):
    return name.split("#", 1)[0]


def as_hold(h):
    if isinstance(h, Hold):
        return h
    name, a, b = h[0], float(h[1]), float(h[2])
    return Hold(name, a, b, h[3] if len(h) > 3 and h[3] else group_of(name))


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


def _centred_speed(rows, i):
    a, b = rows[i - 1], rows[i + 1]
    return math.hypot(b.x - a.x, b.z - a.z) / (b.t - a.t)


def _t90(rows, hold, steady):
    if not (steady > 1e-6):
        return NAN
    idx = [i for i, r in enumerate(rows) if hold.t_start <= r.t <= hold.t_end]
    if len(idx) < 3:
        return NAN
    gaps = [rows[i + 1].t - rows[i].t for i in idx[:-1]]
    if _median(gaps) > RESOLVE_DT:
        return NAN
    first = idx[0]
    cand = [i for i in range(max(1, first - 1), idx[-1]) if i + 1 < len(rows)]
    prev = None
    for i in cand:
        v = _centred_speed(rows, i)
        if v >= 0.9 * steady:
            if prev is None:
                return NAN            # already at speed on the first resolvable row
            (tp, vp) = prev
            ti = rows[i].t
            tc = ti if v == vp else tp + (ti - tp) * (0.9 * steady - vp) / (v - vp)
            return max(0.0, tc - hold.t_start)
        prev = (rows[i].t, v)
    return NAN


def fit_hold(rows, hold, steady_fraction=STEADY_FRACTION, resid_tol=RESID_TOL):
    """One hold's fit over already-deduped rows; along/lateral/blocked are left for fit_holds."""
    hold = as_hold(hold)
    inside = [r for r in rows if hold.t_start <= r.t <= hold.t_end]
    rest = [r.root_y for r in rows if hold.t_start - 1.0 <= r.t < hold.t_start]
    root_rest = _median(rest)
    ms_ok = bool(inside) and all(r.move_scale == 1.0 for r in inside)
    base = dict(name=hold.name, group=hold.group, n=len(inside), root_y_rest=root_rest, move_scale_ok=ms_ok,
                blocked=False, along=NAN, lateral=NAN, rel_heading_deg=NAN)
    if len(inside) < MIN_ROWS:
        return HoldFit(speed=NAN, vx=NAN, vz=NAN, heading_deg=NAN, resid_rms=NAN, t90=NAN, distance=NAN,
                       status="REJECTED: %d rows" % len(inside), **base)
    k = max(3, int(round(len(inside) * steady_fraction)))
    steady = inside[-k:]
    ts = [r.t for r in steady]
    vx, bx = _linfit(ts, [r.x for r in steady])
    vz, bz = _linfit(ts, [r.z for r in steady])
    resid = math.sqrt(sum((r.x - (vx * r.t + bx)) ** 2 + (r.z - (vz * r.t + bz)) ** 2 for r in steady) / len(steady))
    speed = math.hypot(vx, vz)
    heading = math.degrees(math.atan2(vz, vx)) if speed > 1e-6 else NAN
    distance = math.hypot(inside[-1].x - inside[0].x, inside[-1].z - inside[0].z)
    if not ms_ok:
        status = "REJECTED: MoveScale != 1.0"
    elif resid > resid_tol:
        status = "NOISY"
    else:
        status = "OK"
    return HoldFit(speed=speed, vx=vx, vz=vz, heading_deg=heading, resid_rms=resid, t90=_t90(rows, hold, speed),
                   distance=distance, status=status, **base)


def _wrap(deg):
    return (deg + 180.0) % 360.0 - 180.0


def fit_holds(rows, holds, facing_deg=None, facing_hold="fwd", steady_fraction=STEADY_FRACTION,
              resid_tol=RESID_TOL):
    """Every hold's HoldFit, with the blocked flag (per group) and the velocity along/across the facing."""
    rows = dedupe(rows)
    holds = [as_hold(h) for h in holds]
    fits = [fit_hold(rows, h, steady_fraction, resid_tol) for h in holds]
    usable = [f for f in fits if not f.status.startswith("REJECTED")]
    groups = collections.defaultdict(list)
    for f in usable:
        groups[f.group].append(f.distance)
    if facing_deg is None:
        ref = next((f for f in usable if f.name == facing_hold or f.group == facing_hold), None)
        facing_deg = ref.heading_deg if ref is not None else None
    out = []
    for f in fits:
        upd = {}
        if not f.status.startswith("REJECTED"):
            med = _median(groups[f.group])
            if f.distance < 0.5 * med:
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


def report(fits):
    """A markdown table of the fits, one row per hold."""
    lines = ["| hold | rows | speed u/s | along | across | heading deg | rel. deg | t90 s | rootY at rest | "
             "distance | resid | status |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    for f in fits:
        lines.append("| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            f.name, f.n, _num(f.speed, "%.2f"), _num(f.along, "%.2f"), _num(f.lateral, "%.2f"),
            _num(f.heading_deg, "%.1f"), _num(f.rel_heading_deg, "%.1f"), _num(f.t90, "%.3f"),
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
    """The holds of a schedule file the probe wrote: every entry of kind "hold" with its guest-clock span."""
    with open(path) as f:
        data = json.load(f)
    return [Hold(e["name"], float(e["t_start"]), float(e["t_end"]), e.get("group") or group_of(e["name"]))
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
