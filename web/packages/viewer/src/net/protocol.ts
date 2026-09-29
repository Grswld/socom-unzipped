/**
 * The multiplayer wire protocol (web sprint 3, M3/M4; spec W3.R2-R4, rulings W3.R8-R10 in the sprint spec's section 7).
 *
 * One WebSocket per client. Binary frames carry the hot path -- the client's commands up, the server's snapshots down
 * (`./codec`) -- and text frames carry JSON for everything reliable and rare (`ClientEvent` / `ServerEvent`): the join,
 * names, the queue, kills, respawns, the scoreboard, shots for the effects.
 *
 * The model (W3.R8, the command stream): the client's mover ticks at the game's 60 Hz (`CGame::Tick`, research 71
 * section 1.5) and every tick becomes one `Command`, numbered. The server runs each player's commands through that
 * player's own `Walker` in order, as they arrive -- the same code on the same hull, so the server's mover takes the
 * steps the client predicted, bit for bit (`test/simMap.test.ts`), and a correction is needed only when a command
 * was refused or the two sims disagree. Snapshots carry, per recipient, the last command the server ran and the
 * mover's state after it; the client compares with its own history at that number.
 */

/** Bumped on any change to the frames below; a client and server that disagree refuse each other at the hello. */
export const PROTOCOL_VERSION = 1;

/** The game's tick (`CGame::Tick`): the mover's `TICK`, the server's loop. */
export const TICK_HZ = 60;
/** Snapshots a second (W3.R10: every second tick; 30 Hz measured against 20 Hz in the sprint's findings). */
export const SNAPSHOT_HZ = 30;
/** The players a round holds (the owner's ask; the game's own MP limit is 16, research 91). */
export const MAX_PLAYERS = 16;
/** The spectators a room holds in its queue, past which a join is refused (not the game's: the server's guard). */
export const MAX_SPECTATORS = 32;
/** How many of its last commands a client repeats in each batch, for a lost frame on a lossy transport. */
export const COMMAND_REDUNDANCY = 3;
/** The rewind a shot may ask for (W3.R4): the shooter's view time is clamped to this far behind the server. */
export const MAX_REWIND_MS = 200;

/** Binary frame kinds: the first byte of every binary frame. */
export const Frame = {
  /** Client -> server: a batch of commands (`CommandBatch`). */
  Commands: 1,
  /** Server -> client: a snapshot (`Snapshot`). */
  Snapshot: 2,
} as const;
export type Frame = (typeof Frame)[keyof typeof Frame];

/** The buttons a command carries, as bits. Edges (a press) are sent once, on the tick they happened. */
export const Button = {
  /** The jump (pressed this tick). */
  Jump: 1 << 0,
  /** The action button pressed this tick (the ladder's slide, a climb). */
  Action: 1 << 1,
  /** The action button held (the slide from a ladder's head reads it held). */
  ActionHeld: 1 << 2,
  /** The lean held left / right (the peek). */
  LeanLeft: 1 << 3,
  LeanRight: 1 << 4,
  /** A stance change asked this tick: the target in `Command.stance`. */
  Stance: 1 << 5,
  /** The weapon swap asked this tick: to the sidearm when `Command.weapon` is 1, to the rifle when 0. */
  Swap: 1 << 6,
  /** The sprint (the camera's boost; the mover does not read it but the body's run does). */
  Boost: 1 << 7,
  /** The aim held (L1): the body raises the weapon. */
  Aim: 1 << 8,
  /** The trigger held this tick (the body's fire pose; the rounds themselves are `fire` events). */
  Trigger: 1 << 9,
} as const;
export type Button = (typeof Button)[keyof typeof Button];

/** The stance codes on the wire. */
export const STANCE_CODES = ['stand', 'crouch', 'prone'] as const;

/** One 60 Hz tick of a client's input: what `Walker.tick` and its buttons take. */
export interface Command {
  /** The tick's number, from 1, per connection; wraps at 2^32 (never in practice: 2.2 years at 60 Hz). */
  seq: number;
  /** The stick, -1..1 each (quantised to 1/127). */
  forward: number;
  right: number;
  /** The look after the tick's look law, degrees (yaw 0..360 to 1/182; pitch -90..90 to 1/100). */
  yaw: number;
  pitch: number;
  /**
   * The look's turn, radians a second, left positive (`Walker.turn`, `actor+0x48`): past 0.1 of `turn_maxrate` it cuts
   * an interruptible action, so the server must see the turn the client's mover saw (to 1/1000).
   */
  turn: number;
  /** `Button` bits. */
  buttons: number;
  /** The stance asked when `Button.Stance` is set: an index into `STANCE_CODES`. */
  stance: number;
  /** The weapon asked when `Button.Swap` is set: 0 the rifle, 1 the sidearm. Also the weapon in hand otherwise. */
  weapon: number;
}

/** A batch: the newest commands, oldest first; the server skips the ones it has run. */
export interface CommandBatch {
  /** The client's estimate of the server tick it is drawing the others at (lag compensation, W3.R4), in ticks. */
  viewTick: number;
  commands: Command[];
}

/** The mover's state after a command, as the server ran it: what the client reconciles against. */
export interface OwnState {
  /** The last command run. */
  ack: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/**
 * Another player's body, as the animator takes it (`./animator` `MoverSnapshot`, `./mover` `PlaySnapshot`): what
 * the clips play by, quantised (`./codec`). The page interpolates `feet`, `yaw`, `pitch` between two snapshots and
 * takes the rest from the newer.
 */
export interface BodyState {
  id: number;
  feet: [number, number, number];
  yaw: number; pitch: number;
  vx: number; vy: number; vz: number;
  flags: number;
  /** `STANCE_CODES` index: the posture the body uses. */
  stance: number;
  /** `LANDING_CODES` index + 1, 0 none. */
  landing: number;
  /** The jumps taken, mod 256 (the animator sees a take-off by the count). */
  jumps: number;
  /** The ground state: 0 idle, 1 + stance code. */
  ground: number;
  groundForward: number; groundRight: number; groundCls: number;
  /** The action: `ACTION_CODES` index + 1 (0 none), its serial mod 256, its clock and length (s; length -1 none). */
  action: number; actionSerial: number; actionT: number; actionSeconds: number;
  /** The swap overlay: 0 none, else its serial mod 255 + 1; its clock and length. */
  overlay: number; overlayT: number; overlaySeconds: number;
  /** The turn, radians a second, left positive. */
  turnRate: number;
  /** The traversal clip: `TRAVERSAL_CLIPS` index + 1, 0 none; its key, its root (NaN none), its blend. */
  trav: number; travFrame: number; travRootY: number; travBlend: number; travBlendWeight: number;
  /** The peek: -1, 0, 1. */
  peek: number;
  /** The weapon in hand: 0 the rifle, 1 the sidearm. */
  weapon: number;
  /** `PlaySnapshot.stickSnaps`' low bit (the packed byte's spare bit 7): a flip starts the snap's 0.2 s cross-fade. */
  stickSnaps?: number;
}

/** `BodyState.flags`. */
export const BodyFlag = {
  Airborne: 1 << 0,
  Crouched: 1 << 1,
  ActionReversed: 1 << 2,
  OverlayReversed: 1 << 3,
  TravLoop: 1 << 4,
  TravHoldRootTurn: 1 << 5,
  /** Alive: a dead body plays its death and fades (research 91a section 3). */
  Alive: 1 << 6,
  Aiming: 1 << 7,
  Trigger: 1 << 8,
  Boost: 1 << 9,
} as const;
export type BodyFlag = (typeof BodyFlag)[keyof typeof BodyFlag];

export const LANDING_CODES = ['soft', 'hard', 'harder'] as const;
export const ACTION_CODES = [
  'jump', 'launch', 'fall', 'land', 'landHard', 'standToCrouch', 'crouchToProne', 'standToProne',
  'hit', 'hitStomach', 'landDeath', 'getUp', 'swapStand', 'swapCrouch', 'swapProne',
] as const;

/** One snapshot, for one recipient. */
export interface Snapshot {
  /** The server tick it was taken at. */
  tick: number;
  /** The recipient's own mover (absent for a spectator, or a player waiting to respawn). */
  own: OwnState | null;
  /** Every body in the round but the recipient's own. */
  bodies: BodyState[];
}

// ---- the JSON events --------------------------------------------------------------------------------------------

export type Team = 'seal' | 'terrorist';
export type Role = 'player' | 'spectator';

/** Client -> server, text frames. */
export type ClientEvent =
  | { type: 'hello'; version: number; name: string; map: string }
  | { type: 'name'; name: string }
  | { type: 'ping'; t: number }
  /**
   * A round fired (W3.R4): the tick it left on, where from and along what (the client's cone and kick already in),
   * the weapon, and the view tick the shooter saw the others at.
   */
  | { type: 'fire'; seq: number; from: [number, number, number]; dir: [number, number, number]; weapon: number; viewTick: number }
  | { type: 'reload'; seq: number }
  /** A throw (research 85): the grenade's kind, launch point and velocity as the client's `launchGrenade` made them. */
  | { type: 'throw'; seq: number; kind: string; from: [number, number, number]; velocity: [number, number, number] }
  /** The scoreboard asked for (Select/Tab): the server answers with `score`. */
  | { type: 'score' }
  /** W3.R13, research 91 section 17: "VOTE RETAIN:REMOVE" on a teammate, toggled; `remove` false retains. */
  | { type: 'vote'; target: number; remove: boolean };

/** A row of the scoreboard (research 87 section 12, 91). */
export interface ScoreRow { id: number; name: string; team: Team; kills: number; deaths: number; score: number; alive: boolean; ping: number }

/** Server -> client, text frames. */
export type ServerEvent =
  | {
    type: 'welcome'; id: number; version: number; map: string; tick: number; role: Role; team: Team | null;
    queue: number; name: string; players: { id: number; name: string; team: Team }[];
  }
  | { type: 'refused'; reason: string }
  | { type: 'pong'; t: number; tick: number }
  | { type: 'joined'; id: number; name: string; team: Team }
  | { type: 'left'; id: number }
  | { type: 'renamed'; id: number; name: string }
  /** The recipient's place in the spectators' queue (1 = next), or 0 when promoted. */
  | { type: 'queue'; position: number }
  /** The recipient became a player: its team and where it stands. */
  | { type: 'promoted'; team: Team }
  /**
   * A mover placed (a spawn or a respawn): the recipient's own when `id` is its own, the commands after `after` run on
   * the new mover (the client rewinds and replays them).
   */
  | { type: 'spawn'; id: number; at: [number, number, number]; yaw: number; after: number }
  /** A throw by another player (research 85): the page flies the same grenade for its looks, sounds and blast. */
  | { type: 'grenade'; id: number; kind: string; from: [number, number, number]; velocity: [number, number, number] }
  /** A round fired by another player, for its muzzle, tracer and sound (the hit's decal where it struck the world). */
  | { type: 'shot'; id: number; weapon: number; from: [number, number, number]; to: [number, number, number]; normal: [number, number, number] | null; material: number | null }
  /** The recipient was hit: health left per part, and where from (research 91a section 7). */
  | { type: 'hurt'; health: number[]; from: [number, number, number]; part: number }
  /** A kill, for the message window (research 87 section 14, 91): `how` names the game's line. */
  | {
    type: 'kill'; killer: number | null; victim: number; weapon: string | null; how: KillHow;
    /** The death clip the victim plays (`./deaths`), or null (a fall or a blast plays its own). */
    clip: string | null;
  }
  | { type: 'score'; rows: ScoreRow[]; timeLeft: number | null; spectators: string[]; wins: { seal: number; terrorist: number } }
  | { type: 'chat'; text: string }
  /** W3.R13: the votes against the recipient (" Voting: You have %d votes against you.", 0x3f26c0). */
  | { type: 'votes'; count: number }
  /** W3.R13: removed by its team's vote (UIMnLOC 539) or idle; the socket closes after. */
  | { type: 'kicked'; reason: 'vote' | 'idle' }
  /** W3.R11: the clock at 00:00 -- "TIME EXPIRED" (`mp51LOC` 5108) -- and play goes on 15 s (research 91 section 18). */
  | { type: 'timeExpired' }
  /**
   * W3.R11: a round's end, and the match's when `matchOver`; `screens` are the game's screens to show and how long
   * each holds, in order (ROUND COMPLETE between rounds; FINAL ROUND then GAME COMPLETE after a match).
   */
  | {
    type: 'roundOver'; round: number; winner: Team | null; wins: { seal: number; terrorist: number }; matchOver: boolean;
    screens: { screen: 'roundComplete' | 'finalRound' | 'gameComplete'; seconds: number }[];
  }
  /** W3.R11: a round begins (its number, its length in seconds, the match's wins so far). */
  | { type: 'roundStart'; round: number; seconds: number; wins: { seal: number; terrorist: number } };

/** Which of the game's kill lines (research 91b section 3). */
export type KillHow = 'weapon' | 'grenade' | 'suicide' | 'fall' | 'teamkill';

/** The name a guest takes before setting one (W3.R5; research 91b section 6 for the limit and the character set). */
export const GUEST_PREFIX = 'GUEST';
