# Deploying the multiplayer server

The server (`web/redotcom/packages/server`) is one Node process: HTTP `GET /health` (JSON), `GET /metrics` (Prometheus text) and the
WebSocket `/ws`, all on one port (8787). Caddy in front gives it HTTPS/WSS. Transport is WebSocket only (ruling W3.R9 in
`web/redotcom/docs/specs/2026-09-29-web-sprint-3-multiplayer-design.md`), so **no UDP port is needed**.

**The disc files are yours and are never served or baked into an image.** The server reads `RUN/` (`MP*.ZDB`,
`MOTION_P.ZAR`, `READERC.ZAR`) from a directory mounted read-only.

| File | What |
|---|---|
| `Dockerfile` | node:22 build stage (esbuild bundle, 340 kB) -> node:22-slim, non-root, `HEALTHCHECK` on `/health`. Build context: `web/` (the npm workspace root; every member's manifest goes in) |
| `Dockerfile.dockerignore` | BuildKit's per-Dockerfile ignore list (keeps `node_modules`, `public/maps`, `test-fixtures`, `.env`, disc archives out) |
| `compose.yaml` | `mp` (published on 127.0.0.1:8787 only) and `caddy` (80/443, certificates in the `caddy_data` volume) |
| `Caddyfile` | `{$MP_DOMAIN}` -> `mp:8787`; `/metrics` answers 403 to anyone but localhost |
| `env.example` | the settings, commented |
| `deploy.sh` | `./deploy.sh user@host`: installs Docker if missing, rsyncs the build context, builds and starts on the host, polls `/health` |
| `systemd/socom-mp.service` | the no-Docker alternative |

## Size

The server keeps one room per map, each a 60 Hz loop. The load-test target is **16 players + 8 spectators on one
map**; the controller measures CPU for it in M9 (`s2u_step_ms_*` in `/metrics`). Start on Lightsail's **$12/month plan
(2 GB RAM, 2 vCPU)** and **check M9's numbers** before trusting it for more than one busy map; a smaller plan is a
guess until then.

## Steps

1. **Instance.** Lightsail -> create instance -> Linux/Unix, Ubuntu 24.04 LTS, the plan above. Add your SSH key.
2. **Static IP.** Networking -> create a static IP and attach it to the instance.
3. **Firewall.** The instance's Networking tab: keep TCP 22, add **TCP 80 and TCP 443** (80 is for the certificate
   challenge and the redirect). No UDP.
4. **DNS.** An `A` record for the multiplayer name (say `mp.example.com`) to the static IP. Wait until it resolves.
5. **The disc, once, by hand** (from the machine holding your own copy of the disc's `RUN/`):
   ```
   ssh ubuntu@HOST 'sudo mkdir -p /srv/socom-disc && sudo chown $USER /srv/socom-disc'
   rsync -avz /path/to/disc/RUN/ ubuntu@HOST:/srv/socom-disc/RUN/
   ssh ubuntu@HOST 'chmod -R a+rX /srv/socom-disc'
   ```
   (`a+rX`: the container's user is not you.) `deploy.sh` never copies the disc.
6. **Settings.** `cp env.example .env` in this directory and fill in `MP_DOMAIN` and `ACME_EMAIL` (both required);
   `DISC_DIR` if you used another path. `.env` is copied to the host by `deploy.sh`; never commit it.
7. **Deploy.** `./deploy.sh ubuntu@HOST`. It installs `docker.io`, `docker-compose-v2` and `rsync` if missing, rsyncs
   `web/`'s manifests, `redotcom/packages/` and `redotcom/deploy/` to `~/socom-mp/` on the host, runs `docker compose up -d --build`
   there, then polls `https://$MP_DOMAIN/health` for up to 150 s. The first certificate takes a minute.
8. **Check.** `curl https://mp.example.com/health` -> `{"ok":true,...}`. `/metrics` from outside is 403; on the host,
   `curl http://127.0.0.1:8787/metrics`.

## Running it

On the host, in `~/socom-mp/redotcom/deploy` (`~/socom-mp/deploy` before 2026-09-29; `deploy.sh` moves the `.env`):

- Logs: `sudo docker compose logs -f mp` (the server writes one JSON object per line: `{"t":...,"level":...,"msg":...}`).
- Restart: `sudo docker compose restart mp`.
- Update: pull the repository, re-run `./deploy.sh ubuntu@HOST` (a changed `.env` needs it too, or
  `sudo docker compose up -d` on the host).
- Stop: `sudo docker compose down` (certificates survive in the `caddy_data` volume).

## Joining

The page picks the server from its address: `https://<viewer>/?redotcom&mp&server=wss://mp.example.com/ws`.

## Without Docker

Needs Node 22 on the host (Ubuntu 24.04's own `nodejs` is older: use NodeSource or `nvm`) and something for TLS
(the Caddy package with the same `Caddyfile`, its `mp:8787` changed to `127.0.0.1:8787`).

```
cd web && npm ci && npx esbuild packages/server/src/main.ts --bundle --platform=node --format=esm --target=node22 \
  --external:bufferutil --external:utf-8-validate \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=dist/server.mjs
scp dist/server.mjs ubuntu@HOST:/tmp/ && scp deploy/systemd/socom-mp.service ubuntu@HOST:/tmp/
# on the host:
sudo install -D -m 644 /tmp/server.mjs /opt/socom-mp/server.mjs
sudo install -m 644 /tmp/socom-mp.service /etc/systemd/system/
printf 'SOCOM_DISC=/srv/socom-disc\nHOST=127.0.0.1\nPORT=8787\n' | sudo tee /etc/socom-mp.env   # + the other env.example settings
sudo systemctl daemon-reload && sudo systemctl enable --now socom-mp
journalctl -u socom-mp -f
```

The unit's `ReadOnlyPaths=/srv/socom-disc` must match `SOCOM_DISC`.

## Verified, and not

The bundle was built and started locally against the test fixtures (`/health` answered 200). The Dockerfile,
`compose.yaml` (`docker compose config` parses) and `deploy.sh` (`bash -n`) were **not** run end to end: the authoring
container had no Docker daemon, and nothing was run against a remote host.
