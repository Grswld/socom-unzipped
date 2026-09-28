"""Sprint 17 F (the replay bench): the reader of dist/gs_replay_bench.exe's summary and the before/after comparison.

The bench replays a PS2X_GS_RECORD recording through the GL backend and prints one `[gs-replay-bench]` line with a
JSON beside it: the [gs-submit] split in its own field names (setup, dirty_rows, resolve, draw, readback ms/s;
flushes, readbacks, rt_direct /s), the [gs-gl stats] command buckets (submit, transfer, upload, present), the
present-interval histogram, all per 60 replayed presents. tools_py/parity/replay_bench.py reads it and compares two
runs field by field in percent.

The fixtures tests/fixtures/replay_bench/{before,after}.json are written by hand in the bench's shape (nothing from a
run): setup 200 -> 160 is -20.0 %, upload 208 -> 104 is -50.0 %, draw is unchanged (0.0 %), readback 0 -> 5 has no
percentage (None: nothing to divide by), and `only_after` exists in one summary and is left out of the comparison.
"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools_py.parity import replay_bench

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURES = os.path.join(REPO, "tests", "fixtures", "replay_bench")
BEFORE = os.path.join(FIXTURES, "before.json")
AFTER = os.path.join(FIXTURES, "after.json")

LINE = ("[gs-replay-bench] recording=mission_hud.gsr per=60frames frames=570 warmup=30 batches=540 elapsed=30000ms "
        "fps=19.00 ms_per_frame=52.6ms flushes=220000/s setup=200.0ms/s dirty_rows=8.0ms/s resolve=50.0ms/s "
        "draw=300.0ms/s readback=0.0ms/s readbacks=18.0/s rt_direct=72.5/s submit=560.0ms/s transfer=6.5ms/s "
        "upload=208.0ms/s present=14.0ms/s hist_n=569 le17=0 le20=0 le25=0 le33=12 le50=300 le100=250 over=7 "
        "longest_ms=140.5\n")


class Compare(unittest.TestCase):
    def setUp(self):
        self.rows = {name: (b, a, pct) for name, b, a, pct in replay_bench.compare(replay_bench.load(BEFORE),
                                                                                 replay_bench.load(AFTER))}

    def test_percent_is_after_against_before(self):
        self.assertAlmostEqual(self.rows["setup"][2], -20.0)
        self.assertAlmostEqual(self.rows["upload"][2], -50.0)
        self.assertAlmostEqual(self.rows["draw"][2], 0.0)
        self.assertEqual(self.rows["setup"][:2], (200.0, 160.0))

    def test_a_zero_before_has_no_percentage(self):
        self.assertEqual(self.rows["readback"], (0.0, 5.0, None))

    def test_a_field_in_one_summary_only_is_left_out(self):
        self.assertNotIn("only_after", self.rows)

    def test_the_run_totals_and_the_histogram_are_compared(self):
        self.assertAlmostEqual(self.rows["fps"][2], 25.0)
        self.assertAlmostEqual(self.rows["elapsed_ms"][2], -20.0)
        self.assertEqual(self.rows["hist_over"][:2], (7.0, 0.0))
        self.assertAlmostEqual(self.rows["hist_longest_ms"][2], (90.0 - 140.5) / 140.5 * 100.0)

    def test_the_order_is_the_before_summary_s(self):
        names = [r[0] for r in replay_bench.compare(replay_bench.load(BEFORE), replay_bench.load(AFTER))]
        self.assertLess(names.index("setup"), names.index("draw"))
        self.assertLess(names.index("draw"), names.index("hist_n"))

    def test_format_prints_one_line_a_field(self):
        lines = replay_bench.format_compare(replay_bench.compare(replay_bench.load(BEFORE), replay_bench.load(AFTER)))
        setup = [l for l in lines if l.split()[0] == "setup"]
        self.assertEqual(len(setup), 1)
        self.assertIn("-20.0%", setup[0])
        readback = [l for l in lines if l.split()[0] == "readback"][0]
        self.assertIn("n/a", readback)


class ParseLine(unittest.TestCase):
    def test_the_line_reads_as_the_json_does(self):
        s = replay_bench.parse_line(LINE)
        self.assertEqual(s["recording"], "mission_hud.gsr")
        self.assertEqual(s["frames"], 570)
        self.assertEqual(s["elapsed_ms"], 30000.0)
        self.assertEqual(s["fields"]["setup"], 200.0)
        self.assertEqual(s["fields"]["flushes"], 220000.0)
        self.assertEqual(s["hist"]["over"], 7)
        self.assertEqual(s["hist"]["longest_ms"], 140.5)
        b = replay_bench.load(BEFORE)
        self.assertEqual({k: s["fields"][k] for k in b["fields"]}, b["fields"])
        self.assertEqual(s["hist"], b["hist"])

    def test_a_line_without_the_tag_is_none(self):
        self.assertIsNone(replay_bench.parse_line("[gs-submit] elapsed=1000ms setup=1.0ms/s\n"))

    def test_the_last_tagged_line_of_an_output_wins(self):
        out = "noise\n" + LINE.replace("setup=200.0", "setup=1.0") + LINE
        self.assertEqual(replay_bench.parse_output(out)["fields"]["setup"], 200.0)


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="replay_bench_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def fake_bench(self):
        """A stand-in for the exe: echoes its arguments into the JSON it writes and prints the summary line."""
        path = os.path.join(self.tmp, "fake_bench.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write("import json, sys\n"
                    "a = sys.argv[1:]\n"
                    "out = a[a.index('--json') + 1]\n"
                    "s = json.load(open(%r, encoding='utf-8'))\n"
                    "s['argv'] = a\n"
                    "json.dump(s, open(out, 'w', encoding='utf-8'))\n"
                    "sys.stdout.write(%r)\n" % (BEFORE, LINE))
        return [sys.executable, path]

    def test_run_passes_the_recording_and_the_options_and_reads_the_json(self):
        out = os.path.join(self.tmp, "a.json")
        s = replay_bench.run(self.fake_bench(), "rec.gsr", out, warmup=10, frames=100)
        self.assertEqual(s["fields"]["setup"], 200.0)
        self.assertEqual(s["argv"][0], "rec.gsr")
        self.assertEqual(s["argv"][s["argv"].index("--warmup") + 1], "10")
        self.assertEqual(s["argv"][s["argv"].index("--frames") + 1], "100")

    def test_a_failing_bench_raises(self):
        path = os.path.join(self.tmp, "fail.py")
        with open(path, "w", encoding="utf-8") as f:
            f.write("import sys\nsys.stderr.write('no GL\\n')\nsys.exit(3)\n")
        with self.assertRaises(RuntimeError):
            replay_bench.run([sys.executable, path], "rec.gsr", os.path.join(self.tmp, "b.json"))


class Cli(unittest.TestCase):
    def run_main(self, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = replay_bench.main(argv)
        return rc, out.getvalue().splitlines()

    def test_compare_prints_and_exits_0(self):
        rc, lines = self.run_main(["compare", BEFORE, AFTER])
        self.assertEqual(rc, 0)
        self.assertTrue(any(l.split()[0] == "setup" and "-20.0%" in l for l in lines), lines)

    def test_a_missing_summary_exits_2(self):
        rc, _ = self.run_main(["compare", BEFORE, os.path.join(FIXTURES, "missing.json")])
        self.assertEqual(rc, 2)

    def test_runs_as_a_module(self):
        p = subprocess.run([sys.executable, "-m", "tools_py.parity.replay_bench", "compare", BEFORE, AFTER], cwd=REPO,
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("setup", p.stdout)


if __name__ == "__main__":
    unittest.main()
