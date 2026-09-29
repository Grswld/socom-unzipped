/**
 * Headless bots and a load/soak test for the multiplayer server (web sprint 3, M9).
 *
 *   npx tsx tools/mp-bots.ts [--url ws://127.0.0.1:8787/ws] [--map MP2] [--players 16] [--spectators 8] [--seconds 60]
 *                            [--lag 0] [--loss 0] [--json out.json] [--spawn-server --disc <dir>]
 *
 * Each bot is the page's `NetClient` over a real `ws` socket, with a headless mover driven at 60 Hz as `WalkMode` drives
 * it networked (the `PageWalk` of `packages/server/test/netcode.test.ts`) and a seeded, scripted behaviour: a random walk
 * of the stick and turn, jumps, stance changes, rounds fired at the nearest other body, Action pressed while dead.
 * It measures the server's step time, its tick rate (60 Hz holding), the bytes out per client, the bots' snapshot
 * rates, the corrections, the kills, and (in-process) the process's CPU and RSS. `runBots` is the harness; the CLI
 * runs only when this file is executed directly.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { AssetSource } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';
import {
  BodyFlag, Button, centreClaim, groundPolygons, loadSimClips, loadSimMap, MoverSim, quantiseCommand, TICK_HZ, Traversal, Walker,
  type Command, type ServerEvent, type SimClips, type SimMap, type Role,
} from '../packages/viewer/src/sim';
import { NetClient, type NetWalk, type WebSocketLike } from '../packages/viewer/src/net/client';
import { MatchServer } from '../packages/server/src/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../test-fixtures');

export interface BotOptions {
  /** The server's WebSocket URL; the metrics are fetched from the same host unless `server` is given. */
  url: string;
  map: string;
  players: number;
  spectators: number;
  seconds: number;
  /** One-way latency (ms) and loss (0..1) the net client's injector adds. */
  lag: number;
  loss: number;
  /** The disc (or fixtures) directory the bots load the map and clips from. */
  source: AssetSource;
  /** An in-process server: its `metrics()` is read directly, and the process CPU and RSS are reported. */
  server?: MatchServer;
  seed?: number;
  /** A line of progress per second (the CLI). */
  progress?: (line: string) => void;
}

export interface SecondSample {
  t: number;
  stepMeanMs: number; stepMaxMs: number;
  ticks: number;
  bytesPerClient: number;
  rateMin: number; rateMean: number;
  small: number; snapped: number; largest: number;
  kills: number;
}

export interface BotSummary {
  id: number; name: string; role: Role; queue: number;
  rateMean: number; rateMin: number; corrections: { small: number; snapped: number; largest: number }; kills: number;
}

export interface Report {
  options: { url: string; map: string; players: number; spectators: number; seconds: number; lag: number; loss: number; inProcess: boolean };
  seconds: SecondSample[];
  bots: BotSummary[];
  summary: {
    wallSeconds: number;
    serverTicks: number; ticksPerSecond: number; holds60: boolean;
    stepMeanMs: number; stepMaxMs: number;
    bytesPerClientPerSecond: number;
    playerRate: { min: number; mean: number }; spectatorRate: { min: number; mean: number };
    corrections: { small: number; snapped: number; largest: number };
    kills: number;
    cpuPercent: number | null; rssMb: number | null;
  };
}

// ---- the bots -------------------------------------------------------------------------------------------------------

/** `WalkMode` as the net client drives it (as `netcode.test.ts`'s `PageWalk`), with the server's own `Traversal`. */
class BotWalk implements NetWalk {
  sim: MoverSim | null = null;
  tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null = null;
  locked = true;
  constructor(private readonly map: SimMap, private readonly polys: ReturnType<typeof groundPolygons>, private readonly clips: SimClips | null) {}
  setNetTap(tap: typeof this.tap): void { this.tap = tap; }
  setLocked(on: boolean): void { this.locked = on; }
  respawn(at: readonly [number, number, number], yaw: number, replay: readonly Command[] = []): boolean {
    const w = new Walker(this.map.grid);
    if (this.clips) w.actionRoots = this.clips.roots;
    const moves = new Traversal(this.map.grid, this.polys);
    if (this.clips) moves.setClips(this.clips.clips, this.clips.table);
    this.sim = new MoverSim(w, moves);
    w.place(at[0], at[1] + 15.4, at[2]);
    w.state.yaw = yaw;
    for (const c of replay) this.sim.apply(c);
    return true;
  }
  nudge(dx: number, dy: number, dz: number): void { const s = this.sim!.walker.state; s.x += dx; s.y += dy; s.z += dz; }
  /** One tick of play: locked (dead, not yet placed) the stick is still and only the buttons go (Action respawns). */
  play(input: Omit<Command, 'seq'>): void {
    if (!this.sim || this.locked) { this.tap?.({ ...input, forward: 0, right: 0, buttons: input.buttons & Button.Action }, [0, 0, 0]); return; }
    const cmd = quantiseCommand({ ...input, seq: 0 });
    this.sim.apply(cmd);
    const s = this.sim.walker.state;
    this.tap?.(cmd, [s.x, s.y, s.z]);
  }
}

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function adapt(ws: WebSocket): WebSocketLike {
  ws.binaryType = 'arraybuffer';
  const like: WebSocketLike = {
    binaryType: 'arraybuffer',
    get readyState() { return ws.readyState; },
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    onopen: null, onclose: null, onmessage: null, onerror: null,
  };
  ws.on('open', () => like.onopen?.({}));
  ws.on('close', (code, reason) => like.onclose?.({ code, reason: reason.toString() }));
  ws.on('message', (data, isBinary) => like.onmessage?.({ data: isBinary ? data : data.toString() }));
  ws.on('error', (e) => like.onerror?.(e));
  return like;
}

class Bot {
  readonly walk: BotWalk;
  readonly client: NetClient;
  readonly rate: number[] = [];
  kills = 0;
  private dead = false;
  private readonly rand: () => number;
  private forward = 1; private right = 0; private turn = 0; private yaw: number;
  private changeAt = 0; private jumpAt: number; private stanceAt: number; private fireAt: number;
  private stance = 0; private rounds = 0;

  constructor(readonly index: number, readonly name: string, opts: BotOptions, map: SimMap, polys: ReturnType<typeof groundPolygons>, clips: SimClips | null) {
    this.rand = rng((opts.seed ?? 1) * 7919 + index * 104729);
    this.yaw = this.rand() * 360;
    this.jumpAt = 120 + this.rand() * 360;
    this.stanceAt = 300 + this.rand() * 600;
    this.fireAt = 60 + this.rand() * 60;
    this.walk = new BotWalk(map, polys, clips);
    const simulate = opts.lag > 0 || opts.loss > 0 ? { latencyMs: opts.lag, jitterMs: opts.lag / 5, loss: opts.loss } : undefined;
    this.client = new NetClient({
      url: opts.url, map: opts.map, name, simulate, random: this.rand, socket: (url) => adapt(new WebSocket(url)),
    }, this.walk);
    this.client.on((ev: ServerEvent) => {
      if (ev.type === 'kill') { this.kills++; if (ev.victim === this.client.id) this.dead = true; }
      else if (ev.type === 'spawn' && ev.id === this.client.id) this.dead = false;
    });
  }

  /** One 60 Hz tick of the scripted behaviour. */
  step(t: number): void {
    const r = this.rand;
    if (t >= this.changeAt) {
      this.changeAt = t + 30 + r() * 90;
      this.forward = r() < 0.15 ? 0 : 0.5 + r() * 0.5;
      this.right = r() < 0.6 ? 0 : (r() * 2 - 1) * 0.7;
      this.turn = r() < 0.3 ? 0 : (r() * 2 - 1) * 1.2;             // radians a second, left positive
    }
    this.yaw = (((this.yaw + (this.turn * 180 / Math.PI) / TICK_HZ) % 360) + 360) % 360;
    let buttons = 0;
    let stance = this.stance;
    if (this.dead) buttons |= Button.Action;
    else {
      if (t >= this.jumpAt) { buttons |= Button.Jump; this.jumpAt = t + 120 + r() * 480; }
      if (t >= this.stanceAt) { buttons |= Button.Stance; stance = this.stance === 0 ? (r() < 0.6 ? 1 : 2) : 0; this.stance = stance; this.stanceAt = t + 240 + r() * 900; }
    }
    this.walk.play({ forward: this.forward, right: this.right, yaw: this.yaw, pitch: -5 + r() * 10, turn: this.turn, buttons, stance, weapon: 0 });
    if (this.client.role === 'player' && !this.dead && this.walk.sim && !this.walk.locked && t >= this.fireAt) this.fire(t);
  }

  /**
   * A round down the look, when a living other body is in range: from the eye, along the camera's look at the cone's
   * centre (protocol 5: the server checks the eye and the aim against its own cone, `shotCone.ts`), as far as that body.
   */
  private fire(t: number): void {
    const r = this.rand;
    this.fireAt = t + 20 + r() * 60;
    const sim = this.walk.sim!, s = sim.walker.state;
    const from: [number, number, number] = [s.x, s.y + 15.4, s.z];
    let bestD = 4000;
    for (const b of this.client.bodies()) {
      if (!(b.flags & BodyFlag.Alive)) continue;
      const d = Math.hypot(b.feet[0] - from[0], b.feet[1] + 12 - from[1], b.feet[2] - from[2]);
      if (d < bestD && d > 1) bestD = d;
    }
    if (bestD >= 4000) return;
    const claim = centreClaim({
      feet: [s.x, s.y, s.z], yaw: s.yaw, pitch: s.pitch, posture: sim.walker.posture, moveRoot: sim.moves?.rootY() ?? null,
      peek: sim.moves?.peek() ?? 0,
    }, from, bestD);
    this.client.send({
      type: 'fire', seq: this.client.lastSeq(), from, dir: claim.dir, weapon: 0, viewTick: this.client.viewTick(), eye: claim.eye, aim: claim.aim,
    });
    if (++this.rounds % 20 === 0) this.client.send({ type: 'reload', seq: this.client.lastSeq() });
  }
}

// ---- the harness ----------------------------------------------------------------------------------------------------

interface Metrics { stepMean: number; stepMax: number; ticks: number; bytes: number }

function parseMetrics(text: string): Metrics {
  const get = (name: string): number => {
    const m = new RegExp(`^${name} (\\S+)`, 'm').exec(text);
    return m ? Number(m[1]) : 0;
  };
  return { stepMean: get('s2u_step_ms_mean'), stepMax: get('s2u_step_ms_max'), ticks: get('s2u_ticks_total'), bytes: get('s2u_bytes_out_total') };
}

async function readMetrics(opts: BotOptions): Promise<Metrics> {
  if (opts.server) return parseMetrics(opts.server.metrics());
  const u = new URL(opts.url);
  const res = await fetch(`${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}/metrics`);
  return parseMetrics(await res.text());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runBots(opts: BotOptions): Promise<Report> {
  const map = await loadSimMap(opts.source, `RUN/${opts.map.toUpperCase()}.ZDB`);
  let clips: SimClips | null = null;
  try { clips = await loadSimClips(opts.source); } catch { clips = null; }
  const polys = groundPolygons(map.ground);
  const total = opts.players + opts.spectators;
  const bots: Bot[] = [];
  try {
    // Joined one at a time, each welcomed before the next: the queue's order is the join order.
    for (let i = 0; i < total; i++) {
      const bot = new Bot(i, `${i < opts.players ? 'BOT' : 'SPEC'}${i}`, opts, map, polys, clips);
      bots.push(bot);
      await until(() => bot.client.id !== 0 || bot.client.state === 'refused' || bot.client.state === 'closed', 15_000, `welcome of bot ${i}`);
    }

    const cpu0 = process.cpuUsage();
    const start = performance.now();
    const m0 = await readMetrics(opts);
    let last = m0, lastAt = start;
    const seconds: SecondSample[] = [];
    let killsSeen = 0, tick = 0, nextSample = start + 1000;
    const period = 1000 / TICK_HZ;
    let next = start;
    const end = start + opts.seconds * 1000;
    const sample = async (now: number): Promise<void> => {
      const m = await readMetrics(opts);
      const open = bots.filter((b) => b.client.state === 'open').length || 1;
      const rates = bots.map((b) => b.client.snapshotRate()).filter((x) => x > 0);
      for (const b of bots) { const x = b.client.snapshotRate(); if (x > 0) b.rate.push(x); }
      const c = { small: 0, snapped: 0, largest: 0 };
      for (const b of bots) {
        c.small += b.client.corrections.small; c.snapped += b.client.corrections.snapped;
        c.largest = Math.max(c.largest, b.client.corrections.largest);
      }
      killsSeen = Math.max(0, ...bots.map((b) => b.kills));
      const s: SecondSample = {
        t: seconds.length + 1, stepMeanMs: m.stepMean, stepMaxMs: m.stepMax, ticks: (m.ticks - last.ticks) * (1000 / (now - lastAt)),
        bytesPerClient: ((m.bytes - last.bytes) / open) * (1000 / (now - lastAt)),
        rateMin: rates.length ? Math.min(...rates) : 0, rateMean: mean(rates), ...c, kills: killsSeen,
      };
      seconds.push(s);
      last = m; lastAt = now;
      opts.progress?.(`t=${s.t}s step ${s.stepMeanMs.toFixed(2)}/${s.stepMaxMs.toFixed(2)} ms, ${s.ticks.toFixed(1)} ticks/s, ${(s.bytesPerClient / 1024).toFixed(1)} KiB/s/client, snap ${s.rateMin.toFixed(1)}-${s.rateMean.toFixed(1)} Hz, corr ${s.small}/${s.snapped}, kills ${s.kills}`);
    };

    // The 60 Hz loop: a drift-corrected setTimeout; a stall is caught up (bounded), not skipped.
    await new Promise<void>((done, fail) => {
      const run = (): void => {
        const now = performance.now();
        let steps = 0;
        while (next <= now && steps < 5) { for (const b of bots) b.step(tick); tick++; next += period; steps++; }
        if (next < now - period * 5) next = now;
        if (now >= nextSample) {
          nextSample += 1000;
          sample(now).catch(fail);
        }
        if (now >= end) { done(); return; }
        setTimeout(run, Math.max(0, next - performance.now()));
      };
      run();
    });
    const wall = (performance.now() - start) / 1000;
    const m1 = await readMetrics(opts);
    const cpu = process.cpuUsage(cpu0);

    const summaries: BotSummary[] = bots.map((b) => ({
      id: b.client.id, name: b.name, role: b.client.role, queue: b.client.queue,
      rateMean: mean(b.rate.slice(1)), rateMin: b.rate.length > 1 ? Math.min(...b.rate.slice(1)) : 0,
      corrections: { ...b.client.corrections }, kills: b.kills,
    }));
    const rateOf = (role: Role): { min: number; mean: number } => {
      const xs = summaries.filter((b) => b.role === role && b.rateMean > 0);
      return { min: xs.length ? Math.min(...xs.map((b) => b.rateMin)) : 0, mean: mean(xs.map((b) => b.rateMean)) };
    };
    const corr = { small: 0, snapped: 0, largest: 0 };
    for (const b of summaries) { corr.small += b.corrections.small; corr.snapped += b.corrections.snapped; corr.largest = Math.max(corr.largest, b.corrections.largest); }
    const serverTicks = m1.ticks - m0.ticks;
    const report: Report = {
      options: { url: opts.url, map: opts.map, players: opts.players, spectators: opts.spectators, seconds: opts.seconds, lag: opts.lag, loss: opts.loss, inProcess: !!opts.server },
      seconds, bots: summaries,
      summary: {
        wallSeconds: wall, serverTicks, ticksPerSecond: serverTicks / wall, holds60: serverTicks / wall >= 0.95 * TICK_HZ,
        stepMeanMs: mean(seconds.map((s) => s.stepMeanMs)), stepMaxMs: Math.max(0, ...seconds.map((s) => s.stepMaxMs)),
        bytesPerClientPerSecond: mean(seconds.map((s) => s.bytesPerClient)),
        playerRate: rateOf('player'), spectatorRate: rateOf('spectator'),
        corrections: corr, kills: Math.max(0, ...summaries.map((b) => b.kills)),
        cpuPercent: opts.server ? ((cpu.user + cpu.system) / 1000 / (wall * 1000)) * 100 : null,
        rssMb: opts.server ? process.memoryUsage().rss / (1024 * 1024) : null,
      },
    };
    return report;
  } finally {
    for (const b of bots) b.client.close();
    await sleep(50);
  }
}

export function markdown(r: Report): string {
  const s = r.summary, f = (x: number, d = 2): string => x.toFixed(d);
  const o = r.options;
  const rows: [string, string][] = [
    ['clients', `${o.players} players + ${o.spectators} spectators on ${o.map}, ${o.seconds} s, lag ${o.lag} ms, loss ${o.loss}`],
    ['server ticks / s (60 Hz holding)', `${f(s.ticksPerSecond, 1)} (${s.serverTicks} in ${f(s.wallSeconds, 1)} s): ${s.holds60 ? 'HOLDS' : 'DROPS'}`],
    ['step time mean / worst (ms)', `${f(s.stepMeanMs, 3)} / ${f(s.stepMaxMs, 3)} (budget 16.667)`],
    ['bytes out per client per s', `${f(s.bytesPerClientPerSecond / 1024, 2)} KiB (${f(s.bytesPerClientPerSecond * 8 / 1000, 1)} kbit/s)`],
    ['player snapshot rate min / mean (Hz)', `${f(s.playerRate.min, 1)} / ${f(s.playerRate.mean, 1)}`],
    ['spectator snapshot rate min / mean (Hz)', `${f(s.spectatorRate.min, 1)} / ${f(s.spectatorRate.mean, 1)}`],
    ['corrections small / snapped / largest', `${s.corrections.small} / ${s.corrections.snapped} / ${f(s.corrections.largest, 3)}`],
    ['kills seen', `${s.kills}`],
    ['process CPU (server + bots, % of one core)', s.cpuPercent === null ? 'n/a (remote)' : f(s.cpuPercent, 1)],
    ['process RSS (MB)', s.rssMb === null ? 'n/a (remote)' : f(s.rssMb, 0)],
  ];
  return ['| measure | value |', '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

// ---- the CLI --------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const val = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string, fallback: number): number => { const v = Number(val(name)); return val(name) !== undefined && Number.isFinite(v) ? v : fallback; };

  const disc = val('disc') ?? FIXTURES;
  if (!existsSync(disc)) { console.error(`--disc ${disc}: no such directory`); process.exit(2); }
  const source = new FsAssetSource(disc);
  let server: MatchServer | undefined;
  let url = val('url') ?? 'ws://127.0.0.1:8787/ws';
  if (flag('spawn-server')) {
    server = new MatchServer({ source, port: 0, host: '127.0.0.1', maps: [], room: {}, log: () => undefined });
    const port = await server.start();
    url = `ws://127.0.0.1:${port}/ws`;
    setInterval(() => server!.resetRates(), 1000).unref();
  }
  try {
    const report = await runBots({
      url, map: (val('map') ?? 'MP2').toUpperCase(), players: num('players', 16), spectators: num('spectators', 8), seconds: num('seconds', 60),
      lag: num('lag', 0), loss: num('loss', 0), source, server, seed: num('seed', 1), progress: (l) => console.log(l),
    });
    console.log(`\n${markdown(report)}`);
    const json = val('json');
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await server?.stop();
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
