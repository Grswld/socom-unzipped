#!/usr/bin/env python
"""Replay the 989snd RPC sequence a real run logged ("[ps2xIOP] 989snd: NAME (fno 0xNN) [args] -> 0xRESULT")
into the disc's real 989SND.IRX running on #254's LLE IOP with our provider (harness_lle, Sprint 15 T1, research/70;
research/40's replay.py with its root, its title and a --no-usb switch changed), translating the handles and
pointers our model issued into the ones the real IRX issues, and count where the two answer differently.

Usage, from the repository's root (the default --cdroot and --iso are under its git-ignored game/; $REPO overrides
the root), with $SCRATCH the scratch directory outside the repository that holds the build (README.md beside this):
  python "$SCRATCH/oracle/replay_lle.py" --log logs/run_X.log --harness "$SCRATCH/oracle/build/harness_lle.exe"
         [--tick 4920000] [--limit N] [--cdroot game/disc] [--iso "game/SOCOM II - U.S. Navy SEALs (USA).iso"]
         [--out results.md] [--no-usb]
ORACLE_NO_PROVIDER=1 in the environment is read by the harness, not by this script: the refused-read run.
"""
import argparse
import collections
import os
import re
import subprocess
import sys
import time

ROOT = os.environ.get("REPO") or os.getcwd()  # the repository's root; the replays of 2026-09-26 ran from it
LINE = re.compile(r"989snd: (\w+) \(fno 0x([0-9a-f]+)\)(?: \[([^\]]*)\])?(?: -> 0x([0-9a-f]+))?")
STREAM_SID_FNOS = {0x2, 0x3}
# Functions whose answer is a handle or an IOP pointer the game passes back later: the map is built from these.
ISSUING_FNOS = {0x2, 0x3, 0x11, 0x2C, 0x3B, 0x1A, 0x1C, 0x1D}
NO_ANSWER_MEANING = {0x12}  # NoReturn


def parse_log(path, limit):
    calls = []
    with open(path, "r", encoding="utf-8", errors="replace") as fp:
        for raw in fp:
            m = LINE.search(raw)
            if not m:
                continue
            name, fno, args, result = m.group(1), int(m.group(2), 16), m.group(3), m.group(4)
            words = [int(w, 16) for w in args.split(",")] if args else []
            calls.append((name, fno, words, int(result, 16) if result is not None else None))
            if limit and len(calls) >= limit:
                break
    return calls


class Harness:
    def __init__(self, exe, cdroot, iso):
        self.p = subprocess.Popen([exe, cdroot, iso], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, bufsize=1, encoding="utf-8", errors="replace")
        self.logs = []
        self.expect("READY")

    def expect(self, prefix):
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError("harness exited; last logs:\n" + "\n".join(self.logs[-20:]))
            line = line.rstrip("\n")
            if line.startswith("LOG ") or line.startswith("ERR "):
                self.logs.append(line)
                continue
            if line.startswith(prefix):
                return line
            self.logs.append("?? " + line)

    def send(self, cmd, prefix):
        self.p.stdin.write(cmd + "\n")
        self.p.stdin.flush()
        return self.expect(prefix)

    def load(self, path, args=""):
        return self.send(f"load {path} {args}".rstrip(), "LOAD ")

    def rpc(self, stream, fno, words):
        line = self.send("rpc %s %x %s" % ("stream" if stream else "snd", fno, " ".join("%x" % w for w in words)), "RPC ")
        m = re.search(r"handled=(\d) recv=([0-9a-f]{8}) ([0-9a-f]{8}) ([0-9a-f]{8}) ([0-9a-f]{8}) instr=(\d+)", line)
        handled = m.group(1) == "1"
        recv = [int(m.group(i), 16) for i in range(2, 6)]
        return handled, recv, int(m.group(6))

    def tick(self, cycles):
        return self.send(f"tick {cycles}", "TICK ")

    def peek(self, addr, n):
        return self.send("peek %x %d" % (addr, n), "PEEK ")

    def close(self):
        try:
            self.p.stdin.write("quit\n")
            self.p.stdin.flush()
        except OSError:
            pass
        self.p.wait(timeout=10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--harness", required=True)
    ap.add_argument("--cdroot", default=os.path.join(ROOT, "game", "disc"))
    ap.add_argument("--iso", default=os.path.join(ROOT, "game", "SOCOM II - U.S. Navy SEALs (USA).iso"))
    ap.add_argument("--tick", type=int, default=4_920_000, help="EE cycles advanced after every call (one NTSC frame)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--no-usb", action="store_true", help="leave USBD and LGAUD out (non-resident on the oracle)")
    a = ap.parse_args()

    calls = parse_log(a.log, a.limit)
    print(f"{len(calls)} logged calls from {a.log}")
    h = Harness(a.harness, a.cdroot, a.iso)
    t0 = time.time()
    # The game's own load order and arguments for the sound path (research/05 §"Reference boot"); USBKB and DEV9
    # are left out (keyboard and network, no 989snd contact). HEADSETO registers with 989snd and owns an RPC server.
    order = [("cdrom0:/RUN/IRX/USB/USBD.IRX;1", "hub=1"), ("cdrom0:/RUN/IRX/LIBSD.IRX;1", ""),
             ("cdrom0:/RUN/IRX/SOUND/989SND.IRX;1", "stream_priority=18"), ("cdrom0:/RUN/IRX/SOUND/989DSTRM.IRX;1", ""),
             ("cdrom0:/RUN/IRX/LGAUD.IRX;1", ""), ("cdrom0:/RUN/IRX/HEADSETO.IRX;1", "priority=22")]
    if a.no_usb:
        order = [m for m in order if "USBD" not in m[0] and "LGAUD" not in m[0]]
    loads = [h.load(p, args) for p, args in order]
    for l in loads:
        print(l)
    for l in h.logs:
        print("  " + l)
    h.logs.clear()
    if any("handled=0" in l or "start=-" in l for l in loads):
        print("BLOCKED: a module did not load/start; stopping")
        h.close()
        return 3
    # The IRX's RPC server threads register on their first run: give the IOP two frames before the first call.
    h.tick(a.tick)
    h.tick(a.tick)
    print(h.send("snap", "SNAP "))
    for l in h.logs:
        print("  " + l)
    h.logs.clear()

    handle_map = {}      # our model's value (as logged) -> the real IRX's value
    per_fno = collections.defaultdict(lambda: {"name": "", "n": 0, "agree": 0, "disagree": 0, "no_expected": 0, "unhandled": 0})
    disagreements = []
    transcript = []
    for i, (name, fno, words, expected) in enumerate(calls):
        stream = fno in STREAM_SID_FNOS
        sent = [handle_map.get(w, w) for w in words]
        handled, recv, instr = h.rpc(stream, fno, sent)
        real = recv[0] if stream else recv[1]
        row = per_fno[fno]
        row["name"] = name
        row["n"] += 1
        if not handled:
            row["unhandled"] += 1
        verdict = ""
        if expected is None:
            row["no_expected"] += 1
        else:
            # An issuing call re-maps every time: our model hands out the same PCM buffer on every open while the
            # real IRX hands out a fresh one, and later calls must follow the latest.
            if fno in ISSUING_FNOS and expected != 0 and real != 0:
                handle_map[expected] = real
                want = real
            else:
                want = handle_map.get(expected, expected)
            if real == want and handled and not (expected != 0 and real == 0):
                row["agree"] += 1
                verdict = "agree"
            else:
                row["disagree"] += 1
                verdict = "DISAGREE"
                disagreements.append((i, name, fno, words, sent, expected, want, real, recv, list(h.logs[-6:])))
        transcript.append((i, name, fno, sent, expected, real, handled, instr, verdict))
        if a.verbose or verdict == "DISAGREE":
            print(f"#{i} {name} fno={fno:02x} args={[hex(w) for w in sent]} expected={expected if expected is None else hex(expected)} real={hex(real)} recv={[hex(r) for r in recv]} {verdict} instr={instr}")
            for l in h.logs[-6:]:
                print("    " + l)
        h.logs.clear()
        h.tick(a.tick)
        if i % 200 == 0 and i:
            print(f"... {i}/{len(calls)} calls, {time.time() - t0:.0f} s")
    status = h.peek(0x48DA00, 5)
    snap = h.send("snap", "SNAP ")
    h.close()

    total_dis = sum(r["disagree"] for r in per_fno.values())
    total_cmp = sum(r["agree"] + r["disagree"] for r in per_fno.values())
    lines = []
    lines.append(f"# 989snd RPC differential: real IRX (#254 LLE IOP + provider, Sprint 15 T1) vs our snd989 model\n")
    lines.append(f"Log: `{os.path.relpath(a.log, ROOT)}`; {len(calls)} calls replayed; tick {a.tick} EE cycles per call; "
                 f"{time.time() - t0:.0f} s; {status}; {snap}\n")
    lines.append(f"**Compared answers: {total_cmp}; disagreements: {total_dis}.**\n")
    lines.append("| fno | function | calls | agree | disagree | no expected | unhandled |")
    lines.append("|---|---|---|---|---|---|---|")
    for fno in sorted(per_fno):
        r = per_fno[fno]
        lines.append(f"| 0x{fno:02x} | {r['name']} | {r['n']} | {r['agree']} | {r['disagree']} | {r['no_expected']} | {r['unhandled']} |")
    lines.append("")
    lines.append(f"## First {min(60, len(disagreements))} disagreements\n")
    for (i, name, fno, words, sent, expected, want, real, recv, logs) in disagreements[:60]:
        lines.append(f"- #{i} `{name}` fno 0x{fno:02x} logged args {[hex(w) for w in words]} sent {[hex(w) for w in sent]}: "
                     f"ours 0x{expected:x} (maps to 0x{want:x}), IRX 0x{real:x}, recv {[hex(r) for r in recv]}")
        for l in logs:
            lines.append(f"    - {l}")
    lines.append("")
    lines.append(f"## Handle map ({len(handle_map)} entries)\n")
    for k, v in list(handle_map.items())[:80]:
        lines.append(f"- 0x{k:x} -> 0x{v:x}")
    text = "\n".join(lines) + "\n"
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fp:
            fp.write(text)
        print(f"wrote {a.out}")
    print(f"compared {total_cmp}, disagreements {total_dis}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
