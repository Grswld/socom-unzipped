"""tools_py/parity/capture_offset.py: the seconds by which an audio capture's WAV began before the drive (LATER
row 37).

The capture's t=0 is the loopback recorder's first packet (`first_packet_epoch=` in loopback.log), not the moment
audio_parity.sh started the recorder (`.capture_started`): the stamps below are the real ones of
logs/parity/s16_v0_t1b_dump, where the script used 1.93 s and the true offset is 1.58 s. A capture whose log has
no first-packet line still scores, on the old clock, and says so. Pure files in a temp dir: no bash, no device.
"""
import contextlib
import io
import os
import tempfile
import unittest

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


class CaptureOffsetTest(unittest.TestCase):
    def capture_dir(self, loopback_log=LOOPBACK_LOG, drive_started=DRIVE_STARTED):
        tmp = tempfile.TemporaryDirectory(prefix="capture_offset_")
        self.addCleanup(tmp.cleanup)
        out = tmp.name
        with open(os.path.join(out, ".capture_started"), "w", encoding="utf-8") as fh:
            fh.write(CAPTURE_STARTED)
        if drive_started is not None:
            with open(os.path.join(out, ".drive_started"), "w", encoding="utf-8") as fh:
                fh.write(drive_started)
        if loopback_log is not None:
            with open(os.path.join(out, "loopback.log"), "w", encoding="utf-8", newline="") as fh:
                fh.write(loopback_log)
        return out

    def cli(self, out_dir):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            rc = co.main(["capture_offset", out_dir])
        return rc, stdout.getvalue(), stderr.getvalue()

    def test_the_offset_is_on_the_recorders_first_packet_clock(self):
        """(a) 1723.110 - 1721.526, not 1723.110 - 1721.177: the WAV's frame 0 is the first packet."""
        out = self.capture_dir()
        self.assertEqual(co.capture_offset(out), (1.584, "first_packet"))
        rc, stdout, stderr = self.cli(out)
        self.assertEqual((rc, stdout, stderr), (0, "offset=1.584 from=first_packet\n", ""),
                         "audio_parity.sh parses exactly this one line")

    def test_without_the_first_packet_line_the_offset_falls_back_to_capture_started(self):
        """(b) today's clock, so an older capture (or a recorder that died before its first packet) still scores
        -- and the source says which clock it was."""
        no_line = LOOPBACK_LOG.replace("first_packet_epoch=1790513721.526\r\n", "")
        for label, log in (("no loopback.log", None), ("no first_packet_epoch line", no_line)):
            with self.subTest(label):
                out = self.capture_dir(loopback_log=log)
                self.assertEqual(co.capture_offset(out), (1.933, "capture_started"))
                rc, stdout, _ = self.cli(out)
                self.assertEqual((rc, stdout), (0, "offset=1.933 from=capture_started\n"))

    def test_a_missing_drive_stamp_is_a_failure_the_cli_exits_2_on(self):
        """(c) no .drive_started: no offset at all -- one line on stderr, nothing on stdout, exit 2."""
        out = self.capture_dir(drive_started=None)
        with self.assertRaises(co.MissingStamp):
            co.capture_offset(out)
        rc, stdout, stderr = self.cli(out)
        self.assertEqual(rc, 2)
        self.assertEqual(stdout, "", "the shell's read must get nothing rather than a half line")
        self.assertEqual(len(stderr.splitlines()), 1, stderr)
        self.assertIn(".drive_started", stderr)


if __name__ == "__main__":
    unittest.main()
