#!/usr/bin/env bash
# socom-dns (Sprint 18, R-D): bind the box's first private IPv4 (systemd-resolved holds 127.0.0.53:53, so never the
# wildcard) and answer SOCOM II's six retail host names with muis.json's Endpoint. Run by socom-dns.service.
set -euo pipefail
BIND="$(hostname -I | awk '{print $1}')"
[ -n "$BIND" ] || { echo "socom-dns: no IPv4 address on this host to bind" >&2; exit 2; }
exec /usr/bin/python3 /opt/socom-unzipped-server/linux/socom_dns.py --bind "$BIND" --muis /opt/socom-unzipped-server/config/muis.json
