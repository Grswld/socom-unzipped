"""The SEAL speed probe's driver skeleton (web sprint 2, Task W2.2c), without a console.

--dry-run must print the plan and exit 0 without touching PCSX2; the schedule must name only keys PCSX2's [Pad1]
binds; one sample must walk the pointer chains through a fake PINE and refuse a torn read. No game, no PINE
socket, no window: the fake below is a dict of guest words.
"""
import collections
import io
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

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


if __name__ == "__main__":
    unittest.main()
