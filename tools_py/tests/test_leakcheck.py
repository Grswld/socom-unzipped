"""The gate over the tree, its history and its artefacts (Sprint 10 hardening; the design is Sprint 11 Goal 9).

A leak check that is only ever run against clean input proves nothing: it would pass just as happily with every
rule deleted. So most of this file plants a secret and asserts the gate finds it, names the right rule, and makes
the process exit non-zero. The clean cases come after.

The secrets here are invented. The shapes are the ones the monitor's rules were built against: an SSH
private key, a street address, an AWS account id, a Horizon access token, a home IP -- plus the Cloudflare Access
pair the Sprint 11 spec named as the monitor's gap.

The git modes run against a throwaway repository built in setUp, so they never depend on this repository's
history; two tests at the end run against THIS repository, because that is the thing being protected.
"""
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from tools_py.release import leakcheck as L
from tools_py.release import leakrules as R

USER = "Testowner"
EXTRA = "Chateau Griffondor"
PNG_HEAD = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 64

CLEAN = {
    "README.md": "run s9_g2_release_gate reached 3.143.65.100 (socom.scotho.com), harness dc6a625571d7\n",
    "data/runs.json": '{"runs": [{"name": "s9_g2", "sha256": "d6e30021aabb"}]}\n',
    "src/a.cpp": "const uint64_t token = postAndGetToken(std::move(cmd)); // 127.0.0.1:8775\n",
    "img/A_01_lobby.png": PNG_HEAD + b"\x00" * 200,
}

PLANTED = [
    ("owner-user-name", "built by Testowner on the PC"),
    ("owner-literal", "the place is called Chateau Griffondor"),
    ("home-directory-path", r"the disc is at C:\Users\craigs\iso\socom.iso"),
    ("home-directory-path", "the disc is at /c/Users/craigs/iso/socom.iso"),
    ("home-directory-path", "HOME=/home/craigs"),
    ("home-directory-path", '{"p": "C:\\\\Users\\\\craigs\\\\x"}'),
    ("ip-address", "home 86.21.44.190 reached"),
    ("street-address", "delivered to 12 Mulberry Lane, Reading"),
    ("street-address", "14 Rue Lafayette"),
    ("postcode", "posted to SW1A 2AA"),
    ("email", "mail some.person@somewhere-else.org for the key"),
    ("private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----"),
    ("private-key-block", "-----BEGIN RSA PRIVATE KEY-----"),
    ("ssh-public-key-body", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx me@box"),
    ("key-file-name", "ssh -i socom_linux.pem ubuntu@host"),
    ("key-file-name", "copied vm/keys/id_rsa to the box"),
    ("key-file-name", "source .env.production"),
    ("aws-account-id", "arn:aws:iam::123456789012:role/monitor"),
    ("vendor-token", "AKIAQ2W3E4R5T6Y7U8I9"),
    ("vendor-token", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
    ("vendor-token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"),
    ("vendor-token", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
    ("jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u"),
    ("cf-access-client-id", "CF-Access-Client-Id: 0123456789abcdef0123456789abcdef.access"),
    ("cf-access-client-secret", "CF-Access-Client-Secret: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    ("bearer-token", "Authorization: Bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ12345678"),
    ("secret-assignment", "accessToken=hunter2hunter2"),
    ("secret-assignment", 'password: "correct-horse-battery-9"'),
    ("secret-assignment", "HORIZON_API_KEY: abc123def456ghi789"),
    ("opaque-secret", "key Zk8Qw2ePlRt7YuIoAs3DfGhJkL9xCvBnMq4Zz here"),
]

# Lines the gate must NOT fire on, each the shape of something this tree is full of.
INNOCENT = [
    "harness=dc6a625571d778883146da3911413fe22a69a7f8",
    "sha256=d6e30021123456789012ababababababababababababababababababababab",
    "hosted 3.143.65.100 / socom.scotho.com, exit 65, 1.2.3.400, mpexit=0",
    "listening on 127.0.0.1:8775 and 0.0.0.0:10075",
    "img/run-s8_voice_open/A_03_name_and_more_here.png",
    "best=864.288313900726",
    "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>",
    r"C:\Users\<you>\socom.iso and %USERPROFILE%\x and /home/$USER/x and C:\Users\secretuser\iso",
    "password: <your password>  token=[redacted]  PS2X_SOCOM2_LOGIN_PASS=${PASS}",
    "Password = reader.ReadString(Constants.PASSWORD_MAXLEN);",
    "m_token = owner.m_nextToken++;",
    '$"Password:{Password}";',
    'MX_TOKEN="$MX/t.$(now).$$.$RANDOM$RANDOM"',
    'cp "$RTBUILD/ps2xRuntime/ps2EntryRunner.exe" "$ROOT/dist/socom2.exe"',
    '"FindExceptionHandler__FP12ThrowContextP13ExceptionInfoPl@0x00182C80",',
    "MediusWorldGenericFieldLevel1234 = (1 << 6),",
    '"integrity": "sha512-sB9y4ovltoQP+WaUPwmSxO9WIg9Ig694Di5PalVPsYHklAdE027mehpWF2SQSVq+k6sFgaivbTjTJwZLSHbedA=="',
    "        URL_HASH SHA256=6c9fcb0ef3136a1e5947319f8043ec60589da3a87e8044775f89b694d236e95c",
    "MW MIPS C Compiler 2.4.1.01",
    '<PackageReference Include="HighPrecisionTimeStamps" Version="1.0.0.6" />',
    "ssh -i vm/keys/socom_linux -p 2222 socom@127.0.0.1 'ls'",
    "text #C9D6D2, panel #12262A",
    "budget 82s exceeded at wp16 close=None",
    "id_ed25519.pub is the public half",
    "the mission ambience is a CONDUCTOR sound (M51_AM 0x31)",
]


def _rules():
    return (R.text_rules(users=[USER], extras=[EXTRA]), R.binary_rules(users=[USER], extras=[EXTRA]),
            R.name_rules(users=[USER], extras=[EXTRA]))


def _fired(line):
    return {rule for rule, fn in R.text_rules(users=[USER], extras=[EXTRA]) if fn(line)}


class PlantedSecretsAreCaught(unittest.TestCase):
    def test_every_planted_secret_trips_its_rule(self):
        for rule, body in PLANTED:
            with self.subTest(rule=rule, body=body):
                self.assertIn(rule, _fired(body), f"{rule} missed in {body!r}; fired {_fired(body)}")

    def test_the_tree_s_own_shapes_do_not_fire(self):
        for line in INNOCENT:
            with self.subTest(line=line):
                self.assertEqual(_fired(line), set(), line)

    def test_a_private_ip_fires_only_on_an_artifact(self):
        line = "client 192.168.1.50 joined"
        self.assertNotIn("private-ip", _fired(line))
        art = {r for r, fn in R.text_rules(users=[USER], extras=[EXTRA], surface="artifact") if fn(line)}
        self.assertIn("private-ip", art)

    def test_a_key_shaped_file_name_is_caught_by_path(self):
        nrules = R.name_rules(users=[USER], extras=[EXTRA])
        for name in ("vm/keys/id_ed25519", "deploy/.secrets/socom_linux.pem", "server/.env.production",
                     "site/credentials.json", "a/b/server.key", "Testowner_desktop.png", "x/.npmrc"):
            with self.subTest(name=name):
                self.assertTrue(any(fn(name) for _, fn in nrules), name)
        for name in ("vm/keys/id_ed25519.pub", "scripts/parity/ref_title.png", "docs/KNOWN.md", "keys.md"):
            with self.subTest(name=name):
                self.assertFalse(any(fn(name) for _, fn in nrules), name)

    def test_the_self_test_passes_and_counts(self):
        st = L.self_test()
        self.assertEqual(st["missed"], [])
        self.assertEqual(st["caught"], st["planted"])
        self.assertGreater(st["planted"], 20)

    def test_the_self_test_controls_the_product_word_exception_in_both_directions(self):
        """Review I4. self_test() builds its rules with an explicit `users=[PLANTED_USER]`, so it never
        went through owner_names() and never through drop_product_words. A regression that made
        is_product_word return True for everything -- switching owner-user-name off on every machine in
        the project -- would still have printed "0 hits -- clean ... self-test 28/28" from the
        pre-commit hook. The control has to exercise the exception, not just the rules it feeds."""
        base = L.self_test()
        self.assertEqual(base["missed"], [])

        with mock.patch.object(R, "is_product_word", lambda name: True):
            broken = L.self_test()
        self.assertTrue(broken["missed"], "the exception swallowing every user name is not caught")
        self.assertLess(broken["caught"], broken["planted"])

        with mock.patch.object(R, "is_product_word", lambda name: False):
            asleep = L.self_test()
        self.assertTrue(asleep["missed"], "the exception never firing at all is not caught")

    def test_a_machine_user_named_after_the_product_is_not_a_secret(self):
        """The socom-linux VM's account is `socom`, so on 2026-09-22 the owner-user-name rule matched the
        product's own name and README.md:1 -- "# SOCOM Unzipped" -- became a leak. A user name that is part
        of what the project calls itself is not a secret; anything else still is."""
        with mock.patch.dict(os.environ, {"USERNAME": "socom", "USER": "socom", "LOGNAME": "socom"}, clear=False), \
                mock.patch.object(R.os.path, "expanduser", lambda p: "/home/socom"):
            names = R.owner_names()
        self.assertEqual(names, set(), "the product's own name is not this machine's secret")

        with mock.patch.dict(os.environ, {"USERNAME": "craigs", "USER": "craigs", "LOGNAME": "craigs"}, clear=False), \
                mock.patch.object(R.os.path, "expanduser", lambda p: "/home/craigs"):
            self.assertEqual(R.owner_names(), {"craigs"})

    def test_the_product_s_own_words_are_the_only_ones_dropped(self):
        for name in ("socom", "SOCOM", "Socom", "unzipped", "socom_pc", "socom-pc", "socompc", "Ps2x",
                     "ps2recomp"):
            with self.subTest(name=name):
                self.assertTrue(R.is_product_word(name), name)
        for name in ("craigs", "socomx7", "seal", "navy"):
            with self.subTest(name=name):
                self.assertFalse(R.is_product_word(name), name)

    def test_a_fragment_of_a_product_word_is_not_a_product_word(self):
        """Review I3. The test was `name in word`, so any user name that happened to be a SUBSTRING of a
        product word had the whole owner-user-name rule switched off for them, everywhere, with one
        stderr line as the only trace. `owner_names()` admits anything three characters or longer, which
        leaves a lot of them: a machine user called `zip`, `ps2`, `comp` or `oco` was exempt."""
        for name in ("zip", "ps2", "comp", "oco", "unzip", "reco", "som", "p_p"):
            with self.subTest(name=name):
                self.assertFalse(R.is_product_word(name), "%r is a fragment, not the product's name" % name)

    def test_the_exception_does_not_depend_on_where_the_clone_sits(self):
        """Review I3, second half. The checkout's own directory name was in PRODUCT_WORDS, so which user
        names the gate exempted differed between C:\\projects\\socom_pc and C:\\projects\\wt-linuxring --
        the leak gate's behaviour changed with the clone path. In this worktree that made `linux` and
        `ring` exempt."""
        for name in ("linux", "ring", "linuxring", "projects"):
            with self.subTest(name=name):
                self.assertFalse(R.is_product_word(name), name)
        # The list is written out, never derived: a worktree's name is not in it, and no token is a path.
        # (The repository's own name IS a product word -- a clone called socom_pc must not fail this.)
        for name in ("wt-linuxring", "wt", "socom_pc_web", "projects"):
            self.assertNotIn(name, {w.lower() for w in R.PRODUCT_TOKENS}, name)
        self.assertFalse(any(os.sep in w or "/" in w for w in R.PRODUCT_TOKENS), "a token is a path")

    def test_a_user_named_socom_leaves_the_readme_alone(self):
        """End to end: the rules built for that machine, over the line that fired."""
        line = "# SOCOM Unzipped"
        self.assertNotIn("owner-user-name",
                         {r for r, fn in R.text_rules(users=R.drop_product_words(["socom"])) if fn(line)})
        self.assertIn("owner-user-name",
                      {r for r, fn in R.text_rules(users=R.drop_product_words(["craigs"]))
                       if fn("built by craigs")})

    def test_the_mask_never_shows_the_middle(self):
        self.assertEqual(R.mask("AKIAQ2W3E4R5T6Y7U8I9"), "AKIA...I9 (20 chars)")
        self.assertEqual(R.mask("short"), "sh...")
        h = L.Hit("a.txt", 3, "vendor-token", "AKIAQ2W3E4R5T6Y7U8I9", "x")
        self.assertNotIn("Q2W3E4R5", h.render())
        self.assertNotIn("Q2W3E4R5", json.dumps(h.as_json()))
        self.assertIn("Q2W3E4R5", h.render(reveal=True))


class TreeScans(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="leak_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, files):
        for rel, body in files.items():
            p = os.path.join(self.tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(body if isinstance(body, bytes) else body.encode("utf-8"))
        return self.tmp

    def test_a_clean_directory_passes(self):
        hits, stats = L.check_dir(self.write(CLEAN), _rules(), allow=[])
        self.assertEqual([h.render(True) for h in hits], [])
        self.assertEqual((stats["files"], stats["text_files"], stats["binary_files"]), (4, 3, 1))

    def test_a_planted_secret_names_the_file_and_line(self):
        root = self.write(dict(CLEAN, **{"docs/x.md": "ok\nok\n-----BEGIN RSA PRIVATE KEY-----\n"}))
        hits, _ = L.check_dir(root, _rules(), allow=[])
        self.assertEqual([(h.path, h.line, h.rule) for h in hits], [("docs/x.md", 3, "private-key-block")])

    def test_a_secret_inside_a_png_is_caught(self):
        blob = PNG_HEAD + b"tEXtComment\x00C:\\Users\\craigs\\shot.png" + b"\x00" * 32
        root = self.write(dict(CLEAN, **{"img/shot.png": blob}))
        hits, _ = L.check_dir(root, _rules(), allow=[])
        self.assertEqual({h.rule for h in hits}, {"home-directory-path"})
        self.assertEqual(hits[0].context, "binary")

    def test_a_secret_in_a_file_name_is_caught(self):
        root = self.write(dict(CLEAN, **{"img/Testowner_desktop.png": PNG_HEAD, "keys/id_rsa": "x"}))
        hits, _ = L.check_dir(root, _rules(), allow=[])
        self.assertEqual({(h.path, h.rule) for h in hits},
                         {("img/Testowner_desktop.png", "owner-user-name"), ("keys/id_rsa", "key-file-name")})
        self.assertTrue(all("(file name)" in h.render() for h in hits))

    def test_a_long_line_is_scanned_in_pieces_not_skipped(self):
        body = "x" * (L.MAX_LINE * 2) + " AKIAQ2W3E4R5T6Y7U8I9 " + "y" * 100 + "\n"
        root = self.write(dict(CLEAN, **{"big.txt": body}))
        hits, _ = L.check_dir(root, _rules(), allow=[])
        self.assertEqual([(h.path, h.line, h.rule) for h in hits], [("big.txt", 1, "vendor-token")])

    def test_the_allow_list_needs_rule_path_and_literal_to_agree(self):
        root = self.write(dict(CLEAN, **{"server/config/db.config.json": '{"DatabasePassword": "horizon1"}\n'}))
        hit = L.check_dir(root, _rules(), allow=[])[0][0]
        self.assertEqual(hit.rule, "secret-assignment")
        self.assertTrue(L.allowed(hit, [("secret-assignment", "server/config/db.config.json", "horizon1", "dev")]))
        self.assertTrue(L.allowed(hit, [("secret-assignment", "server/config/*", "", "dev")]))
        self.assertTrue(L.allowed(hit, [("*", "server/config", "", "dev")]))
        self.assertFalse(L.allowed(hit, [("secret-assignment", "server/config/db.config.json", "other", "dev")]))
        self.assertFalse(L.allowed(hit, [("secret-assignment", "docs/*", "", "dev")]))
        self.assertFalse(L.allowed(hit, [("vendor-token", "server/config/db.config.json", "", "dev")]))

    def test_a_malformed_allow_line_is_an_error_not_a_silent_skip(self):
        p = os.path.join(self.tmp, "allow.txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write("# fine\nsecret-assignment  # no glob\n")
        with self.assertRaises(ValueError):
            L.load_allow(p)
        with open(p, "w", encoding="utf-8") as f:
            f.write('street-address  docs/*  "37 Route A"   # research/37, option A\n')
        self.assertEqual(L.load_allow(p), [("street-address", "docs/*", "37 Route A", "research/37, option A")])

    def test_main_exit_codes_and_json(self):
        clean = self.write(CLEAN)
        out = os.path.join(self.tmp, "r.json")
        self.assertEqual(L.main(["artifact", clean, "--allow", os.devnull, "--json", out]), 0)
        with open(out, encoding="utf-8") as f:
            rep = json.load(f)
        self.assertEqual((rep["exit"], rep["findings"]), (0, []))
        self.assertEqual(rep["self_test"]["caught"], rep["self_test"]["planted"])
        dirty = os.path.join(self.tmp, "d")
        os.makedirs(dirty)
        with open(os.path.join(dirty, "log.txt"), "w") as f:
            f.write("client 192.168.1.50 joined\nAKIAQ2W3E4R5T6Y7U8I9\n")
        err = io.StringIO()
        import contextlib
        with contextlib.redirect_stderr(err):
            self.assertEqual(L.main(["artifact", dirty, "--allow", os.devnull, "--json", out]), 1)
        text = err.getvalue()
        self.assertIn("log.txt:1: private-ip:", text)
        self.assertIn("log.txt:2: vendor-token:", text)
        self.assertNotIn("Q2W3E4R5", text)
        with open(out, encoding="utf-8") as f:
            rep = json.load(f)
        self.assertEqual(rep["exit"], 1)
        self.assertNotIn("Q2W3E4R5", json.dumps(rep))
        self.assertEqual({f["severity"] for f in rep["findings"]}, {"low", "critical"})
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(L.main(["artifact", os.path.join(self.tmp, "nowhere"), "--allow", os.devnull]), 2)


def _git(cwd, *args, **kw):
    return subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True, check=True, **kw).stdout


class GitModes(unittest.TestCase):
    """A throwaway repository: two commits, an ignore file, a forced add."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="leakgit_")
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.name", "Test Person")
        _git(self.repo, "config", "user.email", "test@example.com")
        _git(self.repo, "config", "commit.gpgsign", "false")
        self.write(".gitignore", "/vm/\n/logs/\n*.pem\n")
        self.write("README.md", "clean\n")
        _git(self.repo, "add", ".gitignore", "README.md")
        _git(self.repo, "commit", "-q", "-m", "one")

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def write(self, rel, body):
        p = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)

    def test_tree_reads_tracked_files_only(self):
        self.write("notes.md", "AKIAQ2W3E4R5T6Y7U8I9\n")            # untracked: not going anywhere
        self.write("README.md", "clean\nAKIAQ2W3E4R5T6Y7U8I9\n")    # tracked, modified in the tree
        hits, _ = L.check_tree(self.repo, _rules(), allow=[])
        self.assertEqual([(h.path, h.line, h.rule) for h in hits], [("README.md", 2, "vendor-token")])

    def test_staged_reads_the_index_not_the_tree_and_sees_a_forced_add(self):
        self.write("a.txt", "AKIAQ2W3E4R5T6Y7U8I9\n")
        _git(self.repo, "add", "a.txt")
        self.write("a.txt", "clean now\n")                          # the tree is clean, the index is not
        self.write("vm/keys/thing.pem", "-----BEGIN RSA PRIVATE KEY-----\n")
        _git(self.repo, "add", "-f", "vm/keys/thing.pem")
        hits, _ = L.check_staged(self.repo, _rules(), allow=[])
        got = {(h.path, h.rule) for h in hits}
        self.assertIn(("a.txt", "vendor-token"), got)
        self.assertIn(("vm/keys/thing.pem", "forced-ignored-file"), got)
        self.assertIn(("vm/keys/thing.pem", "key-file-name"), got)
        self.assertIn(("vm/keys/thing.pem", "private-key-block"), got)

    def test_the_real_gitignore_refuses_the_never_commit_shapes(self):
        """Sprint 14 S4: docs/GIT_STRATEGY.md section 3's never-commit list says the leak hooks refuse every
        entry; a forced add of each shape under this repository's own .gitignore must be forced-ignored."""
        shutil.copyfile(os.path.join(L.ROOT, ".gitignore"), os.path.join(self.repo, ".gitignore"))
        planted = ("out.wav", "out.bin", "build-clang/x", "build-linux/x", "dist-foo/x", "game.iso", "disc.7z",
                   "out/x", "server/ops/pulled/x", "server/horizon-docker/x")
        for rel in planted:
            self.write(rel, "x\n")
            _git(self.repo, "add", "-f", rel)
        hits, _ = L.check_staged(self.repo, _rules(), allow=[])
        forced = {h.path for h in hits if h.rule == "forced-ignored-file"}
        self.assertEqual(sorted(set(planted) - forced), [], "staged over the .gitignore and not refused")
        for rel in ("build.sh", "tests/fixtures/audio/a.bin", "scripts/parity/refs/a.wav"):
            p = subprocess.run(["git", "check-ignore", "--no-index", "-q", "--", rel], cwd=self.repo)
            self.assertNotEqual(p.returncode, 0, "%s is a tracked shape and must not be ignored" % rel)

    def test_ignored_proves_ignored_untracked_and_never_committed(self):
        hits, _ = L.check_ignored(self.repo, paths=("vm/", "logs/", "secrets/"), allow=[])
        self.assertEqual({(h.path, h.rule) for h in hits}, {("secrets/", "ignored-path-not-ignored")})
        self.write("logs/run.log", "x\n")
        _git(self.repo, "add", "-f", "logs/run.log")
        _git(self.repo, "commit", "-q", "-m", "oops")
        hits, _ = L.check_ignored(self.repo, paths=("vm/", "logs/"), allow=[])
        self.assertEqual({(h.path, h.rule) for h in hits},
                         {("logs/", "ignored-path-tracked"), ("logs/", "ignored-path-in-history")})
        _git(self.repo, "rm", "-q", "--cached", "logs/run.log")
        _git(self.repo, "commit", "-q", "-m", "untracked again")
        hits, _ = L.check_ignored(self.repo, paths=("vm/", "logs/"), allow=[])
        self.assertEqual({(h.path, h.rule) for h in hits}, {("logs/", "ignored-path-in-history")})

    def test_history_finds_a_secret_that_was_added_and_removed(self):
        self.write("cfg.txt", "token=abc123def456ghi789\n")
        _git(self.repo, "add", "cfg.txt")
        _git(self.repo, "commit", "-q", "-m", "two")
        self.write("cfg.txt", "token=[redacted]\n")
        _git(self.repo, "commit", "-q", "-am", "three")
        tree_hits, _ = L.check_tree(self.repo, _rules(), allow=[])
        self.assertEqual(tree_hits, [])
        hist, stats = L.check_history(self.repo, rules=_rules(), allow=[])
        self.assertEqual([(h.path, h.line, h.rule) for h in hist], [("cfg.txt", 1, "secret-assignment")])
        self.assertEqual(stats["commits"], 3)
        ranged, _ = L.check_history(self.repo, revs=["HEAD~1..HEAD"], rules=_rules(), allow=[])
        self.assertEqual(ranged, [])

    def test_history_checks_the_names_of_added_files(self):
        self.write("deploy/server.pem", "not a key, but the name is\n")
        _git(self.repo, "add", "-f", "deploy/server.pem")
        _git(self.repo, "commit", "-q", "-m", "named")
        hist, _ = L.check_history(self.repo, rules=_rules(), allow=[])
        self.assertIn(("deploy/server.pem", "key-file-name"), {(h.path, h.rule) for h in hist})

    def test_metadata_lists_every_identity_until_allowed(self):
        hits, stats = L.check_metadata(self.repo, allow=[])
        self.assertEqual({(h.rule, h.text) for h in hits},
                         {("commit-author", "Test Person <test@example.com>"),
                          ("commit-committer", "Test Person <test@example.com>")})
        allow = [("commit-author", "<git metadata>", "Test Person <test@example.com>", "ok"),
                 ("commit-committer", "<git metadata>", "Test Person <test@example.com>", "ok")]
        self.assertEqual(L.check_metadata(self.repo, allow=allow)[0], [])

    def test_a_shallow_clone_cannot_pass_the_history_modes(self):
        self.write("b.txt", "b\n")
        _git(self.repo, "add", "b.txt")
        _git(self.repo, "commit", "-q", "-m", "two")
        shallow = tempfile.mkdtemp(prefix="leakshallow_")
        try:
            _git(shallow, "clone", "-q", "--depth", "1", "file://" + self.repo.replace("\\", "/"), "c")
            clone = os.path.join(shallow, "c")
            with self.assertRaises(L.ScanNotRun):
                L.check_history(clone, rules=_rules(), allow=[])
            with self.assertRaises(L.ScanNotRun):
                L.check_ignored(clone, paths=("vm/",), allow=[])
            # main turns it into exit 2, never 0
            import contextlib
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(L.main(["history", "--repo", clone, "--allow", os.devnull]), 2)
        finally:
            shutil.rmtree(shallow, ignore_errors=True)


class ThisRepository(unittest.TestCase):
    """The thing being protected. Skipped, not passed, where the check cannot run (a shallow CI checkout)."""

    def test_the_sensitive_paths_are_ignored_untracked_and_never_committed(self):
        if L.is_shallow(L.ROOT):
            self.skipTest("shallow clone: the history half cannot be proven here")
        hits, _ = L.check_ignored(L.ROOT)
        self.assertEqual([h.render(True) for h in hits], [])

    def test_the_landing_sites_game_derived_inputs_are_in_the_proof(self):
        # web/.gitignore lists them under the landing's "Build inputs" (web/landing/README.md): the HUD sounds, the
        # game-showing images, the owner's artwork and the home/story goldens. The gate re-proves only what this
        # constant names, so a later .gitignore edit that un-ignored one would pass unseen (launch review, site
        # minor). File samples for the goldens: e2e/goldens/gallery-* is tracked on purpose.
        for path in ("web/landing/public/media/", "web/landing/public/sfx/", "web/landing/public/img/intel.jpg",
                     "web/landing/public/img/share.jpg", "web/landing/art/", "web/landing/e2e/goldens/home-x.png",
                     "web/landing/e2e/goldens/story-x.png"):
            with self.subTest(path=path):
                self.assertIn(path, L.SENSITIVE_IGNORED)

    def test_nothing_key_shaped_is_tracked(self):
        bad = [rel for rel in L.tracked_files(L.ROOT) if R.KEYNAME_PATH_RE.search(rel)]
        self.assertEqual(bad, [])

    def test_the_allow_list_parses_and_every_row_has_a_reason(self):
        rows = L.load_allow()
        self.assertGreater(len(rows), 3)
        for rule, glob, lit, reason in rows:
            with self.subTest(rule=rule, glob=glob):
                self.assertTrue(reason, f"{rule} {glob} {lit}: no reason")
                self.assertIn(rule, set(R.SEVERITY) | {"*"})

    def test_the_tracked_tree_is_clean(self):
        hits, stats = L.check_tree(L.ROOT)
        self.assertGreater(stats["files"], 1000)
        self.assertEqual([h.render() for h in hits], [])


if __name__ == "__main__":
    unittest.main()
