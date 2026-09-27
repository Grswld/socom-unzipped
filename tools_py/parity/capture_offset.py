"""The seconds by which an audio capture's recording began before its drive -- the offset `audio_parity score`
shifts every step window by -- read on the clock the WAV is actually on.

    python -m tools_py.parity.capture_offset <capture dir>      # prints: offset=<seconds> from=<source>

LATER row 37 (the 2026-09-27 diagnosis of V0 leg 3, issue #91): scripts/parity/audio_parity.sh took the offset as
`.drive_started - .capture_started`, but `.capture_started` is the moment the script LAUNCHED the loopback
recorder, and the recorder spends a Python start, a PyAudio init and two stream opens before its first packet. The
WAV's frame 0 is that first packet, which loopback_record.py prints into loopback.log as `first_packet_epoch=`.
On logs/parity/s16_v0_t1b_dump the stamps are .capture_started 1790513721.177, first_packet_epoch 1790513721.526
and .drive_started 1790513723.110: the script used 1.93 s where the true offset is 1.58 s. On s16_v0_t1b it used
5.23 s against 4.41 s -- 0.82 s of error, enough to move a cue's transition inside the 1.2-5 s scoring windows.

So the offset is `.drive_started - first_packet_epoch` when loopback.log carries that line (source
`first_packet`), and falls back to `.drive_started - .capture_started`, the old clock, when it does not (source
`capture_started`) -- a capture taken before the recorder printed the line, or one whose recorder never got a
packet, still scores, and capture.txt says which clock it was on. Rounded to the millisecond, the stamp's own
precision. The first-packet stamp is when the first 1024-frame read RETURNED, so frame 0 is up to one read
(~21 ms at 48 kHz) earlier (tools_py/parity/cb_trace.py subtracts it for its dip attribution); that is left in
here, far below the scoring windows' length. A missing `.drive_started` is no offset at all: MissingStamp, which
the command line turns into exit 2 with one line on stderr.
"""
import os
import re
import sys
from typing import Tuple

_FIRST_PACKET = re.compile(r"^first_packet_epoch=([0-9]+(?:\.[0-9]+)?)\s*$", re.M)


class MissingStamp(Exception):
    """A stamp file the offset needs is not in the capture directory."""


def _stamp(out_dir: str, name: str) -> float:
    path = os.path.join(out_dir, name)
    try:
        with open(path, encoding="utf-8") as fh:
            return float(fh.read().strip())
    except FileNotFoundError:
        raise MissingStamp(f"no {name} in {out_dir}") from None


def first_packet_epoch(out_dir: str):
    """The recorder's `first_packet_epoch=` from `<out_dir>/loopback.log`, or None (no log, or no such line)."""
    try:
        with open(os.path.join(out_dir, "loopback.log"), encoding="utf-8", errors="replace") as fh:
            m = _FIRST_PACKET.search(fh.read())
    except FileNotFoundError:
        return None
    return float(m.group(1)) if m else None


def capture_offset(out_dir: str) -> Tuple[float, str]:
    """(offset_seconds, source): how long the WAV's frame 0 preceded `.drive_started`, and which clock that is
    on -- "first_packet" (the recorder's first packet) or "capture_started" (the fallback: the recorder's launch)."""
    drive = _stamp(out_dir, ".drive_started")
    first = first_packet_epoch(out_dir)
    if first is not None:
        return round(drive - first, 3), "first_packet"
    return round(drive - _stamp(out_dir, ".capture_started"), 3), "capture_started"


def main(argv) -> int:
    if len(argv) != 2:
        print("usage: python -m tools_py.parity.capture_offset <capture dir>", file=sys.stderr)
        return 2
    try:
        offset, source = capture_offset(argv[1])
    except MissingStamp as e:
        print(f"capture_offset: {e}", file=sys.stderr)
        return 2
    print(f"offset={offset:.3f} from={source}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
