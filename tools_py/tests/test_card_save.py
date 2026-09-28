"""The persona-card plan (docs/superpowers/plans/2026-09-28-persona-card-creator.md) Task 1: the Python reference
decoder for the card's SOCOM II save file (tools_py/card_save.py), on the three fixture cards the C++ tests read
(third_party/ps2recomp/ps2xTest/fixtures/cards/: virgin has no persona, one holds s27pa, two holds s16pc then s16pd).
Never a real card. The C++ side (launcher/card_save.h, ps2xTest/src/card_save_tests.cpp) is held to the same bytes.
"""
import os
import unittest

from tools_py import card_save

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CARDS = os.path.join(ROOT, 'third_party', 'ps2recomp', 'ps2xTest', 'fixtures', 'cards')


def fixture(leaf):
    with open(os.path.join(CARDS, leaf), 'rb') as f:
        return f.read()


class ScramblerTest(unittest.TestCase):
    def test_round_trip_all_three_fixtures(self):
        for leaf in ('virgin.bin', 'one.bin', 'two.bin'):
            raw = fixture(leaf)
            self.assertTrue(raw, leaf)
            self.assertEqual(card_save.scramble(card_save.unscramble(raw)), raw, leaf)
            self.assertEqual(card_save.unscramble(card_save.scramble(raw)), raw, leaf)

    def test_short_inputs(self):
        self.assertEqual(card_save.unscramble(b''), b'')
        self.assertEqual(card_save.scramble(card_save.unscramble(b'A')), b'A')


class ZarTest(unittest.TestCase):
    def test_two_has_eighteen_keys_in_pre_order(self):
        head, keys = card_save.parse_zar(card_save.unscramble(fixture('two.bin')))
        self.assertEqual(head['key_count'], 18)
        self.assertEqual(head['appversion'], 14)
        self.assertEqual(head['padding'], 16)
        names = [k[0] for k in keys]
        self.assertEqual(len(names), 18)
        self.assertEqual(names[:4], ['', 'zSaveHeader', 'CSaveModuleList', 'CUIVarManager'])
        self.assertEqual(names[-4:], ['CValveSaveManager', 'PersistentValves.rdr', 'CAcctDB', 'AcctInfo.rdr'])
        self.assertEqual(len(card_save.find_key(keys, 'zSaveHeader')), 268)
        self.assertEqual(len(card_save.find_key(keys, 'PersistentValves.rdr')), 4144)

    def test_the_scrambled_file_is_not_an_archive(self):
        with self.assertRaises(ValueError):
            card_save.parse_zar(fixture('two.bin'))


class PersonasTest(unittest.TestCase):
    def test_two_holds_s16pc_then_s16pd(self):
        rows = card_save.read_card_file(fixture('two.bin'))
        self.assertEqual([(r['name'], r['password'], r['host'], r['port'], r['savePassword']) for r in rows],
                         [('s16pc', 'pwsixc', '3.143.65.100', 10075, 1),
                          ('s16pd', 'pwsixd', '3.143.65.100', 10075, 1)])
        self.assertEqual(rows[0]['profileChecksum'], [0] * 16)
        self.assertEqual(rows[0]['town'], '')

    def test_one_holds_s27pa(self):
        rows = card_save.read_card_file(fixture('one.bin'))
        self.assertEqual([(r['name'], r['password']) for r in rows], [('s27pa', 's27pa2')])

    def test_virgin_holds_none(self):
        self.assertEqual(card_save.read_card_file(fixture('virgin.bin')), [])


def acct_of(leaf):
    _head, keys = card_save.parse_zar(card_save.unscramble(fixture(leaf)))
    return card_save.find_key(keys, 'AcctInfo.rdr')


def s17pc():
    return dict(host='3.143.65.100', name='s17pc', town='', gender=0, port=10075, password='hunter2', savePassword=1,
                profileChecksum=[0] * 16, profileInfo=[])


class EncoderTest(unittest.TestCase):
    """The encoder the C++ writer (launcher/card_save.h) is held to: created.bin is this encoder's card for s17pc
    from virgin.bin, and ps2xTest's CardSave case asserts writeCardFile({}, {s17pc}) is the same bytes."""

    def test_one_record_is_the_games_own_bytes(self):
        acct = acct_of('one.bin')
        self.assertEqual(card_save.write_personas(card_save.read_personas(acct)), acct)

    def test_no_record_is_the_virgin_blob(self):
        self.assertEqual(card_save.write_personas([]), acct_of('virgin.bin'))
        self.assertEqual(len(acct_of('virgin.bin')), 24)

    def test_two_records_re_read_equal(self):
        rows = card_save.read_personas(acct_of('two.bin'))
        self.assertEqual(card_save.read_personas(card_save.write_personas(rows)), rows)

    def test_build_zar_re_parses_to_the_same_tree(self):
        for leaf in ('virgin.bin', 'one.bin', 'two.bin'):
            _head, keys = card_save.parse_zar(card_save.unscramble(fixture(leaf)))
            tree = card_save.key_tree(keys)
            _h2, again = card_save.parse_zar(card_save.build_zar(tree))
            self.assertEqual(card_save.key_tree(again), tree, leaf)

    def test_created_card_is_the_fixture(self):
        made = card_save.write_card_file(fixture('virgin.bin'), [s17pc()])
        self.assertEqual(made, fixture('created.bin'))
        self.assertEqual(card_save.read_card_file(made), [s17pc()])

    def test_rewrite_keeps_every_other_key(self):
        q = dict(s17pc(), name='s17pq', password='pwq')
        made = card_save.write_card_file(fixture('one.bin'), [q, s17pc()])
        self.assertEqual([r['name'] for r in card_save.read_card_file(made)], ['s17pq', 's17pc'])
        _h1, before = card_save.parse_zar(card_save.unscramble(fixture('one.bin')))
        _h2, after = card_save.parse_zar(card_save.unscramble(made))
        self.assertEqual([(k[0], k[2]) for k in before], [(k[0], k[2]) for k in after])
        for b, a in zip(before, after):
            if b[0] != 'AcctInfo.rdr':
                self.assertEqual(a[1], b[1], b[0])

    def test_dump_prints_the_records(self):
        import io
        import tempfile
        from contextlib import redirect_stdout
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'card')
            with open(path, 'wb') as f:
                f.write(fixture('created.bin'))
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(card_save.main(['card_save', '--dump', path]), 0)
        import json
        self.assertEqual(json.loads(out.getvalue()), [s17pc()])


if __name__ == '__main__':
    unittest.main()
