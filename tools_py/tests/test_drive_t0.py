"""drive.py prints the epoch of its own step clock's zero, once (LATER row 37, fix round 1).

Every `sNN_<btn>  t=<s>` line drive.py prints is measured from the t0 it sets after its running-process checks and
the game launch -- 1.3-1.5 s after audio_parity.sh's `.drive_started` on the s16_v0_t1b_dump capture. An audio
capture's window offset needs that zero on the wall clock, so drive.py prints it as `drive_t0_epoch=` into the
stdout every capture keeps (tools_py/parity/capture_offset.py reads it). No game: every host call is patched.
"""
import contextlib
import io
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

from tools_py.parity import drive


class DriveT0Test(unittest.TestCase):
    def test_the_step_clocks_zero_is_printed_once_as_an_epoch(self):
        seen = {}

        def run_steps(a, steps, proc, hwnd, t0, last, manifest):
            seen["t0"] = t0
            print("s00_CROSS                t=   0.1s stable=True waited=0.0s", flush=True)

        with tempfile.TemporaryDirectory(prefix="drive_t0_") as tmp:
            script = os.path.join(tmp, "script.txt")
            with open(script, "w", encoding="utf-8") as fh:
                fh.write("stable+1:CROSS\n")
            argv = ["drive", "--target", "ours", "--script", script, "--out", os.path.join(tmp, "out")]
            out = io.StringIO()
            with mock.patch.object(sys, "argv", argv), \
                 mock.patch.object(drive.hostplatform, "process_running", lambda base: False), \
                 mock.patch.object(drive.hostplatform, "kill_process_by_name", lambda base: None), \
                 mock.patch.object(drive, "launch", lambda target, seconds: mock.Mock()), \
                 mock.patch.object(drive.winshot, "find_window", lambda title: 1234), \
                 mock.patch.object(drive.winshot, "keep_on_top", lambda hwnd: None), \
                 mock.patch.object(drive, "frame", lambda hwnd: object()), \
                 mock.patch.object(drive, "run_steps", run_steps), \
                 contextlib.redirect_stdout(out):
                drive.main()
        lines = out.getvalue().splitlines()
        stamps = [l for l in lines if l.startswith("drive_t0_epoch=")]
        self.assertEqual(len(stamps), 1, lines)
        self.assertRegex(stamps[0], r"^drive_t0_epoch=\d+\.\d{3}$")
        self.assertAlmostEqual(float(stamps[0].split("=", 1)[1]), seen["t0"], delta=0.0006,
                               msg="the printed epoch is the very t0 the step times are measured from")
        self.assertLess(lines.index(stamps[0]), lines.index(next(l for l in lines if re.match(r"^s\d+_", l))),
                        "it precedes the first step line")


if __name__ == "__main__":
    unittest.main()
