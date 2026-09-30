"""drive.py finds the game's window by process identity, not by the first title match (issue #118).

2026-09-29/30: seven mission walks captured a maximised browser tab on the site -- its page title ends in
`-- SOCOM Unzipped`, the substring `keys.WINDOW_TITLES["ours"]` searches for -- because `winshot.find_window` returns
the FIRST visible top-level window whose title contains it, and the browser came before the game in the enumeration.
Each walk failed at `s00_CROSS.png` on a 1913x1229 client area. The driver launched the game itself, so it knows the
process: it asks for the window of the launched pid or one of its descendants (PCSX2; our exe on Linux), then of a
process whose image is the runtime exe's name created after the launch (our exe on Windows), and uses the title alone
only when it did not launch the game. At attach it names the hwnd, the pid and the client size, and a window whose
client area is not 640x448 is refused there, naming its title, instead of at the first capture.

The Windows chain the doubles model is the REAL one (review of 4e26f1a4, and the probe below): launch() runs
`bash ./run.sh`, Git Bash's fork leaves `timeout.exe` -> socom2.exe with no parent chain back to the launched bash, so
the launched pid's tree is the bash alone and the exe that owns the window is an orphan.

The unit tests create no window and spawn no process: the enumeration is faked through `drive.winshot`'s functions,
once more on Windows through winshot's own user32 seam, and psutil through sys.modules. One Windows-only integration
test launches a real `bash run_t.sh` whose `timeout 8 PING.EXE` stands in for the game (no game, no window).
"""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

from tools_py.parity import drive, winshot
from tools_py.tests.shell import BASH

TITLE = "-- SOCOM Unzipped"
BROWSER = (0x65, 7777, "Mission walkthrough -- SOCOM Unzipped - Google Chrome", (1913, 1229))
GAME = (0xCA, 4242, "SOCOM II r0004 -- SOCOM Unzipped", (640, 448))
BASH_PID = 4000                 # the launched `bash ./run.sh`: owns no window, and no Windows child either
LAUNCHED_AT = 1_000_000.0
EXE = "socom2.exe"


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


def windows_tree(root):
    """The real Windows launch: the launched bash's tree is the bash alone (timeout and the exe are orphaned)."""
    return [root]


def linux_tree(root):
    """The Linux launch: `timeout` -> the exe, both descendants of the launched process."""
    return {BASH_PID: [BASH_PID, 4100, GAME[1]]}.get(root, [root])


def exe_pids(name, since):
    """launched_exe_pids' double: the game is the only socom2.exe, created after the launch."""
    return [GAME[1]] if name.lower() == EXE and since <= LAUNCHED_AT + 2.0 else []


@contextlib.contextmanager
def desktop(desk):
    with contextlib.ExitStack() as stack:
        for p in desk.patches():
            stack.enter_context(p)
        yield desk


class FindGameWindowTest(unittest.TestCase):
    def test_windows_chain_the_orphaned_exes_window_wins_over_a_browser_enumerated_first(self):
        with desktop(FakeDesktop()) as desk:
            got = drive.find_game_window(TITLE, launched_pid=BASH_PID, tree=windows_tree, exe_name=EXE,
                                         launched_at=LAUNCHED_AT, exe_pids=exe_pids)
        self.assertEqual(got, (GAME[0], GAME[1], "exe"))
        self.assertNotIn(None, desk.searches, "a launched game is never looked up by title alone")

    def test_linux_chain_the_descendants_window_is_found_by_pid(self):
        with desktop(FakeDesktop()) as desk:
            got = drive.find_game_window(TITLE, launched_pid=BASH_PID, tree=linux_tree, exe_name=EXE,
                                         launched_at=LAUNCHED_AT, exe_pids=exe_pids)
        self.assertEqual(got, (GAME[0], GAME[1], "pid"))
        self.assertNotIn(None, desk.searches)

    def test_pcsx2_the_launched_pid_itself_owns_the_window(self):
        with desktop(FakeDesktop()) as desk:
            got = drive.find_game_window(TITLE, launched_pid=GAME[1], tree=windows_tree)
        self.assertEqual(got, (GAME[0], GAME[1], "pid"))
        self.assertEqual(desk.searches, [GAME[1]])

    def test_no_game_window_yet_is_none_not_the_browser(self):
        with desktop(FakeDesktop(windows=(BROWSER,))):
            got = drive.find_game_window(TITLE, launched_pid=BASH_PID, tree=windows_tree, exe_name=EXE,
                                         launched_at=LAUNCHED_AT, exe_pids=exe_pids)
        self.assertEqual(got, (None, None, "pid"))

    def test_without_an_exe_name_an_orphaned_window_is_not_taken_by_title(self):
        with desktop(FakeDesktop()):
            got = drive.find_game_window(TITLE, launched_pid=BASH_PID, tree=windows_tree)
        self.assertEqual(got, (None, None, "pid"), "the loud failure, never a bare title fallback")

    def test_attach_only_still_uses_the_title_search(self):
        with desktop(FakeDesktop(windows=(GAME,))) as desk:
            got = drive.find_game_window(TITLE, launched_pid=None, tree=windows_tree)
        self.assertEqual(got, (GAME[0], GAME[1], "title"))
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

    def test_the_second_window_is_picked_when_it_is_the_launched_games(self):
        with mock.patch.object(winshot, "user32", self._fake_user32([BROWSER, GAME])):
            self.assertEqual(winshot.find_window(TITLE), BROWSER[0], "the title alone takes the browser: #118")
            got = drive.find_game_window(TITLE, launched_pid=BASH_PID, tree=windows_tree, exe_name=EXE,
                                         launched_at=LAUNCHED_AT, exe_pids=exe_pids)
        self.assertEqual(got, (GAME[0], GAME[1], "exe"))


class FakeProc:
    def __init__(self, pid, name=None, created=None, children=()):
        self.pid, self._children = pid, list(children)
        self.info = {"name": name, "create_time": created}

    def children(self, recursive=False):
        assert recursive
        return self._children


class ProcessSearchTest(unittest.TestCase):
    def test_process_tree_root_first_then_its_descendants(self):
        fake = types.SimpleNamespace(Process=lambda pid: FakeProc(pid, children=[FakeProc(4100), FakeProc(4242)]))
        with mock.patch.dict(sys.modules, {"psutil": fake}):
            self.assertEqual(drive.process_tree_pids(BASH_PID), [BASH_PID, 4100, 4242])

    def test_a_process_that_is_gone_is_just_itself(self):
        def gone(pid):
            raise RuntimeError("no such process")

        with mock.patch.dict(sys.modules, {"psutil": types.SimpleNamespace(Process=gone)}):
            self.assertEqual(drive.process_tree_pids(BASH_PID), [BASH_PID])

    def test_launched_exe_pids_takes_only_the_runtime_exe_started_after_the_launch(self):
        procs = [FakeProc(7777, "chrome.exe", LAUNCHED_AT + 5.0),        # a new browser tab process: wrong name
                 FakeProc(3000, "socom2.exe", LAUNCHED_AT - 600.0),     # an older game: before the launch
                 FakeProc(4242, "SOCOM2.EXE", LAUNCHED_AT + 2.0),       # the launched game (any case)
                 FakeProc(4300, "timeout.exe", LAUNCHED_AT + 1.5),
                 FakeProc(4400, None, None)]                            # access denied: no info
        fake = types.SimpleNamespace(process_iter=lambda attrs: iter(procs))
        with mock.patch.dict(sys.modules, {"psutil": fake}):
            self.assertEqual(drive.launched_exe_pids(EXE, LAUNCHED_AT), [4242])

    def test_launched_exe_pids_without_psutil_is_empty(self):
        with mock.patch.dict(sys.modules, {"psutil": None}):
            self.assertEqual(drive.launched_exe_pids(EXE, LAUNCHED_AT), [])


def _psutil_available():
    try:
        import psutil  # noqa: F401
        return True
    except ImportError:
        return False


@unittest.skipUnless(os.name == "nt" and BASH and _psutil_available(),
                     "the real Windows launch chain: Git Bash, psutil")
class RealWindowsLaunchChainTest(unittest.TestCase):
    """The review's probe as a test: `bash ./run_t.sh 8` launched as launch() launches it (Popen from this Python,
    DEVNULL outputs), run_t.sh running `timeout <s> PING.EXE ...` where run.sh runs `timeout <s> socom2.exe ...`.
    PING.EXE stands in for the game; no game, no window. The launched bash's tree does not reach it; the exe-name
    leg does."""

    def test_the_timeout_child_is_orphaned_and_found_by_its_exe_name(self):
        with tempfile.TemporaryDirectory(prefix="drive_chain_") as tmp:
            with open(os.path.join(tmp, "run_t.sh"), "w", encoding="utf-8", newline="\n") as fh:
                fh.write('#!/usr/bin/env bash\ntimeout "${1:-8}" PING.EXE -n 6 127.0.0.1 > /dev/null 2>&1\n')
            launched_at = time.time()
            proc = subprocess.Popen([BASH, "./run_t.sh", "8"], cwd=tmp,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                found = []
                deadline = time.time() + 6.0
                while not found and time.time() < deadline:
                    found = drive.launched_exe_pids("PING.EXE", launched_at)
                    time.sleep(0.2)
                tree = drive.process_tree_pids(proc.pid)
                print(f"\nprobe: bash pid={proc.pid} process_tree_pids={tree} launched_exe_pids(PING.EXE)={found}")
                self.assertTrue(found, "the timeout-launched PING.EXE is found by name and start time")
                self.assertFalse(set(found) & set(tree), "and it is not in the launched bash's tree (orphaned)")
                owner = found[0]
                desk = FakeDesktop(windows=(BROWSER, (GAME[0], owner, GAME[2], GAME[3])))
                with desktop(desk):
                    got = drive.find_game_window(TITLE, launched_pid=proc.pid, exe_name="PING.EXE",
                                                 launched_at=launched_at)
                print(f"probe: find_game_window -> {got}")
                self.assertEqual(got, (GAME[0], owner, "exe"))
            finally:
                proc.wait(timeout=15)


class AttachTest(unittest.TestCase):
    def test_the_attach_line_names_hwnd_pid_client_size_and_the_method(self):
        out = io.StringIO()
        with desktop(FakeDesktop()), contextlib.redirect_stdout(out):
            drive.settle_attach(GAME[0], GAME[1], "exe")
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=exe", out.getvalue())

    def test_a_window_that_is_not_640x448_is_refused_at_attach_naming_its_title(self):
        with desktop(FakeDesktop()), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                drive.settle_attach(BROWSER[0], BROWSER[1], "title")
        msg = str(cm.exception.code)
        self.assertIn(BROWSER[2], msg)
        self.assertIn("1913x1229", msg)

    def _main(self, desk, exe_search, system, tree=windows_tree):
        """drive.main() for `--target ours` on the host `system` names ("Windows" or "Linux"), whatever host runs
        the suite: main() takes the exe name from hostplatform.runtime_exe(), which is socom2.exe on Windows and
        socom2 on Linux, so a chain is modelled under the platform it claims (the Linux runner reddened on a
        Windows chain that read the host's platform, issue #118)."""
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
                stack.enter_context(desktop(desk))
                host = types.SimpleNamespace(system=lambda: system)
                for p in (mock.patch.object(drive.hostplatform, "platform", host),
                          mock.patch.object(sys, "argv", argv),
                          mock.patch.dict(os.environ, {"SOCOM_EXE": ""}),
                          mock.patch.object(drive.hostplatform, "process_running", lambda base: False),
                          mock.patch.object(drive.hostplatform, "kill_process_by_name", lambda base: None),
                          mock.patch.object(drive, "launch", lambda target, seconds: mock.Mock(pid=BASH_PID)),
                          mock.patch.object(drive, "process_tree_pids", tree),
                          mock.patch.object(drive, "launched_exe_pids", exe_search),
                          mock.patch.object(drive.winshot, "keep_on_top", lambda hwnd: None),
                          mock.patch.object(drive, "frame", lambda hwnd: object()),
                          mock.patch.object(drive, "run_steps", run_steps),
                          contextlib.redirect_stdout(out)):
                    stack.enter_context(p)
                drive.main()
        return seen, out.getvalue()

    def test_main_on_the_windows_chain_attaches_to_the_games_window_not_the_browser(self):
        asked = []

        def exe_search(name, since):
            asked.append((name, since))
            return [GAME[1]] if name.lower() == EXE and since <= time.time() else []

        seen, out = self._main(FakeDesktop(), exe_search, "Windows")
        self.assertEqual(seen["hwnd"], GAME[0])
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=exe", out)
        self.assertEqual(asked[0][0].lower(), EXE, "the runtime exe's own name, from hostplatform.runtime_exe()")

    def test_main_on_linux_the_exe_name_search_asks_for_socom2_without_the_suffix(self):
        # The exe-name leg with the game outside the launched tree, on Linux: main() asks for `socom2`, the name
        # the Linux build writes (dist-linux/socom2), and attaches to the game's window, not the browser.
        asked = []

        def exe_search(name, since):
            asked.append((name, since))
            return [GAME[1]] if name == "socom2" and since <= time.time() else []

        seen, out = self._main(FakeDesktop(), exe_search, "Linux")
        self.assertEqual(seen["hwnd"], GAME[0])
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=exe", out)
        self.assertEqual(asked[0][0], "socom2", "the Linux runtime exe's name, from hostplatform.runtime_exe()")

    def test_main_on_the_linux_chain_attaches_to_the_launched_trees_window(self):
        # The real Linux launch: the exe is a descendant of the launched process, found by pid before any name.
        asked = []
        seen, out = self._main(FakeDesktop(), lambda name, since: asked.append(name) or [], "Linux", tree=linux_tree)
        self.assertEqual(seen["hwnd"], GAME[0])
        self.assertIn("attach: hwnd=0xca pid=4242 client=640x448 found_by=pid", out)
        self.assertEqual(asked, [], "the exe-name search is not needed when the tree owns the window")


if __name__ == "__main__":
    unittest.main()
