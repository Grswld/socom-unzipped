"""The launcher's POSIX glue keeps Linux's behaviour: the macOS port's workarounds are __APPLE__ only.

Darwin has neither pipe2 nor sigtimedwait, so ps2xLauncher/src/posix_glue.cpp uses pipe + FD_CLOEXEC and a
sigpending/sigwait drain there. Linux must keep the atomic pipe2(O_CLOEXEC) -- the non-atomic form lets a child
spawned from another thread inherit a pipe end -- and its original drain (final review, I2).
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GLUE = os.path.join(ROOT, "third_party", "ps2recomp", "ps2xLauncher", "src", "posix_glue.cpp")


def non_apple(text):
    """The file as a non-Apple build sees it: every `#if defined(__APPLE__)` body dropped (none nest)."""
    return re.sub(r"#if defined\(__APPLE__\)\n.*?\n#(else|endif)\n", "", text, flags=re.S)


class PosixGluePlatforms(unittest.TestCase):
    def setUp(self):
        with open(GLUE, encoding="utf-8") as f:
            self.src = f.read()
        self.linux = non_apple(self.src)

    def test_linux_keeps_the_atomic_pipe2(self):
        self.assertIn("return ::pipe2(fds, O_CLOEXEC) == 0;", self.linux)
        self.assertNotIn("::pipe(fds)", self.linux)

    def test_linux_keeps_the_sigtimedwait_drain(self):
        self.assertIn("while (::sigtimedwait(&pipeSet, nullptr, &none) > 0)", self.linux)
        self.assertNotIn("sigpending", self.linux)

    def test_every_spawn_pipe_goes_through_the_helper(self):
        self.assertEqual(len(re.findall(r"!pipeCloexec\((toChild|fromChild)\)", self.src)), 3)
        self.assertNotIn("::pipe2(toChild", self.src)
        self.assertNotIn("::pipe2(fromChild", self.src)


if __name__ == "__main__":
    unittest.main()
