import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AssetSource } from '@s2u/archive';
import { loadSimClips, loadSimMap, loadSimSkeleton, parseRules, TICK_HZ, type ClientEvent, type Rules, type SimClips } from '../../viewer/src/sim';
import { Room, type RoomOptions } from './room';

/**
 * The server (web sprint 3, M3; W3.R6, W3.R9): one HTTP port for `/health`, `/metrics`, `/rooms` and the WebSocket
 * (`/ws`); one `Room` per map and rules (protocol 4: a hello names `respawn` or `classic`, the server's default when it
 * does not), made when its first client says hello and loaded from the private disc directory (never served);
 * the rooms stepped at the game's 60 Hz by a drift-corrected clock; per-connection rate limits; JSON-line logs.
 */

export interface ServerOptions {
  source: AssetSource;
  port: number;
  host: string;
  /** The maps a client may ask for (stems, `MP2`); empty: every `RUN/MP*.ZDB` the source holds. */
  maps: readonly string[];
  room: Partial<RoomOptions>;
  /** The rules of a hello that names none (`RULES`; respawn by default, W3.R11). */
  rules?: Rules;
  log: (entry: Record<string, unknown>) => void;
}

/** Frames a connection may send a second before the extras are dropped, and the burst it may run up. */
const RATE = { binary: 120, text: 40 };
/** A frame larger than this closes the connection (a command batch is 51 bytes, a fire event under 300). */
const MAX_PAYLOAD = 4096;
/** A connection that says nothing for this long after connecting is closed: it never said hello. */
const HELLO_MS = 10_000;
/** Body ids are one byte on the wire (`./codec`): a room hands out 1..255. */
const MAX_ID = 255;

interface Session { id: number; room: Room | null; socket: WebSocket; binary: number; text: number; strikes: number; address: string }

export class MatchServer {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
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

  constructor(private readonly opts: ServerOptions) {
    this.http = createServer((req, res) => this.request(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    this.http.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) { socket.destroy(); return; }
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
    let next = performance.now();
    const run = (): void => {
      const now = performance.now();
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
    const path = `RUN/${upper}.ZDB`;
    // The SEAL skeleton for the hit volumes: without it the room keeps the placeholder capsules.
    const body = loadSimSkeleton(this.opts.source, path).catch(() => null);
    const load = Promise.all([loadSimMap(this.opts.source, path), body]).then(([map, skeleton]) => {
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

  private allowed(stem: string): boolean {
    if (!/^MP\d{1,2}$/i.test(stem)) return false;
    return this.opts.maps.length === 0 || this.opts.maps.includes(stem.toUpperCase());
  }

  // ---- sessions ----

  private connect(socket: WebSocket, req: IncomingMessage): void {
    const address = (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? '').trim();
    const session: Session = { id: 0, room: null, socket, binary: 0, text: 0, strikes: 0, address };
    this.sessions.add(session);
    const hello = setTimeout(() => { if (!session.room) socket.close(4003, 'no hello'); }, HELLO_MS);
    const conn = {
      send: (frame: Uint8Array | string): void => {
        if (socket.readyState !== socket.OPEN) return;
        this.bytesOut += typeof frame === 'string' ? frame.length : frame.byteLength;
        socket.send(frame);
      },
      close: (code: number, reason: string): void => socket.close(code, reason),
    };
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        if (++session.binary > RATE.binary) { this.strike(session); return; }
        if (session.room) session.room.binary(session.id, toBytes(data));
        return;
      }
      if (++session.text > RATE.text) { this.strike(session); return; }
      let ev: ClientEvent;
      try { ev = JSON.parse(data.toString()) as ClientEvent; } catch { this.strike(session); return; }
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') { this.strike(session); return; }
      if (ev.type === 'hello') {
        if (session.room) return;
        if (typeof ev.map !== 'string' || !this.allowed(ev.map)) { conn.send(JSON.stringify({ type: 'refused', reason: 'no such map' })); socket.close(4004, 'no such map'); return; }
        const rules = ev.rules === undefined ? (this.opts.rules ?? 'respawn') : parseRules(ev.rules);
        if (!rules) { conn.send(JSON.stringify({ type: 'refused', reason: 'no such rules' })); socket.close(4004, 'no such rules'); return; }
        void this.room(ev.map, rules).then((room) => {
          if (socket.readyState !== socket.OPEN) return;
          const id = freeId(room);
          if (id === null) { conn.send(JSON.stringify({ type: 'refused', reason: 'The game is full.' })); socket.close(4000, 'full'); return; }
          session.id = id;
          if (room.hello(id, conn, { ...ev, name: String(ev.name ?? '') }, address)) {
            session.room = room;
            clearTimeout(hello);
            this.opts.log({ level: 'info', msg: 'joined', map: room.map.stem, rules, id, address });
          }
        }, (e) => {
          this.opts.log({ level: 'error', msg: 'room load failed', map: ev.map, error: String(e) });
          socket.close(1011, 'map failed to load');
        });
        return;
      }
      session.room?.text(session.id, ev);
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
