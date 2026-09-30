import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { FsAssetSource } from '@s2u/archive/node';
import type { AssetSource } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { decodeSnapshot, DoorSet, encodeCommands, loadSimMap, PROTOCOL_VERSION, RESPAWN_RULES_ENABLED, type ServerEvent, type SimMap } from '../../viewer/src/sim';
import { Room } from '../src/room';
import { clientAddress, etagMatches, forkSimMap, HEARTBEAT_MS, MatchServer, roomsBody, roomsHeaders, ROOMS_MAX_AGE, sweepHeartbeat, type Beat } from '../src/server';

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
    // The respawn ruleset is off by the owner's ruling of 2026-09-29 (`RESPAWN_RULES_ENABLED`); its rooms are kept, so
    // this server turns it on to keep them pinned. The server as shipped is the next describe's.
    server = new MatchServer({ source: new FsAssetSource(FIXTURES), port: 0, host: '127.0.0.1', maps: [], room: {}, log: (e) => log.push(e), respawnRules: true });
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

/**
 * Classic only (owner ruling, 2026-09-29: "Remove the respawn option entirely for the time being. No mode selection."):
 * the server as shipped (`respawnRules` left to `RESPAWN_RULES_ENABLED`, off) opens classic rooms and nothing else.
 */
describe.skipIf(!MP2)(`the match server as shipped: classic rooms only${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let server: MatchServer, port = 0;
  beforeAll(async () => {
    server = new MatchServer({ source: new FsAssetSource(FIXTURES), port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined });
    port = await server.start();
  });
  afterAll(async () => { await server.stop(); });

  it('a hello asking for respawn, one naming no rules and one asking for classic all join the map classic room', async () => {
    expect(RESPAWN_RULES_ENABLED).toBe(false);
    const asks = await Promise.all([connect(port, 'Resp', 'MP2', 'respawn'), connect(port, 'None', 'MP2'), connect(port, 'Clas', 'MP2', 'classic')]);
    await until(() => asks.every((p) => p.events.some((e) => e.type === 'welcome')));
    for (const p of asks) expect(p.events.find((e) => e.type === 'welcome')).toMatchObject({ rules: 'classic', rounds: 11 });
    const rooms = await (await fetch(`http://127.0.0.1:${port}/rooms`)).json() as { map: string; rules: string; players: number }[];
    expect(rooms.map((r) => [r.map, r.rules, r.players])).toEqual([['MP2', 'classic', 3]]);
    // The list is the counts alone, no tick (it would make every answer new, `roomsBody`); unchanged, it revalidates.
    expect(Object.keys(rooms[0]!).sort()).toEqual(['map', 'players', 'round', 'rules', 'spectators']);
    const first = await fetch(`http://127.0.0.1:${port}/rooms`);
    const etag = first.headers.get('etag')!;
    const again = await fetch(`http://127.0.0.1:${port}/rooms`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    asks[0]!.ws.close();
    await until(() => server.metrics().includes('s2u_room_players{map="MP2",rules="classic"} 2'));
    const moved = await fetch(`http://127.0.0.1:${port}/rooms`, { headers: { 'if-none-match': etag } });
    expect(moved.status).toBe(200);                                         // a player left: a new list, a new tag
    expect(moved.headers.get('etag')).not.toBe(etag);
    expect((await moved.json() as { players: number }[])[0]!.players).toBe(2);
    expect(server.loadedRoom('MP2')).toBeUndefined();                        // no respawn room was ever opened
    expect(server.metrics()).not.toMatch(/rules="respawn"/);
    const odd = await connect(port, 'Odd', 'MP2', 'deathmatch');             // rules that are not rules: still refused
    await until(() => odd.events.length > 0);
    expect(odd.events[0]).toMatchObject({ type: 'refused', reason: 'no such rules' });
    for (const p of asks) p.ws.close();
  });

  it('a RULES=respawn default is served classic too', async () => {
    const other = new MatchServer({ source: new FsAssetSource(FIXTURES), port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined, rules: 'respawn' });
    const at = await other.start();
    try {
      const p = await connect(at, 'Env');
      await until(() => p.events.some((e) => e.type === 'welcome'));
      expect(p.events.find((e) => e.type === 'welcome')).toMatchObject({ rules: 'classic' });
      p.ws.close();
    } finally { await other.stop(); }
  });
});

// ---- the pre-launch fixes (batch B2 of the launch list) ----

/** A socket that has opened and said nothing yet. */
function open(port: number, options: ConstructorParameters<typeof WebSocket>[2] = {}): Promise<Peer> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const peer: Peer = { ws, events: [], snaps: [] };
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, binary) => {
      if (binary) peer.snaps.push(new Uint8Array(data as Buffer));
      else peer.events.push(JSON.parse(data.toString()) as ServerEvent);
    });
    ws.on('open', () => ok(peer));
    ws.on('error', fail);
  });
}

const hello = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name, map: 'MP2', ...extra });

/** A masked client text frame (RFC 6455 section 5.2): two of them go out in one TCP write, as one burst. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
}
const rawWrite = (peer: Peer, bytes: Buffer): void => { (peer.ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(bytes); };

interface RoomRow { map: string; rules: string; players: number; spectators: number }
const roomsOf = async (port: number): Promise<RoomRow[]> => await (await fetch(`http://127.0.0.1:${port}/rooms`)).json() as RoomRow[];
const counts = async (port: number, rules = 'respawn'): Promise<[number, number]> => {
  const r = (await roomsOf(port)).find((x) => x.map === 'MP2' && x.rules === rules);
  return r ? [r.players, r.spectators] : [0, 0];
};
const welcomes = (p: Peer): number => p.events.filter((e) => e.type === 'welcome').length;
const closed = (p: Peer): Promise<number> => new Promise((ok) => {
  if (p.ws.readyState === p.ws.CLOSED) ok(-1); else p.ws.on('close', (code) => ok(code));
});
const emptyRoom = (server: MatchServer, rules = 'respawn'): boolean =>
  server.metrics().includes(`s2u_room_players{map="MP2",rules="${rules}"} 0`)
  && server.metrics().includes(`s2u_room_spectators{map="MP2",rules="${rules}"} 0`);

describe('the client address (TRUST_PROXY): the proxy\'s own entry, never a client\'s', () => {
  it('without a trusted proxy the header is ignored: the socket\'s peer is the address', () => {
    expect(clientAddress('192.0.2.66', '198.51.100.7', false)).toBe('198.51.100.7');
    expect(clientAddress(undefined, '198.51.100.7', false)).toBe('198.51.100.7');
  });
  it('behind a trusted proxy the LAST X-Forwarded-For entry is the one the proxy appended', () => {
    // A client that sends its own header gets it prefixed: `forged, real` -- the first entry is the client's word.
    expect(clientAddress('192.0.2.66, 203.0.113.9', '127.0.0.1', true)).toBe('203.0.113.9');
    expect(clientAddress(' 203.0.113.9 ', '127.0.0.1', true)).toBe('203.0.113.9');
    expect(clientAddress(['192.0.2.1', '192.0.2.66, 203.0.113.9'], '127.0.0.1', true)).toBe('203.0.113.9');
  });
  it('behind a trusted proxy with no header (a probe on the host) the peer is the address', () => {
    expect(clientAddress(undefined, '127.0.0.1', true)).toBe('127.0.0.1');
    expect(clientAddress(', ', '127.0.0.1', true)).toBe('127.0.0.1');
  });
});

describe('the heartbeat (WebSocket ping/pong): a socket that stops answering is terminated', () => {
  const beat = (answers: boolean): Beat & { terminated: number; pings: number } => {
    const b = {
      alive: true, terminated: 0, pings: 0,
      socket: { ping: () => { b.pings++; if (answers) b.alive = true; }, terminate: () => { b.terminated++; } },
    };
    return b;
  };
  it('is a 5 s sweep', () => { expect(HEARTBEAT_MS).toBe(5000); });
  it('a socket that answers every ping survives any number of sweeps', () => {
    const b = beat(true);
    for (let i = 0; i < 5; i++) sweepHeartbeat([b]);
    expect(b.terminated).toBe(0);
    expect(b.pings).toBe(5);
  });
  it('a socket that stops answering is terminated on the second sweep, not the first', () => {
    const b = beat(false);
    sweepHeartbeat([b]);
    expect(b.terminated).toBe(0);
    sweepHeartbeat([b]);
    expect(b.terminated).toBe(1);
  });
  it('a watcher that sends nothing after its hello but answers pings is kept (never a silence sweep)', () => {
    const watcher = beat(true), gone = beat(false);
    sweepHeartbeat([watcher, gone]);
    sweepHeartbeat([watcher, gone]);
    expect(watcher.terminated).toBe(0);
    expect(gone.terminated).toBe(1);
  });
});

describe.skipIf(!MP2)(`the match server's pre-launch holes${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let server: MatchServer, port = 0;
  const reads: string[] = [];
  beforeAll(async () => {
    const fs = new FsAssetSource(FIXTURES);
    const source: AssetSource = { list: () => fs.list(), read: (path) => { reads.push(path); return fs.read(path); } };
    server = new MatchServer({ source, port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined, heartbeatMs: 100, respawnRules: true });
    port = await server.start();
  });
  afterAll(async () => { await server.stop(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a double hello in the first load\'s window: one welcome, one member, none left after the close', async () => {
    const a = await open(port);
    a.ws.send(hello('Twice', { rules: 'classic' }));
    a.ws.send(hello('Twice', { rules: 'classic' }));
    await until(() => welcomes(a) > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(welcomes(a)).toBe(1);
    expect(await counts(port, 'classic')).toEqual([1, 0]);
    a.ws.close();
    await closed(a);
    await until(() => emptyRoom(server, 'classic'));
    expect(await counts(port, 'classic')).toEqual([0, 0]);
  });

  it('shares one parse of a map between its two rules rooms (the disc read once)', async () => {
    // The classic room (the test above) read the archive for its parse (the map, then the skeleton off it).
    const before = reads.filter((p) => p === 'RUN/MP2.ZDB').length;
    expect(before).toBeGreaterThan(0);
    const b = await open(port);
    b.ws.send(hello('Plain'));
    await until(() => welcomes(b) > 0);
    expect(reads.filter((p) => p === 'RUN/MP2.ZDB').length).toBe(before);
    const classic = server.loadedRoom('MP2/classic')!, respawn = server.loadedRoom('MP2')!;
    expect(classic.map.stem).toBe('MP2');
    expect(respawn.map.slots).toBe(classic.map.slots);                    // the parse is shared ...
    if (classic.map.doors?.length) expect(respawn.map.ground.points).not.toBe(classic.map.ground.points);   // ... the swinging hull is not
    b.ws.close();
    await closed(b);
    await until(() => emptyRoom(server));
  });

  it('two hellos in one burst to a loaded room: one welcome, players 1 / spectators 0, then 0 / 0', async () => {
    const a = await open(port);
    rawWrite(a, Buffer.concat([textFrame(hello('Burst')), textFrame(hello('Burst'))]));
    await until(() => welcomes(a) > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(welcomes(a)).toBe(1);
    expect(await counts(port)).toEqual([1, 0]);
    // A watcher's double hello the same way: one watcher place, not two.
    const w = await open(port);
    rawWrite(w, Buffer.concat([textFrame(hello('Eye', { watch: true })), textFrame(hello('Eye', { watch: true }))]));
    await until(() => welcomes(w) > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(await counts(port)).toEqual([1, 1]);
    a.ws.close(); w.ws.close();
    await Promise.all([closed(a), closed(w)]);
    await until(() => emptyRoom(server));
    expect(await counts(port)).toEqual([0, 0]);
  });

  it('a frame the room throws on (text or binary) costs a strike, never the process: /health answers, a second client joins', async () => {
    const a = await open(port);
    a.ws.send(hello('Breaker'));
    await until(() => welcomes(a) > 0);
    vi.spyOn(Room.prototype, 'text').mockImplementationOnce(() => { throw new TypeError('boom (text)'); });
    vi.spyOn(Room.prototype, 'binary').mockImplementationOnce(() => { throw new TypeError('boom (binary)'); });
    a.ws.send(JSON.stringify({ type: 'ping', t: 1 }));
    a.ws.send(encodeCommands({ viewTick: 0, commands: [{ seq: 1, forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }] }));
    // And the review's malformed events, as sent: the room drops or refuses them; the server must outlive any throw.
    for (const bad of [
      { type: 'fire' }, { type: 'fire', from: null, dir: null }, { type: 'throw', kind: 'M67' }, { type: 'throw', kind: 'constructor' },
      { type: 'name', name: null }, { type: 'vote', target: null }, { type: 'door', door: {} }, { type: 'reload', weapon: 'x' },
    ]) a.ws.send(JSON.stringify(bad));
    await new Promise((r) => setTimeout(r, 300));
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect(a.ws.readyState).toBe(a.ws.OPEN);                              // a strike, not a close
    const b = await open(port);
    b.ws.send(hello('After'));
    await until(() => welcomes(b) > 0);
    a.ws.close(); b.ws.close();
    await Promise.all([closed(a), closed(b)]);
    await until(() => emptyRoom(server));
  });

  it('a hello the room throws on closes that socket (1011) and nothing else', async () => {
    vi.spyOn(Room.prototype, 'hello').mockImplementationOnce(() => { throw new TypeError('boom (hello)'); });
    const a = await open(port);
    a.ws.send(hello('Thrown'));
    expect(await closed(a)).toBe(1011);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
  });

  it('terminates a socket that stops answering pings (the room frees its seat); one that answers stays', async () => {
    const live = await open(port), dead = await open(port, { autoPong: false });
    live.ws.send(hello('Live')); dead.ws.send(hello('Dead'));
    await until(() => welcomes(live) > 0 && welcomes(dead) > 0);
    expect((await counts(port))[0]).toBe(2);
    await closed(dead);
    await until(() => server.metrics().includes('s2u_room_players{map="MP2",rules="respawn"} 1'));
    await new Promise((r) => setTimeout(r, 400));                         // four more sweeps
    expect(live.ws.readyState).toBe(live.ws.OPEN);
    live.ws.close();
    await closed(live);
  });
});

describe.skipIf(!MP2)(`a map's two rules rooms share its parse, not its swinging hull${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('a door swung in one room\'s fork leaves the other fork and the parse untouched; a map without doors is shared whole', async () => {
    const source = new FsAssetSource(FIXTURES);
    let doorMap: SimMap | null = null, plainMap: SimMap | null = null;
    for (const stem of ['MP2', 'MP6', 'MP72']) {
      if (!fixture(`RUN/${stem}.ZDB`)) continue;
      const map = await loadSimMap(source, `RUN/${stem}.ZDB`);
      if (map.doors?.length) doorMap ??= map; else plainMap ??= map;
    }
    if (plainMap) expect(forkSimMap(plainMap)).toBe(plainMap);
    expect(doorMap).not.toBeNull();
    const parse = doorMap!;
    const pristine = Float32Array.from(parse.ground.points);
    const a = forkSimMap(parse), b = forkSimMap(parse);
    expect(a.ground.points).not.toBe(b.ground.points);
    expect(a.grid).not.toBe(b.grid);
    expect(a.slots).toBe(parse.slots);
    const doors = new DoorSet(a.doors!, a.ground);
    let used = false;
    for (let i = 0; i < doors.count && !used; i++) used = doors.use(i);
    expect(used).toBe(true);
    for (let t = 0; t < 180; t++) doors.step(1 / 60);
    expect(a.ground.points).not.toEqual(pristine);
    expect(b.ground.points).toEqual(pristine);
    expect(parse.ground.points).toEqual(pristine);
  }, 60_000);
});

/**
 * `/rooms` for the viewer's PLAYERS ONLINE poll (owner, 2026-09-29; `viewer/src/playersOnline.ts`): an ETag answered
 * with 304, `Cache-Control: public, max-age=10` so a CDN can fold a burst, and CORS `*` as before -- on the 200 and the
 * 304 alike. No fixtures needed: a server with no room loaded answers an empty list.
 */
describe('/rooms: a validator and a short public cache', () => {
  let server: MatchServer, port = 0;
  beforeAll(async () => {
    server = new MatchServer({ source: new FsAssetSource(resolve(FIXTURES, 'no-such-dir')), port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined });
    port = await server.start();
  });
  afterAll(async () => { await server.stop(); });
  const url = (): string => `http://127.0.0.1:${port}/rooms`;

  it('answers 200 with the list, CORS *, a strong ETag and Cache-Control: public, max-age=10', async () => {
    const res = await fetch(url());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=10');
    expect(ROOMS_MAX_AGE).toBe(10);
    expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]{16}"$/);
    expect(await res.json()).toEqual([]);
  });

  it('answers 304, no body, the same headers, to an If-None-Match that names its tag (weak, listed or *)', async () => {
    const etag = (await fetch(url())).headers.get('etag')!;
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await fetch(url(), { headers: { 'if-none-match': inm } });
      expect(res.status, inm).toBe(304);
      expect(res.headers.get('etag'), inm).toBe(etag);
      expect(res.headers.get('access-control-allow-origin'), inm).toBe('*');
      expect(res.headers.get('cache-control'), inm).toBe('public, max-age=10');
      expect(await res.text(), inm).toBe('');
    }
    const other = await fetch(url(), { headers: { 'if-none-match': '"not-it"' } });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual([]);
  });

  it('the tag is the body\'s: the same list the same tag, any change a new one; the tick is not in the list', () => {
    const room = (players: number, tick: number) => ({ map: { stem: 'mp2' }, stats: () => ({ players, spectators: 1, tick, round: 3, rules: 'classic' as const }) });
    const a = roomsBody([room(2, 100)]), b = roomsBody([room(2, 9_999)]), c = roomsBody([room(3, 100)]);
    expect(JSON.parse(a)).toEqual([{ map: 'MP2', rules: 'classic', players: 2, spectators: 1, round: 3 }]);
    expect(a).toBe(b);                                                         // the tick moved: nothing a reader sees did
    expect(roomsHeaders(a).etag).toBe(roomsHeaders(b).etag);
    expect(roomsHeaders(c).etag).not.toBe(roomsHeaders(a).etag);
  });

  it('matches If-None-Match by the weak comparison, and nothing else', () => {
    expect(etagMatches(undefined, '"x"')).toBe(false);
    expect(etagMatches('', '"x"')).toBe(false);
    expect(etagMatches('"x"', '"x"')).toBe(true);
    expect(etagMatches('W/"x"', '"x"')).toBe(true);
    expect(etagMatches(' "a" ,  "x"', '"x"')).toBe(true);
    expect(etagMatches(['"a"', '"x"'], '"x"')).toBe(true);
    expect(etagMatches('*', '"x"')).toBe(true);
    expect(etagMatches('"y"', '"x"')).toBe(false);
    expect(etagMatches('x', '"x"')).toBe(false);
  });
});
