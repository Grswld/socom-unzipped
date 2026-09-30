import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AssetSource } from '@s2u/archive';
import {
  groundGrid, loadSimClips, loadSimMap, loadSimSkeleton, offeredRules, parseRules, RESPAWN_RULES_ENABLED, TICK_HZ,
  type ClientEvent, type Rules, type SimClips, type SimMap, type SimSkeleton,
} from '../../viewer/src/sim';
import { Room, type RoomOptions } from './room';

/**
 * The server (web sprint 3, M3; W3.R6, W3.R9): one HTTP port for `/health`, `/metrics`, `/rooms` and the WebSocket
 * (`/ws`); one `Room` per map and rules (protocol 4: a hello names `respawn` or `classic`, the server's default when it
 * does not), made when its first client says hello and loaded from the private disc directory (never served) -- a
 * map's two rules rooms share one parse of it (`forkSimMap`); the rooms stepped at the game's 60 Hz by a
 * drift-corrected clock; per-connection rate limits; a WebSocket ping/pong heartbeat; JSON-line logs. While the
 * respawn ruleset is off (owner ruling 2026-09-29, `RESPAWN_RULES_ENABLED`) every room is classic (`respawnRules`).
 *
 * The public surface (owner ruling 2026-09-29, OWNER-4): `/health`, `/rooms` (anonymous per-room counts, CORS `*`)
 * and `/ws`; `/metrics` is for the host only (the Caddyfile's 403, the tunnel's ingress). `deploy/README.md` names
 * them and `test/deployEnv.test.ts` pins the set.
 */

export interface ServerOptions {
  source: AssetSource;
  port: number;
  host: string;
  /** The maps a client may ask for (stems, `MP2`); empty: every `RUN/MP*.ZDB` the source holds. */
  maps: readonly string[];
  room: Partial<RoomOptions>;
  /** The rules of a hello that names none (`RULES`; classic by default: the only ruleset while respawn is off). */
  rules?: Rules;
  /**
   * Whether respawn rooms are opened (`RESPAWN_RULES_ENABLED`, off by the owner's ruling of 2026-09-29: "Remove the
   * respawn option entirely for the time being"). Off, every room is classic: a hello asking for respawn, or naming no
   * rules, joins the map's classic room, and `/rooms` lists classic rooms only. The respawn room's tests turn it on.
   */
  respawnRules?: boolean;
  log: (entry: Record<string, unknown>) => void;
  /**
   * `TRUST_PROXY`: the server sits behind a proxy that writes the client's address into `X-Forwarded-For` (Caddy,
   * cloudflared): the address -- the vote ban's key -- is that header's LAST entry. Off, the header is never read.
   */
  trustProxy?: boolean;
  /** The heartbeat's sweep (`HEARTBEAT_MS`); the tests shorten it. */
  heartbeatMs?: number;
}

/** Frames a connection may send a second before the extras are dropped, and the burst it may run up. */
const RATE = { binary: 120, text: 40 };
/** A frame larger than this closes the connection (a command batch is 51 bytes, a fire event under 300). */
const MAX_PAYLOAD = 4096;
/** A connection that says nothing for this long after connecting is closed: it never said hello. */
const HELLO_MS = 10_000;
/** Body ids are one byte on the wire (`./codec`): a room hands out 1..255. */
const MAX_ID = 255;
/** The WebSocket's path: an upgrade anywhere else is refused. */
const WS_PATH = '/ws';
/**
 * The heartbeat (a server policy, not a game value): every sweep pings each socket at the WebSocket protocol level
 * (RFC 6455 section 5.5.2; browsers answer on their own), and a socket that has not answered the previous sweep's
 * ping is terminated -- its close frees its seat. A socket is dropped 5-10 s after it stops answering. Never a silence
 * sweep: a watcher sends nothing after its hello.
 */
export const HEARTBEAT_MS = 5_000;

type Conn = { send(frame: Uint8Array | string): void; close(code: number, reason: string): void };

interface Session {
  id: number; room: Room | null; socket: WebSocket; binary: number; text: number; strikes: number; address: string;
  /** A hello is being answered (the room's load, then its `hello`): a second hello is refused, not answered twice. */
  joining: boolean;
  /** Answered the last heartbeat ping. */
  alive: boolean;
  /** A frame threw inside the room: logged once per connection. */
  threw: boolean;
}

/** What the heartbeat sweeps: a flag and a socket. */
export interface Beat { alive: boolean; socket: { ping(): void; terminate(): void } }

/**
 * One heartbeat sweep: a socket that has not answered since the last sweep is terminated; each other one is marked
 * unanswered and pinged (its pong marks it again). Returns how many were terminated.
 */
export function sweepHeartbeat(beats: Iterable<Beat>): number {
  let dropped = 0;
  for (const b of beats) {
    if (!b.alive) { b.socket.terminate(); dropped++; continue; }
    b.alive = false;
    try { b.socket.ping(); } catch { /* a socket closing under the sweep: its close is on the way */ }
  }
  return dropped;
}

/**
 * The client's address, the vote ban's key (`Room.banned`). Behind a trusted proxy it is the LAST `X-Forwarded-For`
 * entry: Caddy (v2) replaces a client's own header with the peer it saw, Cloudflare appends that peer after it, so
 * the last entry is the proxy's word either way and a client's own entries only ever come before it.
 * Never a loopback test on the peer (behind compose every client's peer is the proxy: one ban would ban them all).
 */
export function clientAddress(forwarded: string | string[] | undefined, remote: string | undefined, trustProxy: boolean): string {
  if (trustProxy && forwarded !== undefined) {
    const entries = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').map((e) => e.trim()).filter(Boolean);
    const last = entries.at(-1);
    if (last) return last;
  }
  return (remote ?? '').trim();
}

/**
 * A room's own copy of a shared parse (PL-10): the doors (`DoorSet`) rewrite the hull's points in place, so a map with
 * doors gives each room its own points and the grid over them; everything else (the spawn slots, the doors' specs, the
 * name) is read only and shared. A map without doors is shared whole. `map` must be the pristine parse.
 */
export function forkSimMap(map: SimMap): SimMap {
  if (!map.doors?.length) return map;
  const ground = { ...map.ground, points: Float32Array.from(map.ground.points) };
  return { ...map, ground, grid: groundGrid(ground) };
}

export class MatchServer {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  /** Each map's parse, kept pristine and shared by its rules rooms (`forkSimMap`). */
  private readonly parsed = new Map<string, Promise<{ map: SimMap; skeleton: SimSkeleton | null }>>();
  private clips: SimClips | null = null;
  private readonly http: HttpServer;
  private readonly wss: WebSocketServer;
  private timer: NodeJS.Timeout | null = null;
  private readonly sessions = new Set<Session>();
  private readonly started = Date.now();
  /** Step timings: the last second's worst and mean, milliseconds. */
  private readonly stepMs: number[] = [];
  private bytesOut = 0;
  private ticks = 0;
  private lastBeat = 0;

  constructor(private readonly opts: ServerOptions) {
    this.http = createServer((req, res) => this.request(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith(WS_PATH)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, req));
    });
  }

  async start(): Promise<number> {
    try { this.clips = await loadSimClips(this.opts.source); } catch (e) {
      this.opts.log({ level: 'warn', msg: 'no MOTION_P.ZAR: movers run without the clips\' root motion', error: String(e) });
    }
    await new Promise<void>((resolve) => this.http.listen(this.opts.port, this.opts.host, resolve));
    this.loop();
    const address = this.http.address();
    const port = typeof address === 'object' && address ? address.port : this.opts.port;
    this.opts.log({ level: 'info', msg: 'listening', port, host: this.opts.host });
    return port;
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const s of this.sessions) s.socket.close(1001, 'server stopping');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  // ---- the clock ----

  private loop(): void {
    const period = 1000 / TICK_HZ;
    const beat = this.opts.heartbeatMs ?? HEARTBEAT_MS;
    let next = performance.now();
    this.lastBeat = next;
    const run = (): void => {
      const now = performance.now();
      if (now - this.lastBeat >= beat) { this.lastBeat = now; sweepHeartbeat(this.sessions); }
      let steps = 0;
      while (next <= now && steps < 5) {
        const t0 = performance.now();
        for (const room of this.rooms.values()) if (room.stats().players + room.stats().spectators > 0) room.step();
        this.stepMs.push(performance.now() - t0);
        if (this.stepMs.length > TICK_HZ) this.stepMs.shift();
        this.ticks++;
        next += period;
        steps++;
      }
      if (next < now - period * 5) next = now;                  // a long stall is dropped, not replayed
      this.timer = setTimeout(run, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(run, 0);
  }

  // ---- rooms ----

  /** The room for a map under its rules, keyed `MP2` (respawn, as before protocol 4) or `MP2/classic`. */
  private room(stem: string, rules: Rules): Promise<Room> {
    const upper = stem.toUpperCase();
    const key = rules === 'respawn' ? upper : `${upper}/${rules}`;
    const have = this.rooms.get(key);
    if (have) return Promise.resolve(have);
    const pending = this.loading.get(key);
    if (pending) return pending;
    const load = this.parse(upper).then(({ map: parse, skeleton }) => {
      const map = forkSimMap(parse);
      const room = new Room(map, this.clips, { ...this.opts.room, rules }, skeleton);
      this.rooms.set(key, room);
      this.loading.delete(key);
      this.opts.log({ level: 'info', msg: 'room loaded', map: upper, rules, name: map.name, hitVolumes: skeleton ? skeleton.model : 'placeholder', slots: map.slots.length, respawns: map.respawns.length, notes: map.notes });
      return room;
    });
    load.catch(() => this.loading.delete(key));
    this.loading.set(key, load);
    return load;
  }

  /** A map's parse, read from the disc once for both its rules rooms (PL-10); a failed read is not kept. */
  private parse(upper: string): Promise<{ map: SimMap; skeleton: SimSkeleton | null }> {
    const have = this.parsed.get(upper);
    if (have) return have;
    const path = `RUN/${upper}.ZDB`;
    // The SEAL skeleton for the hit volumes: without it the room keeps the placeholder capsules.
    const body = loadSimSkeleton(this.opts.source, path).catch(() => null);
    const load = Promise.all([loadSimMap(this.opts.source, path), body]).then(([map, skeleton]) => ({ map, skeleton }));
    load.catch(() => this.parsed.delete(upper));
    this.parsed.set(upper, load);
    return load;
  }

  /** A loaded room by its key (`MP2`, `MP2/classic`), for the tests. */
  loadedRoom(key: string): Room | undefined {
    return this.rooms.get(key);
  }

  private allowed(stem: string): boolean {
    if (!/^MP\d{1,2}$/i.test(stem)) return false;
    return this.opts.maps.length === 0 || this.opts.maps.includes(stem.toUpperCase());
  }

  // ---- sessions ----

  private connect(socket: WebSocket, req: IncomingMessage): void {
    const address = clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress, this.opts.trustProxy === true);
    const session: Session = { id: 0, room: null, socket, binary: 0, text: 0, strikes: 0, address, joining: false, alive: true, threw: false };
    this.sessions.add(session);
    const hello = setTimeout(() => { if (!session.room) socket.close(4003, 'no hello'); }, HELLO_MS);
    const conn: Conn = {
      send: (frame) => {
        if (socket.readyState !== socket.OPEN) return;
        this.bytesOut += typeof frame === 'string' ? frame.length : frame.byteLength;
        socket.send(frame);
      },
      close: (code, reason) => socket.close(code, reason),
    };
    socket.on('pong', () => { session.alive = true; });
    socket.on('message', (data, isBinary) => {
      // ws emits 'message' synchronously from the socket's data handler: a throw here would take the process (and
      // every match on it) down. Whatever a frame makes the room throw costs that connection a strike, nothing more.
      try {
        this.message(session, conn, hello, data, isBinary);
      } catch (e) {
        if (!session.threw) {
          session.threw = true;
          this.opts.log({ level: 'warn', msg: 'frame threw', id: session.id, map: session.room?.map.stem, error: String(e) });
        }
        this.strike(session);
      }
    });
    socket.on('close', () => {
      clearTimeout(hello);
      this.sessions.delete(session);
      if (session.room) {
        session.room.leave(session.id);
        this.opts.log({ level: 'info', msg: 'left', map: session.room.map.stem, rules: session.room.rules, id: session.id });
      }
    });
    socket.on('error', () => undefined);
  }

  /** One frame from a connection: a command batch, a hello, or an event for its room. */
  private message(session: Session, conn: Conn, hello: NodeJS.Timeout, data: unknown, isBinary: boolean): void {
    const socket = session.socket;
    if (isBinary) {
      if (++session.binary > RATE.binary) { this.strike(session); return; }
      if (session.room) session.room.binary(session.id, toBytes(data));
      return;
    }
    if (++session.text > RATE.text) { this.strike(session); return; }
    let ev: ClientEvent;
    try { ev = JSON.parse(String(data)) as ClientEvent; } catch { this.strike(session); return; }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') { this.strike(session); return; }
    if (ev.type === 'hello') {
      // One hello per connection: `session.room` is set only once the room has answered, so a second hello in the
      // same burst, or during the map's first load, would otherwise take a second id on the same socket -- a member
      // no close ever removes.
      if (session.room || session.joining) { this.strike(session); return; }
      if (typeof ev.map !== 'string' || !this.allowed(ev.map)) { conn.send(JSON.stringify({ type: 'refused', reason: 'no such map' })); socket.close(4004, 'no such map'); return; }
      const asked = ev.rules === undefined ? (this.opts.rules ?? null) : parseRules(ev.rules);
      if (ev.rules !== undefined && !asked) { conn.send(JSON.stringify({ type: 'refused', reason: 'no such rules' })); socket.close(4004, 'no such rules'); return; }
      const rules = offeredRules(asked, this.opts.respawnRules ?? RESPAWN_RULES_ENABLED);
      session.joining = true;
      const map = ev.map;
      this.room(map, rules).then((room) => {
        if (socket.readyState !== socket.OPEN) return;
        const id = freeId(room);
        if (id === null) { conn.send(JSON.stringify({ type: 'refused', reason: 'The game is full.' })); socket.close(4000, 'full'); return; }
        let joined = false;
        try {
          joined = room.hello(id, conn, { ...ev, name: String(ev.name ?? '') }, session.address);
        } catch (e) {
          // The room threw answering the hello: whatever it seated goes again, and so does that socket; the process
          // and the room stay.
          try { room.leave(id); } catch { /* nothing was seated */ }
          this.opts.log({ level: 'error', msg: 'hello threw', map, error: String(e) });
          socket.close(1011, 'hello failed');
          return;
        }
        if (joined) {
          session.id = id;
          session.room = room;
          clearTimeout(hello);
          this.opts.log({ level: 'info', msg: 'joined', map: room.map.stem, rules, id, address: session.address });
        }
      }, (e: unknown) => {
        this.opts.log({ level: 'error', msg: 'room load failed', map, error: String(e) });
        socket.close(1011, 'map failed to load');
      }).catch((e: unknown) => {
        this.opts.log({ level: 'error', msg: 'join failed', map, error: String(e) });
        socket.close(1011, 'join failed');
      }).finally(() => { session.joining = false; });
      return;
    }
    session.room?.text(session.id, ev);
  }

  /** A frame past the rate: dropped; a connection that keeps at it is closed. */
  private strike(s: Session): void {
    if (++s.strikes > 200) s.socket.close(4005, 'rate');
  }

  // ---- HTTP ----

  private request(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: Math.round((Date.now() - this.started) / 1000), rooms: this.rooms.size }));
      return;
    }
    if (req.url === '/rooms') {
      // The room list: each loaded room's map, rules, players, spectators and round.
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify([...this.rooms.values()].map((room) => ({ map: room.map.stem.toUpperCase(), ...room.stats() }))));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(this.metrics());
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /** Prometheus text: the rooms, the step's cost, the traffic. */
  metrics(): string {
    const lines: string[] = [];
    const mean = this.stepMs.length ? this.stepMs.reduce((a, b) => a + b, 0) / this.stepMs.length : 0;
    lines.push(`s2u_step_ms_mean ${mean.toFixed(3)}`, `s2u_step_ms_max ${Math.max(0, ...this.stepMs).toFixed(3)}`);
    lines.push(`s2u_ticks_total ${this.ticks}`, `s2u_bytes_out_total ${this.bytesOut}`, `s2u_connections ${this.sessions.size}`);
    for (const room of this.rooms.values()) {
      const s = room.stats();
      const at = `map="${room.map.stem.toUpperCase()}",rules="${s.rules}"`;
      lines.push(`s2u_room_players{${at}} ${s.players}`, `s2u_room_spectators{${at}} ${s.spectators}`, `s2u_room_round{${at}} ${s.round}`);
    }
    return `${lines.join('\n')}\n`;
  }

  /** Per-second counters: the rate limits' windows. */
  resetRates(): void {
    for (const s of this.sessions) { s.binary = 0; s.text = 0; }
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]));
  return new Uint8Array(0);
}

/** The lowest id 1..255 the room has not handed out. */
function freeId(room: Room): number | null {
  const taken = new Set([...room.lobby.players(), ...room.lobby.spectators()].map((m) => m.id));
  for (let id = 1; id <= MAX_ID; id++) if (!taken.has(id)) return id;
  return null;
}
