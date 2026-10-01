// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The local demo (owner, 2026-10-01: "merge the demo/teaser in as we built and deployed to live, with multiplayer
 * extracted and it just being a local demo"). This repository's redotcom is the teaser the site serves at /redotcom/:
 * single player, its only match the offline one (`../src/net/loopback`, the room run in the page). The online match --
 * the match server, its WebSocket transport, the Online setting, the players-online poll -- lives in the separate
 * redotcom project. This guard reads the sources and the manifests, so none of it creeps back in by a merge.
 */

const viewer = resolve(import.meta.dirname, '..');
const redotcom = resolve(viewer, '../..');
const web = resolve(redotcom, '..');

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, ext));
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

/** What the page ships: the viewer's sources and its markup. */
const shipped = [...files(join(viewer, 'src'), /\.(ts|css)$/), join(viewer, 'index.html')];

/** The online match's marks: its server's addresses, its transport, its build switches and its words. */
const ONLINE: [string, RegExp][] = [
  ['the shared match server', /mp\.socomunzipped/i],
  ['a WebSocket of the page\'s own', /new\s+WebSocket\s*\(/],
  ['a ws:// or wss:// address', /\bwss?:\/\//],
  ['the match server\'s /ws, /rooms or /health', /['"`]\/(ws|rooms|health)\b/],
  ['the local match server\'s port', /:8787\b/],
  ['the multiplayer build switch', /VITE_S2U_MULTIPLAYER/],
  ['the rooms poll\'s build switch', /VITE_S2U_ROOMS/],
  ['the players-online count', /players online/i],
  ['the Online setting\'s markup', /id="(mp-section|online|online-state|mp-name|players-online)"/],
];

describe('the local demo: no online match in the page', () => {
  it('ships none of the online match\'s modules', () => {
    for (const gone of ['online.ts', 'multiplayer.ts', 'playersOnline.ts']) {
      expect(existsSync(join(viewer, 'src', gone)), gone).toBe(false);
    }
    expect(existsSync(join(redotcom, 'packages', 'server')), 'packages/server').toBe(false);
    expect(existsSync(join(redotcom, 'deploy')), 'the match server\'s deploy').toBe(false);
  });

  it('holds no match server address, transport, build switch or online word in any shipped source', () => {
    expect(shipped.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of shipped) {
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const [what, re] of ONLINE) if (re.test(line)) hits.push(`${relative(redotcom, f)}:${i + 1}: ${what}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('depends on no WebSocket library, and no workspace is the match server', () => {
    const manifests = [join(web, 'package.json'), ...files(redotcom, /^package\.json$/).filter((f) => !/node_modules|test-fixtures/.test(f))];
    for (const m of manifests) {
      const pkg = JSON.parse(readFileSync(m, 'utf8')) as { name?: string; dependencies?: object; devDependencies?: object; scripts?: Record<string, string> };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      expect(Object.keys(deps), relative(web, m)).not.toContain('ws');
      expect(Object.keys(deps), relative(web, m)).not.toContain('@types/ws');
      expect(pkg.name, relative(web, m)).not.toBe('@s2u/server');
      expect(JSON.stringify(pkg.scripts ?? {}), relative(web, m)).not.toMatch(/packages\/server/);
    }
  });

  it('keeps the offline match: the page runs the room in itself and joins it through the loopback', () => {
    const main = readFileSync(join(viewer, 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/new LoopbackMatch\(/);
    expect(main).toMatch(/new NetPage\(deps,/);
    expect(main).toMatch(/socket: solo\.socket/);
    const loopback = readFileSync(join(viewer, 'src', 'net', 'loopback.ts'), 'utf8');
    expect(loopback).toMatch(/from '\.\/room'/);
    const client = readFileSync(join(viewer, 'src', 'net', 'client.ts'), 'utf8');
    expect(client).toMatch(/socket: \(\) => WebSocketLike;/);              // handed in, never opened by the client
  });

  it('builds the site\'s redotcom with no multiplayer flag', () => {
    const deploy = readFileSync(join(web, 'shared', 'deploy', 'site', 'deploy.sh'), 'utf8');
    expect(deploy).toMatch(/npm run build -w @s2u\/redotcom/);
    expect(deploy).not.toMatch(/VITE_S2U_MULTIPLAYER|VITE_S2U_ROOMS/);
  });
});
