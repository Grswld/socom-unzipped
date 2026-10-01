"""The shapes of the mission's VU1 entry-0 programs, from PS2X_VU1_DUMP files (Sprint 17 F, docs/research/83).

What is read. Any directory of PS2X_VU1_DUMP's format (tools_py/parity/vu1_refused_shapes.py: a 16-byte header
(startPc, top, itop, codeSize), code 16 KB, VU data 16 KB, vi[16], vf[32][4]).

What is done. Each dump is traced from its start pc on the lower pipeline's integer state only -- XTOP/XITOP, ILW/
ILWR/ISW/ISWR, the integer ALU, the branches and jumps, LQI/LQD/SQI/SQD's pointer steps, XGKICK and the E bit --
counting instruction pairs to the program's end. A branch reads the old value of a vi the pair before it wrote with
an integer op or a LQI/SQI step, as the interpreter and the generated code do (`m_viBranchBackup*`). An op that would
put float or flag state into a vi (FMAND, FCAND, FSAND, MTIR ...) stops the trace at that pair, as does an ILW from a
qword the program has already stored a vector to: the trace never guesses. Pairs are not cycles: stalls are not
modelled (research/83 compares the two).

What is printed. A table of the entry-0 programs by the path they took (named by the handler blocks visited, research/
12 section (a): `kick` 0x40, `matrix` 0x140, `verts` 0x390, `fade` 0x3f0, `list` 0x458), with the count, the pair
counts, the XGKICK addresses and the header z (the list length) seen, and one file holding it; then the mean pairs.
--groups adds the runs of entry-0 programs between two other entries, in file order (`matrix fade list kick ->
0x1b50`: the four MSCAL 0s that set up one object, then its dispatcher).

    python -m tools_py.parity.vu1_entry0_shapes <dir> [--groups] [--each]

Exits 1 when the directory holds no entry-0 dump.
"""
import argparse
import os
import re
import struct
import sys

CODE_BYTES = 0x4000
DATA_BYTES = 0x4000
HEADER_BYTES = 16
DATA_OFFSET = HEADER_BYTES + CODE_BYTES
VI_OFFSET = DATA_OFFSET + DATA_BYTES
VF_OFFSET = VI_OFFSET + 16 * 4
DUMP_BYTES = VF_OFFSET + 32 * 4 * 4

MAX_PAIRS = 100000

# The entry-0 handler's blocks, in path order (research/12 section (a)).
PATH_BLOCKS = (("kick", 0x40), ("matrix", 0x140), ("verts", 0x390), ("fade", 0x3F0), ("list", 0x458))

# Lower ops whose vi result comes from float or flag state: the trace stops on them.
OPAQUE = {0x10: "FCEQ", 0x12: "FCAND", 0x13: "FCOR", 0x14: "FSEQ", 0x16: "FSAND", 0x17: "FSOR", 0x18: "FMEQ",
          0x1A: "FMAND", 0x1B: "FMOR", 0x1C: "FCGET"}
OPAQUE_EXT = {0x3C: "MTIR"}


def _s16(value):
    value &= 0xFFFF
    return value - 0x10000 if value & 0x8000 else value


def _imm11(word):
    v = word & 0x7FF
    return v - 0x800 if v & 0x400 else v


def _imm15(word):
    return (word & 0x7FF) | (((word >> 21) & 0xF) << 11)


def _lane(word):
    """The one lane an ILW/ISW names: x is dest bit 3."""
    dest = (word >> 21) & 0xF
    for lane in range(4):
        if dest & (8 >> lane):
            return lane
    return 0


class Dump:
    def __init__(self, path, blob):
        self.path = path
        self.pc, self.top_raw, self.itop, self.code_size = struct.unpack_from("<4I", blob, 0)
        self.code = blob[HEADER_BYTES:HEADER_BYTES + CODE_BYTES]
        self.data = blob[DATA_OFFSET:DATA_OFFSET + DATA_BYTES]
        self.vi = list(struct.unpack_from("<16i", blob, VI_OFFSET))

    @property
    def top(self):
        return self.top_raw & 0x3FF

    def header(self):
        """TOP+0 as ILW reads it: (x, y, z, w), each the low 16 bits, signed."""
        return tuple(_s16(v) for v in struct.unpack_from("<4I", self.data, self.top * 16))


def read_dump_bytes(path, blob):
    return Dump(path, blob) if len(blob) >= DUMP_BYTES else None


def read_dump(path):
    with open(path, "rb") as fh:
        return read_dump_bytes(path, fh.read())


class Trace:
    def __init__(self):
        self.pairs = 0
        self.end_pc = None
        self.kicks = []
        self.stores = set()
        self.visited = set()
        self.stopped = None

    @property
    def path(self):
        names = [name for name, pc in PATH_BLOCKS if pc in self.visited]
        return "+".join(names) if names else "none"


def trace_dump(dump):
    """The integer-path trace of one dump from its start pc (see the module docstring)."""
    t = Trace()
    data = bytearray(dump.data)
    vi = [_s16(v) for v in dump.vi]
    vi[0] = 0
    code = dump.code
    pc = dump.pc & 0x3FF8
    hazard = None                  # (reg, old value) a branch in the next pair reads instead of vi[reg]
    pending = None                 # (target, pairs left before it is taken)
    end_after = None               # pairs left after an E bit
    dirty = set()                  # qwords a vector store wrote: their words are not known

    def branch_read(reg, hz):
        if reg == 0:
            return 0
        if hz is not None and hz[0] == reg:
            return hz[1]
        return vi[reg]

    def word_at(qword, lane):
        qword &= 0x3FF
        if qword in dirty:
            return None
        return _s16(struct.unpack_from("<I", data, qword * 16 + lane * 4)[0])

    while True:
        if t.pairs >= MAX_PAIRS:
            t.stopped = "limit at 0x%x" % pc
            break
        lower, upper = struct.unpack_from("<II", code, pc)
        t.visited.add(pc)
        new_hazard = None
        stop = None
        write = None               # (reg, value)
        target = None
        if not upper & 0x80000000:
            op = (lower >> 25) & 0x7F
            it = (lower >> 16) & 0xF
            is_ = (lower >> 11) & 0xF
            id_ = (lower >> 6) & 0xF
            if op == 0x40:
                low = lower & 0x3F
                if low < 0x3C:
                    if low in (0x30, 0x31, 0x34, 0x35):
                        a, b = vi[is_], vi[it]
                        value = {0x30: a + b, 0x31: a - b, 0x34: a & b, 0x35: a | b}[low]
                        write = (id_, value)
                        new_hazard = True
                    elif low == 0x32:
                        imm = (lower >> 6) & 0x1F
                        write = (it, vi[is_] + (imm - 32 if imm & 0x10 else imm))
                        new_hazard = True
                else:
                    ext = ((lower >> 6) & 0x1F) << 2 | (low & 3)
                    if ext in OPAQUE_EXT:
                        stop = OPAQUE_EXT[ext]
                    elif ext in (0x34, 0x36):          # LQI, LQD: the base register steps
                        write = (is_, vi[is_] + (1 if ext == 0x34 else -1))
                        new_hazard = True
                    elif ext in (0x35, 0x37):          # SQI, SQD
                        address = vi[it] if ext == 0x35 else vi[it] - 1
                        t.stores.add(address & 0x3FF)
                        dirty.add(address & 0x3FF)
                        write = (it, vi[it] + (1 if ext == 0x35 else -1))
                        new_hazard = True
                    elif ext == 0x3E:                  # ILWR
                        value = word_at(vi[is_], _lane(lower))
                        if value is None:
                            stop = "ILWR of stored qword %d" % (vi[is_] & 0x3FF)
                        else:
                            write = (it, value)
                    elif ext == 0x3F:                  # ISWR
                        _store_word(data, vi[is_], _lane(lower), vi[it], t, dirty)
                    elif ext == 0x68:
                        write = (it, dump.top_raw & 0x3FF)
                    elif ext == 0x69:
                        write = (it, dump.itop & 0x3FF)
                    elif ext == 0x6C:
                        t.kicks.append(vi[is_] & 0xFFFF)
            elif op in OPAQUE:
                stop = OPAQUE[op]
            elif op == 0x01:                           # SQ
                address = vi[it] + _imm11(lower)
                t.stores.add(address & 0x3FF)
                dirty.add(address & 0x3FF)
            elif op == 0x04:                           # ILW
                value = word_at(vi[is_] + _imm11(lower), _lane(lower))
                if value is None:
                    stop = "ILW of stored qword %d" % ((vi[is_] + _imm11(lower)) & 0x3FF)
                else:
                    write = (it, value)
            elif op == 0x05:                           # ISW
                _store_word(data, vi[is_] + _imm11(lower), _lane(lower), vi[it], t, dirty)
            elif op in (0x08, 0x09):                   # IADDIU, ISUBIU
                write = (it, vi[is_] + (_imm15(lower) if op == 0x08 else -_imm15(lower)))
                new_hazard = True
            elif op in (0x20, 0x21):                   # B, BAL
                target = (pc + 8 + _imm11(lower) * 8) & 0x3FFF
                if op == 0x21:
                    write = (it, (pc + 16) // 8)
            elif op in (0x24, 0x25):                   # JR, JALR
                target = (branch_read(is_, hazard) * 8) & 0x3FFF
                if op == 0x25:
                    write = (it, (pc + 16) // 8)
            elif op in (0x28, 0x29, 0x2C, 0x2D, 0x2E, 0x2F):
                a = _s16(branch_read(is_, hazard))
                b = _s16(branch_read(it, hazard))
                taken = {0x28: a == b, 0x29: a != b, 0x2C: a < 0, 0x2D: a > 0, 0x2E: a <= 0, 0x2F: a >= 0}[op]
                if taken:
                    target = (pc + 8 + _imm11(lower) * 8) & 0x3FFF
        if stop is not None:
            t.stopped = "%s at 0x%x" % (stop, pc)
            break
        t.pairs += 1
        if write is not None and write[0] != 0:
            old = vi[write[0]]
            vi[write[0]] = _s16(write[1])
            hazard = (write[0], old) if new_hazard else None
        else:
            hazard = None
        next_pc = (pc + 8) & 0x3FFF
        if pending is not None:
            next_pc = pending
            pending = None
        if target is not None:
            pending = target
        if end_after is not None:
            t.end_pc = next_pc
            break
        if upper & 0x40000000:
            end_after = 1
        pc = next_pc
    return t


def _store_word(data, qword, lane, value, t, dirty):
    qword &= 0x3FF
    struct.pack_into("<I", data, qword * 16 + lane * 4, value & 0xFFFF)
    t.stores.add(qword)


def _natural(name):
    return [int(p) if p.isdigit() else p for p in re.split(r"([0-9]+)", name)]


def dumps_in(directory, entry=0):
    """The dumps in file order; `entry` keeps one start pc (None keeps all)."""
    names = sorted((n for n in os.listdir(directory) if n.endswith(".bin")), key=_natural)
    out = []
    for name in names:
        dump = read_dump(os.path.join(directory, name))
        if dump is None or (entry is not None and dump.pc != entry):
            continue
        out.append(dump)
    return out


def shape_table(dumps):
    """[path, count, pair counts, kick address tuples, first file, header z values], most frequent first."""
    rows = {}
    for dump in dumps:
        t = trace_dump(dump)
        path = t.path + (" (stopped)" if t.stopped else "")
        row = rows.setdefault(path, {"count": 0, "pairs": set(), "kicks": set(), "z": set(),
                                     "first": os.path.basename(dump.path)})
        row["count"] += 1
        row["pairs"].add(t.pairs)
        row["kicks"].add(tuple(t.kicks))
        row["z"].add(dump.header()[2])
    table = [[path, r["count"], sorted(r["pairs"]), sorted(r["kicks"]), r["first"], sorted(r["z"])]
             for path, r in rows.items()]
    table.sort(key=lambda row: (-row[1], row[0]))
    return table


def group_table(dumps):
    """[(the entry-0 paths since the last other entry, then that entry), count], most frequent first."""
    counts = {}
    run = []
    for dump in dumps:
        if dump.pc == 0:
            run.append(trace_dump(dump).path)
            continue
        key = "%s -> 0x%x" % (" ".join(run) if run else "(none)", dump.pc)
        counts[key] = counts.get(key, 0) + 1
        run = []
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def _values(values, limit=10):
    text = ",".join(str(v) for v in values[:limit])
    return text + (",...(%d)" % len(values) if len(values) > limit else "")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("directory")
    parser.add_argument("--groups", action="store_true", help="the entry-0 runs between two other entries")
    parser.add_argument("--each", action="store_true", help="one line per entry-0 dump first")
    args = parser.parse_args(argv)
    every = dumps_in(args.directory, entry=None)
    dumps = [d for d in every if d.pc == 0]
    if not dumps:
        print("no entry-0 dump in %s" % args.directory)
        return 1
    traces = [trace_dump(d) for d in dumps]
    if args.each:
        for dump, t in zip(dumps, traces):
            print("%s top=%d header=%s path=%s pairs=%d end=0x%x kicks=%s%s" % (
                os.path.basename(dump.path), dump.top, dump.header(), t.path, t.pairs, t.end_pc or 0, t.kicks,
                " stopped: " + t.stopped if t.stopped else ""))
        print()
    print("%-5s  %-24s  %-14s  %-12s  %-14s  %s" % ("count", "path", "pairs", "kicks", "header z", "first"))
    for path, count, pairs, kicks, first, zs in shape_table(dumps):
        print("%-5d  %-24s  %-14s  %-12s  %-14s  %s" % (count, path, _values(pairs),
                                                        ";".join(",".join(map(str, k)) or "-" for k in kicks),
                                                        _values(zs), first))
    print("%d entry-0 dump(s), mean %.1f pairs" % (len(dumps), sum(t.pairs for t in traces) / len(traces)))
    if args.groups:
        print()
        for key, count in group_table(every):
            print("%-5d  %s" % (count, key))
    return 0


if __name__ == "__main__":
    sys.exit(main())
