import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `web/redotcom/deploy/env.example` (the merge review's hole 1): the deploy's README and `compose.yaml` tell the owner to copy
 * it as the git-ignored settings file, so it must exist and name every setting the server, the compose file and the
 * Caddyfile read -- each with a placeholder or the dev default, never a real value.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string): string => readFileSync(resolve(WEB, rel), 'utf8');

/** The variables a text reads: `env['X']` (the server), `${X...}` (compose), `{$X}` (Caddy). */
function readsOf(): Set<string> {
  const out = new Set<string>();
  for (const m of read('packages/server/src/main.ts').matchAll(/env\['([A-Z_]+)'\]/g)) out.add(m[1]!);
  for (const m of read('packages/server/src/main.ts').matchAll(/num\('([A-Z_]+)'/g)) out.add(m[1]!);
  for (const m of read('deploy/compose.yaml').matchAll(/\$\{([A-Z_]+)/g)) out.add(m[1]!);
  for (const m of read('deploy/Caddyfile').matchAll(/\{\$([A-Z_]+)\}/g)) out.add(m[1]!);
  return out;
}

describe('deploy/env.example', () => {
  it('exists and names every setting the server, compose and Caddy read', () => {
    expect(existsSync(resolve(WEB, 'deploy/env.example'))).toBe(true);
    const text = read('deploy/env.example');
    const named = new Set([...text.matchAll(/^#?\s*([A-Z_]+)=/gm)].map((m) => m[1]!));
    const reads = readsOf();
    expect(reads.size).toBeGreaterThanOrEqual(9);
    for (const key of reads) expect(named, key).toContain(key);
  });

  it('carries placeholders only: the example domain, no address', () => {
    const text = read('deploy/env.example');
    expect(text).toMatch(/^MP_DOMAIN=\S*example\.com$/m);
    expect(text).toMatch(/^ACME_EMAIL=\S*@example\.com$/m);
    const addresses = [...text.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)].map((m) => m[0]);
    expect(addresses.filter((a) => a !== '0.0.0.0' && a !== '127.0.0.1')).toEqual([]);   // only the bind defaults
  });
});

/** The paths the server answers: its HTTP routes (`req.url === '/x'`) and the WebSocket's upgrade path. */
function serverPaths(): string[] {
  const src = read('packages/server/src/server.ts');
  const http = [...src.matchAll(/req\.url === '(\/[a-z]+)'/g)].map((m) => m[1]!);
  const ws = [...src.matchAll(/WS_PATH = '(\/[a-z]+)'/g)].map((m) => m[1]!);
  return [...new Set([...http, ...ws])].sort();
}

/** The paths the Caddyfile answers 403 off the host: each matcher's `path` under a `not remote_ip` loopback test. */
function caddyHostOnly(): string[] {
  const out: string[] = [];
  for (const m of read('deploy/Caddyfile').matchAll(/@\w+ \{([^}]*)\}/g)) {
    const body = m[1]!;
    if (!/not remote_ip 127\.0\.0\.1 ::1/.test(body)) continue;
    for (const p of body.match(/path ([^\n]*)/)?.[1]!.trim().split(/\s+/) ?? []) if (!p.endsWith('*')) out.push(p);
  }
  return out.sort();
}

describe('the public surface (owner ruling 2026-09-29, OWNER-4: /rooms stays public and documented)', () => {
  const PUBLIC = ['/health', '/rooms', '/ws'];
  const HOST_ONLY = ['/metrics'];

  it('the server answers exactly /health, /metrics, /rooms and /ws', () => {
    expect(serverPaths()).toEqual([...PUBLIC, ...HOST_ONLY].sort());
  });

  it('behind Caddy only /metrics is host-only: the public set is /health, /rooms and /ws', () => {
    expect(caddyHostOnly()).toEqual(HOST_ONLY);
    expect(serverPaths().filter((p) => !caddyHostOnly().includes(p))).toEqual(PUBLIC);
  });

  it('behind the Cloudflare tunnel the ingress rule passes the same public set and nothing else', () => {
    const readme = read('deploy/README.md');
    const rule = readme.match(/path: \^\/\(([a-z|]+)\)\$/);
    expect(rule, 'the README\'s cloudflared ingress path rule').not.toBeNull();
    expect(rule![1]!.split('|').map((p) => `/${p}`).sort()).toEqual(PUBLIC);
    expect(readme).toMatch(/service: http_status:404/);                    // the catch-all: everything else 404
  });

  it('the deploy README names every public path, /rooms as public, and /metrics as host-only, in its first paragraph', () => {
    const first = read('deploy/README.md').split(/\r?\n\r?\n/)[1]!;
    for (const p of PUBLIC) expect(first).toContain(`\`${p === '/ws' ? '/ws' : `GET ${p}`}\``);
    expect(first).toMatch(/\/rooms`[^.]*public/);
    expect(first).toMatch(/\/metrics`[^.]*host only/);
  });
});

describe('/rooms is cacheable (the viewer\'s PLAYERS ONLINE poll, owner 2026-09-29)', () => {
  it('the server gives /rooms an ETag, a 304 for a matching If-None-Match, a public max-age of 10 s, and CORS * still', () => {
    const src = read('packages/server/src/server.ts');
    const route = src.slice(src.indexOf("req.url === '/rooms'"), src.indexOf("req.url === '/metrics'"));
    expect(route).toMatch(/if-none-match/);
    expect(route).toMatch(/writeHead\(304, headers\)/);
    expect(route).toMatch(/writeHead\(200, \{ 'content-type': 'application\/json', \.\.\.headers \}\)/);
    expect(src).toMatch(/export const ROOMS_MAX_AGE = 10;/);
    expect(src).toMatch(/'cache-control': `public, max-age=\$\{ROOMS_MAX_AGE\}`/);
    expect(src).toMatch(/'access-control-allow-origin': '\*', 'cache-control'/);
  });

  it('the deploy README says so in its first paragraph, and nothing in front strips it (the Caddyfile sets no header)', () => {
    const first = read('deploy/README.md').split(/\r?\n\r?\n/)[1]!;
    expect(first).toMatch(/\/rooms`[^)]*ETag[^)]*304[^)]*Cache-Control: public, max-age=10/);
    expect(read('deploy/Caddyfile')).not.toMatch(/^\s*header\b/m);
  });
});

describe('the deploy text against the tree', () => {
  it('compose trusts its proxy for the client address (Caddy and cloudflared append X-Forwarded-For)', () => {
    expect(read('deploy/compose.yaml')).toMatch(/^\s+TRUST_PROXY: "1"$/m);
    expect(read('deploy/env.example')).toMatch(/^# TRUST_PROXY=1$/m);
  });

  it('the no-Docker commands name files that exist (the post-2026-09-29 layout, from web/)', () => {
    const readme = read('deploy/README.md');
    const block = readme.slice(readme.indexOf('## Without Docker'));
    const named = [...block.matchAll(/(redotcom\/[\w/.-]+\.(?:ts|service))/g)].map((m) => m[1]!);
    expect(named).toEqual(expect.arrayContaining(['redotcom/packages/server/src/main.ts', 'redotcom/deploy/systemd/socom-mp.service']));
    for (const rel of named) expect(existsSync(resolve(WEB, '..', rel)), rel).toBe(true);
    expect(block).not.toMatch(/esbuild packages\/server|scp deploy\//);
  });

  it('says one room per map and rules, and names the heartbeat', () => {
    const readme = read('deploy/README.md');
    expect(readme).toMatch(/one room per map and rules/);
    expect(readme).not.toMatch(/one room per map[^ ]/);
    expect(readme).toMatch(/HEARTBEAT_MS/);
  });
});
