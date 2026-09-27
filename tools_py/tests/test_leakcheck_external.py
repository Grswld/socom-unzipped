"""The leak gate's sixth leg: the site's and the monitor's own scanners, called from here (Sprint 11 Task 12).

Three repositories publish from this machine -- this one, `../scotho` (scotho.com and socomunzipped.com) and
`../socom_monitor` (the built snapshot). Each has its own scanner, and until now each
was run by hand, which means each was run when someone remembered. `leakcheck external` calls the other two.

The thing these tests exist to hold down is the third exit state. A scanner that is not there did not run, and
"did not run" is not "found nothing": the run that matters is the one on a machine where the sibling repository
is missing, because that is CI, and a gate that prints green there would be worse than no gate. So:

  * a sibling that is simply absent  -> SKIPPED, exit 0 on its own, exit 2 under `--require`, and the word
    "clean" is never printed for it;
  * a sibling that is there and whose scanner could not scan -> exit 2 whatever the flags say;
  * a sibling that found something -> exit 1, with the finding in our own `--json` report, masked.

No test here touches the real `../scotho` or `../socom_monitor`: every sibling is a temp directory holding a
scanner that does exactly one thing, passed in with `--siblings-root`. The one that pretends to be the site is
JavaScript because the real one is; it is skipped where there is no node.
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

from tools_py.release import leakcheck as L

NODE = shutil.which("node")
TOKEN = "AKIAQ2W3E4R5T6Y7U8I9"          # invented; the shape the site's scanner masks and the monitor's does not

# The site's scanner, as `leakcheck external` calls it: `node scripts/check-secrets.mjs --json`, one object on
# stdout, excerpts already masked, exit 0/1/2 with the same three meanings as ours.
FAKE_SITE = """\
const report = {
  tool: 'check-secrets',
  target: ['dist', 'sites/s2u/dist'],
  scanned: { files: 3, bytes: 120 },
  self_test: { planted: 12, caught: 12, failures: [] },
  findings: [{ rule: 'vendor-token', file: 'dist/app.js', line: 7,
               excerpt_masked: 'AKIA...I9 (20 chars)', severity: 'critical' }],
  exit: %d,
};
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report) + '\\n');
process.exit(report.exit);
"""

# The monitor's scanner: no --json, no control of its own, its paths relative to the directory it was given,
# and its terminal lines carrying the matched text UNMASKED (`path:line: rule: text`). Masking it, and putting
# the directory back in front of the path, is this end's job.
FAKE_MONITOR = """\
import os, sys
out = sys.argv[1]
if not os.path.isdir(out):
    print("leakcheck: not a directory: %%s" %% out, file=sys.stderr)
    sys.exit(2)
print("leakcheck: 2 files (2 text, 0 binary), 9 lines, 120 bytes")
if %(code)d == 2:
    print("leakcheck: nothing to check -- did the build run?", file=sys.stderr)
    sys.exit(2)
print("index.html:12: vendor-token: %(token)s", file=sys.stderr)
print("runs/7.html: (file name): key-file-name: id_rsa", file=sys.stderr)
print("leakcheck: FAILED -- 2 hits in 2 files. Do not publish.", file=sys.stderr)
sys.exit(1)
"""


def write(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)


class ExternalMode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leakext_")
        self.json = os.path.join(self.tmp, "report.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- the fake siblings ---------------------------------------------------------------------

    def site(self, code=1):
        write(os.path.join(self.tmp, "scotho", "scripts", "check-secrets.mjs"), FAKE_SITE % code)

    def monitor(self, code=1, built=True):
        write(os.path.join(self.tmp, "socom_monitor", "leakcheck.py"),
              FAKE_MONITOR % {"code": code, "token": TOKEN})
        if built:
            os.makedirs(os.path.join(self.tmp, "socom_monitor", "out", "site"), exist_ok=True)

    def run_mode(self, *args, **kw):
        """(exit code, stdout, stderr, the JSON report)."""
        argv = ["external", "--siblings-root", kw.pop("root", self.tmp), "--allow", os.devnull,
                "--json", self.json] + list(args)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = L.main(argv)
        with open(self.json, encoding="utf-8") as fh:
            return code, out.getvalue(), err.getvalue(), json.load(fh)

    def entry(self, rep, tool):
        got = [e for e in rep["external"] if e["tool"] == tool]
        self.assertEqual(len(got), 1, f"{tool} not in {[e['tool'] for e in rep['external']]}")
        return got[0]

    # -- a sibling that finds something --------------------------------------------------------

    @unittest.skipUnless(NODE, "no node on this machine: the site's scanner cannot be run")
    def test_a_sibling_s_finding_fails_the_mode_and_reaches_our_json(self):
        self.site(code=1)
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 1)
        site = self.entry(rep, "check-secrets")
        self.assertEqual((site["state"], site["exit"], site["repo"]), ("findings", 1, "scotho"))
        self.assertEqual(site["self_test"], {"planted": 12, "caught": 12, "failures": []})
        found = [f for f in rep["findings"] if f["tool"] == "check-secrets"]
        self.assertEqual(len(found), 1)
        self.assertEqual((found[0]["rule"], found[0]["file"], found[0]["line"], found[0]["severity"]),
                         ("vendor-token", "scotho/dist/app.js", 7, "critical"))
        self.assertEqual(found[0]["excerpt_masked"], "AKIA...I9 (20 chars)")
        self.assertIn("check-secrets", out)
        self.assertIn("scotho/dist/app.js:7", err)
        self.assertNotIn("-- clean", out)

    def test_the_monitor_s_unmasked_excerpt_is_masked_before_it_reaches_our_report(self):
        self.monitor(code=1)
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 1)
        mon = self.entry(rep, "monitor-leakcheck")
        self.assertEqual((mon["state"], mon["exit"], mon["repo"]), ("findings", 1, "socom_monitor"))
        self.assertEqual(mon["scanned"], {"files": 2, "text_files": 2, "binary_files": 0,
                                          "lines": 9, "bytes": 120, "commits": 0})
        rules = [(f["file"], f["line"], f["rule"], f["excerpt_masked"]) for f in mon["findings"]]
        self.assertEqual(rules, [("socom_monitor/out/site/index.html", 12, "vendor-token", L.R.mask(TOKEN)),
                                 ("socom_monitor/out/site/runs/7.html", 0, "key-file-name", L.R.mask("id_rsa"))])
        # the whole point: the sibling printed the token in clear, and nothing of ours repeats it
        blob = json.dumps(rep) + out + err
        self.assertNotIn("Q2W3E4R5", blob)
        self.assertNotIn(TOKEN, blob)
        # its scanner has no control of its own, so it reports none -- and says so rather than implying one
        self.assertNotIn("self_test", mon)
        self.assertIn("no control of its own", out)

    # -- a sibling that is not there -----------------------------------------------------------

    def test_a_missing_sibling_with_require_is_exit_2_and_its_entry_has_no_self_test(self):
        code, out, err, rep = self.run_mode("--require")
        self.assertEqual(code, 2)
        self.assertEqual(rep["exit"], 2)
        for tool in ("check-secrets", "monitor-leakcheck"):
            e = self.entry(rep, tool)
            self.assertEqual((e["state"], e["skipped"], e["exit"]), ("not_run", True, 2))
            self.assertNotIn("self_test", e, f"{tool} did not run; it cannot report a control")
            self.assertEqual(e["findings"], [])
            self.assertTrue(e["reason"])
        self.assertIn("did not run", err)
        self.assertNotIn("-- clean", out)

    def test_a_missing_sibling_without_require_prints_SKIPPED_and_never_prints_clean(self):
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 0)
        self.assertIn("SKIPPED", out)
        self.assertIn("scotho", out)
        self.assertIn("socom_monitor", out)
        self.assertNotIn("-- clean", out)                 # 0 hits, but nothing was scanned: not a clean result
        self.assertIn("DID NOT RUN", out)
        self.assertEqual(rep["findings"], [])
        self.assertEqual([e["state"] for e in rep["external"]], ["not_run", "not_run"])

    def test_the_planted_control_still_runs_first(self):
        for args in ([], ["--require"]):
            with self.subTest(args=args):
                _code, _out, _err, rep = self.run_mode(*args)
                st = rep["self_test"]
                self.assertEqual(st["missed"], [])
                self.assertEqual(st["caught"], st["planted"])
                self.assertGreater(st["planted"], 20)

    # -- a sibling that is there and could not scan --------------------------------------------

    def test_a_present_scanner_that_could_not_run_is_exit_2_even_without_require(self):
        self.monitor(code=2)                      # built, but its own gate says it has nothing to check
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 2)
        mon = self.entry(rep, "monitor-leakcheck")
        self.assertEqual((mon["state"], mon["skipped"], mon["exit"]), ("not_run", False, 2))
        self.assertIn("did not run", err)
        self.assertNotIn("-- clean", out)

    def test_the_monitor_without_a_built_snapshot_is_skipped_not_clean(self):
        self.monitor(code=1, built=False)         # the repository is there; build.py has not run
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 0)
        mon = self.entry(rep, "monitor-leakcheck")
        self.assertEqual((mon["state"], mon["skipped"]), ("not_run", True))
        self.assertIn("out/site", mon["reason"])
        self.assertIn("SKIPPED", out)
        self.assertEqual(L.main(["external", "--siblings-root", self.tmp, "--allow", os.devnull, "--require"]), 2)

    def test_a_sibling_that_exits_0_with_output_we_cannot_read_is_not_clean(self):
        """The failure mode a text-parsed sibling has and a JSON one does not: its scanner is fine, its wording
        changed, and every line this end reads as a finding is gone. Exit 0 and nothing parsed is not "clean" --
        it is "nothing is known about what it scanned", which is the third state."""
        write(os.path.join(self.tmp, "socom_monitor", "leakcheck.py"),
              'import os, sys\n'
              'sys.exit(2) if not os.path.isdir(sys.argv[1]) else None\n'
              'print("scanned the site; all good")\n')
        os.makedirs(os.path.join(self.tmp, "socom_monitor", "out", "site"), exist_ok=True)
        code, out, err, rep = self.run_mode()
        mon = self.entry(rep, "monitor-leakcheck")
        self.assertEqual((mon["state"], mon["exit"], mon["findings"]), ("not_run", 2, []))
        self.assertEqual(mon["scanned"]["files"], 0)
        self.assertIn("not parseable", mon["reason"])
        self.assertNotIn("CLEAN", out)
        self.assertNotIn("-- clean", out)
        # it is there and it could not be scanned, so it is exit 2 with the flag and without it
        self.assertEqual(code, 2)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(L.main(["external", "--siblings-root", self.tmp, "--allow", os.devnull,
                                     "--require"]), 2)

    def test_a_clean_sibling_says_clean_and_exits_0(self):
        self.monitor(code=0)
        # a scanner that exits 0 with nothing on stderr: the only shape that may print "clean"
        write(os.path.join(self.tmp, "socom_monitor", "leakcheck.py"),
              'import os, sys\n'
              'sys.exit(2) if not os.path.isdir(sys.argv[1]) else None\n'
              'print("leakcheck: 4 files (4 text, 0 binary), 20 lines, 400 bytes")\n'
              'print("leakcheck: 0 hits -- clean")\n')
        code, out, err, rep = self.run_mode()
        self.assertEqual(code, 0)
        mon = self.entry(rep, "monitor-leakcheck")
        self.assertEqual((mon["state"], mon["exit"], mon["findings"]), ("clean", 0, []))
        self.assertEqual(mon["scanned"]["files"], 4)
        self.assertIn("SKIPPED", out)              # the site is still absent, and still says so

    # -- the plumbing ---------------------------------------------------------------------------

    def test_the_siblings_root_comes_from_the_environment_too(self):
        self.monitor(code=1)
        old = os.environ.get(L.SIBLINGS_ENV)
        os.environ[L.SIBLINGS_ENV] = self.tmp
        try:
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = L.main(["external", "--allow", os.devnull, "--json", self.json])
            self.assertEqual(code, 1)
            with open(self.json, encoding="utf-8") as fh:
                rep = json.load(fh)
            self.assertEqual(self.entry(rep, "monitor-leakcheck")["state"], "findings")
        finally:
            os.environ.pop(L.SIBLINGS_ENV, None)
            if old is not None:
                os.environ[L.SIBLINGS_ENV] = old

    def test_no_absolute_path_of_this_machine_reaches_the_report(self):
        """The report is the thing most likely to be pasted. A sibling is named by its directory, never by
        where it happens to live on someone's disk."""
        self.monitor(code=1)
        _code, out, err, rep = self.run_mode()
        blob = json.dumps(rep)
        self.assertNotIn(self.tmp.replace("\\", "\\\\"), blob)
        self.assertNotIn(self.tmp.replace("\\", "/"), blob)
        self.assertNotIn(os.path.dirname(L.ROOT).replace("\\", "\\\\"), blob)


class TheModeIsWiredIn(unittest.TestCase):
    def test_all_runs_external_and_external_is_a_mode(self):
        self.assertIn("external", L.MODES)
        self.assertIn("external", L.ALL_MODES)
        self.assertEqual(L.ALL_MODES[-1], "external")     # last: the four local modes are the cheap ones

    def test_ci_never_passes_require_so_a_runner_without_the_siblings_stays_green(self):
        for rel in (".github/workflows/secrets.yml", ".github/workflows/release-draft.yml"):
            path = os.path.join(L.ROOT, rel)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            calls = [ln for ln in text.splitlines() if "tools_py.release.leakcheck" in ln]
            with self.subTest(rel=rel):
                self.assertTrue(any("leakcheck all" in ln for ln in calls), calls)
                for ln in calls:          # a comment may name the flag; no invocation may pass it
                    self.assertNotIn("--require", ln, ln)

    def test_the_two_siblings_are_named_and_neither_is_an_absolute_path(self):
        self.assertEqual([s["dir"] for s in L.EXTERNALS], ["scotho", "socom_monitor"])
        for spec in L.EXTERNALS:
            with self.subTest(dir=spec["dir"]):
                self.assertFalse(os.path.isabs(spec["dir"]))
                self.assertTrue(spec["tool"] and spec["target"])

    def test_the_documentation_says_what_exit_2_means_here(self):
        for rel in ("CONTRIBUTING.md", "docs/DEVELOPING.md"):
            with open(os.path.join(L.ROOT, rel), encoding="utf-8") as fh:
                text = fh.read()
            with self.subTest(rel=rel):
                self.assertIn("external", text)


if __name__ == "__main__":
    unittest.main()
