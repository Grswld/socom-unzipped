"""server/ops/: the hosted box's backup, health and off-box pull, tracked with their secrets in an ignored file
(Sprint 13 Task O3).

The scripts used to live only under the git-ignored vm/lightsail/, with the box's address and key path written into
them. Tracked, they must carry none of that: every secret, address and key path comes from ops.env (ignored), whose
shape is ops.env.example (tracked, placeholders only). What is pinned here:
  * each script loads ops.env, and refuses to run without one (exit 2);
  * no script carries an address literal -- no private address (the leak check's tracked-private-ip rule), not the
    hosted box's public address (the leak check's HOSTED_IPS), no public IPv4 at all but loopback -- nor a key path;
  * ops.env.example has every OPS_* key the scripts read, and its addresses are RFC 5737 placeholders;
  * backup.sh makes verified sets and keeps only OPS_BACKUP_KEEP of them; the puller's check accepts such a set and
    refuses a tampered one; the puller refuses the example's placeholder address;
  * ops.env is ignored, and the package never ships it.
"""
import hashlib
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

from tools_py.release import leakrules as R
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OPS = os.path.join(ROOT, "server", "ops")
SCRIPTS = ("backup.sh", "health.sh", "backup-pull.ps1", "backup.cron")
EXAMPLE = os.path.join(OPS, "ops.env.example")
IPV4 = re.compile(r"(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])")
LOOPBACK_OR_ANY = {"127.0.0.1", "0.0.0.0"}
KEY_PATH = re.compile(r"(?i)(?:\.pem\b|_ed25519|id_(?:rsa|ecdsa)|/keys/|\\keys\\|\.ssh[/\\])")
ACCOUNT_ID = re.compile(r"(?<!\d)\d{12}(?!\d)")          # an AWS account id's shape


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _posix(path):
    return path.replace("\\", "/")


def _keys_read(text):
    return set(re.findall(r"\bOPS_[A-Z0-9_]+\b", text)) - {"OPS_ENV"}


def _example_keys():
    return {line.split("=", 1)[0].strip() for line in _read(EXAMPLE).splitlines()
            if line.strip() and not line.lstrip().startswith("#") and "=" in line}


class OpsScriptsCarryNoSecrets(unittest.TestCase):
    def test_every_script_is_there(self):
        for name in SCRIPTS + ("ops.env.example",):
            self.assertTrue(os.path.isfile(os.path.join(OPS, name)), name)

    def test_each_script_loads_the_env_file(self):
        for name in ("backup.sh", "health.sh"):
            text = _read(os.path.join(OPS, name))
            self.assertIn("set -a; . <(tr -d '\\r' < \"$f\"); set +a", text, name + " must source ops.env")
            self.assertRegex(text, r"(?m)^load_ops_env$", name + " must call its loader")
        pull = _read(os.path.join(OPS, "backup-pull.ps1"))
        self.assertIn("Read-OpsEnv $EnvFile", pull)
        self.assertIn("'ops.env'", pull)
        self.assertIn("OPS_ENV=", _read(os.path.join(OPS, "backup.cron")))

    def test_no_script_carries_an_address_or_a_key_path(self):
        for name in SCRIPTS:
            text = _read(os.path.join(OPS, name))
            for i, line in enumerate(text.splitlines(), 1):
                where = "%s:%d: %s" % (name, i, line.strip())
                self.assertIsNone(R.PRIVATE_IP_RE.search(line), "private address (tracked-private-ip) " + where)
                for hosted in R.HOSTED_IPS:
                    self.assertNotIn(hosted, line, "the hosted box's address belongs in ops.env: " + where)
                for ip in IPV4.findall(line):
                    self.assertIn(ip, LOOPBACK_OR_ANY, "an address literal belongs in ops.env: " + where)
                self.assertIsNone(KEY_PATH.search(line), "a key path belongs in ops.env: " + where)
                self.assertIsNone(ACCOUNT_ID.search(line), "an account id has no place here: " + where)

    def test_the_example_holds_placeholders_only(self):
        text = _read(EXAMPLE)
        for i, line in enumerate(text.splitlines(), 1):
            where = "ops.env.example:%d: %s" % (i, line.strip())
            self.assertIsNone(R.PRIVATE_IP_RE.search(line), where)
            for hosted in R.HOSTED_IPS | R.HOSTED_NAMES:
                self.assertNotIn(hosted, line, where)
            for ip in IPV4.findall(line):
                self.assertTrue(ip in LOOPBACK_OR_ANY or R.NOBODYS_IP_RE.match(ip)
                                or ipaddress.ip_address(ip) in ipaddress.ip_network("203.0.113.0/24"), where)
            self.assertIsNone(KEY_PATH.search(line), where)
            self.assertIsNone(ACCOUNT_ID.search(line), where)

    def test_the_example_has_every_key_the_scripts_read(self):
        wanted = set()
        for name in SCRIPTS:
            wanted |= _keys_read(_read(os.path.join(OPS, name)))
        self.assertTrue(wanted)
        self.assertEqual(sorted(wanted - _example_keys()), [], "keys the scripts read that ops.env.example lacks")

    def test_the_env_file_is_ignored(self):
        for name in ("server/ops/ops.env", "server/ops/box2.env"):
            r = subprocess.run(["git", "check-ignore", "-q", name], cwd=ROOT)
            self.assertEqual(r.returncode, 0, name + " must be git-ignored")
        r = subprocess.run(["git", "check-ignore", "-q", "server/ops/ops.env.example"], cwd=ROOT)
        self.assertEqual(r.returncode, 1, "the example must stay trackable")


@unittest.skipUnless(BASH, "no bash on this host")
class BoxScripts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="server_ops_")
        self.server = os.path.join(self.tmp, "server")
        self.backups = os.path.join(self.tmp, "backups")
        os.makedirs(os.path.join(self.server, "config"))
        with open(os.path.join(self.server, "config", "simulated.db"), "wb") as fh:
            fh.write(os.urandom(4096))
        for name in ("medius.json", "muis.json"):
            with open(os.path.join(self.server, "config", name), "w") as fh:
                fh.write('{"x": 1}\n')
        self.env = os.path.join(self.tmp, "ops.env")
        with open(self.env, "w", newline="\r\n") as fh:   # CRLF, as an ops.env saved on Windows is
            fh.write("OPS_SERVER_DIR=%s\nOPS_BACKUP_DIR=%s\nOPS_BACKUP_KEEP=2\nOPS_BACKUP_SETTLE_SEC=0\n"
                     % (_posix(self.server), _posix(self.backups)))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, script, env_file):
        return subprocess.run([BASH, os.path.join(OPS, script)], capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, "OPS_ENV": _posix(env_file)})

    def test_without_an_env_file_nothing_runs(self):
        for script in ("backup.sh", "health.sh"):
            r = self._run(script, os.path.join(self.tmp, "missing.env"))
            self.assertEqual(r.returncode, 2, script + ": " + r.stderr)
            self.assertIn("ops.env", r.stderr)
        self.assertFalse(os.path.exists(self.backups))

    def test_backup_makes_verified_sets_and_keeps_the_newest(self):
        for n in range(3):
            if n:
                time.sleep(1.1)                  # the set's name is a UTC stamp to the second
            r = self._run("backup.sh", self.env)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("settled=1", r.stdout)
        sets = sorted(os.listdir(self.backups))
        self.assertEqual(len(sets), 2, sets)
        newest = os.path.join(self.backups, sets[-1])
        with open(os.path.join(self.server, "config", "simulated.db"), "rb") as fh:
            live = fh.read()
        with open(os.path.join(newest, "simulated.db"), "rb") as fh:
            self.assertEqual(fh.read(), live)
        lines = _read(os.path.join(newest, "SHA256SUMS")).splitlines()
        self.assertEqual(len(lines), 3, lines)
        for line in lines:
            digest, name = line.split(None, 1)
            name = name.lstrip("*")
            self.assertNotIn("/", name, "SHA256SUMS names the files bare, so a pulled set verifies anywhere")
            with open(os.path.join(newest, name), "rb") as fh:
                self.assertEqual(hashlib.sha256(fh.read()).hexdigest(), digest, name)
        self.newest = newest


@unittest.skipUnless(BASH and shutil.which("powershell"), "bash and PowerShell only")
class Puller(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="server_ops_pull_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _pull(self, *args):
        return subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                               os.path.join(OPS, "backup-pull.ps1"), *args], capture_output=True, text=True, cwd=ROOT)

    def _a_set(self):
        box = BoxScripts("test_backup_makes_verified_sets_and_keeps_the_newest")
        box.setUp()
        self.addCleanup(box.tearDown)
        box.test_backup_makes_verified_sets_and_keeps_the_newest()
        return box.newest

    def test_a_set_from_backup_sh_verifies_and_a_tampered_one_does_not(self):
        s = self._a_set()
        r = self._pull("-VerifyOnly", s)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("verified (3 files)", r.stdout)
        with open(os.path.join(s, "medius.json"), "a") as fh:
            fh.write(" ")
        r = self._pull("-VerifyOnly", s)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("medius.json differs", r.stderr)

    def test_the_box_sets_absolute_paths_verify_too(self):
        s = self._a_set()
        sums = os.path.join(s, "SHA256SUMS")
        rows = [l.split(None, 1) for l in _read(sums).splitlines()]
        with open(sums, "w", newline="\n") as fh:
            for digest, name in rows:
                fh.write("%s  /var/backups/socom-unzipped/%s/%s\n" % (digest, os.path.basename(s), name.lstrip("*")))
        r = self._pull("-VerifyOnly", s)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_without_an_env_file_nothing_is_pulled(self):
        r = self._pull("-EnvFile", os.path.join(self.tmp, "missing.env"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("no ops.env", r.stderr)

    def test_the_examples_placeholder_address_is_refused(self):
        env = os.path.join(self.tmp, "ops.env")
        shutil.copyfile(EXAMPLE, env)
        r = self._pull("-EnvFile", env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("placeholder", r.stderr)

    def test_a_missing_key_is_named(self):
        env = os.path.join(self.tmp, "ops.env")
        with open(env, "w") as fh:
            fh.write("OPS_BOX_HOST=box.example.org\nOPS_BOX_USER=ubuntu\n")
        r = self._pull("-EnvFile", env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("OPS_SSH_KEY", r.stderr)

    def _env_with_known_hosts(self, known_hosts_body):
        key = os.path.join(self.tmp, "box_key")
        with open(key, "w") as fh:
            fh.write("not a key\n")
        env = os.path.join(self.tmp, "ops.env")
        lines = ["OPS_BOX_HOST=box.example.org", "OPS_BOX_USER=ubuntu", "OPS_SSH_KEY=" + key,
                 "OPS_KNOWN_HOSTS=" + os.path.join(self.tmp, "known_hosts"), "OPS_BACKUP_DIR=/var/backups/x",
                 "OPS_PULL_DIR=" + os.path.join(self.tmp, "pulled")]
        with open(env, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        if known_hosts_body is not None:
            with open(os.path.join(self.tmp, "known_hosts"), "w") as fh:
                fh.write(known_hosts_body)
        return env

    def test_a_missing_or_empty_known_hosts_is_refused(self):
        """The host key is pinned (StrictHostKeyChecking=yes), so there must be one to pin against."""
        for body in (None, ""):
            r = self._pull("-EnvFile", self._env_with_known_hosts(body))
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("OPS_KNOWN_HOSTS", r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "pulled")), "nothing is pulled")
        text = _read(os.path.join(OPS, "backup-pull.ps1"))
        self.assertIn("StrictHostKeyChecking=yes", text)
        self.assertNotIn("accept-new", text)

    def test_a_set_without_the_database_does_not_verify(self):
        s = self._a_set()
        sums = os.path.join(s, "SHA256SUMS")
        kept = [l for l in _read(sums).splitlines() if "simulated.db" not in l]
        with open(sums, "w", newline="\n") as fh:
            fh.write("\n".join(kept) + "\n")
        r = self._pull("-VerifyOnly", s)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("does not list simulated.db", r.stderr)


@unittest.skipUnless(BASH, "no bash on this host")
class BoxScriptsMore(unittest.TestCase):
    """health.sh's line against a stand-in layout, and a backup whose database never settles."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="server_ops_more_")
        self.server = os.path.join(self.tmp, "server")
        self.backups = os.path.join(self.tmp, "backups")
        os.makedirs(os.path.join(self.server, "config"))
        with open(os.path.join(self.server, "config", "simulated.db"), "wb") as fh:
            fh.write(b"12345")
        with open(os.path.join(self.server, "config", "medius.json"), "w") as fh:
            fh.write("{}\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _env(self, extra=""):
        env = os.path.join(self.tmp, "ops.env")
        with open(env, "w", newline="\n") as fh:
            # port 9 (discard) on loopback: nothing answers, so the stats read is quick and empty
            fh.write("OPS_SERVER_DIR=%s\nOPS_BACKUP_DIR=%s\nOPS_STATS_URL=http://127.0.0.1:9/stats\n"
                     "OPS_DEPLOYED_COMMIT=\n%s" % (_posix(self.server), _posix(self.backups), extra))
        return env

    def _run(self, script, env):
        return subprocess.run([BASH, os.path.join(OPS, script)], capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, "OPS_ENV": _posix(env)}, timeout=120)

    # health.sh reads /proc/uptime and /proc/meminfo: the Linux server box's, which Git Bash emulates on Windows
    # and macOS has no equivalent of (macOS port, phase 1).
    @unittest.skipIf(sys.platform == "darwin", "health.sh reads /proc, which macOS does not have")
    def test_the_health_line_has_its_shape_and_names_an_unsettled_backup(self):
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        os.makedirs(os.path.join(self.backups, stamp))
        open(os.path.join(self.backups, stamp, "simulated.db.unsettled"), "w").close()
        r = self._run("health.sh", self._env())
        lines = r.stdout.splitlines()
        self.assertEqual(len(lines), 1, r.stdout + r.stderr)
        self.assertRegex(lines[0], r"^HEALTH (ok|WARN [^|]+) \| up [\d.]+d \| disk \S+/\S+ \(\d+%\) \| mem avail \S+MB"
                                   r" \| services [0-4]/4 active \| ports [0-5]/5 listening \| db 5 @ \S+"
                                   r" \| backup " + stamp + r" \| stats OFFLINE$")
        self.assertIn("backup %s unsettled" % stamp, lines[0])
        self.assertIn("stats offline", lines[0])
        self.assertEqual(r.returncode, 1, "a WARN line exits 1")

    def test_a_database_that_never_settles_is_kept_but_fails(self):
        import threading
        db = os.path.join(self.server, "config", "simulated.db")
        stop = threading.Event()

        def churn():
            n = 0
            while not stop.is_set():
                n += 1
                try:
                    with open(db, "wb") as fh:
                        fh.write(str(n).encode() * 64)
                except OSError:
                    pass
                time.sleep(0.02)

        t = threading.Thread(target=churn)
        t.start()
        try:
            r = self._run("backup.sh", self._env("OPS_BACKUP_KEEP=3\nOPS_BACKUP_SETTLE_SEC=0.3\n"))
        finally:
            stop.set()
            t.join()
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("never settled", r.stderr)
        sets = os.listdir(self.backups)
        self.assertEqual(len(sets), 1, sets)
        self.assertIn("simulated.db.unsettled", os.listdir(os.path.join(self.backups, sets[0])))


if __name__ == "__main__":
    unittest.main()
