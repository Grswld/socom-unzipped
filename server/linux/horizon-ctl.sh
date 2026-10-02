#!/usr/bin/env bash
# The hosted Horizon stack on Linux (Sprint 8 Goal 12): start-servers.ps1's verbs over the systemd units.
#
#   horizon-ctl.sh start | stop | restart        the four units and socom-dns (horizon.target), as root or sudo
#   horizon-ctl.sh status                        the units, the listeners against the port table, the advertised address
#   horizon-ctl.sh show-ip                       the address clients are told to dial back on
#   horizon-ctl.sh public-ip <ip or hostname>    rewrite that address; restart afterwards for it to take
#   horizon-ctl.sh check                         exit 2 while that address is still an RFC 5737 placeholder
#   ... [--config-dir <dir>]                     default: <the folder above this script>/config
#
# ADVERTISED ADDRESS. Everything binds 0.0.0.0, but Medius and MUIS also hand the client an address in their
# replies, and the client dials it. public-ip rewrites exactly those fields -- medius.json PublicIpOverride and
# NATIp, dme.json PublicIpOverride, every muis.json Endpoint -- as a targeted edit of the raw text (every other
# byte preserved), and refuses to write a file that would not parse back as JSON. dme.json's MPS.Ip is DME
# reaching Medius on the same machine: it stays 127.0.0.1 and is never touched. On a cloud box the advertised
# address is the public (static) one, not the private one the interface carries.
# start and restart run `check` first (Sprint 13 S6): the tracked configs hold the RFC 5737 placeholder
# 192.0.2.1, and a stack that would advertise a documentation address is refused before systemctl is reached.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$(dirname "$HERE")/config"
UNITS=(horizon-nat horizon-muis horizon-medius horizon-dme socom-dns)

PY="$(command -v python3 || command -v python || true)"

verb="${1:-}"; [ $# -gt 0 ] && shift
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --config-dir) [ $# -ge 2 ] || { echo "horizon-ctl: --config-dir needs a directory" >&2; exit 2; }; CONFIG_DIR="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

need_python() { [ -n "$PY" ] || { echo "horizon-ctl: python3 is needed for this verb" >&2; exit 2; }; }

advertised() {  # advertised show | advertised set <addr>
  need_python
  "$PY" - "$CONFIG_DIR" "$@" <<'PYEOF'
import json, os, re, sys

config_dir, mode = sys.argv[1], sys.argv[2]
PLAN = (("medius.json", ("PublicIpOverride", "NATIp")), ("dme.json", ("PublicIpOverride",)), ("muis.json", ("Endpoint",)))
IPV4 = re.compile(r"^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$")
HOST = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$")


def field_pattern(key):
    return re.compile(r'("' + re.escape(key) + r'"\s*:\s*")([^"]*)(")')


def read(path):
    with open(path, "rb") as f:
        return f.read().decode("utf-8")


if mode == "show":
    print("Advertised address (what clients are told to connect back to), from %s:" % config_dir)
    seen = set()
    for name, keys in PLAN:
        path = os.path.join(config_dir, name)
        if not os.path.isfile(path):
            print("  %-11s missing" % name)
            continue
        text = read(path)
        for key in keys:
            for m in field_pattern(key).finditer(text):
                seen.add(m.group(2))
                print("  %-11s %-18s %s" % (name, key, m.group(2)))
    if len(seen) > 1:
        print("WARNING: advertised addresses disagree (%s) - clients will be sent to different hosts; use public-ip."
              % ", ".join(sorted(seen)))
    dme = os.path.join(config_dir, "dme.json")
    if os.path.isfile(dme):
        print("  %-11s %-18s %s   (host-local: DME -> Medius, leave as 127.0.0.1)"
              % ("dme.json", "MPS.Ip", json.loads(read(dme)).get("MPS", {}).get("Ip")))
    sys.exit(0)

if mode == "check":
    # Sprint 13 S6: the advertised address is a REQUIRED value. The tracked configs carry an RFC 5737
    # documentation placeholder, never anybody's own network; a stack that would hand one to clients is refused.
    doc = re.compile(r"^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$")
    bad, values = [], set()
    for name, keys in PLAN:
        path = os.path.join(config_dir, name)
        if not os.path.isfile(path):
            continue
        text = read(path)
        for key in keys:
            for m in field_pattern(key).finditer(text):
                if doc.match(m.group(2)):
                    if "%s %s" % (name, key) not in bad:
                        bad.append("%s %s" % (name, key))
                    values.add(m.group(2))
    if bad:
        sys.stderr.write("horizon-ctl: the advertised address is not set -- %s still hold %s, a documentation "
                         "placeholder (RFC 5737) that no client can reach. Run horizon-ctl.sh public-ip <this box's "
                         "public address> (it rewrites medius.json, dme.json and muis.json), then start again. "
                         "Nothing was started.\n" % (", ".join(bad), ", ".join(sorted(values))))
        sys.exit(2)
    sys.exit(0)

addr =sys.argv[3] if len(sys.argv) > 3 else ""
if not (IPV4.match(addr) or (HOST.match(addr) and not re.match(r"^[\d.]+$", addr))):
    sys.exit("horizon-ctl: '%s' is not a valid IP address or hostname; nothing was written." % addr)

writes = []
for name, keys in PLAN:
    path = os.path.join(config_dir, name)
    if not os.path.isfile(path):
        print("WARNING: %s is missing; not rewriting it." % name)
        continue
    text = new = read(path)
    changes = []
    for key in keys:
        pattern = field_pattern(key)
        changes += [key for m in pattern.finditer(new) if m.group(2) != addr]
        new = pattern.sub(lambda m: m.group(1) + addr + m.group(3), new)
    if new == text:
        print("%s: already %s" % (name, addr))
        continue
    try:
        json.loads(new)
    except ValueError as e:
        sys.exit("horizon-ctl: rewriting %s would produce invalid JSON; nothing was written. (%s)" % (name, e))
    writes.append((path, name, new, changes))

for path, name, new, changes in writes:       # every file validated before the first write
    with open(path, "wb") as f:
        f.write(new.encode("utf-8"))
    for key in changes:
        print("%s: %s -> %s" % (name, key, addr))

dme = os.path.join(config_dir, "dme.json")
if writes and os.path.isfile(dme):
    mps = json.loads(read(dme)).get("MPS", {}).get("Ip")
    if mps != "127.0.0.1":
        print("WARNING: dme.json MPS.Ip is %s (expected 127.0.0.1)." % mps)
PYEOF
}

listeners() {
  local table=("tcp 10071 MUIS (universe info)" "tcp 10075 MAS  (authentication)" "tcp 10078 MLS  (lobby)"
               "tcp 10077 MPS  (proxy; DME<->Medius, host-local)" "tcp 10073 DME  TCP" "udp 10070 NAT  (address echo)"
               "udp 53 DNS  (socom-dns, the six names)")
  local row proto port label
  for row in "${table[@]}"; do
    proto="${row%% *}"; row="${row#* }"; port="${row%% *}"; label="${row#* }"
    # 127.0.0.53/54:53 is systemd-resolved's own stub, not socom-dns: it never counts as ours.
    if ss -H -ln"${proto:0:1}" "sport = :$port" 2>/dev/null | grep -v '127\.0\.0\.5[34]' | grep -q .; then
      printf '  %-4s %-6s %-40s LISTENING\n' "$proto" "$port" "$label"
    else
      printf '  %-4s %-6s %-40s not listening\n' "$proto" "$port" "$label"
    fi
  done
  printf '  udp  50000+ DME UDP, one socket per connected client: %s bound\n' \
    "$(ss -H -lnu 2>/dev/null | awk '{print $4}' | grep -Ec ':5[0-9]{4}$' || true)"
}

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

case "$verb" in
  start)    advertised check || exit $?; as_root systemctl start horizon.target ;;
  stop)     as_root systemctl stop "${UNITS[@]}" horizon.target ;;
  restart)  advertised check || exit $?; as_root systemctl stop "${UNITS[@]}"; as_root systemctl start horizon.target ;;
  check)    advertised check ;;
  status)
    for u in "${UNITS[@]}"; do printf '  %-16s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
    listeners
    advertised show ;;
  show-ip)   advertised show ;;
  public-ip) advertised set "${args[0]:-}" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
