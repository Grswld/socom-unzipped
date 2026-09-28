"""hostplatform: the harness's Windows/Linux split, and x11shot's mirror of winshot.

Sprint 8 Goal 1 Task 9. Every function here takes a `system=` override, so this Windows host
exercises both branches without running anything: the kill/running helpers are split into a pure
argv builder and a thin `run`, and `shot_module` only imports.
"""
import inspect
import os
import unittest

from tools_py.parity import hostplatform as hp
from tools_py.parity import keys, x11shot

WIN, LIN = "Windows", "Linux"


class ExeName(unittest.TestCase):
    def test_windows_appends_exe(self):
        self.assertEqual(hp.exe_name("socom2", system=WIN), "socom2.exe")
        self.assertEqual(hp.exe_name("pcsx2-qt", system=WIN), "pcsx2-qt.exe")

    def test_linux_is_bare(self):
        self.assertEqual(hp.exe_name("socom2", system=LIN), "socom2")
        self.assertEqual(hp.exe_name("pcsx2-qt", system=LIN), "pcsx2-qt")

    def test_is_windows(self):
        self.assertTrue(hp.is_windows(system=WIN))
        self.assertFalse(hp.is_windows(system=LIN))
        self.assertFalse(hp.is_windows(system="Darwin"))

    def test_default_system_is_this_host(self):
        self.assertEqual(hp.is_windows(), os.name == "nt")


class KillArgv(unittest.TestCase):
    def test_windows_taskkill_through_cmd(self):
        # Git Bash mangles a bare "/F" (drive.py's long-standing comment), so taskkill goes through cmd.
        self.assertEqual(hp.kill_argv("socom2", system=WIN),
                         ["cmd", "/c", "taskkill /F /IM socom2.exe"])
        self.assertEqual(hp.kill_argv("pcsx2-qt", system=WIN),
                         ["cmd", "/c", "taskkill /F /IM pcsx2-qt.exe"])

    def test_linux_pkill_on_the_bare_name(self):
        self.assertEqual(hp.kill_argv("socom2", system=LIN), ["pkill", "-x", "socom2"])

    def test_kill_tree_names_one_pid_never_the_image(self):
        # 2026-09-22: a drive beside the owner's own game (--instance) kills by pid, so the owner's
        # socom2.exe on the same PC survives the harness's exit.
        self.assertEqual(hp.kill_tree_argv(4321, system=WIN), ["cmd", "/c", "taskkill /F /T /PID 4321"])
        self.assertEqual(hp.kill_tree_argv("4321", system=LIN), ["pkill", "-9", "-P", "4321"])
        self.assertNotIn("/IM", " ".join(hp.kill_tree_argv(1, system=WIN)))


class RunningArgv(unittest.TestCase):
    def test_windows_tasklist(self):
        self.assertEqual(hp.running_argv("socom2", system=WIN), ["tasklist"])

    def test_linux_pgrep(self):
        self.assertEqual(hp.running_argv("socom2", system=LIN), ["pgrep", "-x", "socom2"])

    def test_windows_reads_the_exe_name_out_of_tasklist(self):
        out = "socom2.exe                    5000 Console                    1    412,000 K\n"
        self.assertTrue(hp.running_from_output("socom2", out, 0, system=WIN))
        self.assertFalse(hp.running_from_output("pcsx2-qt", out, 0, system=WIN))

    def test_linux_reads_pgrep_returncode(self):
        self.assertTrue(hp.running_from_output("socom2", "5000\n", 0, system=LIN))
        self.assertFalse(hp.running_from_output("socom2", "", 1, system=LIN))


class ShotModule(unittest.TestCase):
    def test_linux_is_x11shot(self):
        self.assertIs(hp.shot_module(system=LIN), x11shot)

    @unittest.skipUnless(os.name == "nt", "winshot imports ctypes.windll")
    def test_windows_is_winshot(self):
        from tools_py.parity import winshot
        self.assertIs(hp.shot_module(system=WIN), winshot)


class VkToXdotool(unittest.TestCase):
    """Every VK the harness can send has an X keysym name (socom2_host_input.cpp's keyboard map)."""

    TABLE = {
        0x26: "Up", 0x28: "Down", 0x25: "Left", 0x27: "Right",
        0x0D: "Return", 0x08: "BackSpace", 0x20: "space",
        0x31: "1", 0x32: "2", 0x33: "3", 0x34: "4", 0x37: "7", 0x38: "8",
        0x41: "a", 0x43: "c", 0x44: "d", 0x45: "e", 0x46: "f", 0x47: "g", 0x48: "h",
        0x49: "i", 0x4A: "j", 0x4B: "k", 0x4C: "l", 0x51: "q", 0x53: "s", 0x54: "t",
        0x56: "v", 0x57: "w", 0x58: "x", 0x5A: "z",
    }

    def test_table(self):
        for vk, name in self.TABLE.items():
            self.assertEqual(x11shot.vk_to_xdotool(vk), name, f"VK 0x{vk:02X}")

    def test_every_vk_the_harness_binds(self):
        for target, m in keys.MAPS.items():
            for button, vk in m.items():
                self.assertIn(x11shot.vk_to_xdotool(vk), self.TABLE.values(),
                              f"{target}/{button} (VK 0x{vk:02X})")

    def test_unknown_vk_raises(self):
        with self.assertRaises(KeyError):
            x11shot.vk_to_xdotool(0xFE)

    def test_press_builds_keydown_keyup_on_the_window(self):
        sent = []
        x11shot.press(4242, "cross", "ours", hold_s=0.0, run=sent.append)
        self.assertEqual(sent, [["xdotool", "keydown", "--window", "4242", "x"],
                                ["xdotool", "keyup", "--window", "4242", "x"]])


class MirrorsWinshot(unittest.TestCase):
    """x11shot is winshot's Linux half: the same public callables with the same signatures, so
    every caller that goes through hostplatform.shot_module() needs no branch of its own."""

    @staticmethod
    def public(mod):
        return {n for n, o in vars(mod).items()
                if not n.startswith("_") and callable(o) and getattr(o, "__module__", None) == mod.__name__}

    @unittest.skipUnless(os.name == "nt", "winshot imports ctypes.windll")
    def test_same_public_names(self):
        from tools_py.parity import winshot
        self.assertEqual(self.public(x11shot) - set(x11shot.KEY_INJECTION_NAMES), self.public(winshot))

    @unittest.skipUnless(os.name == "nt", "winshot imports ctypes.windll")
    def test_same_signatures(self):
        from tools_py.parity import winshot
        for name in self.public(winshot):
            win, x11 = getattr(winshot, name), getattr(x11shot, name)
            if not inspect.isfunction(win):          # the two error classes; __init__ below
                continue
            self.assertEqual(str(inspect.signature(x11)), str(inspect.signature(win)), name)
        self.assertEqual(str(inspect.signature(x11shot.StaleFrameError.__init__)),
                         str(inspect.signature(winshot.StaleFrameError.__init__)))

    def test_key_injection_twin_mirrors_keys_press(self):
        # x11shot.press takes keys.press's parameters, plus the injectable `run` the tests use.
        self.assertEqual(list(inspect.signature(x11shot.press).parameters)[:4],
                         list(inspect.signature(keys.press).parameters)[:4])

    def test_frame_retry_and_error_types_exist(self):
        self.assertTrue(issubclass(x11shot.StaleFrameError, RuntimeError))
        self.assertTrue(issubclass(x11shot.ClientRectError, RuntimeError))
        self.assertIsInstance(x11shot.FRAME_RETRY_S, float)


class RuntimeExeOverrideTest(unittest.TestCase):
    """Sprint 9 Goal 2: SOCOM_EXE names the runner the gate and the harness start (the release build lives
    in dist-release/, and the developer's dist/socom2.exe stays the default)."""

    def test_default_is_unchanged_with_an_empty_environment(self):
        self.assertEqual(hp.runtime_exe("Windows", env={}), os.path.join("dist", "socom2.exe"))
        self.assertEqual(hp.runtime_exe("Linux", env={}), os.path.join("dist-linux", "socom2"))

    def test_an_empty_value_is_not_an_override(self):
        self.assertEqual(hp.runtime_exe("Windows", env={"SOCOM_EXE": ""}),
                         os.path.join("dist", "socom2.exe"))

    def test_the_override_is_returned_as_given(self):
        self.assertEqual(hp.runtime_exe("Windows", env={"SOCOM_EXE": "C:/x/dist-release/socom2.exe"}),
                         "C:/x/dist-release/socom2.exe")
        self.assertEqual(hp.runtime_exe("Windows", env={"SOCOM_EXE": "dist-release\SOCOM2.EXE"}),
                         "dist-release\SOCOM2.EXE")
        self.assertEqual(hp.runtime_exe("Linux", env={"SOCOM_EXE": "dist-linux-release/socom2"}),
                         "dist-linux-release/socom2")

    def test_a_runner_under_another_name_is_refused(self):
        # process_running / kill_process_by_name look for "socom2": a runner called anything else would be
        # started and then never seen, never killed.
        with self.assertRaises(ValueError) as caught:
            hp.runtime_exe("Windows", env={"SOCOM_EXE": "dist/socom2_release.exe"})
        self.assertIn("socom2.exe", str(caught.exception))
        with self.assertRaises(ValueError):
            hp.runtime_exe("Linux", env={"SOCOM_EXE": "dist-linux-release/socom2.exe"})


class DevEnvTest(unittest.TestCase):
    """Sprint 9 Goal 3: every harness launch of the runner is a developer-mode launch -- the instruments the
    harness reads (the exported frame, the sampler, the peek rows, the pad file) are Dev knobs."""

    def test_it_sets_the_switch_and_returns_the_same_dict(self):
        env = {"PATH": "x"}
        self.assertIs(hp.dev_env(env), env)
        self.assertEqual(env["PS2X_DEV"], "1")

    def test_an_operators_own_choice_is_left_alone(self):
        self.assertEqual(hp.dev_env({"PS2X_DEV": "0"})["PS2X_DEV"], "0")


if __name__ == "__main__":
    unittest.main()
