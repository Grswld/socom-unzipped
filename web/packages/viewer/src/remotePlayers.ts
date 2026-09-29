import type { Matrix4, Object3D, PerspectiveCamera, Scene } from 'three';
import type { WeaponPoint } from '@s2u/scene';
import type { LoadedBody } from './body';
import { buildBody, type BodyView } from './bodyView';
import type { Lighting } from './lighting';
import type { LoadedMap } from './loadMap';
import { snapshotOf } from './net/body';
import { BODY_FADE_S } from './net/deaths';
import type { TraversalPose } from './animator';
import type { BodyState, Team } from './net/protocol';
import { Play, type PlayClips } from './play';
import type { Mount } from './heldItem';
import type { Firearm } from './kit';

/**
 * The other player's weapons by the replicated weapon (`BodyState.weapon`: 0 the rifle, 1 the Mark 23), where the
 * local kit leaves them once its swap has ended (`./kit`: `FUN_005a60d0(seal, 2, 0)` carries the rifle while the pistol
 * is in the hand; `FUN_005a75d0` holsters the pistol). The swap's clip itself is the mover's and rides the snapshot;
 * the mounts change when the weapon does [placeholder: no hand-off phase on the other screens].
 */
export function remoteKit(weapon: 0 | 1): { item: Firearm; mounts: { rifle: Mount; pistol: Mount } } {
  return weapon === 1 ? { item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' } } : { item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' } };
}

/**
 * The other players, drawn 1:1 (web sprint 3, M5): each is the map's own character -- the first SEAL type for the
 * SEALs, the first Terrorist type for the Terrorists (`LoadedMap.terrorist`, research 91 section 14,
 * DEFAULT_CHARTYPE_PLACEHOLDER) -- in its own gear, with its own `Play` running the game's clips from the replicated
 * mover (`./net/body` `snapshotOf`), the rifle in its hand raised by the replicated aim and trigger. A body the
 * snapshots stop naming is taken away.
 *
 * A death plays the clip the server chose from `damanim.rdr`'s lists (`./net/deaths`, research 91 section 3) and the
 * body goes when the game's fade would have taken it (0.1 a second: 10 s). BODY_FADE_PLACEHOLDER: the body is drawn
 * whole until then and hidden at once -- the skinned material has no opacity yet.
 */

interface Remote {
  id: number; team: Team; view: BodyView; play: Play; weapon: Object3D | null; sidearm: Object3D | null; item: Firearm; snap: ReturnType<typeof snapshotOf> | null;
  deadFor: number; deathClip: string | null;
}

/**
 * A death clip at `seconds` into it, as the animator's one-node play (the traversal seam, `./animator`): its key from
 * its `motion.rdr` playback (the clip's own seconds), held on the last key once played.
 */
export function deathPose(clip: string, seconds: number, clips: PlayClips | null): TraversalPose | null {
  const c = clips?.clips.find((k) => k.name === clip);
  if (!c) return null;
  const entry = clips?.table?.find(([name]) => name === clip)?.[1];
  const playback = entry?.playback ?? c.frameCount / 30;
  const frame = Math.min(c.frameCount - 1, (seconds / playback) * (c.frameCount - 1));
  return { clip, frame, loop: false, rootY: null };
}

export class RemotePlayers {
  private readonly remotes = new Map<number, Remote>();
  private map: LoadedMap | null = null;
  private lighting: Lighting | null = null;
  private clips: PlayClips | null = null;
  private weapon: { object: Object3D; points: readonly WeaponPoint[] } | null = null;
  private sidearm: { object: Object3D; points: readonly WeaponPoint[] } | null = null;
  private readonly teams = new Map<number, Team>();

  constructor(private readonly scene: Scene) {}

  /** A new map (its bodies, textures, weapon and sidearm): every remote is rebuilt from it on its next snapshot. */
  setMap(
    map: LoadedMap | null, lighting: Lighting, weapon: { object: Object3D; points: readonly WeaponPoint[] } | null,
    sidearm: { object: Object3D; points: readonly WeaponPoint[] } | null = null,
  ): void {
    this.clear();
    this.map = map;
    this.lighting = lighting;
    this.weapon = weapon;
    this.sidearm = sidearm;
  }

  setClips(clips: PlayClips | null): void {
    this.clips = clips;
    for (const r of this.remotes.values()) r.play.setClips(clips);
  }

  /** A player's team, from the server's `welcome` / `joined` / `promoted`. */
  setTeam(id: number, team: Team): void {
    this.teams.set(id, team);
    const r = this.remotes.get(id);
    if (r && r.team !== team) this.remove(id);
  }

  forget(id: number): void {
    this.teams.delete(id);
    this.remove(id);
  }

  /** One frame: every body at its interpolated state, in its clip. */
  frame(dt: number, bodies: readonly BodyState[], camera: PerspectiveCamera): void {
    const seen = new Set<number>();
    for (const b of bodies) {
      seen.add(b.id);
      const r = this.remotes.get(b.id) ?? this.add(b.id);
      if (!r) continue;
      r.snap = snapshotOf(b);
      if (r.snap.alive) { r.deadFor = 0; r.deathClip = null; } else r.deadFor += dt;
      const shown = r.snap.alive || r.deadFor < BODY_FADE_S;
      r.view.group.visible = shown;
      if (!shown) continue;
      if (!r.snap.alive && r.deathClip) r.snap.traversal = deathPose(r.deathClip, r.deadFor, this.clips);
      const kit = remoteKit(r.snap.weapon);                     // WEAPON: the replicated rifle or Mark 23 in the hand
      if (kit.item !== r.item) { r.item = kit.item; r.play.setItem(kit.item); }
      r.play.setMounts(kit.mounts);
      r.play.frame(dt, { snapshot: () => r.snap, view: () => 'third' }, camera);
      r.view.group.visible = true;
    }
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this.remove(id);
  }

  /** Where each body's muzzle is (the shots' tracers and flashes start there), or null. */
  muzzle(id: number): [number, number, number] | null {
    return this.remotes.get(id)?.play.muzzle() ?? null;
  }

  /** A kill: the victim's death clip (the server's choice), played from now. */
  died(id: number, clip: string | null): void {
    const r = this.remotes.get(id);
    if (r) { r.deathClip = clip; r.deadFor = 0; } else if (clip) this.pendingDeaths.set(id, clip);
  }
  private readonly pendingDeaths = new Map<number, string>();

  /** A body's weapon node in the world and its `firepoint` (the muzzle animation's frame, research 89 section 4), or null. */
  weaponFrame(id: number): { matrix: Matrix4; muzzle: [number, number, number] | null } | null {
    const r = this.remotes.get(id);
    const pistol = r?.item === 'pistol';
    const object = pistol ? r?.sidearm : r?.weapon, source = pistol ? this.sidearm : this.weapon;
    if (!r || !object || !r.view.group.visible || !source) return null;
    object.updateWorldMatrix(true, false);
    const p = source.points.find((q) => q.name === 'firepoint' || q.name === 'firepont');
    return { matrix: object.matrixWorld.clone(), muzzle: p ? [p.at[0], p.at[1], p.at[2]] : null };
  }

  /** Each body's feet, for the positional sounds. */
  feet(id: number): [number, number, number] | null {
    const s = this.remotes.get(id)?.snap;
    return s ? [s.feet[0], s.feet[1], s.feet[2]] : null;
  }

  count(): number {
    return this.remotes.size;
  }

  private add(id: number): Remote | null {
    const map = this.map, lighting = this.lighting;
    if (!map || !lighting) return null;
    const team = this.teams.get(id) ?? 'seal';
    const loaded: LoadedBody | undefined = (team === 'terrorist' ? (map.terrorist ?? map.body) : map.body) ?? undefined;
    if (!loaded) return null;
    const view = buildBody(loaded, map, lighting);
    this.scene.add(view.group);
    const play = new Play();
    play.setBody(view, loaded);
    play.setFlyToggle(true);
    play.setClips(this.clips);
    const weapon = this.weapon ? this.weapon.object.clone(true) : null;
    if (weapon && this.weapon) play.setWeapon(weapon, this.weapon.points);
    const sidearm = this.sidearm ? this.sidearm.object.clone(true) : null;
    if (sidearm && this.sidearm) play.setSidearm(sidearm, this.sidearm.points);
    const r: Remote = { id, team, view, play, weapon, sidearm, item: 'rifle', snap: null, deadFor: 0, deathClip: this.pendingDeaths.get(id) ?? null };
    this.pendingDeaths.delete(id);
    play.setWeaponInput(() => ({ trigger: r.snap?.trigger ?? false, aiming: r.snap?.aiming ?? false }));
    this.remotes.set(id, r);
    return r;
  }

  private remove(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.view.group);
    r.play.setWeapon(null, []);
    r.play.setSidearm(null, []);
    r.view.dispose();
    this.remotes.delete(id);
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
  }
}
