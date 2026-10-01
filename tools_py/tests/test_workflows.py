""".github/workflows: what a run's conclusion means, and which checks the `main` ruleset requires (Sprint 13 H1).

GitHub computes a workflow run's conclusion from its jobs: any job that ran and passed makes the run `success`;
the run reads `skipped` only when EVERY job was skipped (read on 2026-09-25 from public runs: cli/cli's "PR
Triaging" is `skipped` when all seven jobs skip and `success` when one of them runs). The `linux` and `windows`
workflows' `changes` job always runs, so a docs-only push used to read `success` with the build skipped -- and a
final status job that is itself skipped cannot change that, because `changes` still succeeded. The only place the
decision can be made before any job exists is the trigger: `on.push.paths-ignore: docs/**`. A docs-only push now
starts no `linux` or `windows` run at all; a push that touches anything else builds.

The pull_request trigger keeps no path filter: `build`, `build-windows` and `leakcheck` are the `main` ruleset's
required checks (docs/GIT_STRATEGY.md section 6), and a required check whose workflow never starts leaves the pull
request waiting forever. On a pull request the `changes` job compares the pull request's base...head (from the merge base), and this test
pins that the expression is chosen by the event's name, so a pull_request run can never fall back to a push's
`before`.

These are text-level checks with an optional PyYAML layer: the `docs` workflow runs this file with no packages
installed, and it must run (not skip) there. The build runners install requirements.txt since Sprint 13 H7, which
carries PyYAML, so the parsed layer runs there too.
"""
import os
import re
import subprocess
import tempfile
import textwrap
import unittest

from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WF = os.path.join(ROOT, ".github", "workflows")

# The workflow whose build is skipped on docs-only changes -> its build job (a required check on `main`).
BUILD_WORKFLOWS = {"linux.yml": "build", "windows.yml": "build-windows"}
# Every required check on `main` (docs/GIT_STRATEGY.md section 6, the ruleset as read 2026-09-25) -> its workflow.
REQUIRED_CHECKS = {"build": "linux.yml", "build-windows": "windows.yml", "leakcheck": "secrets.yml"}

PR_BASE = "github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before"
PR_HEAD = "github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha"


def _text(name):
    with open(os.path.join(WF, name), encoding="utf-8") as f:
        return f.read()


def _block(text, key, indent):
    """The lines under `<indent>key:` up to the next line at that indent or shallower."""
    lines = text.splitlines()
    pad = " " * indent
    for i, line in enumerate(lines):
        if line.rstrip() == pad + key + ":" or line.startswith(pad + key + ": "):
            out = []
            for nxt in lines[i + 1:]:
                if nxt.strip() and not nxt.startswith(" " * (indent + 1)) and not nxt.lstrip().startswith("#"):
                    break
                out.append(nxt)
            return line, "\n".join(out)
    return None, None


def _jobs(text):
    """Job ids (two-space keys under `jobs:`) -> their bodies."""
    _, body = _block(text, "jobs", 0)
    jobs, cur = {}, None
    for line in (body or "").splitlines():
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            cur = m.group(1)
            jobs[cur] = []
        elif cur:
            jobs[cur].append(line)
    return {k: "\n".join(v) for k, v in jobs.items()}


class DocsOnlyPushStartsNoBuildRun(unittest.TestCase):
    def test_push_ignores_docs_and_pull_request_is_unfiltered(self):
        for name in BUILD_WORKFLOWS:
            text = _text(name)
            _, on = _block(text, "on", 0)
            self.assertIsNotNone(on, name)
            _, push = _block(on, "push", 2)
            self.assertIsNotNone(push, f"{name}: no push trigger")
            self.assertRegex(push, r"paths-ignore:\s*\n\s*- '?docs/\*\*'?",
                             f"{name}: a docs-only push must start no run (on.push.paths-ignore: docs/**)")
            head, pr = _block(on, "pull_request", 2)
            self.assertIsNotNone(head, f"{name}: no pull_request trigger")
            self.assertNotIn("paths", pr or "",
                             f"{name}: a path filter on pull_request would leave a required check waiting forever")

    def test_secrets_runs_on_every_push(self):
        text = _text("secrets.yml")
        self.assertNotIn("paths", _block(text, "on", 0)[1], "a secret in a document is still a secret")


class PullRequestComparesBaseToHead(unittest.TestCase):
    def test_changes_filter_names_the_pull_request_base(self):
        for name in BUILD_WORKFLOWS:
            changes = _jobs(_text(name)).get("changes")
            self.assertIsNotNone(changes, f"{name}: no changes job")
            self.assertIn("BASE: ${{ " + PR_BASE + " }}", changes, name)
            self.assertIn("HEAD: ${{ " + PR_HEAD + " }}", changes, name)
            # Three dots: from the merge base, so main's own movement since the fork is not "code changed".
            self.assertIn('git diff --name-only "$BASE...$HEAD"', changes, name)
            self.assertNotIn('git diff --name-only "$BASE" "$HEAD"', changes, name)
            # No merge base (a forced push onto unrelated history) builds rather than reading as docs-only.
            self.assertIn('git merge-base "$BASE" "$HEAD"', changes, name)


class ChangesStepSurvivesALongList(unittest.TestCase):
    """The `changes` step must not fail on a long file list (2026-10-01: PR #130's 679 files reddened CI).

    The step printed `echo "$changed" | head -50` under `set -euo pipefail`: with more than the pipe can hold, `head`
    exits after 50 lines, the `echo` writer dies of SIGPIPE (or `write error: Broken pipe`), pipefail makes the
    pipeline fail, set -e ends the step, and `build` is skipped -- the required check never runs. This runs each
    workflow's real `run:` block under `bash -eo pipefail` (the runner's own flags) with `git` stubbed to a 1,000-line
    diff of long paths, and asserts exit 0 and `code=true` in $GITHUB_OUTPUT.
    """

    LINES = 1000

    def _run_block(self, name):
        steps = _steps(_jobs(_text(name))["changes"])
        diff = [s for s in steps if re.search(r"^\s+id: diff\s*$", s, re.M)]
        self.assertEqual(len(diff), 1, name)
        _, run = _block(diff[0], "run", 8)
        self.assertTrue(run and run.strip(), name)
        return textwrap.dedent(run)

    def test_a_thousand_changed_files_still_build(self):
        if not BASH:
            self.skipTest("no bash")
        # The runner's shell ignores SIGPIPE (its log read `echo: write error: Broken pipe`); a default shell dies of it
        # (exit 141). Both are the same defect, so both are run.
        for name, sigpipe in [(n, t) for n in BUILD_WORKFLOWS for t in ("default", "ignored")]:
            with self.subTest(workflow=name, sigpipe=sigpipe), tempfile.TemporaryDirectory() as tmp:
                # Everything goes in the script (no env, no absolute path): the same under Git Bash and Linux bash.
                stub = "\n".join([
                    "export EVENT=push BASE=1111111111111111111111111111111111111111 HEAD=2222222222222222222222222222222222222222",
                    "export GITHUB_OUTPUT=out.txt",
                    "trap '' PIPE" if sigpipe == "ignored" else "",
                    "git() {",
                    '  case "$1" in',
                    "    cat-file|merge-base) return 0 ;;",
                    f"    diff) for i in $(seq 1 {self.LINES}); do printf 'src/%0200d/file_%d.cpp\n' \"$i\" \"$i\"; done ;;",
                    "    *) return 2 ;;",
                    "  esac",
                    "}",
                    "",
                ])
                script = os.path.join(tmp, "step.sh")
                with open(script, "w", encoding="utf-8", newline="\n") as f:
                    f.write(stub + self._run_block(name))
                r = subprocess.run([BASH, "--noprofile", "--norc", "-eo", "pipefail", "step.sh"], cwd=tmp,
                                   capture_output=True, text=True, timeout=120)
                self.assertEqual(r.returncode, 0, f"{name}: exit {r.returncode}\n{r.stderr[-2000:]}")
                with open(os.path.join(tmp, "out.txt"), encoding="utf-8") as f:
                    self.assertIn("code=true", f.read().splitlines(), name)
                self.assertIn(str(self.LINES), r.stdout, f"{name}: the total count is not printed")
                self.assertEqual(r.stdout.count("/file_"), 50, f"{name}: not exactly the first 50 listed")


class DocsWorkflowChecksDocsOnlyPushes(unittest.TestCase):
    """Fix round 1: the doc tests read the real docs/ tree and ran only inside the builds a docs push skips."""

    def test_docs_workflow_runs_the_doc_checks_on_docs_pushes(self):
        self.assertTrue(os.path.exists(os.path.join(WF, "docs.yml")), "no .github/workflows/docs.yml")
        text = _text("docs.yml")
        _, on = _block(text, "on", 0)
        _, push = _block(on, "push", 2)
        self.assertRegex(push or "", r"paths:\s*\n(\s*- .*\n)*?\s*- '?docs/\*\*'?", "docs.yml: push must name docs/**")
        self.assertIsNotNone(_block(on, "pull_request", 2)[0], "docs.yml: no pull_request trigger")
        self.assertIn("python -m tools_py.docmaint", text)
        for mod in ("test_doc_maintenance", "test_tools_py_inventory", "test_workflows"):
            self.assertIn("tools_py.tests." + mod, text, mod)

    def test_docs_job_is_not_a_required_check(self):
        jobs = _jobs(_text("docs.yml"))
        self.assertEqual(list(jobs), ["docs"])
        self.assertNotIn("docs", REQUIRED_CHECKS)


class RequiredChecksKeepTheirNames(unittest.TestCase):
    def test_each_required_check_is_a_job_with_no_renaming_name(self):
        for check, wf in REQUIRED_CHECKS.items():
            jobs = _jobs(_text(wf))
            self.assertIn(check, jobs, f"{wf}: the required check `{check}` is gone")
            # A job-level `name:` (four spaces) would become the check-run name and break the ruleset.
            self.assertNotRegex(jobs[check], r"(?m)^    name:", f"{wf}: `{check}` renamed by a job-level name:")

    def test_build_jobs_still_gate_on_changes(self):
        for name, build in BUILD_WORKFLOWS.items():
            body = _jobs(_text(name))[build]
            self.assertRegex(body, r"(?m)^    needs: changes\s*$", name)
            self.assertRegex(body, r"(?m)^    if: needs\.changes\.outputs\.code == 'true'\s*$", name)


SYNTHETIC = os.path.join(ROOT, "tests", "fixtures", "synthetic_recomp")
SYNTHETIC_SCRIPT = "scripts/build_synthetic_runner.sh"
# The job's own tree, built a step earlier with no generated code: only the runner's sources compile on top.
SYNTHETIC_TREE = {"linux.yml": "third_party/ps2recomp/build-linux", "windows.yml": "third_party/ps2recomp/build-clang"}
# The files only the runner compiles, the reason the step exists (the 2026-09-25 audit, code-runtime.md F7).
RUNNER_ONLY = ("game_overrides_socom2.cpp", "socom2_crypto.cpp")
GAME_TEXT_START = 0x180000  # the game's text starts at 0x180008; the synthetic program lives below it


def _steps(job_body):
    """A job body's steps as text blocks, each starting at its `      - ` line."""
    steps, cur = [], None
    for line in job_body.splitlines():
        if line.startswith("      - "):
            cur = [line]
            steps.append(cur)
        elif cur is not None and (line.startswith("        ") or not line.strip()):
            cur.append(line)
        elif line.startswith("      #"):
            continue
        else:
            cur = None
    return ["\n".join(s) for s in steps]


class RunnerLinksAgainstASyntheticSet(unittest.TestCase):
    """Sprint 13 Task C1: every code push compiles the game's own files and links the runner (audit F7, F41)."""

    def _step(self, name):
        body = _jobs(_text(name))[BUILD_WORKFLOWS[name]]
        steps = _steps(body)
        hits = [i for i, s in enumerate(steps) if SYNTHETIC_SCRIPT in s]
        self.assertEqual(len(hits), 1, f"{name}: the build job must run {SYNTHETIC_SCRIPT} exactly once")
        return steps, hits[0]

    def test_each_build_job_runs_the_synthetic_link(self):
        for name in BUILD_WORKFLOWS:
            steps, i = self._step(name)
            step = steps[i]
            first = step.splitlines()[0]
            for f in RUNNER_ONLY:
                self.assertIn(f, first, f"{name}: the step's name must say it compiles {f}")
            self.assertIn(f"--build-dir {SYNTHETIC_TREE[name]}", step,
                          f"{name}: reuse the job's own tree ({SYNTHETIC_TREE[name]}), not a second cold build")
            # After the no-runner build (`id: build`): the tree it reuses has the library already.
            build = [j for j, s in enumerate(steps) if re.search(r"(?m)^        id: build\s*$", s)]
            self.assertEqual(len(build), 1, f"{name}: the no-runner build step needs `id: build`")
            self.assertIn("--no-runner", steps[build[0]], name)
            self.assertLess(build[0], i, f"{name}: the synthetic link must follow the no-runner build")
            # It runs even when the suite failed (both verdicts), never when the build itself failed or was cancelled.
            self.assertRegex(step, r"if: \$\{\{ !cancelled\(\) && steps\.build\.outcome == 'success' \}\}", name)

    def test_the_runner_target_compiles_the_two_files(self):
        with open(os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRuntime", "CMakeLists.txt"),
                  encoding="utf-8") as f:
            cmake = f.read()
        for name in RUNNER_ONLY:
            self.assertIn(f"target_sources(ps2EntryRunner PRIVATE src/lib/{name})", cmake, name)

    def test_the_script_points_the_runner_at_the_synthetic_set(self):
        with open(os.path.join(ROOT, SYNTHETIC_SCRIPT), encoding="utf-8") as f:
            script = f.read()
        self.assertIn('SYN="$ROOT/tests/fixtures/synthetic_recomp"', script)
        self.assertIn('-DPS2X_RUNNER_GENERATED_DIR="$SYN"', script)
        self.assertIn("--target ps2EntryRunner", script)
        self.assertIn('"$rc" -ne 68', script, "the smoke must require the preflight's elf-missing exit")
        code = "\n".join(l for l in script.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotRegex(code, r"\bdist(-linux)?\b", "the synthetic runner is not a game; never into dist/")


class SyntheticGeneratedSetShape(unittest.TestCase):
    """tests/fixtures/synthetic_recomp: three hand-written functions and the tables, in the recompiler's shape."""

    def _read(self, name):
        with open(os.path.join(SYNTHETIC, name), encoding="utf-8") as f:
            return f.read()

    def test_three_functions_and_the_tables(self):
        self.assertEqual(sorted(os.listdir(SYNTHETIC)), sorted([
            "entry_0x100000.cpp", "sub_00100020_0x100020.cpp", "rand_0x100030.cpp", "register_functions.cpp",
            "ps2_recompiled_functions.h", "ps2_recompiled_stubs.h"]))

    def test_declared_defined_and_tabled_agree(self):
        decl = re.compile(r"(?m)^void (\w+_0x([0-9a-f]+))\(uint8_t\* rdram, R5900Context\* ctx, PS2Runtime ?\* ?runtime\);")
        declared = {}
        for h in ("ps2_recompiled_functions.h", "ps2_recompiled_stubs.h"):
            for m in decl.finditer(self._read(h)):
                declared[m.group(1)] = int(m.group(2), 16)
        self.assertEqual(len(declared), 3, declared)
        for fn in declared:
            body = self._read(fn + ".cpp")
            self.assertRegex(body, r"(?m)^void " + fn + r"\(uint8_t\* rdram, R5900Context\* ctx, PS2Runtime \*runtime\) \{")
        reg = self._read("register_functions.cpp")
        base = int(re.search(r"g_ps2RecompiledFunctionTableBase = 0x([0-9a-f]+)u;", reg).group(1), 16)
        end = int(re.search(r"g_ps2RecompiledFunctionTableEnd = 0x([0-9a-f]+)u;", reg).group(1), 16)
        count = int(re.search(r"g_ps2RecompiledFunctionTableSlotCount = (\d+)u;", reg).group(1))
        self.assertEqual(count, (end - base) >> 2)
        self.assertIn(f"g_ps2RecompiledFunctionTable[{count}u] = {{}};", reg)
        rows = re.findall(r"g_ps2RecompiledFunctionTable\[(\d+)\] = (\w+); // 0x([0-9a-f]+)", reg)
        self.assertTrue(rows)
        self.assertEqual({fn for _, fn, _ in rows}, set(declared), "every function tabled, nothing else")
        for slot, fn, addr in rows:
            self.assertLess(int(slot), count)
            self.assertEqual(int(addr, 16), base + 4 * int(slot), f"slot {slot}'s comment")
            self.assertGreaterEqual(int(addr, 16), declared[fn], f"{fn} owns 0x{addr} only from its own start")
        for fn, start in declared.items():
            self.assertEqual(dict((f, a) for _, f, a in rows if int(a, 16) == start).get(fn), f"{start:x}",
                             f"{fn}'s own address is its slot")

    @staticmethod
    def _preamble(text):
        """A generated file's lines before its first comment: the includes and the declarations the emitter writes."""
        lines = []
        for line in text.splitlines():
            if line.startswith("// "):
                break
            lines.append(line)
        return lines

    def test_each_function_file_carries_the_preamble_the_emitter_writes_today(self):
        # Issue #57: a function file declares only the functions it tail-calls by name, and includes neither
        # generated header. recomp_ref/expected is the emitter's own output (the recomp-ref job diffs it on every
        # code push); none of its function files calls by name, and neither do these two, so the preambles are equal.
        expected = os.path.join(RECOMP_REF, "expected")
        def read(path):
            with open(path, encoding="utf-8") as f:
                return f.read()
        emitted = {tuple(self._preamble(read(os.path.join(expected, n))))
                   for n in os.listdir(expected) if re.search(r"_0x[0-9a-f]+\.cpp$", n)}
        self.assertEqual(len(emitted), 1, "recomp_ref's function files disagree on their preamble")
        emitter = read(os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRecomp", "src", "lib",
                                     "function_emitter.cpp"))
        written = "".join(re.findall(r'file << "((?:[^"\\]|\\.)*)";', emitter)).encode().decode("unicode_escape")
        (preamble,) = emitted
        self.assertTrue(written.startswith("\n".join(preamble)), "the emitter's preamble moved: regenerate expected/")
        for name in ("entry_0x100000.cpp", "sub_00100020_0x100020.cpp"):
            self.assertEqual(self._preamble(self._read(name)), list(preamble), f"{name}: not the emitter's preamble")

    def test_nothing_at_the_games_addresses(self):
        # Hand-written, never copied from recomp/output: nothing at or above the game's text (0x180008 up).
        for name in os.listdir(SYNTHETIC):
            # Every address, not the instruction words the comments print after one (`// 0x100000: 0x27bdfff0`).
            for m in re.finditer(r"(?<!: )0x([0-9a-fA-F]{5,8})", self._read(name)):
                self.assertLess(int(m.group(1), 16), GAME_TEXT_START, f"{name}: {m.group(0)} is in the game's range")


RECOMP_REF = os.path.join(ROOT, "tests", "fixtures", "recomp_ref")
RECOMP_REF_JOB = "recomp-ref"
RECOMP_REF_INPUTS = ("input.elf", "functions.csv", "names.csv", "recomp_ref.toml")


class RecompilerReferenceJob(unittest.TestCase):
    """Sprint 14 Task E3: the recompiler re-derives a synthetic ELF's output on every code push, diffed to a reference."""

    def _job(self):
        jobs = _jobs(_text("linux.yml"))
        self.assertIn(RECOMP_REF_JOB, jobs, "linux.yml: no recomp-ref job")
        return jobs[RECOMP_REF_JOB]

    def test_its_own_job_gated_on_changes(self):
        body = self._job()
        self.assertRegex(body, r"(?m)^    runs-on: ubuntu-24\.04\s*$")
        self.assertRegex(body, r"(?m)^    needs: changes\s*$")
        self.assertRegex(body, r"(?m)^    if: needs\.changes\.outputs\.code == 'true'\s*$")
        self.assertNotIn(RECOMP_REF_JOB, REQUIRED_CHECKS, "not a required check (a ruleset change is the owner's)")

    def test_builds_only_the_recompiler(self):
        code = "\n".join(l for l in self._job().splitlines() if not l.lstrip().startswith("#"))
        self.assertEqual(re.findall(r"--target\s+(\S+)", code), ["ps2_recomp"], "only the ps2_recomp target")
        for off in ("RUNTIME", "ANALYZER", "TEST"):
            self.assertIn(f"-DPS2X_BUILD_{off}=OFF", code, f"configure without {off}")
        self.assertNotIn("build_linux.sh", code, "not the runtime build")

    def test_runs_the_fixture_and_diffs_the_reference(self):
        code = "\n".join(l for l in self._job().splitlines() if not l.lstrip().startswith("#"))
        self.assertIn("tests/fixtures/recomp_ref", code)
        self.assertRegex(code, r"ps2xRecomp/ps2_recomp\"? recomp_ref\.toml", "run on the fixture's toml")
        self.assertRegex(code, r"diff -r \S+ \"?\$GITHUB_WORKSPACE/tests/fixtures/recomp_ref/expected\"?",
                         "diff -r the output against expected/")
        self.assertIn("set -euo pipefail", code)

    def test_drift_fails_the_diff_step(self):
        steps = [s for s in _steps(self._job()) if "diff -r" in s]
        self.assertEqual(len(steps), 1, "one step runs the diff")
        self.assertEqual(drift_step_problems(steps[0]), [])

    def test_the_drift_check_rejects_planted_steps(self):
        good = [s for s in _steps(self._job()) if "diff -r" in s][0]
        plants = {
            "no set -euo pipefail": good.replace("set -euo pipefail", "set -u"),
            "`|| true` after the diff": good.replace('/expected"; then', '/expected" || true; then'),
            "no `exit 1` in the `if !` branch": good.replace("exit 1", "exit 0"),
            "diff not under `if !`": good.replace("if ! diff -r", "if diff -r"),
        }
        for what, step in plants.items():
            self.assertNotEqual(step, good, f"the plant did not apply: {what}")
            self.assertTrue(drift_step_problems(step), f"planted {what} passed")


def drift_step_problems(step):
    """What keeps a drift from failing the recomp-ref diff step: [] when `diff -r` failing fails the step."""
    code = "\n".join(l for l in step.splitlines() if not l.lstrip().startswith("#"))
    problems = []
    if not re.search(r"(?m)^\s*set -euo pipefail\s*$", code):
        problems.append("the step's script does not start with set -euo pipefail")
    m = re.search(r"(?m)^(\s*)if ! diff -r [^\n]*/tests/fixtures/recomp_ref/expected\"?; then\s*$", code)
    if not m:
        problems.append("the diff is not the condition of `if ! diff -r ... expected; then` (or has `|| true`)")
    else:
        branch = code[m.end():].split("\n" + m.group(1) + "fi", 1)[0]
        if not re.search(r"(?m)^\s*exit 1\s*$", branch):
            problems.append("the `if !` branch does not `exit 1`")
    if re.search(r"diff -r[^\n]*\|\|", code):
        problems.append("`||` after the diff swallows its status")
    return problems


class RecompilerReferenceFixture(unittest.TestCase):
    """tests/fixtures/recomp_ref: synthetic inputs (its make_fixture.py) and the recompiler's output."""

    def _read(self, *parts):
        with open(os.path.join(RECOMP_REF, *parts), "rb") as f:
            return f.read()

    def test_the_generator_reproduces_the_inputs(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("make_fixture", os.path.join(RECOMP_REF, "make_fixture.py"))
        make_fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(make_fixture)
        made = make_fixture.inputs()
        self.assertEqual(sorted(made), sorted(RECOMP_REF_INPUTS))
        self.assertEqual(made["input.elf"], self._read("input.elf"), "input.elf is the generator's bytes")
        for name in RECOMP_REF_INPUTS[1:]:
            # A Windows checkout (core.autocrlf) may carry CRLF; the blob is the generator's LF text.
            self.assertEqual(made[name], self._read(name).replace(b"\r\n", b"\n"), name)

    def test_synthetic_and_small(self):
        elf = self._read("input.elf")
        self.assertEqual(elf[:4], b"\x7fELF")
        self.assertLess(len(elf), 8192, "a few KB, no disc bytes")
        toml = self._read("recomp_ref.toml").decode()
        for key in ("input", "ghidra_output", "names", "output"):
            value = re.search(r'(?m)^' + key + r' = "([^"]*)"', toml).group(1)
            self.assertFalse(os.path.isabs(value) or ".." in value or ":" in value,
                             f"{key} = {value!r}: relative to the fixture directory, never the game")

    def test_expected_is_path_and_date_free(self):
        expected = os.path.join(RECOMP_REF, "expected")
        names = sorted(os.listdir(expected))
        self.assertIn("register_functions.cpp", names)
        self.assertIn("sceVu0MulMatrix_0x100010.cpp", names, "the sidecar name reached the output")
        for name in names:
            text = self._read("expected", name).decode("utf-8")
            self.assertNotRegex(text, r"[A-Za-z]:[\\/]|/c/|/home/|/tmp/|\\Users\\", f"{name}: an absolute path")
            self.assertNotRegex(text, r"\b20\d\d-\d\d-\d\d\b|\b\d\d:\d\d:\d\d\b", f"{name}: a date or a time")
            for m in re.finditer(r"(?<!: )0x([0-9a-fA-F]{5,8})", text):
                self.assertLess(int(m.group(1), 16), GAME_TEXT_START, f"{name}: {m.group(0)} is in the game's range")

    def test_expected_is_lf_in_the_index(self):
        # The Linux job's recompiler writes LF; a Windows one writes CRLF (text-mode streams), which core.autocrlf
        # turns into LF on add. A CRLF blob would fail the job on every push, so the index must say lf.
        import subprocess
        try:
            out = subprocess.run(["git", "ls-files", "--eol", "--", "tests/fixtures/recomp_ref/expected"], cwd=ROOT,
                                 capture_output=True, text=True, check=True).stdout
        except (OSError, subprocess.CalledProcessError) as e:
            self.skipTest(f"no git here ({e})")
        rows = [l for l in out.splitlines() if l.strip()]
        if not rows:
            self.skipTest("expected/ not in the index (an uncommitted tree)")
        for row in rows:
            self.assertTrue(row.startswith("i/lf "), f"a CRLF or binary blob in expected/: {row}")


class WithPyYAML(unittest.TestCase):
    """The same facts through a real parser, where one is installed (the owner's machine has 6.0.3)."""

    def setUp(self):
        try:
            import yaml  # noqa: F401
        except ImportError:
            self.skipTest("PyYAML not installed; the text-level classes above carry the checks")

    def test_parsed(self):
        import yaml
        for name, build in BUILD_WORKFLOWS.items():
            doc = yaml.safe_load(_text(name))
            on = doc.get("on", doc.get(True))  # PyYAML reads a bare `on:` key as True
            self.assertEqual((on["push"] or {}).get("paths-ignore"), ["docs/**"], name)
            self.assertFalse(on.get("pull_request") and {"paths", "paths-ignore"} & set(on["pull_request"]), name)
            env = doc["jobs"]["changes"]["steps"][1]["env"]
            self.assertEqual(env["BASE"], "${{ " + PR_BASE + " }}", name)
            self.assertEqual(env["HEAD"], "${{ " + PR_HEAD + " }}", name)
            self.assertEqual(doc["jobs"][build]["needs"], "changes", name)
            self.assertNotIn("name", doc["jobs"][build], name)
            runs = [s for s in doc["jobs"][build]["steps"] if SYNTHETIC_SCRIPT in (s.get("run") or "")]
            self.assertEqual(len(runs), 1, name)
            self.assertIn(f"--build-dir {SYNTHETIC_TREE[name]}", runs[0]["run"], name)
            self.assertEqual(runs[0]["if"], "${{ !cancelled() && steps.build.outcome == 'success' }}", name)
        for check, wf in REQUIRED_CHECKS.items():
            jobs = yaml.safe_load(_text(wf))["jobs"]
            self.assertIn(check, jobs, wf)
            self.assertNotIn("name", jobs[check], wf)


if __name__ == "__main__":
    unittest.main()
