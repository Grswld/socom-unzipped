import argparse
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

from tools_py.parity import black_rows, drive, gate, screen_bands

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "gate")   # committed: runs on a fresh clone
# The save inside the pristine card, not just the directory that holds it: run_gate copies the card and the
# case below reads this file out of the copy. The socom-linux VM has the ISO but not the card, and a guard on
# the directory alone let the case run there and fail on a missing file instead of skipping (2026-09-22).
PRISTINE_CARD_SAVE = os.path.join(ROOT, gate.PRISTINE_CARD, "BASCUS-97275SOCOMII", "BASCUS-97275SOCOMII")
TITLE_FIXTURE_RUN = os.path.join(FIXTURES, "title")
TRANSITION_FIXTURE_RUN = os.path.join(FIXTURES, "transition")
GOOD_MISSION_FIXTURE = os.path.join(FIXTURES, "mission", "good.drive.txt")
BAD_MISSION_FIXTURE = os.path.join(FIXTURES, "mission", "bad.drive.txt")
# R30 (2026-09-13): the mission verdict now reads the hold captures, not only the drive log.
# s3a: HUD after 4 presses, holds are gameplay. dbuff (s5_task4_dbuff): the HUD untilref "matched" the
# letterboxed intro cinematic with 0 presses; its holds are that cinematic; its final.png is gameplay
# behind a HELP pop-up. 320x224 palette PNGs built by make_gate_fixtures.build_mission_frame_fixtures.
S3A_MISSION_LOG = os.path.join(FIXTURES, "mission", "s3a.drive.txt")
S3A_MISSION_RUN = os.path.join(FIXTURES, "mission", "s3a")
DBUFF_MISSION_LOG = os.path.join(FIXTURES, "mission", "dbuff.drive.txt")
DBUFF_MISSION_RUN = os.path.join(FIXTURES, "mission", "dbuff")
HUD_REF = os.path.join(ROOT, "scripts", "parity", "ref_hud_ours.png")
# Sprint 13 H7 (harness audit #35): the real runs below used to be the only witness for five cases, which then ran
# on the owner's machine alone. make_gate_fixtures' real_mission / real_transition builders reduced them from the
# archives (each fixture checked to reach its source's verdict): frozen = s5_gatefix (R34, 0 live hold pairs),
# failed = s5_head_1x_b (the MISSION FAILURE screen; its banner frame at the source's 640x451), probe5 = gameplay_probe5's
# captures beside good.drive.txt, and the transition runs tfix3 (clean, 18 frames) and wcap2 (stalled at the dialog).
# Identical captures are stored once and listed in the fixture's shared.txt; _mission_run() materializes the run.
FROZEN_MISSION_LOG = os.path.join(FIXTURES, "mission", "frozen.drive.txt")
FROZEN_MISSION_RUN = os.path.join(FIXTURES, "mission", "frozen")
FAILED_MISSION_LOG = os.path.join(FIXTURES, "mission", "failed.drive.txt")
FAILED_MISSION_RUN = os.path.join(FIXTURES, "mission", "failed")
PROBE5_MISSION_RUN = os.path.join(FIXTURES, "mission", "probe5")


def _score_fixture_run(log, fixture_dir):
    """score_mission_log over a fixture with its shared.txt expanded (make_gate_fixtures.materialize)."""
    from tools_py.parity.make_gate_fixtures import materialize
    with tempfile.TemporaryDirectory() as tmp:
        return gate.score_mission_log(log, materialize(fixture_dir, os.path.join(tmp, "mission")))
CLEAN_TRANSITION_FIXTURE = os.path.join(FIXTURES, "transition_runs", "tfix3")
STALLED_TRANSITION_FIXTURE = os.path.join(FIXTURES, "transition_runs", "wcap2")

# git-ignored real-run logs, kept locally: extra coverage when present, but never required.
GOOD_TITLE_RUN = os.path.join(ROOT, "logs", "parity", "runs", "vr_title")               # known clean (STATUS 2026-09-10 17:40)
# drive.py stdout (not the game's own run log) is what carries `matched=True`; this run reached the HUD.
GOOD_MISSION_LOG = os.path.join(ROOT, "logs", "parity", "drive_gameplay_probe5.txt")    # known reached HUD (STATUS 2026-09-09 13:30)
GOOD_MISSION_FRAMES = os.path.join(ROOT, "logs", "parity", "runs", "gameplay_probe5")   # its captures; holds are gameplay
FULL_DBUFF_RUN = os.path.join(ROOT, "logs", "parity", "gate", "s5_task4_dbuff")          # full-size originals of the dbuff fixture
# R34: runs whose hold captures are gameplay but frozen (the present loop stalled after gameplay start: 43 / 36
# latest_frame exports after the first guest fault, against ~1400 in s3a), and live references.
FROZEN_RUNS = [os.path.join(ROOT, "logs", "parity", "gate", r) for r in ("s5_gatefix", "mission4")]
LIVE_RUNS = [os.path.join(ROOT, "logs", "parity", "gate", r) for r in ("s3a", "famb", "native_on")]
# Live, but the mission was lost on screen: s3d_2x_host's s38/s40 holds and s5_head_1x_b's final frame are the
# MISSION FAILURE statistics screen (Sprint 6 Task 1a). Both read as gameplay to the band test; s3d_2x_host was
# in LIVE_RUNS until the failure-screen check landed.
FAILED_ON_SCREEN_RUNS = [os.path.join(ROOT, "logs", "parity", "gate", r) for r in ("s3d_2x_host", "s5_head_1x_b")]
BAD_MISSION_LOG = os.path.join(ROOT, "logs", "parity", "vr_gameplay.drive.log")         # known FAIL: HUD never matched
# Sprint 6 Task 1: the three lock-free scorers wired into score_mission_log. failure_screen.png is the
# s5_head_1x_b MISSION FAILURE screen; gameplay_spawn.png is s6_depth_m2's s28 (the spawn view with the
# grey water shards); console_spawn_slot8.png is the PCSX2 slot-8 screenshot of the same view.
MISSION_FIXTURES = os.path.join(ROOT, "tools_py", "tests", "fixtures", "mission")
FAILURE_SCREEN = os.path.join(MISSION_FIXTURES, "failure_screen.png")
GAMEPLAY_SPAWN = os.path.join(MISSION_FIXTURES, "gameplay_spawn.png")
CONSOLE_SPAWN = os.path.join(ROOT, "scripts", "parity", "refs", "console_spawn_slot8.png")
GUEST_PROBE_CONSOLE = os.path.join(ROOT, "scripts", "parity", "guest_probe_console.json")
# A stand-in game image: guest_addresses.launch_revision reads the build banner and nothing else, so a
# file carrying one is all a test of the gate's revision wiring needs (`% b"r0004 10:14:38 Nov  3 2004"`).
BANNER_STAND_IN = b"\x7fELF" + b"\0" * 64 + b"SOCOM 2 %s\0" + b"\0" * 64
# A real HUD capture from a gate run; /logs/ is gitignored, so it is only on a host that has run one.
HUD_FRAME_S6_GAMEPAD4 = os.path.join(ROOT, "logs", "parity", "gate", "s6_gamepad4", "mission", "s28_none.png")
CLEAN_TRANSITION_RUN = os.path.join(ROOT, "logs", "parity", "gate", "tfix3", "transition")   # 18 frames at/after the burst step
# Pre-fix run: the probe stalled on the "save to memory card?" dialog, so it has black frames
# from the boot and none at/after its burst step (gate.py TRANSITION_MIN_FRAMES).
STALLED_TRANSITION_RUN = os.path.join(ROOT, "logs", "parity", "gate", "wcap2", "transition")


class WaitCaptures(unittest.TestCase):
    """drive.wait_capturer is what puts the mid-wait frames on disk for black_rows.py to score
    (gate.TRANSITION_MIN_FRAMES); check the cadence and the names without a game window."""

    def _run(self, elapsed_values, period=1.0):
        grabs = []
        real_grab = drive.winshot.grab
        drive.winshot.grab = lambda hwnd: Image.new("RGB", (640, 448), (0, 0, 0))
        try:
            with tempfile.TemporaryDirectory() as out:
                on_frame = drive.wait_capturer(out, hwnd=None, step=3, period=period)
                for e in elapsed_values:
                    on_frame(e)
                grabs = sorted(os.listdir(out))
        finally:
            drive.winshot.grab = real_grab
        return grabs

    def test_one_capture_per_period(self):
        """Polls land every 0.25 s; one frame per second of the wait, named w<step>_<k>.png."""
        self.assertEqual(self._run([0.25, 0.5, 0.75, 1.0, 1.25, 2.1, 2.4]),
                         ["w03_000.png", "w03_001.png", "w03_002.png"])

    def test_short_wait_still_captures_once(self):
        self.assertEqual(self._run([0.25]), ["w03_000.png"])

    def test_failed_grab_does_not_raise(self):
        """A capture is a diagnostic: a grab that fails must not take a 170 s gate run down."""
        real_grab = drive.winshot.grab

        def boom(hwnd):
            raise RuntimeError("window gone")

        drive.winshot.grab = boom
        try:
            with tempfile.TemporaryDirectory() as out:
                on_frame = drive.wait_capturer(out, hwnd=None, step=0)
                on_frame(0.25)
                on_frame(1.5)
                self.assertEqual(os.listdir(out), [])
        finally:
            drive.winshot.grab = real_grab


class TitleScoring(unittest.TestCase):
    def test_fixture_run_passes(self):
        """tests/fixtures/gate/title/: s00..s15 of the known-clean vr_title run, 320x224
        (256-colour palette PNGs; see tools_py/parity/make_gate_fixtures.py). All 16 must score
        >= TITLE_MIN_SCORE for this to hit the >= 16 floor."""
        ok, detail = gate.score_title(TITLE_FIXTURE_RUN)
        self.assertTrue(ok, detail)

    def test_empty_dir_fails(self):
        ok, detail = gate.score_title(os.path.join(ROOT, "logs"))
        self.assertFalse(ok)

    @unittest.skipUnless(os.path.isdir(GOOD_TITLE_RUN), "needs logs/parity/runs/vr_title")
    def test_known_clean_run_passes(self):
        ok, detail = gate.score_title(GOOD_TITLE_RUN)
        self.assertTrue(ok, detail)

    def test_wait_frames_are_not_title_captures(self):
        """drive.py also writes w<NN>_<kkk>.png during its settle waits (Task 8). Those are
        mid-wait frames, not the settled screen a step captures, so the title scorer must keep
        globbing s[0-9][0-9]_*.png only: a black w00_000.png dropped into a clean run must not
        appear in the score list nor change the verdict."""
        with tempfile.TemporaryDirectory() as tmp:
            run = os.path.join(tmp, "title")
            shutil.copytree(TITLE_FIXTURE_RUN, run)
            before_ok, before_detail = gate.score_title(run)
            Image.new("RGB", (640, 448), (0, 0, 0)).save(os.path.join(run, "w00_000.png"))
            after_ok, after_detail = gate.score_title(run)
        self.assertNotIn("w00", after_detail)
        self.assertEqual(before_detail, after_detail)
        self.assertEqual(before_ok, after_ok)


class MissionScoring(unittest.TestCase):
    def test_fixture_good_log_without_frames_is_no_data(self):
        """tests/fixtures/gate/mission/good.drive.txt: the untilref(...matched=True) line and the >= 3
        sNN_hold lines, trimmed from drive_gameplay_probe5.txt. Before R30 that log alone was a PASS;
        a log proves the script ran, not that its holds were gameplay, so with no captures to look at
        the verdict is FAIL with NO-DATA."""
        ok, detail = gate.score_mission_log(GOOD_MISSION_FIXTURE)
        self.assertFalse(ok, detail)
        self.assertIn("NO-DATA", detail)

    def test_fixture_bad_log_fails(self):
        ok, detail = gate.score_mission_log(BAD_MISSION_FIXTURE, S3A_MISSION_RUN)
        self.assertFalse(ok)

    def test_s3a_gameplay_holds_pass(self):
        ok, detail = gate.score_mission_log(S3A_MISSION_LOG, S3A_MISSION_RUN)
        self.assertTrue(ok, detail)
        self.assertIn("3/3 hold captures are gameplay", detail)
        self.assertIn("2 live hold pairs", detail)

    def test_frozen_gameplay_holds_fail(self):
        """R34: gameplay on screen is not a live game. s5_gatefix and mission4 held W/R1/L over a frame the
        runtime had stopped presenting; the band test passed every hold. Byte-identical gameplay holds
        (the s3a s30 fixture copied over s32 and s34) must fail the liveness check."""
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("s30_holdW.png", "s32_holdR1.png", "s34_holdR1.png"):
                shutil.copyfile(os.path.join(S3A_MISSION_RUN, "s30_holdW.png"), os.path.join(tmp, name))
            ok, detail = gate.score_mission_log(S3A_MISSION_LOG, tmp)
        self.assertFalse(ok, detail)
        self.assertIn("3/3 hold captures are gameplay", detail)
        self.assertIn("0 live hold pairs", detail)

    def test_one_live_pair_is_not_enough(self):
        with tempfile.TemporaryDirectory() as tmp:
            for src, dst in (("s30_holdW.png", "s30_holdW.png"), ("s32_holdR1.png", "s32_holdR1.png"),
                             ("s32_holdR1.png", "s34_holdR1.png")):
                shutil.copyfile(os.path.join(S3A_MISSION_RUN, src), os.path.join(tmp, dst))
            ok, detail = gate.score_mission_log(S3A_MISSION_LOG, tmp)
        self.assertFalse(ok, detail)
        self.assertIn("1 live hold pairs", detail)

    def test_missing_captures_against_logged_holds_is_no_data(self):
        """R34: the capture count must equal the logged hold count -- 3 captures for 6 logged holds is
        NO-DATA, even though 3 is the gameplay floor."""
        with tempfile.TemporaryDirectory() as tmp:
            with open(S3A_MISSION_LOG, encoding="utf-8") as f:
                text = f.read()
            log = os.path.join(tmp, "six.drive.txt")
            with open(log, "w", encoding="utf-8") as f:
                f.write(text + "s36_holdL                t= 224.8s\ns38_holdS                t= 235.4s\n"
                               "s40_holdR1               t= 238.2s\n")
            ok, detail = gate.score_mission_log(log, S3A_MISSION_RUN)
        self.assertFalse(ok, detail)
        self.assertIn("NO-DATA", detail)
        self.assertIn("3 hold captures for 6 logged holds", detail)

    def test_dbuff_cinematic_holds_fail(self):
        """The defect R30 fixes: s5_task4_dbuff's log says HUD matched and 6 holds -- the old PASS --
        but every hold capture is the letterboxed intro cinematic."""
        ok, detail = gate.score_mission_log(DBUFF_MISSION_LOG, DBUFF_MISSION_RUN)
        self.assertFalse(ok, detail)
        self.assertIn("0/3 hold captures are gameplay", detail)

    def test_gate_layout_finds_frames_beside_the_log(self):
        """run_gate writes <root>/mission.drive.log and <root>/mission/; the scorer finds the captures
        from the log path alone, as --score-mission does."""
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copyfile(S3A_MISSION_LOG, os.path.join(tmp, "mission.drive.log"))
            shutil.copytree(S3A_MISSION_RUN, os.path.join(tmp, "mission"))
            ok, detail = gate.score_mission_log(os.path.join(tmp, "mission.drive.log"))
        self.assertTrue(ok, detail)

    def test_too_few_hold_captures_is_no_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copyfile(os.path.join(S3A_MISSION_RUN, "s30_holdW.png"), os.path.join(tmp, "s30_holdW.png"))
            ok, detail = gate.score_mission_log(S3A_MISSION_LOG, tmp)
        self.assertFalse(ok, detail)
        self.assertIn("NO-DATA", detail)

    def test_known_good_log_passes(self):
        ok, detail = _score_fixture_run(GOOD_MISSION_FIXTURE, PROBE5_MISSION_RUN)
        self.assertTrue(ok, detail)
        self.assertIn("6/6 hold captures are gameplay", detail)
        if os.path.isfile(GOOD_MISSION_LOG) and os.path.isdir(GOOD_MISSION_FRAMES):   # the full-size run, where kept
            ok, detail = gate.score_mission_log(GOOD_MISSION_LOG, GOOD_MISSION_FRAMES)
            self.assertTrue(ok, detail)

    @unittest.skipUnless(os.path.isdir(FULL_DBUFF_RUN), "needs logs/parity/gate/s5_task4_dbuff")
    def test_full_size_dbuff_run_fails(self):
        ok, detail = gate.score_mission_log(os.path.join(FULL_DBUFF_RUN, "mission.drive.log"))
        self.assertFalse(ok, detail)
        self.assertIn("0/6 hold captures are gameplay", detail)

    def test_real_frozen_runs_fail(self):
        ok, detail = _score_fixture_run(FROZEN_MISSION_LOG, FROZEN_MISSION_RUN)
        self.assertFalse(ok, detail)
        self.assertIn("6/6 hold captures are gameplay", detail)
        self.assertIn("0 live hold pairs", detail)
        for r in [r for r in FROZEN_RUNS if os.path.isdir(os.path.join(r, "mission"))]:   # full-size, where kept
            ok, detail = gate.score_mission_log(os.path.join(r, "mission.drive.log"))
            self.assertFalse(ok, (r, detail))

    def test_real_live_runs_pass(self):
        ok, detail = gate.score_mission_log(S3A_MISSION_LOG, S3A_MISSION_RUN)   # s3a, reduced (make_gate_fixtures)
        self.assertTrue(ok, detail)
        for r in [r for r in LIVE_RUNS if os.path.isdir(os.path.join(r, "mission"))]:   # full-size, where kept
            ok, detail = gate.score_mission_log(os.path.join(r, "mission.drive.log"))
            self.assertTrue(ok, (r, detail))

    def test_missing_hud_fails(self):
        for log in [BAD_MISSION_FIXTURE] + ([BAD_MISSION_LOG] if os.path.isfile(BAD_MISSION_LOG) else []):
            ok, detail = gate.score_mission_log(log)
            self.assertFalse(ok, (log, detail))
            self.assertIn("HUD never matched", detail)

    def test_real_runs_that_failed_the_mission_on_screen_fail(self):
        ok, detail = _score_fixture_run(FAILED_MISSION_LOG, FAILED_MISSION_RUN)
        self.assertFalse(ok, detail)
        self.assertIn("MISSION FAILED on screen", detail)
        self.assertIn("4 live hold pairs", detail)      # live: only the banner check can fail it
        for r in [r for r in FAILED_ON_SCREEN_RUNS if os.path.isdir(os.path.join(r, "mission"))]:   # where kept
            ok, detail = gate.score_mission_log(os.path.join(r, "mission.drive.log"))
            self.assertFalse(ok, (r, detail))
            self.assertIn("MISSION FAILED on screen", detail)


class MissionSeeing(unittest.TestCase):
    """Sprint 6 Task 1 (owner-agreed 2026-09-14): score_mission_log runs three more scorers once the
    liveness checks pass. mission_fail.detect over the hold captures and final.png FAILS the stage
    (1a); console_compare on the s28 spawn capture (1b) and guest_probe over the game's run log (1c)
    are printed into the detail and, under R78, do not change the verdict."""

    HUD_LINE = "untilref(scripts/parity/ref_hud_ours.png): 3 presses, dist=5.2 bands=0.92, matched=True\n"
    HOLD_LINES = ("s30_holdW                t= 213.6s stable=True waited=0.0s\n"
                  "s32_holdR1               t= 216.4s stable=True waited=0.0s\n"
                  "s34_holdR1               t= 218.3s stable=True waited=0.0s\n")

    def _run(self, tmp, s28=None, extra_holds=(), final=None, log_s28=True):
        """<tmp>/mission.drive.log + <tmp>/mission/ in run_gate's layout: the s3a passing hold set,
        optionally an s28_none capture, extra hold captures and a final.png."""
        run = os.path.join(tmp, "mission")
        shutil.copytree(S3A_MISSION_RUN, run)
        text = ("s27_none                 t= 205.9s stable=False waited=40.2s\n" + self.HUD_LINE
                + ("s28_none                 t= 207.9s stable=True waited=0.0s\n" if log_s28 else "")
                + self.HOLD_LINES)
        for name, _ in extra_holds:
            text += "%-24s t= 224.8s stable=True waited=0.0s\n" % name[:-4]
        log = os.path.join(tmp, "mission.drive.log")
        with open(log, "w", encoding="utf-8") as f:
            f.write(text)
        if s28:
            shutil.copyfile(s28, os.path.join(run, "s28_none.png"))
        for name, src in extra_holds:
            shutil.copyfile(src, os.path.join(run, name))
        if final:
            shutil.copyfile(final, os.path.join(run, "final.png"))
        return log

    # -- 1a: the MISSION FAILURE screen fails the stage --------------------------------------------
    def test_failure_screen_as_final_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp, final=FAILURE_SCREEN))
        self.assertFalse(ok, detail)
        self.assertIn("MISSION FAILED on screen", detail)
        self.assertIn("final.png", detail)

    def test_failure_screen_as_a_hold_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = self._run(tmp, extra_holds=[("s36_holdL.png", FAILURE_SCREEN)])
            ok, detail = gate.score_mission_log(log)
        self.assertFalse(ok, detail)
        self.assertIn("MISSION FAILED on screen", detail)
        self.assertIn("s36_holdL.png", detail)

    def test_gameplay_final_still_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp, final=GAMEPLAY_SPAWN))
        self.assertTrue(ok, detail)
        self.assertNotIn("MISSION FAILED", detail)

    # -- 1b: console-vs-ours on the s28 spawn capture, print-only (R78) -----------------------------
    def test_console_line_passes_on_the_console_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp, s28=CONSOLE_SPAWN))
        self.assertTrue(ok, detail)
        self.assertRegex(detail, r"CONSOLE spawn score=\d+\.\d water flat=0\.\d{3} dark=0\.\d{3} -> PASS")

    def test_console_line_fails_on_our_spawn_without_changing_the_verdict(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp, s28=GAMEPLAY_SPAWN))
        self.assertTrue(ok, detail)      # R78: the water defect is known and owned; the number is for the trend
        self.assertRegex(detail, r"CONSOLE spawn score=\d+\.\d water flat=0\.\d{3} dark=0\.\d{3} -> FAIL")

    def test_console_line_is_no_data_without_an_s28_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp))
        self.assertTrue(ok, detail)
        self.assertIn("CONSOLE spawn NO-DATA", detail)

    def test_console_line_is_no_data_when_the_log_names_no_step_after_the_hud(self):
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp, s28=CONSOLE_SPAWN, log_s28=False))
        self.assertTrue(ok, detail)
        self.assertIn("CONSOLE spawn NO-DATA", detail)

    def test_spawn_capture_is_the_first_none_step_after_the_hud_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = self._run(tmp, s28=CONSOLE_SPAWN)
            self.assertEqual(gate.mission_spawn_capture(log, os.path.join(tmp, "mission")),
                             os.path.join(tmp, "mission", "s28_none.png"))
            log = self._run(os.path.join(tmp, "b"), s28=None)
            self.assertIsNone(gate.mission_spawn_capture(log, os.path.join(tmp, "b", "mission")))

    # -- 1c: guest-value probe over the game's run log, print-only (R78) ----------------------------
    @staticmethod
    def _peek_rows(root_y=5.50391, move_scale=1.0):
        from tools_py.parity.sim_walk_to_b import peek_line, _w
        actor, node = 0x01794000, 0x00C10000
        # The runtime names the address column it installed before any [peek] row (Task 19,
        # socom2_addresses.h selectFromImage). guest_probe reads the probes with THAT column, and a log
        # that never says is NO-DATA rather than a quiet read of r0001's addresses -- so a game log
        # standing in for a real one carries the line a real one carries.
        rows = ["[socom2] address table: the image names itself r0001 -- using the r0001 addresses\n"]
        for i in range(10):
            # The camera record ORBITS the player (~19 units of ground separation on every archived gate
            # run), and the camera_orbit probe reads that distance, so a stand-in row has to place it
            # where a real one does rather than 479 units away.
            ax, az = 900.0 + 2.0 * i, 850.0
            line = peek_line(ax - 3.0, -120.0, az - 19.0, actor=(ax, -145.0, az), actor_addr=actor)
            line += f" @{actor + 0x2e8:x}: {node:08x}(0)"
            line += f" @{node:x}: 00000000(0) {_w(root_y)}"
            line += f" @{actor + 0x1368:x}: {_w(move_scale)}"
            rows.append(line + "\n")
        return rows

    def test_probe_lines_come_from_the_game_log_beside_the_drive_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = self._run(tmp)
            with open(os.path.join(tmp, "mission.game.log"), "w", encoding="utf-8") as f:
                f.write("Using argv boot path\n" + "".join(self._peek_rows()))
            ok, detail = gate.score_mission_log(log)
        self.assertTrue(ok, detail)
        self.assertIn("PROBE root_node_y PASS", detail)
        self.assertIn("PROBE move_scale PASS", detail)
        self.assertIn("PROBE teleport_steps PASS", detail)

    def test_a_fallback_branch_log_still_names_its_column(self):
        """Re-review N1, end to end. The runtime prints "the image names itself rNNNN" only when a row's
        own stamp named that row; on its two fallback branches it prints "... -- using rNNNN, every
        override address is an rNNNN address" instead. s11_open_gate reached the gate on that branch. A
        --score-mission of such a log has no stamp record to consult, so it reads the wording -- and
        while guest_probe kept its own copy of log_revision, which matched only the first form, it read
        PROBE NO-DATA instead of the rows that are right there."""
        fallback = ("[socom2] address table: the version string names no revision "
                    "(a boot path) -- using r0001, every override address is an r0001 address\n")
        with tempfile.TemporaryDirectory() as tmp:
            log = self._run(tmp)
            with open(os.path.join(tmp, "mission.game.log"), "w", encoding="utf-8") as f:
                f.write(fallback + "".join(r for r in self._peek_rows() if r.startswith("[peek]")))
            ok, detail = gate.score_mission_log(log, probe_required=True)
        self.assertTrue(ok, detail)
        self.assertIn("PROBE root_node_y PASS", detail)
        self.assertIn("(r0001 addresses)", detail)
        probes = [p for p in detail.split("; ") if p.startswith("PROBE ")]
        self.assertEqual(len(probes), 4, probes)
        self.assertTrue(all(" PASS " in p for p in probes), probes)

    def test_probe_failure_fails_the_stage(self):
        # R80 (2026-09-15): s6_probe read root node 5.5039, MoveScale 1.0 and 0 teleports on the block-pointer exe,
        # so the three probe values are scored from that run on -- R78's print-only period for them is over.
        with tempfile.TemporaryDirectory() as tmp:
            run_log = os.path.join(tmp, "some.log")
            with open(run_log, "w", encoding="utf-8") as f:
                f.write("".join(self._peek_rows(root_y=0.0)))
            ok, detail = gate.score_mission_log(self._run(tmp), run_log=run_log)
        self.assertFalse(ok, detail)
        self.assertTrue(detail.startswith("GUEST PROBE FAILED: root_node_y"), detail)
        self.assertIn("PROBE root_node_y FAIL", detail)
        self.assertIn("PROBE move_scale PASS", detail)

    def test_no_game_log_is_no_data_and_fails_only_when_the_probe_was_required(self):
        # A re-score of an old run (--score-mission) has no game log: printed as NO-DATA, not failed. A run the
        # gate launched itself (run_gate sets PS2X_PEEK and the sampler) must have rows: NO-DATA fails it.
        with tempfile.TemporaryDirectory() as tmp:
            ok, detail = gate.score_mission_log(self._run(tmp))
            self.assertTrue(ok, detail)
            self.assertIn("PROBE NO-DATA", detail)
            ok, detail = gate.score_mission_log(self._run(os.path.join(tmp, "b")), probe_required=True)
            self.assertFalse(ok, detail)
            self.assertTrue(detail.startswith("GUEST PROBE FAILED"), detail)

    @unittest.skipUnless(os.path.isfile(PRISTINE_CARD_SAVE),
                         "needs the pristine memory card save %s (owner's disc assets; game/ is git-ignored)"
                         % PRISTINE_CARD_SAVE)
    def test_mission_stage_launches_with_the_probe_peek_spec(self):
        """run_gate sets PS2X_PEEK for the mission stage from guest_probe_console.json unless the
        environment already carries one (an operator's wider spec wins).

        The card assertion below reads the copy run_gate makes of game/disc/mc0_parity, so this case
        needs the owner's disc assets and is skipped on a bare clone (CI)."""
        from tools_py.parity import guest_probe
        calls = []

        def fake_run(cmd, **kw):
            calls.append((cmd, kw.get("env")))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        def drive_env():
            return [env for cmd, env in calls if "tools_py.parity.drive" in cmd][0]

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(gate.subprocess, "run", fake_run), \
                mock.patch.object(gate.shutil, "copyfile"), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PS2X_PEEK", None)
            os.environ.pop("PS2X_PC_SAMPLER", None)
            os.environ.pop("SOCOM_GAME_ELF", None)
            gate.run_gate("mission", tmp)
            # The LITERAL r0001 spec, not `peek_spec(...)` compared with itself -- the old assertion called
            # the same two functions on both sides and held for any implementation, including one that
            # always answered r0001 (review F4). This string is also, character for character, the
            # PS2X_PEEK line in scripts/parity/pins.json's detail.env, which is what keeps the r0001 env
            # pin from moving.
            self.assertEqual(drive_env()["PS2X_PEEK"],
                             "0x416054:3,*0x408c58+0x2e8:1,*0x408c58+0x2e8*:2,*0x408c58+0x1368:1,"
                             "*0x408c58:64,0x4365c0:1")
            # The runtime prints [peek] rows only from the PC sampler's thread (game_overrides_socom2.cpp:
            # "dump guest words ... with each sample"), so PS2X_PEEK alone yields 0 rows -- s6_blockptr's
            # mission stage read "PROBE ... NO-DATA (0 reads of 0 rows)" for exactly that reason.
            self.assertEqual(drive_env()["PS2X_PC_SAMPLER"], "1")
            # ... and an r0004 image gets the r0004 spec. This is the single integration point the whole
            # per-revision change exists for, and before the review nothing exercised it: an implementation
            # that always answered r0001 passed the suite (review F4). The image is a stand-in carrying
            # only the build banner, which is all launch_revision reads.
            calls.clear()
            elf = os.path.join(tmp, "r0004_stand_in.elf")
            with open(elf, "wb") as f:
                f.write(BANNER_STAND_IN % b"r0004 10:14:38 Nov  3 2004")
            os.environ["SOCOM_GAME_ELF"] = elf
            gate.run_gate("mission", tmp)
            self.assertEqual(drive_env()["PS2X_PEEK"],
                             "0x442a14:3,*0x435618+0x2e8:1,*0x435618+0x2e8*:2,*0x435618+0x136c:1,"
                             "*0x435618:64,0x442fd0:1")
            self.assertEqual(drive_env()["PS2X_PEEK"], guest_probe.peek_spec(GUEST_PROBE_CONSOLE, "r0004"))
            os.environ.pop("SOCOM_GAME_ELF", None)
            calls.clear()
            os.environ["PS2X_PEEK"] = "0x416054:3"
            gate.run_gate("mission", tmp)
            self.assertEqual(drive_env()["PS2X_PEEK"], "0x416054:3")
            calls.clear()
            gate.run_gate("title", tmp)
            self.assertEqual(drive_env()["PS2X_PEEK"], "0x416054:3")   # title: the environment passes through untouched
            self.assertNotIn("PS2X_PC_SAMPLER", drive_env())
            self.assertEqual(drive_env()["PS2X_HOST_GAMEPAD"], "0")   # every stage: a gate boots with no controller
            # ... and from a PRISTINE memory card: the owner's free play (2026-09-16) saved the controller configuration
            # onto game/disc/mc0, the card every gate had booted from, and the boot stopped showing the configuration
            # screens and the 'save to memory card?' dialog the transition stage keys on (s6_gamepad..s6_gamepad3).
            # run_gate copies game/disc/mc0_parity into the stamp directory and points the game there.
            card = drive_env()["PS2X_MC_DIR"]
            self.assertTrue(card.startswith(os.path.abspath(tmp)), card)
            self.assertTrue(os.path.isfile(os.path.join(card, "BASCUS-97275SOCOMII", "BASCUS-97275SOCOMII")), card)
            os.environ["PS2X_MC_DIR"] = "C:/elsewhere"
            calls.clear()
            gate.run_gate("title", tmp)
            self.assertEqual(drive_env()["PS2X_MC_DIR"], "C:/elsewhere")   # an operator's card wins
            os.environ.pop("PS2X_MC_DIR", None)

    def test_run_gate_clears_a_previous_runs_captures_from_the_stage_dir(self):
        """A reused stamp must not mix two runs' frames: s17_b6 was rerun three times on 2026-10-01, the
        transition dir kept the first run's 76 captures, and fade_frames (mtime order) scored a stale
        w04_011.png as the first briefing frame -- two false FAILs. run_gate clears the stage's captures,
        final.png and manifest.json before the drive writes its own."""
        with tempfile.TemporaryDirectory() as tmp:
            stage_dir = os.path.join(tmp, "transition")
            os.makedirs(stage_dir)
            Image.new("RGB", (4, 4), (200, 200, 200)).save(os.path.join(stage_dir, "w04_011.png"))
            Image.new("RGB", (4, 4), (200, 200, 200)).save(os.path.join(stage_dir, "final.png"))
            with open(os.path.join(stage_dir, "manifest.json"), "w", encoding="utf-8") as f:
                f.write("[]")
            fresh = os.path.join(stage_dir, "w05_009.png")

            def fake_run(cmd, **kw):
                if "tools_py.parity.drive" in cmd:
                    Image.new("RGB", (4, 4), (0, 0, 0)).save(fresh)
                return subprocess.CompletedProcess(cmd, 0, "", "")

            out = io.StringIO()
            with mock.patch.object(gate.subprocess, "run", fake_run), \
                    mock.patch.object(gate.shutil, "copyfile"), \
                    mock.patch.object(gate, "score_transition", return_value=(True, "stub")), \
                    mock.patch.dict(os.environ, {"PS2X_MC_DIR": os.path.join(tmp, "card")}), \
                    contextlib.redirect_stdout(out):
                gate.run_gate("transition", tmp)
            self.assertEqual(sorted(os.listdir(stage_dir)), ["w05_009.png"])
            self.assertIn("gate: transition: removed 3 capture(s) of a previous run from %s" % stage_dir,
                          out.getvalue())


class GameplayBands(unittest.TestCase):
    """screen_bands.gameplay_band: the letterbox bands (rows 2-95 and 340-446 of the 640x448 frame) are
    lit in gameplay and black through the intro cinematic. Measured on the gate's own mission captures
    (s3a, s3b3, s3d_2x_host, famb, mission4, native_on, s5_task4_dbuff): pixels above 3 cover >= 0.86 of
    both bands on gameplay, <= 0.57 on letterboxed frames."""

    def _band(self, path):
        with Image.open(path) as im:
            return screen_bands.gameplay_band(im)

    def test_intro_cinematic_is_not_gameplay(self):
        ok, frac = self._band(os.path.join(DBUFF_MISSION_RUN, "s30_holdW.png"))
        self.assertFalse(ok, frac)

    def test_help_popup_over_hud_is_gameplay(self):
        ok, frac = self._band(os.path.join(DBUFF_MISSION_RUN, "final.png"))
        self.assertTrue(ok, frac)

    def test_s3a_hold_is_gameplay(self):
        ok, frac = self._band(os.path.join(S3A_MISSION_RUN, "s30_holdW.png"))
        self.assertTrue(ok, frac)

    def test_rows_scale_with_frame_height(self):
        a = np.full((448, 640, 3), 60, np.uint8)
        a[:96] = 0
        self.assertFalse(screen_bands.gameplay_band(Image.fromarray(a))[0])
        small = Image.fromarray(a).resize((320, 224), Image.BOX)
        self.assertFalse(screen_bands.gameplay_band(small)[0])
        self.assertTrue(screen_bands.gameplay_band(Image.fromarray(np.full((224, 320, 3), 60, np.uint8)))[0])

    @unittest.skipUnless(os.path.isdir(FULL_DBUFF_RUN), "needs logs/parity/gate/s5_task4_dbuff")
    def test_full_size_originals(self):
        self.assertFalse(self._band(os.path.join(FULL_DBUFF_RUN, "mission", "s30_holdW.png"))[0])
        self.assertTrue(self._band(os.path.join(FULL_DBUFF_RUN, "mission", "final.png"))[0])


class HudMatch(unittest.TestCase):
    """drive.hud_match is untilref's per-frame test. The HUD reference region compared on the cropped
    160x112 thumbnail matches the cinematic (the defect); with `lit` the band test must reject it."""

    # 2026-09-16: the HUD reference was re-captured from the lit look (the post-process brighten now reaches the
    # frame, research/31 section 12-13); the dbuff fixtures are the earlier dark look, so the defect-documenting
    # cases compare them against the reference of their day (committed beside them), and the acceptance case uses a
    # lit-look fixture (tests/fixtures/gate/mission/lum/s28_none.png, logs/parity/gate/s6_lum3).
    def setUp(self):
        with Image.open(HUD_REF) as im:
            self.ref = drive.thumb(im)
        with Image.open(os.path.join(DBUFF_MISSION_RUN, "ref_hud_ours_2026-09-11.png")) as im:
            self.ref_2026_09_11 = drive.thumb(im)

    # 2026-09-16 (evening): the compared region moved from the squad panel (92,112,125,160) to the ammo box
    # (92,112,0,40) with threshold 20: once the ground behind the squad panel was drawn (research/31 section 17)
    # the MISSION BRIEFING screen read 37.2 against the re-captured reference and the gate matched before pressing
    # anything (s6_vifwait_gate). On the ammo box a HUD frame of any run reads under 4, the briefing 33, cinematics
    # 27+ (and the lit band test rejects them anyway).
    def _match(self, path, lit, ref=None, region=(92, 112, 0, 40), thresh=20.0):
        with Image.open(path) as im:
            return drive.hud_match(im, self.ref if ref is None else ref, region, thresh, lit)

    def test_cinematic_matched_without_lit_documents_the_defect(self):
        matched, dist, _ = self._match(os.path.join(DBUFF_MISSION_RUN, "s30_holdW.png"), lit=False, ref=self.ref_2026_09_11,
                                       region=(92, 112, 125, 160), thresh=40.0)   # the region and threshold of that day
        self.assertTrue(matched, dist)

    def test_cinematic_rejected_with_lit(self):
        matched, dist, band = self._match(os.path.join(DBUFF_MISSION_RUN, "s30_holdW.png"), lit=True, ref=self.ref_2026_09_11,
                                          region=(92, 112, 125, 160), thresh=40.0)
        self.assertFalse(matched, (dist, band))

    # 2026-09-16 (evening): the reference was re-captured again from the run with the VIF wait-for-idle fix
    # (research/31 section 17, logs/parity/gate/s6_vifwait1): the ground behind the squad panel is now drawn,
    # so the compared region no longer holds the light slab; a slab-era HUD frame reads 60+ against it.
    def test_hud_accepted_with_lit(self):
        matched, dist, band = self._match(os.path.join(FIXTURES, "mission", "vifwait", "s28_none.png"), lit=True)
        self.assertTrue(matched, (dist, band))

    def test_hud_frames_of_other_runs_are_accepted(self):
        """The ammo box does not depend on the ground behind it: HUD frames of earlier runs (slab era) read under 4."""
        for run in ("lum",):
            matched, dist, band = self._match(os.path.join(FIXTURES, "mission", run, "s28_none.png"), lit=True)
            self.assertTrue(matched, (run, dist, band))

    def test_the_mission_briefing_is_rejected(self):
        """s6_vifwait_gate: the briefing screen read 37.2 on the squad panel and the gate matched before pressing;
        on the ammo box it reads 33 against a threshold of 20."""
        matched, dist, band = self._match(os.path.join(FIXTURES, "mission", "vifwait", "briefing_s31.png"), lit=True)
        self.assertFalse(matched, (dist, band))

    def test_mission_scripts_require_lit(self):
        """Every script that waits for the in-game HUD (the mission gate's gameplay_probe.txt, and
        gameplay_damage.txt / gameplay_death.txt) must ask untilref for the band test (R30, R34)."""
        for script in (gate.GATES["mission"]["script"], "scripts/parity/gameplay_damage.txt",
                       "scripts/parity/gameplay_death.txt"):
            with open(os.path.join(ROOT, script), encoding="utf-8") as f:
                lines = [ln.split("#", 1)[0] for ln in f if "ref_hud_ours.png" in ln.split("#", 1)[0]]
            self.assertTrue(lines, script)
            for ln in lines:
                self.assertIn(",lit)", ln.replace(" ", ""), script)


class HoldCapture(unittest.TestCase):
    """drive.capture_step: hold steps are captured with winshot.grab(hwnd, max_age=1.0); a stale frame file
    prints STALE FRAME and still saves the (old) frame -- the drive goes on, the scorer decides (R34)."""

    def _run(self, grab, hold):
        real = drive.winshot.grab
        drive.winshot.grab = grab
        try:
            with tempfile.TemporaryDirectory() as tmp, mock.patch("builtins.print") as out:
                path = os.path.join(tmp, "s30_holdW.png")
                drive.capture_step(None, path, hold)
                saved = os.path.isfile(path)
            return saved, " ".join(str(c.args[0]) for c in out.call_args_list if c.args)
        finally:
            drive.winshot.grab = real

    def test_hold_capture_asks_for_a_fresh_frame(self):
        calls = []

        def grab(hwnd, max_age=None):
            calls.append(max_age)
            return Image.new("RGB", (64, 48))
        saved, printed = self._run(grab, hold=True)
        self.assertTrue(saved)
        self.assertEqual(calls, [1.0])
        self.assertNotIn("STALE FRAME", printed)

    def test_stale_frame_is_logged_and_saved(self):
        def grab(hwnd, max_age=None):
            if max_age is not None:
                raise drive.winshot.StaleFrameError("latest_frame.png", 7.5, max_age)
            return Image.new("RGB", (64, 48))
        saved, printed = self._run(grab, hold=True)
        self.assertTrue(saved)
        self.assertIn("STALE FRAME", printed)

    def test_non_hold_capture_keeps_the_old_grab(self):
        calls = []

        def grab(hwnd, max_age=None):
            calls.append(max_age)
            return Image.new("RGB", (64, 48))
        self._run(grab, hold=False)
        self.assertEqual(calls, [None])


class TransitionScoring(unittest.TestCase):
    def test_empty_dir_fails(self):
        """black_rows.py exits 0 when it examines nothing, so an empty run must not score PASS."""
        with tempfile.TemporaryDirectory() as empty:
            ok, detail = gate.score_transition(empty)
        self.assertFalse(ok, detail)

    def test_missing_dir_fails(self):
        ok, detail = gate.score_transition(os.path.join(ROOT, "logs", "parity", "no_such_run"))
        self.assertFalse(ok, detail)

    def test_fixture_run_passes(self):
        """tests/fixtures/gate/transition/: five near-black 320x224 frames from a real run
        (logs/parity/gate/tfix4/transition -- four of the 5 fps burst frames of the fade into the
        briefing and one wait capture after it, all peak 0). Every name is s11_*/w13_*, at or
        after the probe's burst step, so the scorer examines all five; five clears
        gate.TRANSITION_MIN_FRAMES (3 since 2026-09-17; the wall-time transition test below pins it)."""
        ok, detail = gate.score_transition(TRANSITION_FIXTURE_RUN)
        self.assertTrue(ok, detail)
        self.assertIn("5 black-screen frames examined", detail)
        self.assertIn("at/after the burst step", detail)

    def test_four_frames_pass_at_the_wall_time_transition(self):
        """research/34 section 6: with the guest clock on wall time the black screen before the briefing lasts
        about 4 s, not 14 (s6_clock_gate: 4 wait captures at 1 Hz, every frame peak 0, vs 14 on s6_clutfix_gate
        at two thirds speed). The floor of 5 was calibrated on the slow clock; 3 keeps the vacuous-pass guard
        (a run that never reached the fade examines 0 or 1) and admits the real transition."""
        import shutil, tempfile
        with tempfile.TemporaryDirectory() as tmp:
            names = sorted(n for n in os.listdir(TRANSITION_FIXTURE_RUN) if n.endswith(".png"))
            for n in names[:4]:
                shutil.copy(os.path.join(TRANSITION_FIXTURE_RUN, n), os.path.join(tmp, n))
            for n in os.listdir(TRANSITION_FIXTURE_RUN):
                if not n.endswith(".png"):
                    shutil.copy(os.path.join(TRANSITION_FIXTURE_RUN, n), os.path.join(tmp, n))
            ok, detail = gate.score_transition(tmp)
            self.assertTrue(ok, detail)
            self.assertIn("4 black-screen frames examined", detail)
            self.assertEqual(gate.TRANSITION_MIN_FRAMES, 3)

    def test_known_clean_run_passes(self):
        """tfix3's 18 transition frames, with the run's 12 boot black frames beside them that the burst step drops."""
        for run in [CLEAN_TRANSITION_FIXTURE] + ([CLEAN_TRANSITION_RUN] if os.path.isdir(CLEAN_TRANSITION_RUN) else []):
            ok, detail = gate.score_transition(run)
            self.assertTrue(ok, (run, detail))
            self.assertIn("18 black-screen frames examined", detail)

    def test_wait_frames_count_toward_transition(self):
        """Task 8: drive.py captures a frame every 1.0 s of every settle wait as
        w<NN>_<kkk>.png, so the ~1 s fade can no longer fall between two step captures.
        black_rows.py must examine those alongside the s*.png step captures -- three wait
        frames plus two step frames is five examined, enough for TRANSITION_MIN_FRAMES = 5.
        The names are s11/w13 because the scorer only examines frames at/after the probe's
        burst step."""
        with tempfile.TemporaryDirectory() as run:
            for name in ("w13_000.png", "w13_001.png", "w13_002.png",
                         "s11_burst_000.png", "s12_none.png"):
                Image.new("RGB", (640, 448), (0, 0, 0)).save(os.path.join(run, name))
            ok, detail = gate.score_transition(run)
        self.assertTrue(ok, detail)
        self.assertIn("5 black-screen frames examined", detail)

    def test_bright_pixel_in_the_band_fails(self):
        """The regression the band exists to catch (STATUS 2026-09-09 12:10: a strip of the
        main-menu video at rows 396-447 of the black screen before the briefing). Copy the passing
        fixture run, light one pixel inside the band of one frame -- scaled by h/448, the fixtures
        are 320x224 -- and the gate must go red with the NOT BLACK reason, not merely count five
        frames and pass. Without this, every transition assertion in this file is a positive."""
        with tempfile.TemporaryDirectory() as tmp:
            run = os.path.join(tmp, "transition")
            shutil.copytree(TRANSITION_FIXTURE_RUN, run)
            self.assertTrue(gate.score_transition(run)[0])
            victim = sorted(f for f in os.listdir(run) if f.endswith(".png"))[0]
            path = os.path.join(run, victim)
            with Image.open(path) as im:
                im = im.convert("RGB")
                w, h = im.size
                y = (396 * h // 448 + 447 * h // 448) // 2   # mid-band, in this frame's scale
                im.putpixel((w // 2, y), (255, 255, 255))
                im.save(path)
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("NOT BLACK", detail)
        self.assertIn(victim, detail)

    def test_black_frames_before_the_burst_step_do_not_pass_the_gate(self):
        """The bug this whole enforcement exists for, at the scorer level: twenty black
        frames from the boot (s00..s09, w00..w09) are not a transition. Before --from-step they
        were twenty "black-screen frames examined" and a green gate; now they are zero."""
        with tempfile.TemporaryDirectory() as run:
            for i in range(10):
                Image.new("RGB", (640, 448), (0, 0, 0)).save(os.path.join(run, "s%02d_CROSS.png" % i))
                Image.new("RGB", (640, 448), (0, 0, 0)).save(os.path.join(run, "w%02d_000.png" % i))
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("0 black-screen frames examined", detail)

    def test_stalled_pre_fix_run_now_fails(self):
        """The real article: logs/parity/gate/wcap2 passed this gate on 2026-09-11 with 13
        black-screen frames, every one of them from the boot -- the probe stalled on the
        "save to memory card?" dialog and never reached the briefing. Under the enforced scorer
        it FAILs with 0. Same for famb, famc, hostdraw_on and hostdraw_fix (see gate.py)."""
        for run in [STALLED_TRANSITION_FIXTURE] + ([STALLED_TRANSITION_RUN] if os.path.isdir(STALLED_TRANSITION_RUN) else []):
            ok, detail = gate.score_transition(run)
            self.assertFalse(ok, (run, detail))
            self.assertIn("0 black-screen frames examined", detail)


class BurstStepFiltering(unittest.TestCase):
    """The transition frame count has to be able to say which frames are the transition and
    which are the boot: black_rows.py --from-step drops the boot ones, and gate.first_burst_step
    reads the step index to drop them from off the probe script rather than a hard-coded number."""

    def test_first_burst_step_of_the_transition_probe(self):
        """transition_probe.txt: nine `next` steps (s00..s08, the boot screens through the rank
        screen), the two ifref guards for the "save to memory card?" dialog (s09/s10), then the
        burst that starts on the NO press and captures the fade. Captures from it on are named
        s11_*; the gate examines those and nothing earlier."""
        self.assertEqual(gate.first_burst_step(), 11)

    def test_first_burst_step_ignores_comments_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "probe.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("# a comment\n\nnext+1.0:CROSS   # step 0\nwait+1.0:NONE\n"
                        "burst+5.0:NONE  # step 2\nburst+1.0:NONE\n")
            self.assertEqual(gate.first_burst_step(path), 2)

    def test_script_without_a_burst_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "probe.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("next+1.0:CROSS\nwait+1.0:NONE\n")
            self.assertIsNone(gate.first_burst_step(path))
            self.assertIsNone(gate.first_burst_step(os.path.join(tmp, "no_such_script.txt")))

    def test_first_burst_step_accepts_ifburst(self):
        """The transition probe's transition burst is an `ifburst` (one after every "save to
        memory card?" guard pair, only the answered pair's fires). The static fallback has to
        recognise that form, or it would skip past all three and point at the briefing burst."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "probe.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("next+1.0:CROSS\nifburst+12.0:NONE\nburst+8.0:NONE\n")
            self.assertEqual(gate.first_burst_step(path), 1)

    def test_step_index_of_capture_names(self):
        self.assertEqual(black_rows.step_index("s09_burst_003.png"), 9)
        self.assertEqual(black_rows.step_index("w10_001.png"), 10)
        self.assertEqual(black_rows.step_index("s00_none.png"), 0)
        self.assertEqual(black_rows.step_index("final.png"), -1)   # not a step capture

    def test_frames_before_the_burst_step_do_not_count(self):
        """The point of --from-step, at the black_rows.py level: eight black frames from the
        boot (s00..s07) plus two from the burst step is ten frames of which only two can be the
        transition. Unrestricted, black_rows.py examines all ten; --from-step 8 examines the two."""
        with tempfile.TemporaryDirectory() as run:
            names = ["s%02d_CROSS.png" % i for i in range(8)] + ["s08_burst_000.png", "w08_000.png"]
            for name in names:
                Image.new("RGB", (640, 448), (0, 0, 0)).save(os.path.join(run, name))

            def examined(*extra):
                r = subprocess.run([sys.executable, "tools_py/parity/black_rows.py", run] + list(extra),
                                   capture_output=True, text=True, cwd=ROOT)
                return [ln.split()[0] for ln in r.stdout.splitlines() if "black screen, rows " in ln]

            self.assertEqual(len(examined()), 10)
            self.assertEqual(sorted(examined("--from-step", "8")),
                             ["s08_burst_000.png", "w08_000.png"])
            self.assertEqual(examined("--from-step", "9"), [])


class MovedDialog(unittest.TestCase):
    """The 2026-09-12 defect: the "save to memory card?" dialog lands on a step index that moves
    with how many controller-configuration screens the boot shows, so a burst pinned to a fixed
    index stops being the transition. logs/parity/gate/s4_mb matched the dialog at steps 13/14
    instead of 9/10; the step-11 burst captured a configuration screen and the scorer was left
    four 1 Hz wait frames ("4 black-screen frames examined, need 5"), three runs in a row."""

    @staticmethod
    def _black(path):
        Image.new("RGB", (640, 448), (0, 0, 0)).save(path)

    def _late_dialog_run(self, tmp):
        """A run shaped like s4_mb under the fixed probe: boot black screens through step 10, the
        first guard pair not matching (so its ifburst fires nothing), the dialog answered at
        steps 13/14, and the burst firing at step 15 on the fade."""
        run = os.path.join(tmp, "transition")
        os.makedirs(run)
        for i in range(11):                       # boot: black, but not the transition
            self._black(os.path.join(run, "s%02d_CROSS.png" % i))
            self._black(os.path.join(run, "w%02d_000.png" % i))
        for name in ("s12_CROSS.png", "s13_RIGHT.png", "s14_CROSS.png"):
            Image.new("RGB", (640, 448), (200, 200, 200)).save(os.path.join(run, name))
        for k in range(4):                        # the burst that actually fired, on the NO press
            self._black(os.path.join(run, "s15_burst_%03d.png" % k))
        self._black(os.path.join(run, "w16_000.png"))
        return run

    def test_observed_burst_step_reads_the_burst_that_fired(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self._late_dialog_run(tmp)
            self.assertEqual(gate.observed_burst_step(run), 15)
        # ... and the script's static answer, which the old scorer used, is the wrong one.
        self.assertEqual(gate.first_burst_step(), 11)

    def test_observed_burst_step_is_none_without_burst_captures(self):
        with tempfile.TemporaryDirectory() as run:
            self._black(os.path.join(run, "s00_CROSS.png"))
            self.assertIsNone(gate.observed_burst_step(run))
        self.assertIsNone(gate.observed_burst_step(os.path.join(ROOT, "logs", "no_such_run")))

    def test_observed_burst_step_takes_the_first_burst_not_the_briefing_one(self):
        """The probe ends with a second, unconditional burst on the settled briefing. The scorer
        must count from the transition burst, not from that one."""
        with tempfile.TemporaryDirectory() as tmp:
            run = self._late_dialog_run(tmp)
            self._black(os.path.join(run, "s22_burst_000.png"))
            self.assertEqual(gate.observed_burst_step(run), 15)

    def test_late_dialog_run_is_scored_from_the_no_press(self):
        """The property the fix has to hold: the frames counted are the frames after the NO
        press, wherever it landed. Twenty-two boot black frames sit in this run and none of them
        count; the five frames from the fired burst on do, which is exactly the floor."""
        with tempfile.TemporaryDirectory() as tmp:
            run = self._late_dialog_run(tmp)
            ok, detail = gate.score_transition(run)
        self.assertTrue(ok, detail)
        self.assertIn("5 black-screen frames examined", detail)
        self.assertIn("(s15, fired)", detail)

    def test_late_dialog_run_would_have_failed_on_the_fixed_index(self):
        """Same run, scored the old way (from the script's fixed burst step): the fade is at
        s15/w16 and the three configuration screens at s12..s14 are not black, so a from-step-11
        count sees only the five real frames -- but with the burst firing at 11 instead, as it
        did on s4_mb, those five would have been four 1 Hz wait captures. Pin the difference the
        cheap way: the fixed index and the observed one are not the same number."""
        with tempfile.TemporaryDirectory() as tmp:
            run = self._late_dialog_run(tmp)
            self.assertNotEqual(gate.observed_burst_step(run), gate.first_burst_step())

    def test_run_that_fired_no_burst_still_fails(self):
        """A run whose probe never answered the dialog has no transition burst, so nothing marks
        where the transition begins and there is no window to fall back to."""
        with tempfile.TemporaryDirectory() as run:
            for i in range(11):
                self._black(os.path.join(run, "s%02d_CROSS.png" % i))
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("0 black-screen frames examined", detail)
        self.assertIn("no transition burst fired", detail)

    def test_only_the_trailing_briefing_burst_is_not_a_transition(self):
        """Review finding, 2026-09-12, and the quiet pass this scorer exists to prevent.

        The probe ends with an UNCONDITIONAL `burst+8.0:NONE` on the settled briefing (step 22).
        A run that answered no dialog -- it never appeared, or the wrong-answer loop recovered --
        but still reached that burst has `s22_burst_*` as its only burst captures. Taking a plain
        min() over every burst capture reports 22, and the scorer then counts whatever sits at the
        end of the run and calls it the transition: a PASS if that region reads black, on a run
        that captured no fade at all. Only steps the script marks `ifburst` may count."""
        with tempfile.TemporaryDirectory() as run:
            for i in range(20):                     # boot / menus, black, and not the transition
                self._black(os.path.join(run, "s%02d_CROSS.png" % i))
            for k in range(8):                      # the trailing briefing burst, and nothing else
                self._black(os.path.join(run, "s22_burst_%03d.png" % k))
            self.assertEqual(min(black_rows.step_index(n) for n in os.listdir(run)
                                 if "_burst_" in n), 22)      # what a plain min() would have said
            self.assertIsNone(gate.observed_burst_step(run))
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("0 black-screen frames examined", detail)
        self.assertIn("no transition burst fired", detail)

    def test_conditional_burst_steps_of_the_transition_probe(self):
        """One ifburst behind each of the three guard pairs, and the briefing burst is not one."""
        self.assertEqual(gate.conditional_burst_steps(), {11, 15, 19})

    def test_a_script_with_no_ifburst_counts_every_burst(self):
        """An older probe whose bursts are all unconditional has no conditional set to restrict
        to; every burst it fired is the only thing such a run can mean (this is what keeps
        archived runs from before the ifburst rework scorable)."""
        with tempfile.TemporaryDirectory() as tmp:
            script = os.path.join(tmp, "probe.txt")
            with open(script, "w", encoding="utf-8") as f:
                f.write("next+1.0:CROSS\nburst+5.0:NONE\nburst+5.0:NONE\n")
            self.assertEqual(gate.conditional_burst_steps(script), set())
            run = os.path.join(tmp, "run")
            os.makedirs(run)
            self._black(os.path.join(run, "s01_burst_000.png"))
            self._black(os.path.join(run, "s02_burst_000.png"))
            self.assertEqual(gate.observed_burst_step(run, script), 1)
            # ... and under the real probe, neither of those steps is a transition burst.
            self.assertIsNone(gate.observed_burst_step(run))

    def test_probe_pairs_an_ifburst_with_every_guard_pair(self):
        """Structural guard on scripts/parity/transition_probe.txt: every `ifref` guard pair that
        can answer the dialog is immediately followed by an `ifburst`, so whichever pair matches,
        the burst is on its NO press. A pinned `burst` after only the first pair is the defect."""
        path = os.path.join(ROOT, "scripts", "parity", "transition_probe.txt")
        with open(path, encoding="utf-8") as f:
            modes = [ln.split("#", 1)[0].strip().split("+", 1)[0]
                     for ln in f if ln.split("#", 1)[0].strip()]
        pairs = [i for i in range(len(modes) - 1)
                 if modes[i].startswith("ifref(") and modes[i + 1].startswith("ifref(")]
        self.assertEqual(len(pairs), 3, modes)
        for i in pairs:
            self.assertEqual(modes[i + 2], "ifburst", "no ifburst after the pair at step %d" % i)
        self.assertNotIn("burst", modes[:max(pairs) + 2])   # no unconditional burst before them


class ConditionalBurst(unittest.TestCase):
    """drive.py `ifburst`: a burst that fires only when the ifref step above it matched. Driven
    without a game window by stubbing the frame grab, the settle wait and the key presses."""

    REF = "scripts/parity/ref_save_prompt_ours.png"   # relative: drive.parse splits the line on ':'

    def _run(self, script):
        saved = (drive.frame, drive.wait_stable, drive.winshot.grab, drive.keys.press)
        drive.frame = lambda hwnd: np.zeros((112, 160), dtype=np.float32)
        drive.wait_stable = lambda *a, **k: (True, 0.0)
        drive.winshot.grab = lambda hwnd: Image.new("RGB", (64, 64), (0, 0, 0))
        drive.keys.press = lambda *a, **k: None
        try:
            with tempfile.TemporaryDirectory() as out:
                a = argparse.Namespace(out=out, settle=1.5, maxwait=40.0, target="ours", tail=0.0)
                drive.run_steps(a, drive.parse(script), None, None, 0.0, None, [])
                return sorted(os.listdir(out))
        finally:
            drive.frame, drive.wait_stable, drive.winshot.grab, drive.keys.press = saved

    def _script(self, thresh_first, thresh_second):
        # A huge threshold always matches the stubbed all-zero frame, a zero threshold never does.
        return ("ifref(%s,47,62,36,125,%s)+0.0:CROSS\nifburst+0.4:NONE\n"
                "ifref(%s,47,62,36,125,%s)+0.0:CROSS\nifburst+0.4:NONE\n"
                "burst+0.4:NONE\n" % (self.REF, thresh_first, self.REF, thresh_second))

    def test_ifburst_fires_only_after_the_matching_pair(self):
        """First ifref does not match, second does: the burst that fires is the second one, at
        the step index the dialog actually landed on -- which is the whole fix."""
        names = self._run(self._script("0", "100000"))
        self.assertFalse([n for n in names if n.startswith("s01_burst_")], names)
        self.assertTrue([n for n in names if n.startswith("s03_burst_")], names)

    def test_ifburst_fires_on_the_first_pair_when_that_is_where_the_dialog_is(self):
        names = self._run(self._script("100000", "0"))
        self.assertTrue([n for n in names if n.startswith("s01_burst_")], names)
        self.assertFalse([n for n in names if n.startswith("s03_burst_")], names)

    def test_plain_burst_is_unconditional(self):
        """The briefing burst at the end of the probe must keep firing regardless of the guards."""
        names = self._run(self._script("0", "0"))
        self.assertFalse([n for n in names if "_burst_" in n and not n.startswith("s04_")], names)
        self.assertTrue([n for n in names if n.startswith("s04_burst_")], names)


class TestGateDiskRefusal(unittest.TestCase):
    """Sprint 5 R46/A5: gate.py refuses to start a real run below RUN_MIN_FREE_GB (default 4) free
    on C:, exit 3. `gate.free_gb()` is the injectable seam (mock.patch.object) so no test touches
    the real disk; RUN_FREE_GB_CMD is a second seam (a shell command whose last stdout line is the
    GB figure), shared in spirit with scripts/run_detached.sh's own RUN_FREE_GB_CMD override.

    --score-title/--score-mission (re-scoring an existing run, no game launch, nothing large
    written) are exempt (review round 1 item 3, 2026-09-13) -- those tests use the real fixture
    scoring path deliberately, to prove the exemption reaches all the way through, not just the
    branch check.

    The real-run path is tested with `_lock` mocked to report BUSY: that proves execution reached
    past the disk-refusal point (which runs before out_root/lock setup) without spawning drive.py."""

    def setUp(self):
        self._env = dict(os.environ)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._env)

    def _busy_lock(self, cmd, owner):
        return subprocess.CompletedProcess(args=["fake"], returncode=1, stdout="BUSY: fake\n")

    def test_free_gb_reads_run_free_gb_cmd_override(self):
        os.environ["RUN_FREE_GB_CMD"] = "echo ignored && echo 12.5"
        os.environ.pop("RUN_MIN_FREE_GB", None)
        self.assertAlmostEqual(gate.free_gb(), 12.5)

    def test_refuses_below_default_threshold(self):
        os.environ.pop("RUN_MIN_FREE_GB", None)
        os.environ.pop("RUN_FREE_GB_CMD", None)
        with mock.patch.object(gate, "free_gb", return_value=3.9), \
             mock.patch.object(gate, "_lock") as lock:
            rc = gate.main(["--stamp", "diskrefusal_test"])
        self.assertEqual(rc, 3)
        lock.assert_not_called()

    def test_proceeds_above_default_threshold(self):
        os.environ.pop("RUN_MIN_FREE_GB", None)
        os.environ.pop("RUN_FREE_GB_CMD", None)
        # The pins check (Q1b) sits between the disk check and the lock; on a checkout without the
        # git-ignored pristine card it would refuse (7) first, which is not what this case is about.
        # The revision check (Task 19) sits just before it and refuses (8) when nothing says which
        # revision a launch would run -- which on a checkout with no game/ is the case, i.e. on every CI
        # runner. That rule is a launch's and stands; this case is not about it either, so it STATES the
        # revision with a stand-in carrying an r0001 build banner (all launch_revision reads).
        with tempfile.TemporaryDirectory() as tmp:
            elf = os.path.join(tmp, "r0001_stand_in.elf")
            with open(elf, "wb") as f:
                f.write(BANNER_STAND_IN % b"r0001 17:22:21 Oct 11 2003")   # the real r0001 image's own banner
            os.environ["SOCOM_GAME_ELF"] = elf
            with mock.patch.object(gate, "free_gb", return_value=4.1), \
                 mock.patch.object(gate, "check_pins", return_value=([], {}, False)), \
                 mock.patch.object(gate, "freshness_roots", return_value=[]), \
                 mock.patch.object(gate, "_lock", side_effect=self._busy_lock):
                rc = gate.main(["--stamp", "diskrefusal_test"])
        # Got past the disk check into the real-run path, which then found the (mocked) lock busy.
        self.assertEqual(rc, 2)

    def test_threshold_moves_with_run_min_free_gb(self):
        os.environ["RUN_MIN_FREE_GB"] = "10"
        with mock.patch.object(gate, "free_gb", return_value=9.0), \
             mock.patch.object(gate, "_lock") as lock:
            rc = gate.main(["--stamp", "diskrefusal_test"])
        self.assertEqual(rc, 3)
        lock.assert_not_called()

    def test_refusal_message_names_the_shortfall(self):
        os.environ["RUN_MIN_FREE_GB"] = "4"
        with mock.patch.object(gate, "free_gb", return_value=1.0):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = gate.main(["--stamp", "diskrefusal_test"])
        self.assertEqual(rc, 3)
        self.assertIn("1.0", buf.getvalue())
        self.assertIn("4", buf.getvalue())

    def test_score_title_is_exempt_from_disk_refusal(self):
        os.environ["RUN_MIN_FREE_GB"] = "4"
        with mock.patch.object(gate, "free_gb", return_value=0.1) as free_gb_fn:
            rc = gate.main(["--score-title", TITLE_FIXTURE_RUN])
        self.assertNotEqual(rc, 3)
        free_gb_fn.assert_not_called()

    def test_score_mission_is_exempt_from_disk_refusal(self):
        os.environ["RUN_MIN_FREE_GB"] = "4"
        with mock.patch.object(gate, "free_gb", return_value=0.1) as free_gb_fn:
            rc = gate.main(["--score-mission", GOOD_MISSION_FIXTURE])
        self.assertNotEqual(rc, 3)
        free_gb_fn.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class FadeBeforeBriefing(unittest.TestCase):
    """The content-scored transition (s6_fade, 2026-09-16). With a controller configuration saved on the memory card
    the boot shows no configuration screens and no 'save to memory card?' dialog, so no ifburst ever fires; the fade
    to black happens during the rank press's own settle wait, and that step's index drifts with how many boot screens
    the run showed (s05 in s6_fade, s07 nominal), so no step-pinned burst can catch it. gate.fade_frames scores by
    content instead: every capture of the run in capture order, the FIRST frame whose header band matches
    scripts/parity/ref_briefing_ours.png ends the fade, the briefing's own fade-in (non-black frames within
    FADE_IN_MAX_S before it) is skipped, and the contiguous black-screen run before that is the transition. The boot's
    black screens sit behind the main menu, a non-black frame, so they never join the run."""

    BLACK, MENU, DIM = (0, 0, 0), (90, 90, 90), (40, 40, 40)

    @staticmethod
    def _write(run, frames, spacing=1.0):
        """frames: (name, colour | "briefing") in capture order; mtimes `spacing` seconds apart."""
        t0 = 1_700_000_000.0
        for k, (name, colour) in enumerate(frames):
            p = os.path.join(run, name)
            if colour == "briefing":
                shutil.copyfile(gate.BRIEFING_REF, p)
            else:
                Image.new("RGB", (640, 448), colour).save(p)
            os.utime(p, (t0 + k * spacing, t0 + k * spacing))

    def _boot(self):
        return [("w00_000.png", self.BLACK), ("w00_001.png", self.BLACK), ("s00_CROSS.png", self.BLACK),
                ("s03_CROSS.png", self.MENU), ("s04_CROSS.png", self.MENU)]

    def test_counts_the_black_run_before_the_first_briefing_frame(self):
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(6)]
                        + [("s05_CROSS.png", "briefing"), ("w07_000.png", self.BLACK)])
            black, first = gate.fade_frames(run)
            self.assertEqual(first, "s05_CROSS.png")
            self.assertEqual([n for n, _ in black], ["w05_%03d.png" % k for k in range(6)])
            ok, detail = gate.score_transition(run)
        self.assertTrue(ok, detail)
        self.assertIn("6 black-screen frames examined before the first briefing frame (s05_CROSS.png)", detail)

    def test_the_briefing_fade_in_is_skipped(self):
        """w06_002 in s6_fade: the header half-drawn (band dist 11.9), the screen not black -- the walk back must
        step over such frames, bounded by FADE_IN_MAX_S, and still find the black run behind them."""
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(6)]
                        + [("w06_000.png", self.DIM), ("w06_001.png", self.DIM), ("s06_CROSS.png", "briefing")],
                        spacing=0.5)
            black, first = gate.fade_frames(run)
            self.assertEqual(first, "s06_CROSS.png")
            self.assertEqual(len(black), 6)

    def test_a_menu_frame_inside_the_fade_in_window_ends_the_search(self):
        """The skip is for the briefing's fade-in only: a non-black frame older than FADE_IN_MAX_S before the first
        briefing frame is a screen, and nothing behind it is the transition."""
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(6)]
                        + [("w06_000.png", self.MENU), ("w06_001.png", self.MENU), ("w06_002.png", self.MENU),
                           ("s06_CROSS.png", "briefing")], spacing=1.0)
            black, first = gate.fade_frames(run)
            self.assertEqual(first, "s06_CROSS.png")
            self.assertEqual(black, [])

    def test_fewer_than_the_floor_fails(self):
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(2)]
                        + [("s05_CROSS.png", "briefing")])
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("2 black-screen frames examined before the first briefing frame", detail)
        self.assertIn("need 3", detail)

    def test_no_briefing_frame_examines_nothing(self):
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(6)])
            self.assertEqual(gate.fade_frames(run), ([], None))
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("0 black-screen frames examined", detail)
        self.assertIn("no briefing frame", detail)

    def test_a_lit_band_fails(self):
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w05_%03d.png" % k, self.BLACK) for k in range(6)]
                        + [("s05_CROSS.png", "briefing")])
            p = os.path.join(run, "w05_003.png")
            stamp = os.path.getmtime(p)
            im = Image.open(p).convert("RGB")
            im.putpixel((320, 420), (255, 255, 255))
            im.save(p)
            os.utime(p, (stamp, stamp))          # keep its place in capture order
            ok, detail = gate.score_transition(run)
        self.assertFalse(ok, detail)
        self.assertIn("NOT BLACK", detail)
        self.assertIn("w05_003.png", detail)

    def test_order_is_capture_time_not_file_name(self):
        """Step names lie about time only when the run's steps drifted; capture order is what the fade is measured on."""
        with tempfile.TemporaryDirectory() as run:
            self._write(run, self._boot() + [("w09_%03d.png" % k, self.BLACK) for k in range(6)]
                        + [("s02_none.png", "briefing")])
            black, first = gate.fade_frames(run)
            self.assertEqual(first, "s02_none.png")
            self.assertEqual(len(black), 6)

    def test_a_fired_ifburst_still_wins(self):
        """A run whose dialog was answered scores from its NO-press burst exactly as before."""
        ok, detail = gate.score_transition(TRANSITION_FIXTURE_RUN)
        self.assertTrue(ok, detail)
        self.assertIn("at/after the burst step", detail)

    @unittest.skipUnless(os.path.isdir(os.path.join(ROOT, "logs", "parity", "gate", "s6_fade", "transition")),
                         "needs logs/parity/gate/s6_fade/transition")
    def test_the_s6_fade_run(self):
        """The run that motivated this: 1 Hz wait captures caught five black frames between the rank press and the
        briefing (w05_001, w05_002, s05_CROSS, w06_000, w06_001; w06_002 is the fade-in)."""
        black, first = gate.fade_frames(os.path.join(ROOT, "logs", "parity", "gate", "s6_fade", "transition"))
        self.assertEqual(first, "w06_003.png")
        self.assertEqual([n for n, _ in black],
                         ["w05_001.png", "w05_002.png", "s05_CROSS.png", "w06_000.png", "w06_001.png"])


class DriveCommand(unittest.TestCase):
    """run_gate's drive.py command line per stage: the transition stage captures its settle waits at 5 fps
    (--wait-period 0.2) so a ~3 s fade yields well over TRANSITION_MIN_FRAMES frames; the other stages keep 1 Hz."""

    def test_transition_stage_captures_waits_at_five_fps(self):
        cmd = gate.drive_command("transition", os.path.join("out", "transition"))
        self.assertIn("--wait-period", cmd)
        self.assertEqual(cmd[cmd.index("--wait-period") + 1], "0.2")
        self.assertEqual(cmd[cmd.index("--script") + 1], gate.GATES["transition"]["script"])

    def test_other_stages_keep_the_default(self):
        for name in ("title", "mission"):
            self.assertNotIn("--wait-period", gate.drive_command(name, os.path.join("out", name)))


class BlackRowsExamine(unittest.TestCase):
    def test_examine_reports_black_screen_and_band_peak(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "f.png")
            Image.new("RGB", (640, 448), (0, 0, 0)).save(p)
            self.assertEqual(black_rows.examine(p), (True, 0))
            im = Image.open(p).convert("RGB")
            im.putpixel((10, 430), (20, 20, 20))
            im.save(p)
            self.assertEqual(black_rows.examine(p), (True, 20))
            im.putpixel((10, 10), (200, 0, 0))
            im.save(p)
            self.assertEqual(black_rows.examine(p)[0], False)


class ConsoleSpawnNeedsAHudFrame(unittest.TestCase):
    """s6_gamepad5 (2026-09-16): the capture after the HUD match was the letterboxed location cinematic (gameplay band
    0.56, HUD frames read 0.92) and the console comparison printed `water flat=0.071` on it -- the only sub-0.5 flat
    figure ever, and meaningless. A frame that is not a HUD frame is NO-DATA, not a verdict."""

    def _run(self, frame):
        with tempfile.TemporaryDirectory() as tmp:
            run = os.path.join(tmp, "mission")
            os.makedirs(run)
            log = os.path.join(tmp, "mission.drive.log")
            with open(log, "w") as f:
                f.write("untilref(scripts/parity/ref_hud_ours.png): 2 presses, dist=15.9 bands=0.92, matched=True"
                        + chr(10) + "s28_none t= 1.0s stable=True waited=0.0s" + chr(10))
            frame.save(os.path.join(run, "s28_none.png"))
            return gate.console_spawn_line(log, run)

    def test_a_letterboxed_cinematic_frame_is_no_data(self):
        im = Image.new("RGB", (640, 448), (90, 80, 70))
        for y in list(range(0, 30)) + list(range(418, 448)):        # the cinematic's black bars
            for x in range(640):
                im.putpixel((x, y), (0, 0, 0))
        line = self._run(im)
        self.assertTrue(line.startswith("CONSOLE spawn NO-DATA"), line)
        self.assertIn("not a HUD frame", line)
        self.assertNotIn("flat=", line)

    def test_a_hud_frame_is_still_scored(self):
        """The committed lit-look HUD frame (mission/lum/s28_none.png, s6_lum3), and s6_gamepad4's where it is kept."""
        frames = [os.path.join(FIXTURES, "mission", "lum", "s28_none.png")]
        frames += [HUD_FRAME_S6_GAMEPAD4] if os.path.isfile(HUD_FRAME_S6_GAMEPAD4) else []
        for frame in frames:
            with Image.open(frame) as im:
                line = self._run(im.convert("RGB"))
            self.assertIn("water flat=", line, frame)


class BaselineScoring(unittest.TestCase):
    """Sprint 6 Task 8: `gate.py --baseline <stamp>` re-scores a saved run directory without launching anything:
    each stage the stamp holds (title/, transition/, mission.drive.log with its frames) goes through the same
    scorer the live gate used, and nothing is written."""

    def _stamp(self, tmp, stages):
        import os
        if "title" in stages:
            os.makedirs(os.path.join(tmp, "title"))
        if "transition" in stages:
            os.makedirs(os.path.join(tmp, "transition"))
        if "mission" in stages:
            os.makedirs(os.path.join(tmp, "mission"))
            with open(os.path.join(tmp, "mission.drive.log"), "w") as f:
                f.write("drive\n")
        return tmp

    def test_scores_every_stage_the_stamp_holds_and_writes_nothing(self):
        import io, os, tempfile
        from contextlib import redirect_stdout
        from unittest import mock
        from tools_py.parity import gate
        with tempfile.TemporaryDirectory() as tmp:
            stamp = self._stamp(tmp, ("title", "transition", "mission"))
            before = sorted(os.listdir(stamp))
            calls = []
            with mock.patch.object(gate, "score_title", lambda d: (calls.append(("title", d)) or (True, "t"))), \
                 mock.patch.object(gate, "score_transition", lambda d: (calls.append(("transition", d)) or (True, "x"))), \
                 mock.patch.object(gate, "score_mission_log",
                                   lambda log, run_log=None, probe_required=False, revision=None: (calls.append(("mission", log, probe_required, revision)) or (False, "m"))):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = gate.main(["--baseline", stamp])
            self.assertEqual(rc, 1, out.getvalue())
            self.assertEqual([c[0] for c in calls], ["title", "transition", "mission"])
            self.assertEqual(calls[0][1], os.path.join(stamp, "title"))
            self.assertEqual(calls[2][1], os.path.join(stamp, "mission.drive.log"))
            self.assertTrue(calls[2][2], "the mission is scored with the probe required, as the live gate does")
            # This stamp records no PS2X_PEEK and has no game log, so nothing says which column its rows
            # are in: the re-score passes None and the probe says UNKNOWN-REVISION rather than reading
            # r0001's addresses (review F1).
            self.assertIsNone(calls[2][3])
            self.assertIn("PASS title (t)", out.getvalue())
            self.assertIn("FAIL mission (m)", out.getvalue())
            self.assertIn("GATE FAIL (2/3) [baseline", out.getvalue())
            self.assertEqual(sorted(os.listdir(stamp)), before, "a baseline scoring writes nothing into the stamp")

    def test_only_the_stages_present_and_nothing_is_an_error(self):
        import io, tempfile
        from contextlib import redirect_stdout
        from unittest import mock
        from tools_py.parity import gate
        with tempfile.TemporaryDirectory() as tmp:
            stamp = self._stamp(tmp, ("title",))
            with mock.patch.object(gate, "score_title", lambda d: (True, "t")):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = gate.main(["--baseline", stamp])
            self.assertEqual(rc, 0)
            self.assertIn("GATE PASS (1/1) [baseline", out.getvalue())
        with tempfile.TemporaryDirectory() as tmp:
            out = io.StringIO()
            with redirect_stdout(out):
                rc = gate.main(["--baseline", tmp])
            self.assertEqual(rc, 4)
            self.assertIn("nothing to score", out.getvalue())
