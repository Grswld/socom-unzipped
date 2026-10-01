"""Sprint 17 F (docs/research/83): the entry-0 shapes of the mission's VU1 swarm, from PS2X_VU1_DUMP files.

tools_py/parity/vu1_entry0_shapes.py traces the integer control flow of a dump from its start pc (the lower
pipeline only: XTOP, ILW, the integer ALU, the branches, LQI/SQI's pointer steps, XGKICK, the E bit) and tables the
programs by their TOP header. The image is the mission's own, from the in-tree fixtures: research/12 verified that
every title-screen entry 0 runs exactly 82 pairs and ends at 0x1b50 without a kick (tests/fixtures/vu1/title), and
the other headers here are written into a copy of that dump.
"""
import contextlib
import io
import os
import shutil
import struct
import tempfile
import unittest

from tools_py.parity import vu1_entry0_shapes as e0

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TITLE = os.path.join(ROOT, "tests", "fixtures", "vu1", "title", "vu1_prog_0.bin")


def with_header(blob, x=0, y=0, z=0, w=0, pc=None):
    """The title dump with another TOP header (and, optionally, another start pc)."""
    out = bytearray(blob)
    top = struct.unpack_from("<I", out, 4)[0] & 0x3FF
    struct.pack_into("<4I", out, e0.DATA_OFFSET + top * 16, x, y, z, w)
    if pc is not None:
        struct.pack_into("<I", out, 0, pc)
    return bytes(out)


def with_code(blob, pairs):
    """The dump with its code replaced from pc 0 (`pairs`: (lower, upper) words) and every vi zero."""
    out = bytearray(blob)
    struct.pack_into("<16i", out, e0.VI_OFFSET, *([0] * 16))
    out[e0.HEADER_BYTES:e0.HEADER_BYTES + e0.CODE_BYTES] = bytes(e0.CODE_BYTES)
    for k, (lower, upper) in enumerate(pairs):
        struct.pack_into("<II", out, e0.HEADER_BYTES + k * 8, lower, upper)
    return bytes(out)


class Dir:
    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="vu1_entry0_shapes_")

    def put(self, name, blob):
        with open(os.path.join(self.path, name), "wb") as fh:
            fh.write(blob)
        return os.path.join(self.path, name)

    def close(self):
        shutil.rmtree(self.path, ignore_errors=True)


class TraceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TITLE, "rb") as fh:
            cls.title = fh.read()

    def trace(self, blob):
        return e0.trace_dump(e0.read_dump_bytes("t.bin", blob))

    def test_the_title_entry_runs_research_12s_82_pairs_to_0x1b50_without_a_kick(self):
        t = self.trace(self.title)
        self.assertEqual((t.pairs, t.end_pc, t.kicks, t.stopped), (82, 0x1B50, [], None))
        # research/12 finding 5: the 13 qwords entry 0 writes on the title screen.
        self.assertEqual(sorted(t.stores), [0, 1, 2, 3, 30, 31, 32, 33, 34, 35, 36, 327, 328])

    def test_the_kick_bit_sends_423_then_the_eight_qwords_at_330(self):
        t = self.trace(with_header(self.title, w=2))
        self.assertEqual((t.pairs, t.end_pc, t.kicks), (37, 0x1B50, [423, 330]))
        self.assertEqual(sorted(t.stores), list(range(330, 338)))

    def test_the_fade_bit_alone_stores_27_38_28_29(self):
        t = self.trace(with_header(self.title, w=8))
        self.assertEqual((t.pairs, t.kicks), (34, []))
        self.assertEqual(sorted(t.stores), [27, 28, 29, 38])

    def test_a_list_upload_copies_z_qwords_to_340_two_by_two(self):
        # Five pairs to the IBLTZ and its delay slot (one SQI), two more to the IBGTZ and its (the second): an odd
        # count leaves on the IBLTZ with its last qword stored, an even one on the IBGTZ.
        seven = self.trace(with_header(self.title, z=7))
        self.assertEqual(sorted(seven.stores), list(range(340, 347)))
        six = self.trace(with_header(self.title, z=6))
        self.assertEqual(sorted(six.stores), list(range(340, 346)))
        self.assertEqual((six.pairs, seven.pairs), (48, 53))
        both = self.trace(with_header(self.title, z=5, w=8))
        self.assertEqual(sorted(both.stores), [27, 28, 29, 38] + list(range(340, 345)))

    def test_an_op_that_needs_the_float_state_stops_the_trace(self):
        # IADDIU vi1, vi0, 1 ; FMAND vi2, vi1 ; IBEQ vi2, vi0 -> a branch on a flag the tracer does not model.
        iaddiu = (0x08 << 25) | (1 << 16) | 1
        fmand = (0x1A << 25) | (2 << 16) | (1 << 11)
        blob = with_code(with_header(self.title, pc=0), [(iaddiu, 0x2FF), (fmand, 0x2FF)])
        t = self.trace(blob)
        self.assertEqual(t.stopped, "FMAND at 0x8")
        self.assertEqual(t.pairs, 1)

    def test_a_branch_reads_the_old_value_of_a_vi_the_pair_before_wrote(self):
        # 0x0 IADDIU vi1, vi0, 1 ; 0x8 IBNE vi1, vi0, +2 (reads vi1 = 0: falls through) ; 0x10 delay ;
        # 0x18 NOP|E ; 0x20 NOP -- a taken branch would land on 0x20 and run to the end of the image.
        iaddiu = (0x08 << 25) | (1 << 16) | 1
        ibne = (0x29 << 25) | (1 << 16) | (0 << 11) | 2
        e_bit = 0x2FF | (1 << 30)
        t = self.trace(with_code(self.title, [(iaddiu, 0x2FF), (ibne, 0x2FF), (0, 0x2FF), (0, e_bit), (0, 0x2FF)]))
        self.assertEqual((t.pairs, t.end_pc, t.stopped), (5, 0x28, None))


class TableTest(unittest.TestCase):
    def setUp(self):
        with open(TITLE, "rb") as fh:
            title = fh.read()
        self.dir = Dir()
        self.addCleanup(self.dir.close)
        self.dir.put("vu1_prog_0.bin", with_header(title, w=1))
        self.dir.put("vu1_prog_1.bin", with_header(title, w=8))
        self.dir.put("vu1_prog_2.bin", with_header(title, z=7))
        self.dir.put("vu1_prog_3.bin", with_header(title, w=2))
        self.dir.put("vu1_prog_4.bin", with_header(title, pc=0x1B50))
        self.dir.put("vu1_prog_5.bin", with_header(title, w=1))
        self.dir.put("vu1_prog_10.bin", with_header(title, w=2))
        self.dir.put("vu1_prog_11.bin", with_header(title, pc=0x1B50))
        self.dir.put("short.bin", b"\0" * 100)

    def test_the_table_groups_by_path_with_counts_pairs_and_kicks(self):
        table = e0.shape_table(e0.dumps_in(self.dir.path))
        self.assertEqual([row[:4] for row in table], [
            ["kick", 2, [37], [(423, 330)]],
            ["matrix", 2, [82], [()]],
            ["fade", 1, [34], [()]],
            ["list", 1, [53], [()]],
        ])
        self.assertEqual(table[0][4], "vu1_prog_3.bin")

    def test_the_groups_between_dispatcher_entries(self):
        groups = e0.group_table(e0.dumps_in(self.dir.path, entry=None))
        self.assertEqual(groups, [("matrix fade list kick -> 0x1b50", 1), ("matrix kick -> 0x1b50", 1)])

    def test_the_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(e0.main([self.dir.path, "--groups"]), 0)
        text = out.getvalue()
        self.assertIn("6 entry-0 dump(s), mean 54.2 pairs", text)
        self.assertIn("matrix fade list kick -> 0x1b50", text)
        empty = Dir()
        self.addCleanup(empty.close)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(e0.main([empty.path]), 1)


if __name__ == "__main__":
    unittest.main()
