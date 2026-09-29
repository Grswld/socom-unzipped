import type { Matrix4, Object3D, PerspectiveCamera, Scene } from 'three';
import type { WeaponPoint } from '@s2u/scene';
import type { LoadedBody } from './body';
import { buildBody, type BodyView } from './bodyView';
import type { Lighting } from './lighting';
import type { LoadedMap } from './loadMap';
import { snapshotOf } from './net/body';
import type { BodyState, Team } from './net/protocol';
import { Play, type PlayClips } from './play';

/**
 * The other players, drawn 1:1 (web sprint 3, M5): each is the map's own character -- the first SEAL type for the
 * SEALs, the first Terrorist type for the Terrorists (`LoadedMap.terrorist`, research 91 section 14,
 * DEFAULT_CHARTYPE_PLACEHOLDER) -- in its own gear, with its own `Play` running the game's clips from the replicated
 * mover (`./net/body` `snapshotOf`), the rifle in its hand raised by the replicated aim and trigger. A body the
 * snapshots stop naming is taken away.
 *
 * DEATH_CLIP_PLACEHOLDER: the game plays a death clip from `damanim.rdr` by the part and the stance and fades the body
 * at 0.1 a second (research 91 section 3); until those clips are wired, a dead body holds its last pose for the fade's
 * first second and is hidden.
 */

interface Remote { id: number; team: Team; view: BodyView; play: Play; weapon: Object3D | null; snap: ReturnType<typeof snapshotOf> | null; deadFor: number }

const DEATH_HOLD_S_PLACEHOLDER = 1;

export class RemotePlayers {
  private readonly remotes = new Map<number, Remote>();
  private map: LoadedMap | null = null;
  private lighting: Lighting | null = null;
  private clips: PlayClips | null = null;
  private weapon: { object: Object3D; points: readonly WeaponPoint[] } | null = null;
  private readonly teams = new Map<number, Team>();

  constructor(private readonly scene: Scene) {}

  /** A new map (its bodies, textures and weapon): every remote is rebuilt from it on its next snapshot. */
  setMap(map: LoadedMap | null, lighting: Lighting, weapon: { object: Object3D; points: readonly WeaponPoint[] } | null): void {
    this.clear();
    this.map = map;
    this.lighting = lighting;
    this.weapon = weapon;
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
      if (r.snap.alive) r.deadFor = 0; else r.deadFor += dt;
      const shown = r.snap.alive || r.deadFor < DEATH_HOLD_S_PLACEHOLDER;
      r.view.group.visible = shown;
      if (!shown) continue;
      r.play.frame(r.snap.alive ? dt : 0, { snapshot: () => r.snap, view: () => 'third' }, camera);
      r.view.group.visible = true;
    }
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this.remove(id);
  }

  /** Where each body's muzzle is (the shots' tracers and flashes start there), or null. */
  muzzle(id: number): [number, number, number] | null {
    return this.remotes.get(id)?.play.muzzle() ?? null;
  }

  /** A body's weapon node in the world and its `firepoint` (the muzzle animation's frame, research 89 section 4), or null. */
  weaponFrame(id: number): { matrix: Matrix4; muzzle: [number, number, number] | null } | null {
    const r = this.remotes.get(id);
    if (!r?.weapon || !r.view.group.visible || !this.weapon) return null;
    r.weapon.updateWorldMatrix(true, false);
    const p = this.weapon.points.find((q) => q.name === 'firepoint' || q.name === 'firepont');
    return { matrix: r.weapon.matrixWorld.clone(), muzzle: p ? [p.at[0], p.at[1], p.at[2]] : null };
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
    const r: Remote = { id, team, view, play, weapon, snap: null, deadFor: 0 };
    play.setWeaponInput(() => ({ trigger: r.snap?.trigger ?? false, aiming: r.snap?.aiming ?? false }));
    this.remotes.set(id, r);
    return r;
  }

  private remove(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.view.group);
    r.play.setWeapon(null, []);
    r.view.dispose();
    this.remotes.delete(id);
  }

  clear(): void {
    for (const id of [...this.remotes.keys()]) this.remove(id);
  }
}
