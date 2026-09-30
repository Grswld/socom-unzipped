"""Sprint 17 F N1c (docs/research/82 section 9): the picker of the refused 0x33c8 lists' shapes.

PS2X_VU1_DUMP_REFUSED writes each refused program in PS2X_VU1_DUMP's format (runtime/vu1_dump_refused.h);
tools_py/parity/vu1_refused_shapes.py walks each list as the dispatcher runs it and tables the distinct shapes. Every
dump here is synthetic, built byte by byte in that format: the list at qword 340 (x = command, y = 0x4c's loop target,
z = an inline block count), the header at TOP+2 (x = index list offset, z = vertices, w = primitives), vi5 and vi14.
"""
import contextlib
import io
import os
import shutil
import struct
import tempfile
import unittest

from tools_py.parity import vu1_refused_shapes as shapes

TOP = 424


def make_dump(entries, pc=0x33C8, vi14=1, vi5=5, prims=38, verts=42, top=TOP):
    """A PS2X_VU1_DUMP-format blob. `entries`: (command, y, z) per list qword from index 0, or a bare command."""
    data = bytearray(shapes.DATA_BYTES)
    for k, entry in enumerate(entries):
        command, y, z = entry if isinstance(entry, tuple) else (entry, 0, 0)
        struct.pack_into("<3I", data, (shapes.LIST_QWORD + k) * 16, command, y & 0xFFFF, z & 0xFFFF)
    struct.pack_into("<4I", data, (top + 2) * 16, 100, 0, verts & 0xFFFF, prims & 0xFFFF)
    vi = [0] * 16
    vi[5], vi[14] = vi5, vi14
    blob = struct.pack("<4I", pc, top, 0, shapes.CODE_BYTES) + bytes(shapes.CODE_BYTES) + bytes(data)
    blob += struct.pack("<16i", *vi) + bytes(32 * 4 * 4)
    assert len(blob) == shapes.DUMP_BYTES
    return blob


def world_list(y=4, first_y=None):
    """`52 66 06 02 [0a 12 2a 4c] 42`: the body from index 4, every qword's y the target unless first_y is given."""
    words = [0x52, 0x66, 0x06, 0x02, 0x0A, 0x12, 0x2A, 0x4C, 0x42]
    out = [(w, y, 0) for w in words]
    if first_y is not None:
        out[4] = (0x0A, first_y, 0)
    return out


class Dir:
    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="vu1_refused_shapes_")

    def put(self, name, blob):
        with open(os.path.join(self.path, name), "wb") as fh:
            fh.write(blob)
        return os.path.join(self.path, name)

    def close(self):
        shutil.rmtree(self.path, ignore_errors=True)


class WalkTest(unittest.TestCase):
    def setUp(self):
        self.dir = Dir()
        self.addCleanup(self.dir.close)

    def walk(self, entries, **kw):
        return shapes.walk(shapes.read_dump(self.dir.put("vu1_refused_0_resume_command_0x2.bin",
                                                         make_dump(entries, **kw))))

    def test_a_linear_list_from_the_resume_index_through_its_42(self):
        self.assertEqual(self.walk([0x52, 0x66, 0x06, 0x08, 0x10, 0x40, 0x42, 0x08]), "66 06 08 10 40 42")

    def test_the_resume_index_is_vi14_at_0x33c8_and_0_at_any_other_entry(self):
        self.assertEqual(self.walk([0x52, 0x54, 0x42], vi14=2), "42")
        self.assertEqual(self.walk([0x68, 0x54, 0x42], pc=0x1B50, vi14=2), "68 54 42")

    def test_the_world_object_loop_is_printed_once_with_its_back_edge(self):
        self.assertEqual(self.walk(world_list()), "66 06 02 [0a 12 2a 4c]")

    def test_a_fall_in_reading_another_target_is_marked(self):
        # One past the 0x02 (index 4, the first primitive's fall-in) carries y = 5: a culled first primitive would
        # loop to index 5, not 4.
        self.assertEqual(self.walk(world_list(first_y=5)), "66 06 02 [0a 12 2a 4c] y=mixed")

    def test_a_loop_target_outside_the_walk_is_flagged(self):
        self.assertEqual(self.walk(world_list(y=9)), "66 06 02 0a 12 2a 4c ->@9?")

    def test_inline_blocks_are_stepped_over_by_their_count(self):
        block = [(0x8006, 0, 0)] + [(0, 0, 0)] * 7          # a GIFtag qword and seven more: never a command
        entries = [0x52, 0x66, (0x30, 0, 1)] + block + [0x72, 0x42]
        self.assertEqual(self.walk(entries), "66 30{1} 72 42")
        sphere = [(0x8006, 0, 0)] + [(0, 0, 0)] * 10
        self.assertEqual(self.walk([0x52, (0x34, 0, 1)] + sphere + [0x74, 0x42]), "34{1} 74 42")

    def test_a_list_without_an_end_inside_the_dispatchers_bounds(self):
        self.assertTrue(self.walk([0x52] + [0x08] * 63).endswith("(no end)"))

    def test_a_resume_index_outside_the_list(self):
        self.assertEqual(self.walk([0x52, 0x42], vi14=64), "(resume 64 outside the list)")


class TableTest(unittest.TestCase):
    def setUp(self):
        self.dir = Dir()
        self.addCleanup(self.dir.close)
        self.dir.put("vu1_refused_0_resume_command_0x2.bin", make_dump(world_list(), prims=38, verts=42))
        self.dir.put("vu1_refused_1_resume_command_0x2.bin", make_dump(world_list(), prims=12, verts=20))
        self.dir.put("vu1_refused_2_resume_command_0x54.bin",
                     make_dump([0x52, 0x66, 0x06, 0x08, 0x54, 0x40, 0x42], prims=7, verts=9))
        self.dir.put("vu1_refused_10_write_range_0x6.bin", make_dump([0x52, 0x06, 0x08, 0x40, 0x42], prims=5))
        self.dir.put("vu1_prog_3.bin", make_dump([0x68, 0x02, 0x42], pc=0x1B50))      # not a 0x33c8 program
        self.dir.put("vu1_prog_4.bin", make_dump([0x52, 0x66, 0x42], vi5=1))          # a bone pass
        self.dir.put("short.bin", b"\0" * 100)                                          # not a dump
        self.dir.put("refused.txt", b"an index line\n")

    def test_the_table_counts_each_shape_with_its_refusals_and_counts(self):
        table = shapes.shape_table(shapes.dumps_in(self.dir.path, entry=0x33C8, last_bone=True))
        self.assertEqual(table[0], ["66 06 02 [0a 12 2a 4c]", 2, ["resume_command 0x2"], [12, 38], [20, 42],
                                    "vu1_refused_0_resume_command_0x2.bin"])
        self.assertEqual(sorted(row[0] for row in table[1:]), ["06 08 40 42", "66 06 08 54 40 42"])
        self.assertEqual({row[0]: row[2] for row in table[1:]},
                         {"06 08 40 42": ["write_range 0x6"], "66 06 08 54 40 42": ["resume_command 0x54"]})

    def test_the_filters(self):
        names = lambda **kw: [os.path.basename(d.path) for d in shapes.dumps_in(self.dir.path, **kw)]
        # short.bin is not a dump (under PS2X_VU1_DUMP's 33,360 bytes); refused.txt is not a .bin; natural order.
        self.assertEqual(names(), ["vu1_prog_3.bin", "vu1_prog_4.bin", "vu1_refused_0_resume_command_0x2.bin",
                                   "vu1_refused_1_resume_command_0x2.bin", "vu1_refused_2_resume_command_0x54.bin",
                                   "vu1_refused_10_write_range_0x6.bin"])
        self.assertNotIn("vu1_prog_3.bin", names(entry=0x33C8))
        self.assertIn("vu1_prog_4.bin", names(entry=0x33C8))
        self.assertNotIn("vu1_prog_4.bin", names(last_bone=True))

    def test_the_cli_prints_each_list_then_the_table(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(shapes.main([self.dir.path, "--last-bone"]), 0)
        text = out.getvalue()
        self.assertIn("vu1_refused_1_resume_command_0x2.bin entry=0x33c8 resume=1 prims=12 verts=20 : "
                      "66 06 02 [0a 12 2a 4c]", text)
        self.assertIn("4 dump(s), 3 shape(s)", text)
        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet):
            shapes.main([self.dir.path, "--last-bone", "--quiet"])
        self.assertNotIn(" : 66 06 02", quiet.getvalue())
        self.assertIn("|  66 06 02 [0a 12 2a 4c]", quiet.getvalue())

    def test_the_cli_exits_1_on_no_dump(self):
        empty = Dir()
        self.addCleanup(empty.close)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(shapes.main([empty.path]), 1)
        self.assertIn("no dump", out.getvalue())


if __name__ == "__main__":
    unittest.main()
