"""scripts/bootstrap_windows.sh --restore-owner-tools: the owner's installs under tools/ back from the off-tree
backup in one command (Sprint 16 X1).

2026-09-26 20:41Z: a worktree deleted by `gh pr merge --delete-branch` took the main tree's `tools/` with it through
the junction (`docs/HAZARDS.md`, git). The pinned toolchain came back in a minute with this script; PCSX2, Ghidra and
the rest were the owner's installs, which nothing re-fetched, and they were rebuilt by hand from the backup
`D:/socom_archive/tools_backup_2026-09-26`. This flag makes that a one-line recovery: the entries a tracked manifest
names are verified in the backup (file count, one probe file's size and sha256), copied into `tools/` where they are
missing, and verified again after the copy. Nothing here downloads, and nothing here writes into the backup.

Every case runs through the script's own seams -- `SOCOM_TOOLS_DIR`, `SOCOM_TOOLS_BACKUP`, `SOCOM_TOOLS_MANIFEST` --
against temporary directories the test builds; never the real `tools/` of any tree, never the backup as a write
target. The one case that reads the real backup (`RealBackupTest`) is a dry run, skipped where the backup is absent.
"""
import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest

from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "bootstrap_windows.sh")
MANIFEST = os.path.join(ROOT, "scripts", "tools_backup_manifest.txt")
DEFAULT_BACKUP = "D:/socom_archive/tools_backup_2026-09-26"
TOOLCHAIN = ("llvm-mingw", "cmake", "ninja")


def sha256_of(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def manifest_rows(path=MANIFEST):
    """[(name, files, probe, probe_bytes, probe_sha256)] from a manifest file; comments and blanks skipped."""
    rows = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, files, probe, size, sha = line.split("|")
            rows.append((name, int(files), probe, int(size), sha))
    return rows


def run_script(args, env_extra, cwd=ROOT):
    env = dict(os.environ)
    env.update(env_extra)
    done = subprocess.run([BASH, SCRIPT] + list(args), capture_output=True, text=True, env=env, cwd=cwd)
    return done.returncode, done.stdout + done.stderr


def tree_listing(root):
    """{relative path: (size, mtime)} for every file under root -- what 'untouched' means for the backup."""
    out = {}
    for dirpath, _, files in os.walk(root):
        for f in files:
            p = os.path.join(dirpath, f)
            st = os.stat(p)
            out[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns)
    return out


class TrackedManifestTest(unittest.TestCase):
    """The manifest is what the restore trusts: the owner's installs, each with a count and a probe, and never
    the three toolchain directories the fetch path owns."""

    def test_the_manifest_exists_and_every_row_has_its_five_fields(self):
        self.assertTrue(os.path.isfile(MANIFEST), MANIFEST)
        rows = manifest_rows()
        self.assertTrue(rows, "an empty manifest restores nothing")
        for name, files, probe, size, sha in rows:
            self.assertRegex(name, r"^[A-Za-z0-9_.-]+$", name)
            self.assertGreater(files, 0, name)
            self.assertTrue(probe and ".." not in probe.split("/") and not probe.startswith("/"), name)
            self.assertGreater(size, 0, name)
            self.assertRegex(sha, r"^[0-9a-f]{64}$", name)

    def test_the_owners_installs_are_named_and_the_toolchain_is_not(self):
        names = [r[0] for r in manifest_rows()]
        for wanted in ("ghidra", "pcsx2"):
            self.assertIn(wanted, names)
        for tool in TOOLCHAIN:
            self.assertNotIn(tool, names, "%s is the fetch path's, not the restore's" % tool)
        self.assertEqual(len(names), len(set(names)), "a name twice")


@unittest.skipUnless(BASH, "bash not found")
class RestoreTest(unittest.TestCase):
    """The flag against a fake backup, a fake manifest and an empty tools directory, all temporary."""

    ENTRIES = {
        # name: {relative file: content}; the first file listed is the probe
        "ghidra": {"ghidraRun.bat": b"@echo ghidra\r\n", "Ghidra/application.properties": b"v=12.1.3\n",
                   "support/analyzeHeadless.bat": b"@echo headless\r\n"},
        "pcsx2": {"pcsx2-qt.exe": b"MZ-not-really-an-exe" * 64, "inis/PCSX2.ini": b"[Pad1]\n"},
    }

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bootstrap_restore_")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.backup = os.path.join(self.tmp, "backup")
        self.tools = os.path.join(self.tmp, "tools")
        self.manifest = os.path.join(self.tmp, "manifest.txt")
        os.makedirs(self.tools)
        rows = []
        for name, files in self.ENTRIES.items():
            for rel, content in files.items():
                p = os.path.join(self.backup, name, *rel.split("/"))
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "wb") as fh:
                    fh.write(content)
            probe = next(iter(files))
            ppath = os.path.join(self.backup, name, *probe.split("/"))
            rows.append("%s|%d|%s|%d|%s" % (name, len(files), probe, os.path.getsize(ppath), sha256_of(ppath)))
        with open(self.manifest, "w", newline="\n") as fh:
            fh.write("# name|files|probe|probe_bytes|probe_sha256\n" + "\n".join(rows) + "\n")

    def env(self):
        return {"SOCOM_TOOLS_DIR": self.tools, "SOCOM_TOOLS_BACKUP": self.backup,
                "SOCOM_TOOLS_MANIFEST": self.manifest}

    def restore(self, *extra):
        return run_script(["--restore-owner-tools"] + list(extra), self.env())

    def test_a_dry_run_prints_the_copy_plan_and_writes_nothing(self):
        before = tree_listing(self.backup)
        code, out = self.restore("--dry-run")
        self.assertEqual(code, 0, out)
        for name, files in self.ENTRIES.items():
            self.assertIn("restore: would copy %s -> %s (%d files)" % (
                os.path.join(self.backup, name).replace("\\", "/"),
                os.path.join(self.tools, name).replace("\\", "/"), len(files)), out)
        self.assertEqual(os.listdir(self.tools), [], "a dry run wrote into tools/")
        self.assertEqual(tree_listing(self.backup), before, "a dry run touched the backup")

    def test_a_planted_empty_tools_directory_is_restored_and_verified(self):
        before = tree_listing(self.backup)
        code, out = self.restore()
        self.assertEqual(code, 0, out)
        for name, files in self.ENTRIES.items():
            self.assertIn("restore: %s restored (%d files)" % (name, len(files)), out)
            for rel, content in files.items():
                with open(os.path.join(self.tools, name, *rel.split("/")), "rb") as fh:
                    self.assertEqual(fh.read(), content, "%s/%s" % (name, rel))
        self.assertEqual(tree_listing(self.backup), before, "the restore touched the backup")
        self.assertIn("restore: done", out)

    def test_a_missing_backup_entry_is_refused_before_anything_is_copied(self):
        shutil.rmtree(os.path.join(self.backup, "pcsx2"))
        code, out = self.restore()
        self.assertEqual(code, 1, out)
        self.assertIn("restore: pcsx2: missing from the backup", out)
        self.assertIn("nothing was copied", out)
        self.assertEqual(os.listdir(self.tools), [], "an entry was copied although the manifest failed")

    def test_a_changed_probe_is_refused_and_named(self):
        with open(os.path.join(self.backup, "ghidra", "ghidraRun.bat"), "ab") as fh:
            fh.write(b"tampered\r\n")
        code, out = self.restore("--dry-run")
        self.assertEqual(code, 1, out)
        self.assertIn("restore: ghidra: probe ghidraRun.bat", out)
        self.assertIn("nothing was copied", out)

    def test_a_wrong_file_count_is_refused_and_named(self):
        with open(os.path.join(self.backup, "pcsx2", "extra.txt"), "wb") as fh:
            fh.write(b"one more file than the manifest says\n")
        code, out = self.restore("--dry-run")
        self.assertEqual(code, 1, out)
        self.assertIn("restore: pcsx2: 3 files in the backup, the manifest says 2", out)

    def test_an_entry_already_in_tools_is_left_alone(self):
        os.makedirs(os.path.join(self.tools, "pcsx2"))
        marker = os.path.join(self.tools, "pcsx2", "owner-was-here.txt")
        with open(marker, "wb") as fh:
            fh.write(b"do not overwrite\n")
        code, out = self.restore()
        self.assertEqual(code, 0, out)
        self.assertIn("restore: pcsx2 present in tools/, left alone", out)
        self.assertIn("restore: ghidra restored", out)
        self.assertTrue(os.path.isfile(marker), "the existing entry was replaced")
        self.assertFalse(os.path.exists(os.path.join(self.tools, "pcsx2", "pcsx2-qt.exe")))

    def test_an_absent_backup_directory_is_refused_with_its_path(self):
        shutil.rmtree(self.backup)
        code, out = self.restore("--dry-run")
        self.assertEqual(code, 1, out)
        self.assertIn("restore: no backup at %s" % self.backup.replace("\\", "/"), out)

    def test_the_check_path_is_unchanged_by_the_flag(self):
        code, out = run_script(["--check"], {"SOCOM_TOOLS_DIR": self.tools})
        self.assertEqual(code, 1, out)
        self.assertIn("bootstrap: llvm-mingw wanted", out)
        self.assertNotIn("restore:", out)


@unittest.skipUnless(BASH and os.path.isdir(DEFAULT_BACKUP), "the off-tree backup is not on this machine")
class RealBackupTest(unittest.TestCase):
    """The tracked manifest against the real backup: a dry run, read-only, into a temporary tools directory.
    It takes a few seconds (it counts Ghidra's files); it never copies."""

    def test_the_tracked_manifest_verifies_against_the_backup_in_a_dry_run(self):
        tmp = tempfile.mkdtemp(prefix="bootstrap_restore_real_")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        code, out = run_script(["--restore-owner-tools", "--dry-run"], {"SOCOM_TOOLS_DIR": tmp})
        self.assertEqual(code, 0, out)
        for name, files, _, _, _ in manifest_rows():
            self.assertIn("restore: %s ok (%d files" % (name, files), out)
        self.assertEqual(os.listdir(tmp), [])


if __name__ == "__main__":
    unittest.main()
