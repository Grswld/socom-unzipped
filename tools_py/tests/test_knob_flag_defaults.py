"""A Flag knob's default in knobs.h is the default its code reads.

ps2x::knobOn(name, dflt) takes its default from its second argument; the table's default column is never read
for a Flag, so the two can drift apart silently. They did: PS2X_GS_DOUBLE_SWIZZLE's row says "1" since b6745191
("defaults to 1 -- attempt 3 froze the intro-movie transition, #114"), and its knobOn call passes nothing, so the
game runs with it off. And PS2X_GS_BATCH_BY_VALUE's adoption flipped the row first and the code not at all (the
macOS performance work, 2026-10-02; caught by a bench replay that still drew 363k batches a second).
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KNOBS_H = os.path.join(ROOT, "third_party", "ps2recomp", "ps2xShared", "include", "ps2x", "knobs.h")
SOURCES = [os.path.join(ROOT, "third_party", "ps2recomp", d) for d in ("ps2xRuntime", "ps2xIOP", "ps2xShared", "ps2xLauncher")]

# Known disagreements awaiting the owner's ruling -- each named, never silently: the test fails on any other.
KNOWN = {
    "PS2X_GS_DOUBLE_SWIZZLE": "row says 1 since b6745191 (#114), code reads 0: which one is meant is the owner's call",
}
TRUE_WORDS = {"1", "true", "on"}


def table_flags():
    with open(KNOBS_H, encoding="utf-8") as f:
        text = f.read()
    return {m.group(1): m.group(2) in TRUE_WORDS
            for m in re.finditer(r'X\("(PS2X_[A-Z0-9_]+)", \w+, Flag, "([^"]*)"', text)}


def code_reads():
    reads = {}
    pattern = re.compile(r'knobOn\("(PS2X_[A-Z0-9_]+)"\s*(?:,\s*(true|false))?\s*\)')
    for base in SOURCES:
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if not d.startswith("build")]
            for name in filenames:
                if not name.endswith((".cpp", ".h")):
                    continue
                with open(os.path.join(dirpath, name), encoding="utf-8", errors="replace") as f:
                    for m in pattern.finditer(f.read()):
                        reads.setdefault(m.group(1), set()).add(m.group(2) == "true")
    return reads


class FlagDefaultsAgree(unittest.TestCase):
    def test_every_flag_read_defaults_as_its_row_says(self):
        table, reads = table_flags(), code_reads()
        wrong = []
        for name, defaults in sorted(reads.items()):
            if name not in table or name in KNOWN:
                continue
            for d in defaults:
                if d != table[name]:
                    wrong.append(f"{name}: knobs.h default {'on' if table[name] else 'off'}, knobOn reads "
                                 f"{'on' if d else 'off'} -- pass the default as knobOn's second argument")
        self.assertEqual(wrong, [])

    def test_the_known_disagreements_still_disagree(self):
        # Once one is resolved, take it off KNOWN so the first test guards it again.
        table, reads = table_flags(), code_reads()
        for name in KNOWN:
            self.assertIn(name, table, name)
            self.assertTrue(any(d != table[name] for d in reads.get(name, {False})), f"{name} agrees now: drop it from KNOWN")


if __name__ == "__main__":
    unittest.main()
