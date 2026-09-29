import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `web/deploy/env.example` (the merge review's hole 1): the deploy's README and `compose.yaml` tell the owner to copy
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
