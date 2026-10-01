"""scripts/parity/merged_chain.sh -- the merged chain, the gate unit (Sprint 14 Task W2).

The template the controller copies to logs/s14_merged_chain.sh and launches ONCE under the loop lock: recomp ->
runtime -> suites -> gate (on the exe it built, SOCOM_EXE) -> the E2 leg (skipped with a reason until its references
exist) -> the release build -> the archive and PLAYTEST's block (`playtest_block.sh --release`, Task D5). A red step
names the merges since the last green chain (logs/merged_chain.last_green) and the eviction; a dirty tracked tree is
refused before anything runs.

No build and no game: every test runs a COPY of the chain in a throwaway git repository whose build.sh, Python and
playtest_block.sh are fakes that log their arguments, under a planted lock record (LOOP_LOCK_PATH in the temp dir).
"""
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest

from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAIN = os.path.join(ROOT, "scripts", "parity", "merged_chain.sh")
LOCK_SH = os.path.join(ROOT, "scripts", "loop_lock.sh")
PY_ENV = os.path.join(ROOT, "scripts", "python_env.sh")
GIT = shutil.which("git")
STEPS = ["recomp", "runtime", "test", "gate", "the fourth leg", "release", "archive and PLAYTEST block"]

FAKE_BUILD = """#!/usr/bin/env bash
# a fake build.sh: logs its step; FAKE_FAIL=<step> fails it, FAKE_DIRTY=<step> edits a tracked file
echo "build $1" >> "$FAKE_LOG"
# Sprint 17 G1: the chain's running marker as each step sees it, and (CHAIN_JUDGE_PY set) the hooks' judgement of it
[ -f logs/.merged_chain.running ] && echo "marker $1 $(tr '[:space:]' ' ' < logs/.merged_chain.running)" >> "$FAKE_LOG"
[ -n "${CHAIN_JUDGE_PY:-}" ] && "$CHAIN_JUDGE_PY" -m tools_py.hooks.chainmark . >> "$FAKE_LOG"
case "$1" in runtime) mkdir -p dist dist-linux && echo exe > dist/socom2.exe && echo exe > dist-linux/socom2;; esac
[ "${FAKE_DIRTY:-}" = "$1" ] && echo dirt >> tracked.txt
[ "${FAKE_COMMIT:-}" = "$1" ] && git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m moved
[ "${FAKE_FAIL:-}" = "$1" ] && exit 7
exit 0
"""
FAKE_PYTHON = """#!/usr/bin/env bash
[ "$1" = -c ] && exit 0
echo "python SOCOM_EXE=${SOCOM_EXE:-} $*" >> "$FAKE_LOG"
case "$*" in *--leg*) [ "${FAKE_FAIL:-}" = leg ] && exit 5;; *) [ "${FAKE_FAIL:-}" = gate ] && exit 6;; esac
exit 0
"""
FAKE_PLAYTEST = """#!/usr/bin/env bash
echo "playtest $*" >> "$FAKE_LOG"
echo "block rewritten" >> docs/PLAYTEST.md
[ "${FAKE_FAIL:-}" = playtest ] && exit 3
exit 0
"""


def _write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    if mode:
        os.chmod(path, mode)


def fwd(path):
    return path.replace("\\", "/")


class TestMergedChainText(unittest.TestCase):
    """The template's shape, read from its text."""

    def setUp(self):
        with open(CHAIN, encoding="utf-8") as fh:
            self.text = fh.read()
        self.code = "\n".join(l for l in self.text.splitlines() if not l.lstrip().startswith("#"))

    @unittest.skipUnless(BASH, "bash not found")
    def test_it_parses(self):
        p = subprocess.run([BASH, "-n", CHAIN], capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_it_takes_no_lock_of_its_own(self):
        """ONE holding for the whole chain: the launcher's. A take, run, wait or release inside would be a second
        holding (or a gap between steps the queue grants to its head); run_detached inside a held lock is refused."""
        self.assertIsNone(re.search(r"loop_lock\.sh\"?\s+(take|run|wait|release)\b", self.code), "a lock verb in the chain")
        self.assertNotIn("run_detached.sh", self.code)
        self.assertIn("LOOP_LOCK_HELD", self.code)

    def test_the_last_step_packages_the_release_build(self):
        self.assertRegex(self.code, r"playtest_block\.sh\"?\s+--release\b")

    def test_the_gate_is_given_the_exe(self):
        self.assertIn("SOCOM_EXE=", self.code)


@unittest.skipUnless(BASH and GIT, "bash and git needed")
class TestMergedChainRuns(unittest.TestCase):
    """The chain run end to end in a throwaway repository with fake steps."""

    def git(self, *args):
        p = subprocess.run([GIT, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
                           + list(args),
                           cwd=self.repo, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout.strip()

    def merge_branch(self, name):
        self.git("checkout", "-q", "-b", name)
        _write(os.path.join(self.repo, name + ".txt"), name + "\n")
        self.git("add", name + ".txt")
        self.git("commit", "-q", "-m", "feat(%s): work" % name)
        self.git("checkout", "-q", "sprint")
        self.git("merge", "-q", "--no-ff", "-m", "merge(sprint): %s landed" % name, name)
        return self.git("rev-parse", "HEAD")

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="merged_chain_test_")
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        self.git("init", "-q")
        self.git("checkout", "-q", "-b", "sprint")
        for src, rel in ((CHAIN, "scripts/parity/merged_chain.sh"), (PY_ENV, "scripts/python_env.sh")):
            with open(src, encoding="utf-8") as fh:
                _write(os.path.join(self.repo, *rel.split("/")), fh.read())
        _write(os.path.join(self.repo, "build.sh"), FAKE_BUILD, 0o755)
        _write(os.path.join(self.repo, "scripts", "parity", "playtest_block.sh"), FAKE_PLAYTEST, 0o755)
        _write(os.path.join(self.repo, "docs", "PLAYTEST.md"), "# playtest\n")
        _write(os.path.join(self.repo, "tracked.txt"), "clean\n")
        _write(os.path.join(self.repo, ".gitignore"), "/logs/\n/dist*/\n")
        self.git("add", ".gitignore", "build.sh", "tracked.txt", "docs/PLAYTEST.md", "scripts/python_env.sh",
                 "scripts/parity/merged_chain.sh", "scripts/parity/playtest_block.sh")
        self.git("commit", "-q", "-m", "base")
        self.fake_py = os.path.join(self.tmp, "fakepy.sh")
        _write(self.fake_py, FAKE_PYTHON, 0o755)
        self.log = os.path.join(self.tmp, "fake.log")
        self.lock = os.path.join(self.tmp, "lk")
        os.makedirs(self.lock + ".d")
        _write(os.path.join(self.lock + ".d", "record"), "chain 100-1x1 %d merged chain\n" % int(time.time()))
        self.last_green = os.path.join(self.repo, "logs", "merged_chain.last_green")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_chain(self, **extra):
        env = dict(os.environ)
        for k in ("MERGED_CHAIN_DRY_RUN", "SOCOM_EXE", "PLAYTEST_BLOCK_PRINT_DIR"):
            env.pop(k, None)
        env.update({"PYTHON": fwd(self.fake_py), "FAKE_LOG": fwd(self.log), "LOOP_LOCK_PATH": fwd(self.lock),
                    "LOOP_LOCK_HELD": "chain 100-1x1", "MERGED_CHAIN_LOCK_SH": fwd(LOCK_SH),
                    "LOOP_LOCK_PS_CMD": "true",
                    # the launcher preflight reads the host's processes; the owner's launcher may be open
                    "BUILD_LAUNCHER_CHECK_CMD": "true"})
        env.update({k: str(v) for k, v in extra.items() if v is not None})
        for k, v in extra.items():
            if v is None:
                env.pop(k, None)
        p = subprocess.run([BASH, "scripts/parity/merged_chain.sh", "stamp_x"], cwd=self.repo, capture_output=True,
                           text=True, env=env, timeout=120)
        return p.returncode, p.stdout + p.stderr

    def fake_log(self):
        try:
            with open(self.log, encoding="utf-8") as fh:
                return fh.read().splitlines()
        except OSError:
            return []

    def steps_printed(self, out):
        return re.findall(r"^=== step \d+: (.+?) ===", out, re.M)

    def test_green_runs_the_steps_in_order_and_records_the_head(self):
        self.merge_branch("a")
        head = self.merge_branch("b")
        rc, out = self.run_chain()
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.steps_printed(out), STEPS)
        log = self.fake_log()
        self.assertEqual([l for l in log if l.startswith("build ")],
                         ["build recomp", "build runtime", "build test", "build release"])
        gate = [l for l in log if l.startswith("python ")]
        self.assertEqual(len(gate), 1, log)
        self.assertIn("-m tools_py.parity.gate", gate[0])
        self.assertIn("--stamp stamp_x", gate[0])
        self.assertRegex(gate[0], r"SOCOM_EXE=\S*dist(-linux)?/socom2(\.exe)? ")
        self.assertEqual(log[-1], "playtest --release")
        with open(self.last_green) as fh:
            self.assertEqual(fh.read().strip(), head)
        self.assertIn("SKIPPED", out)
        self.assertRegex(out, r"SKIPPED.*scripts/parity/refs/")
        with open(os.path.join(self.repo, "logs", "merged_chain.done")) as fh:
            self.assertEqual(fh.read().strip(), "done 0 all-green")

    def test_the_e2_leg_runs_when_its_references_exist(self):
        refs = os.path.join(self.tmp, "refs")
        os.makedirs(refs)
        rc, out = self.run_chain(MERGED_CHAIN_LEG_REFS=fwd(refs))
        self.assertEqual(rc, 0, out)
        gate = [l for l in self.fake_log() if l.startswith("python ")]
        self.assertEqual(len(gate), 2, gate)
        self.assertIn("--leg", gate[1])
        self.assertRegex(gate[1], r"SOCOM_EXE=\S*dist(-linux)?/socom2(\.exe)? ")

    def test_a_red_step_names_the_merges_since_the_last_green_chain(self):
        self.merge_branch("a")
        green = self.git("rev-parse", "HEAD")
        os.makedirs(os.path.dirname(self.last_green))
        _write(self.last_green, green + "\n")
        self.merge_branch("b")
        self.merge_branch("c")
        rc, out = self.run_chain(FAKE_FAIL="gate")
        self.assertEqual(rc, 6, out)
        self.assertEqual(self.steps_printed(out), STEPS[:4])
        self.assertIn("merge(sprint): b landed", out)
        self.assertIn("merge(sprint): c landed", out)
        self.assertNotIn("merge(sprint): a landed", out)
        self.assertIn("git revert -m 1", out)
        with open(self.last_green) as fh:
            self.assertEqual(fh.read().strip(), green, "a red chain moved the last-green record")
        with open(os.path.join(self.repo, "logs", "merged_chain.done")) as fh:
            self.assertEqual(fh.read().strip(), "done 6 gate")

    def test_a_head_that_moves_during_the_chain_is_red_and_records_nothing(self):
        # W2 review A2 (1): a commit landing mid-chain means the steps did not all build one commit.
        head0 = self.git("rev-parse", "HEAD")
        rc, out = self.run_chain(FAKE_COMMIT="runtime")
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(self.steps_printed(out), STEPS[:2])
        self.assertIn("HEAD moved from %s to " % head0, out)
        self.assertIn("during runtime", out)
        self.assertFalse(os.path.exists(self.last_green))
        with open(os.path.join(self.repo, "logs", "merged_chain.done")) as fh:
            self.assertTrue(fh.read().startswith("done 1 runtime"), "the done marker names the step")

    def test_a_last_green_record_off_this_line_falls_back_to_main(self):
        # W2 review A2 (2): a record that exists but is not an ancestor of HEAD (another branch's green) must not
        # be the range's start; the merges since main are listed instead.
        self.git("branch", "main")
        self.git("checkout", "-q", "-b", "other")
        self.git("commit", "-q", "--allow-empty", "-m", "elsewhere")
        stray = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "sprint")
        self.merge_branch("a")
        self.merge_branch("b")
        os.makedirs(os.path.dirname(self.last_green))
        _write(self.last_green, stray + "\n")
        rc, out = self.run_chain(FAKE_FAIL="test")
        self.assertEqual(rc, 7, out)
        self.assertIn("not on this line", out)
        self.assertIn("since main", out)
        self.assertIn("merge(sprint): a landed", out)
        self.assertIn("merge(sprint): b landed", out)

    def test_a_step_that_dirties_a_tracked_file_is_red(self):
        rc, out = self.run_chain(FAKE_DIRTY="recomp")
        self.assertNotEqual(rc, 0, out)
        self.assertIn("tracked.txt", out)
        self.assertEqual(self.steps_printed(out), STEPS[:1])
        self.assertFalse(os.path.exists(self.last_green))

    def test_a_dirty_tree_is_refused_before_any_step(self):
        _write(os.path.join(self.repo, "tracked.txt"), "someone's edit\n")
        rc, out = self.run_chain()
        self.assertEqual(rc, 2, out)
        self.assertIn("tracked.txt", out)
        self.assertEqual(self.steps_printed(out), [])
        self.assertEqual(self.fake_log(), [])

    def test_a_running_launcher_is_refused_before_any_step(self):
        # Sprint 17: step 2's copy of the launcher fails 'Device or resource busy' while it runs (three reds,
        # 2026-09-30/10-01); the preflight refuses first, with build.sh's line, so no recomp time is spent.
        rc, out = self.run_chain(BUILD_LAUNCHER_CHECK_CMD="echo 4242")
        self.assertEqual(rc, 2, out)
        self.assertIn("merged_chain: REFUSED -- the launcher is running (pid 4242): close the launcher window", out)
        self.assertEqual(self.steps_printed(out), [])
        self.assertEqual(self.fake_log(), [])
        with open(os.path.join(self.repo, "logs", "merged_chain.done")) as fh:      # logs/<script name>.done
            self.assertEqual(fh.read().strip(), "done 2 refused-launcher-running")
        self.assertFalse(os.path.exists(self.running_marker()))

    def test_it_refuses_to_run_outside_the_lock(self):
        rc, out = self.run_chain(LOOP_LOCK_HELD=None)
        self.assertEqual(rc, 2, out)
        self.assertIn("lock", out)
        self.assertEqual(self.fake_log(), [])
        rc, out = self.run_chain(LOOP_LOCK_HELD="someone 1-1x1")
        self.assertEqual(rc, 2, out)
        self.assertEqual(self.fake_log(), [])

    # --- Sprint 17 G1: logs/.merged_chain.running pins the chain's tree for the hooks (tools_py/hooks/chainmark.py)

    def running_marker(self):
        return os.path.join(self.repo, "logs", ".merged_chain.running")

    def markers(self):
        return [l for l in self.fake_log() if l.startswith("marker ")]

    def test_the_running_marker_lives_exactly_as_long_as_the_chain(self):
        head = self.git("rev-parse", "HEAD")
        judge = shutil.which("python") or shutil.which("python3")
        rc, out = self.run_chain(CHAIN_JUDGE_PY=fwd(judge) if judge else None, PYTHONPATH=ROOT)
        self.assertEqual(rc, 0, out)
        seen = self.markers()
        self.assertEqual([l.split()[1] for l in seen], ["recomp", "runtime", "test", "release"])
        for field in ("head=%s" % head, "stamp=stamp_x", "held=chain 100-1x1"):
            self.assertIn(field, seen[0])
        self.assertRegex(seen[0], r" pid=\d+ start=\d+ ")
        self.assertRegex(seen[0], r" root=\S*/repo ")          # git's spelling of the path, not tempfile's 8.3 one
        if judge:                                            # the hooks' own reader calls the chain alive, mid-run
            judged = [l for l in self.fake_log() if l.startswith("running ")]
            self.assertEqual(len(judged), 4, self.fake_log())
            self.assertIn("stamp=stamp_x", judged[0])
        self.assertFalse(os.path.exists(self.running_marker()), "the marker outlived a green chain")

    def test_a_red_chain_removes_its_marker(self):
        rc, out = self.run_chain(FAKE_FAIL="gate")
        self.assertEqual(rc, 6, out)
        self.assertEqual(len(self.markers()), 3)             # recomp, runtime, test ran under it
        self.assertFalse(os.path.exists(self.running_marker()), "the marker outlived a red chain")

    def test_a_refused_or_dry_chain_writes_no_marker(self):
        rc, out = self.run_chain(LOOP_LOCK_HELD=None)
        self.assertEqual(rc, 2, out)
        _write(os.path.join(self.repo, "tracked.txt"), "someone's edit\n")
        rc, out = self.run_chain()
        self.assertEqual(rc, 2, out)
        _write(os.path.join(self.repo, "tracked.txt"), "clean\n")
        rc, out = self.run_chain(MERGED_CHAIN_DRY_RUN="1", LOOP_LOCK_HELD=None)
        self.assertEqual(rc, 3, out)
        self.assertEqual(self.markers(), [])
        self.assertFalse(os.path.exists(self.running_marker()))

    def test_a_dry_run_prints_the_steps_runs_nothing_and_is_never_green(self):
        rc, out = self.run_chain(MERGED_CHAIN_DRY_RUN="1", LOOP_LOCK_HELD=None)
        self.assertEqual(rc, 3, out)
        self.assertEqual(self.steps_printed(out), STEPS)
        self.assertIn("playtest_block.sh --release", out)
        self.assertEqual(self.fake_log(), [])
        self.assertFalse(os.path.exists(self.last_green))


if __name__ == "__main__":
    unittest.main()
