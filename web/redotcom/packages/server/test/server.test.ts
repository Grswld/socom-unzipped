import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { decodeSnapshot, encodeCommands, PROTOCOL_VERSION, type ServerEvent } from '../../viewer/src/sim';
import { MatchServer } from '../src/server';

/** The server over a real socket (web sprint 3, M3): Frostfire from the fixtures, two clients, snapshots both ways. */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

interface Peer { ws: WebSocket; events: ServerEvent[]; snaps: Uint8Array[] }

function connect(port: number, name: string, map = 'MP2', rules?: string, version = PROTOCOL_VERSION): Promise<Peer> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer: Peer = { ws, events: [], snaps: [] };
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, binary) => {
      if (binary) peer.snaps.push(new Uint8Array(data as Buffer));
      else peer.events.push(JSON.parse(data.toString()) as ServerEvent);
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', version, name, map, ...(rules ? { rules } : {}) })); ok(peer); });
    ws.on('error', fail);
  });
}

const until = async (test: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe.skipIf(!MP2)(`the match server on Frostfire${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let server: MatchServer, port = 0;
  const log: Record<string, unknown>[] = [];
  beforeAll(async () => {
    server = new MatchServer({ source: new FsAssetSource(FIXTURES), port: 0, host: '127.0.0.1', maps: [], room: {}, log: (e) => log.push(e) });
    port = await server.start();
  });
  afterAll(async () => { await server.stop(); });

  it('welcomes two clients, streams each the other at 30 Hz, and runs their commands', async () => {
    const a = await connect(port, 'Alpha'), b = await connect(port, 'Bravo');
    await until(() => a.events.some((e) => e.type === 'welcome') && b.events.some((e) => e.type === 'welcome'));
    const wa = a.events.find((e) => e.type === 'welcome') as Extract<ServerEvent, { type: 'welcome' }>;
    expect(wa).toMatchObject({ role: 'player', map: 'MP2', name: 'Alpha' });
    await until(() => a.snaps.length > 10 && b.snaps.length > 10);
    const snap = decodeSnapshot(a.snaps.at(-1)!);
    expect(snap.bodies.map((x) => x.id)).toEqual([wa.id === 1 ? 2 : 1]);
    const spawn = a.events.filter((e) => e.type === 'spawn' && e.id === wa.id).at(-1) as Extract<ServerEvent, { type: 'spawn' }>;
    const commands = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, forward: 1, right: 0, yaw: spawn.yaw, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }));
    for (let i = 0; i < 30; i += 3) a.ws.send(encodeCommands({ viewTick: 0, commands: commands.slice(Math.max(0, i - 2), i + 3) }));
    await until(() => decodeSnapshot(a.snaps.at(-1)!).own?.ack === 30);
    const own = decodeSnapshot(a.snaps.at(-1)!).own!;
    expect(Math.hypot(own.x - spawn.at[0], own.z - spawn.at[2])).toBeGreaterThan(5);
    a.ws.close(); b.ws.close();
    await until(() => server.metrics().includes('s2u_room_players{map="MP2",rules="respawn"} 0'));
  });

  it('answers /health and /metrics, and refuses a map it does not have', async () => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { ok: boolean };
    expect(health.ok).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toMatch(/s2u_step_ms_mean/);
    const bad = await connect(port, 'X', '../etc');
    await until(() => bad.events.length > 0);
    expect(bad.events[0]).toMatchObject({ type: 'refused' });
  });

  it('keys the rooms by map and rules: the hello names them (the server default without); each room is listed with its rules', async () => {
    const a = await connect(port, 'Classic', 'MP2', 'classic'), b = await connect(port, 'Plain', 'MP2');
    await until(() => a.events.some((e) => e.type === 'welcome') && b.events.some((e) => e.type === 'welcome'));
    expect(a.events.find((e) => e.type === 'welcome')).toMatchObject({ rules: 'classic', rounds: 11 });
    expect(b.events.find((e) => e.type === 'welcome')).toMatchObject({ rules: 'respawn', rounds: 11 });
    const rooms = await (await fetch(`http://127.0.0.1:${port}/rooms`)).json() as { map: string; rules: string; players: number }[];
    expect(rooms.filter((r) => r.map === 'MP2').map((r) => [r.rules, r.players]).sort()).toEqual([['classic', 1], ['respawn', 1]]);
    const odd = await connect(port, 'Odd', 'MP2', 'deathmatch');
    await until(() => odd.events.length > 0);
    expect(odd.events[0]).toMatchObject({ type: 'refused', reason: 'no such rules' });
    const old = await connect(port, 'Old', 'MP2', undefined, 2);
    await until(() => old.events.length > 0);
    expect(old.events[0]).toMatchObject({ type: 'refused' });   // an older protocol is refused
    a.ws.close(); b.ws.close();
  });
});
