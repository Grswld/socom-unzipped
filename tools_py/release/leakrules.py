"""The shapes a leak takes, as regular expressions -- one set, shared by every mode of `leakcheck`.

Vendored from the monitor (`../socom_monitor/scrub.py` and `leakcheck.py`, commit `920e323`), where they were
built against real shapes -- an SSH private key, a street address, an AWS account id, a Horizon access
token, a home IP -- and burned in against two false positives that only a run
over real data found (a thoroughfare word under `re.I`; a float's fraction read as an account id). The Sprint
11 spec (Goal 9) says: do not invent a third set. Two additions the spec named as a gap in the monitor's copy:
the Cloudflare Access service-token pair (the site's `secret-scan.mjs` had them first).

Everything here is a *detection* rule; there is no scrubber in this repository. The rules are grouped by the
surface they run on: a line of a text file, the bytes of a binary, a file's path, a commit's metadata.

Owner-specific literals (a street address, an old account name) never go in this file: they are read from a
git-ignored `leak_extra.txt` beside it, because committing a secret in order to catch it defeats the exercise.
"""
import os
import re
import sys

# The one address that is public by nature: the project's Lightsail box, and its name.
HOSTED_IPS = {"3.143.65.100"}
HOSTED_NAMES = {"socom.scotho.com", "socomunzipped.com", "s2u.scotho.com"}

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRA_FILE = os.path.join(HERE, "leak_extra.txt")

# --------------------------------------------------------------------------------------------
# this machine's filesystem

# A home directory in the Windows, the MSYS and the Unix spelling. A source tree legitimately names paths
# under the repository, so a bare drive-absolute path is NOT a rule here (it was in the monitor, whose output
# is a snapshot and has no business naming any path); the home directory is, because it carries the user name.
# `[\\/]{1,2}` because a path inside a JSON string arrives with its backslashes doubled.
HOME_DIR_RE = re.compile(r"(?i)(?<![\w])(?:[a-z]:[\\/]{1,2}users[\\/]{1,2}|/[a-z]/users/|/home/)"
                         r"(?!\$|%|\{|<|\[|\*|[\\/]|\s)([^\\/\s\"'<>|]+)")
# What a home-directory match may legitimately name: a placeholder, or an account that is nobody's.
HOME_DIR_OK = {"user", "users", "username", "you", "yourname", "name", "runner", "root", "ubuntu",
               "public", "default", "all users", "owner", "me", "someone", "somebody", "player", "bob",
               "alice", "x", "u", "xxx", "example", "your-name", "your_name", "the-owner", "linuxbrew",
               "secretuser", "socom", "testowner", "someuser", "anyone", "contributor",
               # the localised default account names -- as generic as "User", and this machine's is one of them
               "utilisateur", "usuario", "benutzer", "utente", "gebruiker", "usuário"}

# --------------------------------------------------------------------------------------------
# addresses, network and postal

# IPv4. The boundaries stop it matching inside a longer dotted run or inside a word.
IPV4_RE = re.compile(r"(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)(?![A-Za-z])")
PRIVATE_IP_RE = re.compile(
    r"(?<![\w.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|169\.254\.\d{1,3}\.\d{1,3})(?!\.?\d)(?![A-Za-z])")
# Addresses that are nobody's: loopback, unspecified, broadcast, documentation ranges (RFC 5737), multicast.
NOBODYS_IP_RE = re.compile(r"^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\."
                           r"|2(?:2[4-9]|3\d)\.|255\.|0\.|1\.2\.3\.4$)")   # 1.2.3.4: every test's example address

# A street address: a number, one to four CAPITALISED words, a thoroughfare word.
#
# The capitals are load-bearing and the whole pattern is deliberately case-sensitive. Compiled with re.I this
# rule ate `budget 82s exceeded at wp16 close=None` out of a real drive log -- under re.I, `[A-Z]` matches
# lower case, four lower-case words pass, and `close` is a thoroughfare word. Only the street word itself is
# case-folded, with an inline group.
STREET_WORDS = (r"(?i:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|circle|cir|"
                r"way|place|pl|terrace|ter|trail|trl|parkway|pkwy|highway|hwy|route|rte|square|sq|"
                r"crescent|cres|close|grove|gardens|gdns|rue|chemin|allee|impasse)")
ADDRESS_RE = re.compile(
    # English order: 221B Baker Street. French/Spanish order: 14 Rue Lafayette, 3 Chemin des Vignes.
    r"(?<![\w-])\d{1,6}[A-Za-z]?(?:[ \t]+(?:[A-Z][\w'.-]*|\d+(?:st|nd|rd|th)))"
    r"{1,4}[ \t]+" + STREET_WORDS + r"\b\.?"
    r"|(?<![\w-])\d{1,6}[A-Za-z]?[ \t]+" + STREET_WORDS + r"\b(?:[ \t]+[A-Z][\w'.-]*){1,4}")
# A UK/CA-style postcode and a US ZIP+4 are address-shaped on their own.
POSTCODE_RE = re.compile(r"(?<![\w#-])(?:[A-Z]{1,2}\d[A-Z\d]?[ ]?\d[A-Z]{2}"
                         r"|[A-Z]\d[A-Z][ ]?\d[A-Z]\d"
                         r"|\d{5}-\d{4})(?![\w-])")

EMAIL_RE = re.compile(r"(?<![\w.])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w.])")
# Addresses that are nobody's, or are deliberately public: the co-author trailer, RFC 2606 domains, the
# project's own domain (SECURITY.md names a contact there on purpose).
EMAIL_OK_RE = re.compile(r"(?i)(?:@(?:example\.(?:com|org|net)|scotho\.com|users\.noreply\.github\.com)$"
                         r"|\.(?:example|test|invalid|localhost)$"
                         r"|^noreply@anthropic\.com$|^noreply@github\.com$)")

# --------------------------------------------------------------------------------------------
# credentials

# An AWS account id is twelve digits. The alnum boundaries matter: a 64-character sha256 contains a
# twelve-digit run about once every forty hashes, and flagging those would make the gate useless.
ACCOUNT_ID_RE = re.compile(r"(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])")


def account_matches(text):
    """ACCOUNT_ID_RE, minus the fraction of a decimal number. Found on real data: the drive logs are full of
    `best=864.288313900726`, and a rule that calls that an AWS account id fails every build."""
    for m in ACCOUNT_ID_RE.finditer(text):
        i = m.start()
        if i >= 2 and text[i - 1] == "." and text[i - 2].isdigit():
            continue
        yield m


PEM_MARKER_RE = re.compile(r"BEGIN[ A-Z]*PRIVATE KEY")
SSH_PUBKEY_BODY_RE = re.compile(r"\bssh-(?:rsa|ed25519|dss|ecdsa-sha2-nistp256) AAAA[0-9A-Za-z+/]{40,}")

# Key material by name: the SSH key names, PEM/PPK files, dotenv files.
KEYNAME_TEXT_RE = re.compile(r"(?i)(?<![\w-])(id_(?:rsa|dsa|ecdsa|ed25519)(?![\w.-]*\.pub)[\w.-]*"
                             r"|[\w.-]+\.(?:pem|ppk)|\.env(?:\.[\w-]+)?)(?![\w-])")
# The same shapes, anchored, for a tracked file's own path -- plus `.key` and the keystore formats, which are
# too common as words to grep for in prose but unambiguous as a file extension.
KEYNAME_PATH_RE = re.compile(r"(?i)(^|/)(id_(?:rsa|dsa|ecdsa|ed25519)(?![\w.-]*\.pub)[\w.-]*"
                             r"|[^/]*\.(?:pem|ppk|key|p12|pfx|jks|keystore|kdbx)"
                             r"|\.env(?:\.[\w-]+)?|[^/]*\.secret|[^/]*_secret\.[\w]+|credentials(?:\.json)?"
                             r"|\.netrc|\.pgpass|\.npmrc|\.pypirc|kube_?config|\.htpasswd|known_hosts)$")

# Secrets by assignment, by vendor prefix, by JWT shape, and by opacity.
# The lazy prefix is what makes `accessToken=` and `HORIZON_API_KEY:` match as well as bare `token=`; without
# it the word boundary sits in the wrong place in every camelCase and every SCREAMING_SNAKE key.
ASSIGN_RE = re.compile(
    r"(?i)(?<![\w])([\w-]{0,24}?(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key"
    r"|secret[_-]?key|private[_-]?key|auth|bearer|session[_-]?id|credential|login[_-]?pass)s?)[\"']?\s*[:=]\s*"
    r"([\"']?)([^\s\"',;]{6,})")
VENDOR_RE = re.compile(r"(?<![\w])(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AGPA[0-9A-Z]{16}|AIDA[0-9A-Z]{16}"
                       r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
                       r"|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}"
                       r"|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})")
JWT_RE = re.compile(r"(?<![\w])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
# A Cloudflare Access service token: the client id carries `.access` and is distinctive; the secret is a long
# hex run, so it is only a finding NEXT TO its own header name -- a bare 64-hex run is usually a sha256 sum.
CF_ACCESS_ID_RE = re.compile(r"(?i)\b[0-9a-f]{32}\.access(?:\.[A-Za-z0-9._-]+)?")
CF_ACCESS_SECRET_RE = re.compile(r"(?i)CF[-_]?Access[-_]?Client[-_]?Secret\s*[:=]?\s*[\"']?[0-9A-Za-z_-]{30,}")
BEARER_RE = re.compile(r"\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}=*")
# An opaque blob. The candidate is any long run of token characters; `opaque_hit` decides. Lower-case hex
# (every sha256 and harness id in this project) has no upper-case letter and is left alone, and so is
# anything separator-heavy -- `img/run-s8_voice_open/A_03_name` is a path, not a secret, and a rule that
# flags it is a rule someone turns off.
OPAQUE_RE = re.compile(r"(?<![\w+/=-])[A-Za-z0-9+/=_-]{32,}(?![\w+/=-])")


def opaque_hit(s):
    """Does this long token look like key material rather than a name, a path or a hash?

    Key material mixes its cases and scatters its digits; a mangled C++ name (`FindExceptionHandler__FP12Throw`),
    a build path (`RTBUILD/ps2xRuntime/ps2EntryRunner`) and a NuGet id do not. So: both cases, at least three
    separate digit runs, no path separator, no `__`, and at most two of `_-`."""
    if re.match(r"(?i)sha\d{3}[-=]", s):
        return False                                  # an integrity hash: `sha512-...` (package-lock.json), `SHA256=...` (CMake URL_HASH)
    return (any(c.islower() for c in s) and any(c.isupper() for c in s)
            and len(re.findall(r"\d+", s)) >= 3
            and "/" not in s and "__" not in s
            and sum(c in "_-" for c in s) <= 2)


def opaque_matches(text):
    for m in OPAQUE_RE.finditer(text):
        if opaque_hit(m.group(0)):
            yield m


# Values an assignment rule must not call a secret: placeholders, the redaction markers, and the
# repository's own well-known dev defaults (named per file in leak_allow.txt, not here).
ASSIGN_VALUE_OK_RE = re.compile(r"(?i)^(?:\[?(?:redacted|masked|removed|private key removed|your[-_ ]?\w*"
                                r"|changeme|change[-_]me|xxx+|\.\.\.|none|null|nil|empty|unset|placeholder)\]?"
                                r"|<[^>]*>|\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Z_]+%|\{\{[^}]*\}\}|\*{4,}|x{6,}"
                                r"|\$\([^)]*\)|\$\w+|[\^~<>=]*\d+(?:\.\d+)+[-+\w.]*)$")   # a version or a range


# A bare (unquoted) value counts only when it is shaped like a token: one run of token characters with a digit
# in it. `reader.ReadString(...)`, `m_nextToken++`, `Utils.ComputeSHA256(x)` and `${PASS}` are expressions --
# source code assigns to variables named `token` all day, and a rule that flags those is a rule someone turns off.
BARE_VALUE_RE = re.compile(r"^(?=.*\d)[A-Za-z0-9+/=_.-]{8,}$")


def assign_matches(text):
    for m in ASSIGN_RE.finditer(text):
        quote, value = m.group(2), m.group(3)
        value = value.rstrip(")]}>\"'`")
        if ASSIGN_VALUE_OK_RE.match(value) or ASSIGN_VALUE_OK_RE.match(m.group(3)):
            continue
        if not quote and not BARE_VALUE_RE.match(value):
            continue
        if quote and ("{" in value or value.startswith("$") or value.startswith("%")):
            continue                                        # an interpolation: $"Password:{Password}", "$MX/t"
        yield m


# --------------------------------------------------------------------------------------------
# who this machine belongs to

# What the project calls itself. A machine user named after the product is not a secret: the socom-linux
# VM's account is `socom`, and on 2026-09-22 the owner-user-name rule -- built from whoami -- turned
# README.md:1, "# SOCOM Unzipped", into a finding and refused the tree. Nothing else changes: a real
# account name is still hunted everywhere, and the home-directory rule (which has always allowed "socom")
# is untouched.
#
# The match is over WHOLE NAMES, not substrings, and the list is fixed (review I3). Both halves were
# wrong before: `name in word` exempted any user called `zip`, `ps2`, `comp` or `oco` -- owner_names()
# admits anything three characters or longer -- and the list ended with the checkout's own directory
# name, so which users the gate exempted differed between C:\projects\socom_pc and a worktree. Switching
# a leak rule off for somebody is not something a clone path gets to decide.
# The list is spelled out in full rather than derived by splitting the names on separators: splitting
# "ps2 recomp" hands back "ps2", which is a three-character fragment that owner_names() would accept, and
# that is the very trap this finding is about. Every spelling that should be exempt is written here.
PRODUCT_TOKENS = frozenset((
    "socom", "unzipped", "socom unzipped", "socomunzipped",
    "socom_pc", "socom-pc", "socompc", "socom pc",
    "ps2x", "ps2recomp",
))
_DROPPED = set()          # so the note below is one line per name per process, not one per rule build


def is_product_word(name):
    """True when `name` IS one of the product's own names, case-insensitively -- not a fragment of one."""
    low = (name or "").strip().lower()
    return bool(low) and low in PRODUCT_TOKENS


def drop_product_words(names, log=True):
    """Candidate user names, minus the ones that are only the product's own name -- with a line saying so.

    `log=False` for a caller that is probing the rule rather than using it (leakcheck.self_test runs on
    every commit through the pre-commit hook; its two control names are not this machine's user, and a
    line about them on every commit would be noise that teaches people to ignore the real one)."""
    kept = set()
    for name in names:
        if is_product_word(name):
            if log and name.lower() not in _DROPPED:
                _DROPPED.add(name.lower())
                print("leakcheck: this machine's user is %r, which is part of the project's own name -- "
                      "not hunted as a secret (it would fire on every line that says SOCOM Unzipped)."
                      % name, file=sys.stderr)
            continue
        kept.add(name)
    return kept


def owner_names():
    """Every spelling of this machine's user that must not reach the tree."""
    out = set()
    for cand in (os.path.basename(os.path.expanduser("~")), os.environ.get("USERNAME"),
                 os.environ.get("USER"), os.environ.get("LOGNAME")):
        if cand and len(cand) >= 3 and cand.lower() not in ("user", "users", "root", "home", "runner",
                                                              "ubuntu", "utilisateur", "usuario", "benutzer"):
            out.add(cand)
    return drop_product_words(out)


def extra_literals(path=EXTRA_FILE):
    """Owner-specific literals from a git-ignored file: one per line, `#` comments, blanks skipped."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    out = [line.strip() for line in lines]
    return sorted({line for line in out if line and not line.startswith("#") and len(line) >= 4},
                  key=len, reverse=True)


# --------------------------------------------------------------------------------------------
# the rule tables

def _first(rx):
    def run(s):
        m = rx.search(s)
        return m.group(0) if m else None
    return run


def _home_dir_rule():
    def run(s):
        for m in HOME_DIR_RE.finditer(s):
            who = re.sub(r"~\d+$", "", m.group(1).lower().rstrip(".,;:`'\")"))   # BOB~1 is bob
            if who not in HOME_DIR_OK:
                return m.group(0)
        return None
    return run


def _ip_rule(hosted):
    """Any public IPv4 that is not the hosted box's: a home IP, a LAN peer, the site's box."""
    def run(s):
        for m in IPV4_RE.finditer(s):
            if any(int(g) > 255 or (len(g) > 1 and g[0] == "0") for g in m.groups()):
                continue                      # a count, a version string (2.4.1.01)
            a = m.group(0)
            if a in hosted or NOBODYS_IP_RE.match(a) or PRIVATE_IP_RE.match(a):
                continue
            if re.search(r"(?i)version\W{0,3}$", s[max(0, m.start() - 12):m.start()]):
                continue                      # Version="1.0.0.6": a four-part package version
            return a
        return None
    return run


def _email_rule():
    def run(s):
        for m in EMAIL_RE.finditer(s):
            if not EMAIL_OK_RE.search(m.group(0)):
                return m.group(0)
        return None
    return run


def _gen_rule(gen):
    def run(s):
        for m in gen(s):
            return m.group(0)
        return None
    return run


def _literal_rules(name, literals):
    # No word boundaries, on purpose: `<user>_desktop.png` is still the user's name, and a bounded rule lets
    # it through the gate too.
    return [(name, _first(re.compile(re.escape(lit), re.I))) for lit in literals]


def text_rules(users=None, extras=None, hosted=HOSTED_IPS, surface="tree"):
    """[(rule name, callable(line) -> matched text or None)] applied to every line of every text file.

    `surface` is what is being scanned: the source `tree` (and its history), or an `artifact` that reaches a
    stranger's disk. A LAN address is unroutable and a source tree's tests and research notes are full of
    them, so `private-ip` runs only on artifacts -- where a log naming the builder's LAN is a leak. (The tree as it
    is now, and the index, are held to more: leakcheck's `scan_private` reports every private address in a tracked
    file as `tracked-private-ip` unless leak_allow.txt says why it is there -- Sprint 13 S6.)"""
    rules = _literal_rules("owner-user-name", users if users is not None else owner_names())
    rules += _literal_rules("owner-literal", extras if extras is not None else extra_literals())
    rules += [("home-directory-path", _home_dir_rule())]
    if surface == "artifact":
        rules += [("private-ip", _first(PRIVATE_IP_RE))]
    rules += [
        ("ip-address", _ip_rule(hosted)),
        ("street-address", _first(ADDRESS_RE)),
        ("postcode", _first(POSTCODE_RE)),
        ("email", _email_rule()),
        ("private-key-block", _first(PEM_MARKER_RE)),
        ("ssh-public-key-body", _first(SSH_PUBKEY_BODY_RE)),
        ("key-file-name", _first(KEYNAME_TEXT_RE)),
        ("aws-account-id", _gen_rule(account_matches)),
        ("vendor-token", _first(VENDOR_RE)),
        ("jwt", _first(JWT_RE)),
        ("cf-access-client-id", _first(CF_ACCESS_ID_RE)),
        ("cf-access-client-secret", _first(CF_ACCESS_SECRET_RE)),
        ("bearer-token", _first(BEARER_RE)),
        ("secret-assignment", _gen_rule(assign_matches)),
        ("opaque-secret", _gen_rule(opaque_matches)),
    ]
    return rules


def binary_rules(users=None, extras=None):
    """What is worth grepping for inside a PNG or an executable. Only long, literal shapes: anything shorter
    would fire on compressed noise, and a gate that cries wolf gets switched off."""
    rules = _literal_rules("owner-user-name", users if users is not None else owner_names())
    rules += _literal_rules("owner-literal", extras if extras is not None else extra_literals())
    rules += [("home-directory-path", _home_dir_rule()),
              ("private-key-block", _first(PEM_MARKER_RE)),
              ("ssh-public-key-body", _first(SSH_PUBKEY_BODY_RE)),
              ("vendor-token", _first(VENDOR_RE)),
              ("cf-access-client-id", _first(CF_ACCESS_ID_RE)),
              ("jwt", _first(JWT_RE))]
    return rules


def name_rules(users=None, extras=None):
    """Applied to each file's path, not its content."""
    rules = _literal_rules("owner-user-name", users if users is not None else owner_names())
    rules += _literal_rules("owner-literal", extras if extras is not None else extra_literals())
    rules += [("key-file-name", _first(KEYNAME_PATH_RE)),
              ("home-directory-path", _home_dir_rule()),
              ("street-address", _first(ADDRESS_RE)),
              ("aws-account-id", _gen_rule(account_matches))]
    return rules


# Severity, for the JSON report and for a reader deciding what to fix first.
SEVERITY = {
    "private-key-block": "critical", "ssh-public-key-body": "high", "vendor-token": "critical",
    "jwt": "critical", "cf-access-client-id": "critical", "cf-access-client-secret": "critical",
    "bearer-token": "critical", "secret-assignment": "high", "opaque-secret": "medium",
    "key-file-name": "high", "aws-account-id": "high", "owner-literal": "high",
    "owner-user-name": "medium", "home-directory-path": "medium", "street-address": "high",
    "postcode": "medium", "email": "medium", "ip-address": "medium", "private-ip": "low", "tracked-private-ip": "low",
    "ignored-path-tracked": "critical", "ignored-path-not-ignored": "high", "ignored-path-in-history": "critical",
    "commit-author": "medium", "commit-committer": "medium", "unreadable": "high", "forced-ignored-file": "critical",
}


def mask(s):
    """An excerpt that says what shape was found and not what it was. Gate output gets pasted into messages
    and JSON reports get attached to issues; neither may carry the secret itself."""
    if s is None:
        return ""
    s = s.strip()
    if len(s) <= 8:
        return s[:2] + "..."
    return f"{s[:4]}...{s[-2:]} ({len(s)} chars)"
