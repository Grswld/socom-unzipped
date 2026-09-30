import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { runBots, type Report } from '../../../tools/mp-bots';
import { MatchServer } from '../src/server';

/** The bot harness (tools/mp-bots.ts) against the in-process server: 16 players (the room's cap: only joiners past it are queued) and 2 spectators for 5 s. */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)(`the bots against the match server${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let server: MatchServer, port = 0;
  beforeAll(async () => {
    // A respawn room (the harness's measure predates classic-only, owner ruling 2026-09-29): the flag forced on.
    server = new MatchServer({ source: new FsAssetSource(FIXTURES), port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined, respawnRules: true });
    port = await server.start();
  });
  afterAll(async () => { await server.stop(); });

  it('seats 16 players (the room limit) and queues 2 spectators; snapshots at 30 Hz, no snap, 60 Hz held', async () => {
    const report: Report = await runBots({
      url: `ws://127.0.0.1:${port}/ws`, map: 'MP2', players: 16, spectators: 2, seconds: 5, lag: 0, loss: 0,
      source: new FsAssetSource(FIXTURES), server,
    });
    const players = report.bots.filter((b) => b.role === 'player');
    const spectators = report.bots.filter((b) => b.role === 'spectator');
    expect(players.length).toBe(16);
    expect(spectators.map((b) => b.queue)).toEqual([1, 2]);
    for (const p of players) expect(p.rateMean).toBeGreaterThanOrEqual(25);
    expect(report.summary.corrections.snapped).toBe(0);
    expect(report.summary.serverTicks).toBeGreaterThanOrEqual(280);
  }, 30_000);
});
