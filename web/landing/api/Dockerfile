# s2u-api: the bug-report inbox. No dependencies, no build step, runs as an unprivileged user.
FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
WORKDIR /app
COPY bugs.mjs testers.mjs server.mjs ./
# uid 10001 owns /data; deploy.sh gives the host directory the same owner.
RUN adduser -D -H -u 10001 s2uapi && mkdir -p /data && chown 10001:10001 /data
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
