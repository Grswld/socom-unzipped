#!/usr/bin/env bash
# Build and deploy socomunzipped.com -- the landing site (web/landing) with redotcom (web/redotcom) under /redotcom/ --
# to the site's box (Git Bash on Windows or any POSIX shell). Run from anywhere in the repository.
#
#   HOST=user@box KEY=~/.ssh/<key> web/shared/deploy/site/deploy.sh          # build both sites, scan, ship, restart
#   HOST=... KEY=... web/shared/deploy/site/deploy.sh logs     # tail the site container's logs
#   HOST=... KEY=... web/shared/deploy/site/deploy.sh status   # the site's status code from inside the box's network
#   HOST=... KEY=... web/shared/deploy/site/deploy.sh maps     # upload redotcom's archives (MAPS, default
#                                                              # web/redotcom/public/maps) to the box's maps directory
#
# HOST and KEY are required and have no defaults: the box's address and its key are the owner's and live outside
# the repository. Assumes on the box: docker compose, and the stack that owns the shared `claudescape_internal`
# network and the Cloudflare tunnel connector that publishes the `s2u` container as https://socomunzipped.com.
# The landing build needs its game-derived inputs present (web/landing/README.md, "Build inputs"): the menu movie
# and the HUD sounds rendered from your own disc; this script refuses to ship a site without them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$(cd "$HERE/../../.." && pwd)"          # web/
LANDING="$WEB/landing"
REDOTCOM="$WEB/redotcom"
: "${HOST:?set HOST=user@address (the site box; not kept in the repository)}"
: "${KEY:?set KEY=<path to the SSH key for HOST> (not kept in the repository)}"
REMOTE="${REMOTE:-/opt/s2u}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$HOST")

case "${1:-deploy}" in
  logs)   exec "${SSH[@]}" "docker logs --tail ${2:-80} -f s2u" ;;
  status) exec "${SSH[@]}" "docker run --rm --network claudescape_internal curlimages/curl -sS -o /dev/null -w '%{http_code}\n' http://s2u/" ;;
  maps)
    # The 22 MP archives, the shared archives and index.json (about 290 MB), streamed once; a deploy never touches them.
    MAPS="${MAPS:-$REDOTCOM/public/maps}"
    [ -f "$MAPS/index.json" ] || { echo "no maps at $MAPS (run npm run extract-maps -w @s2u/redotcom in web/)"; exit 2; }
    "${SSH[@]}" "sudo mkdir -p $REMOTE/maps && sudo chown \$(id -un):\$(id -gn) $REMOTE/maps && sudo chmod 755 $REMOTE/maps"
    tar -C "$MAPS" -cf - . | "${SSH[@]}" "tar -xf - -C $REMOTE/maps && chmod -R a+rX $REMOTE/maps && ls $REMOTE/maps/RUN | wc -l"
    echo "maps uploaded"; exit 0 ;;
  deploy) ;;
  *) echo "usage: deploy.sh [deploy|logs|status|maps]"; exit 2 ;;
esac

# The game-derived inputs: the page runs without them, a deploy must not ship without them.
for f in public/media/menuloop.mp4 public/sfx/dink.ogg public/sfx/thunk.ogg public/sfx/back.ogg public/sfx/neg.ogg public/sfx/type.ogg; do
  [ -f "$LANDING/$f" ] || { echo "missing web/landing/$f -- npm run assets -w landing (the disc under game/disc, ffmpeg)"; exit 2; }
done

# Both sites, built here from this tree: the landing site into web/landing/dist, redotcom for its /redotcom/ prefix into
# web/redotcom/dist/viewer. No copy of either comes from outside the repository. redotcom ships single player (owner,
# 2026-09-30: "in its current state with multiplayer disabled"): VITE_S2U_MULTIPLAYER=off takes out its Online section,
# its PLAYERS ONLINE count and every request to a match server (web/redotcom/packages/viewer/src/multiplayer.ts).
(cd "$WEB" && npm run build -w landing)
(cd "$WEB" && VIEWER_BASE=/redotcom/ VITE_S2U_MULTIPLAYER=off npm run build -w @s2u/redotcom)
[ -f "$REDOTCOM/dist/viewer/index.html" ] || { echo "no redotcom build at web/redotcom/dist/viewer"; exit 2; }

# The release, staged outside the source tree.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/api"
cp "$HERE/Dockerfile" "$HERE/nginx.conf" "$HERE/docker-compose.yml" "$STAGE/"
cp -r "$LANDING/dist" "$STAGE/dist"
cp -r "$REDOTCOM/dist/viewer" "$STAGE/redotcom"
cp "$LANDING/api/Dockerfile" "$LANDING/api/bugs.mjs" "$LANDING/api/testers.mjs" "$LANDING/api/server.mjs" "$STAGE/api/"

# Nothing leaves the machine unscanned: keys, tokens, addresses, emails -- the repository's own leak check over the
# exact tree that ships.
(cd "$WEB/.." && python -m tools_py.release.leakcheck artifact "$STAGE")

tar -C "$STAGE" -czf "$STAGE.tgz" .
"${SSH[@]}" "sudo mkdir -p $REMOTE && sudo chown \$(id -un):\$(id -gn) $REMOTE"
# The bug-report inbox: owned by the api container's user (uid 10001), readable by the login user's group for the
# reader skill, closed to everyone else. It lives beside src/, so a deploy never touches a stored report.
"${SSH[@]}" "sudo mkdir -p $REMOTE/data/bugs $REMOTE/data/bugs-test $REMOTE/data/testers $REMOTE/data/testers-test && sudo chown -R 10001:\$(id -gn) $REMOTE/data && sudo chmod -R u=rwX,g=rX,o= $REMOTE/data && sudo chmod g+s $REMOTE/data $REMOTE/data/bugs $REMOTE/data/bugs-test"
scp -i "$KEY" -q "$STAGE.tgz" "$HOST:$REMOTE/release.tgz"
rm -f "$STAGE.tgz"
"${SSH[@]}" REMOTE="$REMOTE" bash -s <<'EOF'
set -euo pipefail
rm -rf "$REMOTE/src.new" && mkdir -p "$REMOTE/src.new"
tar -xzf "$REMOTE/release.tgz" -C "$REMOTE/src.new"
rm -rf "$REMOTE/src.old"; [ -d "$REMOTE/src" ] && mv "$REMOTE/src" "$REMOTE/src.old"
mv "$REMOTE/src.new" "$REMOTE/src"; rm -f "$REMOTE/release.tgz"
cd "$REMOTE/src"
docker compose up -d --build
docker image prune -f >/dev/null
docker ps --filter name=s2u --format '{{.Names}} {{.Status}}'
EOF
echo "deployed: https://socomunzipped.com/"
