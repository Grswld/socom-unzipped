#!/usr/bin/env bash
# socom-dns (Sprint 18, R-D): bind the box's first private IPv4 (systemd-resolved holds 127.0.0.53:53, so never the
# wildcard) and answer SOCOM II's six retail host names with muis.json's Endpoint. Run by socom-dns.service.
# The address is the first dotted quad `hostname -I` prints (its first word may be IPv6). For the tests:
# SOCOM_DNS_HOST_ADDRS stands in for `hostname -I`, and SOCOM_DNS_DRY_RUN=1 prints the address and exits 0.
set -euo pipefail
ADDRS="${SOCOM_DNS_HOST_ADDRS:-$(hostname -I 2>/dev/null || true)}"
BIND="$(printf '%s\n' "$ADDRS" | tr ' ' '\n' | grep -m1 -E '^[0-9]+(\.[0-9]+){3}$' || true)"
[ -n "$BIND" ] || { echo "socom-dns: no IPv4 address on this host to bind (hostname -I: '$ADDRS'); not starting" >&2; exit 1; }
if [ "${SOCOM_DNS_DRY_RUN:-}" = 1 ]; then echo "$BIND"; exit 0; fi
exec /usr/bin/python3 /opt/socom-unzipped-server/linux/socom_dns.py --bind "$BIND" --muis /opt/socom-unzipped-server/config/muis.json
