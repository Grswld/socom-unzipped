"""Sprint 17 F (research/81 §3.4): the reader of the `[vu1-refuse]` lines, the native VU1 dispatcher's refusal count.

The runtime prints, under PS2X_VU1_NATIVE_REFUSALS=1, one `[vu1-refuse]` line per (entry, reason, cmd) key a second
(deltas: n= refusals, cycles= the fallback's VU cycles, host_us= its host time); vu1_replay prints the running totals
at its end as `[vu1-refuse-total]`. tools_py/parity/vu1_refusals.py sums them into reason, entries, share, cycles.

Every fixture line is written here in the line's shape (runtime/vu1_native_refusals.h formatRow), nothing copied
from a log. Two seconds of a walk: unknown_command cmd=0x52 (3 + 1 entries, 3000 + 1000 cycles), no_native_entry at
0x33c8 (2 + 2 entries, 5000 + 3000 cycles) and handler_clamp cmd=0x28 (2 entries, 0 cycles) -- 10 entries and 12000
cycles in all, so no_native_entry is 40 % of the entries and 66.7 % of the cycles, and sorts first.
"""
import contextlib
import io
import os
import shutil
import tempfile
import unittest

from tools_py.parity import frame_time, vu1_refusals

SAMPLER = ("[pc-sampler] live pc=0x2cece4 ra=0x2cece4 sp=0x1f7fe60 t=%.2f vsync=%d ee=%.2f seq=1 dpc=0x1e70ec "
           "idle=1 running=1\n")
LINE = "[vu1-refuse] elapsed=%dms entry=0x%x reason=%s cmd=%s n=%d cycles=%d host_us=%d\n"
TOTAL = "[vu1-refuse-total] entry=0x%x reason=%s cmd=%s n=%d cycles=%d host_us=%d\n"
OVERFLOW = "%s overflow=%d (keys past 128 slots not counted)\n"


def walk_text():
    return "".join([
        "[vu1-stats] programs/s=10 cycles/s=1 host=1 ms/s\n",                      # a neighbour, not read
        SAMPLER % (10.0, 60, 10.0),
        LINE % (1001, 0x1b50, "unknown_command", "0x52", 3, 3000, 300),
        LINE % (1001, 0x33c8, "no_native_entry", "-", 2, 5000, 500),
        SAMPLER % (20.0, 120, 20.0),
        LINE % (998, 0x33c8, "no_native_entry", "-", 2, 3000, 300),
        LINE % (998, 0x1b50, "unknown_command", "0x52", 1, 1000, 100),
        LINE % (998, 0x1b50, "handler_clamp", "0x28", 2, 0, 0),
        "[vu1-refuse] overflow=0 (keys past 128 slots not counted)\n",           # not a row
    ])


class Vu1RefusalsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vu1_refusals_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, text):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def test_rows_parse_every_field(self):
        parsed = vu1_refusals.rows(walk_text().splitlines())
        self.assertEqual(len(parsed), 5)
        self.assertEqual(parsed[0], (0x1b50, "unknown_command", 0x52, 3, 3000, 300))
        self.assertEqual(parsed[1], (0x33c8, "no_native_entry", None, 2, 5000, 500))

    def test_by_reason_sums_and_shares(self):
        result = vu1_refusals.read(self.write("game.log", walk_text()))
        self.assertEqual([r[0] for r in result], ["no_native_entry", "unknown_command", "handler_clamp"],
                         "sorted by cycles")
        label, n, share, cycles, cshare, host_ms = result[0]
        self.assertEqual((n, cycles), (4, 8000))
        self.assertAlmostEqual(share, 0.4)
        self.assertAlmostEqual(cshare, 8000 / 12000)
        self.assertAlmostEqual(host_ms, 0.8)
        self.assertEqual(result[1][1:2] + result[1][3:4], (4, 4000))
        self.assertEqual(sum(r[1] for r in result), 10)

    def test_by_key_keeps_entry_and_command(self):
        result = vu1_refusals.read(self.write("game.log", walk_text()), by="key")
        labels = [r[0] for r in result]
        self.assertIn("entry=0x1b50 unknown_command cmd=0x52", labels)
        self.assertIn("entry=0x33c8 no_native_entry cmd=-", labels)
        self.assertIn("entry=0x1b50 handler_clamp cmd=0x28", labels)

    def test_the_entry_0_split_names_its_path(self):
        # research/83 section 3.1: no_native_entry at entry 0 carries the entry-0 program's path, not a hex word.
        text = walk_text() + "".join([
            LINE % (1000, 0x0, "no_native_entry", "kick", 4, 148, 3),
            LINE % (1000, 0x0, "no_native_entry", "matrix", 2, 166, 1),
            LINE % (1000, 0x0, "no_native_entry", "fade+list", 1, 50, 0),
            LINE % (1000, 0x0, "no_native_entry", "kick", 1, 37, 1),
        ])
        parsed = vu1_refusals.rows(text.splitlines())
        self.assertEqual(len(parsed), 9, "every split line is read")
        self.assertIn((0x0, "no_native_entry", "kick", 4, 148, 3), parsed, "the path stays a name")
        self.assertIn((0x0, "no_native_entry", "fade+list", 1, 50, 0), parsed)
        result = vu1_refusals.read(self.write("game.log", text), by="key")
        by_label = {r[0]: r for r in result}
        self.assertEqual(by_label["entry=0x0 no_native_entry cmd=kick"][1:2] +
                         by_label["entry=0x0 no_native_entry cmd=kick"][3:4], (5, 185), "the kick path summed")
        self.assertIn("entry=0x0 no_native_entry cmd=matrix", by_label)
        self.assertIn("entry=0x0 no_native_entry cmd=fade+list", by_label)
        self.assertIn("entry=0x33c8 no_native_entry cmd=-", by_label, "other entries keep cmd=-")
        by_reason = {r[0]: r for r in vu1_refusals.read(self.write("game.log", text))}
        self.assertEqual(by_reason["no_native_entry"][1], 4 + 8, "by reason the paths fold into one row")
        self.assertEqual(vu1_refusals.rows([LINE % (1000, 0x0, "no_native_entry", "Kick!", 1, 1, 1)]), [],
                         "a name is lower-case letters and '+' only")

    def test_window_by_sampler_t(self):
        result = vu1_refusals.read(self.write("game.log", walk_text()), t_from=15.0)
        self.assertEqual(sum(r[1] for r in result), 5, "only the lines after the t=20 row")
        self.assertEqual(vu1_refusals.read(self.write("game.log", walk_text()), t_from=30.0), [])

    def test_totals_win_over_intervals(self):
        text = walk_text() + TOTAL % (0x1b50, "unknown_command", "0x52", 7, 7000, 700)
        result = vu1_refusals.read(self.write("replay.txt", text))
        self.assertEqual(result, [("unknown_command", 7, 1.0, 7000, 1.0, 0.7)],
                         "vu1_replay's totals already sum every program: the interval lines are not added again")

    def test_main_prints_the_table_and_exits_1_without_lines(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = vu1_refusals.main([self.write("game.log", walk_text())])
        self.assertEqual(rc, 0)
        lines = out.getvalue().splitlines()
        self.assertTrue(lines[0].startswith("reason"))
        self.assertTrue(lines[2].startswith("no_native_entry "))
        self.assertIn("40.0%", lines[2])
        self.assertIn("66.7%", lines[2])
        self.assertTrue(lines[-1].startswith("total "))
        self.assertIn(" 10 ", lines[-1])
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = vu1_refusals.main([self.write("empty.log", "[vu1-stats] programs/s=1\n")])
        self.assertEqual(rc, 1)
        self.assertIn("no [vu1-refuse] line", err.getvalue())

    def test_to_and_the_window_edges_are_inclusive(self):
        path = self.write("game.log", walk_text())
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(path, t_to=15.0)), 5, "--to: only the t=10 row's lines")
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(path, t_to=10.0)), 5, "a row at t == --to is inside")
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(path, t_from=20.0)), 5, "a row at t == --from is inside")
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(path, t_from=10.0, t_to=20.0)), 10)
        self.assertEqual(vu1_refusals.read(path, t_to=5.0), [], "before the first row: nothing")

    def test_a_truncated_last_line_is_dropped_not_parsed_short(self):
        last = LINE % (998, 0x1b50, "unknown_command", "0x52", 9, 9000, 91)
        unfinished = walk_text() + last[:-2]              # host_us=91 cut to host_us=9, no newline: ends mid-line
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(self.write("cut.log", unfinished))), 10,
                         "a last line without its newline may be cut anywhere, so it is not read")
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(self.write("done.log", walk_text() + last))), 19,
                         "the same line, finished, is read")
        runon = walk_text() + last[:-1] + "[gs-loop] elapsed=1000ms\n"
        self.assertEqual(sum(r[1] for r in vu1_refusals.read(self.write("runon.log", runon))), 10,
                         "a line that runs on into another is not parsed short")

    def test_overflow_is_read_and_warned(self):
        text = walk_text().replace("overflow=0", "overflow=3") + OVERFLOW % ("[vu1-refuse]", 5)
        path = self.write("game.log", text)
        self.assertEqual(vu1_refusals.read_overflow(path), 5, "the runtime's line is cumulative: the largest")
        total = text + TOTAL % (0x1b50, "unknown_command", "0x52", 7, 7000, 700) + OVERFLOW % ("[vu1-refuse-total]", 2)
        self.assertEqual(vu1_refusals.read_overflow(self.write("replay.txt", total)), 2, "the total line wins")
        self.assertEqual(vu1_refusals.read_overflow(self.write("clean.log", walk_text())), 0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = vu1_refusals.main([path])
        self.assertEqual(rc, 0)
        self.assertIn("WARNING: overflow=5", out.getvalue())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            vu1_refusals.main([self.write("clean.log", walk_text())])
        self.assertNotIn("WARNING", out.getvalue())

    def test_stamp_window_reads_the_scripted_walk(self):
        stamp = os.path.join(self.tmp, "stamp")
        os.makedirs(stamp)
        self.write(os.path.join("stamp", "mission.game.log"), walk_text())
        self.write(os.path.join("stamp", "mission.drive.log"),
                   "s27_wait  t=  5.0s untilref(%s): score=0.1 matched=True\n"
                   "s28_walk  t= 15.0s key w\n"
                   "s29_walk  t= 25.0s key w\n" % frame_time.HUD_REF_NAME)
        self.assertEqual(vu1_refusals.stamp_window(stamp), (os.path.join(stamp, "mission.game.log"), 15.0, 25.0))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = vu1_refusals.main(["--stamp", stamp])
        self.assertEqual(rc, 0)
        self.assertIn(" 5 ", out.getvalue().splitlines()[-1], "only the t=20 row's lines are in the walk")
        os.makedirs(os.path.join(self.tmp, "nostamp"))
        self.assertIsNone(vu1_refusals.stamp_window(os.path.join(self.tmp, "nostamp")))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(vu1_refusals.main(["--stamp", os.path.join(self.tmp, "nostamp")]), 1)


if __name__ == "__main__":
    unittest.main()
