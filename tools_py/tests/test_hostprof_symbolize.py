"""Issue #95 -- tools_py/hostprof_symbolize.py reads a PS2X_HOST_PROF_STACKS=1 histogram.

With the stacks knob the host profiler (game_overrides_socom2.cpp, ps2HostProfStart) appends
"stack <count> leaf;caller;..." lines of raw absolute addresses after the "rva count" lines. The
symboliser did int(parts[0], 16) on the word "stack" and died with a ValueError, so the documented
command failed on every stacks profile. The stack lines are the input of tools_py/hostprof_stacks.py;
the flat symboliser skips them, counts them in its header line, and keeps them out of the sample total
(their counts repeat the flat samples). The exe is never read: image_base, symbols and demangle are
replaced by a planted two-symbol table.
"""
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from tools_py import hostprof_symbolize as hs

BASE = 0x140000000
SYMS = [(BASE + 0x1000, "node_0x100000"), (BASE + 0x2000, "gsFlush")]

# The exact shape the Windows writer produces: header, flat "rva count" lines (an "ext" one for another
# module), "stack <n> a;b;c" lines leaf first, then the per-thread lines.
HIST = (
    "base 0x140000000 total 10\n"
    "1010 6\n"
    "2004 3\n"
    "7ffb0dd44a14 1 ext ntdll.dll+0x164a14\n"
    "stack 6 140001010;140002004;7ffb0b23cd30\n"
    "stack 3 140002004;7ffb0dc8caec\n"
    "thread 4242 10 GameThread\n"
)


class StacksHistogram(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "hostprof.txt")
        with open(self.path, "w") as f:
            f.write(HIST)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_main(self, *extra):
        out = io.StringIO()
        with mock.patch.object(hs, "image_base", return_value=BASE), \
                mock.patch.object(hs, "symbols", return_value=SYMS), \
                mock.patch.object(hs, "demangle", return_value={}), \
                mock.patch.object(sys, "argv", ["hostprof_symbolize.py", self.path, "--top", "40", *extra]), \
                contextlib.redirect_stdout(out):
            hs.main()
        return out.getvalue().splitlines()

    def test_the_stack_lines_do_not_crash_and_are_counted_as_skipped(self):
        lines = self.run_main()
        self.assertIn("stack lines skipped 2", lines[0])
        self.assertIn("samples in file 10", lines[0])  # the stack counts are not added to the total

    def test_the_flat_samples_still_symbolise(self):
        lines = self.run_main()
        body = "\n".join(lines[1:])
        self.assertRegex(body, r"60\.00%\s+6\s+node_0x100000")
        self.assertRegex(body, r"30\.00%\s+3\s+gsFlush")
        self.assertRegex(body, r"10\.00%\s+1\s+<ext> ntdll\.dll")
        self.assertIn("thread   4242", body)

    def test_a_two_line_histogram_one_sample_one_stack(self):
        # The issue's closing bar: one sample line, one stack line.
        with open(self.path, "w") as f:
            f.write("base 0x140000000 total 1\n1010 1\nstack 1 140001010\n")
        lines = self.run_main()
        self.assertIn("stack lines skipped 1", lines[0])
        self.assertRegex(lines[-1], r"100\.00%\s+1\s+node_0x100000")


if __name__ == "__main__":
    unittest.main()
