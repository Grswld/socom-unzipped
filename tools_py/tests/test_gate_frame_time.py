"""Sprint 13 Task V4: the mission stage's FRAME line and the informational frame-time pin (S13-R3).

The gate's mission stage sets PS2X_PC_SAMPLER=1, so its game log carries a `[pc-sampler]` row a second with
`t=` (host seconds) and `vsync=` (the guest VBlank count, paced by the GL back-pressure). tools_py/parity/
frame_time.py reads VBlank pacing -- host ms per guest VBlank, a lower bound on the time between presents (not
the present rate: docs/KNOWN.md §1's two-instance clock row keeps VBlanks, GL presents and the game's draw
rate apart) -- over the scripted walk, the HUD step to the drive's last step; the gate prints it as
`FRAME mean=<ms> worst1s=<ms> n=<VBlanks>` on the summary and records it in the run's pins.json as an
informational pin that is never compared (S13-R3: no refusal until three gates agree on its spread).

The fixture is s13_proof4_gate's (2026-09-25, 3/3 PINS MATCH on f90eeec0...): its mission.game.log's sampler
rows from t=310 s (the HUD step is at 320.7 s, the last step s48 at 388.8 s) and the three drive-log lines that
name the HUD step and the last step, saved as .txt because *.log is git-ignored. Over the whole stamp the reader
gives the same numbers as over the fixture (walk 21.86/30.30/3067; the tail it leaves out 36.28/41.67/2510).
"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from tools_py.parity import frame_time, gate, pins
from tools_py.tests.test_gate_pins import _LaunchCase

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "gate", "frame_s13_proof4")
DRIVE = os.path.join(FIXTURE, "mission.drive.txt")
GAME = os.path.join(FIXTURE, "mission.game.txt")
PROOF4_LINE = ("FRAME mean=21.86 worst1s=30.30 n=3067 (VBlank pacing: host ms per guest VBlank, a lower bound on "
               "the time between presents; the scripted walk, sampler t=321.2 s (the HUD step) to t=388.3 s (the "
               "last step), 67 windows)")

# Sprint 17 F0 (b): the game's own frame rate. With PS2X_VU_STATS=1 the runtime prints a [vu1-stats] line a second
# (ps2_vu1_core.cpp, the print after s_lastSyncV) whose `syncv/s=` field is the game's own draw rate; the line has no
# clock, so frame_time attributes each one to the [pc-sampler] row before it. The proof4 fixture predates the knob,
# so these lines are planted into a copy of it: 58.0 after the row at 310.2 s (before the HUD step at 320.7 s),
# 29.0, 31.0 and 30.0 inside the walk.
VU1_LINE = ("[vu1-stats] programs/s=1210 cycles/s=5812345 host=212 ms/s (36.5 ns/cycle) flips/s=%.1f syncv/s=%.1f "
            "thread=240 ms/s proc=260 ms/s interp-programs/s=0 handbacks/s=3 vu0/s=0 native-entered/s=1200 "
            "native-ended/s=1190 native-handbacks/s=10\n")
PLANTED_SYNCV = ((310.0, 58.0), (330.0, 29.0), (350.0, 31.0), (370.0, 30.0))


def game_log_with_vu1_stats(path, planted=PLANTED_SYNCV, head=()):
    """A copy of the proof4 game log at `path` with a [vu1-stats] line after the first sampler row at or past each
    planted t; `head` lines go before the first row (stats printed before the sampler's first sample)."""
    todo = sorted(planted)
    with open(GAME, encoding="utf-8") as src, open(path, "w", encoding="utf-8") as dst:
        dst.writelines(head)
        for line in src:
            dst.write(line)
            m = frame_time.SAMPLER_RE.search(line)
            while m and todo and float(m.group(1)) >= todo[0][0]:
                dst.write(VU1_LINE % (todo[0][1], todo[0][1]))
                todo.pop(0)
    assert not todo, todo
    return path


class Reader(unittest.TestCase):
    def test_the_saved_stamps_numbers(self):
        ft, why = frame_time.read(DRIVE, GAME)
        self.assertIsNone(why)
        self.assertAlmostEqual(ft.mean_ms, 21.86, places=2)
        self.assertAlmostEqual(ft.worst_ms, 30.30, places=2)
        self.assertEqual(ft.n, 3067)
        self.assertEqual(ft.windows, 67)
        self.assertAlmostEqual(ft.start_t, 321.2, places=1, msg="the first row at or after the HUD step's 320.7 s")
        self.assertAlmostEqual(ft.end_t, 388.3, places=1, msg="the last row at or before the last step's 388.8 s")
        self.assertEqual(frame_time.line(ft), PROOF4_LINE)

    def test_the_unscripted_tail_is_not_the_gates_number(self):
        tail, why = frame_time.read_tail(DRIVE, GAME)
        self.assertIsNone(why)
        self.assertEqual((round(tail.mean_ms, 2), round(tail.worst_ms, 2), tail.n, tail.windows),
                         (36.28, 41.67, 2510, 91))

    def test_the_hud_ref_is_the_gates(self):
        self.assertEqual(frame_time.HUD_REF_NAME, gate.HUD_REF_NAME)

    def test_a_window_with_no_vblank_is_folded_into_the_next_one(self):
        ft = frame_time.measure([(0.0, 0), (1.0, 60), (2.0, 60), (3.0, 61)], 0.0)
        self.assertEqual(ft.n, 61)
        self.assertAlmostEqual(ft.worst_ms, 2000.0)
        self.assertAlmostEqual(ft.mean_ms, 3000.0 / 61)

    def test_rows_before_the_hud_and_after_the_last_step_are_not_counted(self):
        ft = frame_time.measure([(0.0, 0), (1.0, 10), (2.0, 70), (3.0, 130), (4.0, 140)], 1.5, 3.5)
        self.assertEqual((ft.n, round(ft.mean_ms, 2)), (60, 16.67))

    def test_no_hud_is_no_data(self):
        tmp = tempfile.mkdtemp()
        try:
            drive = os.path.join(tmp, "d.txt")
            with open(drive, "w") as f:
                f.write("untilref(scripts/parity/ref_hud_ours.png): 9 presses, dist=40.0 matched=False\n")
            ft, why = frame_time.read(drive, GAME)
            self.assertIsNone(ft)
            self.assertEqual(frame_time.line(ft, why), "FRAME NO-DATA (HUD not reached in the drive log)")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class SyncvReader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_the_walks_vu1_stats_lines_are_averaged_and_the_one_before_the_hud_is_not(self):
        game = game_log_with_vu1_stats(os.path.join(self.tmp, "g.txt"))
        self.assertEqual(frame_time.read_syncv(game, 320.7, 388.8), 30.0)
        sv = frame_time.syncv(game, 320.7, 388.8)
        self.assertEqual((sv.mean, sv.n), (30.0, 3))
        self.assertEqual(frame_time.syncv_line(sv), "SYNCV mean=30.0/s n=3 (the game's own frame rate: [vu1-stats] "
                                                    "syncv/s over the scripted walk)")

    def test_a_log_with_no_vu1_stats_lines_reads_none(self):
        self.assertIsNone(frame_time.read_syncv(GAME, 320.7, 388.8))

    def test_a_stats_line_before_the_first_sampler_row_has_no_clock_and_is_not_counted(self):
        game = game_log_with_vu1_stats(os.path.join(self.tmp, "g.txt"), head=[VU1_LINE % (99.0, 99.0)])
        self.assertEqual(frame_time.syncv(game, 0.0, 1000.0).n, 4, "the four planted after rows, not the head one")

    def test_the_stamp_reader_uses_the_drive_logs_walk(self):
        shutil.copyfile(DRIVE, os.path.join(self.tmp, "mission.drive.log"))
        game_log_with_vu1_stats(os.path.join(self.tmp, "mission.game.log"))
        sv, why = frame_time.read_syncv_stamp(self.tmp)
        self.assertIsNone(why)
        self.assertEqual((sv.mean, sv.n), (30.0, 3))

    def test_the_gate_and_the_ladder_set_the_vu_stats_knob(self):
        self.assertEqual(gate.launch_env("mission", "card", base={}, default_ok=True).get("PS2X_VU_STATS"), "1")
        self.assertNotIn("PS2X_VU_STATS", gate.launch_env("title", "card", base={}, default_ok=True))
        self.assertEqual(gate.launch_env("mission", "card", base={"PS2X_VU_STATS": "0"},
                                         default_ok=True)["PS2X_VU_STATS"], "0", "an operator's own value wins")
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        with open(os.path.join(root, "scripts", "parity", "ladder_frostfire.sh"), encoding="utf-8") as f:
            self.assertRegex(f.read(), r"(?m)^export PS2X_VU_STATS=1\b")


class GateFrameLine(_LaunchCase):
    """main() with the mission stage mocked: it leaves the fixture's logs where run_gate leaves a live run's."""

    def _stage(self, game=GAME):
        def stage(name, out_root):
            shutil.copyfile(DRIVE, os.path.join(out_root, "mission.drive.log"))
            shutil.copyfile(game, os.path.join(out_root, "mission.game.log"))
            return True, "ok mission"
        return stage

    def _run(self, game=GAME, argv=()):
        out = io.StringIO()
        with mock.patch.object(gate, "run_gate", side_effect=self._stage(game)), contextlib.redirect_stdout(out):
            rc = gate.main(["--stamp", self.stamp, "--only", "mission"] + list(argv))
        return rc, out.getvalue()

    def _record(self):
        with open(os.path.join(self.out_root, pins.RECORD_NAME)) as f:
            return json.load(f)

    def _standard_names(self, **extra):
        with open(self.expected) as f:
            doc = json.load(f)
        doc["pins"].update(extra)
        with open(self.expected, "w") as f:
            json.dump(doc, f)

    def test_the_mission_summary_carries_the_frame_line_and_the_informational_pin(self):
        rc, out = self._run()
        self.assertEqual(rc, 0, out)
        summary = self._summary()
        self.assertIn("\n" + PROOF4_LINE + "\n", summary)
        self.assertIn("PIN frame mean_ms=21.86 worst1s_ms=30.30 n=3067 recorded (informational, S13-R3", summary)
        self.assertIn(PROOF4_LINE, out)
        info = self._record()["informational"]
        self.assertEqual((info["frame_mean_ms"], info["frame_worst_ms"], info["frame_n"]), (21.86, 30.30, 3067))
        self.assertNotIn("frame", self._record()["pins"], "the frame numbers are not a pin the standard can hold")

    def test_the_mission_summary_carries_the_syncv_line_and_the_record_its_mean(self):
        rc, out = self._run(game_log_with_vu1_stats(os.path.join(self.tmp, "vu1.txt")))
        self.assertEqual(rc, 0, out)
        summary = self._summary()
        self.assertIn("\nSYNCV mean=30.0/s n=3 ", summary)
        self.assertIn("SYNCV mean=30.0/s n=3 ", out)
        self.assertLess(summary.index(PROOF4_LINE), summary.index("SYNCV mean="), "next to FRAME, after it")
        info = self._record()["informational"]
        self.assertEqual(info["syncv_mean"], 30.0)
        self.assertEqual(info["frame_mean_ms"], 21.86, "the frame record is unchanged beside it")
        self.assertNotIn("syncv", " ".join(self._record()["pins"]), "informational, never a pin")
        self.assertIn("PINS MATCH", summary)

    def test_a_mission_with_no_vu1_stats_lines_says_so_and_records_no_syncv(self):
        rc, out = self._run()
        self.assertEqual(rc, 0, out)
        self.assertIn("SYNCV NO-DATA (no [vu1-stats] syncv/s line in the walk", self._summary())
        self.assertNotIn("syncv_mean", self._record()["informational"])

    def test_a_differing_frame_time_does_not_fail_the_gate(self):
        rc, out = self._run()
        self.assertEqual(rc, 0, out)
        # A second run whose frame time differs: only the rows from 40 s after the HUD step.
        slow = os.path.join(self.tmp, "slow.txt")
        with open(GAME) as src, open(slow, "w") as dst:
            dst.writelines(l for l in src if float(l.split(" t=", 1)[1].split()[0]) >= 360.0)
        # ... and a standard that somehow names the frame pin: still never compared.
        self._standard_names(frame="21.86")
        rc, out = self._run(slow)
        self.assertEqual(rc, 0, out)
        summary = self._summary()
        self.assertIn("FRAME mean=", summary)
        self.assertNotIn("FRAME mean=21.86 ", summary)
        self.assertIn("recorded (informational, S13-R3", summary)
        self.assertIn("PINS MATCH", summary)
        self.assertEqual(self._record()["drifted"], [])

    def test_accept_pins_never_writes_a_frame_entry_into_the_standard(self):
        # A drifted reference so that --accept-pins rewrites the standard, and a stray `frame` entry in it.
        self._standard_names(**{"frame": "21.86", "scripts/parity/ref_hud_ours.png": "ff" * 32})
        rc, out = self._run(argv=["--accept-pins"])
        self.assertEqual(rc, 0, out)
        standard = pins.load_expected(self.expected)
        self.assertNotEqual(standard["scripts/parity/ref_hud_ours.png"], "ff" * 32, "the standard was rewritten")
        self.assertEqual([k for k in standard if k.startswith("frame")], [])

    def test_a_mission_with_no_sampler_rows_is_recorded_as_no_data_and_passes(self):
        empty = os.path.join(self.tmp, "empty.txt")
        open(empty, "w").close()
        rc, out = self._run(empty)
        self.assertEqual(rc, 0, out)
        summary = self._summary()
        self.assertIn("FRAME NO-DATA (no [pc-sampler] rows in the game log)", summary)
        self.assertIn("PIN frame absent (informational, S13-R3", summary)

    def test_a_stage_list_without_the_mission_prints_no_frame_line(self):
        rc, out, _ = self._main([])
        self.assertEqual(rc, 0, out)
        self.assertNotIn("FRAME", self._summary())


class BaselineFrameLine(_LaunchCase):
    def test_a_re_score_prints_the_saved_stamps_frame_line(self):
        os.makedirs(self.out_root)
        shutil.copyfile(DRIVE, os.path.join(self.out_root, "mission.drive.log"))
        shutil.copyfile(GAME, os.path.join(self.out_root, "mission.game.log"))
        out = io.StringIO()
        with mock.patch.object(gate, "score_mission_log", return_value=(True, "m")), contextlib.redirect_stdout(out):
            rc = gate.main(["--baseline", self.out_root, "--revision", "r0001"])
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn(PROOF4_LINE, out.getvalue())


if __name__ == "__main__":
    unittest.main()
