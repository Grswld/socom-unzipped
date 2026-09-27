"""Task 8b Step 5: scripts/make_portable.sh assembles the portable folder (outline section 2 A) from dist/.
Sprint 9 Goal 2: the folder carries the import closure of the two executables and nothing else, and a
SHA256SUMS sits beside the archive."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from tools_py import portable_audit
from tools_py.tests.binfmt_fixtures import tiny_pe
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "make_portable.sh")

FAKE_DIST = {
    "socom2.exe": tiny_pe(["KERNEL32.dll", "avcodec-61.dll", "libc++.dll"]),
    "socom_unzipped_launcher.exe": tiny_pe(["USER32.dll", "libc++.dll"]),
    "avcodec-61.dll": tiny_pe(["swresample-5.dll", "KERNEL32.dll"]),
    "swresample-5.dll": tiny_pe(["KERNEL32.dll"]),
    "libc++.dll": tiny_pe([]),
    "avformat-61.dll": tiny_pe(["avcodec-61.dll"]),      # in dist/, imported by nothing shipped
    "OpenEXR-3_3.dll": tiny_pe(["KERNEL32.dll"]),        # likewise
    "vu1_replay.exe": tiny_pe(["libc++.dll"]),           # a harness tool: never shipped
    "socom2_game.elf": b"x",
}


def fake_dist(tmp, without=(), name="dist", marker=b""):
    dist = os.path.join(tmp, name)
    os.makedirs(dist)
    for fname, data in FAKE_DIST.items():
        if fname not in without:
            with open(os.path.join(dist, fname), "wb") as fh:
                # marker: a player and a developer exe that differ, as the two configurations' exes do
                fh.write(data + marker if fname == "socom2.exe" else data)
    return dist


@unittest.skipUnless(BASH and shutil.which("powershell"), "bash and PowerShell only")
class MakePortableTest(unittest.TestCase):
    def _run(self, dist, *args):
        return subprocess.run([BASH, SCRIPT] + list(args), capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, "DIST": dist})

    def test_folder_has_the_game_the_launcher_the_closure_the_readme_and_the_licences(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            r = self._run(fake_dist(tmp), out)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            pkg = os.path.join(out, "socom2")
            for f in ("socom2.exe", "socom2_game.elf", "socom_unzipped_launcher.exe", "avcodec-61.dll", "swresample-5.dll",
                      "libc++.dll", "README.txt", "THIRD_PARTY_NOTICES.md", os.path.join("LICENSES", "GPL-3.0-only.txt"),
                      os.path.join("LICENSES", "LGPL-2.1-or-later.txt"), os.path.join("LICENSES", "OFL-1.1.txt")):
                self.assertTrue(os.path.isfile(os.path.join(pkg, f)), f)
            for d in ("cards", "logs"):
                self.assertTrue(os.path.isdir(os.path.join(pkg, d)), d)
            self.assertIn("Run socom_unzipped_launcher.exe", open(os.path.join(pkg, "README.txt")).read())
            # Sprint 9 Goal 1: the About page and the diagnostics zip read version.txt; nothing wrote it before.
            with open(os.path.join(pkg, "version.txt")) as fh:
                self.assertRegex(fh.read(), "^SOCOM Unzipped \\S+ \\(\\d{4}-\\d{2}-\\d{2}\\)\\n$")
            self.assertTrue(os.path.isfile(os.path.join(out, "socom2-portable.zip")))

    def test_what_nothing_imports_stays_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            self.assertEqual(self._run(fake_dist(tmp), out).returncode, 0)
            pkg = os.path.join(out, "socom2")
            for f in ("avformat-61.dll", "OpenEXR-3_3.dll", "vu1_replay.exe"):
                self.assertFalse(os.path.exists(os.path.join(pkg, f)), f)
            self.assertEqual(portable_audit.audit(pkg, "Windows"),
                             {"needed": ["avcodec-61.dll", "libc++.dll", "swresample-5.dll"], "missing": {}, "orphans": []})

    def test_sha256sums_sits_beside_the_zip_and_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            self.assertEqual(self._run(fake_dist(tmp), out).returncode, 0)
            with open(os.path.join(out, "SHA256SUMS")) as fh:
                self.assertRegex(fh.read(), "^[0-9a-f]{64}  socom2-portable\\.zip\\n$")
            self.assertEqual(portable_audit.verify_sha256sums(out), [])
            with open(os.path.join(out, "socom2-portable.zip"), "ab") as fh:
                fh.write(b"tampered")
            self.assertEqual(portable_audit.verify_sha256sums(out), ["socom2-portable.zip: checksum differs"])

    def test_an_import_that_is_nowhere_stops_the_packaging(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self._run(fake_dist(tmp, without=("swresample-5.dll",)), os.path.join(tmp, "out"))
            self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
            self.assertIn("swresample-5.dll", r.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "out", "socom2-portable.zip")))

    def test_release_flag_is_accepted_in_front_of_the_out_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            r = self._run(fake_dist(tmp), "--release", out)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            self.assertTrue(os.path.isfile(os.path.join(out, "socom2-portable.zip")))

    def test_refuses_without_a_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = self._run(os.path.join(tmp, "nodist"), os.path.join(tmp, "out"))
            self.assertEqual(r.returncode, 2)
            self.assertIn("run ./build.sh runtime first", r.stderr)


@unittest.skipUnless(BASH, "bash only")
class TwoReleaseKindsTest(unittest.TestCase):
    """Sprint 16 R3a (R295): the release is two configurations -- a PLAYER exe with the debug UI and the probes
    compiled out (dist-release/) and a DEVELOPER exe with them in (dist-release-dev/) -- and one `--release`
    packaging run makes both archives. Driven on any host: without PowerShell the Windows branch zips with
    Python's zipfile, so the stand-ins below exercise the closure, the audit, the leak check, SHA256SUMS and
    the manifest here too."""

    def _run(self, tmp, *args, dev=True):
        env = {**os.environ, "MAKE_PORTABLE_SYSTEM": "MINGW64_NT", "PYTHON": sys.executable,
               "DIST": fake_dist(tmp, name="dist-release", marker=b"player")}
        env["DEVDIST"] = fake_dist(tmp, name="dist-release-dev", marker=b"developer") if dev \
            else os.path.join(tmp, "dist-release-dev")
        return subprocess.run([BASH, SCRIPT, "--release"] + list(args), capture_output=True, text=True, cwd=ROOT,
                              env=env)

    def test_one_run_writes_the_player_and_the_developer_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            r = self._run(tmp, out)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            for zname, top, marker in (("socom2-portable.zip", "socom2/", b"player"),
                                       ("socom2-developer.zip", "socom2-developer/", b"developer")):
                with zipfile.ZipFile(os.path.join(out, zname)) as z:
                    names = z.namelist()
                    self.assertIn(top + "socom2.exe", names, zname)
                    self.assertIn(top + "socom2_game.elf", names, zname)   # the ELF stays in both (issue #70)
                    self.assertIn(top + "socom_unzipped_launcher.exe", names, zname)
                    self.assertTrue(z.read(top + "socom2.exe").endswith(marker), zname + " packaged the other exe")

    def test_sha256sums_has_a_line_for_each_archive_and_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            self.assertEqual(self._run(tmp, out).returncode, 0)
            with open(os.path.join(out, "SHA256SUMS")) as fh:
                lines = fh.read().splitlines()
            self.assertEqual(sorted(ln.split("  ", 1)[1] for ln in lines),
                             ["socom2-developer.zip", "socom2-portable.zip"])
            self.assertEqual(portable_audit.verify_sha256sums(out), [])

    def test_the_manifest_names_both_archives_with_a_kind_and_an_exe_sha_each(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            self.assertEqual(self._run(tmp, out).returncode, 0)
            with open(os.path.join(tmp, "dist-release", "manifest.json"), encoding="utf-8") as fh:
                m = json.load(fh)
            kinds = {a["kind"]: a for a in m["archives"]}
            self.assertEqual(sorted(kinds), ["developer", "player"])
            self.assertEqual(kinds["player"]["archive"], "socom2-portable.zip")
            self.assertEqual(kinds["developer"]["archive"], "socom2-developer.zip")
            for kind, d in (("player", "dist-release"), ("developer", "dist-release-dev")):
                with open(os.path.join(tmp, d, "socom2.exe"), "rb") as fh:
                    self.assertEqual(kinds[kind]["exe_sha256"], hashlib.sha256(fh.read()).hexdigest(), kind)
                with open(os.path.join(out, kinds[kind]["archive"]), "rb") as fh:
                    self.assertEqual(kinds[kind]["archive_sha256"], hashlib.sha256(fh.read()).hexdigest(), kind)
            # the top-level fields stay the player's, so a reader of the one-archive manifest reads the player
            self.assertEqual((m["archive"], m["kind"]), ("socom2-portable.zip", "player"))

    def test_without_a_developer_build_it_writes_the_player_archive_and_says_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            os.makedirs(out)
            with open(os.path.join(out, "socom2-developer.zip"), "wb") as fh:
                fh.write(b"a previous run's")                      # must not sit beside the new SHA256SUMS
            r = self._run(tmp, out, dev=False)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            self.assertTrue(os.path.isfile(os.path.join(out, "socom2-portable.zip")))
            self.assertFalse(os.path.exists(os.path.join(out, "socom2-developer.zip")))
            self.assertIn("no developer build", r.stdout + r.stderr)
            with open(os.path.join(out, "SHA256SUMS")) as fh:
                self.assertRegex(fh.read(), "^[0-9a-f]{64}  socom2-portable\\.zip\\n$")
            with open(os.path.join(tmp, "dist-release", "manifest.json"), encoding="utf-8") as fh:
                self.assertEqual([a["kind"] for a in json.load(fh)["archives"]], ["player"])

    def test_each_folder_gets_its_own_closure_audit(self):
        # the developer folder imports a DLL the player's does not (the debug UI's, say): its closure is its own
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "MAKE_PORTABLE_SYSTEM": "MINGW64_NT", "PYTHON": sys.executable,
                   "DIST": fake_dist(tmp, name="dist-release"),
                   "DEVDIST": fake_dist(tmp, name="dist-release-dev", without=("swresample-5.dll",))}
            r = subprocess.run([BASH, SCRIPT, "--release", os.path.join(tmp, "out")], capture_output=True,
                               text=True, cwd=ROOT, env=env)
            self.assertEqual(r.returncode, 3, r.stderr + r.stdout)
            self.assertIn("dist-release-dev", r.stderr)
            self.assertFalse(os.path.exists(os.path.join(tmp, "dist-release", "manifest.json")))

    def test_the_linux_branch_writes_both_tarballs(self):
        from tools_py.tests.test_make_portable_linux import fake_ldist
        with tempfile.TemporaryDirectory() as tmp:
            ldist, ldd = fake_ldist(tmp)
            ldev = os.path.join(tmp, "dist-linux-release-dev")
            shutil.copytree(ldist, ldev)
            out = os.path.join(tmp, "out")
            env = {**os.environ, "MAKE_PORTABLE_SYSTEM": "Linux", "LDD": ldd, "PYTHON": sys.executable,
                   "LDIST": ldist, "LDEVDIST": ldev, "DIST": os.path.join(tmp, "nodist")}
            r = subprocess.run([BASH, SCRIPT, "--release", out], capture_output=True, text=True, cwd=ROOT, env=env)
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
            with open(os.path.join(out, "SHA256SUMS")) as fh:
                self.assertEqual(sorted(ln.split("  ", 1)[1] for ln in fh.read().splitlines()),
                                 ["socom2-linux-developer.tar.gz", "socom2-linux.tar.gz"])
            with open(os.path.join(ldist, "manifest.json"), encoding="utf-8") as fh:
                self.assertEqual([(a["kind"], a["archive"]) for a in json.load(fh)["archives"]],
                                 [("player", "socom2-linux.tar.gz"), ("developer", "socom2-linux-developer.tar.gz")])


if __name__ == "__main__":
    unittest.main()


class ReleaseConfigurationTest(unittest.TestCase):
    """Sprint 9 P7. R151 was decided on a measurement -- `-O2` made the generated code's exe 9.9% smaller
    and the ZIP 4.6 MB LARGER, so the release keeps `-O1` -- and `docs/KNOWN.md` records it as settled.
    The ruling was never applied to the script: `build.sh`'s release default was introduced as `-O2` in
    285382e and never changed, so every `./build.sh release` since has built the configuration R151
    rejected. Found when the playtest candidate came out 62.8 MB against Goal 2's recorded 55.7 MB.
    A ruling that is written down but not wired to anything is not a decision, it is a note."""

    def setUp(self):
        with open(os.path.join(ROOT, "build.sh"), encoding="utf-8") as fh:
            self.text = fh.read()

    def test_the_release_default_is_the_optimisation_r151_chose(self):
        line = [ln for ln in self.text.splitlines() if "REL_GENOPT" in ln]
        self.assertEqual(len(line), 1, "one place sets the release's generated-code optimisation")
        self.assertIn("${REL_GENOPT:--O1}", line[0],
                      "R151 measured -O2 as a LARGER download and chose -O1; the default must be what was chosen")
        self.assertNotIn(":--O2", line[0], "the rejected value is not the default")


class ReleaseKindTest(unittest.TestCase):
    """Sprint 16 R3a (R295): build.sh's release() builds one of two kinds, PS2X_RELEASE_KIND=player|developer
    (default player). The player compiles the debug UI and the probes out and stages into dist-release/; the
    developer keeps both and stages into dist-release-dev/. scripts/build_linux.sh's release path mirrors it."""

    def _release_body(self, path):
        with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
            text = fh.read()
        m = re.search(r"(?ms)^release\(\) \{.*?^\}", text)
        self.assertIsNotNone(m, path + " has no release()")
        return text, m.group(0)

    def test_build_sh_release_takes_the_kind_and_passes_both_options(self):
        for path, reldist in (("build.sh", "dist-release"), ("scripts/build_linux.sh", "dist-linux-release")):
            text, body = self._release_body(path)
            self.assertTrue("${PS2X_RELEASE_KIND:-player}" in text, path + ": the kind defaults to player")
            self.assertRegex(body, r"-DPS2X_ENABLE_DEBUG_UI=\"?\$", path + ": the debug UI option follows the kind")
            self.assertRegex(body, r"-DPS2X_ENABLE_PROBES=\"?\$", path + ": the probes option follows the kind")
            self.assertTrue('"$ROOT/%s-dev"' % reldist in text, path + ": the developer kind stages into %s-dev/" % reldist)
            self.assertTrue("player|developer" in text, path + ": an unknown kind is refused, not guessed")

    def test_the_cmake_option_exists_and_defaults_on(self):
        with open(os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRuntime", "CMakeLists.txt"), encoding="utf-8") as fh:
            text = fh.read()
        for line in ('option(PS2X_ENABLE_PROBES "Compile the dump and trace probes" ON)',
                     'option(PS2X_ENABLE_DEBUG_UI "Build the desktop runtime debug UI" ON)'):
            self.assertTrue(line in text, "ps2xRuntime/CMakeLists.txt lacks " + line)
