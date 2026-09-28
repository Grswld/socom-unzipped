"""The console measurement of the SEAL's speeds and stance heights (web sprint 2, Task W2.2c): hold the stick on
PCSX2 through a fixed schedule while sampling the local actor over PINE against the guest clock, then fit.

Lock-bound: a person or the controller runs it under `scripts/loop_lock.sh run`, in a window the owner names; the
recipe is docs/research/79-seal-speed-on-the-console.md. Nothing here launches anything under test.

  Run: python -m tools_py.parity.seal_speed_probe --dry-run                   # print the plan, exit 0, touch nothing
       python -m tools_py.parity.seal_speed_probe                             # attach: PCSX2 already at a spawn
       python -m tools_py.parity.seal_speed_probe --slot 8                    # launch PCSX2, load slot 8 (state_poll's path)
       python -m tools_py.parity.seal_speed_probe --save-state 8              # save the running console to slot 8, exit

What one row reads (the chains of scripts/parity/guest_probe_console.json, by NAME from guest_addresses, the
--revision column; the console boots the r0001 disc): the guest clock (seconds, `guest_clock`), then the local actor
(`player_actor`), its position words 7-9 (`actor_pos`, +0x1c..+0x24), the skeleton root's Y (the node `root_node`
points at, word 1) and MoveScale (`move_scale`), then the clock again -- a row whose two clock reads differ straddled
a game frame and is dropped (counted as torn). Rows sharing a clock value are collapsed by the fit.

The pad path is drive.py's `hold+<s>:BTN` step and pcsx2_ctl's `hold` command: `tools_py.parity.keys.press(hwnd,
button, "pcsx2", hold_s=seconds)`, a WM_KEYDOWN/WM_KEYUP pair posted to the PCSX2 window and its children, which
PCSX2's [Pad1] keyboard bindings (tools/pcsx2/inis/PCSX2.ini) turn into FULL deflection -- a keyboard key has no
half. Two things the schedule therefore cannot do from the keyboard, both left to the controller (PINE writes to
the pad buffer, or a PCSX2 pressure-modifier binding): a light Triangle (the stand/crouch toggle), and a push under
0.838 (the crouch WALK; a full push in crouch stands the SEAL up and runs, spec section 7).

What a FIRM Triangle does (peak pressure >= 0.3; the decompilation's PlayerUpd, socom2_game.elf.decomp.c
~453331-453425, the wished stance byte at actor+0x374): from stand or crouch it wishes PRONE when FUN_00584b00
allows, and from prone it wishes STAND on every branch -- so firm presses cycle stand/crouch -> prone -> stand and
never reach crouch (a light press from prone would). The default schedule is ordered for that: from the crouched
spawn (spec section 7, W2.3) three crouch-stance pairs, Triangle to prone, three prone holds, Triangle to stand,
then the standing pairs -- every direction three times, so research/18's half-the-group-median rule has a group.
Before every hold the probe reads the root at rest (seal_speed_fit.stance_of: standing 11.48 +-0.5, crouched
5.50 +-0.5, prone under 3); a stand or prone hold found in another stance gets up to two more firm taps (3 s
apart); a crouch hold gets none (no firm press reaches it). The schedule record carries the stance the root
finally read, the planned one and the taps, and the fit reports the measured stance.

Writes logs/parity/seal_speed_<stamp>.txt (the rows) and seal_speed_<stamp>.schedule.json (each step's guest-clock
span) and prints seal_speed_fit's table.
"""
import argparse
import collections
import json
import math
import os
import struct
import sys
import threading
import time

from tools_py.parity import guest_addresses as ga
from tools_py.parity import keys
from tools_py.parity import seal_speed_fit as F

Step = collections.namedtuple("Step", "name kind buttons seconds stance direction", defaults=(None, None))

# PCSX2's [Pad1] keyboard bindings for the names the schedule uses (keys.MAPS["pcsx2"] posts the key; this is what
# PCSX2 makes of it). Read from tools/pcsx2/inis/PCSX2.ini; note a step script's "I" on pcsx2 is the RIGHT stick
# up (T), not Triangle -- Triangle is named TRIANGLE.
PAD1_BINDING = {
    "W": "LUp = Keyboard/W",
    "S": "LDown = Keyboard/S",
    "A": "LLeft = Keyboard/A",
    "D": "LRight = Keyboard/D",
    "TRIANGLE": "Triangle = Keyboard/I",
    "CROSS": "Cross = Keyboard/K",
    "L": "RRight = Keyboard/H",
}
TAP_HOLD_S = 0.15            # pcsx2_shell's press hold: the console shell reads a 9-frame hold as one press
DEFAULT_REVISION = "r0001"   # the console boots the r0001 disc
PREFLIGHT_S = 1.0
STANCE_SETTLE_S = 3.0        # after a stance tap, before the root is read again
STANCE_TAPS = 2              # at most this many corrective taps before a hold
FIRM_REACHABLE = ("stand", "prone")   # what a firm Triangle can wish (the decompilation, above)


def _rest(name, s):
    return Step(name, "rest", (), float(s))


def _hold(name, buttons, stance, direction, s=6.0):
    return Step(name, "hold", tuple(buttons), float(s), stance, direction)


def _tap(name, button):
    return Step(name, "tap", (button,), TAP_HOLD_S)


def _pairs(a, b, rest=3):
    """Three alternating holds each way -- a group of three per direction, and the player back near where it began."""
    out = []
    for i in (1, 2, 3):
        out += [_hold("%s#%d" % (a[0], i), *a[1:]), _rest("rest_%s%d" % (a[0], i), rest)]
        if b is not None:
            out += [_hold("%s#%d" % (b[0], i), *b[1:]), _rest("rest_%s%d" % (b[0], i), rest)]
    return tuple(out)


DEFAULT_SCHEDULE = (
    (_rest("spawn_rest", 3),)                                          # the spawn stance's root (crouched: 5.504)
    + _pairs(("crouch_fwd", ["W"], "crouch", "fwd"),                   # full push in crouch: stands and runs
             ("crouch_back", ["S"], "crouch", "back"))
    + (_tap("to_prone", "TRIANGLE"), _rest("prone_rest", 3))           # firm: prone at once (R139)
    + _pairs(("prone_fwd", ["W"], "prone", "fwd"), None)               # prone: no ramp, the crawl's 11
    + (_tap("to_stand", "TRIANGLE"), _rest("stand_rest", 3))           # firm from prone: stand
    + _pairs(("fwd", ["W"], "stand", "fwd"), ("back", ["S"], "stand", "back"))       # 65 / 37; fwd is the facing
    + _pairs(("left", ["A"], "stand", "left"), ("right", ["D"], "stand", "right"))   # 65 each way
    + (_hold("fwd_left", ["W", "A"], "stand", "fwd_left"), _rest("rest_diag", 3))  # 45 deg: still 65 (section 7)
)


def with_turn_first(steps, seconds):
    """Prepend a right-stick-right hold (kind "turn": played, not fitted) and a 2 s rest: the first mission's spawn
    faces a stream (research/25 section 5: a 6 s forward hold from it walked into the water), and the ground's
    slow-down is not what this measures. 0 leaves the schedule as it is."""
    if not seconds:
        return steps
    return (Step("turn_away", "turn", ("L",), float(seconds)), _rest("turn_rest", 2)) + tuple(steps)


def load_steps(path):
    """A schedule file: [{"name", "kind": rest|hold|tap|turn, "buttons": [...], "seconds"}]; unbound buttons
    refused. Only "hold" steps are fitted; "turn" is played like a hold and skipped by the fit."""
    with open(path) as f:
        data = json.load(f)
    steps = []
    for e in data:
        kind = e["kind"]
        if kind not in ("rest", "hold", "tap", "turn"):
            raise ValueError("step %r: kind %r is not rest, hold, tap or turn" % (e.get("name"), kind))
        buttons = tuple(b.upper() for b in e.get("buttons", ()))
        for b in buttons:
            if b not in keys.MAPS["pcsx2"]:
                raise ValueError("step %r: %r is not a PCSX2 [Pad1] key in keys.MAPS" % (e.get("name"), b))
        steps.append(Step(e["name"], kind, buttons, float(e.get("seconds", TAP_HOLD_S)), e.get("stance"),
                          e.get("direction")))
    return tuple(steps)


def _f(bits):
    return struct.unpack("<f", struct.pack("<I", bits & 0xFFFFFFFF))[0]


class Sampler:
    """One row per call over a PINE-like object with read32: (guest_t, x, y, z, root_y, move_scale), or None."""

    def __init__(self, pine, revision=DEFAULT_REVISION):
        self.pine = pine
        self.clock = ga.address("guest_clock", revision)
        self.actor_ptr = ga.address("player_actor", revision)
        self.pos = ga.offset("actor_pos", revision)
        self.root = ga.offset("root_node", revision)
        self.ms = ga.offset("move_scale", revision)
        self.torn = 0
        self.null = 0

    def sample(self):
        r = self.pine.read32
        c0 = r(self.clock)
        actor = r(self.actor_ptr)
        if not actor:
            self.null += 1
            return None
        x, y, z = (_f(r(actor + self.pos + 4 * i)) for i in range(3))
        node = r(actor + self.root)
        root_y = _f(r(node + 4)) if node else math.nan
        ms = _f(r(actor + self.ms))
        c1 = r(self.clock)
        if c1 != c0:
            self.torn += 1
            return None
        return (_f(c0), x, y, z, root_y, ms)


def preflight(rows):
    """(ok, reason): the console is in play -- the guest clock advancing and MoveScale exactly 1.0."""
    if not rows:
        return False, "no rows (no actor, or PINE answered nothing)"
    ts = [r[0] for r in rows]
    if max(ts) <= min(ts):
        return False, "the guest clock is not advancing (paused, a pop-up, a menu or a load)"
    bad = [r for r in rows if r[5] != 1.0]
    if bad:
        return False, "MoveScale read %g on %d of %d rows (must be exactly 1.0)" % (bad[0][5], len(bad), len(rows))
    return True, "in play"


class Recorder(threading.Thread):
    """Samples as fast as PINE answers until stopped; `latest_t` is the newest good row's guest clock."""

    def __init__(self, sampler):
        super().__init__(daemon=True)
        self.sampler = sampler
        self.rows = []
        self.errors = 0
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()

    def run(self):
        while not self._stop_evt.is_set():
            try:
                row = self.sampler.sample()
            except Exception:  # noqa: BLE001 -- a PINE hiccup is counted, not fatal
                self.errors += 1
                time.sleep(0.05)
                continue
            if row is not None:
                with self._lock:
                    self.rows.append(row + (time.time(),))

    def stop(self):
        self._stop_evt.set()
        self.join(5.0)

    def latest_t(self):
        with self._lock:
            return self.rows[-1][0] if self.rows else math.nan

    def rest_root(self, window_s=1.0):
        """The median skeleton-root Y over the last `window_s` guest seconds of rows (NaN with none)."""
        with self._lock:
            if not self.rows:
                return math.nan
            t1 = self.rows[-1][0]
            ys = sorted(r[4] for r in self.rows if r[0] >= t1 - window_s and not math.isnan(r[4]))
        if not ys:
            return math.nan
        k = len(ys) // 2
        return ys[k] if len(ys) % 2 else 0.5 * (ys[k - 1] + ys[k])

    def snapshot(self):
        with self._lock:
            return list(self.rows)


def press_hold(hwnd, buttons, seconds, press=None):
    """Hold every button for `seconds` at once (a thread each), through keys.press -- drive.py's hold path."""
    press = press or keys.press
    threads = [threading.Thread(target=press, args=(hwnd, b, "pcsx2"), kwargs={"hold_s": seconds}, daemon=True)
               for b in buttons]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def ensure_stance(recorder, hwnd, planned, press, sleep):
    """(stance the root reads, root, taps): up to STANCE_TAPS firm Triangles toward `planned` when a firm press can
    reach it, the root re-read STANCE_SETTLE_S after each."""
    root = recorder.rest_root(1.0)
    actual = F.stance_of(root)
    taps = 0
    while actual != planned and planned in FIRM_REACHABLE and taps < STANCE_TAPS:
        press(hwnd, "TRIANGLE", "pcsx2", hold_s=TAP_HOLD_S)
        taps += 1
        sleep(STANCE_SETTLE_S)
        root = recorder.rest_root(1.0)
        actual = F.stance_of(root)
    return actual, root, taps


def run_schedule(steps, recorder, hwnd, press=None, sleep=time.sleep):
    """Play the steps; returns the schedule records with each step's guest-clock span (and, for a hold with a
    planned stance, the stance its rest root read after any corrective taps)."""
    press = press or keys.press
    out = []
    for s in steps:
        extra = {}
        if s.kind == "hold" and s.stance:
            actual, root, taps = ensure_stance(recorder, hwnd, s.stance, press, sleep)
            extra = {"stance": actual, "planned_stance": s.stance, "stance_taps": taps, "root_y_rest": root,
                     "direction": s.direction}
            if actual != s.stance:
                print("%-12s stance %s where %s was planned (root %.3f, %d taps): the hold is marked %s"
                      % (s.name, actual, s.stance, root, taps, actual), flush=True)
        t0, h0 = recorder.latest_t(), time.time()
        if s.kind == "rest":
            sleep(s.seconds)
        elif s.kind in ("hold", "turn"):
            press_hold(hwnd, s.buttons, s.seconds, press)
        else:
            for b in s.buttons:
                press(hwnd, b, "pcsx2", hold_s=s.seconds)
        t1, h1 = recorder.latest_t(), time.time()
        rec = {"name": s.name, "kind": s.kind, "buttons": list(s.buttons), "seconds": s.seconds,
               "t_start": t0, "t_end": t1, "host_start": round(h0, 3), "host_end": round(h1, 3)}
        rec.update(extra)
        out.append(rec)
        print("%-12s %-5s %-10s guest %8.3f -> %8.3f" % (s.name, s.kind, "+".join(s.buttons) or "-", t0, t1),
              flush=True)
    return out


def plan_text(a, steps):
    lines = ["DRY RUN -- nothing launched, no PINE, no window, no file written", ""]
    if a.slot is not None:
        lines.append("console: launch PCSX2 on the disc and load savestate slot %d (state_poll's path)" % a.slot)
    else:
        lines.append("console: attach to a running PCSX2 at a spawn (PINE port %d, window %r)"
                     % (_pine_port(), keys.WINDOW_TITLES["pcsx2"]))
    rev = a.revision
    lines += ["revision %s: clock %#x, actor *%#x, pos +%#x..+%#x, root *(actor+%#x)+0x4, MoveScale +%#x" % (
        rev, ga.address("guest_clock", rev), ga.address("player_actor", rev), ga.offset("actor_pos", rev),
        ga.offset("actor_pos", rev) + 8, ga.offset("root_node", rev), ga.offset("move_scale", rev)),
        "preflight: %.1f s of rows, the clock advancing, MoveScale exactly 1.0" % PREFLIGHT_S, "",
        "| # | step | kind | keys | [Pad1] binding | stance | expected u/s | seconds |",
        "|---|---|---|---|---|---|---:|---:|"]
    total = 0.0
    for i, s in enumerate(steps):
        binding = "; ".join(PAD1_BINDING.get(b, "keys.MAPS %s" % b) for b in s.buttons) or "-"
        exp = F.expected_speed(s.direction, s.stance) if s.kind == "hold" else math.nan
        lines.append("| %d | %s | %s | %s | %s | %s | %s | %.2f |" % (
            i, s.name, s.kind, "+".join(s.buttons) or "-", binding, s.stance or "-",
            "-" if math.isnan(exp) else "%.1f" % exp, s.seconds))
        total += s.seconds
    lines += ["", "schedule: %.1f s" % total,
              "rows -> %s" % os.path.join(a.out_dir, "seal_speed_<stamp>.txt"),
              "schedule -> %s" % os.path.join(a.out_dir, "seal_speed_<stamp>.schedule.json")]
    return "\n".join(lines)


def _pine_port():
    from tools_py.parity.cam_poll import pine_port
    return pine_port()


def default_attach(a):
    """(pine, hwnd, cleanup) for a PCSX2 already running at a spawn."""
    from tools_py.parity import hostplatform
    from tools_py.parity.pine import Pine
    winshot = hostplatform.shot_module()
    hwnd = winshot.find_window(keys.WINDOW_TITLES["pcsx2"])
    if hwnd is None:
        raise SystemExit("no PCSX2 window titled %r: start the console at a spawn first, or pass --slot"
                         % keys.WINDOW_TITLES["pcsx2"])
    return Pine(port=_pine_port()), hwnd, (lambda: None)


def default_launch(a):
    """(pine, hwnd, cleanup): state_poll's path -- PCSX2 -batch -nogui -fastboot on the disc, PINE, load the slot."""
    import subprocess
    from tools_py.parity import hostplatform
    from tools_py.parity.drive import PCSX2
    from tools_py.parity.pine import Pine
    if hostplatform.process_running("pcsx2-qt"):
        raise SystemExit("pcsx2-qt is already running; refusing to start a second instance (attach instead)")
    winshot = hostplatform.shot_module()
    proc = subprocess.Popen([PCSX2, "-batch", "-nogui", "-fastboot", hostplatform.iso_path()],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def cleanup():
        proc.terminate()
        hostplatform.kill_process_by_name("pcsx2-qt")

    t0, pine = time.time(), None
    while pine is None and time.time() - t0 < 120:
        try:
            pine = Pine(port=_pine_port())
        except OSError:
            time.sleep(1.0)
    if pine is None:
        cleanup()
        raise SystemExit("no PINE after 120 s")
    time.sleep(a.boot)
    pine.load_state(a.slot)
    time.sleep(4.0)
    hwnd = winshot.find_window(keys.WINDOW_TITLES["pcsx2"], pid=proc.pid)
    if hwnd is None:
        cleanup()
        raise SystemExit("no PCSX2 window for pid %d" % proc.pid)
    return pine, hwnd, cleanup


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit 0; touches nothing")
    ap.add_argument("--slot", type=int, default=None, help="launch PCSX2 and load this savestate slot")
    ap.add_argument("--boot", type=float, default=25.0, help="seconds between PINE answering and the state load")
    ap.add_argument("--save-state", type=int, default=None, dest="save_state",
                    help="save the RUNNING console to this slot over PINE and exit")
    ap.add_argument("--revision", default=DEFAULT_REVISION)
    ap.add_argument("--schedule", default=None, help="a schedule JSON instead of the default")
    ap.add_argument("--turn-first", type=float, default=0.0, dest="turn_first",
                    help="seconds of right stick right before the schedule (face away from the spawn's stream)")
    ap.add_argument("--out-dir", default=os.path.join("logs", "parity"), dest="out_dir")
    return ap


def main(argv=None, launch=None, attach=None):
    a = build_parser().parse_args(argv)
    steps = with_turn_first(load_steps(a.schedule) if a.schedule else DEFAULT_SCHEDULE, a.turn_first)
    if a.dry_run:
        print(plan_text(a, steps))
        return 0
    if a.save_state is not None:
        from tools_py.parity.pine import Pine
        Pine(port=_pine_port()).save_state(a.save_state)
        print("saved the running console to slot %d" % a.save_state)
        return 0
    pine, hwnd, cleanup = (launch or default_launch)(a) if a.slot is not None else (attach or default_attach)(a)
    try:
        rec = Recorder(Sampler(pine, a.revision))
        rec.start()
        time.sleep(PREFLIGHT_S)
        ok, why = preflight([r[:6] for r in rec.snapshot()])
        if not ok:
            rec.stop()
            print("PREFLIGHT FAIL: %s" % why, file=sys.stderr)
            return 3
        schedule = run_schedule(steps, rec, hwnd)
        rec.stop()
    finally:
        cleanup()
    rows = rec.snapshot()
    os.makedirs(a.out_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    rows_path = os.path.join(a.out_dir, "seal_speed_%s.txt" % stamp)
    sched_path = os.path.join(a.out_dir, "seal_speed_%s.schedule.json" % stamp)
    with open(rows_path, "w") as f:
        f.write("# seal_speed_probe revision=%s slot=%s rows=%d torn=%d null=%d errors=%d\n"
                % (a.revision, a.slot, len(rows), rec.sampler.torn, rec.sampler.null, rec.errors))
        f.write("# guest_t x y z root_y move_scale host_t\n")
        for r in rows:
            f.write("%s %.3f\n" % (F.format_row(r), r[6]))
    with open(sched_path, "w") as f:
        json.dump(schedule, f, indent=1)
    print("%d rows -> %s\nschedule -> %s\n" % (len(rows), rows_path, sched_path))
    print(F.report(F.fit_holds([r[:6] for r in rows], F.load_schedule(sched_path))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
