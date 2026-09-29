# Deploying the multiplayer server

The server (`web/redotcom/packages/server`) is one Node process on one port (8787): `GET /health` (JSON), `GET /rooms`
(each loaded room's map, rules, players, spectators, tick and round: anonymous counts, CORS `*`, public by the owner's
ruling of 2026-09-29), the WebSocket `/ws`, and `GET /metrics` (Prometheus text, for the host only). The public set
is `/health`, `/rooms` and `/ws`, and `packages/server/test/deployEnv.test.ts` pins it. It keeps one room per map and
rules (respawn, classic). A front door gives it HTTPS/WSS: Caddy (the default, below) or a Cloudflare tunnel
([Behind a Cloudflare tunnel](#behind-a-cloudflare-tunnel)). Transport is WebSocket only (ruling W3.R9 in
`web/redotcom/docs/specs/2026-09-29-web-sprint-3-multiplayer-design.md`), so **no UDP port is needed**.

**The disc files are yours and are never served or baked into an image.** The server reads `RUN/` (`MP*.ZDB`,
`MOTION_P.ZAR`, `READERC.ZAR`) from a directory mounted read-only.

| File | What |
|---|---|
| `Dockerfile` | node:22 build stage (esbuild bundle, 340 kB) -> node:22-slim, non-root, `HEALTHCHECK` on `/health`. Build context: `web/` (the npm workspace root; every member's manifest goes in) |
| `Dockerfile.dockerignore` | BuildKit's per-Dockerfile ignore list (keeps `node_modules`, `public/maps`, `test-fixtures`, `.env`, disc archives out) |
| `compose.yaml` | `mp` (published on 127.0.0.1:8787 only) and `caddy` (80/443, certificates in the `caddy_data` volume) |
| `Caddyfile` | `{$MP_DOMAIN}` -> `mp:8787`; `/metrics` answers 403 to anyone but localhost; `/health`, `/rooms`, `/ws` public |
| `env.example` | the settings, commented |
| `deploy.sh` | `./deploy.sh user@host`: installs Docker if missing, rsyncs the build context, builds and starts on the host, polls `/health` |
| `systemd/socom-mp.service` | the no-Docker alternative |

## Size

The server keeps one room per map and rules, each a 60 Hz loop; a map's respawn and classic rooms share its one
parse (the hull, the grid, the spawn slots; a map with doors gives each room its own copy of the hull the doors swing). The load-test target is **16 players + 8 spectators on one
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

## Connections

Settings and limits a host operator meets (all in `packages/server/src/server.ts`; the environment in `env.example`):

- **Heartbeat** (`HEARTBEAT_MS`, 5 s): every sweep pings each socket at the WebSocket protocol level (browsers answer
  on their own); a socket that missed the previous sweep's ping is terminated and its seat freed, 5-10 s after it went
  quiet. It is never a silence timeout: a watcher sends nothing after its hello and is kept while it answers.
- **Client address** (`TRUST_PROXY=1`, set by `compose.yaml`): behind Caddy or cloudflared every peer is the proxy, so the
  address (the vote ban's key) is `X-Forwarded-For`'s last entry, the one the proxy wrote. Unset, the header is never
  read; set it whenever a proxy is in front, and only then.
- **One hello per connection**: a second hello (in the same burst, or during a map's first load) is dropped as a strike.
- **Rate**: 120 binary and 40 text frames a second; a frame past it, a frame that will not parse, or one the room
  throws on is dropped as a strike, and 200 strikes close the connection. Frames over 4096 bytes close it at once.

## Running it

On the host, in `~/socom-mp/redotcom/deploy` (`~/socom-mp/deploy` before 2026-09-29; `deploy.sh` moves the `.env`):

- Logs: `sudo docker compose logs -f mp` (the server writes one JSON object per line: `{"t":...,"level":...,"msg":...}`).
- Restart: `sudo docker compose restart mp`.
- Update: pull the repository, re-run `./deploy.sh ubuntu@HOST` (a changed `.env` needs it too, or
  `sudo docker compose up -d` on the host).
- Stop: `sudo docker compose down` (certificates survive in the `caddy_data` volume).

## Joining

The page picks the server from its address: `https://<viewer>/?redotcom&mp&server=wss://mp.example.com/ws`.

## Behind a Cloudflare tunnel

The variant without Caddy: the box opens no inbound port but SSH, and `cloudflared` dials out to Cloudflare, which
serves the certificate. The server listens on the loopback only, `127.0.0.1:8787` (compose's `mp` service alone, which
publishes there, or the systemd unit below with `HOST=127.0.0.1`), and the tunnel's ingress passes the public set and
nothing else:

```yaml
# /etc/cloudflared/config.yml -- the placeholders are yours: the tunnel's id and the multiplayer name
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: mp.example.com
    path: ^/(ws|health|rooms)$
    service: http://127.0.0.1:8787
  - service: http_status:404
```

- The name's DNS record is the tunnel's (`cloudflared tunnel route dns <tunnel-name> mp.example.com`), not an `A` record;
  steps 2-4 above (static IP, ports 80/443, `A` record) do not apply.
- Compose: after `deploy.sh`'s sync, start only the server on the host, `sudo docker compose up -d --build mp`
  (`deploy.sh` itself starts `caddy` too, which a tunnel box does not want). Without Docker: the unit below.
- `TRUST_PROXY=1` (compose sets it; the unit's `/etc/socom-mp.env` needs the line): Cloudflare appends the client to
  `X-Forwarded-For` and cloudflared passes it on, so the last entry is the client.
- `/metrics` stays on the host (`curl http://127.0.0.1:8787/metrics`); through the tunnel it answers 404, as does
  every path the rule does not name.
- The heartbeat's 5 s ping keeps an idle watcher's socket alive through Cloudflare's WebSocket idle timeout.
- Check: `curl https://mp.example.com/health` -> `{"ok":true,...}`, and `curl https://mp.example.com/rooms` -> a JSON list.

## Without Docker

Needs Node 22 on the host (Ubuntu 24.04's own `nodejs` is older: use NodeSource or `nvm`) and something for TLS
(the Caddy package with the same `Caddyfile`, its `mp:8787` changed to `127.0.0.1:8787`, or the tunnel above).

```
cd web && npm ci && npx esbuild redotcom/packages/server/src/main.ts --bundle --platform=node --format=esm --target=node22 \
  --external:bufferutil --external:utf-8-validate \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile=dist/server.mjs
scp dist/server.mjs ubuntu@HOST:/tmp/ && scp redotcom/deploy/systemd/socom-mp.service ubuntu@HOST:/tmp/
# on the host:
sudo install -D -m 644 /tmp/server.mjs /opt/socom-mp/server.mjs
sudo install -m 644 /tmp/socom-mp.service /etc/systemd/system/
printf 'SOCOM_DISC=/srv/socom-disc\nHOST=127.0.0.1\nPORT=8787\nTRUST_PROXY=1\n' | sudo tee /etc/socom-mp.env   # + the other env.example settings
sudo systemctl daemon-reload && sudo systemctl enable --now socom-mp
journalctl -u socom-mp -f
```

The unit's `ReadOnlyPaths=/srv/socom-disc` must match `SOCOM_DISC`.

## Verified, and not

The bundle was built and started locally against the test fixtures (`/health` answered 200). The Dockerfile,
`compose.yaml` (`docker compose config` parses) and `deploy.sh` (`bash -n`) were **not** run end to end: the authoring
container had no Docker daemon, and nothing was run against a remote host.
