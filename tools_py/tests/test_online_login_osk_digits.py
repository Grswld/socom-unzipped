"""Sprint 16 L1b Step 0 (2026-09-27, launch 1 of logs/parity/s16_l1b_step0): `--name s16pa` came out `s27pa` -- the
form's PLAYER NAME (launch1/03_name.png, launch2/02_persona.png) and the EULA's name line all read it. '1' -> '2' and
'6' -> '7', while 's', 'p' and 'a' were right.

Not a dropped press: the launch ran with PS2X_SOCOM2_INPUT_TRACE=1, and the game's own pad-state lines between the
"Enter Player Name" keyboard opening and the password keyboard opening are exactly the walk the table produced --
RIGHT UP UP RIGHT X / UP UP LEFT X / RIGHT x5 X / DOWN RIGHT x4 X / DOWN LEFT x9 X / RIGHT x11 X, no press missing
and none extra. So the walk reached the key it aimed at in the TABLE's terms and a different key in the game's.

Not the digit row's order either: the row is drawn ` 1 2 3 4 5 6 7 8 9 0 - = [ ] (launch1/03_name_kbd.png), which is
OSK_ROWS[1] as written, and the panel below counts the table's keys row by row. What was wrong is the row's ORIGIN as
the cursor sees it: `osk_moves` moved between rows by index, and the letter block does not start where the digit row
does. On the game's panel CAPS LOCK is wide, 'q' sits under '2' and 'w' under '3' (every letter-row key one key right
of the digit with its index), and UP from 'w' lands on '3' -- the key above it -- not on '2', the key with its index.
From 's' the walk UP UP LEFT went s -> w -> 3 -> 2; the RIGHT x5 that followed went 2 -> 7; and DOWN from '7' lands on
'y' (the key under it), which is where the table already believed the cursor was, so 'p' and 'a' were right again.

The frame in the tree: tools_py/tests/fixtures/lobby/osk_panel_kbd_lad7.png, the game's keyboard panel (the password
keyboard in accent mode, s6_ladder7, cut at (20, 200)). Its key boxes -- measured below along a band through the top
of each key row, above the glyphs -- are the name keyboard's of launch 1 to the pixel (launch1/03_name_kbd.png read
the same way gives the same centres, the same 28.4 px pitch and the same run counts). OSK_ROW_ORIGIN pins what the
panel shows: the symbol row over the digit row key for key (~ over `), the letter block one column right of both.
Between the letter rows the panel's keys are half a key apart, which geometry cannot settle; there the index model
stands, as the letter walks the harness types every launch prove ('socom' read back off the form, 'hello' off the chat
panel in research/66's second round).
"""
import os
import unittest

import numpy as np
from PIL import Image

from tools_py.parity import online_login as O
from tools_py.parity.online_login import OSK_ROWS, OSK_START, osk_moves, osk_pos
from tools_py.tests import test_osk_typing as K

PANEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "lobby", "osk_panel_kbd_lad7.png")
# y bands (panel coordinates) through the top of each key row, above its glyphs: symbols, digits, q, a, z, accent
ROW_BANDS = ((61, 65), (85, 89), (109, 113), (133, 137), (157, 161), (181, 185))
KEY_FILL_MIN = 18.0       # a key's body; the gaps between keys read 0-10
KEY_MIN_WIDTH = 20        # narrower runs are the panel's right edge (4 px), not a key

# The walk the index model produced for "s16pa" and the game received (launch 1's input trace), key by key.
OLD_WALK = [["right", "up", "up", "right"], ["up", "up", "left"], ["right"] * 5, ["down"] + ["right"] * 4,
            ["down"] + ["left"] * 9, ["right"] * 11]


def key_runs(band):
    """[(x0, x1)] of the key bodies along one band of the panel fixture, left to right."""
    y0, y1 = band
    a = np.asarray(Image.open(PANEL).convert("L"), dtype=np.float32)
    lit = a[y0:y1].mean(axis=0) > KEY_FILL_MIN
    runs, x = [], 0
    while x < len(lit):
        if lit[x]:
            s = x
            while x < len(lit) and lit[x]:
                x += 1
            if x - s >= KEY_MIN_WIDTH:
                runs.append((s, x - 1))
        else:
            x += 1
    return runs


def centres(band):
    return [(x0 + x1) / 2 for x0, x1 in key_runs(band)]


def pitch():
    c = centres(ROW_BANDS[1])
    return float(np.median(np.diff(c)))


def measured_offset(upper, lower):
    """How many key pitches row `lower`'s index-1 key sits right of row `upper`'s, off the panel."""
    return round((centres(ROW_BANDS[lower])[1] - centres(ROW_BANDS[upper])[1]) / pitch())


def replay(walks, letter_block_offset):
    """The keys a d-pad walk types on the game's grid as the panel draws it: rows 0-1 share an origin, the letter block
    (rows 2-5) starts `letter_block_offset` columns to their right, the cursor keeps its column on UP/DOWN (clamped to
    the row) and moves one key per LEFT/RIGHT. One CROSS after each walk."""
    origin = (0, 0) + (letter_block_offset,) * 4
    r, i = OSK_START
    typed = []
    for walk in walks:
        for m in walk:
            if m in ("up", "down"):
                col = i + origin[r]
                r += 1 if m == "down" else -1
                i = max(0, min(col - origin[r], len(OSK_ROWS[r]) - 1))
            else:
                i += 1 if m == "right" else -1
                assert 0 <= i < len(OSK_ROWS[r]), (r, i)
        typed.append(OSK_ROWS[r][i])
    return typed


def table_walk(text):
    """osk_moves' walk for each key of `text` and ENTER, from OSK_START."""
    cur, out = OSK_START, []
    for ch in list(text) + ["ENTER"]:
        dst = osk_pos(ch)
        out.append(osk_moves(cur, dst))
        cur = dst
    return out


class ThePanel(unittest.TestCase):
    def test_the_panel_counts_the_tables_keys_row_by_row(self):
        counts = [len(key_runs(b)) for b in ROW_BANDS]
        # the q band also crosses ENTER, which spans the two letter rows (the table keeps it in the a-row)
        self.assertEqual(counts, [14, 15, 13, 13, 12, 11])
        self.assertEqual([len(r) for r in OSK_ROWS], [14, 15, 12, 13, 12, 11])

    def test_q_sits_under_2_and_the_symbols_over_the_digits(self):
        p = pitch()
        self.assertAlmostEqual(p, 28.4, delta=0.6)
        sym, dig, q = (centres(ROW_BANDS[r]) for r in (0, 1, 2))
        for k in range(1, 13):                                  # ! .. +  over  1 .. =
            self.assertLess(abs(sym[k] - dig[k]), 3, k)
        for k in range(1, 12):                                  # q .. \  under  2 .. =
            self.assertLess(abs(q[k] - dig[k + 1]), 3, (OSK_ROWS[2][k], OSK_ROWS[1][k + 1]))
        self.assertEqual(measured_offset(0, 1), 0)
        self.assertEqual(measured_offset(1, 2), 1)

    def test_the_origins_are_the_panels(self):
        self.assertEqual(len(O.OSK_ROW_ORIGIN), len(OSK_ROWS))
        self.assertEqual(O.OSK_ROW_ORIGIN[1] - O.OSK_ROW_ORIGIN[0], measured_offset(0, 1))
        self.assertEqual(O.OSK_ROW_ORIGIN[2] - O.OSK_ROW_ORIGIN[1], measured_offset(1, 2))
        self.assertEqual(len(set(O.OSK_ROW_ORIGIN[2:])), 1)     # the letter rows: the index model the walks proved


class TypingS16pa(unittest.TestCase):
    def test_the_digits_are_where_the_table_says(self):
        self.assertEqual(osk_pos("1"), (1, 1))
        self.assertEqual(osk_pos("6"), (1, 6))
        self.assertEqual(osk_pos("s"), (3, 2))

    def test_the_walk_lands_on_1_and_6(self):
        self.assertEqual(table_walk("s16pa"), [
            ["right", "up", "up", "right"],                     # accent -> TEAM -> z -> a -> s
            ["up", "up", "left", "left"],                       # s -> w -> '3' (above w) -> '2' -> '1'
            ["right"] * 5,                                      # '1' -> '6'
            ["down"] + ["right"] * 5,                           # '6' -> 't' (below 6) -> 'p'
            ["down"] + ["left"] * 9,                            # 'p' -> ';' -> 'a'
            ["right"] * 11,                                     # 'a' -> ENTER
        ])

    def test_the_old_walk_types_what_the_game_showed_and_the_new_one_types_the_name(self):
        off = measured_offset(1, 2)
        self.assertEqual(replay(OLD_WALK, off), list("s27pa") + ["ENTER"])        # launch 1's form: s27pa
        self.assertEqual(replay(table_walk("s16pa"), off), list("s16pa") + ["ENTER"])

    def test_every_digit_from_every_letter_and_back(self):
        off = measured_offset(1, 2)
        letters = [k for row in OSK_ROWS[2:5] for k in row if len(k) == 1]
        digits = [k for k in OSK_ROWS[1] if len(k) == 1]
        for a in letters:
            for d in digits:
                self.assertEqual(replay([osk_moves(OSK_START, osk_pos(a)), osk_moves(osk_pos(a), osk_pos(d))], off),
                                 [a, d], (a, d))
                self.assertEqual(replay([osk_moves(OSK_START, osk_pos(d)), osk_moves(osk_pos(d), osk_pos(a))], off),
                                 [d, a], (d, a))

    def test_the_driver_presses_the_walk_through_the_pad(self):
        sh = K.FakeShell()
        sh.osk_type_pad("s16pa")
        want = []
        for walk in table_walk("s16pa"):
            want += [("pad", m.upper()) for m in walk] + [("pad", "CROSS")]
        self.assertEqual(sh.presses, want)


if __name__ == "__main__":
    unittest.main()
