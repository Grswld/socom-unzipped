"""Sprint 16 Task R1a: the first-run decrypt spike note (docs/research/74-first-run-decrypt-spike.md) says what
the plan needs of it, in the place the plan says.

The note is class S by location and dated in its first fifteen lines. What this pins, from the task's bar
(docs/superpowers/plans/2026-09-27-sprint-16-tasks.md "## Task R1a"): the FIRST section is the decision --
recompile, port or neither, in bold, with its reason; BOTH routes carry a count of the lines that would enter the
tree and name the HLE each needs (the SIF, cdvd and kernel answers decrypt_apache.py stubs); the verification
names the tracked digests file and the "skipped where the disc is not" pattern (R222); and the Decision section
names the home the note chose -- `socom2_build_elf.exe`, a second executable built from the runtime library
`libps2_runtime.a` -- in one sentence (round 2: the first version passed on any mention of any of the four homes
anywhere in the note, and every one of them is discussed in §5.1, so a note that dropped its choice still passed).
The numbers themselves are the note's and are re-run by the commands it cites; this checks that they are there,
not what they are.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NOTE = os.path.join(ROOT, "docs", "research", "74-first-run-decrypt-spike.md")

DECISION = re.compile(r"\*\*(RECOMPILE|PORT|NEITHER)\b[^*]*\*\*")
DATE = re.compile(r"\b2026-\d\d-\d\d\b")
# A route row of the cost table: "| (a) ..." or "| (b) ...", with a lines figure ("N lines" or "N-M lines") in it.
ROUTE_ROW = {route: re.compile(r"(?m)^\|\s*\(" + route + r"\)[^\n]*$") for route in "ab"}
LINES_FIGURE = re.compile(r"\b\d[\d,]*(?:\s*(?:-|to|–)\s*\d[\d,]*)?\s+lines\b")
HLE_WORDS = ("SIF", "cdvd", "kernel")
# The chosen home: one sentence of the Decision carries the name, "second ... executable" and the library.
CHOSEN_HOME = "socom2_build_elf.exe"
HOME_LIBRARY = "libps2_runtime.a"
SECOND = re.compile(r"\bsecond\b")


def read_note():
    with open(NOTE, encoding="utf-8") as fh:
        return fh.read()


def sections(text):
    """[(heading, body)] for every '## ' heading, in order."""
    parts = re.split(r"(?m)^## +", text)
    out = []
    for part in parts[1:]:
        heading, _, body = part.partition("\n")
        out.append((heading.strip(), body))
    return out


def sentences(body):
    """The body's sentences with its lines joined, split after a period that whitespace follows (the period inside
    a file name or a number has none after it)."""
    return re.split(r"(?<=\.)\s+", " ".join(body.split()))


class DecryptSpikeNoteTest(unittest.TestCase):
    def test_the_note_exists_and_is_dated_in_its_first_fifteen_lines(self):
        self.assertTrue(os.path.isfile(NOTE), "docs/research/74-first-run-decrypt-spike.md is not there: R1a's note")
        head = "\n".join(read_note().split("\n")[:15])
        self.assertRegex(head, DATE, "a class S note carries its date in the first fifteen lines")

    def test_the_first_section_is_the_decision_with_its_reason(self):
        secs = sections(read_note())
        self.assertTrue(secs, "the note has no '## ' section")
        heading, body = secs[0]
        self.assertIn("decision", heading.lower(), "the first section is the decision, not the story")
        self.assertRegex(body, DECISION, "the decision is one of RECOMPILE / PORT / NEITHER, in bold")
        self.assertIn("because", body, "the decision carries its reason")

    def test_both_routes_carry_the_lines_that_enter_and_the_hle_each_needs(self):
        text = read_note()
        for route in "ab":
            rows = ROUTE_ROW[route].findall(text)
            self.assertTrue(rows, f"no cost-table row for route ({route})")
            row = " ".join(rows)
            self.assertRegex(row, LINES_FIGURE, f"route ({route})'s row carries no 'N lines' figure")
            for word in HLE_WORDS:
                self.assertIn(word, row, f"route ({route})'s row does not name the {word} answers it needs")

    def test_the_verification_names_the_digests_file_and_the_skip_pattern(self):
        text = read_note()
        self.assertIn("tools_py/disc_to_elf_expected.json", text)
        self.assertRegex(text, r"(?i)skipped", "the disc-bound test says 'skipped' where the disc is not")
        self.assertIn("R222", text)

    def test_the_chosen_home_is_named_in_the_decision(self):
        secs = sections(read_note())
        self.assertTrue(secs, "the note has no '## ' section")
        heading, body = secs[0]
        named = [s for s in sentences(body)
                 if CHOSEN_HOME in s and HOME_LIBRARY in s and SECOND.search(s) and "executable" in s]
        self.assertTrue(named, f"the Decision section ('{heading}') names the chosen home in one sentence: "
                               f"{CHOSEN_HOME}, a second executable built from {HOME_LIBRARY}")


if __name__ == "__main__":
    unittest.main()
