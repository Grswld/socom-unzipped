"""Sprint 10 Q1b: the gate states what it measured, and refuses to score when a pinned input drifted.

Before this, summary.txt pinned one thing (the EXE line) and every other input the score depends on could
change with no record: the reference images, the memory card the run boots from, the drive scripts, the
harness revision, the PS2X_* environment. A silently-changed reference image moves every score with no
record that anything moved -- the sibling of the docs/HAZARDS.md harness hazard, once HANDOFF trap 4 (the pipeline cannot see a defect present in
every run; it cannot see a change in its own standard either).

tools_py/parity/pins.py is the mechanism (hash, compare, lines, files); gate.collect_pins names the gate's
set. scripts/parity/pins.json is the committed standard. A launch whose pins do not match it is REFUSED
(exit 7, distinct from a stage FAIL's 1) unless --accept-pins rewrites the standard; --baseline compares the
stamp's recorded pins too. The mapping hash (Q3b) is read off a `[socom2] input mapping sha256=` game-log
line when one exists, and recorded as absent otherwise.
"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tools_py.parity import gate, pins

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# A stand-in game image carrying only a build banner, which is all launch_revision reads.
BANNER_STAND_IN = b"\x7fELF" + b"\0" * 64 + b"SOCOM 2 %s\0" + b"\0" * 64
REAL_EXPECTED = os.path.join(ROOT, "scripts", "parity", "pins.json")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class TreeAndFileHashes(unittest.TestCase):
    def test_a_text_file_pins_the_same_with_crlf_and_lf_line_endings(self):
        """The first merge of this mechanism refused to score on the main tree: three drive scripts had "drifted"
        because the worktree that generated the standard checked them out with CRLF (core.autocrlf) and the main
        tree holds them with LF -- the same content, different bytes. A text pin is of the content, not the
        checkout; a binary pin (a PNG) is of the bytes."""
        with tempfile.TemporaryDirectory() as d:
            lf, crlf, png = (os.path.join(d, n) for n in ("a.txt", "b.txt", "c.png"))
            with open(lf, "wb") as fh:
                fh.write(b"hold:W 3.0\npress:X\n")
            with open(crlf, "wb") as fh:
                fh.write(b"hold:W 3.0\r\npress:X\r\n")
            with open(png, "wb") as fh:
                fh.write(b"\x89PNG\r\n\x1a\n\x00\x00\r\n")
            self.assertEqual(pins.file_sha256(lf), pins.file_sha256(crlf))
            self.assertEqual(pins.file_sha256(lf), _sha(b"hold:W 3.0\npress:X\n"))
            self.assertEqual(pins.file_sha256(png), _sha(b"\x89PNG\r\n\x1a\n\x00\x00\r\n"), "binary bytes untouched")

    def test_a_directory_pins_as_the_sorted_manifest_of_its_files(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            for root, order in ((a, ("x.bin", "sub/y.bin")), (b, ("sub/y.bin", "x.bin"))):
                for rel in order:
                    p = os.path.join(root, rel)
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    with open(p, "wb") as f:
                        f.write(rel.encode())
            ha, na = pins.tree_sha256(a)
            hb, nb = pins.tree_sha256(b)
            self.assertEqual((ha, na), (hb, 2), "creation order must not matter")
            with open(os.path.join(b, "x.bin"), "ab") as f:
                f.write(b"!")
            self.assertNotEqual(pins.tree_sha256(b)[0], ha, "a byte changed")
            os.rename(os.path.join(a, "x.bin"), os.path.join(a, "z.bin"))
            self.assertNotEqual(pins.tree_sha256(a)[0], hb, "a name changed")

    def test_the_manifest_is_the_documented_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "f"), "wb") as f:
                f.write(b"abc")
            expected = _sha(("f\0%s\n" % _sha(b"abc")).encode())
            self.assertEqual(pins.tree_sha256(tmp), (expected, 1))

    def test_a_missing_file_or_directory_pins_as_none_and_says_so(self):
        p = pins.file_pin("nope", os.path.join("no", "such", "file.png"))
        self.assertIsNone(p.sha256)
        self.assertIn("missing", p.detail)
        t = pins.tree_pin("card", os.path.join("no", "such", "dir"))
        self.assertIsNone(t.sha256)
        self.assertIn("missing", t.detail)


class EnvPin(unittest.TestCase):
    def test_covers_the_ps2x_variables_only_and_not_the_card_path(self):
        env = {"PS2X_B": "2", "PS2X_A": "1", "PS2X_MC_DIR": "C:/somewhere", "PATH": "x", "SOCOM_EXE": "y"}
        p = pins.env_pin(env)
        self.assertEqual(p.detail, ["PS2X_A=1", "PS2X_B=2"])
        self.assertEqual(p.sha256, _sha(b"PS2X_A=1\nPS2X_B=2\n"))
        env["PS2X_MC_DIR"] = "/elsewhere"
        self.assertEqual(pins.env_pin(env).sha256, p.sha256, "the card's path is the card pin's business")
        env["PS2X_A"] = "3"
        self.assertNotEqual(pins.env_pin(env).sha256, p.sha256)

    def test_the_gates_own_launch_environment_is_what_is_pinned(self):
        """collect_pins hashes the environment the mission stage (the widest) would be launched with: the
        gate's own knobs plus whatever PS2X_* the operator exported. An empty shell gives the standard.

        `base={}` is an empty shell, so nothing in it names an image: the comparison side asks for
        `default_ok=True` by name, exactly as `collect_pins` does at its own call (review F3). Without it
        this case is a launch-shaped question asked on a checkout with no game -- i.e. every CI runner --
        and it raised there rather than measuring anything."""
        current = gate.collect_pins(base={})
        self.assertEqual(current["env"].detail, [
            "PS2X_HOST_GAMEPAD=0",
            "PS2X_PC_SAMPLER=1",
            "PS2X_PEEK=" + gate.launch_env("mission", "card", base={}, default_ok=True)["PS2X_PEEK"],
            "PS2X_VU_STATS=1"])   # Sprint 17 F0: the [vu1-stats] line the SYNCV line reads
        drifted = gate.collect_pins(base={"PS2X_GS_STATS": "1"})
        self.assertNotEqual(drifted["env"].sha256, current["env"].sha256)
        self.assertIn("PS2X_GS_STATS=1", drifted["env"].detail)


class PinnedInputs(unittest.TestCase):
    def test_script_refs_are_the_references_a_drive_script_names(self):
        refs = gate.script_refs(os.path.join(ROOT, "scripts", "parity", "gameplay_probe.txt"))
        self.assertEqual(refs, ["scripts/parity/ref_save_prompt_ours.png", "scripts/parity/ref_hud_ours.png"])
        self.assertEqual(gate.script_refs(os.path.join(ROOT, "scripts", "parity", "title_menu.txt")),
                         ["scripts/parity/ref_main_menu_ours.png"])

    def test_script_refs_resolve_a_per_target_sibling(self):
        """drive.ref_for_target reads `<stem>.ours.png` when one exists beside the named file, so THAT file
        is the input, and its appearance must show up as a new pin name (an unpinned input), not hide."""
        with tempfile.TemporaryDirectory() as tmp:
            sub = os.path.join(tmp, "scripts", "parity")
            os.makedirs(sub)
            for name in ("ref_a.png", "ref_a.ours.png"):
                with open(os.path.join(sub, name), "wb") as f:
                    f.write(b"x")
            script = os.path.join(sub, "s.txt")
            with open(script, "w") as f:
                f.write("untilref(scripts/parity/ref_a.png)+1.0:CROSS\n")
            with mock.patch.object(gate, "ROOT", tmp):
                self.assertEqual(gate.script_refs(script), ["scripts/parity/ref_a.ours.png"])

    def test_the_pinned_files_are_the_exact_set_the_three_stages_read(self):
        self.assertEqual(gate.pinned_files(), [
            "scripts/parity/title_menu.txt",
            "scripts/parity/ref_main_menu_ours.png",
            "scripts/parity/transition_probe.txt",
            "scripts/parity/ref_save_prompt_ours.png",
            "scripts/parity/ref_briefing_ours.png",
            "scripts/parity/gameplay_probe.txt",
            "scripts/parity/ref_hud_ours.png",
            "scripts/parity/ref_popup_prompt_ours.png",
            "scripts/parity/refs/console_spawn_slot8.png",
            "scripts/parity/refs/mission_failure_banner.png",
            "scripts/parity/guest_probe_console.json",
        ])
        for rel in gate.pinned_files():
            self.assertTrue(os.path.isfile(os.path.join(ROOT, rel)), rel)

    def test_collect_pins_names_every_input_and_the_record_only_ones(self):
        current = gate.collect_pins(base={})
        self.assertEqual(list(current)[:11], gate.pinned_files())
        self.assertEqual(list(current)[11:], ["card", "env", "harness", "mapping"])
        for rel in gate.pinned_files():
            self.assertEqual(current[rel].sha256, pins.file_sha256(os.path.join(ROOT, rel)), rel)
        self.assertEqual(len(current["harness"].sha256), 64)
        self.assertIn("git", current["harness"].detail)
        self.assertIsNone(current["mapping"].sha256)
        self.assertEqual(pins.RECORD_ONLY, ("harness",))

    def test_the_card_is_the_one_the_run_would_boot_from(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "SCRATCHPAD.DAT"), "wb") as f:
                f.write(b"card")
            mine = gate.collect_pins(base={"PS2X_MC_DIR": tmp})["card"]
            self.assertEqual(mine.sha256, pins.tree_sha256(tmp)[0])
            self.assertIn(tmp.replace("\\", "/"), mine.detail)
            self.assertIn("1 file", mine.detail)
        pristine = gate.collect_pins(base={})["card"]
        self.assertIn("game/disc/mc0_parity", pristine.detail)


class MappingHook(unittest.TestCase):
    """Q3b's hook: the runtime will print `[socom2] input mapping sha256=<hex>`; the gate pins it as `mapping`
    when the line is in a game log and records `absent` (no refusal) when it is not."""

    def test_present_in_a_game_log_is_pinned(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "mission.game.log")
            with open(log, "w") as f:
                f.write("[socom2] boot\n[socom2] input mapping sha256=" + "ab" * 32 + "\n[peek] 1 2 3\n")
            p = pins.mapping_pin([log])
            self.assertEqual(p.sha256, "ab" * 32)
            self.assertIn("mission.game.log", p.detail)

    def test_the_runtimes_own_spelling_is_pinned(self):
        """What socom2_host_input.cpp actually prints (Q3b, agent/input): `hash=` and sixteen hex digits with the
        default/custom word after it -- the design's `sha256=` spelling is read too."""
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "title.game.log")
            with open(log, "w") as f:
                f.write("[socom2] boot\n[socom2] input mapping hash=c393b87b99732a1f (default)\n")
            p = pins.mapping_pin([log])
            self.assertEqual(p.sha256, "c393b87b99732a1f")

    def test_absent_is_recorded_as_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "title.game.log")
            with open(log, "w") as f:
                f.write("[socom2] boot\n")
            p = pins.mapping_pin([log, os.path.join(tmp, "no.log")])
            self.assertIsNone(p.sha256)
            self.assertEqual(p.detail, "absent")
        self.assertEqual(pins.mapping_pin([]).detail, "absent")

    def test_two_stages_disagreeing_is_its_own_finding(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name, h in (("title", "aa" * 32), ("mission", "bb" * 32)):
                with open(os.path.join(tmp, name + ".game.log"), "w") as f:
                    f.write("[socom2] input mapping sha256=%s\n" % h)
            p = pins.mapping_pin([os.path.join(tmp, "title.game.log"), os.path.join(tmp, "mission.game.log")])
            self.assertIsNone(p.sha256)
            self.assertIn("differs", p.detail)


class Compare(unittest.TestCase):
    def _pins(self, **kw):
        return {k: pins.Pin(k, v, "") for k, v in kw.items()}

    def test_names_changed_missing_and_unpinned_inputs(self):
        current = self._pins(a="1", b="2", c="3", harness="h", mapping=None)
        drifts = pins.compare(current, {"a": "1", "b": "9", "d": "4"})
        self.assertEqual([(d.name, d.actual, d.expected) for d in drifts], [
            ("b", "2", "9"),
            ("d", None, "4"),
            ("c", "3", None),
        ])

    def test_record_only_and_absent_pins_never_drift(self):
        current = self._pins(a="1", harness="h", mapping=None)
        self.assertEqual(pins.compare(current, {"a": "1"}), [])
        self.assertEqual(pins.compare(current, {"a": "1", "harness": "zzz"}), [])

    def test_a_present_mapping_is_compared_once_it_is_in_the_file(self):
        current = self._pins(a="1", mapping="m1")
        self.assertEqual([d.name for d in pins.compare(current, {"a": "1"})], ["mapping"])
        self.assertEqual(pins.compare(current, {"a": "1", "mapping": "m1"}), [])
        self.assertEqual([d.name for d in pins.compare(current, {"a": "1", "mapping": "m2"})], ["mapping"])

    def test_lines_say_each_pins_state(self):
        current = self._pins(a="1", b="2", harness="h", mapping=None)
        current["harness"] = pins.Pin("harness", "h", "git abc, clean")
        drifts = pins.compare(current, {"a": "1", "b": "9"})
        lines = pins.lines(current, drifts)
        self.assertEqual(lines, [
            "PIN a sha256=1 ok",
            "PIN b sha256=2 DRIFTED (expected 9)",
            "PIN harness sha256=h recorded (git abc, clean; not compared)",
            "PIN mapping absent (not compared)",
        ])
        self.assertEqual(pins.lines(current, drifts, accepted=True)[1], "PIN b sha256=2 accepted (was 9)")


class ExpectedFile(unittest.TestCase):
    def test_round_trips_and_keeps_only_comparable_pins(self):
        current = {
            "a": pins.Pin("a", "1", "file"),
            "card": pins.Pin("card", "c", "game/disc/mc0_parity, 12 files"),
            "env": pins.Pin("env", "e", ["PS2X_HOST_GAMEPAD=0"]),
            "harness": pins.Pin("harness", "h", "git abc"),
            "mapping": pins.Pin("mapping", None, "absent"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "pins.json")
            pins.write_expected(current, path, note="test")
            self.assertEqual(pins.load_expected(path), {"a": "1", "card": "c", "env": "e"})
            with open(path) as f:
                doc = json.load(f)
            self.assertEqual(doc["detail"]["env"], ["PS2X_HOST_GAMEPAD=0"])
            self.assertEqual(doc["detail"]["card"], "game/disc/mc0_parity, 12 files")
            self.assertNotIn("harness", doc["pins"])
            self.assertNotIn("mapping", doc["pins"])
            self.assertEqual(pins.load_expected(os.path.join(tmp, "none.json")), None)

    def test_the_committed_standard_matches_the_tree(self):
        """The CI-side guard: a change to a pinned input without --accept-pins fails here, before any gate.
        The card lives under the git-ignored game/ and is compared only where it exists."""
        expected = pins.load_expected(REAL_EXPECTED)
        self.assertIsNotNone(expected, "scripts/parity/pins.json is committed")
        current = gate.collect_pins(base={})
        if current["card"].sha256 is None:
            current.pop("card")
            expected.pop("card", None)
        drifts = pins.compare(current, expected)
        self.assertEqual(drifts, [], "\n".join(pins.lines(current, drifts)))


class _LaunchCase(unittest.TestCase):
    """main() with the launch mocked out: no lock, no drive, no game. The expected-pins file and the stamp are
    per test; the card is a temp directory named through PS2X_MC_DIR (game/ is git-ignored, so the pristine
    card may not exist on this checkout).

    ... and so is the IMAGE, which is why each case names one. `gate.main`'s launch path asks
    `gate_revision(default_ok=False)` -- a launch has an image, and a launch that cannot say which revision
    it is refuses (exit 8) rather than silently reading r0001's addresses on an r0004 build (Task 19,
    KNOWN Sec 4). That rule is right and these cases must not soften it, so instead of leaving the revision
    to be guessed they STATE it: `SOCOM_GAME_ELF` names a stand-in carrying an r0001 build banner, which is
    all launch_revision reads. The r0004 cases below point the same variable at an r0004 stand-in. Before
    this, these cases only passed on a host that happened to have `game/disc/socom2_game.elf`; on CI, which
    has no game at all, ten of them failed on the refusal (the linux workflow, red since 2026-09-23)."""

    # The real r0001 image's own banner, character for character (game/disc/socom2_game.elf).
    R0001_BANNER = b"r0001 17:22:21 Oct 11 2003"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.card = os.path.join(self.tmp, "card")
        os.makedirs(self.card)
        with open(os.path.join(self.card, "SCRATCHPAD.DAT"), "wb") as f:
            f.write(b"pristine")
        self.game_elf = os.path.join(self.tmp, "r0001_stand_in.elf")
        with open(self.game_elf, "wb") as f:
            f.write(BANNER_STAND_IN % self.R0001_BANNER)
        self.expected = os.path.join(self.tmp, "pins.json")
        self.stamp = "q1b_pins_test_%d" % os.getpid()
        self.out_root = os.path.join("logs", "parity", "gate", self.stamp)
        shutil.rmtree(self.out_root, ignore_errors=True)
        self.env = mock.patch.dict(os.environ, {"PS2X_MC_DIR": self.card,
                                                "SOCOM_GAME_ELF": self.game_elf}, clear=False)
        self.env.start()
        for k in [k for k in os.environ if k.startswith("PS2X_") and k != "PS2X_MC_DIR"]:
            del os.environ[k]
        self.patches = [
            mock.patch.object(pins, "EXPECTED", self.expected),
            mock.patch.object(gate, "free_gb", return_value=99.0),
            mock.patch.object(gate, "exe_line", return_value="EXE dist/socom2.exe bytes=1 sha256=" + "00" * 32),
            mock.patch.object(gate, "_lock", return_value=subprocess.CompletedProcess(["x"], 0, "", "")),
            # the exe freshness refusal (S14 E4) is test_gate_fresh's; here no source is ever newer
            mock.patch.object(gate, "freshness_roots", return_value=[]),
        ]
        for p in self.patches:
            p.start()
        pins.write_expected(gate.collect_pins(), self.expected, note="test standard")

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.out_root, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _drift(self, name, sha="ff" * 32):
        with open(self.expected) as f:
            doc = json.load(f)
        doc["pins"][name] = sha
        with open(self.expected, "w") as f:
            json.dump(doc, f, indent=1)

    def _main(self, argv, stage=None):
        stage = stage or (lambda name, out_root: (True, "ok " + name))
        out = io.StringIO()
        with mock.patch.object(gate, "run_gate", side_effect=stage) as run, contextlib.redirect_stdout(out):
            rc = gate.main(["--stamp", self.stamp, "--only", "title"] + argv)
        return rc, out.getvalue(), run

    def _summary(self):
        with open(os.path.join(self.out_root, "summary.txt"), encoding="utf-8") as f:
            return f.read()


class LaunchPins(_LaunchCase):
    def test_a_matching_launch_scores_and_states_what_it_measured(self):
        rc, out, run = self._main([])
        self.assertEqual(rc, 0, out)
        self.assertEqual(run.call_count, 1)
        summary = self._summary()
        self.assertIn("PASS title (ok title)\n", summary)
        self.assertIn("EXE dist/socom2.exe bytes=1 sha256=", summary)
        current = gate.collect_pins()
        self.assertIn("PIN scripts/parity/ref_hud_ours.png sha256=%s ok\n" % current["scripts/parity/ref_hud_ours.png"].sha256, summary)
        self.assertIn("PIN card sha256=%s ok; %s, 1 file\n" % (pins.tree_sha256(self.card)[0], self.card.replace("\\", "/")), summary)
        self.assertIn("PIN env sha256=%s ok; PS2X_HOST_GAMEPAD=0 PS2X_PC_SAMPLER=1 PS2X_PEEK=" % current["env"].sha256, summary)
        self.assertIn("PIN harness sha256=%s recorded" % current["harness"].sha256, summary)
        self.assertIn("PIN mapping absent", summary)
        self.assertIn("PINS MATCH %s (13 compared)\n" % self.expected, summary)
        self.assertIn("GATE PASS (1/1)", out)
        with open(os.path.join(self.out_root, "pins.json")) as f:
            record = json.load(f)
        self.assertEqual(record["pins"]["card"], pins.tree_sha256(self.card)[0])
        self.assertEqual(record["pins"]["harness"], current["harness"].sha256)
        self.assertEqual(record["pins"]["mapping"], None)
        self.assertEqual(record["verdict"], "MATCH")
        self.assertEqual(record["exe"], "EXE dist/socom2.exe bytes=1 sha256=" + "00" * 32)

    def test_a_drifted_reference_image_refuses_with_the_name_of_what_drifted(self):
        self._drift("scripts/parity/ref_hud_ours.png")
        rc, out, run = self._main([])
        self.assertEqual(rc, 7, out)
        self.assertEqual(run.call_count, 0, "no launch was paid for")
        gate._lock.assert_not_called()
        self.assertIn("GATE REFUSED (pins drifted: scripts/parity/ref_hud_ours.png)", out)
        summary = self._summary()
        self.assertNotIn("title", summary.split("EXE ")[0])
        self.assertIn("PIN scripts/parity/ref_hud_ours.png sha256=%s DRIFTED (expected %s)\n"
                      % (gate.collect_pins()["scripts/parity/ref_hud_ours.png"].sha256, "ff" * 32), summary)
        self.assertIn("PINS DRIFTED: scripts/parity/ref_hud_ours.png -- refused to score", summary)
        self.assertIn("--accept-pins", summary)
        with open(os.path.join(self.out_root, "pins.json")) as f:
            self.assertEqual(json.load(f)["drifted"], ["scripts/parity/ref_hud_ours.png"])

    def test_a_refusal_is_not_a_stage_failure(self):
        rc, out, _ = self._main([], stage=lambda name, out_root: (False, "bad"))
        self.assertEqual(rc, 1)
        self._drift("card")
        rc, out, _ = self._main([], stage=lambda name, out_root: (False, "bad"))
        self.assertEqual(rc, 7)

    def test_a_touched_card_refuses(self):
        with open(os.path.join(self.card, "SCRATCHPAD.DAT"), "ab") as f:
            f.write(b" booted")
        rc, out, _ = self._main([])
        self.assertEqual(rc, 7)
        self.assertIn("pins drifted: card", out)

    def test_an_operators_ps2x_variable_refuses(self):
        os.environ["PS2X_GS_STATS"] = "1"
        rc, out, _ = self._main([])
        self.assertEqual(rc, 7)
        self.assertIn("pins drifted: env", out)
        self.assertIn("PS2X_GS_STATS=1", self._summary())

    def test_accept_pins_records_the_new_standard_and_scores(self):
        self._drift("scripts/parity/ref_hud_ours.png")
        self._drift("card")
        rc, out, run = self._main(["--accept-pins"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(run.call_count, 1)
        current = gate.collect_pins()
        self.assertEqual(pins.load_expected(self.expected)["scripts/parity/ref_hud_ours.png"],
                         current["scripts/parity/ref_hud_ours.png"].sha256)
        self.assertEqual(pins.load_expected(self.expected)["card"], pins.tree_sha256(self.card)[0])
        summary = self._summary()
        self.assertIn("PIN scripts/parity/ref_hud_ours.png sha256=%s accepted (was %s)\n"
                      % (current["scripts/parity/ref_hud_ours.png"].sha256, "ff" * 32), summary)
        self.assertIn("PINS ACCEPTED: scripts/parity/ref_hud_ours.png, card -> %s rewritten after the run\n" % self.expected, summary)
        with open(os.path.join(self.out_root, "pins.json")) as f:
            record = json.load(f)
        self.assertTrue(record["accepted"])
        self.assertEqual(record["verdict"], "ACCEPTED")
        # ... and the next launch matches without the flag.
        rc, out, _ = self._main([])
        self.assertEqual(rc, 0, out)
        self.assertIn("PINS MATCH", self._summary())

    def test_accept_pins_on_a_matching_launch_changes_nothing_and_says_so(self):
        before = pins.load_expected(self.expected)
        rc, out, _ = self._main(["--accept-pins"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(pins.load_expected(self.expected), before)
        self.assertIn("PINS MATCH", self._summary())

    def test_a_mapping_line_in_the_game_log_is_pinned(self):
        """Q3b: the first run that prints the mapping hash is a new pinned input -> refused until accepted;
        once accepted, a run with a different hash is refused; a run without the line is recorded as absent."""
        def stage_with(h):
            def stage(name, out_root):
                with open(os.path.join(out_root, name + ".game.log"), "w") as f:
                    f.write("[socom2] input mapping sha256=%s\n" % h)
                return True, "ok"
            return stage

        rc, out, run = self._main([], stage=stage_with("ab" * 32))
        self.assertEqual(rc, 7, out)
        self.assertEqual(run.call_count, 1, "the line is only known after the launch")
        self.assertIn("pins drifted: mapping", out)
        summary = self._summary()
        self.assertIn("PASS title (ok)\n", summary, "the stage lines are kept; the verdict is the refusal")
        self.assertIn("PIN mapping sha256=%s DRIFTED (expected none); from title.game.log\n" % ("ab" * 32), summary)

        rc, out, _ = self._main(["--accept-pins"], stage=stage_with("ab" * 32))
        self.assertEqual(rc, 0, out)
        self.assertEqual(pins.load_expected(self.expected)["mapping"], "ab" * 32)
        self.assertIn("PIN mapping sha256=%s accepted (was none); from title.game.log\n" % ("ab" * 32), self._summary())

        rc, out, _ = self._main([], stage=stage_with("ab" * 32))
        self.assertEqual(rc, 0, out)
        self.assertIn("PIN mapping sha256=%s ok; from title.game.log\n" % ("ab" * 32), self._summary())

        rc, out, _ = self._main([], stage=stage_with("cd" * 32))
        self.assertEqual(rc, 7, out)
        self.assertIn("PIN mapping sha256=%s DRIFTED (expected %s); from title.game.log\n" % ("cd" * 32, "ab" * 32), self._summary())

        os.remove(os.path.join(self.out_root, "title.game.log"))   # a stage that printed no line
        rc, out, _ = self._main([])
        self.assertEqual(rc, 0, out)
        self.assertIn("PIN mapping absent (expected %s; the runtime printed no mapping line; not compared)\n" % ("ab" * 32), self._summary())

    def test_pins_only_checks_the_tree_without_launching(self):
        rc, out, run = self._main(["--pins"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(run.call_count, 0)
        self.assertIn("PINS MATCH", out)
        self.assertFalse(os.path.exists(self.out_root), "a dry check writes no stamp")
        self._drift("scripts/parity/title_menu.txt")
        rc, out, _ = self._main(["--pins"])
        self.assertEqual(rc, 7)
        self.assertIn("PINS DRIFTED: scripts/parity/title_menu.txt", out)
        rc, out, _ = self._main(["--pins", "--accept-pins"])
        self.assertEqual(rc, 0, out)
        self.assertIn("PINS ACCEPTED: scripts/parity/title_menu.txt", out)
        self.assertEqual(pins.load_expected(self.expected)["scripts/parity/title_menu.txt"],
                         gate.collect_pins()["scripts/parity/title_menu.txt"].sha256)


class BaselinePins(_LaunchCase):
    """--baseline re-scores a saved stamp: the stamp's recorded pins must match the standard, and so must the
    present tree's file-backed pins (the re-score reads today's reference images)."""

    def _stamp(self, record):
        os.makedirs(os.path.join(self.out_root, "title"))
        if record is not None:
            with open(os.path.join(self.out_root, "pins.json"), "w") as f:
                json.dump(record, f)
        return self.out_root

    def _record(self, **override):
        current = gate.collect_pins()
        rec = {"pins": {k: v.sha256 for k, v in current.items()},
               # A real record carries the detail too, and the env detail is where the run's own
               # PS2X_PEEK is -- which is how a re-score knows which address column the stamp's rows are
               # in without consulting today's tree (review F1, gate.stamp_revision).
               "detail": {k: v.detail for k, v in current.items()}}
        rec["pins"].update(override)
        return rec

    def _baseline(self, argv=()):
        out = io.StringIO()
        with mock.patch.object(gate, "score_title", return_value=(True, "t")) as score, contextlib.redirect_stdout(out):
            rc = gate.main(["--baseline", self.out_root] + list(argv))
        return rc, out.getvalue(), score

    def test_a_matching_record_scores(self):
        self._stamp(self._record())
        rc, out, score = self._baseline()
        self.assertEqual(rc, 0, out)
        self.assertEqual(score.call_count, 1)
        self.assertIn("PINS MATCH", out)
        self.assertIn("GATE PASS (1/1) [baseline", out)

    def test_a_record_with_different_pins_refuses(self):
        self._stamp(self._record(**{"scripts/parity/ref_main_menu_ours.png": "ee" * 32}))
        rc, out, score = self._baseline()
        self.assertEqual(rc, 7, out)
        self.assertEqual(score.call_count, 0)
        self.assertIn("PIN scripts/parity/ref_main_menu_ours.png sha256=%s DRIFTED (expected %s)" % (
            "ee" * 32, gate.collect_pins()["scripts/parity/ref_main_menu_ours.png"].sha256), out)
        self.assertIn("GATE REFUSED (recorded pins drifted: scripts/parity/ref_main_menu_ours.png) [baseline", out)

    def test_a_present_tree_that_drifted_from_the_standard_refuses(self):
        self._stamp(self._record(**{"scripts/parity/ref_main_menu_ours.png": "ee" * 32}))
        self._drift("scripts/parity/ref_main_menu_ours.png", "ee" * 32)   # the record agrees with the file; the tree does not
        rc, out, score = self._baseline()
        self.assertEqual(rc, 7, out)
        self.assertEqual(score.call_count, 0)
        self.assertIn("GATE REFUSED (pins drifted: scripts/parity/ref_main_menu_ours.png) [baseline", out)

    def test_an_unrecorded_stamp_scores_and_says_so(self):
        self._stamp(None)
        rc, out, score = self._baseline()
        self.assertEqual(rc, 0, out)
        self.assertEqual(score.call_count, 1)
        self.assertIn("PINS unrecorded (no pins.json in the stamp: a run from before Q1b)", out)

    def test_the_records_own_card_and_env_are_compared_but_not_todays(self):
        """A re-score boots nothing: today's card and shell are not inputs to it. The record's are."""
        os.environ["PS2X_GS_STATS"] = "1"
        with open(os.path.join(self.card, "SCRATCHPAD.DAT"), "ab") as f:
            f.write(b" booted")
        self._stamp(self._record(env=pins.load_expected(self.expected)["env"], card=pins.load_expected(self.expected)["card"]))
        rc, out, _ = self._baseline()
        self.assertEqual(rc, 0, out)
        shutil.rmtree(self.out_root)
        self._stamp(self._record(env="dd" * 32, card=pins.load_expected(self.expected)["card"]))
        rc, out, _ = self._baseline()
        self.assertEqual(rc, 7, out)
        self.assertIn("recorded pins drifted: env", out)

    def test_accept_pins_is_a_launch_flag(self):
        self._stamp(self._record())
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                gate.main(["--baseline", self.out_root, "--accept-pins"])


class PerRevisionStandards(_LaunchCase):
    """Review F2. PS2X_PEEK is part of the `env` pin and is now revision-dependent, so with ONE standard an
    r0004 gate necessarily drifts -- and the `--accept-pins` that lets it run rewrote the r0001 standard.
    That is not a hazard in the abstract: on 2026-09-24 at 10:25 an unattended
    `gate --accept-pins --stamp s11_r0004_reg3` replaced scripts/parity/pins.json's r0001 env pin with the
    r0004 spec and dropped the mapping pin. One standard per revision, and neither gate can reach the
    other's file. This is docs/HAZARDS.md harness's accept-pins hazard, closed."""

    def _r0004_elf(self):
        path = os.path.join(self.tmp, "r0004_stand_in.elf")
        with open(path, "wb") as f:
            f.write(BANNER_STAND_IN % b"r0004 10:14:38 Nov  3 2004")
        return path

    def test_r0001_keeps_the_committed_file_and_every_other_revision_gets_its_own(self):
        self.assertEqual(gate.expected_pins_rel("r0001"), pins.EXPECTED)
        other = gate.expected_pins_rel("r0004")
        self.assertNotEqual(other, pins.EXPECTED)
        self.assertTrue(other.endswith("_r0004.json"), other)

    def test_an_r0004_accept_pins_cannot_reach_the_r0001_standard(self):
        before = open(self.expected, "rb").read()
        os.environ["SOCOM_GAME_ELF"] = self._r0004_elf()
        try:
            rc, out, _ = self._main(["--accept-pins"])
        finally:
            os.environ["SOCOM_GAME_ELF"] = self.game_elf   # back to the case default, the r0001 stand-in
        self.assertEqual(rc, 0, out)
        self.assertIn("REVISION r0004", out)
        self.assertEqual(open(self.expected, "rb").read(), before,
                         "an r0004 gate must leave the r0001 standard byte for byte as it found it")
        r4 = gate.expected_pins_path("r0004")
        self.assertTrue(os.path.isfile(r4), "the r0004 gate writes its own standard")
        with open(r4) as f:
            doc = json.load(f)
        self.assertIn("0x442a14:3", " ".join(doc["detail"]["env"]))
        self.assertNotIn("0x416054", " ".join(doc["detail"]["env"]))
        self.assertIn(os.path.basename(r4), self._summary())

    def test_an_r0004_gate_that_matches_its_own_standard_does_not_need_accept_pins(self):
        os.environ["SOCOM_GAME_ELF"] = self._r0004_elf()
        try:
            self.assertEqual(self._main(["--accept-pins"])[0], 0)       # the first run sets it
            rc, out, _ = self._main([])                                  # the second just matches
        finally:
            os.environ["SOCOM_GAME_ELF"] = self.game_elf   # back to the case default, the r0001 stand-in
        self.assertEqual(rc, 0, out)
        self.assertIn("PINS MATCH %s" % gate.expected_pins_rel("r0004"), out)

    def test_the_r0001_gate_is_untouched_by_all_of_it(self):
        rc, out, _ = self._main([])
        self.assertEqual(rc, 0, out)
        self.assertIn("REVISION r0001 (probe addresses and pin standard %s)" % pins.EXPECTED, out)
        self.assertIn("PINS MATCH %s" % pins.EXPECTED, out)

    def test_a_launch_that_cannot_name_its_revision_refuses_rather_than_tracebacks(self):
        """Review F9: launch_env now does disk I/O and can raise, from collect_pins -- i.e. from EVERY
        lane including title. A named-but-missing image is the gate's own refusal line and its own exit
        code, not an unhandled traceback."""
        os.environ["SOCOM_GAME_ELF"] = os.path.join(self.tmp, "not_an_image.elf")
        try:
            rc, out, run = self._main([])
        finally:
            os.environ["SOCOM_GAME_ELF"] = self.game_elf   # back to the case default, the r0001 stand-in
        self.assertEqual(rc, gate.REFUSE_REVISION, out)
        self.assertEqual(run.call_count, 0, "nothing was launched")
        self.assertIn("SOCOM_GAME_ELF", out)


class ArchivedStampRevision(unittest.TestCase):
    """Review F1: a --baseline re-score must read an archived run's rows with the column THAT RUN used,
    resolved from the stamp's own record -- never from whatever image game/disc holds today, and never
    assumed. Eight stamps on disk predate the runtime's revision line, among them Sprint 10's closing gate."""

    ARCHIVED = os.path.join(ROOT, "logs", "parity", "gate")

    def _stamp(self, name):
        path = os.path.join(self.ARCHIVED, name)
        if not os.path.isdir(path):
            self.skipTest("needs the archived stamp %s (logs/ is not in a bare clone)" % name)
        return path

    def test_a_stamp_from_before_the_revision_line_is_read_from_its_own_peek_spec(self):
        for name in ("s10_close_gate", "s11_open_gate"):
            revision, how = gate.stamp_revision(self._stamp(name))
            self.assertEqual(revision, "r0001", name)
            self.assertIn("PS2X_PEEK", how, name)

    def test_an_r0004_stamp_reads_as_r0004(self):
        revision, _how = gate.stamp_revision(self._stamp("s11_r0004_probe1"))
        self.assertEqual(revision, "r0004")

    def test_the_probes_of_an_archived_r0001_stamp_still_pass(self):
        """The whole point: s10_close_gate's committed summary.txt carries three PASS probe lines, and the
        re-score has to reproduce them rather than discard the standard with a NO-DATA."""
        stamp = self._stamp("s10_close_gate")
        lines = gate.probe_lines(os.path.join(stamp, "mission.game.log"), gate.stamp_revision(stamp)[0])
        self.assertTrue(all(" PASS " in l for l in lines), lines)
        self.assertIn("root_node_y", " ".join(lines))

    def test_a_stamp_that_says_nothing_is_unknown_not_r0001(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                gate.stamp_revision(tmp)
            open(os.path.join(tmp, "mission.game.log"), "w").close()
            self.assertEqual(gate.probe_lines(os.path.join(tmp, "mission.game.log"))[0].split(" ")[1],
                             "UNKNOWN-REVISION")


REFS_EXPECTED = os.path.join(ROOT, "scripts", "parity", "pins_refs.json")
_TRACKED_SUFFIXES = (".py", ".sh", ".txt", ".json", ".ps1")


def _harness_png_files():
    """Every reference image under scripts/parity/, repo-relative with forward slashes."""
    out = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "scripts", "parity")):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        out += [os.path.relpath(os.path.join(dirpath, n), ROOT).replace("\\", "/")
                for n in sorted(filenames) if n.endswith(".png")]
    return out


def _harness_texts():
    """The text of every file that can read a reference: tools_py and scripts, not the tests (a test naming a
    reference is not a reader), not the pin standards (a standard naming one is not a reader either)."""
    texts = []
    for tree in ("tools_py", "scripts"):
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, tree)):
            dirnames[:] = [d for d in dirnames if d not in ("__pycache__", "tests")]
            for n in filenames:
                if not n.endswith(_TRACKED_SUFFIXES) or (n.startswith("pins") and n.endswith(".json")):
                    continue
                with open(os.path.join(dirpath, n), encoding="utf-8", errors="replace") as f:
                    texts.append(f.read())
    return "\n".join(texts)


def _stem(rel):
    """`scripts/parity/refs/map_frostfire.pcsx2.png` -> `map_frostfire`: a target sibling is read through its
    stem (drive.ref_for_target, online_login_ours.map_ref_path / lobby_title_ref)."""
    name = os.path.basename(rel)[:-len(".png")]
    for target in (".pcsx2", ".ours"):
        if name.endswith(target):
            name = name[:-len(target)]
    return name


def _dynamic_reader(rel):
    """The two families read by a computed path, never by a literal stem: online_login_ours.map_ref_path
    (refs/map_<slug>[.<target>].png, for whatever map a round is asked for) and lobby_title_ref
    (refs/lobby/title_<name>[.<target>].png, for LOBBY_TITLES)."""
    from tools_py.parity import online_login_ours as L
    stem = _stem(rel)
    if rel.startswith("scripts/parity/refs/lobby/title_"):
        return stem[len("title_"):] in L.LOBBY_TITLES
    if rel.startswith("scripts/parity/refs/map_"):
        return os.path.normpath(os.path.join(ROOT, L.map_ref_path(stem[len("map_"):], target="ours"))) == \
            os.path.normpath(os.path.join(ROOT, "scripts", "parity", "refs", stem + ".png"))
    return False


def _directory_standards():
    """`{name: sha256}` from every pins.json in a SUBDIRECTORY of scripts/parity/: a reference directory that carries
    its own standard (the shape of pins.json, written by the tool that captured it) pins the images inside it, and
    only those -- a name outside its own directory is returned under None so the test below reports it."""
    out = {}
    top = os.path.join(ROOT, "scripts", "parity")
    for dirpath, dirnames, filenames in os.walk(top):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        if os.path.normcase(dirpath) == os.path.normcase(top) or pins.RECORD_NAME not in filenames:
            continue
        prefix = os.path.relpath(dirpath, ROOT).replace("\\", "/") + "/"
        for name, sha in (pins.load_expected(os.path.join(dirpath, pins.RECORD_NAME)) or {}).items():
            out[name] = sha if name.startswith(prefix) else None
    return out


class EveryReferenceIsPinned(unittest.TestCase):
    """Sprint 13 H3 (the audit's harness row 25 and its neighbours): the gate pinned 7 of the 58 PNGs under
    scripts/parity/ -- the ones its three stages read. The other 51 (the online login and lobby screens, the
    lobby titles, the twenty-odd map rows, the on-screen keyboard, the console-side siblings, the save-card
    screens) could change with nothing saying so, which is the failure pins.py exists to make impossible. Every
    reference the harness reads is in a standard now: the gate's own in pins.json (unchanged -- the gate compares
    every name its standard holds, so a name it does not read cannot go there), the rest in pins_refs.json, the
    same shape (pins.write_expected / load_expected). And a reference nothing reads is not kept."""

    def test_every_reference_image_has_a_reader(self):
        texts = _harness_texts()
        dead = [rel for rel in _harness_png_files() if _stem(rel) not in texts and not _dynamic_reader(rel)]
        self.assertEqual(dead, [], "reference images nothing under tools_py/ or scripts/ reads")

    def test_every_reference_image_is_in_a_standard_and_matches_it(self):
        standard = dict(pins.load_expected(REAL_EXPECTED) or {})
        refs = pins.load_expected(REFS_EXPECTED)
        self.assertIsNotNone(refs, "scripts/parity/pins_refs.json is committed")
        nested = _directory_standards()
        self.assertEqual([n for n, sha in nested.items() if sha is None], [],
                         "a directory's own pins.json names only files inside that directory")
        overlap = sorted((set(standard) & set(refs)) | ((set(standard) | set(refs)) & set(nested)))
        self.assertEqual(overlap, [], "a reference is pinned in one standard, not two")
        standard.update(refs)
        standard.update(nested)
        unpinned, drifted = [], []
        for rel in _harness_png_files():
            if rel not in standard:
                unpinned.append(rel)
            elif standard[rel] != pins.file_sha256(os.path.join(ROOT, rel)):
                drifted.append(rel)
        self.assertEqual(unpinned, [], "reference images in no standard")
        self.assertEqual(drifted, [], "reference images that no longer match their standard")

    def test_the_references_standard_names_only_files_that_exist(self):
        refs = pins.load_expected(REFS_EXPECTED) or {}
        self.assertEqual([n for n in refs if not os.path.isfile(os.path.join(ROOT, n))], [])


if __name__ == "__main__":
    unittest.main()
