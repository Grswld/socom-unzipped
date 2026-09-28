"""Sprint 16 Task F0: the mission frame-time note (docs/research/73-mission-frame-time.md) says what the plan needs
of it, in the place the plan says.

The note is class S by location and dated in its first fifteen lines. What this pins, from the task's bar
(docs/superpowers/plans/2026-09-27-sprint-16-tasks.md "## Task F0", Steps 1 and 5): the note ranks three costs, each
with a number carrying a unit and a command it came from (a bracketed label whose entry in the commands section is a
back-ticked command line); it names, in one bold sentence, the phase or function that carries the largest share of
the GL thread's second; it says in one sentence whether the EE thread is within 20 % of the wall, and what that does
to F4; it carries the three quiet gates' FRAME lines and their spread against the median; it cites
hostprof_symbolize.py and hostprof_stacks.py runs by command; and it says of F2, F3 and F4 whether each fires. The
numbers themselves are the note's and are re-run by the commands it cites; this checks that they are there, not what
they are -- an empty note, or one with the words and no numbers, fails.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NOTE = os.path.join(ROOT, "docs", "research", "73-mission-frame-time.md")

DATE = re.compile(r"\b2026-\d\d-\d\d\b")
# A ranked row of the top-three table: "| 1 | ... |", "| 2 | ... |", "| 3 | ... |".
RANK_ROW = {rank: re.compile(r"(?m)^\|\s*" + str(rank) + r"\s*\|[^\n]*$") for rank in (1, 2, 3)}
# A number with its unit: "568 ms/s", "17.3 %", "10,584 uploads/s", "1.74 us".
NUMBER_WITH_UNIT = re.compile(r"\b\d[\d,]*(?:\.\d+)?\s*(?:ms/s|ms|%|us|/s|uploads/s|submits/s)")
# A command label "[A]", "[S1]", and its entry in the commands section: "- **[A]** `...`".
LABEL = re.compile(r"\[([A-Z]\d?)\]")
COMMAND_ENTRY = re.compile(r"(?m)^- \*\*\[([A-Z]\d?)\]\*\*\s+`[^`]*(?:python|awk|grep|sed|llvm-objdump)[^`]*`")
BACKTICKED = re.compile(r"`[^`]+`")
GL_LARGEST = re.compile(r"largest share of the GL thread's second")
EE_SENTENCE = re.compile(r"EE thread is (not )?within 20 ?% of the wall")
FRAME_LINE = re.compile(r"FRAME mean=(\d+\.\d+) worst1s=(\d+\.\d+) n=(\d+)")
SPREAD = re.compile(r"(?i)spread[^.\n]*?\b\d+(?:\.\d+)?\s*%")
MEDIAN = re.compile(r"(?i)\bmedian\b[^.\n]*?\b\d+\.\d+")
SYMBOLIZE_RUN = re.compile(r"python tools_py/hostprof_symbolize\.py \S+ --top \d+ --exe dist/socom2\.exe")
STACKS_RUN = re.compile(r"python -m tools_py\.hostprof_stacks \S+ --exe dist/socom2\.exe --top \d+")
TRIGGER = {task: re.compile(r"\*\*" + task + r" (fires|does not fire)\b") for task in ("F2", "F3", "F4")}


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
    return re.split(r"(?<=[.!?])\s+", " ".join(body.split()))


def bold_spans(text):
    """Every **...** span, lines joined."""
    return [" ".join(m.split()) for m in re.findall(r"\*\*(.+?)\*\*", text, re.S)]


class MissionFrameNoteTest(unittest.TestCase):
    def test_the_note_exists_and_is_dated_in_its_first_fifteen_lines(self):
        self.assertTrue(os.path.isfile(NOTE), "docs/research/73-mission-frame-time.md is not there: F0's note")
        head = "\n".join(read_note().split("\n")[:15])
        self.assertRegex(head, DATE, "a class S note carries its date in the first fifteen lines")

    def test_three_costs_are_ranked_each_with_a_number_and_a_command(self):
        text = read_note()
        entries = {m.group(1) for m in COMMAND_ENTRY.finditer(text)}
        self.assertTrue(entries, "no commands section: no '- **[X]** `...`' entry with python/awk/grep/sed in it")
        for rank, pattern in RANK_ROW.items():
            rows = pattern.findall(text)
            self.assertEqual(len(rows), 1, f"expected exactly one ranked row '| {rank} |', found {len(rows)}")
            row = rows[0]
            self.assertRegex(row, NUMBER_WITH_UNIT, f"rank {rank}'s row carries no number with a unit")
            labels = LABEL.findall(row)
            self.assertTrue(labels, f"rank {rank}'s row names no command label [X]")
            for label in labels:
                self.assertIn(label, entries, f"rank {rank} cites [{label}] but the commands section has no "
                                              f"back-ticked command under it")

    def test_the_gl_threads_largest_phase_is_named_in_one_bold_sentence(self):
        named = [s for s in bold_spans(read_note()) if GL_LARGEST.search(s) and BACKTICKED.search(s)
                 and NUMBER_WITH_UNIT.search(s)]
        self.assertEqual(len(named), 1, "one bold sentence names the phase or function that carries the largest "
                                        "share of the GL thread's second, with a back-ticked name and a number")

    def test_the_ee_thread_sentence_is_one_sentence_and_rules_on_f4(self):
        text = read_note()
        hits = [s for s in sentences(text) if EE_SENTENCE.search(s)]
        self.assertTrue(hits, "no sentence says whether the EE thread is within 20 % of the wall")
        ruling = [s for s in hits if "F4" in s and NUMBER_WITH_UNIT.search(s)]
        self.assertEqual(len(ruling), 1, "exactly one EE-thread sentence carries the number and what it does to F4: "
                                         f"{hits}")

    def test_the_three_frame_lines_and_the_spread_against_the_median(self):
        text = read_note()
        means = {m.group(1) for m in FRAME_LINE.finditer(text)}
        self.assertGreaterEqual(len(means), 3, f"fewer than three distinct FRAME mean= lines: {sorted(means)}")
        self.assertRegex(text, SPREAD, "no sentence gives the spread as a percentage")
        self.assertRegex(text, MEDIAN, "no sentence gives the median the spread is taken against")

    def test_the_two_profile_tools_are_cited_by_command(self):
        text = read_note()
        self.assertRegex(text, SYMBOLIZE_RUN, "no hostprof_symbolize.py run cited in its documented form")
        self.assertRegex(text, STACKS_RUN, "no hostprof_stacks run cited in its documented form")

    def test_each_trigger_is_ruled_on(self):
        text = read_note()
        for task, pattern in TRIGGER.items():
            self.assertRegex(text, pattern, f"the note does not say in bold whether {task} fires or does not fire")

    def test_the_reading_is_the_first_section(self):
        secs = sections(read_note())
        self.assertTrue(secs, "the note has no '## ' section")
        heading, body = secs[0]
        self.assertTrue(all(RANK_ROW[r].search(body) for r in (1, 2, 3)),
                        f"the first section ('{heading}') is the reading: the ranked table lives there")


if __name__ == "__main__":
    unittest.main()
