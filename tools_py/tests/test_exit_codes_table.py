"""Sprint 9 Goal 1: the exit-code table in ps2xShared/include/ps2x/exit_codes.h, read from Python.

The header is the one place a code or its sentence is written; tools_py/exit_codes.py reads it with a
regex so the harness, these tests and the launcher can never disagree about what 66 means."""
import unittest

from tools_py import exit_codes


class ExitCodeTableTest(unittest.TestCase):
    def test_the_header_parses_into_fourteen_rows(self):
        rows = exit_codes.table()
        self.assertEqual([r["code"] for r in rows], [0, 1, 3, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 76])
        self.assertEqual(rows[3]["name"], "NoUsableGl")
        self.assertEqual(rows[3]["slug"], "no-usable-gl")

    def test_every_code_is_a_byte_outside_the_shells_range_and_unique(self):
        rows = exit_codes.table()
        codes = [r["code"] for r in rows]
        self.assertEqual(len(codes), len(set(codes)))
        for r in rows:
            self.assertTrue(0 <= r["code"] <= 255, r)
            self.assertFalse(126 <= r["code"] <= 165, r)
            self.assertTrue(0 < len(r["sentence"]) <= 120, r)
            self.assertTrue(r["sentence"].endswith("."), r)

    def test_65_is_still_the_gl_fallback(self):
        self.assertIn("OpenGL 3.3", exit_codes.sentence(65))

    def test_classify_folds_native_crash_statuses_onto_70(self):
        self.assertEqual(exit_codes.classify(3221225477), 70)   # 0xC0000005 as subprocess reports it on Windows
        self.assertEqual(exit_codes.classify(-11), 70)          # subprocess reports "killed by SIGSEGV" as -11 on POSIX
        self.assertEqual(exit_codes.classify(-6), 70)           # SIGABRT
        self.assertEqual(exit_codes.classify(139), 70)          # a shell's 128 + 11
        self.assertEqual(exit_codes.classify(-9), 137)          # SIGKILL is not a crash
        self.assertEqual(exit_codes.classify(66), 66)
        self.assertEqual(exit_codes.classify(0), 0)

    def test_describe_matches_the_headers_fallback(self):
        self.assertEqual(exit_codes.describe(42), "The game closed with code 42. Press SAVE DIAGNOSTICS to collect the log.")
        self.assertEqual(exit_codes.describe(-11), exit_codes.sentence(70))


if __name__ == "__main__":
    unittest.main()
