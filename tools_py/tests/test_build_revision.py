"""scripts/build_revision.sh: the pipeline parameterised by disc revision (Sprint 11 Task 9, Goal B).

    bash scripts/build_revision.sh <rev> <APACHE00.ZDB> [--check-against <elf>] [--dry-run] [--stop-after <step>]

These cases hold the script's argument handling, its preconditions, its dry run and the mark step 4 skips on,
through tools_py/tests/shell.BASH (a bare `bash` resolves to WSL's on a GitHub Windows runner). They touch no
disc and are meant to stop at a refusal, at a skip check, at `--stop-after elf` or at the dry run, before the first
minute of Unicorn and before the first cmake -- except BuildRevisionRecompKeepsItsOutputTest, which runs step 4
with BR_PS2_RECOMP naming a stand-in, and with that seam set step 4 runs no cmake at all. Since #56 that holds
only for a revision with no products in the tree: a non-dry --out case on a revision whose `game/overlays_<rev>/`
is current (r0004 on a working checkout) copies those overlays instead of decrypting, skips the step-1 refusal it
meant to reach and runs on into the lock-bound recomp and runtime. So every non-dry case uses a throwaway
revision name (r0009...).

NOT covered here, because only a disc can cover it: that the pipeline reproduces r0001 byte for byte. That is the
bar the controller runs from the main tree (`r0001check` against dist/socom2_game.elf and recomp/output); the
numbers are in docs/DEVELOPING.md "From your own disc to a buildable ELF".
"""
import hashlib
import os
import subprocess
import tempfile
import unittest

from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join("scripts", "build_revision.sh")
EMPTY_ZDB = os.path.join("tools_py", "tests", "fixtures", "empty.zdb")


def run_bash(*args, **kwargs):
    return subprocess.run([BASH] + list(args), capture_output=True, text=True, cwd=ROOT, **kwargs)


def sh(path):
    """A Windows path as the script's bash reads it: C:/x resolves, C:\\x does not."""
    return path.replace("\\", "/")


def sha256_of(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def read_bytes(path):
    with open(path, "rb") as handle:
        return handle.read()


def touch(*parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8"):
        pass
    return path


def fake_toolchain(tmp):
    """clang/cmake/ninja stubs for the lock-bound tail's toolchain check, so these cases run on a machine (or a
    CI runner) with no tools/ tree. Nothing invokes them: the skip cases stop before step 4's cmake, and the
    BR_PS2_RECOMP cases reach step 4 with the seam set, which skips both cmake lines."""
    binaries = os.path.join(tmp, "fakebin")
    os.makedirs(binaries)
    for name in ("clang", "cmake", "ninja"):
        path = os.path.join(binaries, name)
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("#!/bin/sh\nexit 0\n")
        os.chmod(path, 0o755)
    return binaries


def tail_env(tmp, out, rev="r0004", stop="recomp"):
    """The environment loop_lock.sh hands the re-entered script for steps 4-5."""
    env = dict(os.environ)
    env.update(BR_REV=rev, BR_STOP=stop, BR_FORCE="0", BR_OUT=sh(out))
    env["PATH"] = fake_toolchain(tmp) + os.pathsep + env.get("PATH", "")
    return env


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionArgsTest(unittest.TestCase):
    def test_a_bad_revision_name_is_refused_before_anything_runs(self):
        p = run_bash(SCRIPT, "R4", "nope.zdb")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("revision must look like r0004", p.stderr)

    def test_a_missing_package_is_refused(self):
        p = run_bash(SCRIPT, "r0004", "does/not/exist.zdb")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("no such package", p.stderr)

    def test_dry_run_prints_the_five_steps_and_their_paths(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        for s in ("decrypt", "game/overlays_r0004/", "make_overlay_elf", "recomp/output_r0004/", "dist/socom2_r0004.exe"):
            self.assertIn(s, p.stdout)

    def test_a_revision_may_carry_a_suffix_so_a_check_build_never_overwrites_the_real_one(self):
        # The bar is run as `r0001check`: the same disc under a name that cannot collide with r0001's products.
        p = run_bash(SCRIPT, "r0001check", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("game/overlays_r0001check/", p.stdout)
        p = run_bash(SCRIPT, "r0001-check", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 2, "a suffix is letters and digits only: " + p.stdout + p.stderr)
        p = run_bash(SCRIPT, "r00012", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 2, "a suffix starts with a letter, so r00012 reads as a typo of r0012, "
                                          "not as a variant of r0001: " + p.stdout + p.stderr)

    def test_stop_after_and_check_against_are_shown_by_the_dry_run(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--stop-after", "elf", "--check-against", EMPTY_ZDB)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("check-against", p.stdout)
        self.assertIn("stop after elf", p.stdout)
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--stop-after", "lunch")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("--stop-after", p.stderr)

    def test_stop_after_toml_is_the_last_step_that_takes_no_lock(self):
        """Step 3 writes the tracked recomp/socom2_<rev>.toml, so a change to what it writes has to be
        checkable against the tree without waiting for the loop lock."""
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--stop-after", "toml")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("stop after toml", p.stdout)
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--stop-after", "lunch")
        self.assertIn("toml", p.stderr, "the refusal must list the value it now accepts: " + p.stderr)

    def test_an_unknown_option_is_refused(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--wat")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("unknown option", p.stderr)

    def test_the_package_argument_is_required(self):
        p = run_bash(SCRIPT, "r0004")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("usage:", p.stderr)

    def test_a_missing_check_against_elf_is_refused(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--check-against", "nope.elf")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("no such ELF to check against", p.stderr)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionPreconditionsTest(unittest.TestCase):
    """The inputs step 1 cannot work without, each refused with a sentence before the eight minutes of Unicorn.

    Every case builds a synthetic disc tree in a temporary directory (empty files under the real names) and sends
    every product to --out, so nothing is written inside the repository and no disc byte is involved.

    The revision is a throwaway `r0009precond`, never r0004: since #56 an --out build copies the tree's current
    `game/overlays_<rev>/` instead of decrypting, so on a checkout that holds r0004's products an r0004 case skips
    step 1 -- the refusal it is about -- and runs on through the recomp and the runtime under the loop lock.
    """
    REV = "r0009precond"

    def test_a_package_that_is_not_the_trees_own_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            tree = os.path.join(tmp, "tree")
            touch(tree, "RUN", "RAW", "APACHE00.ZDB")
            touch(tree, "SCUS_972.75")
            touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
            stray = touch(tmp, "elsewhere", "APACHE00.ZDB")
            p = run_bash(SCRIPT, self.REV, sh(stray), "--game", sh(tree), "--ghidra-from-r0001",
                         "--out", sh(os.path.join(tmp, "out")))
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("must be the tree's own", p.stderr)

    def test_a_tree_whose_loader_is_not_scus_972_75_stops_with_a_sentence(self):
        # decrypt_apache.py:206 joins 'SCUS_972.75' onto the tree itself, so a PAL/SLUS tree cannot be decrypted
        # by this script; before this check it announced the eight minutes and then died in a Python traceback.
        with tempfile.TemporaryDirectory() as tmp:
            tree = os.path.join(tmp, "tree")
            zdb = touch(tree, "RUN", "RAW", "APACHE00.ZDB")
            touch(tree, "SLES_512.34")
            touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
            p = run_bash(SCRIPT, self.REV, sh(zdb), "--ghidra-from-r0001",
                         "--out", sh(os.path.join(tmp, "out")))
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("SCUS_972.75", p.stderr)
            self.assertIn("SLES_512.34", p.stderr)
            self.assertNotIn("about eight minutes", p.stdout)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionFunctionMapTest(unittest.TestCase):
    """r0001's function map is a starting point only for the r0001 disc; any other revision must ask for it."""

    # `r0009nomap`, not r0004: r0004's map is tracked in recomp/, and since #56 an --out build reads it from there.

    def test_a_foreign_revision_without_a_map_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, "r0009nomap", EMPTY_ZDB, "--out", sh(os.path.join(tmp, "out")))
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("socom2_ghidra_r0009nomap.csv", p.stderr)
            self.assertIn("--ghidra-from-r0001", p.stderr)

    def test_borrowing_r0001s_map_for_a_foreign_revision_warns_on_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, "r0009nomap", EMPTY_ZDB, "--ghidra-from-r0001",
                         "--out", sh(os.path.join(tmp, "out")))
            self.assertIn("WARNING", p.stderr)
            self.assertIn("Task 10", p.stderr)
            # It then stops for another reason (the fixture's tree holds no loader), which is not this test's
            # business; what matters is that the borrowing was announced before any of it.

    def test_the_r0001_disc_borrows_its_own_map_silently(self):
        p = run_bash(SCRIPT, "r0001check", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn("WARNING", p.stderr)

    def test_the_dry_run_says_which_map_step_3_will_use(self):
        # `r0009fake` rather than r0004: once a revision's own map is in recomp/, the dry run says "is
        # already there" instead, and this case is about what it says when there is none.
        p = run_bash(SCRIPT, "r0009fake", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("--ghidra", p.stdout)

    def test_ghidra_naming_the_revisions_own_map_is_not_a_copy_onto_itself(self):
        """`--ghidra recomp/socom2_ghidra_<rev>.csv` names the map step 3 would use anyway; cp refuses a
        file onto itself, and under `set -e` that killed the run between the ELF and the TOML."""
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run",
                     "--ghidra", "recomp/socom2_ghidra_r0004.csv")
        if "no such function map" in p.stderr:
            self.skipTest("this tree has no recomp/socom2_ghidra_r0004.csv")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("nothing to copy", p.stdout)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionForcedEntryPointsTest(unittest.TestCase):
    """recomp/extra_functions.txt is r0001's list of addresses, so it is a per-revision input like the map.

    A revision with no list of its own falls back to r0001's -- 1,453 of whose 1,619 entries are overlay
    addresses that mean something only in r0001 -- so the fallback has to say so. `r0009fake` is used where
    the case must not depend on which recomp/extra_functions_<rev>.txt the working tree happens to hold.
    """

    def test_a_missing_list_is_refused(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--extra", "recomp/no_such_list.txt")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("no such forced-entry-point list", p.stderr)

    def test_extra_needs_a_path(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--extra")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_the_dry_run_names_the_list_step_4_will_use(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--extra", EMPTY_ZDB)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("forced entry points", p.stdout)
        self.assertIn("empty.zdb", p.stdout)

    def test_a_foreign_revision_borrowing_r0001s_list_says_so(self):
        p = run_bash(SCRIPT, "r0009fake", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("recomp/extra_functions.txt", p.stdout)
        self.assertIn("another build's overlay addresses", p.stdout)

    def test_the_r0001_disc_uses_its_own_list_without_that_note(self):
        p = run_bash(SCRIPT, "r0001check", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("recomp/extra_functions.txt", p.stdout)
        self.assertNotIn("another build's overlay addresses", p.stdout)

    def test_a_foreign_revision_is_warned_on_stderr_outside_the_dry_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, "r0009fake", EMPTY_ZDB, "--ghidra-from-r0001",
                         "--out", sh(os.path.join(tmp, "out")))
            self.assertIn("find_imm_targets.py", p.stderr)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionMatchReportTest(unittest.TestCase):
    """recomp/socom2.toml's ~1,900 guest addresses are r0001's, so the config is a per-revision input too.

    With an address match report step 3 runs tools_py.revision_toml and translates them; without one it
    copies-and-renames as it always did, and a foreign revision is warned that what it gets is r0001's
    numbers. `r0009fake` has no game/r0009fake/match.json in any tree, which is what makes it the revision
    these cases can assert the fallback on.
    """

    def test_a_missing_report_is_refused(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--match", "game/no_such_match.json")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("no such address match report", p.stderr)

    def test_match_needs_a_path(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--match")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)

    def test_the_dry_run_names_the_report_step_3_will_translate_through(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run", "--match", EMPTY_ZDB)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("every address translated through", p.stdout)
        self.assertIn("empty.zdb", p.stdout)

    def test_without_a_report_the_dry_run_says_the_addresses_stay_r0001s(self):
        p = run_bash(SCRIPT, "r0009fake", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("every other address stays r0001's", p.stdout)

    def test_a_foreign_revision_without_a_report_is_warned_on_stderr(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, "r0009fake", EMPTY_ZDB, "--ghidra-from-r0001",
                         "--out", sh(os.path.join(tmp, "out")))
            self.assertIn("no address match report", p.stderr)
            self.assertIn("address_matcher", p.stderr)

    def test_the_r0001_disc_is_not_warned(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, "r0001check", EMPTY_ZDB, "--out", sh(os.path.join(tmp, "out")))
            self.assertNotIn("no address match report", p.stderr)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionRecompSkipTest(unittest.TestCase):
    """Step 4 skips on the mark it writes when ps2_recomp returns 0, never on 'the directory has files in it'.

    Both cases enter the script the way loop_lock.sh does (--_tail with BR_*), with a stub toolchain on PATH.
    Neither reaches a cmake: the first stops at the skip, the second dies on the function map that a temporary
    --out tree does not have -- which is the point, since a run that skipped would never have looked at it.
    """

    def test_a_generated_tree_without_the_mark_is_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            gen = os.path.join(out, "recomp_r0004", "output")
            os.makedirs(gen)
            touch(gen, "half_a_game.cpp")
            p = run_bash(SCRIPT, "--_tail", env=tail_env(tmp, out))
            self.assertNotIn("skipped", p.stdout, "a failed recomp left this tree half-written: " + p.stdout)
            self.assertNotEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_a_generated_tree_that_finished_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            gen = os.path.join(out, "recomp_r0004", "output")
            os.makedirs(gen)
            touch(gen, "a_whole_game.cpp")
            touch(gen, ".complete")
            p = run_bash(SCRIPT, "--_tail", env=tail_env(tmp, out))
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertIn("skipped", p.stdout)
            self.assertIn("stop after recomp", p.stdout)


# A stand-in for ps2_recomp with the two properties issue #57 gave the real one: a file is rewritten only when its
# bytes change, and the function files an earlier run wrote that this one did not are removed. One function file
# per row of step 0's fixed map ("name,hex address"), named the way the emitter names them.
FAKE_RECOMP = r"""#!/bin/sh
set -e
rev="${1#socom2_}"; rev="${rev%.toml}"
[ -z "$FAKE_RECOMP_FAIL" ] || exit 1
mkdir -p output
: > .produced
while IFS=, read -r name addr; do
  f="${name}_0x${addr}.cpp"
  printf 'void %s(uint8_t*, R5900Context*, PS2Runtime*) {}\n' "${name}_0x${addr}" > .next
  if cmp -s .next "output/$f"; then rm -f .next; else mv .next "output/$f"; fi
  echo "$f" >> .produced
done < "build/socom2_ghidra_$rev.fixed.csv"
for f in output/*_0x*.cpp; do
  [ -e "$f" ] || continue
  grep -qxF "$(basename "$f")" .produced || rm -f "$f"
done
"""


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionRecompKeepsItsOutputTest(unittest.TestCase):
    """#57's r0004 leg: step 4 used to `rm -rf` its output directory before ps2_recomp ran, so every file came back
    with a new timestamp and the runtime build after a one-name change recompiled every object -- the incremental
    rebuild the emitter's per-file declarations bought, thrown away. Every case drives the lock-bound tail (--_tail
    with BR_*) through step 4 with the stand-in above named by BR_PS2_RECOMP, and stops after it; with the seam
    set step 4 builds nothing (the last case holds that)."""
    REV = "r0009keep"
    OLD = 1_000_000_000   # a timestamp no run of the stand-in can write

    def _tree(self, tmp, rows):
        out = os.path.join(tmp, "out")
        recomp_dir = os.path.join(out, f"recomp_{self.REV}")
        self._map(recomp_dir, rows)
        fake = os.path.join(tmp, "ps2_recomp")
        with open(fake, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(FAKE_RECOMP)
        os.chmod(fake, 0o755)
        env = tail_env(tmp, out, rev=self.REV)
        env["BR_PS2_RECOMP"] = sh(fake)
        return out, os.path.join(recomp_dir, "output"), env

    def _map(self, recomp_dir, rows):
        path = os.path.join(recomp_dir, "build", f"socom2_ghidra_{self.REV}.fixed.csv")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("".join(f"{name},{addr}\n" for name, addr in rows))

    def _step4(self, env, force):
        env = dict(env, BR_FORCE="1" if force else "0")
        return run_bash(SCRIPT, "--_tail", env=env)

    def test_a_rerun_after_one_name_changed_leaves_the_other_files_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [("entry", "100000"), ("leaf", "100010"), ("sub_00100020", "100020")]
            out, gen, env = self._tree(tmp, rows)
            p = self._step4(env, force=False)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            first = sorted(n for n in os.listdir(gen) if n.endswith(".cpp"))
            self.assertEqual(first, ["entry_0x100000.cpp", "leaf_0x100010.cpp", "sub_00100020_0x100020.cpp"])
            for name in first:
                os.utime(os.path.join(gen, name), (self.OLD, self.OLD))
            self._map(os.path.dirname(gen), rows[:2] + [("renamed", "100020")])
            p = self._step4(env, force=True)   # --force: the .complete mark would skip the step otherwise
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertEqual(sorted(n for n in os.listdir(gen) if n.endswith(".cpp")),
                             ["entry_0x100000.cpp", "leaf_0x100010.cpp", "renamed_0x100020.cpp"])
            for name in ("entry_0x100000.cpp", "leaf_0x100010.cpp"):
                self.assertEqual(os.stat(os.path.join(gen, name)).st_mtime, self.OLD,
                                 f"{name} was rewritten, so its object rebuilds: the output was deleted first")
            self.assertTrue(os.path.isfile(os.path.join(gen, ".complete")))

    def test_a_forced_rerun_that_fails_does_not_keep_the_earlier_runs_mark(self):
        """Without the delete, the previous run's .complete sits in the directory while ps2_recomp runs again;
        a run that fails there must not leave it, or the next build skips a half-rewritten tree."""
        with tempfile.TemporaryDirectory() as tmp:
            out, gen, env = self._tree(tmp, [("entry", "100000")])
            p = self._step4(env, force=False)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertTrue(os.path.isfile(os.path.join(gen, ".complete")))
            p = self._step4(dict(env, FAKE_RECOMP_FAIL="1"), force=True)
            self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
            self.assertFalse(os.path.exists(os.path.join(gen, ".complete")), "a failed recomp kept the old mark")
            p = self._step4(env, force=False)
            self.assertNotIn("skipped", p.stdout, "the next build trusted a tree the failed run left: " + p.stdout)

    def test_with_the_seam_set_step_4_builds_no_recompiler(self):
        """The seam names the recompiler step 4 runs; it must also stop step 4 building the real one. A case that
        ran `cmake -S third_party/ps2recomp -B build-tools` and `cmake --build ... -j $(nproc)` configured and
        built the recompiler outside the loop lock on every suite run where tools/ holds a toolchain -- the script
        puts tools/ at the FRONT of PATH, ahead of any stand-in. So this case runs a copy of the script from a
        synthetic ROOT with no tools/ and no third_party/, puts a cmake that leaves a marker and exits 1 first on
        PATH, and asserts cmake never ran: no marker, no cmake or ninja line, no build-tools directory."""
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "root")
            os.makedirs(os.path.join(root, "scripts"))
            for name in ("build_revision.sh", "python_env.sh"):
                with open(os.path.join(ROOT, "scripts", name), "rb") as src, \
                        open(os.path.join(root, "scripts", name), "wb") as dst:
                    dst.write(src.read())
            out, gen, env = self._tree(tmp, [("entry", "100000")])
            marker = os.path.join(tmp, "cmake-was-called")
            trap = os.path.join(tmp, "trapbin")
            os.makedirs(trap)
            cmake = os.path.join(trap, "cmake")
            with open(cmake, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(f'#!/bin/sh\necho "cmake $*" >> "{sh(marker)}"\nexit 1\n')
            os.chmod(cmake, 0o755)
            env["PATH"] = trap + os.pathsep + env["PATH"]
            p = subprocess.run([BASH, os.path.join("scripts", "build_revision.sh"), "--_tail"],
                               capture_output=True, text=True, cwd=root, env=dict(env, BR_FORCE="0"))
            said = p.stdout + p.stderr
            self.assertFalse(os.path.exists(marker), "step 4 ran cmake with the seam set: " + said)
            self.assertEqual(p.returncode, 0, said)
            for word in ("cmake", "ninja"):
                self.assertNotIn(word, said.lower(), f"step 4 printed a {word} line with the seam set")
            self.assertFalse(os.path.exists(os.path.join(root, "third_party", "ps2recomp", "build-tools")),
                             "step 4 configured build-tools with the seam set")
            self.assertEqual(sorted(n for n in os.listdir(gen) if n.endswith(".cpp")), ["entry_0x100000.cpp"])
            self.assertTrue(os.path.isfile(os.path.join(gen, ".complete")))


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionRepairMapTest(unittest.TestCase):
    """Step 2 repairs the merged ELF against the map steps 3-5 will recompile against.

    The capsule write stack lives beside the revision's capsule (`game/<rev>/decoded/stack.txt`) and
    the map it is resolved against is `$GHIDRA_SRC` when `--ghidra` named one -- which step 3 has not
    yet copied onto `recomp/socom2_ghidra_<rev>.csv`. Reading that copy instead refused a revision
    being bootstrapped with `--ghidra`, and silently repaired against the *old* map when `--ghidra`
    named a new one.

    `r0009repair` is a throwaway revision name. Its stack (under the git-ignored `game/`) and, in one
    case, its own map under `recomp/` are created here and removed again; nothing else reads either.
    Each case stops inside step 2 on the synthetic overlay, well before any lock or toolchain.
    """
    REV = "r0009repair"

    def setUp(self):
        self.stack = os.path.join(ROOT, "game", self.REV, "decoded", "stack.txt")
        os.makedirs(os.path.dirname(self.stack), exist_ok=True)
        with open(self.stack, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("w 80031250 002CC670\nw 80031254 03E00008\n"
                     "w 80031258 002CC674\nw 8003125C 00000000\n"
                     "w 80031260 00000000\nw 80031264 00000000\n")
        self.addCleanup(self._remove_tree, os.path.join(ROOT, "game", self.REV))
        self.own_map = os.path.join(ROOT, "recomp", f"socom2_ghidra_{self.REV}.csv")
        self.addCleanup(self._remove_file, self.own_map)

    @staticmethod
    def _remove_file(path):
        if os.path.isfile(path):
            os.remove(path)

    @staticmethod
    def _remove_tree(path):
        import shutil
        shutil.rmtree(path, ignore_errors=True)

    def _disc(self, tmp):
        """A synthetic tree and an overlays dir that already holds step 1's two products."""
        tree = os.path.join(tmp, "tree")
        zdb = touch(tree, "RUN", "RAW", "APACHE00.ZDB")
        touch(tree, "SCUS_972.75")
        touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
        out = os.path.join(tmp, "out")
        touch(out, f"overlays_{self.REV}", "ftscore.bin")
        touch(out, f"overlays_{self.REV}", "zsealetc.bin")
        return zdb, out

    def _map(self, path, rows):
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("Name,Start,End,Size\n")
            for name, start, end in rows:
                fh.write(f"{name},0x{start:08X},0x{end:08X},{end - start}\n")
        return path

    def test_a_revision_bootstrapped_with_ghidra_is_repaired_against_the_map_it_named(self):
        """It has no map of its own yet -- that is what --ghidra is for -- and step 2 must not
        refuse it by naming the copy step 3 has not made.

        The `repair inputs` line this reads is printed only once step 2 has its twin, and the twin is the
        REAL r0001 image (`game/disc/socom2_game.elf`, git-ignored). On a tree without it step 2 refuses
        first -- correctly, and its own case
        (test_without_the_r0001_image_step_2_says_what_to_build_not_which_file_is_missing) asserts that
        refusal -- so this one has no inputs to run on and SKIPS rather than passing on a checkout that
        never reached the line it is about."""
        if not os.path.isfile(os.path.join(ROOT, "game", "disc", "socom2_game.elf")):
            self.skipTest("needs the r0001 image game/disc/socom2_game.elf (game/ is not in a bare clone)")
        with tempfile.TemporaryDirectory() as tmp:
            zdb, out = self._disc(tmp)
            named = self._map(os.path.join(tmp, "named_map.csv"),
                              [("FUN_002cc5f0", 0x002CC5F0, 0x002CC678)])
            p = run_bash(SCRIPT, self.REV, sh(zdb), "--game", sh(os.path.join(tmp, "tree")),
                         "--ghidra", sh(named), "--out", sh(out))
            self.assertNotIn(f"socom2_ghidra_{self.REV}.csv is not there", p.stderr,
                             "step 2 refused the map step 3 would have written: " + p.stderr)
            self.assertIn("repair inputs", p.stdout, p.stdout + p.stderr)
            self.assertIn("named_map.csv", p.stdout, p.stdout + p.stderr)

    def test_when_ghidra_names_a_new_map_step_2_does_not_use_the_old_one(self):
        """The silent divergence: the ELF repaired against yesterday's map, steps 3-5 compiled
        against today's."""
        with tempfile.TemporaryDirectory() as tmp:
            zdb, out = self._disc(tmp)
            self._map(self.own_map, [("FUN_00100000", 0x00100000, 0x00100028)])
            named = self._map(os.path.join(tmp, "named_map.csv"),
                              [("FUN_002cc5f0", 0x002CC5F0, 0x002CC678)])
            p = run_bash(SCRIPT, self.REV, sh(zdb), "--game", sh(os.path.join(tmp, "tree")),
                         "--ghidra", sh(named), "--out", sh(out))
            self.assertIn("named_map.csv", p.stdout, p.stdout + p.stderr)
            self.assertNotIn(f"map recomp/socom2_ghidra_{self.REV}.csv", p.stdout,
                             "step 2 resolved the repair against the map --ghidra replaces: " + p.stdout)

    def test_the_repair_inputs_line_carries_the_maps_sha256(self):
        """The digest that goes into the sidecar is step 0's FIXED map -- the rows the recompiler
        will compile -- not the source map, which step 0 read and did not write."""
        with tempfile.TemporaryDirectory() as tmp:
            zdb, out = self._disc(tmp)
            named = self._map(os.path.join(tmp, "named_map.csv"),
                              [("FUN_002cc5f0", 0x002CC5F0, 0x002CC678)])
            p = run_bash(SCRIPT, self.REV, sh(zdb), "--game", sh(os.path.join(tmp, "tree")),
                         "--ghidra", sh(named), "--out", sh(out))
            fixed = os.path.join(out, f"recomp_{self.REV}", "build",
                                 f"socom2_ghidra_{self.REV}.fixed.csv")
            self.assertTrue(os.path.isfile(fixed), "step 0 wrote no fixed map: " + p.stdout + p.stderr)
            self.assertIn(sha256_of(fixed), p.stdout,
                          "a map that changes under the image must be visible: " + p.stdout + p.stderr)

    def test_without_the_r0001_image_step_2_says_what_to_build_not_which_file_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            zdb, out = self._disc(tmp)
            named = self._map(os.path.join(tmp, "named_map.csv"),
                              [("FUN_002cc5f0", 0x002CC5F0, 0x002CC678)])
            if os.path.isfile(os.path.join(ROOT, "game", "disc", "socom2_game.elf")):
                self.skipTest("this tree has the r0001 image, so the refusal cannot fire")
            p = run_bash(SCRIPT, self.REV, sh(zdb), "--game", sh(os.path.join(tmp, "tree")),
                         "--ghidra", sh(named), "--out", sh(out))
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("build.sh elf", p.stderr)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionFixedMapTest(unittest.TestCase):
    """Step 0 writes the fixed map to a build PRODUCT; the map it reads is a source and keeps its bytes.

    The fix (non-contiguous ranges cut to size, forced entry points folded in, merge_ranges applied) used to
    run at step 4 over `recomp/socom2_ghidra_<rev>.csv` IN PLACE. So every r0004 build split six rows of the
    tracked map, left `M recomp/socom2_ghidra_r0004.csv` in `git status` for the controller to restore by
    hand, and -- because `<elf>.repair.json` hashes that map as a repair input -- made step 2 call the merged
    image stale on the next build and re-merge it to the same bytes.

    `r0009map` is a throwaway revision name and every path these cases touch is under --out or a temporary
    directory: nothing is written inside the repository, and no case reaches a lock or a toolchain.
    """
    REV = "r0009map"
    ROW = ("FUN_00100000", 0x00100000, 0x00100028)   # one Ghidra row ...
    FORCED = 0x00100010                              # ... that this forced entry point splits in two

    def _tree(self, tmp):
        """A synthetic disc tree, and an out/ that already holds step 1's two products and the map."""
        tree = os.path.join(tmp, "tree")
        zdb = touch(tree, "RUN", "RAW", "APACHE00.ZDB")
        touch(tree, "SCUS_972.75")
        touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
        out = os.path.join(tmp, "out")
        touch(out, f"overlays_{self.REV}", "ftscore.bin")
        touch(out, f"overlays_{self.REV}", "zsealetc.bin")
        source = os.path.join(out, f"recomp_{self.REV}", f"socom2_ghidra_{self.REV}.csv")
        os.makedirs(os.path.dirname(source), exist_ok=True)
        name, start, end = self.ROW
        with open(source, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("Name,Start,End,Size\n")
            fh.write(f"{name},0x{start:08X},0x{end:08X},{end - start}\n")
        extra = os.path.join(tmp, "extra.txt")
        with open(extra, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f"0x{self.FORCED:08X}\n")
        return tree, zdb, out, source, extra

    def _run(self, tmp):
        tree, zdb, out, source, extra = self._tree(tmp)
        before = read_bytes(source)
        p = run_bash(SCRIPT, self.REV, sh(zdb), "--game", sh(tree), "--out", sh(out),
                     "--extra", sh(extra), "--stop-after", "elf")
        fixed = os.path.join(out, f"recomp_{self.REV}", "build", f"socom2_ghidra_{self.REV}.fixed.csv")
        return p, source, before, fixed

    def test_the_map_the_step_read_is_not_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, source, before, _ = self._run(tmp)
            self.assertEqual(before, read_bytes(source),
                             "step 0 rewrote the map it read -- that is the `M recomp/socom2_ghidra_r0004.csv` "
                             "a build used to leave behind: " + p.stdout + p.stderr)

    def test_the_fixed_rows_go_to_a_build_product(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, source, _, fixed = self._run(tmp)
            self.assertTrue(os.path.isfile(fixed), "step 0 wrote no fixed map: " + p.stdout + p.stderr)
            name, start, end = self.ROW
            self.assertIn(f"0x{start:08X},0x{end:08X}", read_bytes(source).decode(),
                          "the source map lost its unsplit row")
            body = read_bytes(fixed).decode()
            self.assertIn(f"0x{start:08X},0x{self.FORCED:08X}", body,
                          "the fixed map does not hold the truncated parent row: " + body)
            self.assertIn(f"0x{self.FORCED:08X},0x{end:08X}", body,
                          "the fixed map does not hold the forced entry point's row: " + body)

    def test_the_run_names_the_product_and_the_source_it_did_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, _, _, fixed = self._run(tmp)
            self.assertIn("was not written", p.stdout, p.stdout + p.stderr)
            self.assertIn(f"socom2_ghidra_{self.REV}.fixed.csv", p.stdout, p.stdout + p.stderr)

    def test_the_dry_run_prints_the_step_and_where_its_product_goes(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("step 0  map", p.stdout)
        self.assertIn("recomp/build/socom2_ghidra_r0004.fixed.csv", p.stdout)
        self.assertIn("the tracked map is never written", p.stdout)

    def test_the_lock_bound_tail_refuses_when_step_0_left_no_fixed_map(self):
        """Step 4 reads that map and no longer writes one, so the tail entered on its own says so rather
        than falling back to rewriting the tracked map the way it used to."""
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            gen = os.path.join(out, f"recomp_{self.REV}", "output")
            os.makedirs(gen)
            env = tail_env(tmp, out, rev=self.REV)
            p = run_bash(SCRIPT, "--_tail", env=env)
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("fixed.csv", p.stderr)
            self.assertIn("Step 0 writes it", p.stderr)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionNamesSidecarTest(unittest.TestCase):
    """#48: with `--out <dir>` step 3 wrote a toml under `<dir>/recomp_<rev>/` whose `[general] names` is relative
    to that directory, and nothing put the sidecar there -- so the recompiler found no names file and every function
    came out FUN_/sub_ behind an info line. The sidecar is now placed beside the toml at step 0 (lock-free, before
    the eight minutes of step 1), and the toml names exactly the file placed.

    Step 3 itself cannot be reached without a disc (step 2 merges a real loader), so the value it writes is held
    textually: both of its paths write `$TOML_NAMES`, the name step 0 settled and placed. `r0009names` is a
    throwaway revision whose sidecar is created under recomp/ here and removed again.
    """
    REV = "r0009names"

    def setUp(self):
        self.sidecar = os.path.join(ROOT, "recomp", f"socom2_names_{self.REV}.csv")
        with open(self.sidecar, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("Address,Name,Evidence,Pass,Score\n0x00100000,test_Name,here,hand,\n")
        self.addCleanup(os.remove, self.sidecar)

    def _run(self, tmp, rev=None):
        rev = rev or self.REV
        tree = os.path.join(tmp, "tree")
        zdb = touch(tree, "RUN", "RAW", "APACHE00.ZDB")
        touch(tree, "SCUS_972.75")
        touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
        out = os.path.join(tmp, "out")
        touch(out, f"overlays_{rev}", "ftscore.bin")
        touch(out, f"overlays_{rev}", "zsealetc.bin")
        named = os.path.join(tmp, "map.csv")
        with open(named, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("Name,Start,End,Size\nFUN_00100000,0x00100000,0x00100028,40\n")
        extra = os.path.join(tmp, "extra.txt")
        with open(extra, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("")
        p = run_bash(SCRIPT, rev, sh(zdb), "--game", sh(tree), "--out", sh(out),
                     "--ghidra", sh(named), "--extra", sh(extra), "--stop-after", "elf")
        return p, os.path.join(out, f"recomp_{rev}")

    def test_out_places_the_sidecar_beside_the_toml(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, recomp_dir = self._run(tmp)
            placed = os.path.join(recomp_dir, f"socom2_names_{self.REV}.csv")
            self.assertTrue(os.path.isfile(placed),
                            "the toml under --out names a sidecar nothing put beside it (#48): "
                            + p.stdout + p.stderr)
            self.assertEqual(read_bytes(placed), read_bytes(self.sidecar))
            self.assertIn(f"names: recomp/socom2_names_{self.REV}.csv", p.stdout, p.stdout + p.stderr)

    def test_a_revision_without_a_sidecar_is_warned_not_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, _ = self._run(tmp, rev="r0009nonames")
            self.assertIn("WARNING: r0009nonames has no names sidecar", p.stderr, p.stdout + p.stderr)

    def test_step_3_names_the_file_step_0_placed_on_both_paths(self):
        with open(os.path.join(ROOT, SCRIPT), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('--set-names "$TOML_NAMES"', text)
        self.assertIn('names = \\"$TOML_NAMES\\"', text)
        self.assertIn('cp "$NAMES_SRC" "$RECOMP_DIR/$TOML_NAMES"', text)

    def test_the_dry_run_says_where_the_names_come_from(self):
        p = run_bash(SCRIPT, "r0004", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("names recomp/socom2_names_r0004.csv", p.stdout)

    def test_an_r0001_check_build_reads_r0001s_own_sidecar(self):
        # r0001check is the r0001 disc under another name; its toml used to name socom2_names_r0001check.csv,
        # which exists nowhere, so even an in-tree check build lost its names.
        p = run_bash(SCRIPT, "r0001check", EMPTY_ZDB, "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("names recomp/socom2_names.csv", p.stdout)


@unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
class BuildRevisionOutReadsTheTreeTest(unittest.TestCase):
    """#56: under `--out <dir>` the out layout took two inputs from the out folder that belong to the tree.

    The function map was looked for at `<dir>/recomp_<rev>/socom2_ghidra_<rev>.csv` -- a copy step 3 makes, so a
    first out run refused the revision unless `--ghidra` named the tracked map. And step 1 decrypted the disc tree
    it was given into `<dir>/overlays_<rev>/` even when the tree's own `game/overlays_<rev>/` already held current
    products; on the machine where r0004's overlays come from the capsule and `game/disc_r0004/RUN` is a junction
    into r0001's disc, that decrypted r0001's package and the merged ELF mismatched.

    "Current" is what `<elf>.repair.json` records: the sha256 of every repair input (the capsule stack, the r0001
    twin, both function maps, the three modules), held to this run's inputs by `tools_py.overlay_repair --check`
    -- the same test step 2 skips on. The sidecar records no disc input (no package, no loader), so the disc tree
    given is not part of the match; a package digest could not be one anyway, because the r0004 overlays this
    machine builds from were never decrypted from a package.

    Each case builds a disc tree whose loader is not `SCUS_972.75`, so a run that decides to decrypt stops at step 1's refusal
    in a second instead of starting Unicorn -- which is also how a case sees that the decrypt was attempted.
    Throwaway revision names; what is created under `recomp/` and `game/` (both removed again) nothing else reads.
    """

    def _tree(self, tmp):
        tree = os.path.join(tmp, "tree")
        zdb = touch(tree, "RUN", "RAW", "APACHE00.ZDB")
        touch(tree, "SLES_512.34")      # a loader, but not the one step 1 can decrypt with
        touch(tree, "OVERLAY", "REL", "DNAS.dec.bin")
        extra = os.path.join(tmp, "extra.txt")
        with open(extra, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("")
        return tree, zdb, extra

    @staticmethod
    def _map(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("Name,Start,End,Size\nFUN_00100000,0x00100000,0x00100028,40\n")
        return path

    @staticmethod
    def _remove_file(path):
        if os.path.isfile(path):
            os.remove(path)

    @staticmethod
    def _remove_tree(path):
        import shutil
        shutil.rmtree(path, ignore_errors=True)

    # ---- (a) the map --------------------------------------------------------------------------------------------

    def test_out_without_ghidra_reads_the_trees_map(self):
        rev = "r0009outmap"
        tracked = self._map(os.path.join(ROOT, "recomp", f"socom2_ghidra_{rev}.csv"))
        self.addCleanup(self._remove_file, tracked)
        with tempfile.TemporaryDirectory() as tmp:
            tree, zdb, extra = self._tree(tmp)
            p = run_bash(SCRIPT, rev, sh(zdb), "--game", sh(tree), "--out", sh(os.path.join(tmp, "out")),
                         "--extra", sh(extra), "--stop-after", "elf")
        self.assertNotIn("has no function map of its own", p.stderr,
                         "--out looked for the map in the out folder, not the tree (#56): " + p.stderr)
        self.assertIn(f"map: recomp/socom2_ghidra_{rev}.csv", p.stdout, p.stdout + p.stderr)

    def test_the_out_dry_run_says_the_map_comes_from_the_tree(self):
        rev = "r0009outmap"
        tracked = self._map(os.path.join(ROOT, "recomp", f"socom2_ghidra_{rev}.csv"))
        self.addCleanup(self._remove_file, tracked)
        with tempfile.TemporaryDirectory() as tmp:
            p = run_bash(SCRIPT, rev, EMPTY_ZDB, "--out", sh(os.path.join(tmp, "out")), "--dry-run")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn(f"copied from recomp/socom2_ghidra_{rev}.csv", p.stdout, p.stdout)
        self.assertNotIn("the run will refuse it", p.stdout, p.stdout)

    def test_ghidra_still_overrides_the_trees_map(self):
        rev = "r0009outmap"
        tracked = self._map(os.path.join(ROOT, "recomp", f"socom2_ghidra_{rev}.csv"))
        self.addCleanup(self._remove_file, tracked)
        with tempfile.TemporaryDirectory() as tmp:
            tree, zdb, extra = self._tree(tmp)
            named = self._map(os.path.join(tmp, "named_map.csv"))
            p = run_bash(SCRIPT, rev, sh(zdb), "--game", sh(tree), "--out", sh(os.path.join(tmp, "out")),
                         "--extra", sh(extra), "--ghidra", sh(named), "--stop-after", "elf")
        self.assertIn("named_map.csv + forced entry points", p.stdout, p.stdout + p.stderr)
        self.assertNotIn(f"map: recomp/socom2_ghidra_{rev}.csv", p.stdout, p.stdout)

    # ---- (b) the overlays ---------------------------------------------------------------------------------------

    def _tree_overlays(self, rev, stale=False):
        """game/<overlays_rev>/ as a finished in-tree build leaves it: both overlays, the merged ELF and its
        sidecar. The revision has no capsule stack, so this run's repair inputs are the three modules alone."""
        from tools_py import overlay_repair
        import json
        d = os.path.join(ROOT, "game", f"overlays_{rev}")
        self.addCleanup(self._remove_tree, d)
        os.makedirs(d, exist_ok=True)
        blobs = {"ftscore.bin": b"FTS" * 100, "zsealetc.bin": b"ZSE" * 90,
                 f"socom2_game_{rev}.elf": b"\x7fELF" + b"merged" * 50}
        for name, data in blobs.items():
            with open(os.path.join(d, name), "wb") as fh:
                fh.write(data)
        sources = overlay_repair.source_digests({})
        if stale:
            sources["make_overlay_elf.py"]["sha256"] = "0" * 64
        with open(os.path.join(d, f"socom2_game_{rev}.elf.repair.json"), "w", encoding="utf-8") as fh:
            json.dump({"image": f"socom2_game_{rev}.elf", "notes": [], "repairs": [], "sources": sources}, fh)
        return d, blobs

    def _run_out(self, tmp, rev, check=None):
        tree, zdb, extra = self._tree(tmp)
        named = self._map(os.path.join(tmp, "named_map.csv"))
        out = os.path.join(tmp, "out")
        args = [SCRIPT, rev, sh(zdb), "--game", sh(tree), "--out", sh(out), "--extra", sh(extra),
                "--ghidra", sh(named), "--stop-after", "elf"]
        if check:
            args += ["--check-against", sh(check)]
        return run_bash(*args), os.path.join(out, f"overlays_{rev}")

    def test_out_reuses_the_trees_current_overlays_instead_of_decrypting(self):
        rev = "r0009reuse"
        d, blobs = self._tree_overlays(rev)
        with tempfile.TemporaryDirectory() as tmp:
            p, out_overlays = self._run_out(tmp, rev, check=os.path.join(d, f"socom2_game_{rev}.elf"))
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertNotIn("decrypt: running", p.stdout, p.stdout)
            self.assertNotIn("SCUS_972.75", p.stderr, "step 1 decrypted again: " + p.stderr)
            self.assertIn(f"overlays: game/overlays_{rev}/ is current", p.stdout, p.stdout)
            for name, data in blobs.items():
                self.assertEqual(read_bytes(os.path.join(out_overlays, name)), data, name)
            self.assertIn("check-against: identical", p.stdout, p.stdout + p.stderr)

    def test_out_decrypts_again_when_the_trees_sidecar_is_stale(self):
        rev = "r0009stale"
        self._tree_overlays(rev, stale=True)
        with tempfile.TemporaryDirectory() as tmp:
            p, out_overlays = self._run_out(tmp, rev)
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn(f"overlays: game/overlays_{rev}/ not reused", p.stdout, p.stdout)
            self.assertIn("make_overlay_elf.py changed", p.stdout, p.stdout)
            self.assertIn("SCUS_972.75", p.stderr, "the stale tree products were not decrypted again: " + p.stderr)
            self.assertFalse(os.path.exists(os.path.join(out_overlays, "ftscore.bin")))

    def test_out_decrypts_again_when_the_map_under_the_image_changed(self):
        """A revision WITH a capsule stack: the sidecar records the fixed map's sha256 among its inputs, and a map
        that is not the one the image was repaired against makes the tree's products stale -- decrypt again."""
        from tools_py import overlay_repair
        import json
        twin = os.path.join(ROOT, "game", "disc", "socom2_game.elf")
        if not os.path.isfile(twin):
            self.skipTest("needs the r0001 image game/disc/socom2_game.elf (step 2's repair inputs refuse without it)")
        rev = "r0009remap"
        stack = os.path.join(ROOT, "game", rev, "decoded", "stack.txt")
        self.addCleanup(self._remove_tree, os.path.join(ROOT, "game", rev))
        os.makedirs(os.path.dirname(stack), exist_ok=True)
        with open(stack, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("w 80031250 002CC670\nw 80031254 03E00008\n")
        d, _ = self._tree_overlays(rev)
        sources = overlay_repair.source_digests({
            "stub-writes": stack, "twin": twin, "twin-rows": os.path.join(ROOT, "recomp", "socom2_ghidra.csv"),
            "rows": stack})      # any file: its digest is then overwritten with one no fixed map has
        sources["rows"]["sha256"] = "f" * 64
        sidecar = os.path.join(d, f"socom2_game_{rev}.elf.repair.json")
        with open(sidecar, "w", encoding="utf-8") as fh:
            json.dump({"image": f"socom2_game_{rev}.elf", "notes": [], "repairs": [], "sources": sources}, fh)
        with tempfile.TemporaryDirectory() as tmp:
            p, out_overlays = self._run_out(tmp, rev)
            self.assertIn("repair inputs -- stack", p.stdout, p.stdout + p.stderr)
            self.assertIn(f"overlays: game/overlays_{rev}/ not reused -- rows changed", p.stdout, p.stdout)
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("SCUS_972.75", p.stderr, "the stale tree products were not decrypted again: " + p.stderr)
            self.assertFalse(os.path.exists(os.path.join(out_overlays, "ftscore.bin")))

    def test_out_that_already_holds_overlays_is_not_overwritten_and_says_so(self):
        rev = "r0009held"
        self._tree_overlays(rev)
        with tempfile.TemporaryDirectory() as tmp:
            out_overlays = os.path.join(tmp, "out", f"overlays_{rev}")
            os.makedirs(out_overlays)
            for name in ("ftscore.bin", "zsealetc.bin"):
                with open(os.path.join(out_overlays, name), "wb") as fh:
                    fh.write(b"already here")
            p, _ = self._run_out(tmp, rev)
            self.assertIn("already holds ftscore.bin and zsealetc.bin -- the tree's are not copied "
                          "(delete them, or --force)", p.stdout, p.stdout + p.stderr)
            self.assertEqual(read_bytes(os.path.join(out_overlays, "ftscore.bin")), b"already here")
            self.assertFalse(os.path.exists(os.path.join(out_overlays, f"socom2_game_{rev}.elf.repair.json")))

    def test_the_reuse_copy_is_staged_with_the_sidecar_last(self):
        rev = "r0009stage"
        self._tree_overlays(rev)
        with tempfile.TemporaryDirectory() as tmp:
            p, out_overlays = self._run_out(tmp, rev)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertEqual([n for n in os.listdir(out_overlays) if n.startswith(".reuse.")], [],
                             "the staging directory was left behind")
        with open(os.path.join(ROOT, SCRIPT), encoding="utf-8") as fh:
            text = fh.read()
        block = text[text.index('STAGE="$OVERLAYS/.reuse.$$"'):text.index('rmdir "$STAGE"')]
        self.assertLess(block.index('"$STAGE/socom2_game_$REV.elf" "$OVERLAYS/"'),
                        block.index('mv "$STAGE/socom2_game_$REV.elf.repair.json"'),
                        "the repair.json must arrive last: its presence marks the copy complete")

    def test_out_decrypts_when_the_tree_holds_no_products(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, out_overlays = self._run_out(tmp, "r0009none")
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("SCUS_972.75", p.stderr, p.stdout + p.stderr)
            self.assertFalse(os.path.exists(os.path.join(out_overlays, "ftscore.bin")))


class RecompNamesLineIsSurfacedTest(unittest.TestCase):
    """#48's other half: a names path that does not resolve is a WARNING in the recompiler, and build.sh's recomp
    step (and build_revision's step 4) print the log's `names` events, so it is seen and not buried in the log."""
    CPP = os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRecomp", "src", "lib", "ps2_recompiler.cpp")
    LOG = ("  [info] other - something\n"
           "  [warning] names - names file does not resolve: socom2_names_r0004.csv (relative to the directory "
           "ps2_recomp runs in); every function keeps its function-map name (FUN_/sub_ placeholders)\n"
           "  [info] names - Loaded 1736 display names from socom2_names_r0004.csv\n")

    def test_the_recompiler_warns_on_a_names_path_that_does_not_resolve(self):
        with open(self.CPP, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('m_reporter.warning("names", "names file does not resolve: "', text)

    def test_the_generated_header_names_its_source_not_an_identity(self):
        # research/59 section 3: `X (identity Y)` read as an alias; the header now points at the sidecar row.
        # ps2xTest's "display names come from the sidecar" case holds the bytes; this holds the wording in CI.
        emitter = os.path.join(ROOT, "third_party", "ps2recomp", "ps2xRecomp", "src", "lib", "function_emitter.cpp")
        with open(emitter, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('"// Name source: "', text)
        self.assertIn('" (map name "', text)
        self.assertNotIn('" (identity "', text)

    def _surfacing_line(self, script, log_var):
        with open(os.path.join(ROOT, script), encoding="utf-8") as fh:
            lines = [ln for ln in fh if "names - " in ln and log_var in ln and ln.lstrip().startswith("grep")]
        self.assertEqual(len(lines), 1, "%s surfaces no `names` events of the recompiler log" % script)
        return lines[0]

    @unittest.skipUnless(BASH, "needs a bash that is not WSL's launcher")
    def test_build_sh_recomp_prints_the_names_events(self):
        line = self._surfacing_line("build.sh", '"$ROOT/recomp/recomp_run.log"')
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "recomp_run.log")
            with open(log, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(self.LOG)
            p = subprocess.run([BASH, "-c", line.replace('"$ROOT/recomp/recomp_run.log"', '"%s"' % sh(log))],
                               capture_output=True, text=True, cwd=ROOT)
        self.assertIn("WARNING: names: names file does not resolve: socom2_names_r0004.csv", p.stdout, p.stderr)
        self.assertIn("recomp: names: Loaded 1736 display names", p.stdout, p.stderr)
        self.assertNotIn("other", p.stdout)

    def test_build_revision_step_4_prints_the_names_events(self):
        self._surfacing_line(SCRIPT, '"$RECOMP_DIR/recomp_run_$REV.log"')


@unittest.skipUnless(os.path.isfile(os.path.join(ROOT, "recomp", "socom2_r0004.toml")),
                     "this tree has no recomp/socom2_r0004.toml")
class RevisionTomlReadsTheBuildProductTest(unittest.TestCase):
    """`recomp/socom2_r0004.toml` is TRACKED and step 3 rewrites it on every build, so everything that
    file says has to be true in every clone -- otherwise the dirty-working-tree defect this task fixed in
    the CSV simply moves one file over."""
    PATH = os.path.join(ROOT, "recomp", "socom2_r0004.toml")

    def test_the_tracked_r0004_config_names_the_fixed_map(self):
        with open(self.PATH, encoding="utf-8") as fh:
            lines = [ln.strip() for ln in fh if ln.strip().startswith("ghidra_output")]
        self.assertEqual(lines, ['ghidra_output = "build/socom2_ghidra_r0004.fixed.csv"'], lines)

    def test_the_tracked_r0004_config_names_its_own_sidecar(self):
        # Step 3 rewrites this file from socom2.toml; r0001's socom2_names.csv would label r0004's addresses.
        with open(self.PATH, encoding="utf-8") as fh:
            lines = [ln.split("#")[0].strip() for ln in fh if ln.strip().startswith("names")]
        self.assertEqual(lines, ['names = "socom2_names_r0004.csv"'], lines)

    def test_step_3_sets_the_revisions_own_sidecar_on_both_paths(self):
        # Both paths write $TOML_NAMES, which for r0004 is its own sidecar's basename (the dry run prints it).
        with open(os.path.join(ROOT, SCRIPT), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('NAMES_SRC="$ROOT/recomp/socom2_names_$REV.csv"', text)
        self.assertIn('TOML_NAMES="$(basename "$NAMES_SRC")"', text)

    def test_the_tracked_r0004_config_carries_no_machines_absolute_path(self):
        import re
        with open(self.PATH, encoding="utf-8") as fh:
            hits = [ln.rstrip() for ln in fh if re.search(r"[A-Za-z]:[\\/]", ln)]
        self.assertEqual(hits, [], "this file dirties on every other machine: %r" % hits)


@unittest.skipUnless(
    os.path.isfile(os.path.join(ROOT, "game", "overlays_r0004",
                                "socom2_game_r0004.elf.repair.json"))
    and os.path.isfile(os.path.join(ROOT, "recomp", "build", "socom2_ghidra_r0004.fixed.csv")),
    "this tree has no built r0004 image beside its fixed map")
class RepairSidecarRecordsTheBuildProductTest(unittest.TestCase):
    """The sidecar beside the merged ELF decides whether the next build re-merges it, and one of the inputs
    it hashes is the function map. It has to be the FIXED map -- a file derived from sources on every run --
    and not a tracked file a build edits under the image, which is what made the old sidecar call the image
    stale on every second build.

    This reads the real products in the tree (both are git-ignored, so the case skips where they are absent);
    the hermetic half of the same claim is the repair-inputs line asserted in BuildRevisionRepairMapTest.
    """
    SIDECAR = os.path.join(ROOT, "game", "overlays_r0004", "socom2_game_r0004.elf.repair.json")
    FIXED = os.path.join(ROOT, "recomp", "build", "socom2_ghidra_r0004.fixed.csv")

    def rows(self):
        import json
        with open(self.SIDECAR, encoding="utf-8") as fh:
            return json.load(fh)["sources"]["rows"]

    def test_the_rows_input_is_the_fixed_map_not_the_tracked_one(self):
        path = self.rows()["path"].replace("\\", "/")
        self.assertTrue(path.endswith("recomp/build/socom2_ghidra_r0004.fixed.csv"), path)
        self.assertNotIn("recomp/socom2_ghidra_r0004.csv", path)

    def test_the_rows_digest_is_the_fixed_maps_own(self):
        self.assertEqual(self.rows()["sha256"], sha256_of(self.FIXED))


if __name__ == "__main__":
    unittest.main()
