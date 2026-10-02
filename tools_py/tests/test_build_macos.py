"""scripts/build_macos.sh refuses up front what would otherwise fail deep inside a build (final review, I5).

FFmpeg's configure stops on a source path with whitespace ("Out of tree builds are impossible with whitespace in
source path"), buried in an ExternalProject log; the script says so before configuring anything.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@unittest.skipUnless(sys.platform == "darwin", "build_macos.sh is the macOS build")
class BuildMacosRefusals(unittest.TestCase):
    def test_a_checkout_path_with_whitespace_is_refused_before_anything_builds(self):
        d = tempfile.mkdtemp()
        try:
            spaced = os.path.join(d, "my games")
            os.symlink(ROOT, spaced)
            p = subprocess.run(["bash", os.path.join(spaced, "scripts", "build_macos.sh"), "tools"],
                               capture_output=True, text=True, timeout=20)
            self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
            self.assertIn("whitespace", p.stderr)
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
