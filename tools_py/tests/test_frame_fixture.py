"""tools_py.parity.frame_fixture: the one over-length frame it builds, and its self-test on a local socket.

No game, no lock: the responder runs on a loopback port in a thread and a plain client socket reads what it sent.
"""
import socket
import threading
import unittest

from tools_py.parity import frame_fixture as ff


class BuildFrameTest(unittest.TestCase):
    def test_the_header_claims_more_than_the_body_it_carries(self):
        frame = ff.build_frame(0x0A, claimed=64, sent=8)
        self.assertEqual(frame[:3], bytes([0x0A, 64, 0]))
        self.assertEqual(len(frame), 3 + 8)
        frame_id, claimed, body = ff.parse_frame(frame)
        self.assertEqual((frame_id, claimed), (0x0A, 64))
        self.assertLess(len(body), claimed)

    def test_the_length_is_sixteen_bit_little_endian(self):
        frame = ff.build_frame(0x0A, claimed=0x1234, sent=2)
        self.assertEqual(frame[1:3], bytes([0x34, 0x12]))

    def test_the_body_is_zeros_only(self):
        frame = ff.build_frame(0x0A, claimed=4096, sent=100)
        self.assertEqual(frame[3:], bytes(100))

    def test_the_defaults_make_an_over_length_frame(self):
        frame_id, claimed, body = ff.parse_frame(ff.build_frame())
        self.assertLess(len(body), claimed)
        self.assertEqual(body, bytes(len(body)))

    def test_a_body_as_long_as_the_claim_is_refused(self):
        with self.assertRaises(ValueError):
            ff.build_frame(0x0A, claimed=8, sent=8)
        with self.assertRaises(ValueError):
            ff.build_frame(0x0A, claimed=8, sent=9)

    def test_a_claim_past_sixteen_bits_or_a_bad_id_is_refused(self):
        with self.assertRaises(ValueError):
            ff.build_frame(0x0A, claimed=0x10000, sent=1)
        with self.assertRaises(ValueError):
            ff.build_frame(0x100, claimed=8, sent=1)
        with self.assertRaises(ValueError):
            ff.build_frame(0x0A, claimed=8, sent=-1)

    def test_parse_refuses_a_short_head(self):
        with self.assertRaises(ValueError):
            ff.parse_frame(b"\x0a\x01")


class ResponderTest(unittest.TestCase):
    def test_one_connection_gets_the_frame_after_its_first_bytes_then_eof(self):
        listener = ff.make_listener("127.0.0.1", 0)
        port = listener.getsockname()[1]
        frame = ff.build_frame(0x0A, claimed=300, sent=20)
        served = []
        t = threading.Thread(target=lambda: served.append(ff.serve(listener, frame, once=True)), daemon=True)
        t.start()
        with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
            c.settimeout(5)
            c.sendall(b"\x01")
            got = ff.read_to_eof(c)
        t.join(5)
        self.assertFalse(t.is_alive(), "serve(once=True) returns after one connection")
        self.assertEqual(served, [1])
        self.assertEqual(got, frame)

    def test_nothing_is_sent_before_the_client_speaks(self):
        listener = ff.make_listener("127.0.0.1", 0)
        port = listener.getsockname()[1]
        frame = ff.build_frame()
        t = threading.Thread(target=ff.serve, args=(listener, frame, True), daemon=True)
        t.start()
        with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
            c.settimeout(0.3)
            with self.assertRaises(socket.timeout):
                c.recv(1)
            c.settimeout(5)
            c.sendall(b"\x00")
            self.assertEqual(ff.read_to_eof(c), frame)
        t.join(5)
        self.assertFalse(t.is_alive())


class SelftestTest(unittest.TestCase):
    def test_selftest_passes(self):
        self.assertEqual(ff.selftest(), 0)

    def test_main_selftest_exit_code(self):
        self.assertEqual(ff.main(["--selftest"]), 0)

    def test_main_refuses_a_body_not_shorter_than_the_claim(self):
        with self.assertRaises(SystemExit) as cm:
            ff.main(["--claimed", "8", "--sent", "8", "--once", "--port", "0"])
        self.assertNotEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
