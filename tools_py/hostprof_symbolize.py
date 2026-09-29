#!/usr/bin/env python
"""Symbolize a PS2X_HOST_PROF histogram (logs/hostprof.txt: "rva count" lines) against dist/socom2.exe
using llvm-nm (symbol table, no debug info needed). Prints the top functions by sample count.

Usage: python tools_py/hostprof_symbolize.py [logs/hostprof.txt] [--top 40] [--exe dist/socom2.exe]

A PS2X_HOST_PROF_STACKS=1 histogram also holds "stack <n> leaf;caller;..." lines (raw absolute addresses,
counts that repeat the flat samples); they are skipped here and counted in the header line -- fold them
with tools_py/hostprof_stacks.py (issue #95).
"""
import argparse
import bisect
import collections
import os
import subprocess
import sys

NM = os.path.join("tools", "llvm-mingw", "bin", "llvm-nm.exe")
OBJDUMP = os.path.join("tools", "llvm-mingw", "bin", "llvm-objdump.exe")


def image_base(exe):
    out = subprocess.run([OBJDUMP, "-p", exe], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "ImageBase" in line:
            return int(line.split()[-1], 16)
    return 0x140000000


def symbols(exe):
    out = subprocess.run([NM, "--defined-only", exe], capture_output=True, text=True, errors="ignore").stdout
    syms = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[1] not in ("T", "t", "W", "w"):
            continue
        try:
            syms.append((int(parts[0], 16), parts[2]))
        except ValueError:
            pass
    syms.sort()
    return syms


def demangle(names):
    try:
        out = subprocess.run([os.path.join("tools", "llvm-mingw", "bin", "llvm-cxxfilt.exe")], input="\n".join(names),
                             capture_output=True, text=True, errors="ignore").stdout.splitlines()
        return dict(zip(names, out)) if len(out) == len(names) else {}
    except OSError:
        return {}


Histogram = collections.namedtuple("Histogram", "header samples threads stack_lines")


def read_histogram(path):
    """The one parser of a PS2X_HOST_PROF histogram, shared with tools_py/hostprof_diff.py (issue #116).
    samples: (rva, count, module) per flat line, module None for the exe, else the "ext" line's module name
    ("?" when absent); threads: (count, tid, description); stack_lines: how many "stack ..." lines were skipped
    (their counts repeat the flat samples; tools_py/hostprof_stacks.py folds them)."""
    samples, threads, stack_lines = [], [], 0
    with open(path) as f:
        header = f.readline().strip()
        for line in f:
            parts = line.split()
            if len(parts) < 2:
                continue
            if parts[0] == "thread":
                threads.append((int(parts[2]), parts[1], " ".join(parts[3:])))
                continue
            if parts[0] == "stack":
                stack_lines += 1
                continue
            module = None
            if len(parts) > 2 and parts[2] == "ext":
                module = parts[3].split("+")[0] if len(parts) > 3 else "?"
            samples.append((int(parts[0], 16), int(parts[1]), module))
    return Histogram(header, samples, threads, stack_lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("hist", nargs="?", default=os.path.join("logs", "hostprof.txt"))
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--exe", default=os.path.join("dist", "socom2.exe"))
    a = ap.parse_args()
    base = image_base(a.exe)
    syms = symbols(a.exe)
    addrs = [s[0] for s in syms]
    per_fn = collections.Counter()
    total = 0
    ext = 0
    hist = read_histogram(a.hist)
    header, threads, stack_lines = hist.header, hist.threads, hist.stack_lines
    for rva, n, module in hist.samples:
        total += n
        if module is not None:
            ext += n
            per_fn["<ext> " + module] += n
            continue
        i = bisect.bisect_right(addrs, base + rva) - 1
        name = syms[i][1] if i >= 0 else f"<{rva:#x}>"
        per_fn[name] += n
    names = [k for k, _ in per_fn.most_common(a.top)]
    dm = demangle(names)
    skipped = f", stack lines skipped {stack_lines} (fold them with tools_py/hostprof_stacks.py)" if stack_lines else ""
    print(header, f"(samples in file {total}, other modules {ext}{skipped})")
    for n, tid, desc in sorted(threads, reverse=True)[:12]:
        print(f"  thread {tid:>6} {n:7d} {100.0 * n / max(1, total):5.1f}%  {desc}")
    for name, n in per_fn.most_common(a.top):
        print(f"{100.0 * n / max(1, total):6.2f}%  {n:7d}  {dm.get(name, name)}")


if __name__ == "__main__":
    main()
