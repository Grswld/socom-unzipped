# Sprint 18 — the task book ("the PCSX2 door")

The table, the rulings, the Outcome and the Log are in `2026-10-01-sprint-18-the-pcsx2-door.md`; the design and its
evidence in `docs/superpowers/specs/2026-10-01-sprint-18-the-pcsx2-door-design.md`. Each task below is one agent's
brief: its files, its failing test first, its steps, its verification, its commit. An implementer sees only its own
task; the **Interfaces** block of each is how it learns the names its neighbours use. Paths are from the repo root;
`L/` is `third_party/ps2recomp/ps2xLauncher/`, `S/` is `third_party/ps2recomp/ps2xShared/`, `T/` is
`third_party/ps2recomp/ps2xTest/`. Tests run as `build-clang/ps2xTest/ps2x_tests --filter <name>` after
`./build.sh runtime` (under the lock, in a window) and `python -m unittest <module>` (lock-free).

---

### T0: The spike — five questions on a fresh PCSX2 (spec §3)

**Files:**
- Create: `docs/research/83-pcsx2-door-spike.md` <!-- docmaint: future -->
- Scratch: `logs/s18_spike/` (git-ignored)

**Interfaces:**
- Produces: the answers T3 (question 3, 4, 5), T4 (1, 2) and T6 (2) design against. A "no" to question 1 or 2 is a
  ruling before T4 begins.

- [ ] **Step 1: Fetch the release by hand into the scratch folder** (one real download, ~26 MB; no lock needed)

```bash
mkdir -p logs/s18_spike && cd logs/s18_spike
curl -sL -o release.json https://api.github.com/repos/PCSX2/pcsx2/releases/latest
URL=$(grep -oE '"browser_download_url":"[^"]*-windows-x64-Qt\.7z"' release.json | cut -d'"' -f4)
curl -L -o pcsx2.7z "$URL"
grep -oE '"digest":"sha256:[0-9a-f]+"' release.json; sha256sum pcsx2.7z     # the 7z's digest must be among them
```

- [ ] **Step 2: Question 1 — extract with the system's bsdtar**

```bash
mkdir -p logs/s18_spike/pcsx2 && /c/Windows/System32/tar.exe -xf logs/s18_spike/pcsx2.7z -C logs/s18_spike/pcsx2
ls logs/s18_spike/pcsx2 | head; test -f logs/s18_spike/pcsx2/pcsx2-qt.exe && echo EXTRACT_OK
```
Record the exit code and whether the exe and its DLLs are at the top level or under a subfolder (the extract step of
T4 needs to know which).

- [ ] **Step 3: Prepare the fresh portable install** (BIOS copied from the harness's instance; the ISO is the owner's)

```bash
cd logs/s18_spike/pcsx2 && touch portable.txt && mkdir -p bios inis patches memcards
cp ../../../tools/pcsx2/bios/*.bin bios/
cp ../../../scripts/parity/pcsx2/0F6FC6CF.pnach patches/
printf '[DEV9/Eth]\nEthEnable = true\nEthApi = Sockets\nInterceptDHCP = true\nAutoMask = true\nAutoGateway = true\nModeDNS1 = Manual\nModeDNS2 = Manual\nDNS1 = 3.143.65.100\nDNS2 = 3.143.65.100\n' > inis/PCSX2.ini
```
Leave `EthDevice` out on purpose (question 5) and `[MemoryCards]` out (question 4).

- [ ] **Step 4: Questions 2-5 — one boot in a window** (`run-gate` skill; the loop lock; the owner's window O20)

```bash
bash scripts/loop_lock.sh run --purpose launch-pcsx2-spike -- logs/s18_spike/pcsx2/pcsx2-qt.exe -batch "<the owner's r0001 ISO>"
```
Then read `logs/s18_spike/pcsx2/logs/emulog.txt` for: the patches line (`Loaded … patches` / the pnach's name), the
memory card lines (`Mcd001.ps2` created, or an error), the DEV9 lines (`DEV9: …` adapter / bind / DHCP), and whether
the process exited when the game was closed. Try `pcsx2-qt.exe --help` once for the flag list (it may open a dialog;
dismiss it). If the game shows the network wizard, run it on automatic answers and note whether the DNS it reports is
`3.143.65.100` (T1 need not be live yet for that).

- [ ] **Step 5: Write the note** — `docs/research/83-pcsx2-door-spike.md`: the five questions, each with its answer, <!-- docmaint: future -->
  the emulog line it was read from, and the design consequence (T3/T4/T6). Delete `logs/s18_spike/pcsx2.7z` (R-C: no
  PCSX2 bytes kept in the tree; the folder is ignored but the archive is 26 MB).

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(research): 83 -- the PCSX2 door spike: bsdtar, -batch, the pnach, the card, the adapter" -- docs/research/83-pcsx2-door-spike.md <!-- docmaint: future -->
```

---

### T1: The box's name service — `socom-dns` beside the four Horizon units

**Files:**
- Create: `server/linux/socom_dns.py`, `server/linux/socom-dns.sh`, `server/linux/socom-dns.service`
- Modify: `server/linux/install.sh` (install the unit), `server/linux/horizon-ctl.sh` (status lists it, start/stop
  include it), `server/linux/horizon.target` (no change if units use `PartOf`/`WantedBy=horizon.target`)
- Test: `tools_py/tests/test_socom_dns.py`
- Modify: `docs/HUMAN_TASKS.md` (O28 only if the AWS session is not live)

**Interfaces:**
- Produces: `3.143.65.100:53/udp` answering the six names with `muis.json`'s `Endpoint`; `socom_dns.respond(data: bytes,
  answer: bytes, names: set) -> bytes | None` (pure; None = drop); `socom_dns.RateCap(per_second: int)` with
  `allow(source_ip: str, now: float) -> bool`.

- [ ] **Step 1: Write the failing test**

```python
# tools_py/tests/test_socom_dns.py
import importlib.util, pathlib, struct, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("socom_dns", ROOT / "server" / "linux" / "socom_dns.py")
socom_dns = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(socom_dns)


def query(name, qtype=1, tid=b"\x12\x34"):
    q = b"".join(bytes([len(l)]) + l.encode() for l in name.split(".")) + b"\x00"
    return tid + struct.pack(">HHHHH", 0x0100, 1, 0, 0, 0) + q + struct.pack(">HH", qtype, 1)


class RespondTests(unittest.TestCase):
    ANSWER = bytes([3, 143, 65, 100])

    def test_known_name_gets_an_a_record_with_the_answer(self):
        resp = socom_dns.respond(query("socom2-prod.pdonline.scea.com"), self.ANSWER, socom_dns.NAMES)
        self.assertEqual(resp[:2], b"\x12\x34")
        self.assertEqual(struct.unpack(">H", resp[2:4])[0], 0x8180)
        self.assertEqual(struct.unpack(">H", resp[6:8])[0], 1)          # one answer
        self.assertTrue(resp.endswith(struct.pack(">H", 4) + self.ANSWER))

    def test_case_does_not_matter(self):
        resp = socom_dns.respond(query("GATE1.US.DNAS.PLAYSTATION.ORG"), self.ANSWER, socom_dns.NAMES)
        self.assertEqual(struct.unpack(">H", resp[6:8])[0], 1)

    def test_other_name_is_nxdomain_with_no_answer(self):
        resp = socom_dns.respond(query("example.com"), self.ANSWER, socom_dns.NAMES)
        self.assertEqual(struct.unpack(">H", resp[2:4])[0], 0x8183)
        self.assertEqual(struct.unpack(">H", resp[6:8])[0], 0)

    def test_aaaa_for_a_known_name_is_nxdomain_not_an_a_record(self):
        resp = socom_dns.respond(query("socom2-prod.muis.pdonline.scea.com", qtype=28), self.ANSWER, socom_dns.NAMES)
        self.assertEqual(struct.unpack(">H", resp[6:8])[0], 0)

    def test_short_or_garbage_packet_is_dropped(self):
        self.assertIsNone(socom_dns.respond(b"\x00" * 5, self.ANSWER, socom_dns.NAMES))
        self.assertIsNone(socom_dns.respond(b"\x12\x34" + b"\xff" * 30, self.ANSWER, socom_dns.NAMES))

    def test_answer_never_larger_than_query_plus_sixteen(self):
        # Amplification: one A record is 16 bytes over the echoed question. Nothing else is ever appended.
        q = query("www.playstation.org")
        self.assertLessEqual(len(socom_dns.respond(q, self.ANSWER, socom_dns.NAMES)), len(q) + 16)


class RateCapTests(unittest.TestCase):
    def test_twentieth_query_in_a_second_is_the_last_one_allowed(self):
        cap = socom_dns.RateCap(per_second=20)
        allowed = [cap.allow("1.2.3.4", 100.0 + i / 100.0) for i in range(25)]
        self.assertEqual(allowed.count(True), 20)
        self.assertTrue(cap.allow("1.2.3.4", 101.5))            # the next second
        self.assertTrue(cap.allow("198.51.100.8", 100.1))            # another source is its own bucket


class MuisEndpointTests(unittest.TestCase):
    def test_endpoint_read_from_muis_json(self):
        text = '{"Universes":[{"Name":"SOCOM II","Endpoint":"3.143.65.100","Port":10075}]}'
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_a_hostname_endpoint_is_refused(self):
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis('{"Universes":[{"Endpoint":"socom.scotho.com"}]}')


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to see it fail** — `python -m unittest tools_py.tests.test_socom_dns -v`: `FileNotFoundError`
  (no `socom_dns.py`).

- [ ] **Step 3: Write `server/linux/socom_dns.py`** — the stub's logic (`tools_py/parity/dns_stub.py`) as pure functions
  plus the cap and the quiet log:

```python
#!/usr/bin/env python3
"""socom-dns: answers SOCOM II's six retail host names with this server's own address, NXDOMAIN for anything else.
Sprint 18 (R-D). Pure functions on top (tested by tools_py/tests/test_socom_dns.py); main() binds UDP 53 on the
interface given and serves. Usage: socom_dns.py --bind <private ip> --muis /opt/socom-unzipped-server/config/muis.json
Quiet: one journal line a minute with the counts, never a line per query."""
import argparse, collections, json, re, socket, struct, sys, time

NAMES = {
    "socom2-prod.pdonline.scea.com", "socom2-prod.muis.pdonline.scea.com",
    "gate1.us.dnas.playstation.org", "gate1.jp.dnas.playstation.org", "gate1.eu.dnas.playstation.org",
    "www.playstation.org",
}
_IPV4 = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")


def endpoint_from_muis(text):
    ep = json.loads(text)["Universes"][0]["Endpoint"]
    if not _IPV4.match(ep):
        sys.exit("socom-dns: muis.json Endpoint %r is not a dotted IPv4 address; the answer must be one" % ep)
    return ep


def _parse_name(data, off):
    labels = []
    while True:
        n = data[off]; off += 1
        if n == 0:
            return ".".join(labels), off
        if n >= 64 or off + n > len(data):
            raise ValueError("bad label")
        labels.append(data[off:off + n].decode("ascii", "replace")); off += n


def respond(data, answer, names):
    """The response for one query datagram, or None when it is not a query worth answering."""
    if len(data) < 17 or len(data) > 512 or data[2] & 0x80:   # too short, too long, or itself a response
        return None
    try:
        name, off = _parse_name(data, 12)
        qtype, qclass = struct.unpack(">HH", data[off:off + 4])
    except (ValueError, IndexError, struct.error):
        return None
    question = data[12:off + 4]
    if name.lower() in names and qtype == 1 and qclass == 1:
        rr = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + answer
        return data[:2] + struct.pack(">HHHHH", 0x8180, 1, 1, 0, 0) + question + rr
    return data[:2] + struct.pack(">HHHHH", 0x8183, 1, 0, 0, 0) + question


class RateCap:
    def __init__(self, per_second):
        self.per_second = per_second
        self.buckets = {}   # source -> (second, count)

    def allow(self, source, now):
        second = int(now)
        s, n = self.buckets.get(source, (second, 0))
        if s != second:
            s, n = second, 0
        if n >= self.per_second:
            return False
        self.buckets[source] = (s, n + 1)
        if len(self.buckets) > 4096:
            self.buckets = {k: v for k, v in self.buckets.items() if v[0] == second}
        return True


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--bind", required=True)
    ap.add_argument("--port", type=int, default=53)
    ap.add_argument("--muis", required=True)
    ap.add_argument("--per-second", type=int, default=20)
    a = ap.parse_args(argv)
    with open(a.muis) as f:
        answer_ip = endpoint_from_muis(f.read())
    answer = bytes(int(x) for x in answer_ip.split("."))
    cap = RateCap(a.per_second)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((a.bind, a.port))
    print("socom-dns listening on %s:%d, answering %s for %d names" % (a.bind, a.port, answer_ip, len(NAMES)), flush=True)
    counts = collections.Counter(); last = time.time()
    while True:
        data, addr = s.recvfrom(512)
        now = time.time()
        if not cap.allow(addr[0], now):
            counts["capped"] += 1
        else:
            resp = respond(data, answer, NAMES)
            if resp is None:
                counts["dropped"] += 1
            else:
                s.sendto(resp, addr)
                counts["answered" if resp[7] else "nxdomain"] += 1
        if now - last >= 60:
            print("socom-dns last minute: %s" % dict(counts), flush=True); counts.clear(); last = now


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the test to see it pass** — `python -m unittest tools_py.tests.test_socom_dns -v`: all green.

- [ ] **Step 5: The wrapper, the unit, the installer** — `server/linux/socom-dns.sh`:

```bash
#!/usr/bin/env bash
# socom-dns: bind the box's first private IPv4 (systemd-resolved holds 127.0.0.53:53, so never the wildcard).
set -euo pipefail
BIND="$(hostname -I | awk '{print $1}')"
exec /usr/bin/python3 /opt/socom-unzipped-server/linux/socom_dns.py --bind "$BIND" --muis /opt/socom-unzipped-server/config/muis.json
```
`server/linux/socom-dns.service` (the NAT unit's shape, `cat server/linux/horizon-nat.service`):

```ini
# SOCOM Unzipped hosted server (Sprint 18, R-D): answers SOCOM II's six retail host names on 53/udp with muis.json's
# Endpoint, NXDOMAIN otherwise. A PCSX2 or a console pointed at this box as its DNS finds the lobby. journalctl -u socom-dns
[Unit]
Description=SOCOM II name service (six retail host names -> this server, 53/udp)
After=network-online.target
Wants=network-online.target
PartOf=horizon.target

[Service]
User=horizon
Group=horizon
WorkingDirectory=/opt/socom-unzipped-server
ExecStart=/bin/bash /opt/socom-unzipped-server/linux/socom-dns.sh
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=horizon.target
```
In `install.sh`: where the four units are copied and enabled, add `socom-dns.service` the same way and `chmod +x
linux/socom-dns.sh linux/socom_dns.py`. In `horizon-ctl.sh`: add `socom-dns` to the unit list `status`, `start`,
`stop`, `restart` iterate (read the script; the four names are one array or one repeated line — extend it, do not
add a branch).

- [ ] **Step 6: Deploy and open the port** (the owner's authority: the spec's head)

```bash
vm/lightsail/ssh.sh 'mkdir -p /tmp/s18' && scp -i vm/lightsail/keys/socom_unzipped_ed25519 server/linux/socom_dns.py server/linux/socom-dns.sh server/linux/socom-dns.service server/linux/install.sh server/linux/horizon-ctl.sh ubuntu@3.143.65.100:/tmp/s18/
vm/lightsail/ssh.sh 'sudo cp /tmp/s18/socom_dns.py /tmp/s18/socom-dns.sh /tmp/s18/horizon-ctl.sh /opt/socom-unzipped-server/linux/ && sudo cp /tmp/s18/socom-dns.service /etc/systemd/system/ && sudo chmod +x /opt/socom-unzipped-server/linux/socom-dns.sh /opt/socom-unzipped-server/linux/socom_dns.py && sudo systemctl daemon-reload && sudo systemctl enable --now socom-dns && sleep 2 && systemctl status socom-dns --no-pager | head -8'
vm/lightsail/ssh.sh 'nslookup socom2-prod.pdonline.scea.com $(hostname -I | awk "{print \$1}")'      # on the box: answers
aws sts get-caller-identity --region us-east-2 && aws lightsail open-instance-public-ports --region us-east-2 --instance-name socom-unzipped-server --port-info fromPort=53,toPort=53,protocol=udp
```
If `aws sts get-caller-identity` fails (no live session), do NOT run `aws login`: write the O28 row in
`docs/HUMAN_TASKS.md` ("open 53/udp from anywhere on socom-unzipped-server: `aws lightsail open-instance-public-ports
--region us-east-2 --instance-name socom-unzipped-server --port-info fromPort=53,toPort=53,protocol=udp`") and report.

- [ ] **Step 7: Verify from off the box** (this host)

```bash
nslookup -type=A socom2-prod.pdonline.scea.com 3.143.65.100     # Address: 3.143.65.100
nslookup -type=A example.com 3.143.65.100                        # NXDOMAIN ("Non-existent domain")
vm/lightsail/ssh.sh 'journalctl -u socom-dns --no-pager -n 3'
```
Record both outputs in the plan's Log with the stamp.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(server): socom-dns -- the box answers SOCOM II's six host names on 53/udp (Sprint 18 R-D)" -- server/linux/socom_dns.py server/linux/socom-dns.sh server/linux/socom-dns.service server/linux/install.sh server/linux/horizon-ctl.sh tools_py/tests/test_socom_dns.py
```

---

### T2: The mode and the second config — `client_mode`, `pcsx2_config`, "coming soon"

**Files:**
- Create: `S/include/launcher/client_mode.h`, `S/src/client_mode.cpp`, `S/include/launcher/pcsx2_config.h`,
  `S/src/pcsx2_config.cpp`
- Modify: `S/include/launcher/launcher_config.h` (add `kPresetComingSoonNote`), `S/CMakeLists.txt` (the two sources),
  `L/src/ui/page_online.cpp:64-66` (the greyed preset row's note), `T/CMakeLists.txt`
- Test: `T/src/pcsx2_config_tests.cpp`

**Interfaces:**
- Produces:
```cpp
namespace launcher {
    enum class ClientMode { Native, Pcsx2 };
    constexpr const char *kClientModeFile = "launcher.json";          // beside the launcher; {"client":"native"}
    ClientMode parseClientMode(const std::string &json);               // anything but "pcsx2" is Native
    std::string clientModeJson(ClientMode mode);                       // "{\n  \"client\": \"pcsx2\"\n}\n"
    const char *clientModeId(ClientMode mode);                         // "native" | "pcsx2"

    constexpr const char *kPcsx2ConfigFile = "config.pcsx2.json";
    constexpr const char *kPcsx2RevisionNote = "needs the card package -- later";   // R-E, the greyed r0004 cell
    struct Pcsx2Config {
        std::string isoPath;
        std::string pcsx2Exe;                 // full path of pcsx2-qt.exe; "" = none selected or installed
        std::string gameRevision = "r0001";   // normalizeGameRevision; r0004 is drawn greyed this sprint (R-E)
        std::string serverPreset = "unzipped";
        std::string server = "127.0.0.1";     // Custom's typed address or name
        std::string ethDevice;                // PCSX2's EthDevice GUID; "" = the launcher picks (T4 pickAdapter)
        bool operator==(const Pcsx2Config &) const = default;
    };
    std::string pcsx2ToJson(const Pcsx2Config &c);
    bool pcsx2FromJson(const std::string &json, Pcsx2Config &out);     // false on malformed JSON; out = defaults then
    std::string pcsx2EffectiveServer(const Pcsx2Config &c);            // the preset's address, or the typed one
    constexpr const char *kPresetComingSoonNote = "coming soon";       // R-B: the greyed community row, both views
}
```

- [ ] **Step 1: Write the failing tests** — `T/src/pcsx2_config_tests.cpp`, in `launcher_tests.cpp`'s style
  (`#include "MiniTest.h"`, `TEST_CASE("name")`, `CHECK(...)`):

```cpp
#include "MiniTest.h"
#include "launcher/client_mode.h"
#include "launcher/launcher_config.h"
#include "launcher/pcsx2_config.h"

TEST_CASE("client_mode: the default, the two ids, and a round trip")
{
    CHECK(launcher::parseClientMode("") == launcher::ClientMode::Native);
    CHECK(launcher::parseClientMode("{\"client\": \"pcsx2\"}") == launcher::ClientMode::Pcsx2);
    CHECK(launcher::parseClientMode("{\"client\": \"PCSX2\"}") == launcher::ClientMode::Native);   // ids are exact
    CHECK(launcher::parseClientMode("not json at all") == launcher::ClientMode::Native);
    CHECK(launcher::parseClientMode(launcher::clientModeJson(launcher::ClientMode::Pcsx2)) == launcher::ClientMode::Pcsx2);
    CHECK(std::string(launcher::clientModeId(launcher::ClientMode::Native)) == "native");
}

TEST_CASE("pcsx2_config: defaults, a round trip, and no key of config.json's")
{
    launcher::Pcsx2Config c;
    CHECK(c.gameRevision == "r0001");
    CHECK(c.serverPreset == "unzipped");
    c.isoPath = "D:\\games\\socom2.iso"; c.pcsx2Exe = "C:\\s2u\\pcsx2\\pcsx2-qt.exe"; c.serverPreset = "custom";
    c.server = "203.0.113.10"; c.ethDevice = "{95852BA5-54B5-4A50-A84D-8ED1B927EDD9}";
    const std::string json = launcher::pcsx2ToJson(c);
    launcher::Pcsx2Config back;
    CHECK(launcher::pcsx2FromJson(json, back));
    CHECK(back == c);
    // Review Focus 1 / R-A: the native client's keys mean nothing here and never leak in.
    CHECK(json.find("gsScale") == std::string::npos);
    CHECK(json.find("loginPassword") == std::string::npos);
    CHECK(json.find("mappings") == std::string::npos);
}

TEST_CASE("pcsx2_config: unknown keys ignored, missing keys keep defaults, malformed is the defaults")
{
    launcher::Pcsx2Config c;
    CHECK(launcher::pcsx2FromJson("{\"isoPath\": \"x.iso\", \"futureKey\": 7, \"gsScale\": 3}", c));
    CHECK(c.isoPath == "x.iso");
    CHECK(c.serverPreset == "unzipped");
    launcher::Pcsx2Config bad; bad.isoPath = "keep?";
    CHECK(!launcher::pcsx2FromJson("{\"isoPath\": ", bad));
    CHECK(bad == launcher::Pcsx2Config{});
}

TEST_CASE("pcsx2_config: the revision and the preset are normalised as the native config's are")
{
    launcher::Pcsx2Config c;
    CHECK(launcher::pcsx2FromJson("{\"gameRevision\": \"r9999\", \"serverPreset\": \"unzipped-ip\"}", c));
    CHECK(c.gameRevision == "r0001");
    CHECK(c.serverPreset == "unzipped");          // kRetiredPresets heals it, as fromJson does
    CHECK(launcher::pcsx2FromJson("{\"serverPreset\": \"community\"}", c));
    CHECK(c.serverPreset == "unzipped");          // R-B: not playable -> the playable fallback, as fromJson does
}

TEST_CASE("pcsx2_config: the effective server is the preset's address or the typed one")
{
    launcher::Pcsx2Config c;
    CHECK(launcher::pcsx2EffectiveServer(c) == "socom.scotho.com");
    c.serverPreset = "custom"; c.server = "203.0.113.7";
    CHECK(launcher::pcsx2EffectiveServer(c) == "203.0.113.7");
    c.server = "";
    CHECK(launcher::pcsx2EffectiveServer(c) == "127.0.0.1");
}

TEST_CASE("launcher_config: the coming-soon note exists and is not the revision note")
{
    CHECK(std::string(launcher::kPresetComingSoonNote) == "coming soon");
    CHECK(std::string(launcher::kPresetComingSoonNote) != std::string(launcher::kRevisionMissingNote));
}
```
Add `src/pcsx2_config_tests.cpp` to `T/CMakeLists.txt` after `src/patch_fetch_tests.cpp`.

- [ ] **Step 2: Build and run to see it fail** — `./build.sh runtime` (lock, window) fails to compile: the headers do
  not exist. (A compile failure is the failing test here; `clang -fsyntax-only` on the test file needs no lock.)

- [ ] **Step 3: Implement** — `client_mode.cpp`: find `"client"` and read its string value with the same minimal
  scanner `launcher_config.cpp`'s `fromJson` uses (read it first; reuse its key/value walk if it is a function, else
  the same three lines). `pcsx2_config.cpp`: `pcsx2ToJson` writes the six keys two-space indented like `toJson`;
  `pcsx2FromJson` mirrors `fromJson`'s loop (lines 290-350) for the six keys: `gameRevision` through
  `normalizeGameRevision`, `serverPreset` through the retired-preset heal and `presetAvailable` fallback exactly as
  `fromJson` does (factor that into a shared `normalizeServerPreset(value)` in `launcher_config.cpp` and call it
  from both — one rule, two callers). `pcsx2EffectiveServer`: `findServerPreset`; address non-empty → it; else
  `server` or `"127.0.0.1"`. Add `kPresetComingSoonNote` and the two new sources to `S/CMakeLists.txt`.

- [ ] **Step 4: The note on the preset row** — `L/src/ui/page_online.cpp:66`: `kRevisionMissingNote` →
  `kPresetComingSoonNote`. Grep `launcher_tests.cpp` and `tips` for the old sentence on the preset row and fix the
  assertion that names it (the revision cell keeps `kRevisionMissingNote`).

- [ ] **Step 5: Build, run** — `./build.sh runtime` then `build-clang/ps2xTest/ps2x_tests --filter pcsx2_config` and
  `--filter launcher`: green; the full `ps2x_tests` count rises by six.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(launcher): client mode + config.pcsx2.json -- two clients, two files; community row says coming soon (S18 T2)" -- third_party/ps2recomp/ps2xShared/include/launcher/client_mode.h third_party/ps2recomp/ps2xShared/src/client_mode.cpp third_party/ps2recomp/ps2xShared/include/launcher/pcsx2_config.h third_party/ps2recomp/ps2xShared/src/pcsx2_config.cpp third_party/ps2recomp/ps2xShared/include/launcher/launcher_config.h third_party/ps2recomp/ps2xShared/src/launcher_config.cpp third_party/ps2recomp/ps2xShared/CMakeLists.txt third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp third_party/ps2recomp/ps2xTest/src/pcsx2_config_tests.cpp third_party/ps2recomp/ps2xTest/CMakeLists.txt
```

---

### T3: What the launcher writes for PCSX2 — the ini merge, the pnach, the root, the DNS pick

**Files:**
- Create: `S/include/launcher/pcsx2_files.h`, `S/src/pcsx2_files.cpp`, `S/pcsx2_pnach_embedded.h.in`
- Modify: `S/CMakeLists.txt` (embed `scripts/parity/pcsx2/0F6FC6CF.pnach` at configure time)
- Test: `T/src/pcsx2_files_tests.cpp`; extend `tools_py/tests/test_pcsx2_masters.py`

**Interfaces:**
- Consumes: `launcher::Pcsx2Config`, `pcsx2EffectiveServer` (T2).
- Produces:
```cpp
namespace launcher::pcsx2files {
    extern const char *const kPnachMaster;     // generated: the bytes of scripts/parity/pcsx2/0F6FC6CF.pnach
    constexpr const char *kPnachName = "0F6FC6CF.pnach";
    constexpr const char *kIniName = "PCSX2.ini";
    constexpr const char *kPortableMarker = "portable.txt";
    // Where this PCSX2 keeps inis/, patches/, bios/, memcards/: beside the exe when portable (portable.txt or
    // portable.ini beside it), else <documents>/PCSX2 (PCSX2's own rule).
    std::filesystem::path dataRoot(const std::filesystem::path &exeDir, bool portableMarkerBesideExe,
                                   const std::filesystem::path &documentsDir);
    // The [DEV9/Eth] keys the launcher owns, in order. ethDevice "" leaves EthDevice out (T4 fills it when known).
    std::vector<std::pair<std::string, std::string>> dev9Keys(const std::string &dnsIp, const std::string &ethDevice);
    // `text` with `keys` set inside `[section]`: an existing key's line replaced in place, a missing key appended at
    // the section's end, the section appended at the end of the file when absent; every other byte kept. CRLF kept.
    std::string mergeIniSection(const std::string &text, const std::string &section,
                                const std::vector<std::pair<std::string, std::string>> &keys);
    bool isDottedIpv4(const std::string &s);
    struct DnsPick { std::string ip; std::string error; };     // error non-empty = LAUNCH is refused with it
    // The address PCSX2's DNS1/DNS2 get: the effective server when it is dotted, else resolver(name) (which returns
    // "" when it cannot). The error names the name: "cannot resolve socom.scotho.com -- check your connection".
    DnsPick dnsServerFor(const Pcsx2Config &c, const std::function<std::string(const std::string &)> &resolver);
    // Write `bytes` to `path` only when the file's bytes differ; when a different file was there, keep it once as
    // "<path>.bak-<stamp>" (never overwritten). Returns true when written. Creates the parent folders.
    bool writeIfDifferent(const std::filesystem::path &path, const std::string &bytes, const std::string &stamp, std::string &error);
}
```

- [ ] **Step 1: Write the failing tests**

```cpp
#include "MiniTest.h"
#include "launcher/pcsx2_files.h"
#include <filesystem>
#include <fstream>
namespace pf = launcher::pcsx2files;
namespace fs = std::filesystem;

TEST_CASE("pcsx2_files: the data root is beside a portable exe and under Documents otherwise")
{
    CHECK(pf::dataRoot("C:/s2u/pcsx2", true, "X:/Documents") == fs::path("C:/s2u/pcsx2"));
    CHECK(pf::dataRoot("C:/Program Files/PCSX2", false, "X:/Documents") == fs::path("X:/Documents/PCSX2"));
}

TEST_CASE("pcsx2_files: the DEV9 keys are the harness's template with the DNS filled in")
{
    const auto keys = pf::dev9Keys("3.143.65.100", "");
    CHECK(keys.front() == std::make_pair(std::string("EthEnable"), std::string("true")));
    bool sawDns1 = false, sawDevice = false;
    for (const auto &[k, v] : keys) { if (k == "DNS1") { sawDns1 = true; CHECK(v == "3.143.65.100"); } if (k == "EthDevice") sawDevice = true; }
    CHECK(sawDns1); CHECK(!sawDevice);
    const auto withDevice = pf::dev9Keys("3.143.65.100", "{AAAA}");
    bool found = false; for (const auto &[k, v] : withDevice) if (k == "EthDevice") { found = true; CHECK(v == "{AAAA}"); }
    CHECK(found);
    for (const char *k : {"EthApi", "InterceptDHCP", "AutoMask", "AutoGateway", "ModeDNS1", "ModeDNS2", "DNS2"})
    { bool f = false; for (const auto &kv : keys) f = f || kv.first == k; CHECK(f); }
}

TEST_CASE("pcsx2_files: merging into a player's ini touches only our keys of our section (Review Focus 2)")
{
    const std::string ini =
        "[UI]\r\nMainWindowGeometry = abc\r\n\r\n[DEV9/Eth]\r\nEthEnable = false\r\nEthApi = PCAP\r\nEthLogDNS = true\r\n\r\n"
        "[DEV9/Hdd]\r\nHddEnable = false\r\n";
    const std::string out = pf::mergeIniSection(ini, "DEV9/Eth", {{"EthEnable", "true"}, {"EthApi", "Sockets"}, {"DNS1", "1.2.3.4"}});
    CHECK(out.find("[UI]\r\nMainWindowGeometry = abc\r\n") == 0);
    CHECK(out.find("EthEnable = true\r\n") != std::string::npos);
    CHECK(out.find("EthEnable = false") == std::string::npos);
    CHECK(out.find("EthApi = Sockets\r\n") != std::string::npos);
    CHECK(out.find("EthLogDNS = true\r\n") != std::string::npos);                 // a key we do not own, kept
    CHECK(out.find("DNS1 = 1.2.3.4\r\n") != std::string::npos);
    CHECK(out.find("DNS1 = 1.2.3.4\r\n") < out.find("[DEV9/Hdd]"));                // appended inside our section
    CHECK(out.find("[DEV9/Hdd]\r\nHddEnable = false\r\n") != std::string::npos);
    CHECK(out.find("Sockets") == out.rfind("Sockets"));                             // once
}

TEST_CASE("pcsx2_files: a missing section is appended; an empty file becomes just the section; LF stays LF")
{
    const std::string out = pf::mergeIniSection("[UI]\nX = 1\n", "DEV9/Eth", {{"EthEnable", "true"}});
    CHECK(out == "[UI]\nX = 1\n\n[DEV9/Eth]\nEthEnable = true\n");
    CHECK(pf::mergeIniSection("", "DEV9/Eth", {{"EthEnable", "true"}}) == "[DEV9/Eth]\nEthEnable = true\n");
}

TEST_CASE("pcsx2_files: the embedded pnach is the master, byte for byte")
{
    const std::string master = []{ std::ifstream f("scripts/parity/pcsx2/0F6FC6CF.pnach", std::ios::binary); return std::string((std::istreambuf_iterator<char>(f)), {}); }();
    CHECK(!master.empty());                       // the test runs from the repo root, as build.sh test does
    CHECK(std::string(pf::kPnachMaster) == master);
    CHECK(master.find("E00327BD") != std::string::npos);     // the guard: never an unguarded 0x2CC670 write
}

TEST_CASE("pcsx2_files: the DNS pick -- dotted stays, a name resolves, a failure names the name (Review Focus 3)")
{
    launcher::Pcsx2Config c;                      // unzipped -> socom.scotho.com
    auto resolver = [](const std::string &n) { return n == "socom.scotho.com" ? std::string("3.143.65.100") : std::string(); };
    CHECK(pf::dnsServerFor(c, resolver).ip == "3.143.65.100");
    c.serverPreset = "custom"; c.server = "203.0.113.3";
    CHECK(pf::dnsServerFor(c, resolver).ip == "203.0.113.3");
    c.server = "nowhere.invalid";
    const pf::DnsPick p = pf::dnsServerFor(c, resolver);
    CHECK(p.ip.empty()); CHECK(p.error.find("nowhere.invalid") != std::string::npos);
    c.server = " 203.0.113.3 ";                      // spaces: not dotted, not a name either
    CHECK(!pf::dnsServerFor(c, resolver).error.empty());
    CHECK(pf::isDottedIpv4("3.143.65.100")); CHECK(!pf::isDottedIpv4("3.143.65.")); CHECK(!pf::isDottedIpv4("300.1.1.1"));
}

TEST_CASE("pcsx2_files: writeIfDifferent writes once, keeps a .bak once, and is quiet when equal")
{
    const fs::path dir = fs::temp_directory_path() / "s18_wid"; fs::remove_all(dir);
    const fs::path p = dir / "patches" / "0F6FC6CF.pnach"; std::string err;
    CHECK(pf::writeIfDifferent(p, "one", "20261001T000000Z", err)); CHECK(err.empty());
    CHECK(!pf::writeIfDifferent(p, "one", "20261001T000001Z", err));
    CHECK(!fs::exists(dir / "patches" / "0F6FC6CF.pnach.bak-20261001T000001Z"));
    CHECK(pf::writeIfDifferent(p, "two", "20261001T000002Z", err));
    CHECK(fs::exists(dir / "patches" / "0F6FC6CF.pnach.bak-20261001T000002Z"));
    fs::remove_all(dir);
}
```
Add `src/pcsx2_files_tests.cpp` to `T/CMakeLists.txt`.

- [ ] **Step 2: See it fail** — `clang -fsyntax-only` on the test (no header) and/or the build.

- [ ] **Step 3: The embed** — `S/pcsx2_pnach_embedded.h.in`:

```cpp
#pragma once
// GENERATED by CMake from scripts/parity/pcsx2/0F6FC6CF.pnach -- edit the master, not this file.
namespace launcher::pcsx2files { inline const char *const kPnachMaster = R"pnach(@PNACH_MASTER@)pnach"; }
```
In `S/CMakeLists.txt`: `file(READ ${CMAKE_SOURCE_DIR}/scripts/parity/pcsx2/0F6FC6CF.pnach PNACH_MASTER)` then
`configure_file(pcsx2_pnach_embedded.h.in ${CMAKE_CURRENT_BINARY_DIR}/generated/launcher/pcsx2_pnach_embedded.h @ONLY)`
and add that generated dir to `ps2x_shared`'s public include dirs; `set_property(DIRECTORY APPEND PROPERTY
CMAKE_CONFIGURE_DEPENDS ...pnach)` so an edited master reconfigures. (Check the master has no `)pnach"` and no `@`.)

- [ ] **Step 4: Implement `pcsx2_files.cpp`** — `mergeIniSection`: split into lines keeping each line's own ending;
  find the `[section]` header line (trimmed, exact); within it (until the next `[` line or EOF) replace lines whose
  key (text before `=`, trimmed) matches, in order; collect the keys not seen; insert them after the section's last
  non-blank line, using the file's dominant line ending (CRLF if any CRLF seen, else LF); no header → append
  `\n[section]\n` (one blank line before when the text does not end in a blank line) and the keys. `dev9Keys`: the
  template `scripts/parity/pcsx2/PCSX2.ini.dev9-section` minus `EthLogDHCP/EthLogDNS` (a player's log need not
  grow), minus `PS2IP/Mask/Gateway` (DHCP interception owns them), `EthDevice` only when given. `dnsServerFor`:
  `pcsx2EffectiveServer`; dotted → it; a plausible host name (letters, digits, `-`, `.`, no spaces) → `resolver`;
  "" → the error `"cannot resolve <name> -- check your connection"`; anything else → `"<value> is not an address or
  a host name"`. `writeIfDifferent`: read existing; equal → false; different and existed → copy to `.bak-<stamp>`
  if that name is free; create dirs; write via a temp name and rename.

- [ ] **Step 5: Extend the Python masters test** — in `tools_py/tests/test_pcsx2_masters.py`, one case: the generated
  header, when present under `build-clang/`, holds the master's bytes between `R"pnach(` and `)pnach"` (skip with a
  reason when no build dir).

- [ ] **Step 6: Build, run** — `ps2x_tests --filter pcsx2_files` green; `python -m unittest tools_py.tests.test_pcsx2_masters` green.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(launcher): pcsx2_files -- the DEV9 merge, the embedded guarded pnach, the data root, the DNS pick (S18 T3)" -- third_party/ps2recomp/ps2xShared/include/launcher/pcsx2_files.h third_party/ps2recomp/ps2xShared/src/pcsx2_files.cpp third_party/ps2recomp/ps2xShared/pcsx2_pnach_embedded.h.in third_party/ps2recomp/ps2xShared/CMakeLists.txt third_party/ps2recomp/ps2xTest/src/pcsx2_files_tests.cpp third_party/ps2recomp/ps2xTest/CMakeLists.txt tools_py/tests/test_pcsx2_masters.py
```

---

### T4: INSTALL — the release parse, the redirect-following download, `runAndWait`, `resolveIpv4`, the adapters

**Files:**
- Create: `S/include/launcher/pcsx2_install.h`, `S/src/pcsx2_install.cpp`
- Modify: `L/src/win32_glue.h`, `L/src/win32_glue.cpp`, `L/src/posix_glue.cpp` (the same four signatures; POSIX
  may answer "not on this platform" for the adapters and use `curl -L` for the redirect follow), `L/src/main.cpp`
  (the headless `--install-pcsx2 <dir>` and `--pcsx2-status <exe>`), `S/CMakeLists.txt`
- Test: `T/src/pcsx2_install_tests.cpp`; `tools_py/tests/test_launcher_pcsx2_install.py` (the headless form against a
  loopback server serving a stand-in "release")

**Interfaces:**
- Consumes: `launcher::patchfetch::verifyPackage` (exists), `win32glue::httpRequest`, `win32glue::httpDownload`.
- Produces:
```cpp
namespace launcher::pcsx2install {
    constexpr const char *kReleasesApi = "https://api.github.com/repos/PCSX2/pcsx2/releases/latest";
    constexpr const char *kReleasesApiEnv = "PS2X_LAUNCHER_PCSX2_API";   // TEST-ONLY, loopback only (patchfetch::patchBase's rule)
    constexpr const char *kAssetSuffix = "-windows-x64-Qt.7z";
    constexpr const char *kVersionMarker = "socom_unzipped_pcsx2.txt";    // the tag, written beside pcsx2-qt.exe by INSTALL
    constexpr const char *kExeName = "pcsx2-qt.exe";
    struct Release { std::string tag, assetName, url, sha256; uint64_t bytes = 0; };
    std::string releasesApi(const char *envValue);                          // kReleasesApi unless a loopback override
    bool parseLatestRelease(const std::string &json, Release &out, std::string &why);
    std::filesystem::path installDir(const std::filesystem::path &launcherDir);   // <launcherDir>/pcsx2
    // github.com or api.github.com (https) may redirect to an https host ending in ".githubusercontent.com"; nothing else.
    bool redirectAllowed(const std::string &fromUrl, const std::string &toUrl);
    // {"<SystemRoot>\System32\tar.exe", "-xf", archive, "-C", dest}
    std::vector<std::string> extractArgv(const std::string &systemRoot, const std::filesystem::path &archive, const std::filesystem::path &dest);
    struct Adapter { std::string guid; std::string name; bool hasGateway = false; };
    // preferred when it is in the list; else the first with a gateway; else the first; "" when the list is empty.
    std::string pickAdapter(const std::vector<Adapter> &adapters, const std::string &preferred);
    // "PCSX2 <tag> (installed by the launcher)" / "PCSX2 (your own copy)" / "" when exe is empty.
    std::string versionLine(const std::string &exe, const std::string &markerText);
}
namespace win32glue {
    using RedirectPolicy = std::function<bool(const std::string &from, const std::string &to)>;
    // httpDownload with `follow` deciding each 3xx (at most 3 hops); a null policy refuses as before.
    DownloadResult httpDownloadFollowing(const std::string &url, const std::filesystem::path &dest, const std::string &userAgent,
                                         int timeoutMs, const DownloadProgress &progress, const RedirectPolicy &follow);
    // argv[0] run with argv[1..], no shell, stdout+stderr to `log`, waited at most timeoutMs. The exit code; -1 and
    // `error` set when it could not start or timed out (then killed).
    int runAndWait(const std::vector<std::string> &argv, const std::filesystem::path &log, int timeoutMs, std::string &error);
    std::string resolveIpv4(const std::string &host);                  // "" when it does not resolve
    std::vector<launcher::pcsx2install::Adapter> listAdapters();        // GetAdaptersAddresses: the GUID as PCSX2 names it ("{...}"), friendly name, a gateway present
    // The generalised startGame: `exe` with `args`, in `workingDir`, inheriting the environment, stdout+stderr to <logDir>/pcsx2_<stamp>.log.
    bool startProcess(const std::string &exe, const std::vector<std::string> &args, const std::string &workingDir, const std::string &logDir, GameProcess &out);
}
```

- [ ] **Step 1: Write the failing pure tests** — `T/src/pcsx2_install_tests.cpp`:

```cpp
#include "MiniTest.h"
#include "launcher/pcsx2_install.h"
namespace pi = launcher::pcsx2install;

static const char *kJson = R"({"tag_name":"v2.8.2","name":"v2.8.2","assets":[
 {"url":"https://api.github.com/x/1","name":"pcsx2-v2.8.2-linux-appimage-x64-Qt.AppImage","size":60119544,"digest":"sha256:0c46bb6a88aa2782b10853a7b07cf3387ba99cbef2b966372cd2315b8571abea","browser_download_url":"https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-linux-appimage-x64-Qt.AppImage"},
 {"url":"https://api.github.com/x/2","name":"pcsx2-v2.8.2-windows-x64-Qt-symbols.7z","size":20962364,"digest":"sha256:b7736262b4d0228c72a2afc07dab7636af5c8a3d4fdb416058e2b070c370e26b","browser_download_url":"https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt-symbols.7z"},
 {"url":"https://api.github.com/x/3","name":"pcsx2-v2.8.2-windows-x64-Qt.7z","size":25670075,"digest":"sha256:7dfc829ca1994cc1045ac49f05e39b6cf968b72e6a374c40e05c2a2b4ac200b4","browser_download_url":"https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt.7z"}]})";

TEST_CASE("pcsx2_install: the Windows Qt 7z is picked, not the symbols one, with its size and digest")
{
    pi::Release r; std::string why;
    CHECK(pi::parseLatestRelease(kJson, r, why)); CHECK(why.empty());
    CHECK(r.tag == "v2.8.2"); CHECK(r.assetName == "pcsx2-v2.8.2-windows-x64-Qt.7z"); CHECK(r.bytes == 25670075u);
    CHECK(r.sha256 == "7dfc829ca1994cc1045ac49f05e39b6cf968b72e6a374c40e05c2a2b4ac200b4");
    CHECK(r.url == "https://github.com/PCSX2/pcsx2/releases/download/v2.8.2/pcsx2-v2.8.2-windows-x64-Qt.7z");
}

TEST_CASE("pcsx2_install: no Windows asset, another digest algorithm, or no digest is a refusal with a sentence (Review Focus 4)")
{
    pi::Release r; std::string why;
    CHECK(!pi::parseLatestRelease(R"({"tag_name":"v9","assets":[{"name":"pcsx2-v9-macos-Qt.tar.xz","size":1,"digest":"sha256:00","browser_download_url":"https://github.com/a"}]})", r, why));
    CHECK(why.find("windows-x64-Qt.7z") != std::string::npos);
    CHECK(!pi::parseLatestRelease(R"({"tag_name":"v9","assets":[{"name":"pcsx2-v9-windows-x64-Qt.7z","size":1,"digest":"md5:00","browser_download_url":"https://github.com/a"}]})", r, why));
    CHECK(!pi::parseLatestRelease(R"({"tag_name":"v9","assets":[{"name":"pcsx2-v9-windows-x64-Qt.7z","size":1,"browser_download_url":"https://github.com/a"}]})", r, why));
    CHECK(!pi::parseLatestRelease("", r, why));
    CHECK(!pi::parseLatestRelease(R"({"message":"API rate limit exceeded"})", r, why));
    CHECK(why.find("rate limit") != std::string::npos);
}

TEST_CASE("pcsx2_install: redirects only from github to githubusercontent, https both ways")
{
    CHECK(pi::redirectAllowed("https://github.com/PCSX2/pcsx2/releases/download/v2/x.7z", "https://objects.githubusercontent.com/github-production-release-asset/abc?x=1"));
    CHECK(pi::redirectAllowed("https://github.com/a", "https://release-assets.githubusercontent.com/b"));
    CHECK(!pi::redirectAllowed("https://github.com/a", "http://objects.githubusercontent.com/b"));
    CHECK(!pi::redirectAllowed("https://github.com/a", "https://githubusercontent.com.evil.example/b"));
    CHECK(!pi::redirectAllowed("https://github.com/a", "https://evil.example/githubusercontent.com"));
    CHECK(!pi::redirectAllowed("https://objects.githubusercontent.com/a", "https://objects.githubusercontent.com/b"));   // one hop from github only
    CHECK(!pi::redirectAllowed("https://example.com/a", "https://objects.githubusercontent.com/b"));
}

TEST_CASE("pcsx2_install: the api override is loopback only, as the patch base is")
{
    CHECK(pi::releasesApi(nullptr) == std::string(pi::kReleasesApi));
    CHECK(pi::releasesApi("http://127.0.0.1:8765/release.json") == "http://127.0.0.1:8765/release.json");
    CHECK(pi::releasesApi("https://evil.example/release.json") == std::string(pi::kReleasesApi));
}

TEST_CASE("pcsx2_install: the extract argv is the system tar with no shell, and the install dir is beside the launcher")
{
    const auto argv = pi::extractArgv("C:\\Windows", "C:\\s2u\\pcsx2\\pcsx2.7z.new", "C:\\s2u\\pcsx2");
    CHECK(argv.size() == 5); CHECK(argv[0] == "C:\\Windows\\System32\\tar.exe"); CHECK(argv[1] == "-xf"); CHECK(argv[3] == "-C");
    CHECK(pi::installDir("C:\\s2u") == std::filesystem::path("C:\\s2u") / "pcsx2");
}

TEST_CASE("pcsx2_install: the adapter pick prefers the saved one, then a gateway, then the first")
{
    const std::vector<pi::Adapter> a{{"{1}", "Bluetooth", false}, {"{2}", "Ethernet", true}, {"{3}", "Wi-Fi", true}};
    CHECK(pi::pickAdapter(a, "{3}") == "{3}"); CHECK(pi::pickAdapter(a, "{9}") == "{2}"); CHECK(pi::pickAdapter(a, "") == "{2}");
    CHECK(pi::pickAdapter({{"{1}", "x", false}}, "") == "{1}"); CHECK(pi::pickAdapter({}, "{1}").empty());
}

TEST_CASE("pcsx2_install: the version line")
{
    CHECK(pi::versionLine("", "").empty());
    CHECK(pi::versionLine("C:/s2u/pcsx2/pcsx2-qt.exe", "v2.8.2\n") == "PCSX2 v2.8.2 (installed by the launcher)");
    CHECK(pi::versionLine("C:/mine/pcsx2-qt.exe", "") == "PCSX2 (your own copy)");
}
```

- [ ] **Step 2: The Python end-to-end test on the headless form** — `tools_py/tests/test_launcher_pcsx2_install.py`
  (the `patch_fetch` test's shape: a loopback `http.server` on a free port): serve `/release.json` naming one asset
  `pcsx2-v0.0.0-windows-x64-Qt.7z` whose `browser_download_url` is `http://127.0.0.1:<port>/pcsx2.7z` (the loopback
  rule lets plain http through, as `httpDownload` does), its `size` and `sha256:` digest computed from a 7z the test
  builds with `tar.exe -cf stand.7z --format 7zip pcsx2-qt.exe` (bsdtar writes 7z; `pcsx2-qt.exe` a 16-byte stand-in);
  run `dist/socom_unzipped_launcher.exe --install-pcsx2 <tmpdir>` with `PS2X_LAUNCHER_PCSX2_API` set; assert exit 0,
  `<tmpdir>/pcsx2/pcsx2-qt.exe` exists with the stand-in's bytes, `<tmpdir>/pcsx2/portable.txt` exists,
  `<tmpdir>/pcsx2/socom_unzipped_pcsx2.txt` holds `v0.0.0`, and no `.7z` or `.part` remains. A second case serves a
  wrong digest: exit non-zero, no `pcsx2-qt.exe`, the sentence on stdout names the digest. Skip when the launcher exe
  is not built (the suite's convention).

- [ ] **Step 3: See both fail** (compile; the Python test's `FileNotFoundError` on the flag or exit 2).

- [ ] **Step 4: Implement the pure half** (`pcsx2_install.cpp`): `parseLatestRelease` — find `"message"` first (a
  rate-limit or error body: `why` = its value); `"tag_name"`; then the first index of `kAssetSuffix"` (the name's
  closing quote) whose preceding `"name":"` names it; the asset's object is from the last `{` before that `"name"`
  to the first `}` after it; inside: `"size":`, `"digest":"sha256:` (else refuse: "no sha256 digest for <asset>"),
  `"browser_download_url":"`. `redirectAllowed`: parse scheme and host of both (lower-case; the host ends at `/`,
  `:` or `?`); from host ∈ {github.com, api.github.com}, both https, to host ends with `.githubusercontent.com` and
  has a label before it. `releasesApi`: the same loopback rule as `patchfetch::patchBase` (call it if it is generic;
  else copy its regex). The rest are one-liners.

- [ ] **Step 5: Implement the glue** (`win32_glue.cpp`): `httpDownloadFollowing` — factor the body of `httpDownload`
  into a one-request function returning the status and `Location`; loop ≤ 3 hops while 301/302/303/307/308 and
  `follow(current, location)`; `httpDownload` = the following form with a null policy (its behaviour unchanged, its
  tests unchanged). `runAndWait` — `CreateProcessW` with a quoted argv (the `startGame` quoting helper), a log handle,
  `WaitForSingleObject(timeoutMs)`, `TerminateProcess` on timeout. `resolveIpv4` — `getaddrinfo` AF_INET. `listAdapters`
  — `GetAdaptersAddresses(AF_INET, GAA_FLAG_INCLUDE_GATEWAYS)`: `AdapterName` is the `{GUID}` PCSX2 writes as
  `EthDevice`; `FriendlyName`; `FirstGatewayAddress != nullptr`; skip loopback and tunnel types. `startProcess` — the
  general form; `startGame` calls it. `posix_glue.cpp`: `runAndWait` with `posix_spawn`; `resolveIpv4` the same;
  `listAdapters` empty; `httpDownloadFollowing` adds `-L --max-redirs 3` only when `follow` is non-null (the policy
  cannot be applied per hop there; say so in the header comment — the Linux client is out of scope, spec §2.4).

- [ ] **Step 6: The headless forms in `main.cpp`** — beside `--fetch-patch`:
  `--install-pcsx2 <dir>`: `releasesApi(getenv)` → `httpRequest("GET", api, "", 20000)` (User-Agent
  `SOCOM-Unzipped-Launcher/1.0`, `Accept: application/vnd.github+json`) → `parseLatestRelease` → `httpDownloadFollowing(url,
  installDir/ "pcsx2.7z.new", ua, 600000, progress to stdout every 5 %, redirectAllowed)` → `patchfetch::verifyPackage(…,
  bytes, sha256)` (a refusal deletes it) → `fs::create_directories(installDir)` → `runAndWait(extractArgv(getenv("SystemRoot"),
  archive, installDir), installDir/"extract.log", 300000)` (non-zero: "tar.exe exited N; see extract.log"; if T0 found the
  exe under a subfolder, move its contents up) → `installDir/kExeName` must exist → write `portable.txt` (empty) and
  `kVersionMarker` (the tag + `\n`) → delete the archive → print `installed PCSX2 <tag> at <dir>` → exit 0. Every
  refusal: one sentence on stdout, exit 1, nothing of PCSX2 left half-written (remove `installDir` when it did not
  exist before). `--pcsx2-status <exe>`: prints the version line, the data root, the BIOS folder and its file count.

- [ ] **Step 7: Build; run** — `ps2x_tests --filter pcsx2_install`, the Python test, then on this host once for real
  (lock-free; ~26 MB): `dist/socom_unzipped_launcher.exe --install-pcsx2 logs/s18_install_real` → the sentence, the
  exe, the marker; then delete `logs/s18_install_real` (R-C). Record the sentence in the Log.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(launcher): --install-pcsx2 -- the official release, verified by the API digest, extracted by the system tar (S18 T4)" -- third_party/ps2recomp/ps2xShared/include/launcher/pcsx2_install.h third_party/ps2recomp/ps2xShared/src/pcsx2_install.cpp third_party/ps2recomp/ps2xShared/CMakeLists.txt third_party/ps2recomp/ps2xLauncher/src/win32_glue.h third_party/ps2recomp/ps2xLauncher/src/win32_glue.cpp third_party/ps2recomp/ps2xLauncher/src/posix_glue.cpp third_party/ps2recomp/ps2xLauncher/src/main.cpp third_party/ps2recomp/ps2xTest/src/pcsx2_install_tests.cpp third_party/ps2recomp/ps2xTest/CMakeLists.txt tools_py/tests/test_launcher_pcsx2_install.py
```

---

### T5: The UI, part one — the client toggle, the rail per mode, the PCSX2 page

**Files:**
- Modify: `L/src/ui/focus.h`, `L/src/ui/focus.cpp` (`Page::Pcsx2`, `kPageCount = 10`, `pagesFor(mode)`,
  `railLayout(window, mode)`, `FocusGraph::build(window, in, mode)`, the `Pcsx2` case of `layoutFor`, the toggle's two
  nodes), `L/src/ui/pages.h` (`App` fields, `drawPcsx2Page`), `L/src/main.cpp` (`drawTopBar`: the toggle; load/save
  `launcher.json` and `config.pcsx2.json`; the probe; `requestClientMode`, `requestInstallPcsx2`, `requestBrowsePcsx2`,
  `requestOpenBios` handled in the loop), `L/CMakeLists.txt` (`page_pcsx2.cpp`, `page_pcsx2_tips.cpp`)
- Create: `L/src/ui/page_pcsx2.cpp`, `L/src/ui/page_pcsx2_tips.cpp`
- Test: `T/src/launcher_tests.cpp` (the rail and the graph per mode; the toggle nodes; the Pcsx2 layout inside the
  body; every `pcsx2.*` id has a tip)

**Interfaces:**
- Consumes: T2 (`ClientMode`, `Pcsx2Config`, the files), T4 (`Release`, the headless install's steps as a worker
  thread, `listAdapters`, `pickAdapter`, `versionLine`), T3 (`dataRoot`).
- Produces (in `ui`):
```cpp
enum class Page { Play = 0, Disc, Video, Audio, Controller, Microphone, Online, Report, About, Pcsx2 };   // appended: existing indices unchanged
constexpr int kPageCount = 10;
std::vector<Page> pagesFor(launcher::ClientMode mode);   // Native: the nine as today; Pcsx2: Play, Disc, Pcsx2, Online, Report, About
std::vector<Node> railLayout(Rect window, launcher::ClientMode mode);          // the rail rows for that mode, plus "bar.client.native" and "bar.client.pcsx2" (the toggle's two cells, in the header band, rail=true)
struct LayoutInputs { /* existing */ launcher::ClientMode mode = launcher::ClientMode::Native; bool pcsx2Installing = false; bool pcsx2HasExe = false; };
FocusGraph FocusGraph::build(Rect window, const LayoutInputs &in);           // builds pagesFor(in.mode) only
// App gains:
launcher::ClientMode mode; launcher::Pcsx2Config pcsx2; bool pcsx2Dirty = false;
struct Pcsx2Status { bool exeFound = false; std::string versionLine, dataRoot, biosDir; int biosFiles = 0; std::string adapterName; } pcsx2Status;
struct Pcsx2InstallUi { enum class State { Idle, Fetching, Downloading, Extracting, Done, Failed }; State state = State::Idle; std::string message; uint64_t bytes = 0; int64_t total = -1; } install;
launcher::ClientMode requestClientMode;   bool requestClientModeSet = false;
bool requestInstallPcsx2 = false, requestBrowsePcsx2 = false, requestOpenBios = false;
void drawPcsx2Page(const Ctx &ctx, App &app, const std::vector<Node> &nodes);
```
Node ids on the page: `pcsx2.select`, `pcsx2.install`, `pcsx2.bios.open`, `pcsx2.advanced`, `pcsx2.adapter` (cycles the
adapter list; shown when ADVANCED is open).

- [ ] **Step 1: Write the failing tests** (in `launcher_tests.cpp`, beside the existing rail tests):

```cpp
TEST_CASE("S18: the native rail is the nine pages as before; the PCSX2 rail is six, PCSX2 third")
{
    using ui::Page;
    const auto native = ui::pagesFor(launcher::ClientMode::Native);
    CHECK(native.size() == 9); CHECK(native[0] == Page::Play); CHECK(native[8] == Page::About);
    for (Page p : native) CHECK(p != Page::Pcsx2);
    const auto pcsx2 = ui::pagesFor(launcher::ClientMode::Pcsx2);
    CHECK(pcsx2 == std::vector<Page>{Page::Play, Page::Disc, Page::Pcsx2, Page::Online, Page::Report, Page::About});
}

TEST_CASE("S18: the rail layout carries the toggle's two cells in the header, and only that mode's pages")
{
    const ui::Rect window{0, 0, 1100, 700};
    const auto nodes = ui::railLayout(window, launcher::ClientMode::Pcsx2);
    int rails = 0; bool nat = false, pc = false;
    const ui::Frame f = ui::frameFor(window);
    for (const ui::Node &n : nodes)
    {
        if (n.id == "bar.client.native") { nat = true; CHECK(n.r.y >= f.header.y); CHECK(n.r.bottom() <= f.header.bottom()); }
        else if (n.id == "bar.client.pcsx2") pc = true;
        else { ++rails; CHECK(n.id != ui::railId(ui::Page::Video)); }
    }
    CHECK(nat); CHECK(pc); CHECK(rails == 6);
}

TEST_CASE("S18: the PCSX2 page's controls sit inside the body and every one has a tooltip")
{
    const ui::Rect window{0, 0, 1100, 700};
    ui::LayoutInputs in; in.mode = launcher::ClientMode::Pcsx2; in.advancedOpen = true;
    const auto nodes = ui::layoutFor(ui::Page::Pcsx2, window, in);
    const ui::Frame f = ui::frameFor(window);
    bool select = false, install = false, bios = false, adapter = false;
    for (const ui::Node &n : nodes)
    {
        CHECK(n.r.y >= f.body.y); CHECK(n.r.bottom() <= f.body.bottom() + 0.5f);
        CHECK(!ui::tipFor(n.id, ui::TipState{}).empty());
        select |= n.id == "pcsx2.select"; install |= n.id == "pcsx2.install"; bios |= n.id == "pcsx2.bios.open"; adapter |= n.id == "pcsx2.adapter";
    }
    CHECK(select); CHECK(install); CHECK(bios); CHECK(adapter);
    in.pcsx2Installing = true;
    for (const ui::Node &n : ui::layoutFor(ui::Page::Pcsx2, window, in)) CHECK(n.id != "pcsx2.install");   // no node while a download runs
}

TEST_CASE("S18: the graph for the native mode has no PCSX2 page and the PCSX2 mode no VIDEO page")
{
    const ui::Rect window{0, 0, 1100, 700};
    ui::LayoutInputs in;
    CHECK(ui::FocusGraph::build(window, in).find("pcsx2.install") == nullptr);
    CHECK(ui::FocusGraph::build(window, in).find(ui::railId(ui::Page::Video)) != nullptr);
    in.mode = launcher::ClientMode::Pcsx2;
    CHECK(ui::FocusGraph::build(window, in).find("pcsx2.install") != nullptr);
    CHECK(ui::FocusGraph::build(window, in).find(ui::railId(ui::Page::Video)) == nullptr);
    // From the first rail entry, Up lands on the toggle; from the toggle, Down returns to the rail.
    const ui::FocusGraph g = ui::FocusGraph::build(window, in);
    CHECK(g.move(ui::railId(ui::Page::Play), ui::Dir::Up).rfind("bar.client.", 0) == 0);
}
```
(`tipFor` is `tips.h`'s lookup; read its name there. If `FocusGraph::move` is named differently, use the name the
existing rail tests use.) Fix the existing tests that hard-code `kPageCount == 9` or walk nine rail rows: they
become `pagesFor(Native).size()`.

- [ ] **Step 2: See them fail** (compile).

- [ ] **Step 3: focus.h / focus.cpp** — append `Pcsx2` to `Page` and its `kPages` row
  `{"PCSX2", "PCSX2 -- the emulator that plays your disc, and where it keeps its own settings", "rail.pcsx2"}`;
  `pagesFor`; `railLayout(window, mode)` lays `pagesFor(mode)` down the rail and adds the two toggle cells in the
  header band right of the logo (`Rect{f.header.right() - 300, f.header.y + 10, 140, f.header.h - 20}` and the one
  beside it; read `drawTopBar`'s `l.pill` for the UNSAVED pill's rect and keep clear of it); `build(window, in)`
  iterates `pagesFor(in.mode)`; `move`: Up from any rail entry with nothing above goes to `bar.client.<current mode>`,
  Down from a toggle cell to the first rail entry. `layoutFor` `case Page::Pcsx2`: rows at the ONLINE page's pitch —
  INSTANCE (a read-only field `b.x + labelW`, width `b.w - labelW - 2*150 - 24`; SELECT 140 wide; INSTALL 140 wide,
  absent while `in.pcsx2Installing`), VERSION (text only), BIOS (text + `pcsx2.bios.open` 160 wide), the sentence
  rows (text only), `pcsx2.advanced` at the ONLINE page's advanced y, `pcsx2.adapter` under it when `in.advancedOpen`.

- [ ] **Step 4: page_pcsx2.cpp and page_pcsx2_tips.cpp** — the page draws: `rowLabel` "INSTANCE" + the exe path
  (`ellipsizeStart`, or "none -- SELECT one, or INSTALL the official release" dim when empty) + `button(SELECT)` →
  `app.requestBrowsePcsx2` + `button(INSTALL, enabled = state is Idle/Done/Failed)` → `app.requestInstallPcsx2`; under
  it, while installing, a `meterBar(bytes/total)` and the state's sentence ("fetching the release list", "downloading
  pcsx2-v2.8.2-windows-x64-Qt.7z: 12.4 of 25.7 MB", "extracting", "installed PCSX2 v2.8.2", the failure's sentence
  in `theme::warn`); "VERSION" + `pcsx2Status.versionLine`; "BIOS" + ("<n> file(s) in <biosDir>" or "none yet: put your
  PS2 BIOS dump in this folder" in warn) + `button(OPEN FOLDER)` → `app.requestOpenBios`; two captions: "PCSX2 keeps
  its own video, audio, controller and BIOS settings: open PCSX2 and use its Settings menu. The launcher writes only
  its network section and the SOCOM II patch." and "PCSX2 is free software (GPL v3) by the PCSX2 team,
  github.com/PCSX2/pcsx2. INSTALL downloads their official release; nothing of it ships with SOCOM Unzipped."; ADVANCED
  → "NETWORK ADAPTER" + `pcsx2Status.adapterName` + a cycle button `pcsx2.adapter` writing `app.pcsx2.ethDevice`
  (`app.pcsx2Dirty = true`). Tips (one line each, the owner's "little tooltip"): `pcsx2.select` "Pick a pcsx2-qt.exe you
  already have. The launcher writes only its network settings and the SOCOM II patch into it."; `pcsx2.install`
  "Downloads the latest official PCSX2 release (about 26 MB) from github.com/PCSX2/pcsx2 into this folder's pcsx2
  subfolder, checks it, and unpacks it. Your BIOS and disc stay yours."; `pcsx2.bios.open` "Opens the folder PCSX2 reads
  its BIOS from. Copy your own PS2 BIOS dump there; the game cannot start without one."; `pcsx2.advanced` "The network
  adapter PCSX2 binds; the launcher picks the one with your internet connection."; `pcsx2.adapter` live: "Binds PCSX2's
  network to <name>." Register the table where `tips.cpp` lists the pages' tables; add `bar.client.native` "Play the
  native PC build of SOCOM II (its own settings and pages)." and `bar.client.pcsx2` "Play your disc in PCSX2 against the
  same servers (its own settings and pages)." to the shared/top-bar table.

- [ ] **Step 5: main.cpp** — at start: `mode = parseClientMode(readText(dir / kClientModeFile))`,
  `pcsx2FromJson(readText(dir / kPcsx2ConfigFile), app.pcsx2)` (one stderr line when malformed), `probePcsx2(app, dir)`
  (exe exists → `pcsx2Status`: `versionLine(exe, readText(exeDir / kVersionMarker))`, `dataRoot(exeDir,
  exists(portable.txt|portable.ini), <Documents>)`, `biosDir = dataRoot / "bios"`, `biosFiles` = regular files ≥ 1 MiB
  there, `adapterName` from `listAdapters()` + `pickAdapter(…, app.pcsx2.ethDevice)`). `drawTopBar`: the two cells as
  `radioCell`s on the toggle's nodes; a click sets `requestClientMode`. In the loop: `requestClientModeSet` → save
  whichever config is dirty (never the other), write `launcher.json`, set `app.mode`, `nav.goTo(Page::Play)`, rebuild the
  graph with `in.mode`; `requestBrowsePcsx2` → the existing file dialog filtered to `pcsx2-qt.exe` → `app.pcsx2.pcsx2Exe`,
  `pcsx2Dirty`, `probePcsx2`; `requestOpenBios` → `create_directories(biosDir)`, `openFolder`; `requestInstallPcsx2` →
  the T4 headless steps on a worker thread (the REPORT page's thread pattern), the UI reading `install.state/bytes/total`
  under its mutex each frame; Done → `app.pcsx2.pcsx2Exe = installDir / kExeName`, `pcsx2Dirty`, `probePcsx2`. Save
  `config.pcsx2.json` wherever `config.json` is saved today (LAUNCH, close, the UNSAVED pill) — when `pcsx2Dirty`; the
  UNSAVED pill lights for either. `--screenshot`: add `Shot{Page::Pcsx2, 1100, 700, ""}` and `{…, "_installing"}` with a
  fixed `install` state, and a `Page::Play` shot in PCSX2 mode (`"_pcsx2"`).

- [ ] **Step 6: Build, run** — `./build.sh runtime`; `ps2x_tests --filter launcher` green (the new and the old);
  `dist/socom_unzipped_launcher.exe --screenshot` writes the new shots; open the launcher once: toggle, PCSX2 page,
  SELECT the T0 scratch exe, the BIOS count reads right, OPEN FOLDER opens it.

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(launcher): the NATIVE/PCSX2 toggle, a rail per client, the PCSX2 page with SELECT and INSTALL (S18 T5)" -- third_party/ps2recomp/ps2xLauncher/src/ui/focus.h third_party/ps2recomp/ps2xLauncher/src/ui/focus.cpp third_party/ps2recomp/ps2xLauncher/src/ui/pages.h third_party/ps2recomp/ps2xLauncher/src/ui/page_pcsx2.cpp third_party/ps2recomp/ps2xLauncher/src/ui/page_pcsx2_tips.cpp third_party/ps2recomp/ps2xLauncher/src/ui/tips.cpp third_party/ps2recomp/ps2xLauncher/src/main.cpp third_party/ps2recomp/ps2xLauncher/CMakeLists.txt third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp
```

---

### T6: The UI, part two — PLAY, DISC and ONLINE in the PCSX2 view; the launch; LAST RUN

**Files:**
- Modify: `L/src/ui/page_play.cpp`, `L/src/ui/page_disc.cpp`, `L/src/ui/page_online.cpp`, `L/src/ui/focus.cpp`
  (`layoutFor` Play/Online under `in.mode == Pcsx2`), `L/src/ui/pages.h` (`activeIsoPath(App&)`,
  `gameVersionRow` taking the mode), `L/src/main.cpp` (the launch block, the disc check on the active ISO, the
  `--selftest` lines), `S/include/launcher/launcher_config.h` + `.cpp` (`launchBlockedReasonPcsx2`, `pcsx2ExitLine`)
- Test: `T/src/launcher_tests.cpp`

**Interfaces:**
- Consumes: T2-T5. `win32glue::startProcess`, `pcsx2files::*`, `pcsx2install::pickAdapter`.
- Produces:
```cpp
namespace launcher {
    // "" when LAUNCH may start PCSX2; else the one sentence the bar shows, in this order of precedence.
    std::string launchBlockedReasonPcsx2(bool running, bool isoSet, bool discOk, const std::string &discMessage,
                                         bool exeFound, int biosFiles, const std::string &dnsError);
    // PCSX2's exit for the PLAY page's LAST RUN: 0 -> "PCSX2 closed"; else "PCSX2 exited with code N -- its log is <emulog>".
    std::string pcsx2ExitLine(int exitCode, const std::string &emulogPath);
    // The argv after the exe: {"-batch", iso} (T0's answer to question 2 may change this; one place).
    std::vector<std::string> pcsx2Args(const std::string &isoPath);
}
namespace ui { std::string &activeIsoPath(App &app); }   // config.isoPath or pcsx2.isoPath by mode
```

- [ ] **Step 1: Write the failing tests**

```cpp
TEST_CASE("S18: the PCSX2 launch is refused for the right reason, in order")
{
    using launcher::launchBlockedReasonPcsx2;
    CHECK(launchBlockedReasonPcsx2(true, true, true, "", true, 1, "") .find("running") != std::string::npos);
    CHECK(launchBlockedReasonPcsx2(false, false, false, "", true, 1, "").find("DISC") != std::string::npos);
    CHECK(launchBlockedReasonPcsx2(false, true, false, "not SOCOM II r0001", true, 1, "") == "not SOCOM II r0001");
    CHECK(launchBlockedReasonPcsx2(false, true, true, "", false, 1, "").find("PCSX2") != std::string::npos);
    CHECK(launchBlockedReasonPcsx2(false, true, true, "", true, 0, "").find("BIOS") != std::string::npos);
    CHECK(launchBlockedReasonPcsx2(false, true, true, "", true, 1, "cannot resolve x -- check your connection") == "cannot resolve x -- check your connection");
    CHECK(launchBlockedReasonPcsx2(false, true, true, "", true, 1, "").empty());
}

TEST_CASE("S18: PCSX2's exit line and argv")
{
    CHECK(launcher::pcsx2ExitLine(0, "C:/x/logs/emulog.txt") == "PCSX2 closed");
    CHECK(launcher::pcsx2ExitLine(3, "C:/x/logs/emulog.txt") == "PCSX2 exited with code 3 -- its log is C:/x/logs/emulog.txt");
    CHECK(launcher::pcsx2Args("D:/s2.iso") == std::vector<std::string>{"-batch", "D:/s2.iso"});
}

TEST_CASE("S18: the ONLINE layout in PCSX2 mode has the presets, the version row and ADDRESS, and none of the native-only rows")
{
    const ui::Rect window{0, 0, 1100, 700};
    ui::LayoutInputs in; in.mode = launcher::ClientMode::Pcsx2; in.customServer = true; in.advancedOpen = true; in.personaRows = 2;
    const auto nodes = ui::layoutFor(ui::Page::Online, window, in);
    bool preset = false, server = false, revision = false;
    for (const ui::Node &n : nodes)
    {
        CHECK(n.id.rfind("online.persona", 0) != 0); CHECK(n.id != "online.second"); CHECK(n.id != "online.advanced");
        preset |= n.id == "online.preset.1"; server |= n.id == "online.server"; revision |= n.id == "online.revision.0";
        CHECK(n.id != "online.revision.1");     // R-E: r0004 is drawn greyed, no node
    }
    CHECK(preset); CHECK(server); CHECK(revision);
}

TEST_CASE("S18: the PLAY layout in PCSX2 mode has four jump rows, the last to the PCSX2 page")
{
    const ui::Rect window{0, 0, 1100, 700};
    ui::LayoutInputs in; in.mode = launcher::ClientMode::Pcsx2;
    const auto nodes = ui::layoutFor(ui::Page::Play, window, in);
    int rows = 0; for (const ui::Node &n : nodes) rows += n.id.rfind("play.row.", 0) == 0;
    CHECK(rows == 4);
}
```
(Read `layoutFor`'s Play case for the row ids' real prefix and use it.)

- [ ] **Step 2: See them fail.**

- [ ] **Step 3: Implement** — `launcher_config.cpp`: the three functions (`launchBlockedReasonPcsx2`'s sentences:
  "the game is running", "no disc set yet: pick your SOCOM II image on the DISC page", `discMessage`, "no PCSX2 yet:
  SELECT or INSTALL one on the PCSX2 page", "no BIOS yet: put your PS2 BIOS dump in PCSX2's bios folder (the PCSX2
  page)", `dnsError`). `pages.h`: `activeIsoPath`; `gameVersionRow(ctx, app, nodes, page)` reads `app.mode`: in PCSX2
  mode the chosen id is `app.pcsx2.gameRevision`, `installed` is `1u << 0` only (R-E) and the greyed note is
  `kPcsx2RevisionNote`, a click writes `app.pcsx2.gameRevision` and `pcsx2Dirty`. `focus.cpp` `layoutFor`: Online under
  `in.mode == Pcsx2` emits the presets, `addRevisionCells` with r0004 absent, `online.server` when `in.customServer`, and
  nothing else; Play's four rows are DISC, SERVER, GAME VERSION, PCSX2 (jump to `Page::Pcsx2`). `page_play.cpp`: in
  PCSX2 mode the rows read `app.pcsx2` and `pcsx2Status` (the fourth row: the version line or "none"), LAST RUN shows
  `app.exitLine` as today; the "which build LAUNCH will start" sentence becomes "LAUNCH starts PCSX2 on your disc".
  `page_disc.cpp`: every `c.isoPath` → `activeIsoPath(app)` (one accessor, both modes). `page_online.cpp`: branch on
  `app.mode` once at the top: the PCSX2 view draws SERVER (the same loop; the community row's `kPresetComingSoonNote`),
  `gameVersionRow`, ADDRESS bound to `app.pcsx2.serverPreset/server`, and in the personas' place one caption: "Personas
  are made in the game: CONNECT TO SOCOM II, then CREATE NEW on its own screen. PCSX2 keeps them on its memory card." —
  nothing below it. `main.cpp`'s launch block: `if (app.mode == Pcsx2)`: `probePcsx2`; `dns = dnsServerFor(app.pcsx2,
  win32glue::resolveIpv4)`; `reason = launchBlockedReasonPcsx2(app.running, !iso.empty(), app.discOk, app.discMessage,
  exeFound, biosFiles, dns.error)`; refused → `setStatus(reason)`; else write `config.pcsx2.json`; `root = dataRoot(...)`;
  `ini = root/"inis"/kIniName`: `writeIfDifferent(ini, mergeIniSection(readText(ini), "DEV9/Eth", dev9Keys(dns.ip,
  pickAdapter(listAdapters(), app.pcsx2.ethDevice))), stamp, err)`; `writeIfDifferent(root/"patches"/kPnachName,
  kPnachMaster, stamp, err)`; a managed install (exe under `installDir(dir)`) also `create_directories(root/"memcards")`
  and `root/"bios"`; then `startProcess(exe, pcsx2Args(iso), exeDir, (dir/"logs").string(), game)` → `app.running`,
  status "PCSX2 started". When it exits: `app.exitLine = pcsx2ExitLine(code, (root/"logs"/"emulog.txt").string())`. The
  disc check at start and on DISC's VERIFY runs on `activeIsoPath`. `--selftest` prints `client: <mode>`, `pcsx2 config:
  <path>` and `pcsx2 exe: <exe or none>` after the existing lines.

- [ ] **Step 4: Build, run** — the tests; then in the window: toggle to PCSX2, SELECT the T0 scratch exe, DISC = the
  owner's ISO, LAUNCH → PCSX2 opens the game (T7 takes it from there); switch back to NATIVE: the native PLAY page, its
  `config.json` untouched (`git diff --no-index` of a copy taken before against after: identical).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(launcher): the PCSX2 view of PLAY, DISC and ONLINE; LAUNCH writes DEV9 + the pnach and starts PCSX2 (S18 T6)" -- third_party/ps2recomp/ps2xLauncher/src/ui/page_play.cpp third_party/ps2recomp/ps2xLauncher/src/ui/page_disc.cpp third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp third_party/ps2recomp/ps2xLauncher/src/ui/focus.cpp third_party/ps2recomp/ps2xLauncher/src/ui/pages.h third_party/ps2recomp/ps2xLauncher/src/main.cpp third_party/ps2recomp/ps2xShared/include/launcher/launcher_config.h third_party/ps2recomp/ps2xShared/src/launcher_config.cpp third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp
```

---

### T7: The proof — INSTALL → BIOS → LAUNCH → the wizard → our lobby, from this host

**Files:**
- Scratch: `logs/s18_proof/` (the launcher's log, PCSX2's emulog, the shots)
- Modify: `docs/KNOWN.md` (one row, via the `doc-maintenance` skill), the plan's Log

**Interfaces:**
- Consumes: T1 live on the box (53/udp answering), T2-T6 merged into `sprint-18`, a built `dist/portable/socom2/`.

- [ ] **Step 1: A clean home** — copy `dist/portable/socom2/` to `logs/s18_proof/home/` (no `config.json`, no
  `launcher.json`, no `pcsx2/`). The launcher opens in NATIVE (the default): screenshot `01_native.png`.

- [ ] **Step 2: PCSX2 mode, INSTALL** — toggle; the PCSX2 page; INSTALL; the meter runs; "installed PCSX2 v2.8.x"
  (`02_installed.png`); `home/pcsx2/pcsx2-qt.exe`, `portable.txt`, `socom_unzipped_pcsx2.txt` exist; no `.7z` left.

- [ ] **Step 3: BIOS** — OPEN FOLDER; copy the owner's BIOS dump in (from `tools/pcsx2/bios/`); the page reads "1 file"
  (`03_bios.png`).

- [ ] **Step 4: DISC, ONLINE** — DISC: the owner's r0001 ISO, verified; ONLINE: SOCOM Unzipped selected, the community
  row greyed "coming soon", r0004 greyed (`04_online.png`).

- [ ] **Step 5: LAUNCH, in the window** (`run-gate` skill; the lock; O20) — PCSX2 opens; the game boots; its network
  wizard: memory card slot 1 → Ethernet → auto-detect → PPPoE not required → IP automatic → DNS automatic → save
  (research/18 lines 157-160; **never** type a DNS by hand there); CONNECT TO SOCOM II → CREATE NEW persona (a name for
  this proof: `s18pcsx2`) → the lobby (`05_lobby.png`). Read `home/pcsx2/inis/PCSX2.ini`'s `[DEV9/Eth]` (DNS1 =
  3.143.65.100, EthDevice set), `home/pcsx2/patches/0F6FC6CF.pnach` (= the master), `home/pcsx2/logs/emulog.txt` (the
  patches line; the DHCP/DNS lines showing the guest asked 3.143.65.100), and the box's journal
  (`vm/lightsail/ssh.sh 'journalctl -u socom-dns --no-pager -n 5'`: the minute's `answered` count rose). Close the game:
  PLAY's LAST RUN reads "PCSX2 closed".

- [ ] **Step 6: Record** — copy the emulog, the launcher log, the ini, the five shots into `logs/s18_proof/`; the KNOWN
  row: *"The launcher's PCSX2 client reaches our lobby from a clean home (date, Sprint 18 T7): INSTALL fetched
  v2.8.x…, the DEV9 section and the guarded pnach written, the box's name service answered, the wizard on automatic,
  persona s18pcsx2 made in the game, LOBBY"* with the artefacts; the plan's Log entry with the stamp.

- [ ] **Step 7: Commit the row**

```bash
git commit -m "docs(known): the PCSX2 client reaches our lobby from a clean home through INSTALL, the DEV9 merge and the box's name service (S18 T7)" -- docs/KNOWN.md docs/superpowers/plans/2026-10-01-sprint-18-the-pcsx2-door.md
```

---

### T8: The documents

**Files:**
- Modify: `docs/DEVELOPING.md` (the launcher's files: `launcher.json`, `config.pcsx2.json`, the headless forms
  `--install-pcsx2`, `--pcsx2-status`; the box section: `socom-dns`), `server/README.md` ("Hosting it on Linux": the
  fifth unit, 53/udp, what it answers), `docs/LATER.md` (the §2.4 rows: r0004 on PCSX2, the PCSX2 personas list, a
  second PCSX2 instance, the Linux PCSX2 client, a public DNS zone, a real PS2), `docs/HUMAN_TASKS.md` (O29 the
  two-home round and the player group's first run; O30 the site copy), `docs/CURRENT_SPRINT.md` (the Sprint 18
  block), `docs/HAZARDS.md` (one line: a player's own PCSX2 is merged, never rewritten — the `.bak-<stamp>` is the
  way back)
- Create: `docs/PCSX2_PLAY.md` <!-- docmaint: future -->

**Interfaces:** none; every fact here is T1-T7's, with its artefact.

- [ ] **Step 1: `docs/PCSX2_PLAY.md`** — the player guide, in the launcher's voice, under 120 lines: what you need <!-- docmaint: future -->
  (the launcher archive, your r0001 ISO, your PS2 BIOS dump, Windows 10 1803 or later); the six steps of T7 as a
  player does them, one screenshot name each; hosting ("whoever creates the game is the host; the others send their
  game traffic straight to the host's address on UDP 3658; if joiners see *Disconnected from Game*, the host's router
  needs one UDP port forward to that PC, or pick the player with the friendliest router as the standing host");
  everyone on the plain disc (the revision rule); what the launcher writes into PCSX2 and what it never touches;
  where PCSX2's own settings are; a real PS2 in one paragraph (a LAN DNS pointing the six names at 3.143.65.100, the
  DNAS bypass from the r0004 card package, the console's DNS set to that LAN address — nothing built, the path named).

- [ ] **Step 2: DEVELOPING and the server README** — invoke `doc-maintenance`; add the lines; run
  `python -m unittest tools_py.tests.test_doc_maintenance` (the ceilings and the dated counts).

- [ ] **Step 3: LATER, HUMAN_TASKS, HAZARDS, CURRENT_SPRINT** — the rows named above; the Sprint 18 block in
  CURRENT_SPRINT points at the plan, the spec and this book.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: Sprint 18 -- the PCSX2 client's guide, the box's name service, the LATER rows and the owner's rows" -- docs/PCSX2_PLAY.md docs/DEVELOPING.md server/README.md docs/LATER.md docs/HUMAN_TASKS.md docs/HAZARDS.md docs/CURRENT_SPRINT.md <!-- docmaint: future -->
```

---

## Self-review (2026-10-01, the controller, against the spec)

- **Coverage:** §2.3 item 1 → T1; 2 → T2 + T5; 3 → T5; 4 → T6; 5 → T3 + T6; 6 → T7; 7 → T8. §2.2 R-A: T2 (two
  files) + T5 (the toggle saves one, never the other — Review Focus 5's test is T5 Step 1's graph test plus T6 Step 4's
  diff); R-B: T2 Step 4 + T6 (both views draw the greyed row); R-C: T4; R-D: T1; R-E: T6 (`installed = 1u << 0`,
  `kPcsx2RevisionNote`); R-F: T3 (`mergeIniSection`, `writeIfDifferent`) + T6 (only the two writes, the folders only
  for a managed install). §3 → T0.
- **Placeholders:** none; every step has its command or its code; the one open design point (the exe's folder depth
  inside the 7z, `-batch`'s exact form) is T0's and is named where T4 and T6 consume it.
- **Names:** `ClientMode`, `Pcsx2Config`, `pcsx2EffectiveServer`, `kPresetComingSoonNote`, `kPcsx2RevisionNote` (T2) are
  what T3, T5, T6 use; `dataRoot`, `dev9Keys`, `mergeIniSection`, `dnsServerFor`, `writeIfDifferent`, `kPnachMaster`
  (T3) are what T6 calls; `installDir`, `kExeName`, `kVersionMarker`, `versionLine`, `pickAdapter`, `listAdapters`,
  `resolveIpv4`, `startProcess` (T4) are what T5/T6 call; `pagesFor`, `railLayout(window, mode)`, `LayoutInputs::mode`
  (T5) are what T6's layout tests use.
- **Review Focus:** 1 → T2 Step 1 (unknown/missing/malformed); 2 → T3 Step 1 (the merge test); 3 → T3 Step 1 (the pick)
  and T6 Step 1 (the refusal); 4 → T4 Step 1 (parse refusals, the redirect policy) and Step 2 (the wrong digest); 5 →
  T5 Step 5 (save the dirty one only) checked by T6 Step 4's byte-for-byte diff of `config.json` across a toggle.
