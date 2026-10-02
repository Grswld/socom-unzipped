"""run.sh's timeout(1) fallback (macOS port, phase 1): base macOS has no timeout, so run.sh kills the run itself.

The fallback must exit 124 on expiry, as timeout does, and must not leave anything holding the caller's stdout
once the game has exited: an orphaned watcher sleep kept a `run.sh 600 | tee` pipeline open for the rest of the
600 s after a crash (final review, I1). Runs only where /usr/bin:/bin has no timeout -- elsewhere run.sh uses it.
"""
import os
import shutil
import subprocess
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUN_SH = os.path.join(ROOT, "run.sh")
BARE_PATH = "/usr/bin:/bin"


@unittest.skipIf(os.name == "nt", "run.sh's fallback is the POSIX path")
@unittest.skipIf(shutil.which("timeout", path=BARE_PATH) or shutil.which("gtimeout", path=BARE_PATH),
                 "timeout(1) is on the bare PATH here, so run.sh never takes its fallback")
class RunShTimeoutFallback(unittest.TestCase):
    def run_sh(self, exe, elf, secs):
        env = {**os.environ, "PATH": BARE_PATH, "SOCOM_EXE": exe, "SOCOM_GAME_ELF": elf}
        start = time.monotonic()
        # stdout through a pipe that is read to EOF: an orphan holding it open shows as wall time
        p = subprocess.run(["bash", RUN_SH, str(secs)], cwd=ROOT, env=env, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=60)
        return p.stdout, time.monotonic() - start

    def test_expiry_exits_124(self):
        out, _ = self.run_sh("/bin/sleep", "30", 2)
        self.assertTrue(out.startswith("exit=124 "), out)

    def test_an_early_exit_releases_the_callers_stdout_at_once(self):
        out, elapsed = self.run_sh("/usr/bin/true", "x", 8)
        self.assertTrue(out.startswith("exit=0 "), out)
        self.assertLess(elapsed, 4.0, "something kept run.sh's stdout open after the game exited")

    def test_the_games_own_exit_code_comes_back(self):
        out, _ = self.run_sh("/usr/bin/false", "x", 5)
        self.assertTrue(out.startswith("exit=1 "), out)


if __name__ == "__main__":
    unittest.main()
