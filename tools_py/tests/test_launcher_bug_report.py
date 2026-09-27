"""Sprint 9 Goal 8: the launcher's bug report, end to end against a LOOPBACK server -- never the live one.

`socom_unzipped_launcher --report-bug <form.json> [home]` builds one report and POSTs it; the service's base
URL comes from PS2X_LAUNCHER_API_BASE, which the launcher honours only for http://127.0.0.1:<port> and
http://localhost:<port>, and only in developer mode (PS2X_DEV=1: it is a Dev knob, Sprint 9 Goal 3). The handler below plays socomunzipped.com's /api/bugs and /api/stats (sites/s2u/api):
201 with an id, 400 with a field, 429 with Retry-After, 500 -- and a closed port for "no connection".
Runs wherever the launcher is built, CI included (no window is opened).
"""
import glob
import http.server
import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest

from tools_py.parity import hostplatform

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LAUNCHER = os.path.join(ROOT, os.path.dirname(hostplatform.runtime_exe()),
                        hostplatform.exe_name("socom_unzipped_launcher"))

STATS = {"status": "online", "server": "SOCOM Unzipped", "location": "US East (Ohio) - AWS us-east-2",
         "uptimeSeconds": 99, "players": {"online": 3, "inGame": 2, "inLobby": 1, "names": ["a", "b", "c"]},
         "games": [{"name": "room$~x", "players": 2}], "channels": [], "sinceStart": {"gamesCreated": 4}}


class Service(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.reply = (201, {"ok": True, "id": "BR-20260919-abc123"}, {})
        self.stats_body = json.dumps(STATS).encode()
        self.requests = []

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.server_address[1]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append({"path": self.path, "type": self.headers.get("Content-Type"), "raw": raw})
        status, body, headers = self.server.reply
        self._send(status, json.dumps(body).encode(), headers)

    def do_GET(self):
        self.server.requests.append({"path": self.path, "type": None, "raw": b""})
        self._send(200, self.server.stats_body)


@unittest.skipUnless(os.path.isfile(LAUNCHER), "no launcher build at " + LAUNCHER)
class LauncherBugReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake_home = os.path.join(self.tmp.name, "Users", "secretuser")
        self.game = os.path.join(self.tmp.name, "game")
        os.makedirs(os.path.join(self.game, "logs"))
        os.makedirs(self.fake_home)
        self.iso = os.path.join(self.fake_home, "Games", "socom2.iso")
        with open(os.path.join(self.game, "config.json"), "w") as fh:
            json.dump({"isoPath": self.iso, "gsScale": 2, "password": "hunter2", "token": "abc123token",
                       "profile": "viper", "micDevice": "Headset (secret mic)"}, fh)
        with open(os.path.join(self.game, "logs", "run_20260101_000000.log"), "w") as fh:
            fh.write("INFO:     > Renderer: Test Renderer\n[socom2] CD image: %s\nthe last line of the run\n" % self.iso)
        with open(os.path.join(self.game, "version.txt"), "w") as fh:
            fh.write("SOCOM Unzipped test (2026-01-01)\n")
        self.service = Service()
        thread = threading.Thread(target=self.service.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.service.server_close)
        self.addCleanup(self.service.shutdown)

    def run_launcher(self, args, base=None):
        # PS2X_LAUNCHER_API_BASE is a Dev knob (Sprint 9 Goal 3): the launcher honours it only in developer mode.
        env = {**os.environ, "USERPROFILE": self.fake_home, "HOME": self.fake_home, "PS2X_DEV": "1",
               "PS2X_LAUNCHER_API_BASE": base or self.service.base}
        return subprocess.run([LAUNCHER] + args, capture_output=True, text=True, timeout=60, env=env)

    def report(self, form, base=None):
        path = os.path.join(self.tmp.name, "form.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(form, fh)
        return self.run_launcher(["--report-bug", path, self.game], base)

    def saved_reports(self):
        return sorted(glob.glob(os.path.join(self.game, "logs", "bugreport_*.json")))

    FORM = {"title": "  launcher loopback proof  ", "description": "It closed when I joined a game.\nTwice.",
            "contact": "me#1"}

    def test_201_the_body_is_the_contract_and_the_id_is_printed(self):
        r = self.report(self.FORM)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("REPORT RECEIVED. REFERENCE BR-20260919-ABC123.", r.stdout)
        self.assertEqual(len(self.service.requests), 1)
        req = self.service.requests[0]
        self.assertEqual(req["path"], "/api/bugs")
        self.assertTrue(req["type"].startswith("application/json"), req["type"])
        self.assertLessEqual(len(req["raw"]), 98304)
        body = json.loads(req["raw"].decode("utf-8"))
        self.assertEqual(body["title"], "launcher loopback proof")
        self.assertEqual(body["description"], "It closed when I joined a game.\nTwice.")
        self.assertEqual(body["contact"], "me#1")
        self.assertEqual(body["source"], "launcher")
        self.assertEqual(body["version"], "SOCOM Unzipped test (2026-01-01)")
        self.assertIn(body["platform"], ("windows", "linux"))
        self.assertEqual(body["website"], "")
        self.assertIs(body["test"], True)   # the headless mode's default: a proof marks itself
        self.assertNotIn("log", body)       # the log is off unless asked for
        context = body["context"]
        self.assertLessEqual(len(context), 16)
        self.assertEqual(context["iso"], "socom2.iso")
        self.assertEqual(context["gsScale"], "2")
        self.assertEqual(context["profile"], "viper")
        self.assertEqual(context["glRenderer"], "Test Renderer")
        for k, v in context.items():
            self.assertIsInstance(v, str)
            self.assertLessEqual(len(k), 32)
            self.assertLessEqual(len(v), 256)
        for secret in (b"secretuser", b"hunter2", b"abc123token", b"password", b"secret mic", b"Games"):
            self.assertNotIn(secret, req["raw"])
        self.assertEqual(self.saved_reports(), [])

    def test_the_log_rides_along_only_when_asked_and_is_scrubbed(self):
        r = self.report({**self.FORM, "attachLog": True, "test": False})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        body = json.loads(self.service.requests[0]["raw"].decode("utf-8"))
        self.assertNotIn("test", body)   # the form file said otherwise
        self.assertIn("the last line of the run", body["log"])
        self.assertIn("socom2.iso", body["log"])
        self.assertLessEqual(len(body["log"]), 65536)
        self.assertNotIn(b"secretuser", self.service.requests[0]["raw"])
        self.assertNotIn(b"Games", self.service.requests[0]["raw"])

    def test_a_form_the_site_would_refuse_never_leaves_the_machine(self):
        r = self.report({"title": "abc", "description": "long enough text"})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("TITLE: 4 TO 120 CHARACTERS.", r.stdout)
        self.assertEqual(self.service.requests, [])

    def test_400_names_the_field(self):
        self.service.reply = (400, {"ok": False, "error": "description: 10 to 4000 characters"}, {})
        r = self.report(self.FORM)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("NOT SENT. DESCRIPTION: 10 TO 4000 CHARACTERS", r.stdout)
        self.assertEqual(self.saved_reports(), [])

    def test_429_says_when_to_retry_and_keeps_the_report(self):
        self.service.reply = (429, {"ok": False, "error": "rate limited"}, {"Retry-After": "1500"})
        r = self.report(self.FORM)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("TRY AGAIN IN 25 MINUTES.", r.stdout)
        self.assertEqual(len(self.saved_reports()), 1)

    def test_500_saves_the_report_and_says_where(self):
        self.service.reply = (500, {"ok": False}, {})
        r = self.report(self.FORM)
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertIn("NOT SENT. THE REPORT SERVICE DID NOT ANSWER; YOUR TEXT IS STILL HERE.", r.stdout)
        saved = self.saved_reports()
        self.assertEqual(len(saved), 1, r.stdout)
        self.assertIn(saved[0], r.stdout)
        with open(saved[0], "rb") as fh:
            on_disk = fh.read()
        self.assertEqual(on_disk, self.service.requests[0]["raw"])   # exactly what would have been sent
        self.assertEqual(json.loads(on_disk.decode("utf-8"))["title"], "launcher loopback proof")

    def test_a_refused_connection_saves_the_report_too(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            closed_port = s.getsockname()[1]
        r = self.report(self.FORM, base="http://127.0.0.1:%d" % closed_port)
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertIn("NOT SENT.", r.stdout)
        saved = self.saved_reports()
        self.assertEqual(len(saved), 1, r.stdout)
        self.assertIn(saved[0], r.stdout)
        with open(saved[0], encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["description"], "It closed when I joined a game.\nTwice.")
        self.assertEqual(self.service.requests, [])

    def test_the_status_line_from_api_stats(self):
        r = self.run_launcher(["--server-status"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout.strip(), "SOCOM Unzipped: online, 3 players, 1 game")
        self.assertEqual(self.service.requests[0]["path"], "/api/stats")
        self.service.stats_body = b"<html>502 Bad Gateway</html>"
        r = self.run_launcher(["--server-status"])
        self.assertEqual(r.stdout.strip(), "")   # silent when the answer is junk
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
