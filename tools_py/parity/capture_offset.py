"""The seconds from an audio capture's WAV frame 0 to the zero of its drive's step clock -- the offset
`audio_parity score` shifts every step window by -- read on the clocks the two actually run on.

    python -m tools_py.parity.capture_offset <capture dir>      # prints: offset=<seconds> from=<source>

LATER row 37 (the 2026-09-27 diagnosis of V0 leg 3, issue #91): scripts/parity/audio_parity.sh took the offset as
`.drive_started - .capture_started`, two stamps the SCRIPT writes, and neither is a clock the scorer uses:

  * the WAV's frame 0 is the loopback recorder's first packet, which loopback_record.py prints into loopback.log
    as `first_packet_epoch=`. `.capture_started` is the moment the script launched the recorder, a Python start,
    a PyAudio init and two stream opens earlier (0.35 s on s16_v0_t1b_dump, 0.81 s on s16_v0_t1b).
  * the step times in drive.stdout run from drive.py's own t0, set after its running-process checks and the game
    launch; drive.py prints it as `drive_t0_epoch=`. `.drive_started` is the moment the script launched drive.py,
    earlier still: the review of c6b763dd put t0 1.31-1.50 s after it on s16_v0_t1b_dump (the step screenshots'
    file times) and at least 1.26 s after it on s16_v0_t1b.

So the offset is `drive_t0_epoch - first_packet_epoch` (source `drive_t0`). Where a stamp is missing, the script's
own stamp stands in for it and the source says so: `drive_t0/capture_started` (no first packet), `first_packet`
(no drive t0: `.drive_started - first_packet_epoch`) and `capture_started` (neither: the old two-stamp offset).
Every capture taken before drive.py printed its t0 -- s16_v0_t1b_dump (1.584 s), s16_v0_t1b (4.412 s) among them
-- has only the fallbacks, and its offset is short by drive.py's start (about 1.3-1.5 s there): the stamps to
correct that were never written, so it is not guessed here. Rounded to the millisecond, the stamps' own precision.

The first-packet stamp is when the first 1024-frame read RETURNED, so frame 0 is up to one read (~21 ms at
48 kHz) earlier; that lag is deliberately left unapplied here (tools_py/parity/cb_trace.py subtracts it for its dip
attribution), far below the scoring windows' length. A capture with no step-clock zero at all -- no drive t0 and
no `.drive_started` -- is MissingStamp, which the command line turns into exit 2 with one line on stderr.
"""
import os
import re
import sys
from typing import Optional, Tuple

_FIRST_PACKET = re.compile(r"^first_packet_epoch=([0-9]+(?:\.[0-9]+)?)\s*$", re.M)
_DRIVE_T0 = re.compile(r"^drive_t0_epoch=([0-9]+(?:\.[0-9]+)?)\s*$", re.M)


class MissingStamp(Exception):
    """A stamp file the offset needs is not in the capture directory."""


def _stamp(out_dir: str, name: str) -> float:
    path = os.path.join(out_dir, name)
    try:
        with open(path, encoding="utf-8") as fh:
            return float(fh.read().strip())
    except FileNotFoundError:
        raise MissingStamp(f"no {name} in {out_dir}") from None


def _epoch_line(out_dir: str, name: str, pattern) -> Optional[float]:
    """The first `pattern` match in `<out_dir>/<name>`, as a float; None when the file or the line is absent."""
    try:
        with open(os.path.join(out_dir, name), encoding="utf-8", errors="replace") as fh:
            m = pattern.search(fh.read())
    except FileNotFoundError:
        return None
    return float(m.group(1)) if m else None


def first_packet_epoch(out_dir: str) -> Optional[float]:
    """The recorder's `first_packet_epoch=` from loopback.log: the WAV's frame 0."""
    return _epoch_line(out_dir, "loopback.log", _FIRST_PACKET)


def drive_t0_epoch(out_dir: str) -> Optional[float]:
    """drive.py's `drive_t0_epoch=` from drive.stdout: the zero of every step's t=."""
    return _epoch_line(out_dir, "drive.stdout", _DRIVE_T0)


def capture_offset(out_dir: str) -> Tuple[float, str]:
    """(offset_seconds, source): how long the WAV's frame 0 preceded the step clock's zero, and which clocks
    that is on -- "drive_t0", "drive_t0/capture_started", "first_packet" or "capture_started" (module doc)."""
    first = first_packet_epoch(out_dir)
    drive_t0 = drive_t0_epoch(out_dir)
    if drive_t0 is not None:
        if first is not None:
            return round(drive_t0 - first, 3), "drive_t0"
        return round(drive_t0 - _stamp(out_dir, ".capture_started"), 3), "drive_t0/capture_started"
    drive = _stamp(out_dir, ".drive_started")
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
