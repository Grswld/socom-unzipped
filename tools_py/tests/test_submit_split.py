"""Sprint 17 Task F1 Step 0: the reader of the `[gs-submit]` line, so every draw-path attempt's before/after is one command.

The runtime prints a `[gs-submit]` line once per stats cadence (Sprint 16 F2), per-second rates over its own `elapsed=`
ms and no clock of its own; tools_py/parity/submit_split.py attributes each line to the `[pc-sampler]` row before it
(frame_time's idiom for the clock-less `[vu1-stats]` line) and averages every `ms/s` and `/s` field elapsed-weighted --
sum(value * elapsed) / sum(elapsed), research/73 §8's command [C] -- over the lines whose row falls in [t_from, t_to].

The fixture is written here in the line's shape, nothing copied from a log: three sampler rows at t=10, 20, 30, each
followed by one `[gs-submit]` line with elapsed 1000, 3000, 1000 ms and setup 10, 20, 30 ms/s, so the weighted setup
is (10*1000 + 20*3000 + 30*1000) / 5000 = 20.0 exactly where the plain mean would also be 20.0 -- resolve= is planted
at 10, 40, 10 so that the weighted mean (28.0) and the plain one (20.0) differ.
"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools_py.parity import submit_split

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SAMPLER = ("[pc-sampler] live pc=0x2cece4 ra=0x2cece4 sp=0x1f7fe60 t=%.2f vsync=%d ee=%.2f seq=1 dpc=0x1e70ec "
           "idle=1 bp_pending=0 bp_waiters=0 bp_wait_ms=0 net_wait=0/0 net_park=0/0 running=1\n")
SUBMIT = ("[gs-submit] elapsed=%dms flushes=%d/s setup=%.1fms/s dirty_rows=1.5ms/s resolve=%.1fms/s draw=2.0ms/s "
          "readback=0.0ms/s readbacks=%.1f/s readback_rows=0/s readback_px=0/s rt_direct=0.0/s\n")
# (sampler t, elapsed ms, flushes/s, setup ms/s, resolve ms/s, readbacks/s)
PLANTED = ((10.0, 1000, 10, 10.0, 10.0, 1.0), (20.0, 3000, 20, 20.0, 40.0, 2.0), (30.0, 1000, 30, 30.0, 10.0, 3.0))


def fixture_text(planted=PLANTED, head=""):
    out = [head]
    for i, (t, elapsed, flushes, setup, resolve, readbacks) in enumerate(planted):
        out.append(SAMPLER % (t, 60 * (i + 1), t))
        out.append("[gs-gl stats] elapsed=%dms calls=1 submit=1.0/1\n" % elapsed)     # a neighbour, not read
        out.append(SUBMIT % (elapsed, flushes, setup, resolve, readbacks))
    return "".join(out)


class _TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="submit_split_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path


class Read(_TmpCase):
    def test_the_fields_average_elapsed_weighted(self):
        r = submit_split.read(self.write("game.log", fixture_text()))
        self.assertEqual(r["setup"], 20.0)
        self.assertEqual(r["resolve"], 28.0, "(10*1000 + 40*3000 + 10*1000) / 5000, not the plain mean 20.0")
        self.assertEqual(r["flushes"], 20.0)
        self.assertEqual(r["readbacks"], 2.0)
        self.assertEqual(r["dirty_rows"], 1.5)
        self.assertEqual(r["draw"], 2.0)
        self.assertEqual(r["lines"], 3)
        self.assertEqual(r["elapsed_ms"], 5000)

    def test_every_rate_field_is_a_key_as_printed(self):
        r = submit_split.read(self.write("game.log", fixture_text()))
        self.assertEqual(set(r), {"flushes", "setup", "dirty_rows", "resolve", "draw", "readback", "readbacks",
                                  "readback_rows", "readback_px", "rt_direct", "elapsed_ms", "lines"})

    def test_the_window_bounds_the_rows_t(self):
        path = self.write("game.log", fixture_text())
        r = submit_split.read(path, t_from=15)
        self.assertEqual((r["setup"], r["lines"], r["elapsed_ms"]), (22.5, 2, 4000))
        r = submit_split.read(path, t_to=20)
        self.assertEqual((r["setup"], r["lines"]), (17.5, 2))
        r = submit_split.read(path, t_from=20, t_to=20)
        self.assertEqual((r["setup"], r["lines"]), (20.0, 1), "the bounds are inclusive")

    def test_a_line_before_the_first_sampler_row_is_dropped(self):
        head = SUBMIT % (1000, 99, 999.0, 999.0, 99.0)
        r = submit_split.read(self.write("game.log", fixture_text(head=head)))
        self.assertEqual((r["setup"], r["lines"], r["elapsed_ms"]), (20.0, 3, 5000))

    def test_no_line_gives_an_empty_dict(self):
        self.assertEqual(submit_split.read(self.write("empty.log", "")), {})
        rows_only = "".join(SAMPLER % (t, 60, t) for t in (10.0, 20.0))
        self.assertEqual(submit_split.read(self.write("rows.log", rows_only)), {})
        self.assertEqual(submit_split.read(self.write("game.log", fixture_text()), t_from=31), {},
                         "a window with no line in it")


class FromStamp(_TmpCase):
    def test_the_walk_is_the_hud_step_to_the_last_step(self):
        stamp = os.path.join(self.tmp, "stamp")
        os.makedirs(stamp)
        with open(os.path.join(stamp, "mission.drive.log"), "w", encoding="utf-8") as f:
            f.write("untilref(scripts/parity/ref_hud_ours.png): 2 presses, dist=1.9 bands=1.00, matched=True\n"
                    "s28_none                 t=  15.0s stable=True waited=0.0s\n"
                    "s48_none                 t=  25.0s stable=True waited=0.0s\n")
        with open(os.path.join(stamp, "mission.game.log"), "w", encoding="utf-8") as f:
            f.write(fixture_text())
        r = submit_split.from_stamp(stamp)
        self.assertEqual((r["setup"], r["lines"], r["elapsed_ms"]), (20.0, 1, 3000))

    def test_no_drive_log_or_no_hud_gives_an_empty_dict(self):
        self.assertEqual(submit_split.from_stamp(os.path.join(self.tmp, "missing")), {})


class Cli(_TmpCase):
    def run_main(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = submit_split.main(argv)
        return rc, out.getvalue().splitlines()

    def test_prints_name_value_lines_and_exits_0(self):
        rc, lines = self.run_main([self.write("game.log", fixture_text())])
        self.assertEqual(rc, 0)
        self.assertIn("setup=20.0", lines)
        self.assertIn("resolve=28.0", lines)
        self.assertIn("lines=3", lines)
        self.assertIn("elapsed_ms=5000", lines)
        self.assertTrue(all(l.count("=") == 1 for l in lines), lines)

    def test_the_window_flags(self):
        rc, lines = self.run_main([self.write("game.log", fixture_text()), "--from", "15", "--to", "30"])
        self.assertEqual(rc, 0)
        self.assertIn("setup=22.5", lines)
        self.assertIn("lines=2", lines)

    def test_an_empty_log_exits_1(self):
        rc, _ = self.run_main([self.write("empty.log", "")])
        self.assertEqual(rc, 1)

    def test_runs_as_a_module(self):
        path = self.write("game.log", fixture_text())
        p = subprocess.run([sys.executable, "-m", "tools_py.parity.submit_split", path], cwd=REPO,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("setup=20.0", p.stdout.splitlines())


if __name__ == "__main__":
    unittest.main()
