"""drive.py finds the game's window by process identity, not by the first title match (issue #118).

2026-09-29/30: seven mission walks captured a maximised browser tab on the site -- its page title ends in
`-- SOCOM Unzipped`, the substring `keys.WINDOW_TITLES["ours"]` searches for -- because `winshot.find_window` returns
the FIRST visible top-level window whose title contains it, and the browser came before the game in the enumeration.
Each walk failed at `s00_CROSS.png` on a 1913x1229 client area. The driver launched the game itself, so it knows the
process: it now asks for the window of the launched pid or of one of its descendants (launch() goes through
`bash run.sh` -> `timeout` -> the exe on Windows and `timeout` -> the exe on Linux), and uses the title alone only when
it did not launch the game. At attach it names the hwnd, the pid and the client size, and a window whose client area
is not 640x448 is refused there, naming its title, instead of at the first capture.

No window is created and no process is spawned: the enumeration is faked through `drive.winshot`'s functions, and on
Windows once more through winshot's own user32 seam.
"""
import contextlib
import io
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

from tools_py.parity import drive, winshot

TITLE = "-- SOCOM Unzipped"
BROWSER = (0x65, 7777, "Mission walkthrough -- SOCOM Unzipped - Google Chrome", (1913, 1229))
GAME = (0xCA, 4242, "SOCOM II r0004 -- SOCOM Unzipped", (640, 448))
WRAPPER_PID, TIMEOUT_PID = 4000, 4100       # bash run.sh, then timeout: neither owns a window


class FakeDesktop:
    """The top-level windows in enumeration order, as winshot's find_window / window_pid / client_size /
    window_title answer for them. The foreign window is first: the order that bit on 2026-09-30."""

    def __init__(self, windows=(BROWSER, GAME)):
        self.windows = list(windows)
        self.searches = []

    def find_window(self, title_substring, pid=None):
        self.searches.append(pid)
        for hwnd, owner, title, _size in self.windows:
            if (pid is None or owner == pid) and title_substring.lower() in title.lower():
                return hwnd
        return None

    def _row(self, hwnd):
        return next(w for w in self.windows if w[0] == hwnd)

    def window_pid(self, hwnd):
        return self._row(hwnd)[1]

    def window_title(self, hwnd):
        return self._row(hwnd)[2]

    def client_size(self, hwnd):
        return self._row(hwnd)[3]

    def patches(self):
        return [mock.patch.object(drive.winshot, name, getattr(self, name))
                for name in ("find_window", "window_pid", "window_title", "client_size")]


def tree(root):
    """The launched wrapper's process tree, root first: run.sh -> timeout -> the game."""
    return {WRAPPER_PID: [WRAPPER_PID, TIMEOUT_PID, GAME[1]]}.get(root, [root])


class FindGameWindowTest(unittest.TestCase):
    def test_the_launched_games_window_wins_over_a_foreign_one_enumerated_first(self):
        desk = FakeDesktop()
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            hwnd, pid, how = drive.find_game_window(TITLE, launched_pid=WRAPPER_PID, tree=tree)
        self.assertEqual((hwnd, pid, how), (GAME[0], GAME[1], "pid"))
        self.assertNotIn(None, desk.searches, "a launched game is never looked up by title alone")

    def test_the_launched_pid_itself_is_asked_first(self):
        desk = FakeDesktop()
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            hwnd, pid, how = drive.find_game_window(TITLE, launched_pid=GAME[1], tree=tree)
        self.assertEqual((hwnd, pid, how), (GAME[0], GAME[1], "pid"))
        self.assertEqual(desk.searches, [GAME[1]])

    def test_no_window_yet_in_the_launched_tree_is_none_not_the_browser(self):
        desk = FakeDesktop(windows=(BROWSER,))
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            hwnd, pid, how = drive.find_game_window(TITLE, launched_pid=WRAPPER_PID, tree=tree)
        self.assertIsNone(hwnd)
        self.assertEqual(how, "pid")

    def test_attach_only_still_uses_the_title_search(self):
        desk = FakeDesktop(windows=(GAME,))
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            hwnd, pid, how = drive.find_game_window(TITLE, launched_pid=None, tree=tree)
        self.assertEqual((hwnd, pid, how), (GAME[0], GAME[1], "title"))
        self.assertEqual(desk.searches, [None])


@unittest.skipUnless(os.name == "nt", "winshot's user32 seam is the Win32 API")
class FindGameWindowThroughUser32Test(unittest.TestCase):
    """The same regression one layer down: winshot's real find_window enumerates a fake user32 whose EnumWindows
    hands the browser first, and the driver still settles on the launched game's window."""

    def _fake_user32(self, windows):
        rows = {w[0]: w for w in windows}

        class U:
            def EnumWindows(self, cb, lparam):
                for hwnd, *_ in windows:
                    if not cb(hwnd, lparam):
                        break
                return 1

            def IsWindowVisible(self, hwnd):
                return 1

            def GetWindowThreadProcessId(self, hwnd, ppid):
                ppid._obj.value = rows[hwnd][1]
                return 1

            def GetWindowTextLengthW(self, hwnd):
                return len(rows[hwnd][2])

            def GetWindowTextW(self, hwnd, buf, n):
                buf.value = rows[hwnd][2][:n - 1]
                return len(buf.value)
        return U()

    def test_the_second_window_is_picked_when_it_is_the_launched_ones(self):
        with mock.patch.object(winshot, "user32", self._fake_user32([BROWSER, GAME])):
            self.assertEqual(winshot.find_window(TITLE), BROWSER[0], "the title alone takes the browser: #118")
            hwnd, pid, how = drive.find_game_window(TITLE, launched_pid=WRAPPER_PID, tree=tree)
        self.assertEqual((hwnd, pid, how), (GAME[0], GAME[1], "pid"))


class ProcessTreeTest(unittest.TestCase):
    def test_root_first_then_its_descendants_through_psutil(self):
        class Proc:
            def __init__(self, pid):
                self.pid = pid

            def children(self, recursive=False):
                assert recursive
                return [Proc(TIMEOUT_PID), Proc(GAME[1])] if self.pid == WRAPPER_PID else []

        fake = types.SimpleNamespace(Process=Proc)
        with mock.patch.dict(sys.modules, {"psutil": fake}):
            self.assertEqual(drive.process_tree_pids(WRAPPER_PID), [WRAPPER_PID, TIMEOUT_PID, GAME[1]])

    def test_a_process_that_is_gone_is_just_itself(self):
        def gone(pid):
            raise RuntimeError("no such process")

        with mock.patch.dict(sys.modules, {"psutil": types.SimpleNamespace(Process=gone)}):
            self.assertEqual(drive.process_tree_pids(WRAPPER_PID), [WRAPPER_PID])


class AttachTest(unittest.TestCase):
    def test_the_attach_line_names_hwnd_pid_client_size_and_the_method(self):
        desk = FakeDesktop()
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stdout(out))
            drive.settle_attach(GAME[0], GAME[1], "pid")
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=pid", out.getvalue())

    def test_a_window_that_is_not_640x448_is_refused_at_attach_naming_its_title(self):
        desk = FakeDesktop()
        with contextlib.ExitStack() as stack:
            for p in desk.patches():
                stack.enter_context(p)
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with self.assertRaises(SystemExit) as cm:
                drive.settle_attach(BROWSER[0], BROWSER[1], "title")
        msg = str(cm.exception.code)
        self.assertIn(BROWSER[2], msg)
        self.assertIn("1913x1229", msg)

    def test_main_attaches_to_the_launched_games_window_not_the_browser(self):
        desk = FakeDesktop()
        seen = {}

        def run_steps(a, steps, proc, hwnd, t0, last, manifest):
            seen["hwnd"] = hwnd

        with tempfile.TemporaryDirectory(prefix="drive_window_") as tmp:
            script = os.path.join(tmp, "script.txt")
            with open(script, "w", encoding="utf-8") as fh:
                fh.write("stable+1:CROSS\n")
            argv = ["drive", "--target", "ours", "--script", script, "--out", os.path.join(tmp, "out")]
            out = io.StringIO()
            with contextlib.ExitStack() as stack:
                for p in desk.patches():
                    stack.enter_context(p)
                for p in (mock.patch.object(sys, "argv", argv),
                          mock.patch.object(drive.hostplatform, "process_running", lambda base: False),
                          mock.patch.object(drive.hostplatform, "kill_process_by_name", lambda base: None),
                          mock.patch.object(drive, "launch", lambda target, seconds: mock.Mock(pid=WRAPPER_PID)),
                          mock.patch.object(drive, "process_tree_pids", tree),
                          mock.patch.object(drive.winshot, "keep_on_top", lambda hwnd: None),
                          mock.patch.object(drive, "frame", lambda hwnd: object()),
                          mock.patch.object(drive, "run_steps", run_steps),
                          contextlib.redirect_stdout(out)):
                    stack.enter_context(p)
                drive.main()
        self.assertEqual(seen["hwnd"], GAME[0])
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=pid", out.getvalue())


if __name__ == "__main__":
    unittest.main()
