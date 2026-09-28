"""The SEAL speed probe's driver skeleton (web sprint 2, Task W2.2c), without a console.

--dry-run must print the plan and exit 0 without touching PCSX2; the schedule must name only keys PCSX2's [Pad1]
binds; one sample must walk the pointer chains through a fake PINE and refuse a torn read. No game, no PINE
socket, no window: the fake below is a dict of guest words.
"""
import atexit
import collections
import io
import json
import math
import os
import signal
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout

from tools_py.parity import guest_addresses as ga
from tools_py.parity import keys
from tools_py.parity import seal_speed_fit as F
from tools_py.parity import seal_speed_probe as P

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def fbits(v):
    return struct.unpack("<I", struct.pack("<f", v))[0]


class FakePine:
    """read32 over a dict; `clock_steps` advances the guest clock by one frame after that many clock reads."""

    def __init__(self, revision="r0001", clock_steps=None):
        self.rev = revision
        self.mem = {}
        actor = 0x01000000
        node = 0x01100000
        self.clock_addr = ga.address("guest_clock", revision)
        self.mem[ga.address("player_actor", revision)] = actor
        base = actor + ga.offset("actor_pos", revision)
        for i, v in enumerate((939.4, -126.3, 832.2)):
            self.mem[base + 4 * i] = fbits(v)
        self.mem[actor + ga.offset("root_node", revision)] = node
        self.mem[node + 4] = fbits(5.504)
        self.mem[actor + ga.offset("move_scale", revision)] = fbits(1.0)
        self.clock = 12.5
        self.clock_steps = clock_steps
        self.clock_reads = 0

    def read32(self, a):
        if a == self.clock_addr:
            self.clock_reads += 1
            if self.clock_steps and self.clock_reads > self.clock_steps:
                self.clock += 1.0 / 60
            return fbits(self.clock)
        return self.mem.get(a, 0)


class DryRunTest(unittest.TestCase):
    def test_dry_run_prints_the_plan_and_exits_0_without_writing(self):
        out = tempfile.mkdtemp()
        r = subprocess.run([sys.executable, "-m", "tools_py.parity.seal_speed_probe", "--dry-run", "--out-dir", out],
                           cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("DRY RUN", r.stdout)
        for step in P.DEFAULT_SCHEDULE:
            self.assertIn(step.name, r.stdout)
        self.assertIn("Keyboard/W", r.stdout)
        self.assertEqual(os.listdir(out), [], "a dry run wrote a file")

    def test_dry_run_in_process_touches_no_launcher(self):
        called = []
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = P.main(["--dry-run", "--slot", "8"], launch=lambda *a: called.append(a),
                        attach=lambda *a: called.append(a))
        self.assertEqual(rc, 0)
        self.assertEqual(called, [])
        self.assertIn("load savestate slot 8", buf.getvalue())


class ScheduleTest(unittest.TestCase):
    def test_every_button_is_a_pcsx2_pad1_binding(self):
        for step in P.DEFAULT_SCHEDULE:
            for b in step.buttons:
                self.assertIn(b, keys.MAPS["pcsx2"], step)
                self.assertIn(b, P.PAD1_BINDING, step)

    def test_the_holds_are_six_seconds_with_a_rest_after_each(self):
        steps = P.DEFAULT_SCHEDULE
        holds = [i for i, s in enumerate(steps) if s.kind == "hold"]
        self.assertGreaterEqual(len(holds), 6)
        for i in holds:
            self.assertEqual(steps[i].seconds, 6.0, steps[i])
            self.assertEqual(steps[i + 1].kind, "rest", steps[i])
            self.assertGreaterEqual(steps[i + 1].seconds, 3.0)
            self.assertEqual(steps[i - 1].kind, "rest", steps[i])
            self.assertGreaterEqual(steps[i - 1].seconds, 2.0, "root Y at rest needs >= 1 s before the hold")
        groups = collections.Counter(F.group_of(steps[i].name) for i in holds)
        for want in ("fwd", "back", "left", "crouch_fwd", "prone_fwd"):
            self.assertEqual(groups[want], 3, "a group of three, so the half-the-median rule has a group: %s" % want)
        for i in holds:
            self.assertIn(steps[i].stance, ("stand", "crouch", "prone"), steps[i])
            self.assertTrue(steps[i].direction, steps[i])
            self.assertFalse(math.isnan(F.expected_speed(steps[i].direction, steps[i].stance)), steps[i])

    def test_the_stance_taps_are_triangle(self):
        taps = [s for s in P.DEFAULT_SCHEDULE if s.kind == "tap"]
        self.assertTrue(taps)
        self.assertTrue(all(s.buttons == ("TRIANGLE",) for s in taps))

    def test_turn_first_prepends_a_right_stick_turn_the_fit_ignores(self):
        steps = P.with_turn_first(P.DEFAULT_SCHEDULE, 1.4)
        self.assertEqual((steps[0].name, steps[0].kind, steps[0].buttons, steps[0].seconds),
                         ("turn_away", "turn", ("L",), 1.4))
        self.assertEqual(steps[1].kind, "rest")
        self.assertEqual(steps[2:], P.DEFAULT_SCHEDULE)
        self.assertEqual(P.PAD1_BINDING["L"], "RRight = Keyboard/H")
        self.assertEqual(keys.MAPS["pcsx2"]["L"], ord("H"))
        self.assertIs(P.with_turn_first(P.DEFAULT_SCHEDULE, 0), P.DEFAULT_SCHEDULE)
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(P.main(["--dry-run", "--turn-first", "1.4"]), 0)
        self.assertIn("turn_away", buf.getvalue())
        d = tempfile.mkdtemp()
        sp = os.path.join(d, "s.json")
        with open(sp, "w") as f:
            f.write('[{"name": "turn_away", "kind": "turn", "t_start": 0.0, "t_end": 1.4},'
                    ' {"name": "fwd", "kind": "hold", "t_start": 3.0, "t_end": 9.0}]')
        self.assertEqual([h.name for h in F.load_schedule(sp)], ["fwd"])

    def test_a_schedule_file_overrides_the_default(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.json")
        with open(p, "w") as f:
            f.write('[{"name": "r", "kind": "rest", "seconds": 2}, {"name": "fwd", "kind": "hold", '
                    '"buttons": ["W"], "seconds": 6}]')
        steps = P.load_steps(p)
        self.assertEqual([s.name for s in steps], ["r", "fwd"])
        self.assertEqual(steps[1].buttons, ("W",))

    def test_a_schedule_with_an_unbound_button_is_refused(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "s.json")
        with open(p, "w") as f:
            f.write('[{"name": "x", "kind": "hold", "buttons": ["NOPE"], "seconds": 1}]')
        with self.assertRaises(ValueError):
            P.load_steps(p)


ROOT_OF = {"stand": 11.484, "crouch": 5.504, "prone": 1.8}
FIRM = {"stand": "prone", "crouch": "prone", "prone": "stand"}   # the decompilation's firm-press branch


class StancePine(FakePine):
    """A fake console whose skeleton root follows a stance a firm Triangle cycles (stand/crouch -> prone -> stand);
    `swallow` presses are ignored first (a pop-up, a transition)."""

    def __init__(self, stance, swallow=0, prone_root=1.8):
        super().__init__()
        self.roots = dict(ROOT_OF, prone=prone_root)
        self.node = self.mem[self.mem[ga.address("player_actor", "r0001")] + ga.offset("root_node", "r0001")]
        self.swallow = swallow
        self.presses = []
        self.set(stance)

    def set(self, stance):
        self.stance = stance
        self.mem[self.node + 4] = fbits(self.roots[stance])

    def press(self, hwnd, button, target, hold_s=0.15):
        self.presses.append(button)
        if button == "TRIANGLE":
            if self.swallow:
                self.swallow -= 1
            else:
                self.set(FIRM[self.stance])


class SyncRecorder:
    """The Recorder's reading surface, sampling the fake on demand instead of in a thread."""

    def __init__(self, pine):
        self.sampler = P.Sampler(pine, "r0001")
        self.pine = pine
        self.t = 0.0

    def latest_t(self):
        self.t += 0.5
        return self.t

    def rest_root(self, window_s=1.0):
        return self.sampler.sample()[4]


class StanceVerifyTest(unittest.TestCase):
    def run_one(self, start, planned, swallow=0, prone_root=1.8):
        pine = StancePine(start, swallow, prone_root)
        steps = (P.Step("rest", "rest", (), 3.0), P.Step("h#1", "hold", ("W",), 6.0, planned, "fwd"))
        with redirect_stdout(io.StringIO()):
            recs = P.run_schedule(steps, SyncRecorder(pine), hwnd=None, press=pine.press, sleep=lambda s: None)
        return pine, recs[1]

    def test_the_right_stance_needs_no_tap(self):
        pine, rec = self.run_one("stand", "stand")
        self.assertEqual(pine.presses, ["W"])
        self.assertEqual((rec["stance"], rec["planned_stance"], rec["stance_taps"]), ("stand", "stand", 0))
        self.assertAlmostEqual(rec["root_y_rest"], 11.484, places=3)

    def test_a_prone_root_anywhere_under_the_crouch_band_is_prone_and_fires_no_tap(self):
        for root in (1.8, 3.5):
            pine, rec = self.run_one("prone", "prone", prone_root=root)
            self.assertEqual(pine.presses, ["W"], root)
            self.assertEqual((rec["stance"], rec["stance_taps"]), ("prone", 0), root)

    def test_a_wrong_stance_is_tapped_into_place(self):
        pine, rec = self.run_one("stand", "prone")
        self.assertEqual(pine.presses, ["TRIANGLE", "W"])
        self.assertEqual((rec["stance"], rec["stance_taps"]), ("prone", 1))

    def test_standing_from_crouch_takes_two_firm_taps(self):
        pine, rec = self.run_one("crouch", "stand")
        self.assertEqual(pine.presses, ["TRIANGLE", "TRIANGLE", "W"])
        self.assertEqual((rec["stance"], rec["stance_taps"]), ("stand", 2))

    def test_two_swallowed_taps_mark_the_hold_with_the_measured_stance(self):
        pine, rec = self.run_one("stand", "prone", swallow=2)
        self.assertEqual(pine.presses, ["TRIANGLE", "TRIANGLE", "W"])
        self.assertEqual((rec["stance"], rec["planned_stance"], rec["stance_taps"]), ("stand", "prone", 2))

    def test_crouch_is_not_tapped_for_because_a_firm_press_never_reaches_it(self):
        pine, rec = self.run_one("stand", "crouch")
        self.assertEqual(pine.presses, ["W"])
        self.assertEqual((rec["stance"], rec["planned_stance"], rec["stance_taps"]), ("stand", "crouch", 0))

    def test_the_fit_reads_the_measured_stance_back(self):
        pine, rec = self.run_one("stand", "crouch")
        d = tempfile.mkdtemp()
        sp = os.path.join(d, "s.json")
        with open(sp, "w") as f:
            json.dump([rec], f)
        self.assertEqual(F.load_schedule(sp)[0].stance, "stand")


class SampleTest(unittest.TestCase):
    def test_one_sample_walks_the_chains(self):
        pine = FakePine()
        row = P.Sampler(pine, "r0001").sample()
        self.assertIsNotNone(row)
        t, x, y, z, root_y, ms = row
        self.assertAlmostEqual(t, 12.5, places=4)
        self.assertAlmostEqual(x, 939.4, places=3)
        self.assertAlmostEqual(z, 832.2, places=3)
        self.assertAlmostEqual(root_y, 5.504, places=3)
        self.assertEqual(ms, 1.0)

    def test_a_torn_read_is_dropped(self):
        pine = FakePine(clock_steps=1)
        s = P.Sampler(pine, "r0001")
        self.assertIsNone(s.sample())
        self.assertEqual(s.torn, 1)

    def test_a_null_actor_is_no_row(self):
        pine = FakePine()
        pine.mem[ga.address("player_actor", "r0001")] = 0
        self.assertIsNone(P.Sampler(pine, "r0001").sample())

    def test_the_r0004_column_is_read_by_name(self):
        pine = FakePine("r0004")
        row = P.Sampler(pine, "r0004").sample()
        self.assertEqual(row[5], 1.0)

    def test_a_written_row_parses_back_in_the_fit(self):
        row = P.Sampler(FakePine(), "r0001").sample()
        back = F.parse_rows([F.format_row(row)])
        self.assertEqual(len(back), 1)
        self.assertAlmostEqual(back[0][1], row[1], places=3)


class PreflightTest(unittest.TestCase):
    def test_no_rows_is_not_in_play(self):
        ok, why = P.preflight([])
        self.assertFalse(ok)
        self.assertIn("no rows", why)

    def test_a_frozen_clock_is_not_in_play(self):
        ok, why = P.preflight([(5.0, 0, 0, 0, 5.5, 1.0)] * 10)
        self.assertFalse(ok)
        self.assertIn("clock", why)

    def test_move_scale_off_1_is_not_in_play(self):
        rows = [(5.0 + i / 60, 0, 0, 0, 5.5, 1.0 if i != 3 else 0.0) for i in range(30)]
        ok, why = P.preflight(rows)
        self.assertFalse(ok)
        self.assertIn("MoveScale", why)

    def test_a_running_clock_at_move_scale_1_is_in_play(self):
        ok, why = P.preflight([(5.0 + i / 60, 0, 0, 0, 5.5, 1.0) for i in range(30)])
        self.assertTrue(ok, why)


# A [Pad1] like the owner's (tools/pcsx2/inis/PCSX2.ini, read 2026-09-28) with the sections around it; the tests
# write only copies of this string, never the owner's file.
SAMPLE_INI = """[UI]
SettingsVersion = 1


[Hotkeys]
LoadStateFromSlot = Keyboard/F3
SaveStateToSlot = Keyboard/F1
TogglePause = Keyboard/Space


[Pad1]
Type = DualShock2
InvertL = 0
InvertR = 0
Deadzone = 0
AxisScale = 1.33
LargeMotorScale = 1
SmallMotorScale = 1
ButtonDeadzone = 0
PressureModifier = 0.5
Triangle = Keyboard/I
Cross = Keyboard/K
L2 = Keyboard/1
R2 = Keyboard/3
LUp = Keyboard/W
LRight = Keyboard/D
LDown = Keyboard/S
LLeft = Keyboard/A
RRight = Keyboard/H


[Pad2]
Type = None
"""


def ini_section(text, name):
    out, on = {}, False
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith("["):
            on = s == "[%s]" % name
        elif on and "=" in s:
            k, v = s.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def pcsx2_stick_byte(pressure, axis_scale):
    """PadDualshock2::Set for an analog key (PCSX2 master, pcsx2/SIO/Pad/PadDualshock2.cpp): raw = u8(value x
    AxisScale x 255), and an up push merges to ly = 127 - raw / 2."""
    raw = int(min(255.0, max(0.0, pressure * axis_scale * 255.0)))
    return raw, 127 - raw // 2


def temp_ini(text=SAMPLE_INI):
    d = tempfile.mkdtemp()
    p = os.path.join(d, "PCSX2.ini")
    with open(p, "w", newline="") as f:
        f.write(text)
    return p


class LightIniTest(unittest.TestCase):
    def test_the_temp_ini_carries_the_macros_and_the_scale(self):
        text = P.light_ini_text(SAMPLE_INI, stick=0.5, triangle=0.2)
        pad = ini_section(text, "Pad1")
        stick, tri = P.LIGHT_MACROS["W_LIGHT"], P.LIGHT_MACROS["TRIANGLE_LIGHT"]
        self.assertEqual(pad["Macro%d" % stick[2]], "Keyboard/8")
        self.assertEqual(pad["Macro%dBinds" % stick[2]], "LUp")
        self.assertEqual(pad["Macro%d" % tri[2]], "Keyboard/7")
        self.assertEqual(pad["Macro%dBinds" % tri[2]], "Triangle")
        raw, ly = pcsx2_stick_byte(float(pad["Macro%dPressure" % stick[2]]), 1.33)
        self.assertEqual((raw, ly), (127, 64), "half of the 128 steps from centre")
        traw = int(float(pad["Macro%dPressure" % tri[2]]) * 255.0)
        self.assertEqual(traw, 51)
        self.assertLess(traw / 255.0, 0.3, "a light Triangle is under 0.3")
        for k, v in ini_section(SAMPLE_INI, "Pad1").items():
            self.assertEqual(pad[k], v, "the owner's own [Pad1] lines stay")
        self.assertEqual(ini_section(text, "Hotkeys"), ini_section(SAMPLE_INI, "Hotkeys"))
        self.assertEqual(ini_section(text, "Pad2"), {"Type": "None"})

    def test_the_stick_pressure_follows_the_axis_scale(self):
        text = P.light_ini_text(SAMPLE_INI.replace("AxisScale = 1.33", "AxisScale = 1"), stick=0.5, triangle=0.2)
        pad = ini_section(text, "Pad1")
        n = P.LIGHT_MACROS["W_LIGHT"][2]
        self.assertEqual(pcsx2_stick_byte(float(pad["Macro%dPressure" % n]), 1.0), (127, 64))
        plan = P.light_plan(SAMPLE_INI, stick=0.5, triangle=0.2)
        self.assertEqual((plan["ly"], plan["push"], plan["triangle_raw"]), (64, 0.5, 51))

    def test_a_spare_key_already_bound_is_refused(self):
        with self.assertRaises(ValueError):
            P.light_ini_text(SAMPLE_INI.replace("L2 = Keyboard/1", "L2 = Keyboard/8"), 0.5, 0.2)
        with self.assertRaises(ValueError):
            P.light_ini_text(SAMPLE_INI.replace("[Pad1]", "[PadX]"), 0.5, 0.2)

    def test_a_scale_the_crouch_walk_cannot_use_is_refused(self):
        for bad in (0.0, 0.9, 1.0):
            with self.assertRaises(ValueError):
                P.light_plan(SAMPLE_INI, stick=bad, triangle=0.2)
        with self.assertRaises(ValueError):
            P.light_plan(SAMPLE_INI, stick=0.5, triangle=0.3)

    def test_the_restore_runs_on_exit(self):
        p = temp_ini()
        with open(p, "rb") as f:
            before = f.read()
        with P.LightIni(p, 0.5, 0.2):
            with open(p) as f:
                self.assertIn("Macro%dBinds = LUp" % P.LIGHT_MACROS["W_LIGHT"][2], f.read())
        with open(p, "rb") as f:
            self.assertEqual(f.read(), before)
        self.assertEqual(os.listdir(os.path.dirname(p)), ["PCSX2.ini"], "no backup left behind")

    def test_the_restore_runs_on_an_exception(self):
        p = temp_ini()
        with self.assertRaises(RuntimeError):
            with P.LightIni(p, 0.5, 0.2):
                raise RuntimeError("the run died")
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)
        self.assertEqual(os.listdir(os.path.dirname(p)), ["PCSX2.ini"])

    def test_a_sigterm_inside_the_run_restores_and_the_old_handler_returns(self):
        p = temp_ini()
        old = signal.getsignal(signal.SIGTERM)
        with self.assertRaises(SystemExit):
            with P.LightIni(p, 0.5, 0.2):
                handler = signal.getsignal(signal.SIGTERM)
                self.assertTrue(callable(handler))
                handler(signal.SIGTERM, None)
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)
        self.assertEqual(signal.getsignal(signal.SIGTERM), old)

    def test_a_stale_backup_from_a_dead_run_is_restored_first(self):
        p = temp_ini(P.light_ini_text(SAMPLE_INI, 0.5, 0.2))
        with open(p + P.LIGHT_BACKUP_SUFFIX, "w", newline="") as f:
            f.write(SAMPLE_INI)
        with redirect_stdout(io.StringIO()):
            with P.LightIni(p, 0.5, 0.2):
                pass
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)
        self.assertEqual(os.listdir(os.path.dirname(p)), ["PCSX2.ini"])


class LightScheduleTest(unittest.TestCase):
    def test_the_light_groups_carry_the_push_and_the_expected_bands(self):
        steps = P.light_schedule(0.5)
        holds = [s for s in steps if s.kind == "hold"]
        groups = collections.Counter(F.group_of(s.name) for s in holds)
        self.assertEqual(groups, {"half_fwd": 3, "crouch_walk": 3})
        for s in holds:
            self.assertEqual((s.buttons, s.direction, s.push, s.seconds), (("W_LIGHT",), "fwd", 0.5, 6.0), s)
            want = {"half_fwd": ("stand", 32.5), "crouch_walk": ("crouch", 14.0)}[F.group_of(s.name)]
            self.assertEqual((s.stance, F.expected_speed(s.direction, s.stance, s.push)), want, s)
        taps = [s for s in steps if s.kind == "tap"]
        self.assertEqual([s.buttons for s in taps], [("TRIANGLE_LIGHT",), ("TRIANGLE_LIGHT",)])
        for s in steps:
            for b in s.buttons:
                self.assertIn(b, keys.MAPS["pcsx2"], s)
                self.assertIn(b, P.PAD1_BINDING, s)
        self.assertNotIn("return", [s.kind for s in P.DEFAULT_SCHEDULE])

    def test_light_appends_the_groups_to_the_default_schedule(self):
        steps = P.schedule_for(light=0.5)
        self.assertEqual(steps[:len(P.DEFAULT_SCHEDULE)], P.DEFAULT_SCHEDULE)
        self.assertEqual(steps[len(P.DEFAULT_SCHEDULE):], P.light_schedule(0.5))
        self.assertIs(P.schedule_for(light=None), P.DEFAULT_SCHEDULE)


LIGHT = {"stand": "crouch", "crouch": "stand", "prone": "crouch"}   # a light press where FUN_005857e0 != 0


class LightStancePine(StancePine):
    def press(self, hwnd, button, target, hold_s=0.15):
        if button == "TRIANGLE_LIGHT":
            self.presses.append(button)
            self.set(LIGHT[self.stance])
        else:
            super().press(hwnd, button, target, hold_s)


class LightStanceTest(unittest.TestCase):
    def run_one(self, start, planned):
        pine = LightStancePine(start)
        steps = (P.Step("rest", "rest", (), 3.0), P.Step("h#1", "hold", ("W_LIGHT",), 6.0, planned, "fwd", 0.5))
        with redirect_stdout(io.StringIO()):
            recs = P.run_schedule(steps, SyncRecorder(pine), hwnd=None, press=pine.press, sleep=lambda s: None,
                                  light=True)
        return pine, recs[1]

    def test_crouch_is_reached_with_a_light_tap(self):
        pine, rec = self.run_one("stand", "crouch")
        self.assertEqual(pine.presses, ["TRIANGLE_LIGHT", "W_LIGHT"])
        self.assertEqual((rec["stance"], rec["stance_taps"], rec["push"]), ("crouch", 1, 0.5))

    def test_stand_from_crouch_is_one_light_tap(self):
        pine, rec = self.run_one("crouch", "stand")
        self.assertEqual(pine.presses, ["TRIANGLE_LIGHT", "W_LIGHT"])
        self.assertEqual((rec["stance"], rec["stance_taps"]), ("stand", 1))

    def test_prone_still_takes_a_firm_tap(self):
        pine, rec = self.run_one("stand", "prone")
        self.assertEqual(pine.presses, ["TRIANGLE", "W_LIGHT"])
        self.assertEqual(rec["stance"], "prone")


class LightMainTest(unittest.TestCase):
    def test_dry_run_light_prints_the_plan_with_the_scale_and_touches_nothing(self):
        p = temp_ini()
        st = os.stat(p)
        out = tempfile.mkdtemp()
        r = subprocess.run([sys.executable, "-m", "tools_py.parity.seal_speed_probe", "--dry-run", "--light",
                            "--pcsx2-ini", p, "--out-dir", out], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        for want in ("light stick 0.50", "Keyboard/8", "Keyboard/7", "LUp", "Macro%dPressure" %
                     P.LIGHT_MACROS["W_LIGHT"][2], "half_fwd#1", "crouch_walk#3", "32.5 (push 0.50)",
                     "14.0 (crouch walk, push 0.50)", "TRIANGLE_LIGHT", "restored"):
            self.assertIn(want, r.stdout)
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)
        self.assertEqual(os.stat(p).st_mtime_ns, st.st_mtime_ns)
        self.assertEqual(os.listdir(os.path.dirname(p)), ["PCSX2.ini"])
        self.assertEqual(os.listdir(out), [])

    def test_light_refuses_to_attach(self):
        called = []
        err = io.StringIO()
        with redirect_stderr(err):
            rc = P.main(["--light", "--pcsx2-ini", temp_ini()], attach=lambda *a: called.append(a))
        self.assertEqual(rc, 2)
        self.assertEqual(called, [])
        self.assertIn("--slot", err.getvalue())

    def test_the_launch_sees_the_temp_ini_and_the_owner_file_comes_back_after_the_kill(self):
        p = temp_ini()
        seen = []

        def cleanup():
            with open(p) as f:
                seen.append(("cleanup", "Macro" in f.read()))

        def launch(a):
            with open(p) as f:
                seen.append(("launch", "Macro%dBinds = Triangle" % P.LIGHT_MACROS["TRIANGLE_LIGHT"][2] in f.read()))
            return FakePine(), 1, cleanup

        d = tempfile.mkdtemp()
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            rc = P.main(["--slot", "8", "--light", "--pcsx2-ini", p, "--out-dir", d], launch=launch)
        self.assertEqual(rc, 3, "the fake clock never advances: preflight fails")
        self.assertEqual(seen, [("launch", True), ("cleanup", True)], "PCSX2 is killed before the restore")
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)

    def test_a_launch_that_raises_still_restores(self):
        p = temp_ini()

        def launch(a):
            raise RuntimeError("no PINE")

        with self.assertRaises(RuntimeError), redirect_stdout(io.StringIO()):
            P.main(["--slot", "8", "--light", "--pcsx2-ini", p], launch=launch)
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)


class FakeProc:
    """A spawned PCSX2 stand-in: alive until killed."""

    def __init__(self):
        self.alive = True


class LightFixRoundTest(unittest.TestCase):
    """The review of fcdc516a: the kill before the restore, a refused or failed restore is loud and keeps the
    backup, the stance warning, a push hold without a stance, a second light level."""

    def test_a_launch_that_raises_after_the_spawn_kills_before_the_restore(self):
        p = temp_ini()
        proc = FakeProc()
        events = []

        def kill(pr):
            with open(p) as f:
                events.append(("kill", "Macro" in f.read()))
            pr.alive = False

        def boot(pr):
            events.append(("boot", pr.alive))
            raise KeyboardInterrupt      # a Ctrl+C in the PINE wait

        with self.assertRaises(KeyboardInterrupt):
            with P.LightIni(p, 0.5, 0.2, alive=lambda: proc.alive):
                P.guarded_launch(lambda: proc, boot, kill)
        self.assertEqual(events, [("boot", True), ("kill", True)], "PCSX2 is killed while the macros are in")
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)
        self.assertEqual(os.listdir(os.path.dirname(p)), ["PCSX2.ini"])

    def test_a_good_launch_returns_a_cleanup_that_kills(self):
        proc = FakeProc()
        killed = []
        pine, hwnd, cleanup = P.guarded_launch(lambda: proc, lambda pr: ("pine", 7), killed.append)
        self.assertEqual((pine, hwnd, killed), ("pine", 7, []))
        cleanup()
        self.assertEqual(killed, [proc])

    def test_a_restore_while_pcsx2_lives_is_refused_loudly_and_keeps_the_backup(self):
        p = temp_ini()
        err = io.StringIO()
        li = P.LightIni(p, 0.5, 0.2, alive=lambda: True)
        try:
            with self.assertRaises(RuntimeError), redirect_stderr(err):
                with li:
                    pass
            self.assertIn("still running", err.getvalue())
            self.assertIn(p + P.LIGHT_BACKUP_SUFFIX, err.getvalue())
            with open(p + P.LIGHT_BACKUP_SUFFIX) as f:
                self.assertEqual(f.read(), SAMPLE_INI, "the backup is kept")
            with open(p) as f:
                self.assertIn("Macro", f.read())
        finally:
            li.alive = lambda: False
            li.restore()
            atexit.unregister(li.restore)
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)

    def test_a_failed_restore_is_loud_reraises_and_keeps_the_backup_and_the_exit_hook(self):
        p = temp_ini()
        err = io.StringIO()
        li = P.LightIni(p, 0.5, 0.2)
        try:
            with mock.patch.object(P.os, "replace", side_effect=OSError("locked")):
                with self.assertRaises(OSError), redirect_stderr(err):
                    with li:
                        pass
            msg = err.getvalue()
            self.assertIn("STILL the modified copy", msg)
            self.assertIn(p + P.LIGHT_BACKUP_SUFFIX, msg)
            self.assertIn("copy %s over it" % (p + P.LIGHT_BACKUP_SUFFIX), msg)
            self.assertTrue(os.path.exists(p + P.LIGHT_BACKUP_SUFFIX))
            self.assertFalse(li.restored)
        finally:
            li.restore()
            atexit.unregister(li.restore)
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)

    def test_a_full_push_hold_in_the_wrong_stance_still_warns(self):
        pine = StancePine("stand")
        steps = (P.Step("rest", "rest", (), 3.0), P.Step("h#1", "hold", ("W",), 6.0, "crouch", "fwd"))
        buf = io.StringIO()
        with redirect_stdout(buf):
            P.run_schedule(steps, SyncRecorder(pine), hwnd=None, press=pine.press, sleep=lambda s: None)
        self.assertIn("stance stand where crouch was planned", buf.getvalue())

    def test_a_push_hold_without_a_stance_plays(self):
        pine = StancePine("stand")
        steps = (P.Step("h#1", "hold", ("W_LIGHT",), 6.0, None, "fwd", 0.5),)
        with redirect_stdout(io.StringIO()):
            recs = P.run_schedule(steps, SyncRecorder(pine), hwnd=None, press=pine.press, sleep=lambda s: None)
        self.assertEqual(recs[0]["push"], 0.5)
        self.assertNotIn("stance", recs[0])
        self.assertEqual(pine.presses, ["W_LIGHT"])

    def test_a_second_light_level_at_0_75(self):
        plan = P.light_plan(SAMPLE_INI, stick=0.75, triangle=0.2)
        self.assertEqual((plan["stick_raw"], plan["ly"], plan["push"]), (191, 32, 0.75))
        pad = ini_section(P.light_ini_text(SAMPLE_INI, 0.75, 0.2), "Pad1")
        n = P.LIGHT_MACROS["W_LIGHT"][2]
        self.assertEqual(pcsx2_stick_byte(float(pad["Macro%dPressure" % n]), 1.33), (191, 32))
        self.assertEqual(F.expected_speed("fwd", "stand", 0.75), 48.75)
        self.assertEqual(F.expected_speed("fwd", "crouch", 0.75), 14.0)
        p = temp_ini()
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(P.main(["--dry-run", "--light", "0.75", "--pcsx2-ini", p]), 0)
        self.assertIn("light stick 0.75", buf.getvalue())
        self.assertIn("ly 32 (0x20)", buf.getvalue())
        self.assertIn("14.0 (crouch walk, push 0.75)", buf.getvalue())
        with open(p) as f:
            self.assertEqual(f.read(), SAMPLE_INI)


if __name__ == "__main__":
    unittest.main()
