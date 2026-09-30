#!/usr/bin/env python
"""Symbolize the difference of two PS2X_HOST_PROF histograms (end minus start): the samples taken
between the two snapshots, e.g. the mission phase of a run when the file was copied at load time.

Run: python -m tools_py.hostprof_diff logs/hostprof_pre.txt logs/hostprof_end.txt [--top 40]
       [--exe dist/socom2.exe] [--start-exe <the exe the start file came from>]

Functions pair by their GUEST ADDRESS, not their name (Sprint 13 Task N1): every generated function's identifier
ends `_0x<start>` (research/61 §1), whatever its readable name, so `sub_00338480_0x338480` in a pre-rename exe and
`node_0x338480` in the renamed one are the one function; an older identifier with no suffix (`FUN_<8 hex>`,
`sub_<8 hex>`) keys on its hex. A symbol with no guest address (the runtime) pairs by its name. With
`--start-exe` the two files may come from two different executables. A keyed symbol is generated EE code, which is
what the "generated EE functions" count reports (it used to read a `FUN_` prefix and lost every renamed function).
"""
import argparse
import bisect
import collections
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hostprof_symbolize import image_base, symbols, demangle, read_histogram  # noqa: E402

_SUFFIX = re.compile(r"_0x([0-9A-Fa-f]+)$")
_PLACEHOLDER = re.compile(r"^_?(?:FUN|sub)_([0-9A-Fa-f]{8})$")
_MANGLED = re.compile(r"^_Z(\d+)")


def _plain(sym: str) -> str:
    """The function's own name out of an Itanium-mangled (`_Z<len><name>...`) or demangled (`name(args)`) symbol."""
    m = _MANGLED.match(sym)
    if m:
        n = int(m.group(1))
        return sym[m.end():m.end() + n]
    return sym.split("(", 1)[0]


def guest_key(sym: str) -> Optional[int]:
    """The guest address a generated function's symbol names, or None for a runtime symbol."""
    name = _plain(sym)
    m = _SUFFIX.search(name) or _PLACEHOLDER.match(name)
    return int(m.group(1), 16) if m else None


def load_counted(path):
    """The flat samples of one histogram, (counts, ext, stack_lines): the symboliser's parser (issue #116), so
    the "stack ..." lines of a PS2X_HOST_PROF_STACKS=1 file are skipped and counted, not parsed as samples."""
    hist = read_histogram(path)
    counts, ext = {}, {}
    for rva, n, module in hist.samples:
        (ext if module is not None else counts)[rva] = n
    return counts, ext, hist.stack_lines


def load(path):
    counts, ext, _ = load_counted(path)
    return counts, ext


def per_function(counts: Dict[int, int], base: int, syms: List[Tuple[int, str]]) -> collections.Counter:
    """One histogram's samples summed per symbol of the exe it was taken from."""
    addrs = [s[0] for s in syms]
    out = collections.Counter()
    for rva, n in counts.items():
        i = bisect.bisect_right(addrs, base + rva) - 1
        out[syms[i][1] if i >= 0 else f"<{rva:#x}>"] += n
    return out


def diff_by_key(start: collections.Counter, end: collections.Counter) -> Tuple[collections.Counter, int]:
    """End minus start per function, paired by guest address (else by name), labelled with the end's name.
    Returns the positive differences and how many of them are generated EE code."""
    def keyed(c):
        out, label = collections.Counter(), {}
        for name, n in c.items():
            g = guest_key(name)
            k = ("guest", g) if g is not None else ("name", name)
            out[k] += n
            label.setdefault(k, name)
        return out, label

    k0, l0 = keyed(start)
    k1, l1 = keyed(end)
    per, gen = collections.Counter(), 0
    for k, n in k1.items():
        d = n - k0.get(k, 0)
        if d <= 0:
            continue
        per[l1.get(k) or l0[k]] += d
        if k[0] == "guest":
            gen += d
    return per, gen


def ext_delta(e0: Dict[int, int], e1: Dict[int, int]) -> int:
    return sum(max(0, n - e0.get(r, 0)) for r, n in e1.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("start")
    ap.add_argument("end")
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--exe", default=os.path.join("dist", "socom2.exe"), help="the exe the end file came from")
    ap.add_argument("--start-exe", help="the exe the start file came from (default: --exe)")
    a = ap.parse_args()
    c0, e0, s0 = load_counted(a.start)
    c1, e1, s1 = load_counted(a.end)
    start_exe = a.start_exe or a.exe
    f1 = per_function(c1, image_base(a.exe), symbols(a.exe))
    f0 = per_function(c0, image_base(start_exe), symbols(start_exe))
    per_fn, gen = diff_by_key(f0, f1)
    extd = ext_delta(e0, e1)
    total = sum(per_fn.values()) + extd
    per_fn["<other module (system DLL / GL driver)>"] += extd
    names = [k for k, _ in per_fn.most_common(a.top)]
    dm = demangle(names)
    skipped = f", stack lines skipped {s0} + {s1} (fold them with tools_py/hostprof_stacks.py)" if s0 or s1 else ""
    print(f"samples in phase {total} (other modules {extd}, generated EE functions {gen}{skipped})")
    for name, n in per_fn.most_common(a.top):
        print(f"{100.0 * n / max(1, total):6.2f}%  {n:7d}  {dm.get(name, name)}")


if __name__ == "__main__":
    main()
