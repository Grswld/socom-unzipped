#!/usr/bin/env bash
# One health line for the hosted box (Sprint 10 Goal 2; tracked by Sprint 13 Task O3): what the owner reads, what a
# watch can grep. Installed as /usr/local/sbin/socom-health.sh; run it over SSH: sudo socom-health.sh
#
# Reads ops.env (OPS_ENV, else ops.env beside this script, else /etc/socom-unzipped/ops.env): OPS_SERVER_DIR,
# OPS_BACKUP_DIR, OPS_STATS_URL, OPS_DEPLOYED_COMMIT (may be empty). Nothing about the box is written here.
#
# Prints: HEALTH ok|WARN <reasons> | up <days> | disk <used>/<size> (<pct>) | mem avail <MB>
#         | services <n>/5 active | ports <n>/5 listening | db <bytes> @ <mtime> | backup <newest stamp>
#         | stats <online|OFFLINE> players=<n> since=<startedUtc> build=<id>
# WARN when disk >= 80 %, memory available < 200 MB, a unit down, a public port not listening (TCP 10071 10073
# 10075 10078, UDP 10070 -- the tracked configs' ports), no backup, one older than 48 h or one whose database never settled, the stats endpoint
# silent, or the running build is not OPS_DEPLOYED_COMMIT. Exit 0 on ok, 1 on WARN, 2 when ops.env is missing.
set -u

load_ops_env() {
  local f="${OPS_ENV:-}"
  if [ -z "$f" ]; then
    f="$(cd "$(dirname "$0")" && pwd)/ops.env"
    [ -f "$f" ] || f=/etc/socom-unzipped/ops.env
  fi
  [ -f "$f" ] || { echo "$(basename "$0"): no ops.env (set OPS_ENV, or copy server/ops/ops.env.example to $f)" >&2; exit 2; }
  set -a; . <(tr -d '\r' < "$f"); set +a      # an ops.env saved on Windows has CRLF line ends
}
load_ops_env
: "${OPS_SERVER_DIR:?ops.env must set OPS_SERVER_DIR}"
: "${OPS_BACKUP_DIR:?ops.env must set OPS_BACKUP_DIR}"
: "${OPS_STATS_URL:?ops.env must set OPS_STATS_URL}"
deployed="${OPS_DEPLOYED_COMMIT:-}"

warn=()
up_days=$(awk '{printf "%.1f", $1/86400}' /proc/uptime)
# no source column: a source with a space in it would shift every field after it
read -r size used pct < <(df -B1 --output=size,used,pcent / | tail -1)
pct_n=${pct%\%}
[ "${pct_n:-0}" -ge 80 ] 2>/dev/null && warn+=("disk ${pct}")
mem_avail=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)
[ -n "$mem_avail" ] && [ "$mem_avail" -lt 200 ] && warn+=("mem ${mem_avail}MB")

active=0
for u in horizon-nat horizon-muis horizon-medius horizon-dme socom-dns; do systemctl is-active --quiet "$u" 2>/dev/null && active=$((active+1)); done
[ "$active" -lt 5 ] && warn+=("services ${active}/5")

listening=0; missing=()
tcp_ports=$(ss -Hltn 2>/dev/null | awk '{print $4}')
udp_ports=$(ss -Hlun 2>/dev/null | awk '{print $4}')
for p in 10071 10073 10075 10078; do
  if printf '%s\n' "$tcp_ports" | grep -q ":$p\$"; then listening=$((listening+1)); else missing+=("${p}/tcp"); fi
done
if printf '%s\n' "$udp_ports" | grep -q ":10070\$"; then listening=$((listening+1)); else missing+=("10070/udp"); fi
[ "${#missing[@]}" -gt 0 ] && warn+=("ports ${missing[*]}")

db="$OPS_SERVER_DIR/config/simulated.db"
db_bytes=$(stat -c %s "$db" 2>/dev/null || echo 0)
db_mtime=$(date -u -r "$db" +%FT%TZ 2>/dev/null || echo none)
newest=$(ls -1d "$OPS_BACKUP_DIR"/*/ 2>/dev/null | sort | tail -1 | xargs -r basename)
[ -z "$newest" ] && warn+=("no backup")
if [ -n "$newest" ]; then
  # the stamp is compact (20260921T035845Z); date -d wants it spelled out
  taken=$(date -u -d "${newest:0:8} ${newest:9:2}:${newest:11:2}:${newest:13:2}" +%s 2>/dev/null || echo 0)
  age_h=$(( ( $(date +%s) - taken ) / 3600 ))
  [ "$age_h" -gt 48 ] && warn+=("backup ${age_h}h old")
  [ -e "$OPS_BACKUP_DIR/$newest/simulated.db.unsettled" ] && warn+=("backup ${newest} unsettled")
fi

stats=$(curl -s -m 5 "$OPS_STATS_URL" || true)
if [ -n "$stats" ]; then
  online=$(printf '%s' "$stats" | sed -n 's/.*"online":\([0-9]*\).*/\1/p')
  since=$(printf '%s' "$stats" | sed -n 's/.*"startedUtc":"\([^"]*\)".*/\1/p')
  build=$(printf '%s' "$stats" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')
  stats_line="stats online players=${online:-?} since=${since:-?} build=${build:-none}"
  if [ -n "$deployed" ] && [ "${build:-}" != "$deployed" ]; then warn+=("build ${build:-none} is not ${deployed}"); fi
else
  stats_line="stats OFFLINE"; warn+=("stats offline")
fi

state=ok
[ "${#warn[@]}" -gt 0 ] && state="WARN ${warn[*]}"
printf 'HEALTH %s | up %sd | disk %s/%s (%s) | mem avail %sMB | services %s/5 active | ports %s/5 listening | db %s @ %s | backup %s | %s\n' \
  "$state" "$up_days" "$(numfmt --to=iec "$used")" "$(numfmt --to=iec "$size")" "$pct" "${mem_avail:-?}" "$active" \
  "$listening" "$db_bytes" "$db_mtime" "${newest:-none}" "$stats_line"
[ "$state" = ok ]
