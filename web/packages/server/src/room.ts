import {
  AN_M8, gridCast, HE, HELD_RIFLE, HELD_SIDEARM, launchGrenade, M67, MARK141, segmentHit, stepGrenade, UNITS_PER_METRE,
  type Grenade, type HullCast, type SpawnSlot, type ThrowableRecord, type WeaponRecord,
} from '@s2u/scene';
import {
  applyFall, applyHit, bodyOf, bulletDamage, fragmentCount, fragmentDamage, fragmentPart, decodeCommands, encodeSnapshot, freshHealth, groundPolygons, isDead, Lobby,
  DoorSet, doorInReach, MoverSim, overall, ringFor, roundPath, Traversal, Walker, type MagazineRing,
  Button, MAX_REWIND_MS, PROTOCOL_VERSION, SNAPSHOT_HZ, TICK_HZ,
  ELIMINATED_HOLD_S, eliminationWinner, isMatchOver, MAX_ROUNDS, ROUND_WATCH_S, type Rules,
  type BodyState, type ClientEvent, type Command, type ExtraSurface, type Health, type KillHow, type LobbyChange,
  type PlaySnapshot, type ScoreRow, type ServerEvent, type SimClips, type SimMap, type SimSkeleton, type Team,
} from '../../viewer/src/sim';
import { bodyVolumes, rayBody, stanceVolumes, BODY_REACH, BODY_TOP, type StanceVolumes, type V3 } from '../../viewer/src/net/hitVolumes';
import { deathClip } from '../../viewer/src/net/deaths';

/**
 * One map's match (web sprint 3, M3/M6; rulings W3.R8-R13): the lobby, every player's mover run from its command
 * stream at the game's 60 Hz, the rounds on the original's clock, the game's damage, deaths, respawns, kills and
 * scores, and a snapshot to each client at 30 Hz. It knows nothing of sockets: a `Conn` sends frames, and the server
 * (`./server`) feeds it what arrives, so the tests drive it tick by tick.
 */

export interface Conn { send(frame: Uint8Array | string): void; close(code: number, reason: string): void }

export interface RoomOptions {
  /** Milliseconds now (the idle kick's clock). */
  now: () => number;
  random: () => number;
  /** W3.R13: the idle kick, held to 3-5 minutes. */
  idleKickMs: number;
  /** W3.R11: the round and the match (the create-game defaults: 6 minutes, 11 rounds). */
  roundSeconds: number;
  /**
   * `mp_max_rounds` (the create-game default 11, `../../viewer/src/net/rules` `MAX_ROUNDS`): classic's match, and the
   * round-start banner's count under both rules (a respawn match is one round whatever it says: `isMatchOver`).
   */
  maxRounds: number;
  /** The room's rules: `respawn` (W3.R11) or `classic` (respawn off, the create-game default). */
  rules: Rules;
}

export const DEFAULT_OPTIONS: RoomOptions = {
  // W3.R11: with RESPAWN on the original's match is one round (research 91 section 18), whatever `mp_max_rounds` says.
  now: () => Date.now(), random: Math.random, idleKickMs: 4 * 60_000, roundSeconds: 6 * 60, maxRounds: MAX_ROUNDS, rules: 'respawn',
};

/** W3.R13: the idle kick's bounds (the owner's "3-5 minute kick timer"). */
export const IDLE_KICK_MIN_MS = 3 * 60_000, IDLE_KICK_MAX_MS = 5 * 60_000;

/** Research 91 section 4.1: the respawn press counts from 5 s dead, once the body has faded (1 -> 0 at 0.1/s: 10 s). */
export const RESPAWN_PRESS_S = 5, RESPAWN_FADE_S = 10;
/** Research 91 section 4.2: the respawn record is lifted a unit above its cell (`FUN_002b8100` L158793). */
const SPAWN_LIFT = 1;
/**
 * The end of a round (research 91 section 18, the maps' `mission_timer2` / `success2` and the MPZANIM screens): at
 * 00:00 "TIME EXPIRED" and 15 s more play; the result 1 s after; the engine reads it 3 s later; then ROUND COMPLETE's
 * countdown (5 s) before the next round, or FINAL ROUND (10 s) and GAME COMPLETE (10 s, the host's wait) after a match.
 */
/** VOTE_BAN_SCOPE_PLACEHOLDER (see `Room.banned`). */
export const VOTE_BAN_MS = 10 * 60_000;
export const EXPIRED_PLAY_S = 15, RESULT_S = 1, ENGINE_READ_S = 3, ROUND_COMPLETE_S = 5, FINAL_ROUND_S = 10, GAME_COMPLETE_S = 10;
/**
 * A client's commands are run as its credit allows: a tick's worth each server tick, or the wall time's when the loop
 * stalled and dropped ticks (a GC pause, a busy host), so a stall's backlog is run once the server is back rather than
 * left in the queue for good; never more than a second's worth saved up (the speed guard: no client runs faster than
 * real time, past a one-second burst).
 */
const CREDIT_MAX = 60;
/** Ticks a gap in the command numbers is waited on before the queue goes on without the missing one (100 ms). */
const GAP_WAIT = 6;
/** A command's stick past this, a button, or a turn counts as input for the idle kick. */
const ACTIVE_STICK = 0.05;
/** How far a round may leave from the shooter's eye as the server holds it (the client's muzzle and lean). */
const MUZZLE_SLACK = 40;
/** Ticks of history kept for the rewind: MAX_REWIND_MS and a margin. */
const HISTORY = Math.ceil((MAX_REWIND_MS / 1000) * TICK_HZ) + 12;
/** The eye over the feet, standing (`./walk` `EYE_HEIGHT`), for the fire origin check. */
const EYE = 15.4;

/** KIT_PLACEHOLDER: every player carries the viewer's held pair (the M4A1 SD and the Mark 23) until M5 wires the maps' kits (research 91 section 14). */
const KIT: readonly [WeaponRecord, WeaponRecord] = [HELD_RIFLE, HELD_SIDEARM];

/**
 * The throwables a SEAL carries (research 85; KIT_PLACEHOLDER: the viewer's kit, each at its record's `capacity`) and
 * their rounds' `Piercing` (research 91 section 5, zweapon.rdr: the M67 4, the HE 1; the smoke and the flash do no
 * fragment damage). The claymore is placed, not thrown: CLAYMORE_PLACEHOLDER, not in the match yet.
 */
const THROWN: Readonly<Record<string, { record: ThrowableRecord; piercing: number; fragments: boolean }>> = {
  M67: { record: M67, piercing: 4, fragments: true },
  HE: { record: HE, piercing: 1, fragments: true },
  'AN-M8': { record: AN_M8, piercing: 0, fragments: false },
  Mark141: { record: MARK141, piercing: 0, fragments: false },
};
/** The fastest a throw leaves the hand (`throwVelocity`'s range at the most power, with slack), units a second. */
const THROW_SPEED_MAX = 400;
/** The head over the feet by posture, for the blast's line of sight to the head node (research 91 section 5). */
const HEAD_OVER: Readonly<Record<'stand' | 'crouch' | 'prone', number>> = { stand: 18.3, crouch: 11.1, prone: 1.7 };

interface Flying { owner: number; kind: string; g: Grenade }

interface Past { tick: number; feet: V3; yaw: number; posture: 'stand' | 'crouch' | 'prone'; alive: boolean }

class Player {
  sim: MoverSim;
  readonly queue: Command[] = [];
  /** The tick a gap in the command numbers was first seen, or -1. */
  gapSince = -1;
  credit = CREDIT_MAX;
  lastActive: number;
  alive = false;
  health: Health = freshHealth();
  diedAt = -1;
  kills = 0; deaths = 0; score = 0;
  /** The round's score (the +5 and +1 bonuses and the side's total read it). */
  roundScore = 0;
  readonly history: Past[] = [];
  viewTick = 0;
  ping = 0;
  /**
   * The magazines, per weapon: the game's ring (`magazines.ts`, research 84 §18) -- the page's `Fire` counts with the
   * same, so a reload here takes the magazine the page's did; the tick each last fired (by command number).
   */
  readonly mags: [MagazineRing, MagazineRing] = [ringFor(KIT[0]), ringFor(KIT[1])];
  readonly lastFire: [number, number] = [-1e9, -1e9];
  reloadUntil = 0;
  trigger = false; aiming = false; boost = false;
  lastYaw = 0; lastPitch = 0;
  lastLanding: unknown = null;
  /** The throwables left, by kind (reset at a spawn). */
  grenades: Record<string, number> = freshGrenades();

  constructor(readonly id: number, public team: Team, sim: MoverSim, now: number) {
    this.sim = sim;
    this.lastActive = now;
  }
}

type RoundState =
  /**
   * Classic, before the match: a side has no player. The original launches only with players on both teams ("There must
   * be players on both teams to launch", `FUN_002c3cf0` L165325-165352, UIMnLOC 350/356); a dedicated room has no lobby,
   * so its players walk and respawn as in a respawn room until both sides are seated (CLASSIC_WAITING_PLACEHOLDER).
   */
  | { phase: 'waiting' }
  | { phase: 'play'; startedAt: number; endsAt: number }
  /** "TIME EXPIRED": the world plays on until `resultAt`. */
  | { phase: 'expired'; resultAt: number }
  /** Classic: a side eliminated; the world plays on until `resultAt` (`ELIMINATED_HOLD_S`), the clock still running. */
  | { phase: 'decided'; resultAt: number; winner: Team; endsAt: number }
  | { phase: 'over'; nextAt: number; matchOver: boolean };

export class Room {
  tick = 0;
  readonly lobby = new Lobby();
  private readonly conns = new Map<number, Conn>();
  private readonly players = new Map<number, Player>();
  private readonly opts: RoomOptions;
  round = 1;
  readonly wins = { seal: 0, terrorist: 0 };
  private state: RoundState;
  private readonly polys;
  private creditStep = 1;
  private lastStepAt: number | null = null;
  /** The rows changed (a join, a leave, a rename): one score event goes out at the next tick. */
  private scoreDirty = false;

  /**
   * The hit volumes (research 91 section 1.3): the SEAL skeleton's capsules at each posture's idle, built once here; one
   * skeleton serves both teams (the Terrorist models carry the same bones). Null: the placeholder capsules.
   */
  private readonly volumes: StanceVolumes | null;
  /**
   * DOORS (web/docs/research/92-doors.md): the map's doors, run here -- a client's `door` event asks, the reach is
   * checked, the swing turns the leaf's polygons in the hull every mover reads -- and sent in every snapshot.
   */
  readonly doors: DoorSet;

  constructor(readonly map: SimMap, readonly clips: SimClips | null, opts: Partial<RoomOptions> = {}, body: SimSkeleton | null = null) {
    this.volumes = body ? stanceVolumes(body) : null;
    this.doors = new DoorSet(map.doors ?? [], map.ground);
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.opts.idleKickMs = Math.min(IDLE_KICK_MAX_MS, Math.max(IDLE_KICK_MIN_MS, this.opts.idleKickMs));
    this.polys = groundPolygons(map.ground);
    this.state = this.opts.rules === 'classic' ? { phase: 'waiting' } : { phase: 'play', startedAt: 0, endsAt: this.opts.roundSeconds * TICK_HZ };
  }

  get rules(): Rules { return this.opts.rules; }

  /**
   * Classic: a player seated while a round is in play is a ghost until the next ("You are a ghost.  You will play the
   * next round as a real player.", 0x3e31c0/0x3e31f0, `FUN_001f97b0` L57047-57097; UIMnLOC 352-353: late joiners
   * "appear as a ghost ... wait until the next round"): not alive, not placed, not counted a living player.
   */
  private seatsGhosts(): boolean {
    return this.opts.rules === 'classic' && this.state.phase !== 'waiting';
  }

  // ---- the sessions ----

  /** A client's hello: welcomed as a player or a spectator, or refused. Returns the id it was given, or null. */
  hello(id: number, conn: Conn, ev: Extract<ClientEvent, { type: 'hello' }>, address = ''): boolean {
    if (address && (this.banned.get(address) ?? -Infinity) > this.opts.now()) { this.refuse(conn, 'You have been banned from that game. Please choose another.'); return false; }
    if (ev.version !== PROTOCOL_VERSION) { this.refuse(conn, `protocol ${ev.version}, this server speaks ${PROTOCOL_VERSION}`); return false; }
    const joined = this.lobby.join(id, ev.name, this.opts.random, ev.watch === true);
    if (!joined) { this.refuse(conn, 'The game is full.'); return false; }
    this.conns.set(id, conn);
    if (address) this.addresses.set(id, address);
    const m = joined.member;
    this.send(id, {
      type: 'welcome', id, version: PROTOCOL_VERSION, map: this.map.stem, tick: this.tick, role: m.role, team: m.team,
      queue: this.lobby.queuePosition(id), name: m.name,
      players: this.lobby.players().filter((p) => p.id !== id).map((p) => ({ id: p.id, name: p.name, team: p.team! })),
      rules: this.opts.rules, round: this.round, rounds: this.opts.maxRounds, ghost: m.role === 'player' && this.seatsGhosts(),
    });
    if (m.role === 'player') this.addPlayer(id, m.team!);
    this.broadcastChanges(joined.changes, id);
    this.send(id, this.scoreEvent());                          // the rows and the clock, for the joiner's HUD
    return true;
  }

  private refuse(conn: Conn, reason: string): void {
    conn.send(JSON.stringify({ type: 'refused', reason } satisfies ServerEvent));
    conn.close(4000, reason);
  }

  /** A client gone: its slot to the queue's head. */
  leave(id: number): void {
    if (!this.conns.delete(id)) return;
    this.players.delete(id);
    this.addresses.delete(id);
    // A voter's votes go with it; a target's with it too.
    this.votes.delete(id);
    for (const set of this.votes.values()) set.delete(id);
    this.broadcastChanges(this.lobby.leave(id));
  }

  private addPlayer(id: number, team: Team): void {
    const p = new Player(id, team, this.newSim(), this.opts.now());
    this.players.set(id, p);
    if (this.seatsGhosts()) { this.scoreDirty = true; return; }   // a ghost until the next round
    this.spawn(p, 'start');
  }

  private newSim(): MoverSim {
    const w = new Walker(this.map.grid);
    if (this.clips) w.actionRoots = this.clips.roots;
    const moves = new Traversal(this.map.grid, this.polys);
    if (this.clips) moves.setClips(this.clips.clips, this.clips.table);
    return new MoverSim(w, moves);
  }

  private broadcastChanges(changes: LobbyChange[], except?: number): void {
    if (changes.length) this.scoreDirty = true;
    for (const c of changes) {
      if (c.kind === 'joined') {
        const m = this.lobby.member(c.id)!;
        if (c.role === 'player') this.broadcast({ type: 'joined', id: c.id, name: m.name, team: c.team! }, except);
      } else if (c.kind === 'left') this.broadcast({ type: 'left', id: c.id });
      else if (c.kind === 'renamed') this.broadcast({ type: 'renamed', id: c.id, name: c.name });
      else if (c.kind === 'queue') this.send(c.id, { type: 'queue', position: c.position });
      else if (c.kind === 'promoted') {
        this.players.delete(c.id);
        this.addPlayer(c.id, c.team);
        this.send(c.id, { type: 'promoted', team: c.team });
        this.broadcast({ type: 'joined', id: c.id, name: this.lobby.member(c.id)!.name, team: c.team }, c.id);
      }
    }
    // A demoted player (W3.R13) is a spectator now: its mover goes.
    for (const id of [...this.players.keys()]) if (this.lobby.member(id)?.role !== 'player') { this.players.delete(id); this.broadcast({ type: 'left', id }); }
  }

  // ---- what arrives ----

  /** A binary frame: a command batch. */
  binary(id: number, bytes: Uint8Array): void {
    const p = this.players.get(id);
    if (!p) return;
    let batch;
    try { batch = decodeCommands(bytes); } catch { return; }
    p.viewTick = Math.max(p.viewTick, batch.viewTick);
    // Frames can arrive out of order (the jitter): every command not yet run and not yet queued goes in, in order.
    for (const c of batch.commands) {
      if (c.seq <= p.sim.seq || p.queue.some((q) => q.seq === c.seq)) continue;
      let at = p.queue.length;
      while (at > 0 && p.queue[at - 1]!.seq > c.seq) at--;
      p.queue.splice(at, 0, c);
    }
    if (p.queue.length > 600) p.queue.splice(0, p.queue.length - 600);   // a flood (10 s) is dropped, not queued
  }

  /** A text frame: a JSON event. */
  text(id: number, ev: ClientEvent): void {
    switch (ev.type) {
      case 'ping': this.send(id, { type: 'pong', t: ev.t, tick: this.tick }); return;
      case 'name': this.broadcastChanges(this.lobby.rename(id, ev.name, this.opts.random)); return;
      case 'score': this.send(id, this.scoreEvent()); return;
      case 'fire': this.fire(id, ev); return;
      case 'reload': this.reload(id); return;
      case 'vote': this.vote(id, ev.target, ev.remove); return;
      case 'throw': this.throwGrenade(id, ev); return;
      case 'door': this.useDoor(id, ev.door); return;
      default: return;
    }
  }

  // ---- the tick ----

  /** One 60 Hz step of the match. */
  step(): void {
    this.tick++;
    const now = this.opts.now();
    // The credit this step: a tick, or the wall time since the last step when that is more (a stall's dropped ticks).
    this.creditStep = this.lastStepAt === null ? 1 : Math.max(1, ((now - this.lastStepAt) / 1000) * TICK_HZ);
    this.lastStepAt = now;
    for (const p of this.players.values()) this.run(p, now);
    for (const p of this.players.values()) this.remember(p);
    this.doors.step(1 / TICK_HZ);
    this.flyGrenades();
    this.clock();
    this.idle(now);
    if (this.scoreDirty) { this.scoreDirty = false; this.broadcast(this.scoreEvent()); }
    if (this.tick % Math.round(TICK_HZ / SNAPSHOT_HZ) === 0) this.snapshots();
  }

  /** A player's commands, in order, as far as its credit goes. */
  private run(p: Player, now: number): void {
    p.credit = Math.min(CREDIT_MAX, p.credit + this.creditStep);
    while (p.queue.length && p.credit >= 1) {
      // A gap (a command lost past the redundancy, or still on its way): wait for it a while, then go on without it.
      if (p.queue[0]!.seq > p.sim.seq + 1 && p.gapSince + GAP_WAIT > this.tick) { if (p.gapSince < 0) p.gapSince = this.tick; break; }
      p.gapSince = -1;
      const cmd = p.queue.shift()!;
      p.credit--;
      const active = Math.abs(cmd.forward) > ACTIVE_STICK || Math.abs(cmd.right) > ACTIVE_STICK || (cmd.buttons & ~Button.Boost) !== 0
        || Math.abs(cmd.yaw - p.lastYaw) > 0.5 || Math.abs(cmd.pitch - p.lastPitch) > 0.5;
      if (active) p.lastActive = now;
      p.lastYaw = cmd.yaw; p.lastPitch = cmd.pitch;
      if (!p.alive) {
        p.sim.seq = cmd.seq;
        if ((cmd.buttons & Button.Action) && this.respawnReady(p)) this.spawn(p, 'respawn');
        continue;
      }
      p.trigger = (cmd.buttons & Button.Trigger) !== 0;
      p.aiming = (cmd.buttons & Button.Aim) !== 0;
      p.boost = (cmd.buttons & Button.Boost) !== 0;
      p.sim.apply(cmd);
      const landing = p.sim.walker.landing;
      if (landing && landing !== p.lastLanding) {
        p.lastLanding = landing;
        if (applyFall(p.health, landing.speed)) this.kill(p, null, null, 'fall');
      }
    }
  }

  private remember(p: Player): void {
    const s = p.sim.walker.state;
    p.history.push({ tick: this.tick, feet: [s.x, s.y, s.z], yaw: s.yaw, posture: p.sim.walker.posture, alive: p.alive });
    if (p.history.length > HISTORY) p.history.shift();
  }

  // ---- spawns (research 91 section 4.2) ----

  private sideOf(team: Team): 0 | 1 {
    // Team words 0x40000001 (SEALs) take side 0 while the sides are not swapped (research 91 section 4.2, 7).
    return team === 'seal' ? 0 : 1;
  }

  /**
   * `FUN_002b7ee0`: of the side's respawn records, the one whose nearest living enemy is farthest; with no enemy, one
   * at random. At a round's start the side's slots (key 0/2), at random (a respawn game, L158760-158787).
   * RESPAWN_BLOCK_PLACEHOLDER: the game searches the player slot's block of `count/24` records; the slot's link to the
   * lobby is not traced (research 91 section 4.2), so the whole side's records are searched.
   */
  private pick(p: Player, kind: 'start' | 'respawn'): SpawnSlot | null {
    const side = this.sideOf(p.team);
    const pool = (kind === 'respawn' ? this.map.respawns : this.map.slots).filter((s) => s.side === side);
    const list = pool.length ? pool : this.map.slots.filter((s) => s.side === side);
    if (!list.length) return null;
    if (kind === 'start' && this.opts.rules === 'classic' && this.state.phase !== 'waiting') {
      // A non-respawn game's round start takes the player slot's own record (`+0xfc8`, L158760-158787), not one at
      // random. START_SLOT_LINK_PLACEHOLDER: the player slot's link to the lobby is not traced (research 91 section
      // 4.2), so the player's place among its side's players (by id) stands in for it.
      const k = [...this.players.values()].filter((q) => q.team === p.team).map((q) => q.id).sort((a, b) => a - b).indexOf(p.id);
      const ordered = [...list].sort((a, b) => a.index - b.index);
      return ordered.find((s) => s.index === k) ?? ordered[Math.max(0, k) % ordered.length]!;
    }
    const enemies = [...this.players.values()].filter((q) => q !== p && q.alive && q.team !== p.team);
    if (kind === 'start' || !enemies.length) return list[Math.floor(this.opts.random() * list.length)]!;
    let best = list[0]!, bestD = -1;
    for (const s of list) {
      let near = Infinity;
      for (const e of enemies) {
        const st = e.sim.walker.state;
        near = Math.min(near, (st.x - s.position[0]) ** 2 + (st.y - s.position[1]) ** 2 + (st.z - s.position[2]) ** 2);
      }
      if (near > bestD) { bestD = near; best = s; }
    }
    return best;
  }

  private spawn(p: Player, kind: 'start' | 'respawn'): void {
    const slot = this.pick(p, kind);
    const after = p.sim.seq;
    const sim = this.newSim();
    sim.seq = after;
    const at: V3 = slot ? [slot.position[0], slot.position[1] + SPAWN_LIFT, slot.position[2]] : [0, 0, 0];
    // The facing: step k points along (sin 45k, -cos 45k); `Pose.yaw` faces (-sin yaw, -cos yaw).
    const yaw = slot ? ((-slot.step * 45) % 360 + 360) % 360 : 0;
    sim.walker.place(at[0], at[1] + EYE, at[2]);
    sim.walker.state.yaw = yaw;
    p.sim = sim;
    p.alive = true;
    p.health = freshHealth();
    // A full kit at every spawn, a round's start included: `FUN_00598b90(p, 0)` (the round's reload, `FUN_00223680`
    // L75931) rebuilds the actor through `FUN_00599b60` (L455158), whose `FUN_00599f00` (L455674) gives the type's
    // `default_weapons` at `Ammo_Capacity` x `NumMags` (research 91 section 4.3). KIT_PLACEHOLDER: the kit itself.
    p.mags[0].fill(); p.mags[1].fill();
    p.lastLanding = null;
    p.grenades = freshGrenades();
    p.history.length = 0;
    const s = sim.walker.state;
    this.broadcast({ type: 'spawn', id: p.id, at: [s.x, s.y, s.z], yaw, after });
  }

  private respawnReady(p: Player): boolean {
    // Classic: no respawn -- the respawn option is off (`FUN_002a7560` L149405-149431); the dead spectate until the next
    // round (`FUN_005979a0` L454484-454489). Only the waiting room (CLASSIC_WAITING_PLACEHOLDER) lets one up.
    if (this.opts.rules === 'classic' && this.state.phase !== 'waiting') return false;
    return this.state.phase !== 'over' && p.diedAt >= 0 && (this.tick - p.diedAt) / TICK_HZ >= Math.max(RESPAWN_PRESS_S, RESPAWN_FADE_S);
  }

  // ---- fire (W3.R4) ----

  private fire(id: number, ev: Extract<ClientEvent, { type: 'fire' }>): void {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state.phase === 'over') return;
    const w: 0 | 1 = ev.weapon ? 1 : 0;
    const record = KIT[w];
    // The rate: rounds by command number, at the record's `fireWait` (a tick's slack for the quantised clock).
    if (ev.seq - p.lastFire[w] < record.fireWait * TICK_HZ - 1) return;
    if (p.mags[w].rounds() <= 0 || this.tick < p.reloadUntil) return;
    const s = p.sim.walker.state;
    const from = ev.from, d = ev.dir;
    if (Math.hypot(from[0] - s.x, from[1] - (s.y + EYE), from[2] - s.z) > MUZZLE_SLACK) return;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 0.5 && len < 1.5)) return;
    const dir: V3 = [d[0] / len, d[1] / len, d[2] / len];
    p.lastFire[w] = ev.seq;
    p.mags[w].fire();
    const reach = record.maximumRange * UNITS_PER_METRE;
    // The rewind: the others where the shooter saw them, at most MAX_REWIND_MS back.
    const earliest = this.tick - Math.round((MAX_REWIND_MS / 1000) * TICK_HZ);
    const at = Math.max(earliest, Math.min(this.tick, ev.viewTick));
    const extra: ExtraSurface[] = [];
    for (const q of this.players.values()) {
      if (q === p || !q.alive) continue;
      const past = this.past(q, at);
      if (!past || !past.alive) continue;
      // Skip a body the ray passes nowhere near (the cylinder round its feet).
      if (!nearRay(from, dir, reach, past.feet)) continue;
      const hit = rayBody(from, dir, reach, bodyVolumes(past.feet, past.yaw, past.posture, this.volumes));
      if (!hit) continue;
      const point: V3 = [from[0] + dir[0] * hit.t, from[1] + dir[1] * hit.t, from[2] + dir[2] * hit.t];
      // A body stops the round (PENETRATION 0: flesh is not in the materials' table; research 91 section 1.3).
      extra.push({ distance: hit.t, penetration: 0, point, normal: [-dir[0], -dir[1], -dir[2]], tag: { id: q.id, part: hit.part } });
    }
    const path = roundPath(this.map.grid, [...from], dir, reach, () => 0.5, record.piercing, extra);
    const struck = path.struck.find((s2) => s2.tag !== undefined);
    const end = path.hit ? path.hit.point : path.end;
    this.broadcast({
      type: 'shot', id, weapon: w, from: [...from], to: [...end],
      normal: path.hit && path.hit.tag === undefined ? path.hit.normal : null, material: path.hit?.material ?? null,
    }, id);
    if (!struck) return;
    const { id: victimId, part } = struck.tag as { id: number; part: number };
    const victim = this.players.get(victimId);
    if (!victim || !victim.alive) return;
    if (victim.team === p.team) return;                        // friendly fire off (W3.R11, the create-game default)
    const dmg = bulletDamage(record, struck.distance);
    if (dmg === null) return;
    const died = applyHit(victim.health, part, dmg, record.piercing);
    this.send(victimId, { type: 'hurt', health: [...victim.health.hp], from: [...from], part });
    if (died) this.kill(victim, p, record.name, 'weapon', deathClip('bullet', part, victim.sim.walker.posture, this.opts.random));
    void overall;
  }

  // ---- doors (web/docs/research/92-doors.md) ----

  /**
   * A client's action on the door under its reticle: taken from a living player within the door's reach of its leaf
   * (the client picked it as the game does, `pickDoor`; the server, which does not see the view, checks the reach);
   * `DoorSet.use` refuses it mid-swing, as `FUN_002b44e0` does.
   */
  private useDoor(id: number, door: number): void {
    const p = this.players.get(id);
    if (!p || !p.alive || !Number.isInteger(door) || door < 0 || door >= this.doors.count) return;
    const s = p.sim.walker.state;
    if (!doorInReach(this.doors, door, [s.x, s.y, s.z])) return;
    this.doors.use(door, [s.x, s.y, s.z]);
  }

  // ---- grenades (research 85, 91 section 5) ----

  private readonly flying: Flying[] = [];
  private cast: HullCast | null = null;

  private throwGrenade(id: number, ev: Extract<ClientEvent, { type: 'throw' }>): void {
    const p = this.players.get(id), t = THROWN[ev.kind];
    if (!p || !p.alive || !t || this.state.phase === 'over' || (p.grenades[ev.kind] ?? 0) <= 0) return;
    const s = p.sim.walker.state;
    if (Math.hypot(ev.from[0] - s.x, ev.from[1] - (s.y + EYE), ev.from[2] - s.z) > MUZZLE_SLACK) return;
    if (!(Math.hypot(...ev.velocity) <= THROW_SPEED_MAX)) return;
    p.grenades[ev.kind]!--;
    this.flying.push({ owner: id, kind: ev.kind, g: launchGrenade([...ev.from], [...ev.velocity], t.record) });
    this.broadcast({ type: 'grenade', id, kind: ev.kind, from: [...ev.from], velocity: [...ev.velocity] }, id);
  }

  /** Every grenade in the air one tick on (the page's own `FLIGHT_TICK` is the game's 60 Hz too); a blast's damage. */
  private flyGrenades(): void {
    if (!this.flying.length) return;
    this.cast ??= gridCast(this.map.grid);
    for (const f of this.flying) {
      for (const e of stepGrenade(f.g, 1 / TICK_HZ, this.cast)) if (e.kind === 'explode') this.blast(f, e.point);
    }
    for (let i = this.flying.length - 1; i >= 0; i--) if (this.flying[i]!.g.state === 'removed') this.flying.splice(i, 1);
  }

  /**
   * A blast (`FUN_005a18b0`, `FUN_005a0e70`; research 91 section 5): each living SEAL the blast sees the head of takes
   * `fragmentCount` fragments by its distance and posture, each `fragmentDamage` on a random part at the round's
   * piercing; friendly fire off spares the thrower's team but not the thrower.
   */
  private blast(f: Flying, at: readonly number[]): void {
    const t = THROWN[f.kind];
    if (!t?.fragments) return;
    const thrower = this.players.get(f.owner) ?? null;
    const point: V3 = [at[0]!, at[1]!, at[2]!];
    for (const q of [...this.players.values()]) {
      if (!q.alive) continue;
      if (thrower && q !== thrower && q.team === thrower.team) continue;
      const s = q.sim.walker.state, posture = q.sim.walker.posture;
      const head: V3 = [s.x, s.y + HEAD_OVER[posture], s.z];
      const d = Math.hypot(s.x - point[0], s.y - point[1], s.z - point[2]);
      if (d >= t.record.explosionRadius) continue;
      if (segmentHit(this.map.grid, point, head)) continue;       // no line to the head
      const n = fragmentCount(d, posture, this.opts.random);
      let died = false, part = 3;
      for (let i = 0; i < n && !died; i++) {
        part = fragmentPart(this.opts.random);
        died = applyHit(q.health, part, fragmentDamage(t.record.explosionDamage, t.record.explosionRadius, d), t.piercing);
      }
      if (n > 0) this.send(q.id, { type: 'hurt', health: [...q.health.hp], from: point, part });
      if (died) this.kill(q, thrower, t.record.name, q === thrower ? 'suicide' : 'weapon', null);
    }
  }

  private reload(id: number): void {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    const w = p.sim.weapon;
    // FUN_005c2a90: the next magazine round the ring with rounds; the one out keeps its rounds (the page's rule).
    if (p.mags[w].full() || !p.mags[w].reload()) return;
    p.reloadUntil = this.tick + 2 * TICK_HZ;                   // `fire.ts` RELOAD_SECONDS
  }

  private past(q: Player, tick: number): Past | null {
    const h = q.history;
    if (!h.length) return null;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i]!.tick <= tick) {
        const a = h[i]!, b = h[i + 1];
        if (!b) return a;
        const t = (tick - a.tick) / (b.tick - a.tick);
        return { ...a, feet: [a.feet[0] + (b.feet[0] - a.feet[0]) * t, a.feet[1] + (b.feet[1] - a.feet[1]) * t, a.feet[2] + (b.feet[2] - a.feet[2]) * t] };
      }
    }
    return h[0]!;
  }

  // ---- deaths and score (research 91 sections 3, 8) ----

  private kill(victim: Player, killer: Player | null, weapon: string | null, how: KillHow, clip: string | null = null): void {
    victim.alive = false;
    victim.diedAt = this.tick;
    victim.deaths++;
    let line: KillHow = how;
    if (!killer || killer === victim) {
      victim.score -= 2; victim.roundScore -= 2;                  // suicide or fall: -2
    } else if (killer.team === victim.team) {
      killer.score -= 2; killer.roundScore -= 2; line = 'teamkill';
    } else {
      killer.kills++; killer.score += 2; killer.roundScore += 2;
    }
    this.broadcast({ type: 'kill', killer: killer?.id ?? null, victim: victim.id, weapon, how: line, clip });
    this.broadcast(this.scoreEvent());                         // the rows change: the scoreboard follows (research 91 §11)
  }

  // ---- the clock (W3.R11; classic: the maps' `objectives` script, research 91 section 18) ----

  private clock(): void {
    const st = this.state;
    const classic = this.opts.rules === 'classic';
    if (st.phase === 'waiting') {
      if (this.sidesSeated()) this.startRound(true);
    } else if (st.phase === 'play') {
      if (!classic) {
        if (this.tick < st.endsAt) return;
        this.state = { phase: 'expired', resultAt: this.tick + (EXPIRED_PLAY_S + RESULT_S) * TICK_HZ };
        this.broadcast({ type: 'timeExpired' });
        return;
      }
      // `start` (WAIT 5, WAIT 10) and `mission_timer` (WAIT 15) watch nothing in the round's first 15 s.
      if (this.tick < st.startedAt + ROUND_WATCH_S * TICK_HZ) return;
      const winner = eliminationWinner(this.living());
      if (winner) {
        // `mp_score00` / `mp_score08` += 1 and `mp_winner` at once, `mission_timer` stopped, the two lines posted.
        this.wins[winner]++;
        this.state = { phase: 'decided', resultAt: this.tick + ELIMINATED_HOLD_S * TICK_HZ, winner, endsAt: st.endsAt };
        this.broadcast({ type: 'eliminated', winner });
        return;
      }
      // `mission_timer` at 00:00 calls `abort`: `round_count` += 1, `mp_winner` = 99 -- a draw, no message, no hold.
      if (this.tick >= st.endsAt) this.endRound(null);
    } else if (st.phase === 'expired') {
      if (this.tick >= st.resultAt) this.endRound();
    } else if (st.phase === 'decided') {
      if (this.tick >= st.resultAt) this.endRound(st.winner);
    } else if (this.tick >= st.nextAt) {
      if (classic && !this.sidesSeated()) {
        // A side emptied: the original abandons the game (`FUN_002bc530` L161130-161140, `dlgNetAbandoned`); the room
        // waits for both sides again (CLASSIC_WAITING_PLACEHOLDER).
        this.resetMatch();
        this.state = { phase: 'waiting' };
        for (const p of this.players.values()) { p.diedAt = -1; this.spawn(p, 'start'); }
        this.broadcast(this.scoreEvent());
        return;
      }
      this.startRound(st.matchOver);
    }
  }

  /** Both sides have a player (dead or alive, ghosts included). */
  private sidesSeated(): boolean {
    let seal = 0, terrorist = 0;
    for (const p of this.players.values()) { if (p.team === 'seal') seal++; else terrorist++; }
    return seal > 0 && terrorist > 0;
  }

  /** `aiteam_00` / `aiteam_08`: each side's living players. */
  private living(): { seal: number; terrorist: number } {
    const n = { seal: 0, terrorist: 0 };
    for (const p of this.players.values()) if (p.alive) n[p.team]++;
    return n;
  }

  private resetMatch(): void {
    this.round = 0; this.wins.seal = 0; this.wins.terrorist = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.score = 0; }
  }

  /** A round begins: the next, or a new match's first; everyone (the ghosts too) at a round-start slot with a full kit. */
  private startRound(newMatch: boolean): void {
    if (newMatch) this.resetMatch();
    this.round++;
    this.state = { phase: 'play', startedAt: this.tick, endsAt: this.tick + this.opts.roundSeconds * TICK_HZ };
    for (const p of this.players.values()) { p.roundScore = 0; p.diedAt = -1; this.spawn(p, 'start'); }
    this.broadcast({ type: 'roundStart', round: this.round, seconds: this.opts.roundSeconds, wins: { ...this.wins }, rounds: this.opts.maxRounds });
    this.broadcast(this.scoreEvent());
  }

  /**
   * A round's result. Respawn (`decided` absent): the side with more round points wins, level is a draw (`success2`).
   * Classic: the elimination's winner (its round win already counted), or null for the clock's draw. Then the bonuses
   * of the MP exit state, the same under both rules (`FUN_00223970` L76146-76165 tests no respawn flag): +5 to each
   * player of `mp_winner`'s side (none on a draw), +1 to each living player.
   */
  private endRound(decided?: Team | null): void {
    const side = { seal: 0, terrorist: 0 };
    for (const p of this.players.values()) {
      if (p.alive) { p.score += 1; p.roundScore += 1; }         // +1 alive at the round's end
      side[p.team] += p.roundScore;
    }
    let winner: Team | null;
    if (decided === undefined) {
      winner = side.seal > side.terrorist ? 'seal' : side.terrorist > side.seal ? 'terrorist' : null;
      if (winner) this.wins[winner]++;
    } else winner = decided;
    if (winner) for (const p of this.players.values()) if (p.team === winner) p.score += 5;   // +5 each on the winning side
    const matchOver = isMatchOver(this.opts.rules, this.round, this.opts.maxRounds, this.wins);
    const screens = matchOver
      ? [{ screen: 'finalRound' as const, seconds: FINAL_ROUND_S }, { screen: 'gameComplete' as const, seconds: GAME_COMPLETE_S }]
      : [{ screen: 'roundComplete' as const, seconds: ROUND_COMPLETE_S }];
    const hold = ENGINE_READ_S + screens.reduce((a, b) => a + b.seconds, 0);
    this.state = { phase: 'over', nextAt: this.tick + hold * TICK_HZ, matchOver };
    this.broadcast({ type: 'roundOver', round: this.round, winner, wins: { ...this.wins }, matchOver, screens });
    this.broadcast(this.scoreEvent());
    this.applyVotes(matchOver);
  }

  // ---- the vote to remove (W3.R13, research 91 section 17) ----

  /** Voter -> the teammates it votes to remove. */
  private readonly votes = new Map<number, Set<number>>();
  /**
   * Addresses refused a rejoin, until when (ms). The original refuses a rejoin to "that game" (research 91 section 17);
   * a dedicated room is never over, so VOTE_BAN_SCOPE_PLACEHOLDER: 10 minutes, two of the original's matches.
   */
  private readonly banned = new Map<string, number>();
  private readonly addresses = new Map<number, string>();

  private vote(id: number, target: number, remove: boolean): void {
    const p = this.players.get(id), t = this.players.get(target);
    if (!p || !t || p === t || p.team !== t.team || !p.alive) return;   // a living player, on a teammate (`FUN_0022f3c0`)
    const mine = this.votes.get(id) ?? new Set<number>();
    if (remove) mine.add(target); else mine.delete(target);
    this.votes.set(id, mine);
    this.send(target, { type: 'votes', count: this.votesAgainst(target) });
  }

  private votesAgainst(target: number): number {
    const t = this.players.get(target);
    if (!t) return 0;
    let n = 0;
    for (const [voter, set] of this.votes) if (set.has(target) && this.players.get(voter)?.team === t.team) n++;
    return n;
  }

  /** `FUN_002c3550` L164913: passed when the votes exceed half the target's team, the target counted. */
  private votePasses(target: number): boolean {
    const t = this.players.get(target);
    if (!t) return false;
    const team = [...this.players.values()].filter((q) => q.team === t.team).length;
    return this.votesAgainst(target) > team / 2;
  }

  /** At a round's end the passed votes remove their targets (research 91 section 17, inferred from SOCOM 1's script). */
  private applyVotes(matchOver: boolean): void {
    const out = [...this.players.keys()].filter((id) => this.votePasses(id));
    for (const id of out) {
      const address = this.addresses.get(id);
      if (address) this.banned.set(address, this.opts.now() + VOTE_BAN_MS);
      this.send(id, { type: 'kicked', reason: 'vote' });
      const conn = this.conns.get(id);
      this.leave(id);
      conn?.close(4002, 'YOU HAVE BEEN KICKED FROM THIS GAME');
    }
    void matchOver;
  }

  /** Seconds left in the round, or null between rounds (and in a classic room waiting for its match). */
  timeLeft(): number | null {
    const st = this.state;
    return st.phase === 'play' || st.phase === 'decided' ? Math.max(0, (st.endsAt - this.tick) / TICK_HZ) : null;
  }

  scoreEvent(): ServerEvent {
    const rows: ScoreRow[] = [...this.players.values()].map((p) => ({
      id: p.id, name: this.lobby.member(p.id)?.name ?? '', team: p.team, kills: p.kills, deaths: p.deaths, score: p.score,
      alive: p.alive, ping: p.ping,
    }));
    return {
      type: 'score', rows, timeLeft: this.timeLeft(), spectators: this.lobby.spectators().map((m) => m.name), wins: { ...this.wins },
    };
  }

  // ---- the idle kick (W3.R13) ----

  private idle(now: number): void {
    for (const p of [...this.players.values()]) {
      // Classic: the dead and the ghosts can only watch until the next round, so their idle clock waits.
      if (!p.alive && this.seatsGhosts()) { p.lastActive = now; continue; }
      if (now - p.lastActive < this.opts.idleKickMs) continue;
      const changes = this.lobby.demote(p.id);
      if (changes) { this.players.delete(p.id); this.broadcastChanges(changes); continue; }
      this.send(p.id, { type: 'kicked', reason: 'idle' });
      const conn = this.conns.get(p.id);
      this.leave(p.id);
      conn?.close(4001, 'Kicked for inactivity.');
    }
  }

  // ---- out ----

  private snapshots(): void {
    const bodies = new Map<number, BodyState>();
    for (const p of this.players.values()) bodies.set(p.id, this.body(p));
    const list = [...bodies.values()];
    const doors = this.doors.count ? this.doors.wire() : undefined;
    for (const [id, conn] of this.conns) {
      const p = this.players.get(id);
      const own = p && p.alive ? (() => {
        const s = p.sim.walker.state;
        return { ack: p.sim.seq, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz };
      })() : null;
      conn.send(encodeSnapshot({ tick: this.tick, own, bodies: p ? list.filter((b) => b.id !== id) : list, doors }));
    }
  }

  private body(p: Player): BodyState {
    const s: PlaySnapshot = p.sim.body();
    return bodyOf(p.id, s, { alive: p.alive, weapon: p.sim.weapon, aiming: p.aiming, trigger: p.trigger, boost: p.boost });
  }

  private send(id: number, ev: ServerEvent): void {
    this.conns.get(id)?.send(JSON.stringify(ev));
  }

  private broadcast(ev: ServerEvent, except?: number): void {
    const text = JSON.stringify(ev);
    for (const [id, conn] of this.conns) if (id !== except) conn.send(text);
  }

  /** For `/metrics`. */
  stats(): { players: number; spectators: number; tick: number; round: number; rules: Rules } {
    return { players: this.players.size, spectators: this.lobby.spectators().length, tick: this.tick, round: this.round, rules: this.opts.rules };
  }

  /** For the tests: a player's mover and state. */
  player(id: number): {
    sim: MoverSim; alive: boolean; health: Health; team: Team; score: number; kills: number; deaths: number;
    readonly mags: readonly [MagazineRing, MagazineRing];
  } | undefined {
    return this.players.get(id);
  }
}

function freshGrenades(): Record<string, number> {
  return Object.fromEntries(Object.entries(THROWN).map(([k, t]) => [k, t.record.capacity]));
}

/** Whether a ray passes within `BODY_REACH` of the vertical line over `feet` (a cheap cull before the capsules). */
function nearRay(o: readonly number[], d: V3, reach: number, feet: V3): boolean {
  const mid: V3 = [feet[0], feet[1] + BODY_TOP / 2, feet[2]];
  const t = Math.max(0, Math.min(reach, (mid[0] - o[0]!) * d[0] + (mid[1] - o[1]!) * d[1] + (mid[2] - o[2]!) * d[2]));
  const px = o[0]! + d[0] * t - mid[0], py = o[1]! + d[1] * t - mid[1], pz = o[2]! + d[2] * t - mid[2];
  return px * px + pz * pz <= BODY_REACH * BODY_REACH && Math.abs(py) <= BODY_TOP;
}

/** A dead body's `isDead` for the tests. */
export { isDead };
