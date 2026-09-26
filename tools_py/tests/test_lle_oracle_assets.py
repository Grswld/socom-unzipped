"""Sprint 15 Task T1c: the LLE-oracle harness landed under docs/research/assets/70-lle-oracle/ (research/70 §6).

The owner adopted #254's LLE IOP as an out-of-tree oracle (2026-09-26); what enters the tree is our glue, the patch
to the fork's slice and the result tables -- none of the fork's files, nothing of the disc and no machine's paths.
This pins that: every landed file exists; the README names the fork commit and the three numbers of 2026-09-26, each
with a backticked command; no file under the directory carries an absolute Windows or MSYS path or a run of 24 or
more hex digits (the shape a disc's bytes take); and the patch's `diff --git` lines name only the fork's
`ps2xIOP/src/lle/` files, none of them a path of our own tree.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "docs", "research", "assets", "70-lle-oracle")

FILES = (
    "README.md",
    "harness_lle.cpp",
    "CMakeLists.txt",
    "build.sh",
    "replay_lle.py",
    "oracle-patch.diff",
    "build-record.txt",
    "results_lle_run_20260922_232655.md",
    "results_lle_run_20260922_150258.md",
    "results_lle_run_20260922_232655_noprovider.md",
    "replay_lle_run_20260922_232655.out",
    "replay_lle_run_20260922_150258.out",
)
FORK_COMMIT = "e42efbe"
FORK = "Sinan-Karakaya/PS2Recomp"
# The three numbers of 2026-09-26 (research/70 §9) and the words that tell them apart.
NUMBERS = ("832", "13,044", "17", "1,794", "12,619")
FORBIDDEN = (
    ("an absolute Windows path", re.compile(r"(?<![A-Za-z])[A-Za-z]:[/\\]")),  # a drive letter, not https:
    # An MSYS drive path (/c/..., /d/...): a single letter between slashes at the start of a path. The fork's own
    # repo-relative paths (a/ps2xIOP/src/lle/..., ps2xIOP/src/lle/) have no leading slash before the letter.
    ("an MSYS drive path", re.compile(r"(?<![A-Za-z0-9_.])/[A-Za-z]/")),
    ("an MSYS home path", re.compile(r"/c/Users", re.IGNORECASE)),
    ("a run of 24+ hex digits", re.compile(r"[0-9A-Fa-f]{24,}")),
)
DIFF_GIT = re.compile(r"^diff --git a/(\S+) b/(\S+)$")
# Every file header, git-form or a bare `diff -u` one: a hunk's target is named here whatever precedes it.
FILE_HEADER = re.compile(r"^(---|\+\+\+) (\S+)")
SLICE = "ps2xIOP/src/lle/"
# The top-level directories of our own tree: a patch path starting with one of them would be ours, not the fork's.
OUR_TOP = ("docs", "tools_py", "scripts", "ps2xRuntime", "recomp", "server", "tests", "game", "logs", "tools",
           "third_party", ".github", ".claude")


def read(name):
    with open(os.path.join(ASSETS, name), encoding="utf-8", errors="replace") as f:
        return f.read()


class LleOracleAssetsTest(unittest.TestCase):
    def test_every_file_is_landed(self):
        missing = [f for f in FILES if not os.path.isfile(os.path.join(ASSETS, f))]
        self.assertEqual(missing, [], "files missing under docs/research/assets/70-lle-oracle/")

    def test_no_fork_source_file_is_landed(self):
        self.assertTrue(os.path.isdir(ASSETS), ASSETS)
        landed = sorted(os.listdir(ASSETS))
        self.assertNotIn("lle", landed, "the fork's lle/ slice stays outside the tree (R287, research/70 §6)")
        self.assertEqual(sorted(set(landed) - set(FILES)), [], "a file the task does not name is landed")

    def test_readme_names_the_fork_commit(self):
        text = read("README.md")
        self.assertIn(FORK_COMMIT, text)
        self.assertIn(FORK, text)
        self.assertIn("GPL-3.0", text)

    def test_readme_numbers_carry_backticked_commands(self):
        text = read("README.md")
        for n in NUMBERS:
            self.assertIn(n, text, f"the README does not state {n}")
        commands = re.findall(r"`grep -m1 \"Compared answers\" docs/research/assets/70-lle-oracle/([\w.]+)`", text)
        self.assertGreaterEqual(len(set(commands)), 3, "each of the three numbers needs its own grep command")
        for name in commands:
            self.assertIn(name, FILES, f"the README's command reads {name}, which is not landed")
            self.assertIn("Compared answers", read(name))

    def test_readme_numbers_match_the_tables(self):
        want = {
            "results_lle_run_20260922_232655.md": (13044, 832),
            "results_lle_run_20260922_150258.md": (1794, 17),
            "results_lle_run_20260922_232655_noprovider.md": (13044, 12619),
        }
        for name, (compared, dis) in want.items():
            m = re.search(r"\*\*Compared answers: (\d+); disagreements: (\d+)\.\*\*", read(name))
            self.assertIsNotNone(m, name)
            self.assertEqual((int(m.group(1)), int(m.group(2))), (compared, dis), name)

    def test_build_record(self):
        text = read("build-record.txt")
        self.assertIn(FORK_COMMIT, text)
        self.assertIn("HARNESS EXIT 0", text)
        self.assertIn("2026-09-26", text)

    def test_no_machine_paths_or_hex_runs(self):
        hits = []
        for dirpath, _dirs, names in os.walk(ASSETS):
            for name in names:
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8", errors="replace") as f:
                    for lno, line in enumerate(f, 1):
                        for what, rx in FORBIDDEN:
                            if rx.search(line):
                                hits.append(f"{os.path.relpath(path, ROOT)}:{lno}: {what}")
        self.assertEqual(hits, [])

    def assert_forks_slice(self, p, line):
        self.assertTrue(p.startswith(SLICE), line)
        self.assertNotIn(p.split("/")[0], OUR_TOP, line)
        # Our tree vendors upstream's ps2xIOP under third_party/ps2recomp/; the fork's lle/ is in neither place.
        for base in (ROOT, os.path.join(ROOT, "third_party", "ps2recomp")):
            self.assertFalse(os.path.exists(os.path.join(base, p)), f"{p} is a path of our own tree")

    def test_patch_touches_only_the_forks_slice(self):
        lines = read("oracle-patch.diff").splitlines()
        paths = []
        for line in lines:
            m = DIFF_GIT.match(line)
            if m:
                self.assertEqual(m.group(1), m.group(2), line)
                paths.append(m.group(1))
        self.assertEqual(len(paths), 5, paths)
        for p in paths:
            self.assert_forks_slice(p, p)
        self.assertIn(SLICE + "kernel.cpp", paths)
        self.assertIn(SLICE + "spu2.cpp", paths)

    def test_every_file_header_names_the_forks_slice(self):
        # A header is a ---/+++ pair directly before a hunk; any line of that shape is read, so a bare `diff -u`
        # section (no `diff --git` line) cannot name a path past this test.
        lines = read("oracle-patch.diff").splitlines()
        headers = []
        for i, line in enumerate(lines):
            m = FILE_HEADER.match(line)
            if not m:
                continue
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            is_old = m.group(1) == "---" and nxt.startswith("+++ ")
            is_new = m.group(1) == "+++" and i > 0 and lines[i - 1].startswith("--- ")
            if not (is_old or is_new):
                continue  # a removed or added line of code, not a header
            want = "a/" if m.group(1) == "---" else "b/"
            self.assertTrue(m.group(2).startswith(want), f"not a git-form {want} header: {line}")
            headers.append(m.group(2)[2:])
            self.assert_forks_slice(m.group(2)[2:], line)
        self.assertEqual(len(headers), 10, headers)
        git_paths = [DIFF_GIT.match(l).group(1) for l in lines if DIFF_GIT.match(l)]
        self.assertEqual(sorted(set(headers)), sorted(git_paths))


if __name__ == "__main__":
    unittest.main()
