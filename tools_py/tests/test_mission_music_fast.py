"""Fix wave W7 (2026-09-22): the mission-music instrument -- a drive script that skips the cinematics, reaches
gameplay fast and then holds in the mission long enough to contain the degradation the owner describes.

The owner, playing tonight's build: "one song playing with stutters or skips ... it is not playing linearly ...
fine the first while, gets much worse as I proceed", and "You may have to write tests that skip the cutscenes
and move faster to catch these issues."

Two files carry that: `scripts/parity/mission_music_fast.txt` (the path) and `scripts/parity/mission_music_long.sh`
(the schedule, the capture and the scores). Nothing here launches a game -- the wrapper's `--dry-run` writes the
generated drive script and stops -- so these are checks of the script the controller is about to run, not of the
run. The numbers they pin come from logs/parity/s9_q1_parity_ours (our exe on launch_to_mission_xl): the DEPLOY
press at t=87 s, the mission up by ~137 s, and that script's `next+10.0:NONE` mission step spending
`waited=40.1s stable=False` before another 10 s on top -- the 50 s the fast path does not spend.
"""
import os
import shutil
import subprocess
import sys
import unittest

from tools_py.parity import drive
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FAST = os.path.join(ROOT, "scripts", "parity", "mission_music_fast.txt")
LONG_SH = os.path.join(ROOT, "scripts", "parity", "mission_music_long.sh")
AUDIO_SH = os.path.join(ROOT, "scripts", "parity", "audio_parity.sh")


def steps(path):
    with open(path, encoding="utf-8") as f:
        return drive.parse(f.read())


class TheFastPath(unittest.TestCase):
    def setUp(self):
        self.steps = steps(FAST)
        self.modes = [m for m, _d, _b in self.steps]

    def test_it_parses_as_a_drive_script(self):
        self.assertTrue(self.steps)
        for mode, delay, buttons in self.steps:
            self.assertGreaterEqual(delay, 0.0)
            for b in buttons:
                self.assertEqual(b, b.upper())

    def test_the_cinematics_are_skipped_by_the_existing_means(self):
        # the boot screens, the intro movie and the briefing cinematic: one CROSS on each NEW settled screen,
        # which is what launch_to_mission*.txt already does for a skippable screen
        crosses = [i for i, (m, _d, b) in enumerate(self.steps) if m == "next" and b == ["CROSS"]]
        self.assertGreaterEqual(len(crosses), 13)
        self.assertEqual(crosses, list(range(len(crosses))))       # they are the run's opening, uninterrupted

    def test_the_flyover_is_pressed_through_to_the_hud_not_waited_out(self):
        untilref = [i for i, m in enumerate(self.modes) if m.startswith("untilref(")]
        self.assertEqual(len(untilref), 1)
        mode = self.modes[untilref[0]]
        parts = [v.strip() for v in mode[len("untilref("):-1].split(",")]
        ref = parts[0]
        self.assertTrue(os.path.exists(os.path.join(ROOT, ref)), ref)
        self.assertIn("lit", parts)                                # the in-game HUD, not the intro cinematic
        # and the step that carries the CROSS through it
        self.assertEqual(self.steps[untilref[0]][2], ["CROSS"])

    def test_the_forty_second_mission_settle_is_gone(self):
        # launch_to_mission_xl.txt spends `next+10.0:NONE` there and measured waited=40.1s stable=False
        after_deploy = self.modes[self.modes.index("untilref(scripts/parity/ref_hud_ours.png,92,112,0,40,40,20,lit)")
                                  - 1]
        self.assertEqual(after_deploy, "wait")
        self.assertNotIn("long", self.modes)

    def test_a_popup_guard_sits_between_the_hud_and_the_hold(self):
        untilref = next(i for i, m in enumerate(self.modes) if m.startswith("untilref("))
        self.assertIn("ifpopup", self.modes[untilref:])

    def test_it_ends_in_a_hold_the_wrapper_extends(self):
        self.assertEqual(self.steps[-1], ("wait", 8.0, []))


@unittest.skipUnless(BASH, "bash not found")
class TheLongWrapper(unittest.TestCase):
    STAMP = "test_w7_mission_music_dryrun"

    def tearDown(self):
        shutil.rmtree(os.path.join(ROOT, "logs", "parity", self.STAMP), ignore_errors=True)

    def dry_run(self, *args):
        p = subprocess.run([BASH, LONG_SH, "--dry-run", "--stamp", self.STAMP, *args],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        head = dict(kv.split("=", 1) for kv in p.stdout.splitlines()[0].split())
        generated = os.path.join(ROOT, "logs", "parity", self.STAMP, "drive_script.txt")
        return head, steps(generated), p.stdout

    def test_the_default_hold_is_at_least_the_ten_minutes_w7_asks_for(self):
        head, parsed, _ = self.dry_run()
        self.assertEqual(head["minutes"], "12")
        held = sum(d for m, d, b in parsed if m == "wait" and not b and d == 8.0)
        self.assertGreaterEqual(held, 600.0)
        self.assertEqual(held, 12 * 60.0)

    def test_the_hold_is_an_argument(self):
        for minutes in ("2", "20"):
            head, parsed, _ = self.dry_run("--minutes", minutes)
            held = sum(d for m, d, b in parsed if m == "wait" and not b and d == 8.0)
            self.assertEqual(held, int(minutes) * 60.0, minutes)
            self.assertEqual(head["hold"], f"{int(minutes) * 60}s")

    def test_the_run_length_covers_the_boot_and_the_whole_hold(self):
        head, parsed, _ = self.dry_run("--minutes", "12")
        drive_s, record_s = int(head["drive"][:-1]), int(head["record"][:-1])
        scripted = sum(d for _m, d, _b in parsed)
        # a game killed mid-hold leaves the rest of the capture as digital silence (s9_q1_parity_ours)
        self.assertGreater(drive_s, scripted + 137 + 10)
        self.assertGreater(record_s, drive_s)

    def test_the_console_gets_the_longer_boot_allowance(self):
        ours, _, _ = self.dry_run("--minutes", "5")
        console, _, _ = self.dry_run("--minutes", "5", "--target", "pcsx2")
        self.assertGreater(int(console["drive"][:-1]), int(ours["drive"][:-1]))

    def test_popup_guards_are_interleaved_through_the_hold(self):
        _head, parsed, _ = self.dry_run("--minutes", "12")
        modes = [m for m, _d, _b in parsed]
        holds = modes.count("wait")
        self.assertGreaterEqual(modes.count("ifpopup"), holds // 16)
        # never two hold steps apart by more than the guard interval near the end of the run
        tail = modes[modes.index("untilref(scripts/parity/ref_hud_ours.png,92,112,0,40,40,20,lit)"):]
        gaps, run = [], 0
        for m in tail:
            if m == "ifpopup":
                gaps.append(run)
                run = 0
            else:
                run += 1
        self.assertLessEqual(max(gaps), 10)

    def test_a_bad_target_is_refused_without_writing_anything(self):
        p = subprocess.run([BASH, LONG_SH, "--dry-run", "--stamp", self.STAMP, "--target", "dolphin"],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)

    # --walk (the W7 follow-up, 2026-09-22): a driven hold captures no music, so the mission hold moves --
    # a short safe leg, forward 8 s and back 8 s, repeated for the whole hold.
    def test_walk_replaces_the_hold_with_alternating_legs_that_cover_the_minutes(self):
        head, parsed, out = self.dry_run("--walk", "--minutes", "10")
        self.assertEqual(head["walk"], "1")
        legs = [(d, b) for m, d, b in parsed if m == "hold"]
        self.assertGreaterEqual(sum(d for d, _b in legs), 0.8 * 600)          # holds are 8 of every 10 s
        walked = sum(d for m, d, b in parsed if m in ("hold", "wait") and parsed.index((m, d, b)) >= 0)
        self.assertGreaterEqual(walked, 600.0)
        self.assertTrue(all(b in (["W"], ["S"]) for _d, b in legs), legs[:4])
        self.assertTrue(all(d == 8.0 for d, _b in legs))
        dirs = [b[0] for _d, b in legs]
        self.assertEqual(dirs[:4], ["W", "S", "W", "S"])                       # back where it started every 20 s
        self.assertEqual(dirs.count("W"), dirs.count("S"))
        self.assertIn("60 walking legs", out)

    def test_walk_keeps_the_popup_guards_and_lengthens_the_run(self):
        head_w, parsed_w, _ = self.dry_run("--walk", "--minutes", "10")
        head_h, parsed_h, _ = self.dry_run("--minutes", "10")
        modes = [m for m, _d, _b in parsed_w]
        self.assertGreaterEqual(modes.count("ifpopup"), modes.count("hold") // 16)
        # a hold step costs its post-press sleep and a capture on top of the hold: the run allows for it
        self.assertGreater(int(head_w["drive"][:-1]), int(head_h["drive"][:-1]))
        scripted = sum(d for _m, d, _b in parsed_w)
        self.assertGreater(int(head_w["drive"][:-1]), scripted + 137 + 10 + 2 * modes.count("hold") - 10)

    def test_walk_is_refused_on_the_briefing(self):
        p = subprocess.run([BASH, LONG_SH, "--dry-run", "--stamp", self.STAMP, "--walk", "--stage", "briefing"],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("MISSION", p.stderr)

    def test_the_device_pin_is_read_from_the_dips_report(self):
        # The pin's parse line, on a report in the scorer's own format: the max-in-a-minute number.
        with open(LONG_SH, encoding="utf-8") as f:
            body = f.read()
        self.assertIn("--max-device-per-minute", body)
        sed = "s/^DEVICE total [0-9]* over [0-9]* minutes, max \\([0-9]*\\) in a minute.*/\\1/p"
        self.assertIn(sed, body)
        p = subprocess.run([BASH, "-c", f"printf 'x\\nDEVICE total 11 over 16 minutes, max 4 in a minute (03:00)\\n' | sed -n '{sed}'"],
                           capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), "4")


@unittest.skipUnless(BASH, "bash not found")
class TheLobbyStage(unittest.TestCase):
    """Sprint 17 A1 (issue #94): the online screens' music held in SOCOM Online's lobby and scored minute by minute.
    The owner on the batch-2 build: "sustained hang or up-pitch every few seconds". The path to the lobby is not a
    drive.py step script -- it is online_login_ours.py's `login` stage with --prefilled --existing, as the
    controller's q2 logoff run calls it -- so the lobby stage's generated drive script is a shell driver that
    audio_parity.sh runs in drive.py's place, under the same recorder, volume hold and dump."""
    STAMP = "test_a1_lobby_music_dryrun"

    def tearDown(self):
        shutil.rmtree(os.path.join(ROOT, "logs", "parity", self.STAMP), ignore_errors=True)

    def run_long(self, *args):
        return subprocess.run([BASH, LONG_SH, "--dry-run", "--stamp", self.STAMP, *args],
                              cwd=ROOT, capture_output=True, text=True)

    def dry_run(self, *args):
        p = self.run_long("--stage", "lobby", *args)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        lines = p.stdout.splitlines()
        head = dict(kv.split("=", 1) for kv in lines[0].split())
        script = dict(kv.split("=", 1) for kv in lines[1].split())["script"]
        with open(os.path.join(ROOT, script), encoding="utf-8") as f:
            body = f.read()
        return head, script, body, p.stdout

    def command(self, body):
        cmd = [ln for ln in body.splitlines() if "tools_py.parity.online_login_ours" in ln and not ln.startswith("#")]
        self.assertEqual(len(cmd), 1, body)
        return cmd[0].split()

    def test_the_drive_script_reaches_the_lobby_by_the_prefilled_existing_login(self):
        head, script, body, _ = self.dry_run("--minutes", "2")
        self.assertEqual(head["stage"], "lobby")
        self.assertTrue(script.endswith(".sh"), script)
        cmd = self.command(body)
        self.assertIn("--prefilled", cmd)
        self.assertIn("--existing", cmd)
        # the login steps, named in the script as online_login_ours.py's stages run them
        for step in ("boot_to_online", "login", "universe", "persona", "CONNECT", "EULA", "SERVER NEWS"):
            self.assertIn(step, body)
        # it stays in the lobby: no briefing room, no game, no extra presses
        for leave in ("--host", "--join", "--then"):
            self.assertNotIn(leave, cmd)
        # our hosted server, by the harness's one knob
        self.assertIn("scripts/parity/env.sh", body)
        self.assertEqual(subprocess.run([BASH, "-n", os.path.join(ROOT, script)]).returncode, 0)

    def test_it_holds_in_the_lobby_for_the_minutes(self):
        for minutes in ("2", "10"):
            head, _script, body, _ = self.dry_run("--minutes", minutes)
            cmd = self.command(body)
            self.assertEqual(cmd[cmd.index("--hold") + 1], str(int(minutes) * 60), minutes)
            self.assertEqual(head["hold"], f"{int(minutes) * 60}s")

    def test_the_run_length_covers_the_login_and_the_whole_hold(self):
        head, _script, body, _ = self.dry_run("--minutes", "2")
        drive_s, record_s = int(head["drive"][:-1]), int(head["record"][:-1])
        cmd = self.command(body)
        self.assertEqual(cmd[cmd.index("--seconds") + 1], str(drive_s))
        # q2_logoff online1 logged `LOBBY class=ok` at 172 s; the hold takes a capture every 5 s on top of its sleep
        self.assertGreater(drive_s, 172 + 120 + 120 // 5)
        self.assertGreater(record_s, drive_s)

    def test_the_game_log_is_pinned_beside_the_capture_for_the_dips_scorer(self):
        _head, _script, body, _ = self.dry_run("--minutes", "2")
        self.assertIn("PS2X_RUN_LOG=", body)
        self.assertIn(f"logs/parity/{self.STAMP}/run.log", body)

    def test_the_console_side_is_refused_with_a_sentence(self):
        p = self.run_long("--stage", "lobby", "--target", "pcsx2")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("not yet", p.stderr)
        self.assertIn("online_login.py", p.stderr)
        self.assertFalse(os.path.exists(os.path.join(ROOT, "logs", "parity", self.STAMP, "drive_lobby.sh")))

    def test_walk_is_refused_in_the_lobby(self):
        p = self.run_long("--stage", "lobby", "--walk")
        self.assertEqual(p.returncode, 2)
        self.assertIn("MISSION", p.stderr)

    def test_a_bad_stage_names_the_lobby(self):
        p = self.run_long("--stage", "clan")
        self.assertEqual(p.returncode, 2)
        self.assertIn("lobby", p.stderr)

    def test_the_record_names_what_env_sh_hands_the_lobby_game(self):
        # issue #38: env_ps2x.txt is "what the game ran under"; the lobby game runs under env.sh's instruments
        self.dry_run("--minutes", "2")
        with open(os.path.join(ROOT, "logs", "parity", self.STAMP, "env_ps2x.txt"), encoding="utf-8") as f:
            record = f.read()
        for knob in ("PS2X_PC_SAMPLER", "PS2X_RUN_LOG", "PS2X_SOCOM2_SERVER", "PS2X_SOCOM2_INPUT_TRACE"):
            self.assertIn(knob, record)

    def test_a_lobby_failure_exits_5_not_the_device_pins_4(self):
        # The capture is stood in for by the wrapper's seam: it writes the login's classified failure and exits with
        # online_login_ours.LOBBY_FAIL_EXIT (4), which is also the DEVICE pin's code -- the wrapper says 5.
        with open(LONG_SH, encoding="utf-8") as f:
            body = f.read()
        # Never run the wrapper without the seam in it: the real capture runs kill_stale_drivers.ps1, which kills
        # every driver and game on the host (an unguarded RED of this test ended another agent's run, 2026-09-29).
        self.assertIn('CAPTURE_SH="${MISSION_MUSIC_CAPTURE_SH:-', body)
        out = os.path.join(ROOT, "logs", "parity", self.STAMP)
        os.makedirs(out, exist_ok=True)
        fake = f"logs/parity/{self.STAMP}/fake_capture.sh"
        with open(os.path.join(ROOT, fake), "w", encoding="utf-8", newline="\n") as f:
            f.write('echo "RESULT LOBBY-FAIL login:eula" > "logs/parity/$3/drive.stdout"\nexit 4\n')
        env = dict(os.environ, MISSION_MUSIC_CAPTURE_SH=fake)
        p = subprocess.run([BASH, LONG_SH, "--stamp", self.STAMP, "--stage", "lobby", "--minutes", "1", "--no-score"],
                           cwd=ROOT, capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        self.assertIn("RESULT LOBBY-FAIL login:eula", p.stdout)
        with open(LONG_SH, encoding="utf-8") as f:
            header = f.read().split("\nset -u\n", 1)[0]
        self.assertIn("exit codes:", header.lower())
        self.assertIn("5 the lobby stage's login failed", header)
        self.assertIn("4 the DEVICE pin", header)

    def test_audio_parity_runs_a_shell_driver_in_drive_pys_place(self):
        with open(AUDIO_SH, encoding="utf-8") as f:
            body = f.read()
        self.assertIn('*.sh) bash "$script"', body)


@unittest.skipUnless(BASH, "bash not found")
class AudioParityStaysCompatible(unittest.TestCase):
    """W7 lengthened audio_parity.sh's capture rather than copying it. Its first three arguments, and what it
    does with them, must not have moved: the pinned PCSX2 reference was captured with the old defaults."""

    def test_the_script_still_parses_and_keeps_its_defaults(self):
        self.assertEqual(subprocess.run([BASH, "-n", AUDIO_SH], cwd=ROOT).returncode, 0)
        with open(AUDIO_SH, encoding="utf-8") as f:
            body = f.read()
        self.assertIn("drive_s=${4:-600}", body)
        self.assertIn("rec_s=${5:-$((drive_s + 20))}", body)
        self.assertIn('--seconds "$drive_s"', body)
        self.assertIn('"$OUT/endpoint.wav" "$rec_s"', body)

    def test_the_dump_is_only_exported_when_asked_for(self):
        with open(AUDIO_SH, encoding="utf-8") as f:
            body = f.read()
        self.assertIn('if [ -n "${AUDIO_DUMP:-}" ] && [ "$target" != pcsx2 ]; then', body)
        self.assertIn('export PS2X_AUDIO_DUMP="$AUDIO_DUMP"', body)

    def test_usage_still_prints_from_the_header(self):
        p = subprocess.run([BASH, AUDIO_SH], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("audio_parity.sh capture", p.stdout)
        self.assertIn("audio_parity.sh compare", p.stdout)


class TheScorersW7Reuses(unittest.TestCase):
    """W7 scores with tools that already exist. audio_envelope is the primary read (reference-free, per-segment,
    and its four measurements are the owner's four words); audio_dips classifies what it finds against the game
    log and the mixer's dump. Neither is new here -- these only check the flags the wrapper passes."""

    def help(self, module):
        return subprocess.run([sys.executable, "-m", f"tools_py.parity.{module}", "--help"],
                              cwd=ROOT, capture_output=True, text=True, check=True).stdout

    def test_audio_envelope_takes_the_segment_the_wrapper_passes(self):
        out = self.help("audio_envelope")
        self.assertIn("--segment", out)

    def test_audio_dips_takes_the_dump_and_the_log(self):
        out = self.help("audio_dips")
        self.assertIn("--dump", out)
        self.assertIn("--log", out)

    def test_the_wrapper_names_both_and_says_why_audio_parity_is_not_the_scorer(self):
        with open(LONG_SH, encoding="utf-8") as f:
            body = f.read()
        self.assertIn("tools_py.parity.audio_envelope", body)
        self.assertIn("tools_py.parity.audio_dips", body)
        self.assertIn("audio_parity.py is deliberately NOT the scorer", body)


if __name__ == "__main__":
    unittest.main()
