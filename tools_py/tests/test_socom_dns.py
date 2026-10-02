"""server/linux/socom_dns.py: the hosted box's name service (Sprint 18 T1, R-D).

It answers SOCOM II's six retail host names with muis.json's Endpoint and NXDOMAIN for anything else, caps each
source's queries per second, and never sends more than the echoed question plus one 16-byte A record (it must not be
an amplifier). The unit, its wrapper, install.sh and horizon-ctl.sh carry it beside the four Horizon units.
"""
import importlib.util, json, os, pathlib, struct, subprocess, unittest

from tools_py.tests.shell import BASH

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("socom_dns", ROOT / "server" / "linux" / "socom_dns.py")
socom_dns = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(socom_dns)
LINUX = ROOT / "server" / "linux"


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

    def test_a_flood_of_distinct_sources_prunes_at_most_once_a_second(self):
        # T1 review: pruning on every call past 4096 sources cost 9.2 s of CPU for 20,000 spoofed sources in one
        # second. It runs at most once a second; memory stays bounded by one second's sources.
        cap = socom_dns.RateCap(per_second=20)
        for i in range(5000):
            self.assertTrue(cap.allow("10.%d.%d.1" % (i // 256, i % 256), 200.5))
        self.assertLessEqual(cap.prunes, 1)
        cap.allow("203.0.113.200", 201.2)                                  # the next second may prune again
        self.assertLessEqual(cap.prunes, 2)
        self.assertEqual(list(cap.buckets), ["203.0.113.200"])             # the old second's sources are forgotten


class MuisEndpointTests(unittest.TestCase):
    def test_endpoint_read_from_muis_json(self):
        text = '{"Universes":[{"Name":"SOCOM II","Endpoint":"3.143.65.100","Port":10075}]}'
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_a_hostname_endpoint_is_refused(self):
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis('{"Universes":[{"Endpoint":"socom.scotho.com"}]}')

    @staticmethod
    def universe(endpoint, enabled=True, name="SOCOM II Local"):
        return {"Enabled": enabled, "Name": name, "Description": "d", "Endpoint": endpoint, "SvoURL": "",
                "ExtendedInfo": "", "Port": 10075, "UniverseId": 1}

    def muis(self, universes):
        return json.dumps({"RefreshConfigInterval": 5000, "Ports": [10071], "EncryptMessages": True,
                           "Universes": universes, "Logging": {"LogLevel": 1}})

    def test_the_box_shape_a_dict_of_app_id_lists_is_read(self):
        # The box's muis.json (2026-10-02, KeyError: 0 on deploy): Universes is the C# Dictionary<int, UniverseInfo[]>.
        text = self.muis({"10472": [self.universe("3.143.65.100")],
                          "0": [self.universe("3.143.65.100", name="Default Local")]})
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_the_repo_config_shape_is_read(self):
        text = (ROOT / "server" / "config" / "muis.json").read_text(encoding="utf-8")
        self.assertEqual(socom_dns.endpoint_from_muis(text), "192.0.2.1")

    def test_universes_disagreeing_on_the_endpoint_are_refused_naming_both(self):
        text = self.muis({"10472": [self.universe("3.143.65.100")], "0": [self.universe("198.51.100.7")]})
        with self.assertRaises(SystemExit) as cm:
            socom_dns.endpoint_from_muis(text)
        self.assertIn("3.143.65.100", str(cm.exception.code))
        self.assertIn("198.51.100.7", str(cm.exception.code))

    def test_a_disabled_universe_is_ignored(self):
        text = self.muis({"10472": [self.universe("3.143.65.100")],
                          "0": [self.universe("198.51.100.7", enabled=False)]})
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_a_disabled_universe_with_a_hostname_is_ignored_too(self):
        text = self.muis({"0": [self.universe("socom.scotho.com", enabled=False), self.universe("3.143.65.100")]})
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_no_enabled_universe_is_refused(self):
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis(self.muis({"10472": [self.universe("3.143.65.100", enabled=False)]}))
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis(self.muis({}))

    def test_a_single_object_value_is_accepted(self):
        self.assertEqual(socom_dns.endpoint_from_muis(self.muis({"10472": self.universe("3.143.65.100")})),
                         "3.143.65.100")

    def test_an_octet_over_255_is_refused(self):
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis(self.muis({"10472": [self.universe("3.143.65.256")]}))


class BoxWiringTests(unittest.TestCase):
    """The unit sits beside the four Horizon units: installed, enabled, started, stopped and listed with them."""

    def read(self, name):
        return (LINUX / name).read_text(encoding="utf-8")

    def test_the_unit_belongs_to_the_horizon_target_and_may_bind_53(self):
        unit = self.read("socom-dns.service")
        self.assertIn("PartOf=horizon.target", unit)
        self.assertIn("WantedBy=horizon.target", unit)
        self.assertIn("AmbientCapabilities=CAP_NET_BIND_SERVICE", unit)
        self.assertIn("ExecStart=/bin/bash /opt/socom-unzipped-server/linux/socom-dns.sh", unit)
        self.assertIn("User=horizon", unit)

    def test_the_wrapper_never_binds_the_wildcard(self):
        sh = self.read("socom-dns.sh")
        self.assertIn("socom_dns.py --bind", sh)
        self.assertIn("--muis /opt/socom-unzipped-server/config/muis.json", sh)
        self.assertNotIn("0.0.0.0", sh)

    def dry_run(self, addrs):
        env = {**os.environ, "SOCOM_DNS_HOST_ADDRS": addrs, "SOCOM_DNS_DRY_RUN": "1"}
        return subprocess.run([BASH, str(LINUX / "socom-dns.sh")], capture_output=True, text=True, env=env,
                              timeout=60)

    @unittest.skipUnless(BASH, "no bash on this host")
    def test_the_wrapper_binds_the_first_dotted_quad(self):
        r = self.dry_run("fe80::1 192.0.2.4 198.51.100.9")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "192.0.2.4"), r.stderr)

    @unittest.skipUnless(BASH, "no bash on this host")
    def test_the_wrapper_refuses_a_host_without_ipv4(self):
        r = self.dry_run("fe80::1")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertIn("socom-dns", r.stderr)

    def test_install_sh_installs_and_enables_the_unit(self):
        sh = self.read("install.sh")
        install = [l for l in sh.splitlines() if l.startswith("install -m 0644")]
        self.assertTrue(any("socom-dns.service" in l for l in install), install)
        enable = [l for l in sh.splitlines() if l.startswith("systemctl enable")]
        self.assertTrue(any("socom-dns.service" in l for l in enable), enable)
        self.assertIn("socom_dns.py", sh)                              # made executable

    def test_horizon_ctl_carries_it_in_its_one_unit_list(self):
        sh = self.read("horizon-ctl.sh")
        units = [l for l in sh.splitlines() if l.startswith("UNITS=(")]
        self.assertEqual(len(units), 1, units)
        self.assertIn("socom-dns", units[0])
        self.assertIn("udp 53", sh)                                    # status's listener table names it


if __name__ == "__main__":
    unittest.main()
