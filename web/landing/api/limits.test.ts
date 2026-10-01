import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { LIMITS } from './bugs.mjs';
import { SIGNUP_LIMITS, bodyLimit } from './testers.mjs';

// Launch review PL-14: the inbox's stated body limits must be the ones enforced. Each endpoint's whole-POST cap is
// read by the server's readBody (bodyLimit picks it per path), and neither is larger than nginx's
// client_max_body_size in front of it -- so nginx refuses first only what the server would refuse anyway.
const here = dirname(fileURLToPath(import.meta.url));
const conf = readFileSync(p(here, '../../shared/deploy/site/nginx.conf'), 'utf-8');
const server = readFileSync(p(here, 'server.mjs'), 'utf-8');
const nginxMax = (path: string): number => {
  const at = conf.indexOf(`location = ${path} {`);
  const m = at < 0 ? null : conf.slice(at, conf.indexOf('\n    }', at)).match(/client_max_body_size (\d+)k;/);
  if (!m) throw new Error(`no client_max_body_size for ${path}`);
  return Number(m[1]) * 1024;
};

describe('the inbox body limits', () => {
  it('each endpoint gets its own cap', () => {
    expect(bodyLimit('/api/bugs')).toBe(LIMITS.body);
    expect(bodyLimit('/api/testers')).toBe(SIGNUP_LIMITS.body);
    expect(SIGNUP_LIMITS.body).toBe(8192);
    expect(LIMITS.body).toBe(98304);
  });
  it('the server never allows more than nginx lets through', () => {
    expect(LIMITS.body).toBeLessThanOrEqual(nginxMax('/api/bugs'));
    expect(SIGNUP_LIMITS.body).toBeLessThanOrEqual(nginxMax('/api/testers'));
  });
  it('readBody is given the per-path cap (SIGNUP_LIMITS.body cannot go dead again)', () => {
    expect(server).toMatch(/readBody\(req, bodyLimit\(path\)\)/);
    expect(server).not.toMatch(/size > LIMITS\.body/);
  });
});
