"""scripts/github_labels.sh: the label set Sprint 11 Goal 7 gives the public repository.

This test PARSES the script's LABELS list; it never runs the script and never calls `gh`. A test that
created labels would need a token, would reach the network, and would be a write to the owner's repository
from a test run -- docs/HANDOFF.md rule 13. What can be checked without any of that is what actually goes
wrong with a label list: a name that drifts from the one the issue templates and the triage routine use, a
duplicate that makes `gh label create --force` overwrite the earlier entry's description, a colour GitHub
will refuse, or an empty description.

The `--force` flag is asserted here too: it is what makes the script idempotent, so the controller can run it
again after a label is added instead of hand-editing thirteen labels in a web page.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "scripts", "github_labels.sh")

# The set Goal 7 names -- two kinds, three states, eight areas -- plus the known-issue stack's additions of
# 2026-09-23 (docs/GIT_STRATEGY.md section 7): four more areas, so every row of docs/KNOWN.md has exactly one
# area to sit under, and the stack's two markers. Adding a label here without adding it to the script (or the
# other way round) fails: the two lists are meant to be read together.
EXPECTED = [
    "bug", "from-launcher", "feature", "needs-repro", "needs-disc-gate",
    "audio", "render", "online", "launcher", "input", "linux", "packaging", "docs",
    "harness", "server", "build", "recomp",
    "known-issue", "carried",
]


def parse_labels(text):
    """The name|colour|description entries of the LABELS=( ... ) array, in order."""
    block = re.search(r"^LABELS=\(\n(.*?)^\)$", text, re.S | re.M)
    assert block is not None, "no LABELS=( ... ) array in the script"
    entries = []
    for line in block.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        assert line.startswith('"') and line.endswith('"'), "a LABELS entry is not one quoted string: %r" % line
        entries.append(line[1:-1].split("|"))
    return entries


class TestGithubLabels(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SCRIPT, encoding="utf-8") as f:
            cls.text = f.read()
        cls.entries = parse_labels(cls.text)

    def test_every_entry_has_a_name_a_colour_and_a_description(self):
        for entry in self.entries:
            self.assertEqual(len(entry), 3, "expected name|colour|description, got %r" % (entry,))
            name, colour, description = entry
            self.assertTrue(name.strip(), "an empty label name in %r" % (entry,))
            self.assertRegex(colour, r"^[0-9a-f]{6}$", "%s: a colour must be six lower-case hex digits" % name)
            self.assertGreaterEqual(len(description.strip()), 20,
                                    "%s: a label with no useful description is a label nobody applies" % name)

    def test_descriptions_fit_githubs_limit(self):
        # GitHub answers HTTP 422 "description is too long (maximum is 100 characters)" -- seen on the first real
        # run of the stack's labels, 2026-09-23, which is why this case exists.
        for name, _colour, description in self.entries:
            self.assertLessEqual(len(description), 100, "%s: GitHub refuses a description over 100 characters" % name)

    def test_the_names_are_the_ones_goal_7_names(self):
        self.assertEqual([e[0] for e in self.entries], EXPECTED)

    def test_no_duplicate_names(self):
        names = [e[0] for e in self.entries]
        duplicates = sorted({n for n in names if names.count(n) > 1})
        self.assertEqual(duplicates, [], "a duplicate would silently overwrite the earlier entry under --force")

    def test_names_are_valid_github_labels(self):
        for name, _colour, _description in self.entries:
            self.assertRegex(name, r"^[a-z0-9][a-z0-9-]*[a-z0-9]$",
                             "%s: keep label names lower-case and hyphenated, as the templates write them" % name)

    def test_it_creates_with_force_so_a_second_run_is_safe(self):
        self.assertIn("--force", self.text, "without --force a re-run fails on the first existing label")
        self.assertNotIn("gh label delete", self.text, "the script must never delete a label: issues carry them")

    def test_the_issue_templates_only_use_labels_the_script_creates(self):
        template_dir = os.path.join(ROOT, ".github", "ISSUE_TEMPLATE")
        names = {e[0] for e in self.entries}
        used = set()
        for entry in os.listdir(template_dir):
            if not entry.endswith((".yml", ".yaml")):
                continue
            with open(os.path.join(template_dir, entry), encoding="utf-8") as f:
                for line in f:
                    match = re.match(r'^labels:\s*\[(.*)\]\s*$', line.strip())
                    if match:
                        used.update(part.strip().strip('"\'') for part in match.group(1).split(",") if part.strip())
        self.assertTrue(used, "no template declares a label; the templates are what applies them by default")
        self.assertEqual(sorted(used - names), [],
                         "an issue template applies a label the script does not create")


if __name__ == "__main__":
    unittest.main()
