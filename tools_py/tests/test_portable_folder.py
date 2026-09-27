"""Sprint 9 Goal 2: every portable folder that exists on this machine is closed -- the shipped executables
import nothing the folder lacks, and the folder carries nothing they do not import -- and the Windows runner
loads with nothing on PATH but System32 (run.sh puts tools/llvm-mingw/bin on PATH, so a gate cannot show that a
folder is complete). The run is `socom2 --home <empty dir>`: the loader resolves every static import before
main(), the preflight finds no ELF and leaves with 68 before a window opens."""
import os
import subprocess
import tempfile
import unittest

from tools_py import exit_codes, portable_audit

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FOLDERS = [
    ("Windows", os.path.join(ROOT, "dist", "portable", "socom2")),
    ("Windows", os.path.join(ROOT, "dist-release", "portable", "socom2")),
    ("Windows", os.path.join(ROOT, "dist-release", "portable", "socom2-developer")),
    ("Linux", os.path.join(ROOT, "dist-linux", "portable", "socom2-linux")),
    ("Linux", os.path.join(ROOT, "dist-linux-release", "portable", "socom2-linux")),
    ("Linux", os.path.join(ROOT, "dist-linux-release", "portable", "socom2-linux-developer")),
]


class RealPortableFoldersTest(unittest.TestCase):
    def test_every_portable_folder_on_this_machine_is_closed(self):
        present = [(system, folder) for system, folder in FOLDERS if os.path.isdir(folder)]
        if not present:
            self.skipTest("no portable folder on this machine (scripts/make_portable.sh writes one)")
        for system, folder in present:
            with self.subTest(folder=folder):
                found = portable_audit.audit(folder, system)
                self.assertEqual(found["missing"], {}, "imported, and not in the folder")
                self.assertEqual(found["orphans"], [], "in the folder, and imported by nothing")

    @unittest.skipUnless(os.name == "nt", "Windows loader only")
    def test_the_windows_runner_and_launcher_load_with_only_system32_on_path(self):
        present = [folder for system, folder in FOLDERS if system == "Windows" and os.path.isdir(folder)]
        if not present:
            self.skipTest("no Windows portable folder on this machine")
        system_root = os.environ.get("SystemRoot", "C:\\Windows")
        for folder in present:
            with self.subTest(folder=folder), tempfile.TemporaryDirectory() as tmp:
                env = {"SystemRoot": system_root, "PATH": os.path.join(system_root, "System32"),
                       "TEMP": tmp, "TMP": tmp, "USERPROFILE": tmp}
                home = os.path.join(tmp, "home")
                os.makedirs(home)
                r = subprocess.run([os.path.join(folder, "socom2.exe"), "--home", home], env=env, cwd=home,
                                   capture_output=True, timeout=60)
                self.assertEqual(exit_codes.classify(r.returncode), exit_codes.code("ElfMissing"), r.stderr[-400:])
                out = os.path.join(tmp, "d.zip")
                r = subprocess.run([os.path.join(folder, "socom_unzipped_launcher.exe"), "--diagnostics", out, home],
                                   env=env, cwd=home, capture_output=True, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-400:])


if __name__ == "__main__":
    unittest.main()
