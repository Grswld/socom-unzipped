"""Sprint 13 O2 (#26) -- the chat step and its round, over synthetic lines in the exe's own formats (the OSK wrap's
open line and the chat receive wrap's count line in game_overrides_socom2.cpp, the sampler's [peek] cells in
runtime/socom2_peek.h), and scripts/parity/control_round_chat.sh textually (a run launches two games)."""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from tools_py.parity import control_round_readout as R
from tools_py.parity import guest_addresses as ga
from tools_py.parity import online_login as O
from tools_py.parity import online_login_ours as L
from tools_py.parity import online_match_ours as M

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.join(ROOT, "scripts", "parity", "control_round_chat.sh")

CHAT_OPEN = ('[socom2] on-screen keyboard open: purpose="_361_EnterChatMessage_MSG" skb="PlayerChatSkb" MaxChars=0 '
             'MaxBytes=0 -> not prefilled')
NAME_OPEN = ('[socom2] on-screen keyboard open: purpose="_305_EnterGameName_MSG" skb="MPPLAYERNAME" MaxChars=15 '
             'MaxBytes=63 -> not prefilled')


def seen_line(n, fixed=0, skipped=0):
    return "[socom2] chat receive bound: seen=%d fixed=%d skipped=%d" % (n, fixed, skipped)


PTR = ga.address("talk_table_ptr", "r0001")


def peek_row(ptr_value, table=None, extra=" @416054: 00000000(0)"):
    """A [peek] row as the runtime prints it: env.sh's items first, then the pointer's cell and its target's."""
    row = "[peek]" + extra + " @%x: %08x(0)" % (PTR, ptr_value)
    if ptr_value == 0:
        return row + " @*0x%x: unresolved (null pointer at 0x%x)" % (PTR, PTR)
    return row + " @%x:" % ptr_value + "".join(" %08x(0)" % w for w in table)


def table_words(byte_0a, byte_0b):
    """12 words whose bytes +0x1c / +0x1d (word 7, bytes 0 and 1, little-endian) are the two talk slots."""
    words = [0x10101010] * 12
    words[7] = 0x10100000 | (byte_0b << 8) | byte_0a
    return words


class ChatLogParsers(unittest.TestCase):
    def test_osk_opens_lists_purpose_and_keyboard_in_order(self):
        text = "x\n" + NAME_OPEN + "\ny\n" + CHAT_OPEN + "\n"
        self.assertEqual(L.osk_opens(text), [("_305_EnterGameName_MSG", "MPPLAYERNAME"),
                                             (L.CHAT_PURPOSE, "PlayerChatSkb")])
        self.assertEqual(L.osk_opens(""), [])
        self.assertEqual(L.osk_opens(None), [])

    def test_chat_seen_lines_carry_the_logs_own_byte_offsets(self):
        head = b"[socom2] chat receive bound (name 32, message 64)\n"
        body = (seen_line(1) + "\n").encode()
        got = L.chat_seen_lines(head + body, base=1000)
        self.assertEqual(got, [(1000 + len(head), 1, 0, 0)])
        self.assertEqual(L.chat_seen_lines(seen_line(9, 2, 1)), [(0, 9, 2, 1)])
        self.assertEqual(L.chat_seen_lines(b"[socom2] chat list bound: seen=1 fixed=0 skipped=0\n"), [],
                         "the list wrap's line is not the receive bound")

    def test_log_marks(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "run.log")
            self.assertEqual(L.log_size(p), 0)
            self.assertEqual(L.read_log_bytes(p, 0), b"")
            with open(p, "wb") as f:
                f.write(b"abc\n" + CHAT_OPEN.encode())
            self.assertEqual(L.log_size(p), 4 + len(CHAT_OPEN))
            self.assertEqual(L.read_log_from(p, 4), CHAT_OPEN)
            self.assertEqual(L.log_size(None), 0)

    def test_the_chat_step_opens_with_r1(self):
        self.assertEqual(L.CHAT_OPEN_BUTTON, "r1")
        from tools_py.parity import keys
        self.assertIn("R1", keys.MAPS["ours"])


# The chat keyboard as round 1 measured it (research/66 section 3): the login grid plus one row below it, the cursor
# opening on that row's first key, clamped on a vertical move and wrapping on a horizontal one (round 1's walk went
# right off EXIT onto SHIFT). A vertical move keeps the cursor's column as the login grid's does (OSK_ROW_ORIGIN, Sprint
# 16 L1b Step 0: the letter block starts one key right of the digit row); the extra row shares the letter block's
# origin (SPACE, UP, TEAM: index 1 to index 1, as CHAT_OSK_ENTRY shows).
CHAT_GRID = [list(r) for r in O.OSK_ROWS] + [["ACCENT", "SPACE", "MESSAGE", "IGNORE", "LEGEND"]]
CHAT_ORIGIN = tuple(O.OSK_ROW_ORIGIN) + (O.OSK_ROW_ORIGIN[-1],)
CHAT_OPENS_ON = (6, 0)


def simulate(presses):
    """[(key pressed with CROSS)] of a sequence of 'up'/'down'/'left'/'right'/'cross' on the chat keyboard."""
    r, i = CHAT_OPENS_ON
    typed = []
    for p in presses:
        if p in ("up", "down"):
            col = i + CHAT_ORIGIN[r]
            r += -1 if p == "up" else 1
            i = max(0, min(col - CHAT_ORIGIN[r], len(CHAT_GRID[r]) - 1))
        elif p in ("left", "right"):
            i = (i + (1 if p == "right" else -1)) % len(CHAT_GRID[r])
        else:
            typed.append(CHAT_GRID[r][i])
    return typed


def walk(text, cur, entry=()):
    out = list(entry)
    for ch in list(text) + ["ENTER"]:
        dst = L.osk_pos(ch)
        out += L.osk_moves(cur, dst) + ["cross"]
        cur = dst
    return out


class ChatKeyboardWalk(unittest.TestCase):
    def test_the_simulator_reproduces_round_1(self):
        """The login's walk from OSK_START on the chat keyboard: 'nd..l' and SHIFT for ENTER, as round 1's captures
        (A_chat_key0..4, A_chat_02_entered) show it."""
        self.assertEqual(simulate(walk("hello", L.OSK_START)), ["n", "d", ".", ".", "l", "SHIFT"])

    def test_the_entry_moves_put_the_walk_on_the_right_keys(self):
        self.assertEqual(O.OSK_ROWS[L.CHAT_OSK_ENTRY_KEY[0]][L.CHAT_OSK_ENTRY_KEY[1]], "TEAM")
        self.assertEqual(CHAT_GRID[5][1], "TEAM")
        for text in ("hello", "test", "socom", "o2"):
            got = simulate(walk(text, L.CHAT_OSK_ENTRY_KEY, L.CHAT_OSK_ENTRY))
            self.assertEqual(got, list(text) + ["ENTER"], text)

    def test_the_keys_band(self):
        flat = [[20] * 640 for _ in range(448)]
        self.assertFalse(L.chat_keyboard_up_of(flat))
        keys = [[(200 if (x // 20) % 2 else 20) for x in range(640)] for _ in range(448)]
        self.assertTrue(L.chat_keyboard_up_of(keys))


class FakeShell:
    def __init__(self):
        self.lines, self.shots = [], []

    def log(self, m):
        self.lines.append(m)

    def shot(self, label, max_age=None):
        self.shots.append(label)


class FakeClient:
    def __init__(self, tag, run_log):
        self.tag, self.run_log, self.sh = tag, run_log, FakeShell()


class ChatExchange(unittest.TestCase):
    def run_exchange(self, receiver_before, receiver_after, opened=True):
        with tempfile.TemporaryDirectory() as d:
            a_log, b_log = os.path.join(d, "A.log"), os.path.join(d, "B.log")
            with open(a_log, "wb") as f:
                f.write(b"boot\n")
            with open(b_log, "wb") as f:
                f.write(receiver_before)
            A, B = FakeClient("A", a_log), FakeClient("B", b_log)

            def fake_chat_line(sh, text, run_log=None):
                with open(b_log, "ab") as f:
                    f.write(receiver_after)
                return {"text": text, "opened": opened, "by": "log" if opened else None, "skb": "PlayerChatSkb",
                        "closed": True, "exited": False, "mark": 5, "room": "game_lobby"}

            real, L.chat_line = L.chat_line, fake_chat_line
            try:
                t = [0.0]
                rec = M.chat_exchange(A, B, "hello", wait_s=3.0, clock=lambda: t[0],
                                      sleep=lambda s: t.__setitem__(0, t[0] + s))
            finally:
                L.chat_line = real
            return rec, A

    def test_a_seen_line_past_the_mark_is_the_receive(self):
        before = b"[socom2] chat receive bound (name 32, message 64)\n"
        rec, A = self.run_exchange(before, (seen_line(1) + "\n").encode())
        self.assertEqual(rec["receiver_mark"], len(before))
        self.assertEqual(rec["receiver_seen"], (len(before), 1, 0, 0))
        self.assertEqual(rec["receiver_pre"], [])
        self.assertIn("CHAT A->B opened=True by=log closed=True exited=False receiver_seen=seen=1", A.sh.lines[-1])

    def test_a_seen_line_before_the_mark_is_reported_and_not_taken(self):
        before = (seen_line(1) + "\n").encode()
        rec, A = self.run_exchange(before, b"")
        self.assertIsNone(rec["receiver_seen"])
        self.assertEqual(rec["receiver_pre"], [(0, 1, 0, 0)])
        self.assertIn("already printed seen=1 before the mark", A.sh.lines[-1])

    def test_an_unopened_keyboard_does_not_wait(self):
        rec, A = self.run_exchange(b"", (seen_line(1) + "\n").encode(), opened=False)
        self.assertIsNone(rec["receiver_seen"], "nothing was typed, so nothing is attributed")


class TalkSlot(unittest.TestCase):
    def test_the_pointer_is_in_the_table_on_both_columns(self):
        self.assertEqual(R.chat_peek_items("r0001"), "0x%x:1,*0x%x:12" % (PTR, PTR))
        r4 = ga.address("talk_table_ptr", "r0004")
        self.assertEqual(R.chat_peek_items("r0004"), "0x%x:1,*0x%x:12" % (r4, r4))
        self.assertLessEqual(R.TALK_TABLE_WORDS, 64, "PS2X_PEEK caps an item at 64 words")
        self.assertEqual(R.TALK_ACTION_OFFSETS, {0x0a: 0x1c, 0x0b: 0x1d})

    def test_peek_cells(self):
        cells = R.peek_cells(peek_row(0x500000, table_words(0x10, 0x10)))
        self.assertEqual(cells["%x" % PTR], [0x500000])
        self.assertEqual(len(cells["500000"]), 12)
        null = R.peek_cells(peek_row(0))
        self.assertTrue(null["*0x%x" % PTR].startswith("unresolved"))
        self.assertEqual(R.peek_cells("[pc-sampler] t=1"), {})

    def test_reading_takes_the_two_talk_bytes_through_the_pointer(self):
        rows = [peek_row(0), peek_row(0x500000, table_words(0x10, 0x10)), peek_row(0x500000, table_words(0x03, 0x10)),
                "[pc-sampler] t=3"]
        r = R.talk_slot_reading(rows, PTR)
        self.assertEqual(r["rows"], 3)
        self.assertEqual(r["resolved"], 2)
        self.assertEqual(r["first"], (0x500000, 0x10, 0x10))
        self.assertEqual(r["last"], (0x500000, 0x03, 0x10))
        v = R.talk_slot_verdict(r, "A", PTR)
        self.assertEqual(v.status, R.PASS)
        self.assertIn("action 0x0a slot 0x03, action 0x0b unbound (0x10)", v.detail)

    def test_no_rows_and_null_pointer_are_no_data(self):
        self.assertEqual(R.talk_slot_verdict(R.talk_slot_reading([], PTR), "A", PTR).status, R.NO_DATA)
        v = R.talk_slot_verdict(R.talk_slot_reading([peek_row(0)], PTR), "B", PTR)
        self.assertEqual(v.status, R.NO_DATA)
        self.assertIn("null", v.detail)


class ChatVerdicts(unittest.TestCase):
    def test_keyboard(self):
        log = b"x" * 10 + CHAT_OPEN.encode()
        self.assertEqual(R.chat_keyboard_verdict({"sender": "A", "mark": 10, "by": "log"}, log).status, R.PASS)
        self.assertEqual(R.chat_keyboard_verdict({"sender": "A", "mark": 11, "by": None}, log).status, R.FAIL,
                         "an open line before the mark is some other press")
        self.assertEqual(R.chat_keyboard_verdict({"sender": "A", "mark": 0}, NAME_OPEN.encode()).status, R.FAIL)
        self.assertEqual(R.chat_keyboard_verdict({"sender": "A", "mark": 0}, None).status, R.NO_DATA)

    def test_receive(self):
        log = (seen_line(1) + "\n").encode()
        self.assertEqual(R.chat_receive_verdict({"receiver": "B", "receiver_mark": 0}, log).status, R.PASS)
        self.assertEqual(R.chat_receive_verdict({"receiver": "B", "receiver_mark": 5}, log).status, R.NO_DATA)
        self.assertEqual(R.chat_receive_verdict({"receiver": "B", "receiver_mark": 0}, b"quiet\n").status, R.FAIL)
        self.assertEqual(R.chat_receive_verdict({"receiver": "B", "receiver_mark": 0}, None).status, R.NO_DATA)

    def test_round_result_is_a_to_b(self):
        a_log = b"a" * 4 + CHAT_OPEN.encode() + b"\n" + peek_row(0x500000, table_words(0x10, 0x10)).encode()
        b_log = b"b" * 8 + (seen_line(1) + "\n").encode()
        chats = [{"sender": "A", "receiver": "B", "mark": 4, "receiver_mark": 8, "by": "log", "closed": True}]
        verdicts, info, overall = R.chat_round(chats, {"A": a_log, "B": b_log}, "A_LOBBY class=ok\nLOBBY class=ok\n",
                                               {"A": R.peek_rows(a_log), "B": R.peek_rows(b_log)})
        got = {x.name: x.status for x in verdicts}
        self.assertEqual(got["keyboard-A"], R.PASS)
        self.assertEqual(got["receive-B"], R.PASS)
        self.assertEqual(got["talk-slot-A"], R.PASS)
        self.assertEqual(got["talk-slot-B"], R.NO_DATA)
        self.assertEqual(overall, R.PASS)
        _, _, overall = R.chat_round(chats, {"A": a_log, "B": b"quiet"}, "LOBBY class=ok\n", {})
        self.assertEqual(overall, R.FAIL)
        _, _, overall = R.chat_round([], {}, "LOBBY class=ok\n", {})
        self.assertEqual(overall, "INCOMPLETE")

    def test_chat_call_lines_are_reported(self):
        log = (b"[call] 1.0s NetIdle #0 a0=0x0\n"
               b"[call] 412.3s ChatAppend #0 a0=0x1 a1=0x2 a2=0x3 a3=0x4 ra=0x1f4d58 f12=0 f13=0 f14=0 a0=\"hello\"\n")
        self.assertEqual(R.chat_call_lines(log), ['[call] 412.3s ChatAppend #0 a0=0x1 a1=0x2 a2=0x3 a3=0x4 ra=0x1f4d58 '
                                                  'f12=0 f13=0 f14=0 a0="hello"'])
        self.assertEqual(R.chat_call_lines(None), [])
        _, info, _ = R.chat_round([], {"B": log}, "LOBBY class=ok\n", {})
        self.assertTrue(any(i.startswith("INFO calls-B [call] 412.3s ChatAppend") for i in info), info)

    def test_main_reads_the_round_directory(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = os.path.join(d, "A.log"), os.path.join(d, "B.log")
            with open(a, "wb") as f:
                f.write(CHAT_OPEN.encode() + b"\n")
            with open(b, "wb") as f:
                f.write((seen_line(1) + "\n").encode())
            with open(os.path.join(d, "drive.txt"), "w") as f:
                f.write("LOBBY class=ok\n")
            with open(os.path.join(d, "chat.json"), "w") as f:
                json.dump([{"sender": "A", "receiver": "B", "mark": 0, "receiver_mark": 0}], f)
            with open(os.path.join(d, "round.txt"), "w") as f:
                f.write("A_LOG=%s\nB_LOG=%s\nDRIVE=%s\nREVISION=r0001\n" % (a, b, os.path.join(d, "drive.txt")))
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = R.main(["chat", d])
            self.assertEqual(rc, 0, buf.getvalue())      # the talk-slot NO-DATA (no peek rows) is not in the RESULT
            self.assertIn("RESULT CHAT PASS", buf.getvalue())


class ChatScript(unittest.TestCase):
    def setUp(self):
        with open(SCRIPT, encoding="utf-8") as f:
            self.src = f.read()
        self.code = "\n".join(ln for ln in self.src.splitlines() if not ln.lstrip().startswith("#"))

    def test_sources_env_and_records_the_environment(self):
        self.assertRegex(self.code, r'(?m)^\. "\$\(dirname "\$0"\)/env\.sh"$')
        self.assertRegex(self.code, r'(?m)^write_env_ps2x "\$OUT"')

    def test_appends_the_peek_to_env_sh_s_spec(self):
        self.assertIn('export PS2X_PEEK="${PS2X_PEEK:+$PS2X_PEEK,}$PEEK_ITEMS"', self.code)
        self.assertIn("chat_peek_items('$REVISION')", self.code)

    def test_drives_the_chat_prefilled_and_never_takes_the_lock(self):
        self.assertRegex(self.code, r"online_match_ours --existing-b --prefilled --chat \"\$TEXT\"")
        self.assertNotRegex(self.code, r"loop_lock\.sh|run_detached\.sh")
        self.assertIn("-m tools_py.parity.control_round_readout chat", self.code)
        self.assertIn('> "logs/${NAME}.done"', self.code)


if __name__ == "__main__":
    unittest.main()
