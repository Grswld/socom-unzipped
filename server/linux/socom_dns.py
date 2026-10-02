#!/usr/bin/env python3
"""socom-dns: answers SOCOM II's six retail host names with this server's own address, NXDOMAIN for anything else.
Sprint 18 (R-D). Pure functions on top (tested by tools_py/tests/test_socom_dns.py); main() binds UDP 53 on the
interface given and serves. Usage: socom_dns.py --bind <private ip> --muis /opt/socom-unzipped-server/config/muis.json
Quiet: one journal line a minute with the counts, never a line per query.
Not an amplifier: a reply is the query's header and question plus at most one 16-byte A record (anything after the
question -- an EDNS record, padding -- is never echoed), and each source is capped at --per-second queries."""
import argparse, collections, json, re, socket, struct, sys, time

NAMES = {
    "socom2-prod.pdonline.scea.com", "socom2-prod.muis.pdonline.scea.com",
    "gate1.us.dnas.playstation.org", "gate1.jp.dnas.playstation.org", "gate1.eu.dnas.playstation.org",
    "www.playstation.org",
}
_IPV4 = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$")
LOG_EVERY = 60.0


SOCOM_APP_ID = "10472"


def endpoint_from_muis(text):
    """The one address every enabled universe in muis.json names; SystemExit when there is none, it is not a dotted
    quad, or two disagree. Universes is the server's Dictionary<int, UniverseInfo[]> ({"10472": [{...}], "0": [...]});
    a bare list of universe objects (and a single object in place of a list) is accepted too."""
    universes = json.loads(text).get("Universes")
    if isinstance(universes, dict):
        groups = sorted(universes.items(), key=lambda kv: kv[0] != SOCOM_APP_ID)   # 10472 first, else file order
    elif isinstance(universes, list):
        groups = [(None, universes)]
    else:
        sys.exit("socom-dns: muis.json has no Universes dict or list")
    found = []   # (where, endpoint), enabled universes only
    for key, group in groups:
        for u in (group if isinstance(group, list) else [group]):
            if not isinstance(u, dict) or u.get("Enabled", True) is False:
                continue
            ep = u.get("Endpoint")
            where = "Universes[%s] %r" % (key, u.get("Name", "?")) if key is not None else repr(u.get("Name", "?"))
            if not isinstance(ep, str) or not _IPV4.match(ep) or any(int(x) > 255 for x in ep.split(".")):
                sys.exit("socom-dns: muis.json %s Endpoint %r is not a dotted IPv4 address; the answer must be one"
                         % (where, ep))
            found.append((where, ep))
    if not found:
        sys.exit("socom-dns: muis.json has no enabled universe with an Endpoint")
    others = [(w, e) for w, e in found if e != found[0][1]]
    if others:
        sys.exit("socom-dns: muis.json's enabled universes disagree: %s says %s but %s says %s; one DNS answer cannot"
                 " serve two addresses" % (found[0][0], found[0][1], others[0][0], others[0][1]))
    return found[0][1]


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
    """At most per_second queries from one source in one wall-clock second; every source is its own bucket."""

    PRUNE_ABOVE = 4096

    def __init__(self, per_second):
        self.per_second = per_second
        self.buckets = {}   # source -> (second, count)
        self.pruned_at = None   # the second of the last prune
        self.prunes = 0

    def allow(self, source, now):
        second = int(now)
        s, n = self.buckets.get(source, (second, 0))
        if s != second:
            s, n = second, 0
        if n >= self.per_second:
            return False
        self.buckets[source] = (s, n + 1)
        # Forget every source not seen this second, at most once a second: a flood of spoofed sources must not
        # rebuild the dict on every datagram (T1 review: 20,000 sources in one second cost 9.2 s of CPU that way).
        # Memory stays bounded by one second's distinct sources.
        if len(self.buckets) > self.PRUNE_ABOVE and self.pruned_at != second:
            self.buckets = {k: v for k, v in self.buckets.items() if v[0] == second}
            self.pruned_at = second
            self.prunes += 1
        return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="SOCOM II's six retail host names -> muis.json's Endpoint, on UDP")
    ap.add_argument("--bind", required=True, help="the address to bind (the box's private IPv4, never the wildcard)")
    ap.add_argument("--port", type=int, default=53)
    ap.add_argument("--muis", required=True, help="muis.json; the Endpoint its enabled universes share is the answer")
    ap.add_argument("--per-second", type=int, default=20, help="queries a second answered per source")
    a = ap.parse_args(argv)
    with open(a.muis, encoding="utf-8") as f:
        answer_ip = endpoint_from_muis(f.read())
    answer = bytes(int(x) for x in answer_ip.split("."))
    cap = RateCap(a.per_second)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((a.bind, a.port))
    s.settimeout(LOG_EVERY)               # an idle minute still closes the minute's line
    print("socom-dns listening on %s:%d, answering %s for %d names, %d/s per source"
          % (a.bind, a.port, answer_ip, len(NAMES), a.per_second), flush=True)
    counts = collections.Counter(); last = time.time()
    while True:
        try:
            data, addr = s.recvfrom(512)
        except socket.timeout:
            data = None
        except OSError:                   # an ICMP error surfacing on the socket: not fatal for a UDP server
            counts["errors"] += 1; data = None
        now = time.time()
        if data is not None:
            if not cap.allow(addr[0], now):
                counts["capped"] += 1
            else:
                resp = respond(data, answer, NAMES)
                if resp is None:
                    counts["dropped"] += 1
                else:
                    try:
                        s.sendto(resp, addr)
                        counts["answered" if resp[7] else "nxdomain"] += 1
                    except OSError:
                        counts["errors"] += 1
        if now - last >= LOG_EVERY:
            if counts:                    # a silent minute writes nothing
                print("socom-dns last minute: %s" % dict(sorted(counts.items())), flush=True)
            counts.clear(); last = now


if __name__ == "__main__":
    main()
