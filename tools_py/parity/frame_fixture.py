"""A local robustness fixture for our own client's receive path: one TCP connection, one over-length RT frame.

It accepts a connection on --port, waits for the client's first bytes, answers with ONE RT frame whose 16-bit
header length (the 3-byte head: id, then the length little-endian, as `socom2_rt_frames.h` reads it) is larger
than the body that follows, and closes. The body is zeros and nothing else; no other protocol is spoken. The
point is the runtime's side: the receive path has to hold a frame it never gets whole without a crash, and the
bounds from the runtime hardening (`socom2_net_bounds.h`, `socom2_libnetb.cpp`) refuse what they refuse with
one log line. Python only, no build, no lock.

Usage:
    python -m tools_py.parity.frame_fixture --selftest
    python -m tools_py.parity.frame_fixture --bind <this host's LAN IP> --port 10071 --once

--claimed (default 4096) is the length the head names, --sent (default 16) the zero bytes actually sent;
--sent must be smaller than --claimed or the fixture refuses. Without --once it answers every connection, one at
a time, the same way, until interrupted. --selftest runs the responder against a local client socket on a
loopback port and asserts the bytes on the wire.

The live check -- run by the CONTROLLER, never by an agent (agents run no game):
  1. `python -m tools_py.parity.dns_stub --bind <IP> --answer <IP>` answers the game's DNS with this host (the
     PCSX2 guest's route; the native client resolves every Medius/DNAS name to PS2X_SOCOM2_SERVER itself).
  2. `PS2X_SOCOM2_SERVER=<IP>` points the client at this host, and this fixture listens on <IP> with --once
     on the port the client connects to first (10071, the universe/MAS port in KNOWN).
  3. The launcher connects one client. Pass: the client's game log shows the receive path's refusal line from
     the runtime hardening -- a `[socom2...] ... bounded: ... refused` line -- or, where the partial frame is
     only held and never dispatched, no crash and a clean connection-closed path; and in every case the game
     does not crash and exits by its own path. The record of that run is kept privately, not in the tree.
"""
import argparse
import socket
import struct
import sys
import threading

HEAD_BYTES = 3          # id, then a u16 little-endian length (the body alone)
DEFAULT_ID = 0x0A       # a plain server-app frame id
DEFAULT_CLAIMED = 4096
DEFAULT_SENT = 16
DEFAULT_PORT = 10071


def build_frame(frame_id=DEFAULT_ID, claimed=DEFAULT_CLAIMED, sent=DEFAULT_SENT):
    """The head naming `claimed` body bytes, then `sent` zero bytes; `sent` < `claimed` or ValueError."""
    if not 0 <= frame_id <= 0xFF:
        raise ValueError("frame id %r is not one byte" % (frame_id,))
    if not 0 < claimed <= 0xFFFF:
        raise ValueError("claimed length %r does not fit the 16-bit head" % (claimed,))
    if not 0 <= sent < claimed:
        raise ValueError("sent %r must be at least 0 and smaller than the claimed %r" % (sent, claimed))
    return struct.pack("<BH", frame_id, claimed) + bytes(sent)


def parse_frame(data):
    """(id, claimed length, body bytes) of one frame as built above; ValueError on a short head."""
    if len(data) < HEAD_BYTES:
        raise ValueError("%d bytes is shorter than the %d-byte head" % (len(data), HEAD_BYTES))
    frame_id, claimed = struct.unpack("<BH", data[:HEAD_BYTES])
    return frame_id, claimed, bytes(data[HEAD_BYTES:])


def make_listener(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((host, port))
    s.listen(1)
    return s


def read_to_eof(sock):
    out = bytearray()
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            return bytes(out)
        out += chunk


def answer_one(conn, frame, first_bytes_timeout=30.0):
    """Wait for the client's first bytes, send the frame, close. Returns the number of bytes the client sent first."""
    with conn:
        conn.settimeout(first_bytes_timeout)
        try:
            first = conn.recv(4096)
        except socket.timeout:
            first = b""
        if first:
            conn.sendall(frame)
        try:
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        return len(first)


def serve(listener, frame, once=True, log=None):
    """Answer connections on `listener`; with `once`, exactly one, then close it. Returns the connections answered."""
    answered = 0
    try:
        while True:
            conn, peer = listener.accept()
            n = answer_one(conn, frame)
            answered += 1
            if log:
                log("frame_fixture: %s:%d sent %d bytes first; answered with %d bytes (head claims %d)"
                    % (peer[0], peer[1], n, len(frame), parse_frame(frame)[1]))
            if once:
                return answered
    finally:
        listener.close()


def selftest():
    """The responder against a local client socket; asserts the bytes on the wire. 0 on pass."""
    frame = build_frame()
    listener = make_listener("127.0.0.1", 0)
    port = listener.getsockname()[1]
    t = threading.Thread(target=serve, args=(listener, frame, True), daemon=True)
    t.start()
    with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
        c.settimeout(5)
        c.sendall(b"\x00")
        got = read_to_eof(c)
    t.join(5)
    assert not t.is_alive(), "the responder did not return after one connection"
    assert got == frame, "wire bytes %r != built frame %r" % (got[:16], frame[:16])
    frame_id, claimed, body = parse_frame(got)
    assert frame_id == DEFAULT_ID, frame_id
    assert len(body) < claimed, (len(body), claimed)
    assert body == bytes(len(body)), "the body is not zeros"
    print("frame_fixture selftest: OK (head claims %d, %d zero bytes sent, then closed)" % (claimed, len(body)))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bind", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="TCP port (default %d)" % DEFAULT_PORT)
    ap.add_argument("--once", action="store_true", help="answer one connection, then exit")
    ap.add_argument("--claimed", type=int, default=DEFAULT_CLAIMED, help="the length the head names")
    ap.add_argument("--sent", type=int, default=DEFAULT_SENT, help="the zero body bytes actually sent")
    ap.add_argument("--selftest", action="store_true", help="run against a local client socket and assert")
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    try:
        frame = build_frame(DEFAULT_ID, args.claimed, args.sent)
    except ValueError as e:
        ap.error(str(e))
    listener = make_listener(args.bind, args.port)
    print("frame_fixture: listening on %s:%d (%s)" % (args.bind, listener.getsockname()[1],
                                                       "once" if args.once else "until interrupted"), flush=True)
    serve(listener, frame, once=args.once, log=lambda s: print(s, flush=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
