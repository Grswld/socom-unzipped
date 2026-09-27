"""Sprint 16 R2a (#71): the launcher's streaming download and the r0004 package fetch, against a LOOPBACK server.

`socom_unzipped_launcher --fetch-patch <dest> <bytes> <sha256>` downloads GET /s2/r0004/APACHE00.ZDB with the
r0001 client's User-Agent and checks the size and the digest. The base URL comes from PS2X_LAUNCHER_PATCH_BASE,
which the launcher honours only for http://127.0.0.1:<port> and http://localhost:<port>, only in developer mode
(PS2X_DEV=1: it is a Dev knob, as PS2X_LAUNCHER_API_BASE is, R205) -- and the headless mode refuses anything
but a loopback base, because the first live fetch from PSRewired is the owner's hand (R293). Every body here is
synthetic: nothing derived from the disc. Runs wherever the launcher is built, CI included (no window).
"""
import hashlib
import http.server
import os
import random
import subprocess
import tempfile
import threading
import unittest

from tools_py.parity import hostplatform

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAUNCHER = os.path.join(ROOT, os.path.dirname(hostplatform.runtime_exe()),
                        hostplatform.exe_name("socom_unzipped_launcher"))

PATH = "/s2/r0004/APACHE00.ZDB"
USER_AGENT = "sceHTTPLib-1.2.42"
# 1.7 MB: above the old 1 MiB cap on httpRequest's body, so a capped path cannot pass.
BODY = random.Random(71).randbytes(1_700_000)
SHA = hashlib.sha256(BODY).hexdigest()


class PackageServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.mode = "ok"            # ok | 404 | short
        self.requests = []

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.server_address[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append({"path": self.path, "agent": self.headers.get("User-Agent")})
        mode = self.server.mode
        if self.path != PATH or mode == "404":
            body = b"not here"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        # "short": the header promises the whole body, the connection closes after half of it.
        self.wfile.write(BODY if mode == "ok" else BODY[:len(BODY) // 2])
        self.wfile.flush()
        self.close_connection = True


@unittest.skipUnless(os.path.isfile(LAUNCHER), "no launcher build at " + LAUNCHER)
class LauncherPatchFetchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out_dir = os.path.join(self.tmp.name, "r0004")
        os.makedirs(self.out_dir)
        self.dest = os.path.join(self.out_dir, "APACHE00.ZDB")
        self.server = PackageServer()
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def fetch(self, size=len(BODY), sha=SHA, dev="1", base=None):
        # PS2X_LAUNCHER_PATCH_BASE is a Dev knob: the launcher honours it only in developer mode. NO_PROXY keeps a
        # proxy in the environment from carrying the loopback request anywhere.
        env = {**os.environ, "PS2X_DEV": dev, "PS2X_LAUNCHER_PATCH_BASE": base or self.server.base,
               "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
        return subprocess.run([LAUNCHER, "--fetch-patch", self.dest, str(size), sha],
                              capture_output=True, text=True, timeout=120, env=env)

    def left_beside_dest(self):
        return sorted(os.listdir(self.out_dir))

    def test_200_above_the_old_cap_is_saved_whole_and_checked(self):
        r = self.fetch()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.left_beside_dest(), ["APACHE00.ZDB"])   # the temporary name never survives
        with open(self.dest, "rb") as fh:
            got = fh.read()
        self.assertEqual(len(got), len(BODY))
        self.assertEqual(hashlib.sha256(got).hexdigest(), SHA)
        self.assertIn("FETCHED %d bytes, sha256 %s" % (len(BODY), SHA), r.stdout)

    def test_the_request_is_the_r0001_clients(self):
        r = self.fetch()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0]["path"], PATH)
        self.assertEqual(self.server.requests[0]["agent"], USER_AGENT)

    def test_404_is_refused_and_nothing_is_left(self):
        self.server.mode = "404"
        r = self.fetch()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("NOT FETCHED.", r.stdout)
        self.assertIn("404", r.stdout)
        self.assertEqual(self.left_beside_dest(), [])

    def test_a_body_shorter_than_its_content_length_is_refused_and_nothing_is_left(self):
        self.server.mode = "short"
        r = self.fetch()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("NOT FETCHED.", r.stdout)
        self.assertEqual(self.left_beside_dest(), [])

    def test_the_right_size_with_the_wrong_sha_is_refused_and_deleted(self):
        r = self.fetch(sha=hashlib.sha256(b"another package").hexdigest())
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("REFUSED.", r.stdout)
        self.assertEqual(self.left_beside_dest(), [])

    def test_the_wrong_size_is_refused_and_deleted(self):
        r = self.fetch(size=len(BODY) - 1)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertEqual(self.left_beside_dest(), [])

    def test_an_existing_file_is_replaced_only_by_a_complete_body(self):
        with open(self.dest, "wb") as fh:
            fh.write(b"the previous copy")
        self.server.mode = "short"
        self.assertEqual(self.fetch().returncode, 1)
        with open(self.dest, "rb") as fh:
            self.assertEqual(fh.read(), b"the previous copy")
        self.assertEqual(self.left_beside_dest(), ["APACHE00.ZDB"])

    def test_without_developer_mode_the_live_server_is_never_asked(self):
        # The seam is ignored without PS2X_DEV, the base falls back to PSRewired, and the headless mode refuses
        # that before any request (R293): nothing reaches the network, nothing is written.
        r = self.fetch(dev="0")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("R293", r.stdout)
        self.assertEqual(self.server.requests, [])
        self.assertEqual(self.left_beside_dest(), [])

    def test_a_non_loopback_base_is_ignored_and_refused(self):
        r = self.fetch(base="http://patch.example.invalid")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(self.left_beside_dest(), [])


if __name__ == "__main__":
    unittest.main()
