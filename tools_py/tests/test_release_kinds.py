"""Sprint 16 R3a: the player exe drops the debug UI and the developer exe keeps it. Proved on the two built
exes when both exist on this machine (`./build.sh release`, then `PS2X_RELEASE_KIND=developer ./build.sh
release`): the player's bytes carry no `imgui`, any case, and the developer's do."""
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLAYER = os.path.join(ROOT, "dist-release", "socom2.exe")
DEVELOPER = os.path.join(ROOT, "dist-release-dev", "socom2.exe")


def has_imgui(path):
    with open(path, "rb") as fh:
        return b"imgui" in fh.read().lower()


@unittest.skipUnless(os.path.isfile(PLAYER) and os.path.isfile(DEVELOPER),
                     "needs dist-release/socom2.exe and dist-release-dev/socom2.exe (both release kinds built)")
class BuiltReleaseKindsTest(unittest.TestCase):
    def test_the_player_exe_has_no_imgui_and_the_developer_exe_has_it(self):
        self.assertFalse(has_imgui(PLAYER), PLAYER + " carries imgui: the debug UI is in the player exe")
        self.assertTrue(has_imgui(DEVELOPER), DEVELOPER + " carries no imgui: the debug UI is missing")


class HasImguiTest(unittest.TestCase):
    def test_it_finds_the_name_in_any_case(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            for data, want in ((b"\0\0ImGui::Begin\0", True), (b"\0RLIMGUI\0", True), (b"\0im gui\0", False)):
                path = os.path.join(tmp, "x.exe")
                with open(path, "wb") as fh:
                    fh.write(data)
                self.assertEqual(has_imgui(path), want, data)


if __name__ == "__main__":
    unittest.main()
