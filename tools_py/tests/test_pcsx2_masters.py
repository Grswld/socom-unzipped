"""The tracked PCSX2 patch masters are safe on both layouts the instances boot (issue #112, closing bar 1).

`scripts/parity/pcsx2/0F6FC6CF.pnach` (instance A) and `0F6FC6CF.clientB.pnach` (instance B) are copied by hand into
`tools/pcsx2*/patches/`. Both cards hold PSRewired's r0004 package, so a boot of the r0001 disc runs r0004 after the
loading screen. An unconditional `jr ra; nop` at `0x2CC670` (the r0001 `dnasCheck` entry) lands in r0004's
`FUN_002CC5F0` epilogue and the game reboot-loops every ~45 s. The masters therefore write each word only behind a
pnach `E` guard (`E0nnvvvv taaaaaaa`: if the halfword at `aaaaaaa` equals `vvvv`, run the next `nn` lines, else skip
them) on the word they replace.

The layouts below are the words at the patched addresses, read from our extracted images (2026-09-29):
`game/disc/socom2_game.elf` (r0001) and `game/overlays_r0004/socom2_game_r0004.elf` (r0004). No disc is read here, so
this module stays in the fast subset. The guard word `27BDFFC0` (`addiu sp,sp,-0x40`) at `0x2CF330` is the one
Harry62's PSRewired cheat tests (`tools/pcsx2/cheats/0F6FC6CF.pnach` lines 4-11; `docs/research/02`); the masters
test the same word at `0x2CC670` for r0001, where the r0001 image holds it.
"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MASTERS = os.path.join(ROOT, "scripts", "parity", "pcsx2")
MASTER_A = os.path.join(MASTERS, "0F6FC6CF.pnach")
MASTER_B = os.path.join(MASTERS, "0F6FC6CF.clientB.pnach")

JR_RA, NOP = 0x03E00008, 0x00000000
DNAS_R0001, DNAS_R0004 = 0x2CC670, 0x2CF330
PORT_SITE, PORT_3658, PORT_3660 = 0x620678, 0x24040E4A, 0x24040E4C   # li a0,0xE4A -> li a0,0xE4C (FUN_00620648)
PORT_SITE_R0004 = 0x627F68   # the same li a0,0xE4A in r0004's relocated copy of the function (0x627F38)

# The word at each address the masters touch, per layout (the two images named in the docstring).
R0001 = {0x2CC670: 0x27BDFFC0, 0x2CC674: 0xFFBF0030, 0x2CF330: 0x0000282D, 0x2CF334: 0xAFA2003C,
         0x620678: PORT_3658, 0x627F68: 0x27BDFEE0}
R0004 = {0x2CC670: 0x7BB10010, 0x2CC674: 0x7BB00000, 0x2CF330: 0x27BDFFC0, 0x2CF334: 0xFFBF0030,
         0x620678: 0x9223F8E8, 0x627F68: PORT_3658}

PATCH = re.compile(r"^patch=(\d+),EE,([0-9A-Fa-f]{8}),extended,([0-9A-Fa-f]{8})$")


def parse(path):
    """Every `patch=` line of a pnach as (place, code, value); comments and header keys are skipped."""
    out = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("//", 1)[0].strip()
            if not line.startswith("patch="):
                continue
            m = PATCH.match(line)
            if not m:
                raise AssertionError("%s: a patch line the test cannot read: %r" % (path, raw))
            out.append((int(m.group(1)), int(m.group(2), 16), int(m.group(3), 16)))
    return out


def guarded(lines):
    """The indices of lines inside some E guard's range."""
    inside = set()
    for i, (_, code, _) in enumerate(lines):
        if code >> 28 == 0xE:
            inside.update(range(i + 1, i + 1 + ((code >> 16) & 0xFF)))
    return inside


def guard_span_problems(lines, name):
    """What is wrong with each E guard's span: it runs off the end, its first write is not the word it guards, a write
    spills past its two-word block, or it holds a guard on another word. A guard's nn counts lines, so one too many
    silently swallows the next line; when that line is the next block's guard, no write spills, but the next block
    now runs only when this guard holds (review of #112). A nested guard is only ever on its outer guard's word."""
    problems = []
    for i, (_, code, value) in enumerate(lines):
        if code >> 28 != 0xE:
            continue
        span = lines[i + 1:i + 1 + ((code >> 16) & 0xFF)]
        if len(span) != (code >> 16) & 0xFF:
            problems.append("%s line %d runs off the end" % (name, i + 1))
            continue
        guarded_word = (value & 0x0FFFFFFF) & ~3
        writes = [c & 0x0FFFFFFF for _, c, _ in span if c >> 28 == 0x2]
        if not (writes and writes[0] == guarded_word):
            problems.append("%s line %d guards 0x%X but writes %r"
                            % (name, i + 1, guarded_word, [hex(w) for w in writes]))
        if not all(guarded_word <= w < guarded_word + 8 for w in writes):
            problems.append("%s line %d spills past its block" % (name, i + 1))
        nested = [(v & 0x0FFFFFFF) & ~3 for _, c, v in span if c >> 28 == 0xE]
        foreign = [w for w in nested if w != guarded_word]
        if foreign:
            problems.append("%s line %d guards 0x%X but covers a guard on %r"
                            % (name, i + 1, guarded_word, [hex(w) for w in foreign]))
    return problems


def apply_once(lines, mem):
    """One pass of PCSX2's extended handler over `mem` (word-addressed); returns the addresses written."""
    written, skip = [], 0
    for _, code, value in lines:
        if skip:
            skip -= 1
            continue
        kind = code >> 28
        if kind == 0x2:
            addr = code & 0x0FFFFFFF
            if addr not in mem:
                raise AssertionError("a write at 0x%X, which the layouts do not model" % addr)
            mem[addr] = value
            written.append(addr)
        elif kind == 0xE and (code >> 24) & 0xF == 0:
            addr, test = value & 0x0FFFFFFF, value >> 28
            word = mem.get(addr & ~3)
            if word is None:
                raise AssertionError("a guard on 0x%X, which the layouts do not model" % addr)
            half = (word >> (16 if addr & 2 else 0)) & 0xFFFF
            if test == 0:
                hold = half == code & 0xFFFF
            elif test == 1:
                hold = half != code & 0xFFFF
            else:
                raise AssertionError("guard test %d is not modelled" % test)
            if not hold:
                skip = (code >> 16) & 0xFF
        else:
            raise AssertionError("code 0x%08X is not modelled" % code)
    return written


def run(path, layout, passes=3):
    """`patch=1` lines re-apply every vsync: run a few passes and return the memory and every address written."""
    mem, written = dict(layout), []
    for _ in range(passes):
        written += apply_once(parse(path), mem)
    return mem, written


class MastersRefuseTheUnconditionalBypass(unittest.TestCase):
    def test_no_master_writes_the_r0001_entry_unguarded(self):
        for path in (MASTER_A, MASTER_B):
            lines = parse(path)
            inside = guarded(lines)
            for i, (_, code, _) in enumerate(lines):
                if code >> 28 == 0x2 and (code & 0x0FFFFFFF) in (DNAS_R0001, DNAS_R0001 + 4):
                    self.assertIn(i, inside, "%s line %d writes 0x%X unconditionally (#112)"
                                  % (os.path.basename(path), i + 1, code & 0x0FFFFFFF))

    def test_on_r0004_nothing_lands_in_the_epilogue(self):
        for path in (MASTER_A, MASTER_B):
            mem, written = run(path, R0004)
            self.assertNotIn(DNAS_R0001, written, os.path.basename(path))
            self.assertNotIn(DNAS_R0001 + 4, written, os.path.basename(path))
            self.assertEqual((mem[0x2CC670], mem[0x2CC674]), (R0004[0x2CC670], R0004[0x2CC674]))

    def test_on_r0004_the_bypass_lands_on_the_relocated_entry(self):
        for path in (MASTER_A, MASTER_B):
            mem, _ = run(path, R0004)
            self.assertEqual((mem[DNAS_R0004], mem[DNAS_R0004 + 4]), (JR_RA, NOP), os.path.basename(path))

    def test_on_r0001_the_bypass_still_lands(self):
        for path in (MASTER_A, MASTER_B):
            mem, _ = run(path, R0001)
            self.assertEqual((mem[DNAS_R0001], mem[DNAS_R0001 + 4]), (JR_RA, NOP), os.path.basename(path))
            self.assertEqual((mem[DNAS_R0004], mem[DNAS_R0004 + 4]), (R0001[0x2CF330], R0001[0x2CF334]))

    def test_every_guard_covers_exactly_its_block(self):
        for path in (MASTER_A, MASTER_B):
            self.assertEqual(guard_span_problems(parse(path), os.path.basename(path)), [])

    def test_a_count_one_too_large_is_caught_even_before_the_next_guard(self):
        # Review of #112: E003 -> E004 on the r0001 outer guard swallows r0004's outer guard, so on r0004 its write
        # sits behind the low half only. Every guard count in both masters, bumped by one, must be refused.
        for path in (MASTER_A, MASTER_B):
            lines = parse(path)
            for i, (place, code, value) in enumerate(lines):
                if code >> 28 != 0xE:
                    continue
                bumped = list(lines)
                bumped[i] = (place, code + 0x10000, value)
                self.assertNotEqual(guard_span_problems(bumped, os.path.basename(path)), [],
                                    "%s line %d with its count bumped" % (os.path.basename(path), i + 1))

    def test_each_word_is_written_once_not_every_vsync(self):
        for path in (MASTER_A, MASTER_B):
            for layout in (R0001, R0004):
                _, written = run(path, layout)
                self.assertEqual(len(written), len(set(written)), os.path.basename(path))


class ClientBKeepsItsPortShift(unittest.TestCase):
    def test_b_moves_its_base_port_to_3660_on_r0001(self):
        mem, _ = run(MASTER_B, R0001)
        self.assertEqual(mem[PORT_SITE], PORT_3660)

    def test_b_moves_its_base_port_to_3660_on_r0004(self):
        # Both cards boot r0004, where the port li sits at 0x627F68: without this write A and B share 3658.
        mem, _ = run(MASTER_B, R0004)
        self.assertEqual(mem[PORT_SITE_R0004], PORT_3660)

    def test_b_shifts_the_port_on_each_image_and_touches_nothing_else(self):
        dnas = {DNAS_R0001, DNAS_R0001 + 4, DNAS_R0004, DNAS_R0004 + 4}
        for layout, site, other in ((R0001, PORT_SITE, PORT_SITE_R0004), (R0004, PORT_SITE_R0004, PORT_SITE)):
            mem, written = run(MASTER_B, layout)
            self.assertEqual([w for w in written if w not in dnas], [site])
            self.assertEqual(mem[other], layout[other])

    def test_b_carries_the_port_word(self):
        for site in (PORT_SITE, PORT_SITE_R0004):
            values = [v for _, code, v in parse(MASTER_B) if code == 0x20000000 | site]
            self.assertEqual(values, [PORT_3660], hex(site))

    def test_b_does_not_overwrite_r0004_code_at_the_port_site(self):
        mem, written = run(MASTER_B, R0004)
        self.assertNotIn(PORT_SITE, written)
        self.assertEqual(mem[PORT_SITE], R0004[PORT_SITE])

    def test_b_does_not_overwrite_r0001_code_at_the_r0004_port_site(self):
        mem, written = run(MASTER_B, R0001)
        self.assertNotIn(PORT_SITE_R0004, written)
        self.assertEqual(mem[PORT_SITE_R0004], R0001[PORT_SITE_R0004])

    def test_a_leaves_the_port_alone(self):
        for layout in (R0001, R0004):
            _, written = run(MASTER_A, layout)
            self.assertNotIn(PORT_SITE, written)
            self.assertNotIn(PORT_SITE_R0004, written)


if __name__ == "__main__":
    unittest.main()
