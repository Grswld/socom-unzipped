"""The shapes of the VU1 command lists native entry 0x33c8 refused (Sprint 17 F N1c, docs/research/82 section 9).

What is read. PS2X_VU1_DUMP_REFUSED=<dir>[:<count>[:<entrypc>]] (runtime/vu1_dump_refused.h) writes each program the
native path refused as resume_command or write_range as <dir>/vu1_refused_<n>_<reason>_<cmd>.bin, PS2X_VU1_DUMP's
format: a 16-byte header (startPc, top, itop, codeSize), code 16 KB, VU data 16 KB, vi[16], vf[32][4]. Any directory
of that format is read (a PS2X_VU1_DUMP capture too: --last-bone keeps the 0x33c8 entries whose vi5 bit 2 is set,
the only ones with a resumed list; a bone pass's TOP+2 is not a list header).

What is printed. Each list walked as the dispatcher runs it, from the resume index (vi14 at entry 0x33c8, 0
elsewhere) through its 0x42, one command per list qword at 340 (x lane, low 16 bits), with:
  * the inline blocks stepped over -- 0x30/0x32 take 8 qwords a block, 0x34 11, the block count in the command's
    z (research/13 3.1-3.2) -- and printed as `32{1}`;
  * the 0x02 family's primitive loop printed once: 0x4c's loop target is the y of the qword AFTER the 0x4c
    (research/13 3.4, 4.7), the body from that index to the 0x4c in brackets, `66 06 02 [0a 12 2a 4c]`. The walk ends
    there: the static 0x42 after a 0x4c is never dispatched (0x4c ends the program on its last primitive). `y=mixed`
    marks a loop where a culled or clipped-away primitive, which falls into 0x4c's code without a dispatch, would
    read another target: 0x20e8 reads the y of qword 340+vi14, and vi14 is then one past the 0x02 (the first
    primitive) or the target itself (a later one), not one past the 0x4c. Those three y must all be the target --
    the invariant research/13 4.7 found in its 39 lists and a proof may not assume;
  * `(no end)` when neither 0x42 nor 0x4c comes within 64 qwords or 32 commands (the dispatcher's own bounds).

Then a table of the distinct shapes: count, the refusal (reason and command from the file name), the primitive
counts (TOP+2.w) and vertex counts (TOP+2.z) seen, and one file holding it -- the input N1c's write proof needs.

    python -m tools_py.parity.vu1_refused_shapes <dir> [--entry <pc>] [--last-bone] [--quiet]

--quiet prints the table only. Exits 1 when the directory holds no dump that passes the filter.
"""
import argparse
import os
import re
import struct
import sys

CODE_BYTES = 0x4000
DATA_BYTES = 0x4000
HEADER_BYTES = 16
DATA_OFFSET = HEADER_BYTES + CODE_BYTES           # 16400
VI_OFFSET = DATA_OFFSET + DATA_BYTES              # 32784
VF_OFFSET = VI_OFFSET + 16 * 4                    # 32848
DUMP_BYTES = VF_OFFSET + 32 * 4 * 4               # 33360

LIST_QWORD = 340
LIST_QWORDS = 64      # the dispatcher's kMaxListQwords
MAX_COMMANDS = 32     # its kMaxCommands
RESUME_ENTRY = 0x33C8

END = 0x42
LOOP_BACK = 0x4C
BLOCK_QWORDS = {0x30: 8, 0x32: 8, 0x34: 11}

NAME_RE = re.compile(r"vu1_refused_[0-9]+_([a-z_]+)_0x([0-9a-fA-F]+)\.bin$")


def _s16(value):
    value &= 0xFFFF
    return value - 0x10000 if value & 0x8000 else value


class Dump:
    """One PS2X_VU1_DUMP-format file: its header, VU data memory and vi registers."""

    def __init__(self, path, blob):
        self.path = path
        self.pc, self.top_raw, self.itop, self.code_size = struct.unpack_from("<4I", blob, 0)
        self.data = blob[DATA_OFFSET:DATA_OFFSET + DATA_BYTES]
        self.vi = struct.unpack_from("<16i", blob, VI_OFFSET)
        m = NAME_RE.search(os.path.basename(path))
        self.reason = m.group(1) if m else "-"
        self.command = int(m.group(2), 16) if m else None

    @property
    def top(self):
        return self.top_raw & 0x3FF

    def word(self, qword, lane):
        """ILW: the low 16 bits of one word of a qword, sign-extended (VU data wraps at 16 KB)."""
        return _s16(struct.unpack_from("<I", self.data, ((qword * 16) & 0x3FFF) + lane * 4)[0])

    def command_at(self, index):
        return struct.unpack_from("<I", self.data, ((LIST_QWORD + index) * 16) & 0x3FFF)[0] & 0xFFFF

    @property
    def resume(self):
        return _s16(self.vi[14]) if self.pc == RESUME_ENTRY else 0

    @property
    def last_bone(self):
        """At 0x33c8: vi5 bit 2, the last bone -- the repack and the resumed list; clear, another 0x52 pass."""
        return self.pc == RESUME_ENTRY and (self.vi[5] & 4) != 0

    @property
    def primitives(self):
        return self.word(self.top + 2, 3)

    @property
    def vertices(self):
        return self.word(self.top + 2, 2)


def read_dump(path):
    with open(path, "rb") as fh:
        blob = fh.read()
    if len(blob) < DUMP_BYTES:
        return None
    return Dump(path, blob)


def walk(dump):
    """The list from the resume index as the dispatcher runs it, as one shape string."""
    items = []
    index = dump.resume
    if index < 0 or index >= LIST_QWORDS:
        return "(resume %d outside the list)" % index
    commands = 0
    while True:
        if index >= LIST_QWORDS or commands >= MAX_COMMANDS:
            items.append((index, "(no end)"))
            break
        command = dump.command_at(index)
        commands += 1
        if command in BLOCK_QWORDS:
            blocks = dump.word(LIST_QWORD + index, 2)
            items.append((index, "%02x{%d}" % (command, blocks)))
            index += 1 + BLOCK_QWORDS[command] * max(blocks, 0)
            continue
        if command == END:
            items.append((index, "%02x" % command))
            break
        if command == LOOP_BACK:
            target = dump.word(LIST_QWORD + index + 1, 1)
            items.append((index, "%02x" % command))
            return _loop_shape(dump, items, target, index)
        items.append((index, "%02x" % command))
        index += 1
    return " ".join(text for _, text in items)


def _loop_shape(dump, items, target, back_edge):
    """Brackets the loop body [target .. 0x4c]; flags a target outside the walked list or a non-uniform y."""
    indices = [i for i, _ in items]
    if target not in indices or target > back_edge:
        return " ".join(text for _, text in items) + " ->@%d?" % target
    at = indices.index(target)
    prefix = [text for _, text in items[:at]]
    body = [text for _, text in items[at:]]
    # The qwords 0x20e8 may read: after a dispatched 0x4c (back_edge + 1), and on a fall-in from 0x02's skip
    # branches, one past the dispatched 0x02 (the first primitive) or the target (a primitive 0x4c re-entered).
    read = [target, back_edge + 1]
    world = [i for i, text in items[:at] if text == "02"]
    if world:
        read.append(world[-1] + 1)
    ys = {dump.word(LIST_QWORD + i, 1) for i in read}
    shape = " ".join(prefix + ["[" + " ".join(body) + "]"])
    return shape if ys == {target} else shape + " y=mixed"


def dumps_in(directory, entry=None, last_bone=False):
    names = sorted((n for n in os.listdir(directory) if n.endswith(".bin")), key=_natural)
    out = []
    for name in names:
        dump = read_dump(os.path.join(directory, name))
        if dump is None or (entry is not None and dump.pc != entry) or (last_bone and not dump.last_bone):
            continue
        out.append(dump)
    return out


def _natural(name):
    return [int(p) if p.isdigit() else p for p in re.split(r"([0-9]+)", name)]


def shape_table(dumps):
    """Distinct shapes: [shape, count, refusals, primitive counts, vertex counts, first file], most frequent first."""
    rows = {}
    for dump in dumps:
        shape = walk(dump)
        row = rows.setdefault(shape, {"count": 0, "refusals": set(), "prims": set(), "verts": set(),
                                      "first": os.path.basename(dump.path)})
        row["count"] += 1
        if dump.command is not None:
            row["refusals"].add("%s 0x%x" % (dump.reason, dump.command))
        row["prims"].add(dump.primitives)
        row["verts"].add(dump.vertices)
    table = [[shape, r["count"], sorted(r["refusals"]), sorted(r["prims"]), sorted(r["verts"]), r["first"]]
             for shape, r in rows.items()]
    table.sort(key=lambda row: (-row[1], row[0]))
    return table


def _counts(values, limit=8):
    if not values:
        return "-"
    text = ",".join(str(v) for v in values[:limit])
    return text + (",...(%d)" % len(values) if len(values) > limit else "")


def format_line(dump):
    return "%s entry=0x%x resume=%d prims=%d verts=%d : %s" % (
        os.path.basename(dump.path), dump.pc, dump.resume, dump.primitives, dump.vertices, walk(dump))


def format_table(table):
    lines = ["%-5s  %-34s  %-18s  %-18s  %s  |  %s" % ("count", "refused", "prims (TOP+2.w)", "verts (TOP+2.z)",
                                                         "first", "shape")]
    for shape, count, refusals, prims, verts, first in table:
        lines.append("%-5d  %-34s  %-18s  %-18s  %s  |  %s" % (count, "; ".join(refusals) or "-", _counts(prims),
                                                               _counts(verts), first, shape))
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("directory")
    parser.add_argument("--entry", type=lambda s: int(s, 0), default=None, help="keep one start pc (0x33c8)")
    parser.add_argument("--last-bone", action="store_true",
                        help="keep 0x33c8 last-bone entries only (vi5 bit 2), for a PS2X_VU1_DUMP capture")
    parser.add_argument("--quiet", action="store_true", help="the table only")
    args = parser.parse_args(argv)
    dumps = dumps_in(args.directory, args.entry, args.last_bone)
    if not dumps:
        print("no dump in %s%s" % (args.directory, "" if args.entry is None else " at entry 0x%x" % args.entry))
        return 1
    if not args.quiet:
        for dump in dumps:
            print(format_line(dump))
        print()
    for line in format_table(shape_table(dumps)):
        print(line)
    print("%d dump(s), %d shape(s)" % (len(dumps), len(shape_table(dumps))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
