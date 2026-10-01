import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';

// The site's nginx.conf, read as text: two launch-review fixes that a later edit must not quietly undo.
const here = dirname(fileURLToPath(import.meta.url));
const conf = readFileSync(p(here, '../../shared/deploy/site/nginx.conf'), 'utf-8');
const lines = conf.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
const code = lines.join('\n');
/** the body of `location = <path> { ... }`, to the closing brace at the block's own indent (limit_except nests one) */
const block = (path: string): string => {
  const at = code.indexOf(`location = ${path} {`);
  if (at < 0) throw new Error(`no location = ${path}`);
  return code.slice(at, code.indexOf('\n    }', at));
};

describe('the inbox rate limit is per visitor', () => {
  // Every request reaches nginx from the Cloudflare tunnel's connector, so $binary_remote_addr is one address for
  // everyone: the zone was one global 12/min bucket. Cloudflare puts the visitor in CF-Connecting-IP; an empty key
  // would make nginx skip the limit, so a request without the header falls back to the socket address.
  it('keys the zone on $s2u_client, mapped from CF-Connecting-IP with the socket address as fallback', () => {
    expect(code).toMatch(/limit_req_zone \$s2u_client zone=s2u_bugs:1m rate=12r\/m;/);
    expect(code).not.toMatch(/limit_req_zone \$binary_remote_addr/);
    const map = code.match(/map \$http_cf_connecting_ip \$s2u_client \{([^}]*)\}/);
    expect(map, 'the map block').not.toBeNull();
    expect(map![1]).toMatch(/default\s+\$http_cf_connecting_ip;/);
    expect(map![1]).toMatch(/""\s+\$binary_remote_addr;/);
  });
  it('both inbox endpoints carry the zone', () => {
    for (const path of ['/api/bugs', '/api/testers']) expect(block(path), path).toMatch(/limit_req zone=s2u_bugs burst=6 nodelay;/);
  });
});

describe('the /map-viewer redirect', () => {
  // `return 301 /redotcom/$1` copies a capture of the decoded $uri into Location as it is (a %0d%0a in the path
  // would land in the header); `rewrite ... permanent` escapes the capture and carries the query string itself.
  it('is a rewrite ... permanent, never a return built from a capture', () => {
    // The location matches /map-viewer and /map-viewer/... only (not /map-viewerX), as the old regex did.
    const loc = code.match(/location ~ \^\/map-viewer\(\?:\/\|\$\) \{([^}]*)\}/);
    expect(loc, 'the /map-viewer location').not.toBeNull();
    expect(loc![1]).toMatch(/rewrite \^\/map-viewer\/\?\(\.\*\)\$ \/redotcom\/\$1 permanent;/);
    expect(loc![1]).toMatch(/absolute_redirect off;/);
    expect(code).not.toMatch(/return 30[12] [^;]*\$1/);
    expect(code).not.toMatch(/\$is_args\$args/);
  });
});
