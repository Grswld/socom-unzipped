"""build.sh consults the loop lock (Sprint 14 G5).

`./build.sh recomp|runtime|release|test|all` refuses (exit 3, run_detached's refusal code) while another holder has
the loop lock, unless it runs as that holder's child (LOOP_LOCK_HELD, exported by `loop_lock.sh run` and
run_detached.sh). `tools` never consults the lock. The consult runs for `--dry-run` too, so these tests exercise it
without building anything: `--dry-run` prints the plan and exits before the toolchain check.

Never the real lock: LOOP_LOCK_PATH points at a temp dir and LOOP_LOCK_PS_CMD at a fake process list, as in
test_loop_lock.py; a lock taken here is released in tearDown.

Sprint 17 (the owner's rule of 2026-09-28): `build.sh test` runs the full Python suite only where it is the
bar -- the main tree with nobody queued on the lock, or the merged chain (whose `logs/.merged_chain.running` names
this holding); a linked worktree, or a holder with waiters QUEUED behind it, runs the C++ tests and skips the
discover with one line (`--full-suite` forces it). TestBuildShSuiteGuard drives the real test step end to end in a
temp repository and its linked worktree, with stub toolchain and stub test binaries, and a planted one-test suite.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUILD_SH = os.path.join(ROOT, "build.sh").replace("\\", "/")
LOCK_SH = os.path.join(ROOT, "scripts", "loop_lock.sh").replace("\\", "/")
IDLE = ["4|0||System|", "900|4||explorer.exe|C:\\Windows\\explorer.exe", "901|900||bash.exe|bash"]


def fwd(path):
    return path.replace("\\", "/")


@unittest.skipUnless(BASH, "bash not found")
class TestBuildShLockConsult(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="build_sh_lock_test_")
        self.lock = os.path.join(self.tmp, "lk")
        self.procs = os.path.join(self.tmp, "procs.txt")
        with open(self.procs, "w", newline="\n") as f:
            f.write("\n".join(IDLE) + "\n")
        self.taken = False

    def tearDown(self):
        if self.taken:
            subprocess.run([BASH, LOCK_SH, "release", "other-holder"], capture_output=True, text=True,
                           env=self.env(), timeout=60)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self, **extra):
        env = dict(os.environ)
        for k in ("LOOP_LOCK_HELD", "LOOP_LOCK_SELF_WINPID"):
            env.pop(k, None)     # this suite may itself run under `loop_lock.sh run`
        env["LOOP_LOCK_PATH"] = fwd(self.lock)
        env["LOOP_LOCK_PS_CMD"] = "cat '%s'" % fwd(self.procs)
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def hold(self):
        p = subprocess.run([BASH, LOCK_SH, "take", "other-holder", "--purpose", "build_sh_lock test"],
                           capture_output=True, text=True, env=self.env(), timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.taken = True
        check = subprocess.run([BASH, LOCK_SH, "check"], capture_output=True, text=True, env=self.env(), timeout=60)
        self.assertTrue(check.stdout.startswith("HELD: other-holder"), check.stdout)

    def build(self, *args, env=None):
        p = subprocess.run([BASH, BUILD_SH] + list(args), capture_output=True, text=True, cwd=ROOT,
                           env=env or self.env(), timeout=120)
        return p.returncode, p.stdout + p.stderr

    def test_held_by_another_refuses_every_locked_step(self):
        self.hold()
        for step in ("runtime", "recomp", "release", "test", "all"):
            rc, out = self.build(step, "--dry-run")
            self.assertEqual(rc, 3, "%s: %s" % (step, out))
            self.assertIn("lock held by other-holder", out)
            self.assertIn("build refused", out)
            self.assertIn("scripts/loop_lock.sh run", out)
            self.assertNotIn("would run", out, "a refused build prints no plan")

    def test_default_step_is_all_and_is_refused_too(self):
        self.hold()
        rc, out = self.build("--dry-run")
        self.assertEqual(rc, 3, out)
        self.assertIn("lock held by", out)

    def holder_id(self):
        p = subprocess.run([BASH, LOCK_SH, "id"], capture_output=True, text=True, env=self.env(), timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertTrue(p.stdout.startswith("other-holder "), p.stdout)
        return p.stdout.strip()

    def test_the_holders_child_proceeds(self):
        self.hold()
        rc, out = self.build("runtime", "--dry-run", env=self.env(LOOP_LOCK_HELD=self.holder_id()))
        self.assertEqual(rc, 0, out)
        self.assertNotIn("lock held by", out)
        self.assertNotIn("stale", out)
        self.assertIn("would run", out)

    def test_a_stale_holder_value_is_refused(self):
        self.hold()
        live = self.holder_id()
        rc, out = self.build("runtime", "--dry-run", env=self.env(LOOP_LOCK_HELD="bogus 1"))
        self.assertEqual(rc, 3, out)
        self.assertIn("LOOP_LOCK_HELD is stale: 'bogus 1' vs holder '%s'" % live, out)
        self.assertNotIn("would run", out)

    def test_a_set_holder_value_on_a_free_lock_proceeds(self):
        rc, out = self.build("runtime", "--dry-run", env=self.env(LOOP_LOCK_HELD="bogus 1"))
        self.assertEqual(rc, 0, out)
        self.assertIn("would run", out)

    def test_free_lock_proceeds_and_prints_the_plan(self):
        rc, out = self.build("runtime", "--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertIn("would run", out)
        self.assertIn("runtime", out)
        self.assertNotIn("lock held by", out)

    def test_tools_never_consults_the_lock(self):
        self.hold()
        rc, out = self.build("tools", "--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertNotIn("lock held by", out)
        self.assertIn("would run", out)

    def test_dry_run_is_parsed_before_the_toolchain_check(self):
        # Static: a machine with no toolchain must still get the plan, so the dry-run exit precedes the check.
        with open(os.path.join(ROOT, "build.sh")) as f:
            text = f.read()
        self.assertLess(text.index('if [ "$DRY_RUN" = 1 ]'), text.index("no toolchain under tools/"))


SKIP_LINKED = "tests: python suite skipped (linked worktree; the merged chain runs it -- --full-suite to force)"
SKIP_PREFIX = "tests: python suite skipped ("
PLANTED = "test_the_planted_suite_ran"          # the planted suite's one test, as `unittest -v` names it
CXX_RAN = "STUB ps2x_tests ran"
# The copies build.sh's test step needs in a tree; each tree gets its own (untracked) copy, so ROOT is that tree.
COPIED = ("build.sh", "scripts/python_env.sh", "scripts/loop_lock.sh", "scripts/check_quiet_gate.sh")
STUB_TOOL = "#!/bin/sh\nexit 0\n"
STUB_PS2X = ("#!/bin/sh\necho '%s'\n"
             "if [ -n \"${STUB_PS2X_FAIL:-}\" ]; then echo 'STUB ps2x_tests FAILED'; exit 1; fi\nexit 0\n" % CXX_RAN)
# vu1_replay: every verify PASSes; the two clamp checks (build.sh's expect_native) want their exact native counts.
STUB_VU1 = ("#!/bin/sh\n"
            "if [ -n \"${PS2X_VU1_NATIVE_TEST_CLIP_CEILING:-}\" ]; then c='ended=9 handbacks=6';\n"
            "else c='ended=0 handbacks=15'; fi\n"
            "echo \"[vu1_replay] native entered=15 $c\"\necho PASS\nexit 0\n")
PLANTED_TEST = ("import unittest\n\n\nclass Planted(unittest.TestCase):\n"
                "    def %s(self):\n        pass\n" % PLANTED)


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="\n") as f:
        f.write(text)
    os.chmod(path, 0o755)


@unittest.skipUnless(BASH, "bash not found")
class TestBuildShSuiteGuard(unittest.TestCase):
    """The owner's rule (2026-09-28): the full Python suite is the merged chain's (and CI's), not a branch build's.

    A temp repository (the main tree) and a linked worktree of it, each with its own copy of build.sh and the three
    scripts its test step calls; a stub clang/cmake/ninja on the PATH, stub ps2x_tests.exe and vu1_replay.exe where
    the test step looks for them, and a planted one-test Python suite, so `build.sh test --no-runner` runs for real:
    the C++ stage prints CXX_RAN, the Python stage prints PLANTED. The trees are built once for the class; a full
    step spawns some sixty processes, so three cases run it end to end and the rest read the decision through
    `--dry-run`, which prints the same skip line from the same function.
    """

    @classmethod
    def setUpClass(cls):
        cls.trees = tempfile.mkdtemp(prefix="build_sh_suite_trees_")
        cls.main = os.path.join(cls.trees, "main")
        cls.linked = os.path.join(cls.trees, "linked")
        git = ["git", "-C", cls.main, "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run(["git", "init", "-q", cls.main], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "x"], check=True, capture_output=True)
        subprocess.run(git + ["worktree", "add", "-q", "-b", "side", cls.linked], check=True, capture_output=True)
        for tree in (cls.main, cls.linked):
            for rel in COPIED:
                dst = os.path.join(tree, *rel.split("/"))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(os.path.join(ROOT, *rel.split("/")), dst)
            _write(os.path.join(tree, "tools_py", "__init__.py"), "")
            _write(os.path.join(tree, "tools_py", "tests", "__init__.py"), "")
            _write(os.path.join(tree, "tools_py", "tests", "test_planted.py"), PLANTED_TEST)
            rt = os.path.join(tree, "third_party", "ps2recomp", "build-clang")
            _write(os.path.join(rt, "ps2xTest", "ps2x_tests.exe"), STUB_PS2X)
            _write(os.path.join(rt, "ps2xRuntime", "vu1_replay.exe"), STUB_VU1)
        cls.stubbin = os.path.join(cls.trees, "stubbin")
        for tool in ("clang", "clang++", "cmake", "ninja"):
            _write(os.path.join(cls.stubbin, tool), STUB_TOOL)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.trees, ignore_errors=True)

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="build_sh_suite_test_")
        self.lock = os.path.join(self.tmp, "lk")
        self.procs = os.path.join(self.tmp, "procs.txt")
        with open(self.procs, "w", newline="\n") as f:
            f.write("\n".join(IDLE) + "\n")
        self.taken = False
        self.waiters = []

    def tearDown(self):
        for p in self.waiters:
            if p.poll() is None:
                p.kill()
            try:
                p.communicate(timeout=10)
            except (subprocess.TimeoutExpired, ValueError):
                pass
        if self.taken:
            subprocess.run([BASH, LOCK_SH, "release", "other-holder"], capture_output=True, text=True,
                           env=self.env(), timeout=120)
        for tree in (self.main, self.linked):
            try:
                os.remove(os.path.join(tree, "logs", ".merged_chain.running"))
            except OSError:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def env(self, **extra):
        env = dict(os.environ)
        for k in ("LOOP_LOCK_HELD", "LOOP_LOCK_SELF_WINPID", "FORCE_QUIET"):
            env.pop(k, None)     # this suite may itself run under `loop_lock.sh run`
        env["LOOP_LOCK_PATH"] = fwd(self.lock)
        env["LOOP_LOCK_PS_CMD"] = "cat '%s'" % fwd(self.procs)
        env["PYTHON"] = fwd(sys.executable)
        env["PATH"] = self.stubbin + os.pathsep + env.get("PATH", "")
        env.update({k: str(v) for k, v in extra.items()})
        return env

    def lock_sh(self, *args, env=None):
        # a loaded host (2026-09-28: 3-4 s a process) makes one lock verb take tens of seconds -- generous timeouts
        return subprocess.run([BASH, LOCK_SH] + list(args), capture_output=True, text=True, env=env or self.env(),
                              timeout=300)

    def hold(self):
        p = self.lock_sh("take", "other-holder", "--purpose", "suite guard test")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.taken = True
        p = self.lock_sh("id")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout.strip()

    def queue_a_waiter(self):
        p = subprocess.Popen([BASH, LOCK_SH, "wait", "queued-one", "30"], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, env=self.env(LOOP_LOCK_WAIT_SEC=5))
        self.waiters.append(p)
        deadline = time.time() + 600
        check = ""
        while time.time() < deadline:
            check = self.lock_sh("check").stdout
            if "QUEUED: queued-one" in check:
                return
            if p.poll() is not None:
                self.fail("the waiter exited before it queued: %s" % p.communicate()[0])
            time.sleep(0.5)
        self.fail("the waiter never queued: %s" % check)

    def mark_chain(self, tree, held):
        _write(os.path.join(tree, "logs", ".merged_chain.running"),
               "pid=1\nstart=1\nhead=0\nstamp=t\nroot=%s\nheld=%s\n" % (fwd(tree), held))

    def build(self, tree, *args, env=None):
        p = subprocess.run([BASH, fwd(os.path.join(tree, "build.sh")), "test", "--no-runner"] + list(args),
                           capture_output=True, text=True, cwd=tree, env=env or self.env(), timeout=1800)
        return p.returncode, p.stdout + p.stderr

    def plan(self, tree, *args, env=None):
        return self.build(tree, "--dry-run", *args, env=env)

    def assertSuiteRan(self, rc, out):
        self.assertEqual(rc, 0, out)
        self.assertIn(CXX_RAN, out)
        self.assertIn(PLANTED, out, "the Python suite should have run")
        self.assertNotIn(SKIP_PREFIX, out)
        self.assertIn("tests: ok", out)

    def assertSuiteSkipped(self, rc, out):
        self.assertEqual(rc, 0, out)
        self.assertIn(CXX_RAN, out, "the C++ tests run either way")
        self.assertNotIn(PLANTED, out, "the Python suite should have been skipped")
        self.assertEqual(sum(1 for line in out.splitlines() if line.startswith(SKIP_PREFIX)), 1, out)
        self.assertIn("tests: ok", out)

    def assertPlanRuns(self, rc, out):
        self.assertEqual(rc, 0, out)
        self.assertIn("would run: test -- the quiet gate, the Python suite, the C++ tests", out)
        self.assertNotIn(SKIP_PREFIX, out)

    def assertPlanSkips(self, rc, out):
        """The skip line the step would print; returns it."""
        self.assertEqual(rc, 0, out)
        self.assertIn("would run: test -- the quiet gate, the C++ tests", out)
        self.assertNotIn("the Python suite", out)
        lines = [x.strip() for x in out.splitlines() if x.strip().startswith(SKIP_PREFIX)]
        self.assertEqual(len(lines), 1, out)
        self.assertTrue(lines[0].endswith("; the merged chain runs it -- --full-suite to force)"), lines[0])
        return lines[0]

    # ---- end to end: the step itself ------------------------------------------------------------------------------
    # (d) the main tree, nobody queued: unchanged, the suite runs
    def test_main_tree_with_no_queue_runs_the_suite(self):
        self.assertSuiteRan(*self.build(self.main))

    # (a) a linked worktree: the C++ tests, one line, exit 0
    def test_linked_worktree_skips_the_suite_with_one_line(self):
        rc, out = self.build(self.linked)
        self.assertSuiteSkipped(rc, out)
        self.assertIn(SKIP_LINKED, out.splitlines())

    def test_a_skipped_suite_still_fails_on_the_cxx_tests(self):
        rc, out = self.build(self.linked, env=self.env(STUB_PS2X_FAIL=1))
        self.assertNotEqual(rc, 0, out)
        self.assertIn("STUB ps2x_tests FAILED", out)
        self.assertNotIn("tests: ok", out)

    # ---- the decision, through --dry-run ---------------------------------------------------------------------------
    def test_dry_run_in_a_linked_worktree_names_the_skip(self):
        self.assertEqual(self.assertPlanSkips(*self.plan(self.linked)), SKIP_LINKED)

    def test_dry_run_in_the_main_tree_runs_the_suite(self):
        self.assertPlanRuns(*self.plan(self.main))

    # (c) --full-suite forces it
    def test_full_suite_forces_it_in_a_linked_worktree(self):
        self.assertPlanRuns(*self.plan(self.linked, "--full-suite"))

    # (b) this tree holds the lock and a waiter is QUEUED behind it; (c) again; (e) the chain's holding
    def test_a_queued_waiter_skips_it_unless_forced_or_the_chain(self):
        held = self.hold()
        self.assertPlanRuns(*self.plan(self.main, env=self.env(LOOP_LOCK_HELD=held)))    # held, nobody queued
        self.queue_a_waiter()
        line = self.assertPlanSkips(*self.plan(self.main, env=self.env(LOOP_LOCK_HELD=held)))
        self.assertIn("queued on the loop lock", line)
        self.assertPlanRuns(*self.plan(self.main, "--full-suite", env=self.env(LOOP_LOCK_HELD=held)))
        # (e) the merged chain: its marker in this tree names this holding -- the suite runs, queue or linked tree
        for tree in (self.main, self.linked):
            self.mark_chain(tree, held)
            self.assertPlanRuns(*self.plan(tree, env=self.env(LOOP_LOCK_HELD=held)))
        # a marker that names another holding (a dead chain's) forces nothing
        self.mark_chain(self.linked, "other-chain 123")
        self.assertEqual(self.assertPlanSkips(*self.plan(self.linked, env=self.env(LOOP_LOCK_HELD=held))),
                         SKIP_LINKED)


if __name__ == "__main__":
    unittest.main()
