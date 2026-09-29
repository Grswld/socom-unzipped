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
import type { WalkMode } from './walk';

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
    postMessage(text: string, scale?: number): void; setTimer(seconds: number): void; setHealth(health: number): void;
    setScoreRows(rows: ScoreRowInfo[] | null, spectators: string[], wins?: { seal: number; terrorist: number }): void;
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

export class NetPage {
  readonly client: NetClient;
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
  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.client.role !== 'spectator' || e.repeat) return;
    if (e.code === 'Space') { this.nextTarget(); e.preventDefault(); }
    else if (e.code === 'KeyV') { this.spectating.follow = !this.spectating.follow; if (!this.spectating.follow) this.deps.spectate(null); }
  };
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: NetPageDeps, url: string, map: string, name: string, simulate?: Simulate) {
    this.client = new NetClient({ url, map, name, ...(simulate ? { simulate } : {}) }, deps.walk);
    this.unsubscribe = this.client.on((ev) => this.event(ev));
    globalThis.addEventListener?.('keydown', this.onKey);
  }

  close(): void {
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

  frame(dt: number, camera: PerspectiveCamera, trigger: boolean): void {
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
    this.deps.hud.postMessage(queueLine(position));
  }

  private event(ev: ServerEvent): void {
    const { remote, hud } = this.deps;
    switch (ev.type) {
      case 'welcome':
        this.names.set(ev.id, ev.name);
        if (ev.role === 'spectator') this.spectatorWelcome(ev.queue);
        for (const p of ev.players) { this.names.set(p.id, p.name); this.teams.set(p.id, p.team); remote.setTeam(p.id, p.team); }
        break;
      case 'joined': this.names.set(ev.id, ev.name); this.teams.set(ev.id, ev.team); remote.setTeam(ev.id, ev.team); break;
      case 'renamed': this.names.set(ev.id, ev.name); break;
      case 'left': remote.forget(ev.id); this.teams.delete(ev.id); break;
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
      case 'roundStart': this.endsAt = performance.now() + ev.seconds * 1000; break;
      case 'roundOver': this.endsAt = null; break;
      case 'score':
        this.rows = ev.rows;
        hud.setScoreRows(ev.rows.map((r) => ({ ...r, self: r.id === this.client.id })), ev.spectators, ev.wins);
        if (ev.timeLeft !== null) this.endsAt = performance.now() + ev.timeLeft * 1000;
        break;
      case 'queue': if (ev.position > 0) hud.postMessage(queueLine(ev.position)); break;
      case 'promoted': this.deps.spectate(null); hud.postMessage('YOU ARE IN: A PLACE IS FREE'); break;
      case 'refused': hud.postMessage(ev.reason); break;
      case 'kicked': hud.postMessage(ev.reason === 'vote' ? 'YOU HAVE BEEN KICKED FROM THIS GAME' : 'Kicked for inactivity.'); break;
      default: break;
    }
  }
}
