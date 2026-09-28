"""Sprint 16 L1b (#73): the driver's --new-persona N -- a second (third, ...) persona on a card that already holds N.

The L1 design note (docs/superpowers/plans/2026-09-27-sprint-16-l1-profile-viewer-design.md, section 2): the driver as it
was cannot make a second persona. `persona_form_mode` reads a filled PLAYER NAME as "saved" and nothing walks the game's
persona list to <New Persona>, so a second create-persona login on that card and server logged in as A typing B's
password. --new-persona N skips persona_form_mode (the mode is "create" by the option), presses the persona-list CROSS
(the CROSS that opens the list -- a DOWN before it would move the form's cursor from PLAYER NAME to PASSWORD), then DOWN
N times, then the pick CROSS, and requires the "Enter Player Name" keyboard after it (osk_title_is_name), else
login:persona:new-persona; then create_persona's walk from the open name keyboard.

Step 0 (2026-09-27, logs/parity/s16_l1b_step0, launch 2 `--new-persona 1`): that list CROSS assumed the form's cursor
on PLAYER NAME, but a card holding a saved persona WITH its password brings the form up with the cursor on CONNECT
(launch2/02_persona.png; launch 3's stdout: "PLAYER NAME 5 glyphs, focus connect"). The "list" CROSS connected as the
saved persona and the four pick CROSSes landed on the USER AGREEMENT (launch2/miss_login_persona_new-persona_1.png).
So press_new_persona first reads the lit row and presses UP, one at a time and each read back, until PLAYER NAME is lit
(bounded; login:persona:focus, with no CROSS sent, when it never is) -- and only then the list CROSS.

Nothing here runs a game: the frames are the fixtures test_first_login.py already cuts (the two keyboards and the
forms, with test_saved_password's lit_row moving the lit fill between rows), and the press sequence is what is asserted.
"""
import unittest
from unittest import mock

from tools_py.parity import online_login_ours as L
from tools_py.tests import test_first_login as F
from tools_py.tests import test_online_login_lobby as T
from tools_py.tests import test_saved_password as S

Grabs = T.Grabs
KEY_CROSS, KEY_DOWN, PAD_CROSS = F.KEY_CROSS, F.KEY_DOWN, F.PAD_CROSS
KEY_UP = ("key", "up")

# The form with the card's persona in PLAYER NAME and the cursor on each row in turn, CONNECT up to PLAYER NAME
ROW_GENDER, ROW_HOMETOWN = (20, 226, 160, 248), (20, 196, 160, 218)
ON_CONNECT = S.FORM_SAVED_ON_CONNECT                  # launch 2's arrival: the password saved, YES ticked, on CONNECT
ON_GENDER = S.lit_row(F.FORM_SAVED, ROW_GENDER)
ON_HOMETOWN = S.lit_row(F.FORM_SAVED, ROW_HOMETOWN)
ON_SAVE = S.lit_row(F.FORM_SAVED, S.ROW_SAVE)
ON_PASSWORD = F.FORM_SAVED                            # the LAN card's arrival (s6_ladder7): no password saved
ON_PLAYER_NAME = S.lit_row(F.FORM_SAVED, F.ROW_PLAYER_NAME)
WALK_FROM_CONNECT = (ON_CONNECT, ON_GENDER, ON_HOMETOWN, ON_SAVE, ON_PASSWORD, ON_PLAYER_NAME)


def list_cross(sh):
    sh.presses.append(("key", "cross"))       # press_persona_list, verified elsewhere (test_first_login)


def run_new(personas, *frames):
    # the form as it arrives with the cursor already on PLAYER NAME: the focus read passes, no UP
    sh, g = T.FakeShell(), Grabs(ON_PLAYER_NAME, *frames)
    with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", mock.Mock(side_effect=list_cross)):
        L.press_new_persona(sh, personas)
    return sh


class PressNewPersona(unittest.TestCase):
    def test_a_the_list_cross_then_n_downs_then_the_pick_cross(self):
        for n in (1, 2, 3):
            sh = run_new(n, F.KBD_NAME)
            self.assertEqual(sh.presses, [KEY_CROSS] + [KEY_DOWN] * n + [KEY_CROSS], n)
            self.assertIn(f"[lobby] {L.CLASS_NEW_PERSONA} press=cross verified=True attempt=1", sh.logs)
            self.assertIn(f"[login] new persona: {n} DOWN(s) past the saved personas, keyboard title edge 163 "
                          f"-> Enter Player Name", sh.logs)
            self.assertFalse([m for m in sh.logs if "LOBBY-FAIL" in m])

    def test_b_no_down_comes_before_the_list_cross(self):
        # the DOWN before the list CROSS moves the form's cursor to PASSWORD instead of walking the list
        sh = run_new(2, F.KBD_NAME)
        self.assertEqual(sh.presses[0], KEY_CROSS)

    def test_c_the_password_keyboard_after_the_pick_fails_with_its_class(self):
        # the pick landed on a saved persona: its password keyboard opened, and typing B's password there would log
        # in as A -- the run stops here
        sh, g = T.FakeShell(), Grabs(ON_PLAYER_NAME, F.KBD_PASSWORD)
        with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", mock.Mock(side_effect=list_cross)), \
                self.assertRaises(L.LobbyFail) as cm:
            L.press_new_persona(sh, 1)
        self.assertEqual(cm.exception.cls, "login:persona:new-persona")
        self.assertIn("LOBBY class=login:persona:new-persona", sh.logs)
        self.assertIn("195", cm.exception.detail)

    def test_d_no_keyboard_after_the_pick_fails_with_the_same_class(self):
        sh, g = T.FakeShell(), Grabs(ON_PLAYER_NAME, F.FORM_SAVED)
        with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", mock.Mock(side_effect=list_cross)), \
                self.assertRaises(L.LobbyFail) as cm:
            L.press_new_persona(sh, 1)
        self.assertEqual(cm.exception.cls, "login:persona:new-persona")
        self.assertIn(PAD_CROSS, sh.presses)      # the pick CROSS was re-sent through the pad before the verdict

    def test_e_zero_or_fewer_saved_personas_is_refused(self):
        with self.assertRaises(ValueError):
            L.press_new_persona(T.FakeShell(), 0)


class TheFocusWalk(unittest.TestCase):
    """Step 0's launch 2: the form arrived on CONNECT, and the list CROSS must wait for PLAYER NAME to read lit."""

    def run_walk(self, personas, *frames):
        sh, g = T.FakeShell(), Grabs(*frames)
        lst = mock.Mock(side_effect=list_cross)
        with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", lst):
            L.press_new_persona(sh, personas)
        return sh

    def test_the_fixtures_read_as_their_rows(self):
        rows = [L.login_focus_row(F.gray(f)) for f in WALK_FROM_CONNECT]
        self.assertEqual(rows, ["connect", "gender", "hometown", "save_password", "password", "player_name"])
        self.assertTrue(all(L.login_form_up(F.gray(f)) for f in WALK_FROM_CONNECT))
        self.assertEqual(L.login_save_password(F.gray(ON_CONNECT)), "yes")

    def test_a_from_connect_five_ups_each_read_back_then_the_list_cross(self):
        for n in (1, 2):
            sh = self.run_walk(n, *WALK_FROM_CONNECT, F.KBD_NAME)
            self.assertEqual(sh.presses, [KEY_UP] * 5 + [KEY_CROSS] + [KEY_DOWN] * n + [KEY_CROSS], n)
            walk = [m for m in sh.logs if m.startswith("[login] new persona: focus")]
            self.assertEqual(walk, ["[login] new persona: focus connect after 0 UP(s)",
                                    "[login] new persona: focus gender after 1 UP(s)",
                                    "[login] new persona: focus hometown after 2 UP(s)",
                                    "[login] new persona: focus save_password after 3 UP(s)",
                                    "[login] new persona: focus password after 4 UP(s)",
                                    "[login] new persona: focus player_name after 5 UP(s)"])
            self.assertIn(f"[lobby] {L.CLASS_NEW_PERSONA} press=cross verified=True attempt=1", sh.logs)
            self.assertFalse([m for m in sh.logs if "LOBBY-FAIL" in m])

    def test_a_from_password_one_up(self):
        # a saved persona without its password (the LAN card, s6_ladder7): the cursor arrives on PASSWORD
        sh = self.run_walk(1, ON_PASSWORD, ON_PLAYER_NAME, F.KBD_NAME)
        self.assertEqual(sh.presses, [KEY_UP, KEY_CROSS, KEY_DOWN, KEY_CROSS])

    def test_a_already_on_player_name_no_up(self):
        sh = self.run_walk(1, ON_PLAYER_NAME, F.KBD_NAME)
        self.assertEqual(sh.presses, [KEY_CROSS, KEY_DOWN, KEY_CROSS])
        self.assertIn("[login] new persona: focus player_name after 0 UP(s)", sh.logs)

    def test_a_a_dropped_up_is_pressed_again_and_an_unread_frame_is_read_again(self):
        sh = self.run_walk(1, ON_CONNECT, ON_CONNECT, F.BLACK, ON_GENDER, ON_HOMETOWN, ON_SAVE, ON_PASSWORD,
                           ON_PLAYER_NAME, F.KBD_NAME)
        # six UPs for five rows (the second read still on CONNECT); nothing pressed on the unread frame
        self.assertEqual(sh.presses, [KEY_UP] * 6 + [KEY_CROSS, KEY_DOWN, KEY_CROSS])
        self.assertIn("[login] new persona: focus unread after 2 UP(s)", sh.logs)
        self.assertEqual(sh.sleeps, [L.NEW_PERSONA_DOWN_S])

    def test_b_a_focus_that_never_reaches_player_name_fails_with_its_class_and_no_cross(self):
        self.assertEqual(L.NEW_PERSONA_FOCUS_UPS, 8)          # CONNECT is 5 rows below PLAYER NAME, and 3 spare
        sh, g = T.FakeShell(), Grabs(ON_CONNECT)
        lst = mock.Mock(side_effect=list_cross)
        with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", lst), \
                self.assertRaises(L.LobbyFail) as cm:
            L.press_new_persona(sh, 1)
        self.assertEqual(cm.exception.cls, "login:persona:focus")
        self.assertEqual(L.CLASS_PERSONA_FOCUS, "login:persona:focus")
        self.assertIn("LOBBY class=login:persona:focus", sh.logs)
        self.assertEqual(sh.presses, [KEY_UP] * L.NEW_PERSONA_FOCUS_UPS)
        self.assertNotIn(KEY_CROSS, sh.presses)
        self.assertNotIn(PAD_CROSS, sh.presses)
        lst.assert_not_called()
        self.assertIn("connect", cm.exception.detail)

    def test_b_no_form_on_screen_presses_nothing_at_all(self):
        sh, g = T.FakeShell(), Grabs(F.BLACK)
        lst = mock.Mock(side_effect=list_cross)
        with mock.patch.object(L.winshot, "grab", g), mock.patch.object(L, "press_persona_list", lst), \
                self.assertRaises(L.LobbyFail) as cm:
            L.press_new_persona(sh, 1)
        self.assertEqual(cm.exception.cls, "login:persona:focus")
        self.assertEqual(sh.presses, [])
        lst.assert_not_called()


class CreatePersonaFromTheOpenKeyboard(unittest.TestCase):
    def test_the_walk_starts_at_the_name_keyboard_with_no_persona_cross(self):
        sh, g = T.FakeShell(), Grabs(F.KBD_NAME, F.FORM_NAME_TYPED, F.FORM_PASSWORD_LIT, F.KBD_PASSWORD)
        with mock.patch.object(L.winshot, "grab", g):
            L.create_persona(sh, "socom", keyboard_open=True)
        self.assertEqual(sh.presses, [("type", "socom"), KEY_DOWN, KEY_CROSS])
        self.assertIn("[login] persona: PLAYER NAME reads 5 glyphs, expected 5", sh.logs)


class LoginNewPersona(unittest.TestCase):
    """login(new_persona=N): no persona_form_mode, the list walk, then the create walk from the open keyboard."""

    def test_the_create_path_by_the_option(self):
        calls = []
        sh, g = T.FakeShell(), Grabs(F.FORM_SAVED)   # PLAYER NAME filled: persona_form_mode would have said "saved"
        stub = mock.patch.multiple(
            L, persona_form_mode=mock.Mock(side_effect=AssertionError("persona_form_mode must not run")),
            press_new_persona=mock.Mock(side_effect=lambda s, n: calls.append(("new", n))),
            create_persona=mock.Mock(side_effect=lambda s, n, listed=False, prefilled=False, keyboard_open=False:
                                     calls.append(("create", n, keyboard_open))),
            press_connect=mock.Mock(side_effect=lambda s: calls.append(("connect",))),
            login_prompts=mock.Mock(side_effect=lambda s: calls.append(("prompts",))),
            login_to_lobby=mock.Mock(side_effect=lambda s: calls.append(("lobby",))))
        with mock.patch.object(L.winshot, "grab", g), stub, \
                mock.patch.object(T.FakeShell, "press_until_gone", lambda *a, **k: True), \
                mock.patch.object(T.FakeShell, "wait_for", lambda *a, **k: True):
            L.login(sh, "bravo", "pw2", existing=True, new_persona=1)
        self.assertEqual(calls, [("new", 1), ("create", "bravo", True), ("connect",), ("prompts",), ("lobby",)])
        self.assertIn("[login] persona: --new-persona 1 -> creating bravo past the card's saved persona(s)", sh.logs)
        self.assertEqual(sh.presses, [("type", "pw2")])


class Arguments(unittest.TestCase):
    def test_the_option_parses_and_refuses_the_saved_password_relaunch(self):
        self.assertEqual(L.parse_args(["--new-persona", "2"]).new_persona, 2)
        self.assertIsNone(L.parse_args([]).new_persona)
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            L.parse_args(["--new-persona", "1", "--saved-password"])
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            L.parse_args(["--new-persona", "0"])


if __name__ == "__main__":
    unittest.main()
