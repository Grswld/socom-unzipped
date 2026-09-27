"""Sprint 14 Task D5: PLAYTEST's build block, rendered from make_portable's manifest.

tools_py/playtest_block.py renders the text between `<!-- build:begin -->` and `<!-- build:end -->` in
docs/PLAYTEST.md from `dist/manifest.json` (every field of it), or **NOT BUILT** with the way to build when there
is no manifest; its CLI rewrites the block in place (idempotent) and `--check` exits 1 on a stale block. The
manifest itself is written by scripts/make_portable.sh; its Linux branch runs on any host with a synthetic
dist-linux/ (test_make_portable_linux.py), which is how the manifest is tested here without a build.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

from tools_py import playtest_block
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "make_portable.sh")

MANIFEST = {
    "archive": "socom2-portable.zip",
    "archive_path": "dist/portable/socom2-portable.zip",
    "archive_sha256": "a" * 64,
    "exe": "socom2.exe",
    "exe_sha256": "b" * 64,
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "branch": "sprint-14",
    "built_at": "2026-09-26T10:11:12Z",
    "tree_dirty": 0,
}

PAGE = """# The playtest

intro

<!-- build:begin -->
old text
<!-- build:end -->

**Not ready until the block above is filled.**
"""


class RenderTest(unittest.TestCase):
    def test_a_manifest_renders_every_field(self):
        block = playtest_block.render(MANIFEST, "2026-09-26")
        self.assertIn("socom2-portable.zip", block)
        self.assertIn("dist/portable/socom2-portable.zip", block)
        self.assertIn("a" * 64, block)
        self.assertIn("b" * 64, block)
        self.assertIn("socom2.exe", block)
        self.assertIn("0123456789ab", block)
        self.assertNotIn("0123456789abcdef0123456789abcdef01234567", block)   # the short commit, not the full one
        self.assertIn("sprint-14", block)
        self.assertIn("2026-09-26T10:11:12Z", block)
        self.assertNotIn("NOT BUILT", block)
        self.assertNotIn("dirty tree", block)
        # sitting.py (D3) shows the block's `build:`/`archive:` lines and any sha256 line
        self.assertRegex(block, r"(?m)^build:")
        self.assertRegex(block, r"(?m)^archive:")

    def test_a_two_archive_manifest_renders_both_with_their_kind(self):
        # Sprint 16 R3a (R295): one --release run packages the player and the developer archive
        two = dict(MANIFEST, kind="player", archive_path="dist-release/portable/socom2-portable.zip", archives=[
            {"kind": "player", "archive": "socom2-portable.zip",
             "archive_path": "dist-release/portable/socom2-portable.zip", "archive_sha256": "a" * 64,
             "exe": "socom2.exe", "exe_sha256": "b" * 64},
            {"kind": "developer", "archive": "socom2-developer.zip",
             "archive_path": "dist-release/portable/socom2-developer.zip", "archive_sha256": "c" * 64,
             "exe": "socom2.exe", "exe_sha256": "d" * 64}])
        block = playtest_block.render(two, "2026-09-26")
        for text in ("socom2-portable.zip", "socom2-developer.zip", "a" * 64, "b" * 64, "c" * 64, "d" * 64,
                     "player", "developer"):
            self.assertIn(text, block)
        self.assertRegex(block, r"(?m)^archive:.*socom2-portable\.zip")   # sitting.py reads the first archive: line
        self.assertLess(block.index("socom2-portable.zip"), block.index("socom2-developer.zip"), "the player first")

    def test_a_dirty_tree_is_said(self):
        block = playtest_block.render(dict(MANIFEST, tree_dirty=3), "2026-09-26")
        self.assertIn("dirty tree", block)
        self.assertIn("3", block)

    def test_no_manifest_renders_not_built_and_how_to_build(self):
        block = playtest_block.render(None, "2026-09-26")
        self.assertIn("**NOT BUILT**", block)
        self.assertIn("bash scripts/make_portable.sh", block)
        self.assertIn("loop_lock.sh run", block)
        # review finding 3: the playtest archive is the release one
        self.assertIn("bash scripts/make_portable.sh --release", block)
        self.assertIn("dist-release/manifest.json", block)

    def test_the_render_does_not_depend_on_the_day(self):
        # --check must not go stale overnight
        self.assertEqual(playtest_block.render(None, "2026-09-26"), playtest_block.render(None, "2026-12-31"))
        self.assertEqual(playtest_block.render(MANIFEST, "2026-09-26"), playtest_block.render(MANIFEST, "2027-01-01"))


class CliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        os.makedirs(os.path.join(self.root, "docs"))
        self.page = os.path.join(self.root, "docs", "PLAYTEST.md")
        with open(self.page, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(PAGE)
        self.manifest = os.path.join(self.root, "manifest.json")

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = playtest_block.main(["--root", self.root] + list(args))
        return rc, out.getvalue()

    def read(self):
        with open(self.page, "rb") as fh:
            return fh.read()

    def test_a_missing_manifest_writes_not_built_and_exits_0(self):
        rc, _ = self.run_main("--manifest", os.path.join(self.root, "nowhere.json"))
        self.assertEqual(rc, 0)
        text = self.read().decode("utf-8")
        self.assertIn("**NOT BUILT**", text)
        self.assertNotIn("old text", text)
        self.assertTrue(text.startswith("# The playtest\n\nintro\n\n<!-- build:begin -->\n"))
        self.assertTrue(text.endswith("<!-- build:end -->\n\n**Not ready until the block above is filled.**\n"))

    def test_the_default_manifest_is_dist_manifest_json_under_the_root(self):
        os.makedirs(os.path.join(self.root, "dist"))
        with open(os.path.join(self.root, "dist", "manifest.json"), "w") as fh:
            json.dump(MANIFEST, fh)
        rc, _ = self.run_main()
        self.assertEqual(rc, 0)
        self.assertIn("a" * 64, self.read().decode("utf-8"))

    def test_the_markers_survive_a_second_run_byte_identical(self):
        with open(self.manifest, "w") as fh:
            json.dump(MANIFEST, fh)
        self.assertEqual(self.run_main("--manifest", self.manifest)[0], 0)
        first = self.read()
        self.assertEqual(self.run_main("--manifest", self.manifest)[0], 0)
        self.assertEqual(self.read(), first)
        self.assertEqual(first.count(b"<!-- build:begin -->"), 1)
        self.assertEqual(first.count(b"<!-- build:end -->"), 1)
        self.assertEqual(self.run_main("--manifest", self.manifest, "--check")[0], 0)

    def test_a_crlf_page_keeps_crlf_and_stays_idempotent(self):
        # core.autocrlf checks docs/*.md out CRLF on the Windows host
        with open(self.page, "wb") as fh:
            fh.write(PAGE.replace("\n", "\r\n").encode("utf-8"))
        with open(self.manifest, "w") as fh:
            json.dump(MANIFEST, fh)
        self.assertEqual(self.run_main("--manifest", self.manifest)[0], 0)
        first = self.read()
        self.assertEqual(first.count(b"\n"), first.count(b"\r\n"), "a bare LF was spliced into a CRLF page")
        self.assertEqual(self.run_main("--manifest", self.manifest)[0], 0)
        self.assertEqual(self.read(), first)
        self.assertEqual(self.run_main("--manifest", self.manifest, "--check")[0], 0)

    def test_check_on_a_stale_block_exits_1_and_writes_nothing(self):
        before = self.read()
        rc, out = self.run_main("--manifest", os.path.join(self.root, "nowhere.json"), "--check")
        self.assertEqual(rc, 1)
        self.assertIn("stale", out)
        self.assertEqual(self.read(), before)

    def test_check_after_a_build_lands_is_stale_until_rewritten(self):
        self.run_main("--manifest", os.path.join(self.root, "nowhere.json"))
        with open(self.manifest, "w") as fh:
            json.dump(MANIFEST, fh)
        self.assertEqual(self.run_main("--manifest", self.manifest, "--check")[0], 1)

    def test_a_page_without_markers_is_an_error(self):
        with open(self.page, "w", encoding="utf-8") as fh:
            fh.write("# no markers\n")
        rc, out = self.run_main("--manifest", os.path.join(self.root, "nowhere.json"))
        self.assertEqual(rc, 2)
        self.assertIn("build:begin", out)

    def test_the_module_runs(self):
        r = subprocess.run([sys.executable, "-m", "tools_py.playtest_block", "--root", self.root,
                            "--manifest", os.path.join(self.root, "nowhere.json")],
                           capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


@unittest.skipUnless(BASH, "bash only")
class MakePortableManifestTest(unittest.TestCase):
    """make_portable's Linux branch, driven on any host with the synthetic dist-linux/ of
    test_make_portable_linux.py: the manifest sits in the build directory, written last, with the hashes of the
    archive and the runner it packaged."""

    def _run(self, tmp, ldist, ldd, *args):
        env = {**os.environ, "MAKE_PORTABLE_SYSTEM": "Linux", "LDD": ldd, "PYTHON": sys.executable,
               "LDIST": ldist, "DIST": os.path.join(tmp, "nodist")}
        return subprocess.run([BASH, SCRIPT] + list(args), capture_output=True, text=True, cwd=ROOT, env=env)

    def test_the_manifest_names_the_archive_and_both_hashes(self):
        from tools_py.tests.test_make_portable_linux import fake_ldist
        with tempfile.TemporaryDirectory() as tmp:
            ldist, ldd = fake_ldist(tmp)
            out = os.path.join(tmp, "out")
            r = self._run(tmp, ldist, ldd, out)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            with open(os.path.join(ldist, "manifest.json"), encoding="utf-8") as fh:
                m = json.load(fh)
            with open(os.path.join(out, "socom2-linux.tar.gz"), "rb") as fh:
                self.assertEqual(m["archive_sha256"], hashlib.sha256(fh.read()).hexdigest())
            with open(os.path.join(ldist, "socom2"), "rb") as fh:
                self.assertEqual(m["exe_sha256"], hashlib.sha256(fh.read()).hexdigest())
            self.assertEqual(m["archive"], "socom2-linux.tar.gz")
            self.assertEqual(m["exe"], "socom2")
            head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=ROOT)
            self.assertEqual(m["commit"], head.stdout.strip())
            self.assertTrue(m["branch"])
            self.assertRegex(m["built_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
            self.assertIsInstance(m["tree_dirty"], int)
            self.assertIn("manifest", r.stdout)
            self.assertIn("socom2-linux.tar.gz", playtest_block.render(m, "2026-09-26"))

    def test_no_commit_means_no_manifest(self):
        # review finding 2: a `git rev-parse HEAD` failing inside $(...) does not trip set -e; an empty commit
        # must refuse the manifest, not write "commit": ""
        from tools_py.tests.test_make_portable_linux import fake_ldist
        with tempfile.TemporaryDirectory() as tmp:
            ldist, ldd = fake_ldist(tmp)
            env = {**os.environ, "MAKE_PORTABLE_SYSTEM": "Linux", "LDD": ldd, "PYTHON": sys.executable,
                   "LDIST": ldist, "DIST": os.path.join(tmp, "nodist"), "GIT_DIR": os.path.join(tmp, "nogit")}
            r = subprocess.run([BASH, SCRIPT, os.path.join(tmp, "out")], capture_output=True, text=True, cwd=ROOT,
                               env=env)
            self.assertNotEqual(r.returncode, 0, r.stderr + r.stdout)
            self.assertIn("no commit", r.stderr)
            self.assertTrue(os.path.isfile(os.path.join(tmp, "out", "socom2-linux.tar.gz")))
            self.assertFalse(os.path.exists(os.path.join(ldist, "manifest.json")))
            self.assertFalse(os.path.exists(os.path.join(ldist, "manifest.json.tmp")))

    def test_a_failed_packaging_leaves_no_manifest(self):
        from tools_py.tests.test_make_portable_linux import fake_ldist
        with tempfile.TemporaryDirectory() as tmp:
            ldist, ldd = fake_ldist(tmp, missing=("libvpx.so.9",))
            stale = os.path.join(ldist, "manifest.json")
            with open(stale, "w") as fh:
                json.dump(MANIFEST, fh)                 # a previous build's manifest
            r = self._run(tmp, ldist, ldd, os.path.join(tmp, "out"))
            self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
            self.assertFalse(os.path.exists(stale), "a failed packaging left the previous build's manifest")


STEP = os.path.join(ROOT, "scripts", "parity", "playtest_block.sh")


@unittest.skipUnless(BASH, "bash only")
class ChainStepTest(unittest.TestCase):
    """scripts/parity/playtest_block.sh reads the manifest from the directory make_portable wrote it to: by
    platform (MAKE_PORTABLE_SYSTEM, else uname) and --release, honouring the same DIST/LDIST overrides (review
    finding 1). PLAYTEST_BLOCK_ROOT points the rewrite at a temp page instead of the repository's."""

    def setUp(self):
        from tools_py.tests.test_make_portable_linux import fake_ldist
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.page_root = os.path.join(self.tmp, "tree")
        os.makedirs(os.path.join(self.page_root, "docs"))
        self.page = os.path.join(self.page_root, "docs", "PLAYTEST.md")
        with open(self.page, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(PAGE)
        self.fake_ldist = fake_ldist

    def tearDown(self):
        self._tmp.cleanup()

    def run_step(self, env_extra, *args):
        env = {**os.environ, "PYTHON": sys.executable, "PLAYTEST_BLOCK_ROOT": self.page_root, **env_extra}
        return subprocess.run([BASH, STEP] + list(args), capture_output=True, text=True, cwd=ROOT, env=env)

    def page_text(self):
        with open(self.page, encoding="utf-8") as fh:
            return fh.read()

    def test_on_linux_the_step_reads_dist_linux(self):
        ldist, ldd = self.fake_ldist(self.tmp)
        # a stale Windows manifest in DIST must not be the one read
        dist = os.path.join(self.tmp, "dist")
        os.makedirs(dist)
        with open(os.path.join(dist, "manifest.json"), "w") as fh:
            json.dump(MANIFEST, fh)
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "Linux", "LDD": ldd, "LDIST": ldist, "DIST": dist},
                          os.path.join(self.tmp, "out"))
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        text = self.page_text()
        self.assertIn("socom2-linux.tar.gz", text)
        self.assertNotIn("socom2-portable.zip", text)
        self.assertNotIn("NOT BUILT", text)

    def test_the_manifest_dir_by_platform_and_release(self):
        # Sprint 14 W2 review (c): the test switch prints and exits 3, so a switch leaked into a chain's environment
        # can never make the chain's last step green without packaging anything.
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "Linux", "PLAYTEST_BLOCK_PRINT_DIR": "1"}, "--release")
        self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
        self.assertEqual(r.stdout.strip().replace("\\", "/").rsplit("/", 1)[-1], "dist-linux-release", r.stderr)
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "Linux", "PLAYTEST_BLOCK_PRINT_DIR": "1"})
        self.assertEqual(r.stdout.strip().replace("\\", "/").rsplit("/", 1)[-1], "dist-linux", r.stderr)
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "MINGW64_NT", "PLAYTEST_BLOCK_PRINT_DIR": "1"}, "--release")
        self.assertEqual(r.stdout.strip().replace("\\", "/").rsplit("/", 1)[-1], "dist-release", r.stderr)
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "MINGW64_NT", "PLAYTEST_BLOCK_PRINT_DIR": "1"})
        self.assertEqual(r.stdout.strip().replace("\\", "/").rsplit("/", 1)[-1], "dist", r.stderr)

    def test_a_failed_packaging_writes_not_built_and_fails_the_step(self):
        ldist, ldd = self.fake_ldist(self.tmp, missing=("libvpx.so.9",))
        r = self.run_step({"MAKE_PORTABLE_SYSTEM": "Linux", "LDD": ldd, "LDIST": ldist},
                          os.path.join(self.tmp, "out"))
        self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
        self.assertIn("**NOT BUILT**", self.page_text())


if __name__ == "__main__":
    unittest.main()
