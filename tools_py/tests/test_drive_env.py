"""Sprint 17 F0 (c): the player-condition knob, SOCOM_DRIVE_NO_LATEST_FRAME=1.

drive.launch() points the exe at logs/parity/latest_frame.png through PS2X_HOST_SCREENSHOT_LATEST, and the runtime
then rewrites that PNG from the GL thread every ~150 ms -- 169 ms/s of the GL thread's second in research/73, a cost
no player's run has (docs/LATER.md row 43). With the knob set the variable is left unset -- in the child's
environment and in ours, so winshot.grab() finds no frame file and falls back to PrintWindow. Nothing is launched
here: drive.child_env() is the environment launch() hands to run.sh, built from the environment it is given.
"""
import os
import unittest

from tools_py.parity import drive

DEFAULT_LATEST = os.path.abspath(os.path.join("logs", "parity", "latest_frame.png"))


def _parent(**extra):
    # PS2X_CD_IMAGE given, so cd_image_env never looks for a disc (this checkout may have none).
    env = {"PS2X_CD_IMAGE": "stand_in.iso", "PATH": "x"}
    env.update(extra)
    return env


class LatestFrameKnob(unittest.TestCase):
    def test_without_the_knob_the_child_gets_the_default_frame_file(self):
        parent = _parent()
        child = drive.child_env(parent)
        self.assertEqual(child["PS2X_HOST_SCREENSHOT_LATEST"], DEFAULT_LATEST)
        self.assertEqual(parent["PS2X_HOST_SCREENSHOT_LATEST"], DEFAULT_LATEST, "grab() reads it from ours")
        self.assertEqual(child["PS2X_SOCOM2_PAD"], "1")

    def test_with_the_knob_the_child_has_no_frame_file(self):
        parent = _parent(SOCOM_DRIVE_NO_LATEST_FRAME="1")
        child = drive.child_env(parent)
        self.assertNotIn("PS2X_HOST_SCREENSHOT_LATEST", child)
        self.assertNotIn("PS2X_HOST_SCREENSHOT_LATEST", parent, "so grab() falls back to PrintWindow")
        self.assertEqual(child["PS2X_SOCOM2_PAD"], "1", "the rest of the launch environment is unchanged")

    def test_the_knob_wins_over_an_exported_frame_file(self):
        parent = _parent(SOCOM_DRIVE_NO_LATEST_FRAME="1", PS2X_HOST_SCREENSHOT_LATEST="elsewhere.png")
        self.assertNotIn("PS2X_HOST_SCREENSHOT_LATEST", drive.child_env(parent))
        self.assertNotIn("PS2X_HOST_SCREENSHOT_LATEST", parent)

    def test_an_exported_frame_file_wins_without_the_knob(self):
        parent = _parent(PS2X_HOST_SCREENSHOT_LATEST="elsewhere.png", SOCOM_DRIVE_NO_LATEST_FRAME="0")
        self.assertEqual(drive.child_env(parent)["PS2X_HOST_SCREENSHOT_LATEST"], "elsewhere.png")


if __name__ == "__main__":
    unittest.main()
