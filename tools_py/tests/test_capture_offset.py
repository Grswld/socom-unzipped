"""tools_py/parity/capture_offset.py: the seconds from an audio capture's WAV frame 0 to the zero of the drive's
step clock (LATER row 37).

The WAV's frame 0 is the loopback recorder's first packet (`first_packet_epoch=` in loopback.log); the step times
in drive.stdout are measured from drive.py's own t0, which it prints as `drive_t0_epoch=`. `.capture_started` and
`.drive_started` are only what older captures have: the stamps below are the real ones of
logs/parity/s16_v0_t1b_dump, taken before drive.py printed its t0, so their offset is on `.drive_started` -- which
the review of c6b763dd put 1.31-1.50 s BEFORE drive.py's t0 on that capture (the step PNGs' file times), so 1.584
is not the true offset, only the one that capture's stamps allow. Pure files in a temp dir: no bash, no device.
"""
import contextlib
import io
import os
import tempfile
import unittest

from tools_py.parity import audio_parity
from tools_py.parity import capture_offset as co

# logs/parity/s16_v0_t1b_dump, verbatim
CAPTURE_STARTED = "1790513721.176546000\n"
DRIVE_STARTED = "1790513723.110032500\n"
LOOPBACK_LOG = ("recording 620s from 'Haut-parleurs (HyperX QuadCast S) [Loopback]' at 48000 Hz, 2 ch -> "
                "logs/parity/s16_v0_t1b_dump/endpoint.wav\r\n"
                "start_epoch=1790513721.474\r\n"
                "pid=51000\r\n"
                "first_packet_epoch=1790513721.526\r\n"
                "wrote 29760512 frames (620.0s) at 48000 Hz\r\n")
NO_FIRST_PACKET = LOOPBACK_LOG.replace("first_packet_epoch=1790513721.526\r\n", "")
# A drive.stdout as drive.py now writes it. The t0 is a FIXTURE, not a measurement: .drive_started + 1.430 s,
# the median of the review's PNG-time estimate on that capture.
DRIVE_STDOUT = ("drive_t0_epoch=1790513724.540\r\n"
                "s00_CROSS                t=   9.0s stable=True waited=6.4s\r\n"
                "s01_CROSS                t=  20.6s stable=True waited=10.4s\r\n")
DRIVE_STDOUT_OLD = DRIVE_STDOUT.split("\r\n", 1)[1]   # what every capture before this change has


class CaptureOffsetTest(unittest.TestCase):
    def capture_dir(self, loopback_log=LOOPBACK_LOG, drive_started=DRIVE_STARTED, drive_stdout=None):
        tmp = tempfile.TemporaryDirectory(prefix="capture_offset_")
        self.addCleanup(tmp.cleanup)
        out = tmp.name
        files = {".capture_started": CAPTURE_STARTED, ".drive_started": drive_started,
                 "loopback.log": loopback_log, "drive.stdout": drive_stdout}
        for name, body in files.items():
            if body is not None:
                with open(os.path.join(out, name), "w", encoding="utf-8", newline="") as fh:
                    fh.write(body)
        return out

    def cli(self, out_dir):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = co.main(["capture_offset", out_dir])
        return rc, stdout.getvalue(), stderr.getvalue()

    def test_the_offset_runs_from_the_first_packet_to_the_drives_own_t0(self):
        """The two clocks the scorer actually lays against each other: 1724.540 - 1721.526. `.drive_started`
        is not needed once the drive has printed its t0."""
        for label, drive_started in (("with .drive_started", DRIVE_STARTED), ("without it", None)):
            with self.subTest(label):
                out = self.capture_dir(drive_started=drive_started, drive_stdout=DRIVE_STDOUT)
                self.assertEqual(co.capture_offset(out), (3.014, "drive_t0"))
                self.assertEqual(self.cli(out), (0, "offset=3.014 from=drive_t0\n", ""),
                                 "audio_parity.sh parses exactly this one line")

    def test_the_drives_t0_without_a_first_packet_is_laid_against_capture_started(self):
        out = self.capture_dir(loopback_log=NO_FIRST_PACKET, drive_stdout=DRIVE_STDOUT)
        self.assertEqual(co.capture_offset(out), (3.363, "drive_t0/capture_started"))
        self.assertEqual(self.cli(out)[:2], (0, "offset=3.363 from=drive_t0/capture_started\n"))

    def test_an_older_capture_is_on_drive_started_and_the_first_packet(self):
        """(a) s16_v0_t1b_dump as it is: no drive_t0 line (a drive.stdout from before it, or none), so the step
        clock's zero falls back to `.drive_started` -- 1723.110 - 1721.526, the source naming the first packet."""
        for label, stdout in (("no drive.stdout", None), ("drive.stdout without the line", DRIVE_STDOUT_OLD)):
            with self.subTest(label):
                out = self.capture_dir(drive_stdout=stdout)
                self.assertEqual(co.capture_offset(out), (1.584, "first_packet"))
                self.assertEqual(self.cli(out), (0, "offset=1.584 from=first_packet\n", ""))

    def test_without_the_first_packet_line_the_offset_falls_back_to_capture_started(self):
        """(b) the oldest clock pair, so a capture from before the recorder printed its first packet (or one whose
        recorder never got a packet) still scores -- and the source says which clock it was."""
        for label, log in (("no loopback.log", None), ("no first_packet_epoch line", NO_FIRST_PACKET)):
            with self.subTest(label):
                out = self.capture_dir(loopback_log=log)
                self.assertEqual(co.capture_offset(out), (1.933, "capture_started"))
                rc, stdout, _ = self.cli(out)
                self.assertEqual((rc, stdout), (0, "offset=1.933 from=capture_started\n"))

    def test_a_missing_drive_stamp_is_a_failure_the_cli_exits_2_on(self):
        """(c) no drive_t0 line and no .drive_started: no step-clock zero at all -- one line on stderr, nothing
        on stdout, exit 2."""
        out = self.capture_dir(drive_started=None, drive_stdout=DRIVE_STDOUT_OLD)
        with self.assertRaises(co.MissingStamp):
            co.capture_offset(out)
        rc, stdout, stderr = self.cli(out)
        self.assertEqual(rc, 2)
        self.assertEqual(stdout, "", "the shell's read must get nothing rather than a half line")
        self.assertEqual(len(stderr.splitlines()), 1, stderr)
        self.assertIn(".drive_started", stderr)


class StepWindowsTest(unittest.TestCase):
    def test_the_drive_t0_line_is_not_a_step(self):
        """The scorer's reader of drive.stdout sees the same windows with the new first line as without it."""
        self.assertEqual(audio_parity.step_windows(DRIVE_STDOUT, 3.014),
                         audio_parity.step_windows(DRIVE_STDOUT_OLD, 3.014))
        self.assertEqual([w.label for w in audio_parity.step_windows(DRIVE_STDOUT)], ["s00", "s01"])


if __name__ == "__main__":
    unittest.main()
