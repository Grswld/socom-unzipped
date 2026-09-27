"""Sprint 15 Task R1: the audio confidence register (docs/research/68-confidence-register.md) keeps its shape.

The register is a class S research note; what this pins is the part later tasks read and update: the audio table
has exactly the five rows of the sprint's spec section 1.1 (the host mixer, snd989, lgaud, the IOP host's audio
path, the SPU2 model); each row's confidence is one word of KNOWN's vocabulary (Proven, Believed, Untested,
Hazard) and cites its artefact -- a KNOWN row or a test file; each row's number cell carries the backticked command
that produced it; a header line sends every non-audio row to docs/LATER.md; the date sits in the first fifteen
lines and a "state at last commit" block at the top carries the dip count the sprint's no-regression bar uses.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NOTE = os.path.join(ROOT, "docs", "research", "68-confidence-register.md")

CONFIDENCE = ("Proven", "Believed", "Untested", "Hazard")
# The five rows, each matched by a phrase its subsystem cell must carry (case-insensitive).
ROWS = {
    "the host mixer": r"host mixer",
    "snd989": r"snd989",
    "lgaud": r"lgaud",
    "the IOP host's audio path": r"IOP host",
    "the SPU2 model": r"SPU2",
}
# A KNOWN row is cited as KNOWN with a section or a line (KNOWN §2, KNOWN:141, KNOWN L141, KNOWN line 141).
KNOWN_CITE = re.compile(r"KNOWN(\.md)?\s*(§\s*\d|:\s*\d|L\d|line\s*\d|lines\s*\d)")
TEST_CITE = re.compile(r"[\w/]*(_tests\.cpp|test_\w+\.py)")
# A command in backticks: a program name, then arguments.
COMMAND = re.compile(r"`(python|git|grep|ls|wc|gh|sed|awk|find|cat|scripts/[\w./-]+|\./[\w./-]+)\b[^`]*\s[^`]*`")


def read_note():
    with open(NOTE, encoding="utf-8") as f:
        return f.read()


def cells(line):
    """A table row's cells; a pipe escaped as backslash-pipe (inside a command) does not split."""
    return [c.strip() for c in re.split(r"(?<!\\)\|",line.strip().strip("|"))]


def row_name(row):
    """The subsystem a row registers: the bold lead of its first cell."""
    m = re.match(r"\*\*(.+?)\*\*", row[0])
    return m.group(1) if m else row[0]


def audio_table(text):
    """The first markdown table whose header names both a confidence and a number column: (header, rows)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        head = [c.lower() for c in cells(line)]
        if any("confidence" in c for c in head) and any("number" in c for c in head):
            rows = []
            for row in lines[i + 2:]:
                if not row.startswith("|"):
                    break
                rows.append(cells(row))
            return head, rows
    return None, []


class AudioRegisterTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.isfile(NOTE), "the register is missing: %s" % NOTE)
        self.text = read_note()
        self.head, self.rows = audio_table(self.text)
        self.assertIsNotNone(self.head, "no table with a Confidence and a Number column in the register")
        self.conf_col = next(i for i, c in enumerate(self.head) if "confidence" in c)
        self.num_col = next(i for i, c in enumerate(self.head) if "number" in c)

    def test_the_five_audio_rows_and_no_others(self):
        self.assertEqual(len(self.rows), len(ROWS), "the audio table has %d rows, not five" % len(self.rows))
        for name, pattern in ROWS.items():
            hits = [r for r in self.rows if re.search(pattern, row_name(r), re.I)]
            self.assertEqual(len(hits), 1, "row %r: %d rows name it in the first column" % (name, len(hits)))

    def test_each_confidence_is_a_known_word_and_cites_its_artefact(self):
        for row in self.rows:
            cell = row[self.conf_col]
            word = re.match(r"\**(\w+)", cell)
            self.assertTrue(word and word.group(1) in CONFIDENCE,
                            "%s: confidence %r is not one of %s" % (row[0][:40], cell[:40], CONFIDENCE))
            self.assertTrue(KNOWN_CITE.search(cell) or TEST_CITE.search(cell),
                            "%s: the confidence cites neither a KNOWN row nor a test file" % row[0][:40])

    def test_each_number_cell_carries_its_command(self):
        for row in self.rows:
            cell = row[self.num_col]
            self.assertRegex(cell, r"\d", "%s: the number cell has no number" % row[0][:40])
            self.assertRegex(cell, COMMAND, "%s: the number cell names no backticked command" % row[0][:40])

    def test_a_header_line_sends_the_non_audio_rows_to_later(self):
        top = self.text.split("\n## ", 1)[0]
        self.assertRegex(top, r"non-audio[^\n]*`docs/LATER\.md`|`docs/LATER\.md`[^\n]*non-audio",
                         "no line above the first section names docs/LATER.md for the non-audio rows")

    def test_the_date_and_the_state_block_at_the_top(self):
        first15 = "\n".join(self.text.splitlines()[:15])
        self.assertRegex(first15, r"20\d\d-\d\d-\d\d", "no date in the first fifteen lines")
        top = self.text.split("\n## ", 1)[0]
        self.assertRegex(top, r"(?i)state at last commit", "no 'state at last commit' block at the top")
        self.assertRegex(top, r"\d+ DEVICE dips", "the state block does not carry the DEVICE dip count")
        self.assertIn("`python -m tools_py.parity.audio_dips ", top, "the state block's dip count names no command")


# Sprint 15 Task X1: the audio survey's shortlist (docs/research/69-audio-survey.md).
SURVEY = os.path.join(ROOT, "docs", "research", "69-audio-survey.md")
PATHS = ("TAKE", "REIMPLEMENT", "BORROW THE IDEA", "LEAVE")
# A licence file named as a file: LICENSE, LICENCE, COPYING, with or without an extension or a suffix.
LICENCE_FILE = re.compile(r"\b(LICEN[CS]E|COPYING)[\w.-]*")


def shortlist_table(text):
    """The first markdown table whose header names a register-row column and a path column: (header, rows)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        head = [c.lower() for c in cells(line)]
        if any("register row" in c for c in head) and any(c == "path" or c.startswith("path") for c in head):
            rows = []
            for row in lines[i + 2:]:
                if not row.startswith("|"):
                    break
                rows.append(cells(row))
            return head, rows
    return None, []


class AudioSurveyShortlistTest(unittest.TestCase):
    def test_every_shortlist_entry_names_a_register_row_a_path_a_licence_file_and_a_validation(self):
        self.assertTrue(os.path.isfile(SURVEY), "the survey is missing: %s" % SURVEY)
        with open(SURVEY, encoding="utf-8") as f:
            text = f.read()
        head, rows = shortlist_table(text)
        self.assertIsNotNone(head, "no shortlist table (a 'Register row' and a 'Path' column) in the survey")
        self.assertTrue(1 <= len(rows) <= 3, "the shortlist has %d entries; one to three" % len(rows))
        col = lambda word: next(i for i, c in enumerate(head) if word in c)
        reg_col, path_col = col("register row"), col("path")
        src_col, val_col = col("source"), col("validation")
        _, register_rows = audio_table(read_note())
        register = [row_name(r) for r in register_rows]
        self.assertEqual(len(register), len(ROWS), "the register (research/68) does not carry its five rows")
        for row in rows:
            label = row[0][:40]
            named = [n for n in register if n.lower() in row[reg_col].lower()]
            self.assertEqual(len(named), 1, "%s: the register-row cell names %d rows of research/68, not one: %r"
                             % (label, len(named), row[reg_col][:60]))
            path = re.sub(r"[*_`]", "", row[path_col]).strip()
            self.assertTrue(any(path.startswith(p) for p in PATHS),
                            "%s: path %r is not one of %s" % (label, path[:30], PATHS))
            self.assertRegex(row[src_col], LICENCE_FILE, "%s: the source names no licence file" % label)
            self.assertRegex(row[val_col], r"\d", "%s: the validation carries no number" % label)
            self.assertRegex(row[val_col], COMMAND, "%s: the validation's number names no backticked command" % label)


# Sprint 15 Task T1: the LLE-oracle spike (docs/research/70-lle-oracle-spike.md). The spike's question, written
# before the reading: the note says ADOPT AS ORACLE or NOT ADOPTED on a recommendation line, and gives N -- the
# mission replay's disagreements on the oracle -- as "N = <number>" on a line that names its backticked command.
SPIKE = os.path.join(ROOT, "docs", "research", "70-lle-oracle-spike.md")
RECOMMENDATION = re.compile(r"(?im)^\W*recommendation\b[^\n]*\b(ADOPT AS ORACLE|NOT ADOPTED)\b")
N_LINE = re.compile(r"(?m)^[^\n]*\bN = \d[\d,]*[^\n]*$")
N_UNMEASURED = re.compile(r"(?m)^[^\n]*\bN = not measured\b[^\n]*$")


class LleOracleSpikeTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.isfile(SPIKE), "the spike note is missing: %s" % SPIKE)
        with open(SPIKE, encoding="utf-8") as f:
            self.text = f.read()

    def test_the_note_carries_a_recommendation_line(self):
        self.assertRegex(self.text, RECOMMENDATION,
                         "no line starting 'Recommendation' that says ADOPT AS ORACLE or NOT ADOPTED")

    def test_the_note_gives_n_with_its_command(self):
        # A spike stopped by its stop rule before the replay ran writes "N = not measured" -- only with NOT ADOPTED,
        # and still naming the command that would measure it (amended after the reading: T1's build stopped it).
        lines = N_LINE.findall(self.text)
        stopped = N_UNMEASURED.findall(self.text)
        verdict = RECOMMENDATION.search(self.text)
        if not lines and stopped:
            self.assertTrue(verdict and verdict.group(1) == "NOT ADOPTED",
                            "'N = not measured' is allowed only under a NOT ADOPTED recommendation")
            lines = stopped
        self.assertTrue(lines, "no 'N = <number>' line in the spike note")
        self.assertTrue(any(COMMAND.search(l) for l in lines), "no 'N = <number>' line names a backticked command")


if __name__ == "__main__":
    unittest.main()
