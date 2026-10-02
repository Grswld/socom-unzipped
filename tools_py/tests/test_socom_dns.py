"""server/linux/socom_dns.py: the hosted box's name service (Sprint 18 T1, R-D).

It answers SOCOM II's six retail host names with muis.json's Endpoint and NXDOMAIN for anything else, caps each
source's queries per second, and never sends more than the echoed question plus one 16-byte A record (it must not be
an amplifier). The unit, its wrapper, install.sh and horizon-ctl.sh carry it beside the four Horizon units.
"""
import importlib.util, pathlib, struct, unittest

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


class MuisEndpointTests(unittest.TestCase):
    def test_endpoint_read_from_muis_json(self):
        text = '{"Universes":[{"Name":"SOCOM II","Endpoint":"3.143.65.100","Port":10075}]}'
        self.assertEqual(socom_dns.endpoint_from_muis(text), "3.143.65.100")

    def test_a_hostname_endpoint_is_refused(self):
        with self.assertRaises(SystemExit):
            socom_dns.endpoint_from_muis('{"Universes":[{"Endpoint":"socom.scotho.com"}]}')


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
