# The multiplayer server (web sprint 3). BUILD CONTEXT: web/ (the npm workspace root), e.g. from web/:
#   docker build -f deploy/Dockerfile -t socom-mp .
# The disc is NEVER copied in: mount it read-only at run time (-v /srv/socom-disc:/disc:ro, SOCOM_DISC=/disc).

FROM node:22 AS build
WORKDIR /src
# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY tools/package.json tools/package.json
COPY packages/archive/package.json packages/archive/package.json
COPY packages/gs/package.json packages/gs/package.json
COPY packages/mesh/package.json packages/mesh/package.json
COPY packages/scene/package.json packages/scene/package.json
COPY packages/sound/package.json packages/sound/package.json
COPY packages/viewer/package.json packages/viewer/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --ignore-scripts
# Sources only (no node_modules, public/maps or test-fixtures: see Dockerfile.dockerignore).
COPY packages packages
# esbuild comes with vite. ws's optional native addons are left out (it falls back to plain JS).
RUN node_modules/.bin/esbuild packages/server/src/main.ts --bundle --platform=node --format=esm --target=node22 \
      --external:bufferutil --external:utf-8-validate \
      --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
      --outfile=/out/server.mjs

FROM node:22-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 SOCOM_DISC=/disc
WORKDIR /app
COPY --from=build /out/server.mjs ./server.mjs
# The image's built-in unprivileged user (uid 1000); the mounted disc must be world-readable.
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.mjs"]
