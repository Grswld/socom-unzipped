"""scripts/parity/audio_parity.sh's capture-side seams -- the parts of a capture that decide what its artefacts
MEAN, held by tests rather than by a reading of the script (audio-out fix round 2: R2, R5, R7, R8).

  * the scorer's meta carries `target` and `script` as two keys -- a missing space glued them into one argument
    and every capture taken with this script recorded `target: 'ours--script'` and no script at all, so
    `audio_parity.sh compare` silently fell back to the wrong pinned reference;
  * the endpoint verdict excludes the loopback recorder by PID, and SAYS SO when the recorder's log carries no
    pid -- otherwise the recorder's own session (whose loopback stream reads the endpoint's whole mix) reads as
    a contaminant and the owner throws away a good capture, or worse, trusts a word that was never earned;
  * the tools root may contain a space;
  * the capture's offset is on the recorder's first-packet clock (tools_py/parity/capture_offset.py), not the
    moment the script started the recorder, and capture.txt says which clock it was (LATER row 37);
  * the wrapper the owner is asked to run is tracked, not left in an ignored logs/ inside a worktree the merge
    will remove.

bash + the pure scorer only: no device, no capture, no game.
"""
import contextlib
import json
import os
import re
import subprocess
import tempfile
import unittest
import wave

from tools_py.parity import audio_dips, audio_parity
from tools_py.tests.shell import BASH

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "parity", "audio_parity.sh")
PS2_AUDIO = os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRuntime", "src", "lib", "ps2_audio.cpp")
WRAPPER = os.path.join(ROOT, "scripts", "parity", "capture_audio_out.sh")
HUMAN_TASKS = os.path.join(ROOT, "docs", "HUMAN_TASKS.md")

SOURCE = 'export AUDIO_PARITY_SOURCE_ONLY=1; . "%s"; ' % SCRIPT.replace("\\", "/")


def sh(script, env=None, cwd=ROOT):
    e = dict(os.environ)
    e.update(env or {})
    p = subprocess.run([BASH, "-c", SOURCE + script], cwd=cwd, env=e, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, universal_newlines=True, encoding="utf-8", errors="replace")
    assert p.returncode == 0, "bash failed (%s): %s" % (p.returncode, p.stdout)
    return p.stdout


class ScoreMetaTest(unittest.TestCase):
    def test_the_meta_the_capture_writes_carries_target_and_script_as_two_keys(self):
        """R2: `--target "$target"--script "$(basename "$script")"` made one argument of two. Proven end to end:
        the tokens the script builds, handed to the scorer, must land as two keys in audio_scores.json."""
        out = sh('score_meta_args ours scripts/parity/launch_to_mission_xl.txt; printf "%s\\n" "${META_ARGS[@]}"')
        tokens = out.strip().splitlines()
        self.assertEqual(tokens, ["--target", "ours", "--script", "launch_to_mission_xl.txt"])
        tmp = tempfile.mkdtemp(prefix="audio_meta_")
        wav, drive, scores = (os.path.join(tmp, n) for n in ("endpoint.wav", "drive.stdout", "audio_scores.json"))
        with wave.open(wav, "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(bytes(48000 * 4))
        with open(drive, "w", encoding="utf-8") as fh:
            fh.write("s00_CROSS   t=   0.1s stable=True\n")
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet):
            audio_parity.main(["audio_parity", "score", wav, "48000", drive, "0.0", scores] + tokens)
        with open(scores, encoding="utf-8") as fh:
            meta = json.load(fh)["meta"]
        self.assertEqual(meta.get("target"), "ours")
        self.assertEqual(meta.get("script"), "launch_to_mission_xl.txt",
                         "compare() reads meta['script'] to pick the pinned reference: glued to the target it "
                         "silently fell back to launch_to_mission_xl for every capture")

    def test_a_script_path_with_a_space_stays_one_argument(self):
        out = sh('score_meta_args pcsx2 "/tmp/a dir/mission music.txt"; printf "%s\\n" "${META_ARGS[@]}"')
        self.assertEqual(out.strip().splitlines(), ["--target", "pcsx2", "--script", "mission music.txt"])


class RecorderPidTest(unittest.TestCase):
    """R5: the exclusion has never actually run -- the evidence capture's verdict names python3.13.exe, the
    recorder itself. A capture whose loopback.log carries no pid must say so in the verdict file."""

    CSV = ("t_s,name,pid,state,peak\n"
           "0.0,socom2.exe,4100,1,0.2100\n"
           "0.0,python3.13.exe,7777,1,0.2100\n"
           "5.0,socom2.exe,4100,1,0.1900\n"
           "5.0,python3.13.exe,7777,1,0.1900\n")

    def capture_dir(self, loopback_log):
        out = tempfile.mkdtemp(prefix="audio_verdict_")
        with open(os.path.join(out, "sessions.csv"), "w", encoding="utf-8") as fh:
            fh.write(self.CSV)
        with open(os.path.join(out, "loopback.log"), "w", encoding="utf-8") as fh:
            fh.write(loopback_log)
        return out

    def verdict(self, loopback_log):
        out = self.capture_dir(loopback_log)
        sh('write_sessions_verdict "%s" socom2.exe' % out.replace("\\", "/"))
        with open(os.path.join(out, "sessions_verdict.txt"), encoding="utf-8") as fh:
            return fh.read()

    def test_the_recorder_is_excluded_when_its_log_carries_a_pid(self):
        text = self.verdict("start_epoch=1700000000.000\npid=7777\nfirst_packet_epoch=1700000000.021\n")
        self.assertIn("clean", text, text)
        self.assertIn("7777", text, "the verdict says whose session it left out")

    def test_a_missing_recorder_pid_is_said_not_omitted(self):
        text = self.verdict("start_epoch=1700000000.000\nfirst_packet_epoch=1700000000.021\n")
        self.assertIn("no recorder pid", text, text)
        self.assertIn("CONTAMINATED", text, "without the pid the recorder's own session is still in the verdict")
        self.assertIn("python3.13.exe", text)


class ToolsRootTest(unittest.TestCase):
    def test_a_tools_root_with_a_space_is_not_split(self):
        """R7: `PYA=\"env PYTHONPATH=$TOOLS_ROOT python -P\"` used unquoted word-splits on the first space."""
        out = sh('TOOLS_ROOT="/c/a dir/socom pc"; pya -c "import os; print(os.environ[\'PYTHONPATH\'])"')
        self.assertIn("a dir/socom pc", out.replace("\\", "/"),
                      "PYTHONPATH reaches python whole (MSYS spells the drive its own way)")
        for name in ("audio_parity.sh", "mission_music_long.sh"):
            with open(os.path.join(ROOT, "scripts", "parity", name), encoding="utf-8") as fh:
                self.assertEqual(fh.read().count("$PYA"), 0,
                                 "%s: the unquoted PYA variable is gone; the pya function replaces it" % name)


class CaptureOffsetClockTest(unittest.TestCase):
    def test_the_offset_comes_from_the_capture_offset_module_and_capture_txt_names_its_clock(self):
        """LATER row 37: `offset=` was `.drive_started - .capture_started`, but the WAV's frame 0 is the recorder's
        first packet -- 1.93 s used where 1.58 s was true on s16_v0_t1b_dump, 5.23 s for 4.41 s on s16_v0_t1b.
        The script's line must be the module's, and that very line, run against those stamps, must yield both."""
        with open(SCRIPT, encoding="utf-8") as fh:
            text = fh.read()
        self.assertFalse(".capture_started').read()" in text, "the inline two-stamp subtraction is gone")
        lines = [l.strip() for l in text.splitlines() if "tools_py.parity.capture_offset" in l]
        self.assertEqual(len(lines), 1, "one line computes the offset: %r" % lines)
        self.assertTrue(lines[0].startswith("read -r offset offset_from "), lines[0])
        self.assertIn('"$OUT"', lines[0])
        written = [l for l in text.splitlines() if '> "$OUT/capture.txt"' in l]
        self.assertEqual(len(written), 1)
        self.assertIn("offset=${offset}s offset_from=$offset_from ", written[0],
                      "capture.txt says which clock the offset is on, right after it")
        out = tempfile.mkdtemp(prefix="audio_offset_")
        for name, body in ((".capture_started", "1790513721.176546000\n"),
                           (".drive_started", "1790513723.110032500\n"),
                           ("loopback.log", "start_epoch=1790513721.474\npid=51000\nfirst_packet_epoch=1790513721.526\n")):
            with open(os.path.join(out, name), "w", encoding="utf-8") as fh:
                fh.write(body)
        got = sh('OUT="%s"; %s; printf "%%s|%%s\\n" "$offset" "$offset_from"' % (out.replace("\\", "/"), lines[0]))
        self.assertEqual(got.strip(), "1.584|first_packet", "the line as the script runs it, not as it reads")


class DumpCapTest(unittest.TestCase):
    def test_the_nodump_rule_states_the_cap_the_runtime_actually_has(self):
        """R6: the docstring still said ten minutes after kDumpMaxFrames became twenty -- a reader deciding
        whether a dip past the dump's end is expected would have halved the window."""
        with open(PS2_AUDIO, encoding="utf-8", errors="replace") as fh:
            m = re.search(r"kDumpMaxFrames = (\d+)u \* (\d+)u", fh.read())
        self.assertIsNotNone(m)
        minutes = int(m.group(2)) // 60
        self.assertEqual(minutes, 20)
        words = {10: "ten minutes", 20: "twenty minutes"}
        self.assertIn(words[minutes], audio_dips.classify.__doc__,
                      "classify() explains NODUMP by the dump's cap: it must be the runtime's own")


class OwnerWrapperTest(unittest.TestCase):
    """R8: HUMAN_TASKS sent the owner to a wrapper under an ignored logs/ inside a worktree the merge removes.

    The owner's step itself is gone: the loop took the quiet capture on 2026-09-25 (Sprint 13 V5 Step 1) and the
    step is archived verbatim with the old list (Sprint 13 R4), so no test reads it. What stays live: the wrapper
    is tracked, and the owner's list never again names the ignored path.
    """

    def test_the_wrapper_is_tracked_beside_the_other_parity_scripts(self):
        self.assertTrue(os.path.exists(WRAPPER), "scripts/parity/capture_audio_out.sh")
        p = subprocess.run(["git", "ls-files", "--error-unmatch", "scripts/parity/capture_audio_out.sh"],
                           cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.assertEqual(p.returncode, 0, "the wrapper must be tracked: %s" % p.stdout)

    def test_human_tasks_never_names_the_ignored_wrapper(self):
        with open(HUMAN_TASKS, encoding="utf-8") as fh:
            text = fh.read()
        # either separator: a bash command line (forward slashes) or a Windows path (backslashes)
        for bad in ("logs\\capture_audio_out.sh", "logs/capture_audio_out.sh"):
            self.assertNotIn(bad, text, "the owner's list must not send anyone to the ignored %s" % bad)


if __name__ == "__main__":
    unittest.main()
