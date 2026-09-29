#!/usr/bin/env bash
# Deploy the multiplayer server to a fresh Ubuntu 24.04 host:  ./deploy.sh user@host
# Method: rsync the build context (sources, no disc, no node_modules) to the host and build the image THERE with
# `docker compose up -d --build`. No registry, no image transfer. The disc is never copied by this script.
set -euo pipefail

HOST="${1:?usage: ./deploy.sh user@host}"
REMOTE_DIR="${REMOTE_DIR:-socom-mp}"   # relative to the remote home
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(dirname "$HERE")"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

ssh_run() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

echo "== ensuring docker and rsync on $HOST"
ssh_run 'set -e
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 rsync
    sudo systemctl enable --now docker
  fi'

echo "== syncing the build context to $HOST:~/$REMOTE_DIR"
ssh_run "mkdir -p '$REMOTE_DIR'"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --include='/package.json' --include='/package-lock.json' \
  --include='/tools/' --include='/tools/package.json' \
  --include='/packages/***' --include='/deploy/***' \
  --exclude='node_modules' --exclude='/deploy/.env' --exclude='*' \
  "$WEB/" "$HOST:$REMOTE_DIR/"

if [[ -f "$HERE/.env" ]]; then
  echo "== copying .env"
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$HERE/.env" "$HOST:$REMOTE_DIR/deploy/.env"
  ssh_run "chmod 600 '$REMOTE_DIR/deploy/.env'"
else
  echo "no local deploy/.env: the host must already have $REMOTE_DIR/deploy/.env" >&2
fi

MP_DOMAIN="$(ssh_run "grep -E '^MP_DOMAIN=' '$REMOTE_DIR/deploy/.env' | tail -n1 | cut -d= -f2-" | tr -d '\r' || true)"
DISC_DIR="$(ssh_run "grep -E '^DISC_DIR=' '$REMOTE_DIR/deploy/.env' | tail -n1 | cut -d= -f2-" | tr -d '\r' || true)"
DISC_DIR="${DISC_DIR:-/srv/socom-disc}"
[[ -n "$MP_DOMAIN" ]] || { echo "MP_DOMAIN is not set in the host's deploy/.env" >&2; exit 1; }

if ! ssh_run "test -f '$DISC_DIR/RUN/READERC.ZAR'"; then
  cat >&2 <<MSG

The disc files are not on the host yet ($DISC_DIR/RUN/READERC.ZAR is missing). This script never copies them.
Once, from the machine holding your own disc copy:
  ssh $HOST 'sudo mkdir -p $DISC_DIR && sudo chown \$USER $DISC_DIR'
  rsync -avz /path/to/disc/RUN/ $HOST:$DISC_DIR/RUN/
  ssh $HOST 'chmod -R a+rX $DISC_DIR'
then re-run ./deploy.sh $HOST. Continuing: the server will not start without them.
MSG
fi

echo "== building and starting"
ssh_run "cd '$REMOTE_DIR/deploy' && sudo docker compose up -d --build"

echo "== polling https://$MP_DOMAIN/health (certificate issuance can take a minute)"
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 5 "https://$MP_DOMAIN/health" 2>/dev/null)"; then
    echo "healthy: $body"
    exit 0
  fi
  sleep 5
done
echo "no healthy answer from https://$MP_DOMAIN/health after 150 s." >&2
echo "check: DNS A record, ports 80/443 in the firewall, the disc files, and 'ssh $HOST \"cd $REMOTE_DIR/deploy && sudo docker compose logs mp caddy\"'" >&2
exit 1
