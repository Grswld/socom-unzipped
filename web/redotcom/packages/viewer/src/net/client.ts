import { decodeSnapshot, encodeCommands, frameKind } from './codec';
import {
  COMMAND_REDUNDANCY, Frame, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_HZ,
  type BodyState, type ClientEvent, type Command, type DoorWire, type Role, type ServerEvent, type Snapshot, type Team,
} from './protocol';

/**
 * The page's end of the match (web sprint 3, M4; W3.R8-R10): the socket, the commands numbered and sent every tick
 * with the last `COMMAND_REDUNDANCY` repeated, the prediction checked against each snapshot's own state (smoothed
 * under `SNAP_DISTANCE`, snapped past it), the respawns replayed, the server's clock, and the other players' bodies
 * held `INTERP_DELAY_MS` behind it and drawn between two snapshots. A latency/loss injector (`simulate`) sits under
 * the socket for the tests and the playtest's network matrix (the bar's 0-150 ms, 1-2 % loss).
 */

/** What the net client drives on the page (`./walk` `WalkMode`). */
export interface NetWalk {
  setNetTap(tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null): void;
  respawn(at: readonly [number, number, number], yaw: number, replay?: readonly Command[]): boolean;
  nudge(dx: number, dy: number, dz: number): void;
  setLocked(on: boolean): void;
}

export interface Simulate {
  /** One-way delay each way, ms, and its jitter (uniform +-). */
  latencyMs: number; jitterMs?: number;
  /** The share of frames lost each way (commands and snapshots; the JSON events ride a reliable socket). */
  loss?: number;
}

export interface NetOptions {
  url: string;
  map: string;
  name: string;
  simulate?: Simulate;
  /** Join as a watcher (the map viewer's Online setting): a spectator that never plays, so the walk is not driven. */
  watch?: boolean;
  random?: () => number;
  /** A socket for the tests (a `WebSocket`-alike); the page's own by default. */
  socket?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** The others are drawn this far behind the server: two snapshot intervals and a margin for jitter. */
export const INTERP_DELAY_MS = 100;
/** A prediction error past this (units) is snapped at once; under it, spread over `SMOOTH_TICKS` (bar 1: never snapped otherwise). */
export const SNAP_DISTANCE = 24;
/** An error under this is float noise, not a correction. */
export const CORRECTION_FLOOR = 0.001;
/** Ticks over which a small correction is spread (100 ms). */
export const SMOOTH_TICKS = 6;
/** Commands kept for replay and reconciliation: 10 s. */
const HISTORY = 10 * TICK_HZ;
/** Snapshots kept for the others' interpolation. */
const SNAPSHOTS = 32;

interface Sent { cmd: Command; feet: [number, number, number] | null }
interface Received { snap: Snapshot; at: number }

export type NetState = 'connecting' | 'open' | 'closed' | 'refused';

export class NetClient {
  id = 0;
  role: Role = 'spectator';
  team: Team | null = null;
  state: NetState = 'connecting';
  queue = 0;
  /** Round trip, ms (the last pong). */
  rtt = 0;
  /** Corrections taken: small (smoothed) and snapped, and the largest error seen -- the playtest's numbers. */
  readonly corrections = { small: 0, snapped: 0, largest: 0 };
  private readonly socket: WebSocketLike;
  private seq = 0;
  private readonly history: Sent[] = [];
  private readonly snaps: Received[] = [];
  private correction: [number, number, number] = [0, 0, 0];
  private correctionTicks = 0;
  private readonly listeners = new Set<(ev: ServerEvent) => void>();
  private readonly random: () => number;
  private lastPing = 0;
  private alive = false;

  constructor(private readonly opts: NetOptions, private readonly walk: NetWalk) {
    this.random = opts.random ?? Math.random;
    this.socket = (opts.socket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike))(opts.url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => {
      this.state = 'open';
      this.out(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, name: opts.name, map: opts.map, ...(opts.watch ? { watch: true } : {}) } satisfies ClientEvent), true);
    };
    this.socket.onclose = () => {
      if (this.state !== 'refused') this.state = 'closed';
      if (!opts.watch) { this.walk.setNetTap(null); this.walk.setLocked(false); }
    };
    this.socket.onerror = () => undefined;
    this.socket.onmessage = (ev) => this.delayed(() => this.receive(ev.data), false);
    if (!opts.watch) {
      walk.setNetTap((cmd, feet) => this.tick(cmd, feet));
      walk.setLocked(true);                                    // until the server stands the mover somewhere
    }
  }

  /** Listens for the server's events (the HUD, the kill lines, the scoreboard); returns the unsubscribe. */
  on(listener: (ev: ServerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(ev: ClientEvent): void {
    this.out(JSON.stringify(ev), true);
  }

  close(): void {
    if (!this.opts.watch) { this.walk.setNetTap(null); this.walk.setLocked(false); }
    this.socket.close(1000, 'left');
  }

  /** The command number of the last tick sent (a round fired in this frame names it). */
  lastSeq(): number {
    return this.seq;
  }

  // ---- up ----

  private tick(partial: Omit<Command, 'seq'>, feet: [number, number, number]): void {
    const cmd: Command = { ...partial, seq: ++this.seq };
    // The prediction is where the mover is plus the correction still to be spread: the two sum to where it should be,
    // and each step of `applyCorrection` moves the one into the other.
    const c = this.correction;
    this.history.push({ cmd, feet: this.alive ? [feet[0] + c[0], feet[1] + c[1], feet[2] + c[2]] : null });
    if (this.history.length > HISTORY) this.history.shift();
    this.applyCorrection();
    if (this.state !== 'open' || this.role !== 'player') return;
    const batch = this.history.slice(-COMMAND_REDUNDANCY).map((h) => h.cmd);
    this.out(encodeCommands({ viewTick: this.viewTick(), commands: batch }), false);
    const now = performance.now();
    if (now - this.lastPing > 2000) { this.lastPing = now; this.send({ type: 'ping', t: now }); }
  }

  private out(frame: string | Uint8Array, reliable: boolean): void {
    this.delayed(() => { if (this.socket.readyState === 1) this.socket.send(frame); }, !reliable);
  }

  /** The injector: a delay each way, and a lost frame (never a JSON event: those ride TCP in the real world too). */
  private delayed(run: () => void, lossy: boolean): void {
    const sim = this.opts.simulate;
    if (!sim) { run(); return; }
    if (lossy && sim.loss && this.random() < sim.loss) return;
    const ms = Math.max(0, sim.latencyMs + (sim.jitterMs ? (this.random() * 2 - 1) * sim.jitterMs : 0));
    if (ms === 0) run(); else setTimeout(run, ms);
  }

  // ---- down ----

  private receive(data: unknown): void {
    if (typeof data === 'string') { this.event(JSON.parse(data) as ServerEvent); return; }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes || frameKind(bytes) !== Frame.Snapshot) return;
    if (this.opts.simulate?.loss && this.random() < this.opts.simulate.loss) return;
    let snap: Snapshot;
    try { snap = decodeSnapshot(bytes); } catch { return; }
    this.snaps.push({ snap, at: performance.now() });
    if (this.snaps.length > SNAPSHOTS) this.snaps.shift();
    if (snap.own) this.reconcile(snap.own.ack, [snap.own.x, snap.own.y, snap.own.z]);
  }

  private event(ev: ServerEvent): void {
    switch (ev.type) {
      case 'welcome': this.id = ev.id; this.role = ev.role; this.team = ev.team; this.queue = ev.queue; break;
      case 'refused': this.state = 'refused'; break;
      case 'queue': this.queue = ev.position; break;
      case 'promoted': this.role = 'player'; this.team = ev.team; this.queue = 0; break;
      case 'pong': this.rtt = performance.now() - ev.t; break;
      case 'spawn':
        if (ev.id === this.id) this.spawned(ev.at, ev.yaw, ev.after);
        break;
      case 'kill':
        if (ev.victim === this.id) { this.alive = false; this.walk.setLocked(true); }
        break;
      case 'kicked': this.walk.setLocked(true); break;
      default: break;
    }
    for (const l of this.listeners) l(ev);
  }

  /** The server stood the mover somewhere: a new mover there, the commands after `after` replayed on it. */
  private spawned(at: readonly [number, number, number], yaw: number, after: number): void {
    const replay = this.history.filter((h) => h.cmd.seq > after).map((h) => h.cmd);
    this.alive = true;
    this.walk.setLocked(false);
    this.walk.respawn(at, yaw, replay);
    // The replayed ticks' predictions are the new mover's now: they are not compared (the next snapshots are). Nor is
    // the one at `after` itself: a snapshot taken in the spawn's tick acks it with the new mover's feet.
    for (const h of this.history) if (h.cmd.seq >= after) h.feet = null;
    this.correction = [0, 0, 0];
    this.correctionTicks = 0;
  }

  /**
   * The server ran up to `ack` and left the mover at `server`; the page predicted `feet` there. The difference is
   * the correction: carried by every later prediction, and applied to the mover now (snapped) or over
   * `SMOOTH_TICKS` (smoothed).
   */
  private reconcile(ack: number, server: [number, number, number]): void {
    const i = this.history.findIndex((h) => h.cmd.seq === ack);
    if (i < 0) return;
    const at = this.history[i]!;
    if (!at.feet) return;
    const e: [number, number, number] = [server[0] - at.feet[0], server[1] - at.feet[1], server[2] - at.feet[2]];
    const size = Math.hypot(e[0], e[1], e[2]);
    // The error is taken out of every prediction from `ack` on (they all stood on the wrong place).
    for (let k = i; k < this.history.length; k++) {
      const f = this.history[k]!.feet;
      if (f) { f[0] += e[0]; f[1] += e[1]; f[2] += e[2]; }
    }
    if (size < CORRECTION_FLOOR) return;
    this.corrections.largest = Math.max(this.corrections.largest, size);
    if (size > SNAP_DISTANCE) {
      this.corrections.snapped++;
      this.walk.nudge(e[0], e[1], e[2]);
      return;
    }
    this.corrections.small++;
    this.correction = [this.correction[0] + e[0], this.correction[1] + e[1], this.correction[2] + e[2]];
    this.correctionTicks = SMOOTH_TICKS;
  }

  private applyCorrection(): void {
    if (this.correctionTicks <= 0) return;
    const f = 1 / this.correctionTicks;
    const step: [number, number, number] = [this.correction[0] * f, this.correction[1] * f, this.correction[2] * f];
    this.walk.nudge(step[0], step[1], step[2]);
    this.correction = [this.correction[0] - step[0], this.correction[1] - step[1], this.correction[2] - step[2]];
    this.correctionTicks--;
  }

  // ---- the clock and the others ----

  /** The server's tick now, as the newest snapshot and the time since it came say. */
  serverTick(now = performance.now()): number {
    const last = this.snaps[this.snaps.length - 1];
    return last ? last.snap.tick + ((now - last.at) / 1000) * TICK_HZ : 0;
  }

  /** The tick the others are drawn at: `INTERP_DELAY_MS` behind the server (what a shot's rewind asks for). */
  viewTick(now = performance.now()): number {
    return Math.max(0, this.serverTick(now) - (INTERP_DELAY_MS / 1000) * TICK_HZ);
  }

  /**
   * Every other body at the view tick: the feet, yaw and pitch between the two snapshots around it; the rest from the
   * newer. A body missing from the newer snapshot is gone; with nothing newer yet, the newest is held.
   */
  bodies(now = performance.now()): BodyState[] {
    const n = this.snaps.length;
    if (!n) return [];
    const t = this.viewTick(now);
    let b = n - 1;
    while (b > 0 && this.snaps[b - 1]!.snap.tick > t) b--;
    const newer = this.snaps[b]!.snap, older = b > 0 ? this.snaps[b - 1]!.snap : null;
    if (!older || newer.tick <= t) return newer.bodies;
    const f = Math.max(0, Math.min(1, (t - older.tick) / (newer.tick - older.tick)));
    const before = new Map(older.bodies.map((x) => [x.id, x]));
    return newer.bodies.map((x) => {
      const o = before.get(x.id);
      if (!o) return x;
      const turn = ((((x.yaw - o.yaw) % 360) + 540) % 360) - 180;
      return {
        ...x,
        feet: [o.feet[0] + (x.feet[0] - o.feet[0]) * f, o.feet[1] + (x.feet[1] - o.feet[1]) * f, o.feet[2] + (x.feet[2] - o.feet[2]) * f],
        yaw: o.yaw + turn * f, pitch: o.pitch + (x.pitch - o.pitch) * f,
      };
    });
  }

  /** DOORS: the doors as the newest snapshot has them (`Snapshot.doors`), or undefined before one or on a map without. */
  doors(): DoorWire[] | undefined {
    return this.snaps[this.snaps.length - 1]?.snap.doors;
  }

  /** The snapshot rate seen over the kept snapshots, a second's worth (the metrics' check on W3.R10). */
  snapshotRate(): number {
    const n = this.snaps.length;
    if (n < 2) return 0;
    const span = (this.snaps[n - 1]!.snap.tick - this.snaps[0]!.snap.tick) / TICK_HZ;
    return span > 0 ? (n - 1) / span : SNAPSHOT_HZ;
  }
}
