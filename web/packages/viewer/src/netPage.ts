import type { PerspectiveCamera } from 'three';
import type { WeaponRecord } from '@s2u/scene';
import type { FireEvent, FireWeapon } from './fire';
import { NetClient, type Simulate } from './net/client';
import type { ScoreRow, ServerEvent, Team } from './net/protocol';
import { deathPose, type RemotePlayers } from './remotePlayers';
import { overall } from './net/damage';
import { RESPAWN_PROMPT_S } from './net/deaths';
import type { PlayClips } from './play';
import type { ScoreRowInfo } from './scoreboard';
import type { RoundScreen } from './roundScreens';
import type { WalkMode } from './walk';
import type { OnlineStatus } from './online';

/**
 * The page in a match (web sprint 3, M4-M8): the net client on the walk, the other players drawn (`./remotePlayers`),
 * their rounds' muzzles, impacts and sounds, the page's own rounds and reloads sent up, the game's kill lines in the
 * message window (research 91 section 10: "%s fragged %s with %s", "%s commits suicide with %s", "%s falls to their
 * death"), "TIME EXPIRED" and the round's clock (section 18), the scoreboard's rows. Behind `?redotcom&mp` (W3.R7).
 */

export interface NetPageDeps {
  walk: WalkMode;
  remote: RemotePlayers;
  /** The HUD's message window and clock (`./hud`). */
  hud: {
    postMessage(text: string | { text: string; scale: number }[], scale?: number): void; setTimer(seconds: number): void; setHealth(health: number): void;
    setScoreRows(rows: ScoreRowInfo[] | null, spectators: string[], wins?: { seal: number; terrorist: number }): void;
    setRoundScreen(screen: RoundScreen | null): void;
  };
  /** The clips (the death clips among them), once the worker has sent them. */
  clips(): PlayClips | null;
  /** Another player's throw, flown on this page for its looks (`GrenadeThrower.launchRemote`). */
  remoteGrenade(kind: string, from: [number, number, number], velocity: [number, number, number]): void;
  /** The spectator's camera: the pose to stand the fly camera at (follow), or null to leave it free. */
  spectate(pose: { x: number; y: number; z: number; yaw: number; pitch: number } | null): void;
  /** A round's effects and sound at a point (`Effects.onRound`, `GameAudio.onFire`). */
  roundEffects(e: Extract<FireEvent, { type: 'round' }>, muzzleOf: number): void;
  /** The weapon the others carry (KIT_PLACEHOLDER: the held M4A1 SD) and the sidearm. */
  weapons: readonly [WeaponRecord, WeaponRecord];
}

/** `?mp` turns the match on; `?server=wss://host/ws` names the server (the page's own host at `/ws` by default). */
export function netSettings(search: string, location: { protocol: string; host: string }): { url: string; simulate?: Simulate } | null {
  const q = new URLSearchParams(search);
  if (!q.has('mp') && !q.has('server')) return null;
  const url = q.get('server') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const lag = Number(q.get('lag') ?? '0'), loss = Number(q.get('loss') ?? '0');
  return { url, ...(lag > 0 || loss > 0 ? { simulate: { latencyMs: lag, jitterMs: lag / 5, loss: loss / 100 } } : {}) };
}

export function fireWeaponOf(r: WeaponRecord): FireWeapon {
  const s = r.sounds;
  return { name: r.name, id: r.id, fireAnim: r.fireAnim ?? null, sounds: s ? { ...s } : { close: null, med: null, far: null, reload: null } };
}

/** The game's kill line (research 91 section 10), the names already resolved. */
export function killLine(how: Extract<ServerEvent, { type: 'kill' }>['how'], killer: string | null, victim: string, weapon: string | null): string {
  if (how === 'fall') return `${victim} falls to their death`;
  if (how === 'suicide' || killer === null || killer === victim) return `${victim} commits suicide with ${weapon ?? ''}`.trimEnd();
  return `${killer} fragged ${victim} with ${weapon ?? ''}`.trimEnd();
}

/**
 * The queue's line in the message window. QUEUE_TEXT_PLACEHOLDER: the game has no queue (its 17th joiner is refused,
 * research 91 section 7); the words are the viewer's, in the game's message style.
 */
export function queueLine(position: number): string {
  return `SPECTATING: YOU ARE NUMBER ${position} IN LINE`;
}

/**
 * The wait before the next attempt to join, ms: after a match was reached, 1, 2, 4 ... 10 s (M9); to a server never
 * reached, 2, 4, 8 ... 60 s.
 */
export function retryDelayMs(attempts: number, reached: boolean): number {
  return reached ? Math.min(10_000, 1000 * 2 ** attempts) : Math.min(60_000, 2000 * 2 ** attempts);
}

/** The engine reads the round's result this long after the script ends it (`FUN_002a9b30` L150612-150672). */
const ENGINE_READ_S = 3;

export class NetPage {
  client: NetClient;
  private readonly names = new Map<number, string>();
  private readonly teams = new Map<number, Team>();
  /** The round's end, in `performance.now()` ms, or null between rounds. */
  private endsAt: number | null = null;
  rows: ScoreRow[] = [];
  /** The page's own death: when (ms), and whether the respawn prompt has been posted. */
  private dead: { at: number; prompted: boolean } | null = null;
  /**
   * The spectator's view (research 91 section 12: `FUN_00295260`'s modes 0 follow a player, 1 free, 2 the map's scenic
   * views). SPECTATOR_PAD_PLACEHOLDER: the game's buttons for them are not traced; here Space follows the next living
   * player and V switches between following and the free (fly) camera. The scenic views are not drawn.
   */
  private spectating: { follow: boolean; target: number | null } = { follow: true, target: null };
  /**
   * The vote to remove (W3.R13; research 91 section 17): the game's radio menu TEAMMATES > a player > "VOTE
   * RETAIN:REMOVE", toggled. RADIO_MENU_PLACEHOLDER: the radio menu's own look is not drawn; K opens the page's list in
   * the message window, with the game's words, a digit toggles the vote on that teammate, K or Escape closes it.
   */
  private voteMenu = false;
  private readonly myVotes = new Set<number>();
  private teammates(): number[] {
    const mine = this.client.team;
    return [...this.teams].filter(([id, team]) => team === mine && id !== this.client.id).map(([id]) => id).sort((a, b) => a - b);
  }
  private showVoteMenu(): void {
    const lines = this.teammates().map((id, i) => `${i + 1} ${this.nameOf(id)}  VOTE ${this.myVotes.has(id) ? 'REMOVE' : 'RETAIN'}`);
    this.deps.hud.postMessage(['TEAMMATES', ...(lines.length ? lines : ['(none)'])].map((text) => ({ text, scale: 0.8 })));
  }
  private readonly onKey = (e: KeyboardEvent): void => {
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (this.client.role === 'player' && !e.repeat) {
      if (e.code === 'KeyK') { this.voteMenu = !this.voteMenu; if (this.voteMenu) this.showVoteMenu(); return; }
      if (this.voteMenu && e.code === 'Escape') { this.voteMenu = false; return; }
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (this.voteMenu && digit) {
        const id = this.teammates()[Number(digit[1]) - 1];
        if (id === undefined) return;
        const remove = !this.myVotes.has(id);
        if (remove) this.myVotes.add(id); else this.myVotes.delete(id);
        this.client.send({ type: 'vote', target: id, remove });
        this.showVoteMenu();
        e.preventDefault();
        return;
      }
    }
    if (this.client.role !== 'spectator' || e.repeat) return;
    if (e.code === 'Space') { this.nextTarget(); e.preventDefault(); }
    else if (e.code === 'KeyV') { this.spectating.follow = !this.spectating.follow; if (!this.spectating.follow) this.deps.spectate(null); }
  };
  private unsubscribe: () => void;
  /**
   * M9: a dropped socket (a server restart, the network) is joined again after 1, 2, 4 ... 10 s; a kick or a refusal
   * is not. The match gives a rejoiner a new place, as the game's lobby would.
   */
  private reconnect = { attempts: 0, at: 0, stopped: false };
  /** Whether a socket of this page has ever opened: a server never reached is retried more slowly and silently. */
  private reached = false;
  /** The server's reason, when it refused. */
  private refusal: string | null = null;
  /**
   * The round's end on the game's screens (research 91 section 18; `./roundScreens`): after the engine reads the result
   * (3 s), each screen the server named for its seconds, counting down; cleared when the next round starts.
   */
  private screens: { start: number; list: { screen: RoundScreen['kind']; seconds: number }[]; winner: Team | null; wins: { seal: number; terrorist: number } } | null = null;
  private readonly joinedAt = performance.now();

  /**
   * `watch` (the map viewer's Online setting): join as a spectator that never plays -- the walk is not driven, the
   * camera follows the living players (Space the next, V the free camera) as a queued spectator's does.
   */
  constructor(private readonly deps: NetPageDeps, private readonly url: string, private readonly map: string, private name: string, private readonly simulate?: Simulate, private readonly watch = false) {
    this.client = this.open();
    this.unsubscribe = this.client.on((ev) => this.event(ev));
    globalThis.addEventListener?.('keydown', this.onKey);
  }

  private open(): NetClient {
    return new NetClient({ url: this.url, map: this.map, name: this.name, ...(this.simulate ? { simulate: this.simulate } : {}), ...(this.watch ? { watch: true } : {}) }, this.deps.walk);
  }

  /**
   * Joins again after a drop, with the backoff: 1, 2, 4 ... 10 s after a match that was reached (with the HUD's line),
   * and 2, 4, 8 ... 60 s, without a word in the HUD, to a server never reached (the shared one before it is up: a
   * browser logs each refused socket itself, so the attempts are kept few).
   */
  private retry(): void {
    const now = performance.now();
    if (this.client.state === 'open') this.reached = true;
    if (this.reconnect.stopped || this.client.state !== 'closed') return;
    if (this.reconnect.at === 0) {
      this.reconnect.at = now + retryDelayMs(this.reconnect.attempts, this.reached);
      if (this.reached) this.deps.hud.postMessage('CONNECTION LOST. RECONNECTING. . .');
      return;
    }
    if (now < this.reconnect.at) return;
    this.reconnect.attempts++;
    this.reconnect.at = 0;
    this.unsubscribe();
    this.deps.remote.clear();
    this.client = this.open();
    this.unsubscribe = this.client.on((ev) => this.event(ev));
  }

  /** The connection as the panel's Online line shows it (`./online` `onlineLine`). */
  status(): OnlineStatus {
    const c = this.client;
    const base = { players: this.rows.length, retryIn: 0, watching: this.watch };
    if (c.state === 'refused' || (this.reconnect.stopped && c.state === 'closed')) return { ...base, state: 'refused', reason: this.refusal ?? 'closed by the server' };
    if (c.state === 'open' && c.id !== 0) return { ...base, state: 'online' };
    if (c.state === 'closed') {
      const wait = this.reconnect.at > 0 ? (this.reconnect.at - performance.now()) / 1000 : retryDelayMs(this.reconnect.attempts, this.reached) / 1000;
      return { ...base, state: 'retrying', retryIn: Math.max(0, wait) };
    }
    return { ...base, state: 'connecting' };
  }

  close(): void {
    this.reconnect.stopped = true;
    this.deps.hud.setRoundScreen(null);
    this.deps.hud.setScoreRows(null, []);
    globalThis.removeEventListener?.('keydown', this.onKey);
    this.unsubscribe();
    this.client.close();
    this.deps.remote.clear();
  }

  /** The page's own rounds and reloads, to the server (`Fire.subscribe`). */
  fireEvent(e: FireEvent): void {
    if (this.client.state !== 'open') return;
    if (e.type === 'round') {
      const d = [e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      this.client.send({
        type: 'fire', seq: this.client.lastSeq(), from: [...e.from], dir: [d[0]! / l, d[1]! / l, d[2]! / l],
        weapon: e.weapon.id === this.deps.weapons[1].id ? 1 : 0, viewTick: this.client.viewTick(),
      });
    } else if (e.type === 'reloadStart') this.client.send({ type: 'reload', seq: this.client.lastSeq() });
  }

  /** The page's own throw, to the server (`GrenadeThrower.on('throw')`). */
  throwEvent(kind: string, from: readonly number[], velocity: readonly number[]): void {
    if (this.client.state !== 'open') return;
    this.client.send({
      type: 'throw', seq: this.client.lastSeq(), kind,
      from: [from[0]!, from[1]!, from[2]!], velocity: [velocity[0]!, velocity[1]!, velocity[2]!],
    });
  }

  /** Whether one of the game's round screens is up (the page hides its reticle under it). */
  screenUp(): boolean {
    return this.roundScreen() !== null;
  }

  private roundScreen(): RoundScreen | null {
    const sc = this.screens;
    if (!sc) return null;
    let t = (performance.now() - sc.start) / 1000 - ENGINE_READ_S;
    if (t < 0) return null;
    for (const item of sc.list) {
      if (t < item.seconds) {
        const rows: ScoreRowInfo[] = this.rows.map((r) => ({ ...r, self: r.id === this.client.id }));
        const best = [...this.rows].sort((a, b) => b.score - a.score)[0];
        const you = this.rows.find((r) => r.id === this.client.id);
        return {
          kind: item.screen, secondsLeft: item.seconds - t, winner: sc.winner, wins: sc.wins, rows,
          mvp: best?.name ?? null, you: you ? { kills: you.kills, deaths: you.deaths, score: you.score } : null,
          timePlayed: (performance.now() - this.joinedAt) / 1000,
        };
      }
      t -= item.seconds;
    }
    return null;
  }

  frame(dt: number, camera: PerspectiveCamera, trigger: boolean): void {
    this.retry();
    this.deps.hud.setRoundScreen(this.roundScreen());
    this.deps.walk.setTrigger(trigger);
    this.deps.remote.frame(dt, this.client.bodies(), camera);
    if (this.client.role === 'spectator' && this.spectating.follow) this.follow();
    if (this.endsAt !== null) this.deps.hud.setTimer(Math.max(0, (this.endsAt - performance.now()) / 1000));
    // Research 91 section 4.1: "Press the %c button to respawn." from 5 s dead (the press counts once the body faded).
    if (this.dead && !this.dead.prompted && performance.now() - this.dead.at >= RESPAWN_PROMPT_S * 1000) {
      this.dead.prompted = true;
      this.deps.hud.postMessage('Press the X button to respawn.');
    }
  }

  /** The next living player to follow, in id order, wrapping. */
  private nextTarget(): void {
    const alive = this.client.bodies().filter((b) => (b.flags & 64) !== 0).map((b) => b.id).sort((a, b) => a - b);
    if (!alive.length) { this.spectating.target = null; return; }
    const at = this.spectating.target === null ? -1 : alive.indexOf(this.spectating.target);
    this.spectating.target = alive[(at + 1) % alive.length]!;
    this.spectating.follow = true;
  }

  /**
   * The follow camera: behind the followed body and over it at the game's third-person distances at rest
   * (`./playerCamera`: 24.906 behind, 25.709 up at the spawn pitch), looking where it looks.
   */
  private follow(): void {
    let body = this.client.bodies().find((b) => b.id === this.spectating.target && (b.flags & 64) !== 0);
    if (!body) { this.nextTarget(); body = this.client.bodies().find((b) => b.id === this.spectating.target); }
    if (!body) return;
    const y = (body.yaw * Math.PI) / 180;
    const back = 24.906, up = 25.709;
    this.deps.spectate({ x: body.feet[0] + Math.sin(y) * back, y: body.feet[1] + up, z: body.feet[2] + Math.cos(y) * back, yaw: body.yaw, pitch: -9.167 });
  }

  nameOf(id: number): string {
    return this.names.get(id) ?? `Player${id}`;
  }

  private spectatorWelcome(position: number): void {
    this.deps.walk.setMode('fly');
    if (position > 0) this.deps.hud.postMessage(queueLine(position));   // a watcher is not in the line
  }

  private event(ev: ServerEvent): void {
    const { remote, hud } = this.deps;
    switch (ev.type) {
      case 'welcome':
        this.reconnect.attempts = 0;
        this.reached = true;
        this.names.set(ev.id, ev.name);
        if (ev.role === 'spectator') this.spectatorWelcome(ev.queue);
        for (const p of ev.players) { this.names.set(p.id, p.name); this.teams.set(p.id, p.team); remote.setTeam(p.id, p.team); }
        break;
      case 'joined': this.names.set(ev.id, ev.name); this.teams.set(ev.id, ev.team); remote.setTeam(ev.id, ev.team); break;
      case 'renamed': this.names.set(ev.id, ev.name); break;
      case 'left': remote.forget(ev.id); this.teams.delete(ev.id); this.myVotes.delete(ev.id); break;
      case 'kill':
        hud.postMessage(killLine(ev.how, ev.killer === null ? null : this.nameOf(ev.killer), this.nameOf(ev.victim), ev.weapon));
        if (ev.victim === this.client.id) {
          const at = performance.now(), clip = ev.clip;
          this.dead = { at, prompted: false };
          hud.setHealth(0);
          this.deps.walk.setDeathPose(clip ? () => deathPose(clip, (performance.now() - at) / 1000, this.deps.clips()) : null);
        } else remote.died(ev.victim, ev.clip);
        break;
      case 'spawn':
        if (ev.id === this.client.id) { this.dead = null; hud.setHealth(1); this.deps.walk.setDeathPose(null); }
        break;
      case 'hurt': hud.setHealth(overall({ hp: ev.health, armour: [] })); break;
      case 'shot': {
        const w = this.deps.weapons[ev.weapon ? 1 : 0];
        this.deps.roundEffects({
          type: 'round', weapon: fireWeaponOf(w), from: ev.from, to: ev.to, hit: ev.normal !== null, rounds: 0,
          normal: ev.normal, material: ev.material,
        }, ev.id);
        break;
      }
      case 'grenade': this.deps.remoteGrenade(ev.kind, ev.from, ev.velocity); break;
      case 'timeExpired': hud.postMessage('TIME EXPIRED', 0.9); this.endsAt = performance.now(); break;
      case 'roundStart': this.endsAt = performance.now() + ev.seconds * 1000; this.screens = null; break;
      case 'roundOver':
        this.endsAt = null;
        this.screens = { start: performance.now(), list: ev.screens, winner: ev.winner, wins: ev.wins };
        break;
      case 'score':
        this.rows = ev.rows;
        hud.setScoreRows(ev.rows.map((r) => ({ ...r, self: r.id === this.client.id })), ev.spectators, ev.wins);
        if (ev.timeLeft !== null) this.endsAt = performance.now() + ev.timeLeft * 1000;
        break;
      case 'queue': if (ev.position > 0) hud.postMessage(queueLine(ev.position)); break;
      case 'promoted': this.deps.spectate(null); hud.postMessage('YOU ARE IN: A PLACE IS FREE'); break;
      case 'refused': this.reconnect.stopped = true; this.refusal = ev.reason; hud.postMessage(ev.reason); break;
      case 'votes': hud.postMessage(` Voting: You have ${ev.count} votes against you.`); break;
      case 'kicked': this.reconnect.stopped = true; this.refusal = ev.reason === 'vote' ? 'kicked by a vote' : 'kicked for inactivity';
        hud.postMessage(ev.reason === 'vote' ? 'YOU HAVE BEEN KICKED FROM THIS GAME' : 'Kicked for inactivity.'); break;
      default: break;
    }
  }
}
