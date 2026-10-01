import { Room, type Conn, type RoomOptions } from './room';
import type { SpawnSlot } from '@s2u/scene';
import { actionRoots, groundGrid, type GroundData } from '../mover';
import type { MotionClip } from '@s2u/scene';
import type { MotionEntry } from '../motionTable';
import type { DoorSpec } from '../doors';
import { stemOf, type SimClips, type SimMap } from '../simMap';
import { offeredRules, RESPAWN_RULES_ENABLED, TICK_HZ, type ClientEvent } from './protocol';
import type { WebSocketLike } from './client';

/**
 * The page's single-player match (owner, 2026-09-29: "let's make offline tick rounds etc too"). Offline, reCOM mode
 * runs the match server's own `Room` (`@s2u/server` `room.ts`: no socket, no Node in it) inside the page, behind a
 * socket that never leaves it (`LoopbackMatch.socket`), and joins it with the same `NetClient` and `NetPage` a match
 * uses: the round's clock and banner, the round and match screens, the game's damage -- a grenade's blast on the
 * player included -- deaths, respawns and scores come from one implementation, online and off. The room runs
 * `solo` (`RoomOptions.solo`: the player is the host's SEAL, no idle kick, classic's round runs alone to its clock).
 *
 * The room is stepped at the game's 60 Hz by the same drift-corrected clock as the server's (`../../../server/src/server`
 * `loop`): at most five steps a wake, a longer stall dropped rather than replayed. Frames cross on a microtask, in order,
 * as a socket's would.
 */

/** What of a loaded map the room needs (`../loadMap` `LoadedMap`). */
export interface LoadedForMatch {
  path: string;
  name: string;
  ground?: GroundData;
  slots: SpawnSlot[];
  respawns?: SpawnSlot[];
  doors?: DoorSpec[];
}

/**
 * The room's map from the page's: the hull copied -- the room's doors turn its polygons as the server's do, and the
 * page's own hull follows them from the snapshots, as online -- its grid, the slots and their respawn twins.
 */
export function simMapOfLoaded(map: LoadedForMatch): SimMap {
  if (!map.ground) throw new Error('no hull: the map has no ground to play on');
  const g = map.ground;
  const ground: GroundData = {
    grid: { ...g.grid }, owners: g.owners.map((o) => ({ ...o })), points: Float32Array.from(g.points), fields: Uint32Array.from(g.fields),
  };
  // The grid is built off the copy, so the room's movers read the copy the room's doors turn.
  return {
    stem: stemOf(map.path), name: map.name, ground, grid: groundGrid(ground), spawns: null,
    slots: map.slots, respawns: map.respawns ?? [], doors: map.doors ?? [], notes: [],
  };
}

/**
 * The room's clips from the page's (`../play` `PlayClips`, the worker's): the same clips and `motion.rdr` table the
 * server loads (`loadSimClips`), so the room's movers run the page's action root motion. Null without them.
 */
export function simClipsOfPlay(play: { clips: MotionClip[]; table: [string, MotionEntry][] | null } | null): SimClips | null {
  if (!play || !play.clips.length) return null;
  return { clips: play.clips, table: play.table ? new Map(play.table) : null, roots: actionRoots(play.clips) };
}

export interface LoopbackOptions extends Partial<RoomOptions> {
  /** Run the room's clock (the page); false: the caller steps it (`step`, the tests). */
  auto?: boolean;
  /**
   * Whether the respawn rules may be played (`./protocol` `RESPAWN_RULES_ENABLED`, off by the owner's ruling of
   * 2026-09-29): off, the match is classic whatever `rules` asks. The respawn room's tests turn it on.
   */
  respawnRules?: boolean;
}

/** The id the page's player takes in its own room. */
const SOLO_ID = 1;

export class LoopbackMatch {
  readonly room: Room;
  /** Whether the room has the clips (a match made before the worker sent them is made again when they come). */
  readonly clips: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(map: SimMap, clips: SimClips | null, opts: LoopbackOptions = {}) {
    const { auto = true, respawnRules = RESPAWN_RULES_ENABLED, ...room } = opts;
    this.clips = clips !== null;
    this.room = new Room(map, clips, { now: () => performance.now(), ...room, rules: offeredRules(room.rules, respawnRules), solo: true });
    if (auto) this.loop();
  }

  /** `NetOptions.socket`: a socket onto this room. */
  readonly socket = (_url: string): WebSocketLike => new LoopbackSocket(this.room, SOLO_ID);

  /** One 60 Hz step of the room (the tests; the page's clock calls it). */
  step(): void {
    this.room.step();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The server's clock (`MatchServer.loop`), in the page. */
  private loop(): void {
    const period = 1000 / TICK_HZ;
    let next = performance.now();
    const run = (): void => {
      if (this.stopped) return;
      const now = performance.now();
      let steps = 0;
      while (next <= now && steps < 5) { this.room.step(); next += period; steps++; }
      if (next < now - period * 5) next = now;                  // a long stall (a hidden tab) is dropped, not replayed
      this.timer = setTimeout(run, Math.max(0, next - performance.now()));
    };
    this.timer = setTimeout(run, 0);
  }
}

/** The page's end: what `NetClient` sends goes into the room; what the room sends comes back on a microtask. */
class LoopbackSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private joined = false;

  constructor(private readonly room: Room, private readonly id: number) {
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    if (typeof data !== 'string') { this.room.binary(this.id, data); return; }
    const ev = JSON.parse(data) as ClientEvent;
    if (ev.type === 'hello') {
      if (this.joined) return;
      this.joined = true;
      const conn: Conn = {
        send: (frame) => queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: frame }); }),
        close: (code, reason) => this.close(code, reason),
      };
      this.room.hello(this.id, conn, ev);
      return;
    }
    this.room.text(this.id, ev);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.room.leave(this.id);
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}
