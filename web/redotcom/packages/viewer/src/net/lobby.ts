import { MAX_PLAYERS, MAX_SPECTATORS, type Role, type Team } from './protocol';

/**
 * The room's roster, headless (web sprint 3, multiplayer): who is a player on which team, who waits in the spectators'
 * queue, and what each is called. Rules from the game's decompilation (research 91) and the sprint's rulings:
 *
 * - Teams (research 91 section 7, `FUN_002bc620` L161359-161395): 8 a team; a joiner goes to the Terrorists if
 *   Terrorists < SEALs, or the SEALs are full, or both are empty; else to the SEALs (ties to the SEALs); refused when the
 *   chosen side is full (`assignTeam`). The game has no in-round auto-balance: each joiner is placed once.
 * - The queue (W3.R11, the owner's 16 players; the queue is the server's guard, not the game's): a join past the
 *   players' room waits in a FIFO of spectators, and a freed player slot promotes the head, placed by the same team rule.
 * - Watchers (the map viewer's Online setting, 2026-09-29): a join asking to watch is a spectator outside the queue --
 *   never promoted, never counted as waiting -- held to the same `maxSpectators` room as the queue, the two together.
 * - Names (research 91 section 13, W3.R12): at most 30 printable ASCII characters; a blank name is the game's
 *   `"Player%d"` with a random four-digit number; a duplicate takes the lowest free `(2)`, `(3)` suffix within the 30.
 *
 * No I/O, no clock: the caller passes `random` where a guest name may be drawn, so a test can seed it.
 */

/** Players a team holds (research 91 section 7: 8 a team). */
export const TEAM_SIZE = 8;
/** The longest name kept (research 91 section 13, W3.R12: the in-game buffer). */
export const NAME_MAX = 30;

/** A client in the room. */
export interface Member {
  id: number;
  name: string;
  role: Role;
  /** The side, for a player; null for a spectator. */
  team: Team | null;
  /** The join order counter (unique, rising): the order of `players()` and of the queue. */
  joinedAt: number;
}

/** What a `join` / `leave` / `rename` did to the roster, in a deterministic order. */
export type LobbyChange =
  | { kind: 'joined'; id: number; role: Role; team: Team | null }
  | { kind: 'left'; id: number }
  | { kind: 'promoted'; id: number; team: Team }
  /** A spectator's 1-based place in the queue changed. */
  | { kind: 'queue'; id: number; position: number }
  | { kind: 'renamed'; id: number; name: string };

/**
 * The game's team rule for a joiner (research 91 section 7, `FUN_002bc620`): Terrorists if Terrorists < SEALs, or the
 * SEALs are full (= `teamSize`), or both teams are empty; else SEALs. Null when the chosen side is full.
 */
export function assignTeam(seal: number, terrorist: number, teamSize: number = TEAM_SIZE): Team | null {
  const terror = terrorist < seal || seal >= teamSize || (seal === 0 && terrorist === 0);
  if (terror) return terrorist >= teamSize ? null : 'terrorist';
  return seal >= teamSize ? null : 'seal';
}

/**
 * W3.R12: printable ASCII only (0x20-0x7e), everything else removed, runs of spaces collapsed, trimmed, cut to
 * `NAME_MAX`. Empty after cleaning gives ''.
 */
export function sanitizeName(raw: string): string {
  let s = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) s += raw[i];
  }
  s = s.replace(/ {2,}/g, ' ').trim();
  // The cut may leave a trailing space: trim again so the name never ends in one.
  return s.slice(0, NAME_MAX).trimEnd();
}

/** W3.R12: the game's `"Player%d"` default with a random four-digit number, `Player1000`..`Player9999`. */
export function guestName(random: () => number = Math.random): string {
  const n = 1000 + Math.floor(random() * 9000);
  return `Player${Math.min(9999, Math.max(1000, n))}`;
}

/**
 * W3.R12: the name itself if no other member has it (`taken` holds the lower-cased names), else the lowest free
 * `name(2)`, `name(3)`... with the base cut so the whole stays within `NAME_MAX`.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = `(${n})`;
    const candidate = name.slice(0, Math.max(0, NAME_MAX - suffix.length)) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The roster: players by join order, spectators in the FIFO queue. */
export class Lobby {
  private readonly maxPlayers: number;
  private readonly maxSpectators: number;
  private readonly teamSize: number;
  private readonly byId = new Map<number, Member>();
  /** Ids of the queued spectators, head first. */
  private queue: number[] = [];
  /** Ids of the watchers (spectators by choice, outside the queue), in join order. */
  private readonly watchers = new Set<number>();
  private counter = 0;

  constructor(opts: { maxPlayers?: number; maxSpectators?: number; teamSize?: number } = {}) {
    this.maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    this.maxSpectators = opts.maxSpectators ?? MAX_SPECTATORS;
    this.teamSize = opts.teamSize ?? TEAM_SIZE;
  }

  /**
   * Adds a client; null when full (players and queue) or when `id` is already in the room. Players first while
   * there is room, else the FIFO queue.
   */
  join(id: number, wantedName: string, random: () => number = Math.random, watch = false, host?: Team): { member: Member; changes: LobbyChange[] } | null {
    if (this.byId.has(id)) return null;
    const counts = this.teamCounts();
    // `host`: the game's host takes its side outright (SEALs, `FUN_002c5450` L166238-166262), not by the joiner's rule.
    const team = watch ? null : counts.seal + counts.terrorist < this.maxPlayers
      ? (host && counts[host] < this.teamSize ? host : assignTeam(counts.seal, counts.terrorist, this.teamSize)) : null;
    if (team === null && this.queue.length + this.watchers.size >= this.maxSpectators) return null;
    const clean = sanitizeName(wantedName);
    const name = uniqueName(clean === '' ? guestName(random) : clean, this.namesExcept(-1));
    const member: Member = { id, name, role: team === null ? 'spectator' : 'player', team, joinedAt: this.counter++ };
    this.byId.set(id, member);
    if (watch) this.watchers.add(id);
    else if (team === null) this.queue.push(id);
    return { member: { ...member }, changes: [{ kind: 'joined', id, role: member.role, team }] };
  }

  /** Removes a client; a freed player slot promotes the queue's head (FIFO), placed by the team rule. */
  leave(id: number): LobbyChange[] {
    const m = this.byId.get(id);
    if (!m) return [];
    this.byId.delete(id);
    const changes: LobbyChange[] = [{ kind: 'left', id }];
    if (this.watchers.delete(id)) return changes;
    if (m.role === 'spectator') {
      const at = this.queue.indexOf(id);
      this.queue.splice(at, 1);
      this.pushQueue(changes, at);
      return changes;
    }
    const headId = this.queue[0];
    if (headId === undefined) return changes;
    const counts = this.teamCounts();
    const team = assignTeam(counts.seal, counts.terrorist, this.teamSize);
    const head = this.byId.get(headId);
    if (team === null || !head) return changes;
    this.queue.shift();
    head.role = 'player';
    head.team = team;
    changes.push({ kind: 'promoted', id: headId, team });
    this.pushQueue(changes, 0);
    return changes;
  }

  /**
   * W3.R13's idle kick with someone waiting: the player goes to the back of the queue and the queue's head takes the
   * slot (by the team rule). Returns the changes, or null when nobody waits (the caller disconnects the idler instead).
   */
  demote(id: number): LobbyChange[] | null {
    const m = this.byId.get(id);
    if (!m || m.role !== 'player' || this.queue.length === 0) return null;
    const changes = this.leave(id);
    const promoted = changes.some((c) => c.kind === 'promoted');
    if (!promoted) {
      // The freed slot could not take the head (a full side): put the player back where it was.
      this.byId.set(id, m);
      return null;
    }
    m.role = 'spectator';
    m.team = null;
    this.byId.set(id, m);
    this.queue.push(id);
    changes.splice(changes.findIndex((c) => c.kind === 'left'), 1);
    changes.push({ kind: 'queue', id, position: this.queue.length });
    return changes;
  }

  /** Renames a member: sanitised, unique against the others; nothing when it is blank or unchanged. */
  rename(id: number, wanted: string, random: () => number = Math.random): LobbyChange[] {
    void random; // a blank name is kept as is (no guest redraw), the argument keeps the shape of `join`
    const m = this.byId.get(id);
    if (!m) return [];
    const clean = sanitizeName(wanted);
    if (clean === '') return [];
    const name = uniqueName(clean, this.namesExcept(id));
    if (name === m.name) return [];
    m.name = name;
    return [{ kind: 'renamed', id, name }];
  }

  /** A member by id (a copy). */
  member(id: number): Member | undefined {
    const m = this.byId.get(id);
    return m ? { ...m } : undefined;
  }

  /** The players, in join order. */
  players(): Member[] {
    return [...this.byId.values()].filter((m) => m.role === 'player').sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({ ...m }));
  }

  /** The spectators: the queue in its order (head first), then the watchers in join order. */
  spectators(): Member[] {
    const out: Member[] = [];
    for (const id of [...this.queue, ...this.watchers]) {
      const m = this.byId.get(id);
      if (m) out.push({ ...m });
    }
    return out;
  }

  /** Whether a member is a watcher (a spectator by choice, never queued). */
  watching(id: number): boolean {
    return this.watchers.has(id);
  }

  /** A spectator's 1-based place in the queue; 0 when not queued (a player, or a watcher). */
  queuePosition(id: number): number {
    return this.queue.indexOf(id) + 1;
  }

  /** Players on each team. */
  teamCounts(): { seal: number; terrorist: number } {
    let seal = 0;
    let terrorist = 0;
    for (const m of this.byId.values()) {
      if (m.team === 'seal') seal++;
      else if (m.team === 'terrorist') terrorist++;
    }
    return { seal, terrorist };
  }

  /** The lower-cased names of every member but `except`. */
  private namesExcept(except: number): Set<string> {
    const s = new Set<string>();
    for (const m of this.byId.values()) if (m.id !== except) s.add(m.name.toLowerCase());
    return s;
  }

  /** A `queue` change for every spectator from index `from` on. */
  private pushQueue(changes: LobbyChange[], from: number): void {
    for (let i = from; i < this.queue.length; i++) {
      const id = this.queue[i];
      if (id !== undefined) changes.push({ kind: 'queue', id, position: i + 1 });
    }
  }
}
