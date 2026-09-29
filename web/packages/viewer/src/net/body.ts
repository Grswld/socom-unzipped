import { SEAL_ANIMS } from '../locomotion';
import type { LandingKind } from '../physics';
import type { GroundMotion, MoverAction, MoverActionName, PlaySnapshot, Stance } from '../mover';
import { TRAVERSAL_CLIPS } from '../traversal';
import { ACTION_CODES, BodyFlag, LANDING_CODES, STANCE_CODES, type BodyState } from './protocol';

/**
 * A body on the wire and back (web sprint 3, M3/M5): the server takes what `WalkMode.snapshot` gives the page's own
 * animator -- the same `PlaySnapshot`, built from the server's `Walker` and moves -- down to a `BodyState`, and the
 * page turns each `BodyState` back into a `PlaySnapshot` for the other players' animators. Nothing is invented on the
 * way: every field the animator reads is carried, quantised (`./codec`).
 */

/** What a body carries beside its mover: alive, the weapon, the aim and the trigger, the sprint. */
export interface BodyExtras { alive: boolean; weapon: 0 | 1; aiming: boolean; trigger: boolean; boost: boolean }

const stanceCode = (s: Stance): number => Math.max(0, STANCE_CODES.indexOf(s));
const actionCode = (name: MoverActionName): number => ACTION_CODES.indexOf(name) + 1;
const travCode = (clip: string): number => TRAVERSAL_CLIPS.indexOf(clip) + 1;

/** A mover's `PlaySnapshot` (and its extras) as the wire's `BodyState`. */
export function bodyOf(id: number, s: PlaySnapshot, extras: BodyExtras): BodyState {
  let flags = 0;
  if (s.airborne) flags |= BodyFlag.Airborne;
  if (s.crouched) flags |= BodyFlag.Crouched;
  if (s.action?.reversed) flags |= BodyFlag.ActionReversed;
  if (s.overlay?.reversed) flags |= BodyFlag.OverlayReversed;
  if (s.traversal?.loop) flags |= BodyFlag.TravLoop;
  if (s.traversal?.holdRootTurn) flags |= BodyFlag.TravHoldRootTurn;
  if (extras.alive) flags |= BodyFlag.Alive;
  if (extras.aiming) flags |= BodyFlag.Aiming;
  if (extras.trigger) flags |= BodyFlag.Trigger;
  if (extras.boost) flags |= BodyFlag.Boost;
  const t = s.traversal ?? null;
  return {
    id, feet: [s.feet[0], s.feet[1], s.feet[2]], yaw: s.yaw, pitch: s.pitch, vx: s.vx, vy: s.vy, vz: s.vz, flags,
    stance: stanceCode(s.stance),
    landing: s.landing ? LANDING_CODES.indexOf(s.landing) + 1 : 0,
    jumps: s.jumps & 0xff,
    ground: s.ground.state === 'idle' ? 0 : 1 + stanceCode(s.ground.state),
    groundForward: s.ground.forward, groundRight: s.ground.right, groundCls: s.ground.cls,
    action: s.action ? actionCode(s.action.name) : 0, actionSerial: s.action ? s.action.serial & 0xff : 0,
    actionT: s.action?.t ?? 0, actionSeconds: s.action?.seconds ?? -1,
    overlay: s.overlay ? (s.overlay.serial % 255) + 1 : 0, overlayT: s.overlay?.t ?? 0, overlaySeconds: s.overlay?.seconds ?? 0,
    turnRate: s.turnRate,
    trav: t ? travCode(t.clip) : 0, travFrame: t?.frame ?? 0, travRootY: t?.rootY ?? Number.NaN,
    travBlend: t?.blend ? travCode(t.blend.clip) : 0, travBlendWeight: t?.blend?.weight ?? 0,
    peek: s.peek ?? 0, weapon: extras.weapon,
  };
}

/** The wire's `BodyState` back as the `PlaySnapshot` a remote body's animator takes. */
export function snapshotOf(b: BodyState): PlaySnapshot & { alive: boolean; weapon: 0 | 1; aiming: boolean; trigger: boolean; boost: boolean } {
  const stance = STANCE_CODES[b.stance] ?? 'stand';
  const groundState: GroundMotion['state'] = b.ground === 0 ? 'idle' : (STANCE_CODES[b.ground - 1] ?? 'stand');
  const actionName = b.action ? ACTION_CODES[b.action - 1] : undefined;
  const action: MoverAction | null = actionName
    ? { name: actionName, serial: b.actionSerial, t: b.actionT, seconds: b.actionSeconds < 0 ? null : b.actionSeconds, reversed: (b.flags & BodyFlag.ActionReversed) !== 0 }
    : null;
  const travClip = b.trav ? TRAVERSAL_CLIPS[b.trav - 1] : undefined;
  const blendClip = b.travBlend ? TRAVERSAL_CLIPS[b.travBlend - 1] : undefined;
  return {
    feet: [b.feet[0], b.feet[1], b.feet[2]], yaw: b.yaw, pitch: b.pitch, vx: b.vx, vz: b.vz, vy: b.vy,
    airborne: (b.flags & BodyFlag.Airborne) !== 0, crouched: (b.flags & BodyFlag.Crouched) !== 0, stance,
    landing: b.landing ? (LANDING_CODES[b.landing - 1] as LandingKind) : null,
    jumps: b.jumps,
    ground: { state: groundState, forward: b.groundForward, right: b.groundRight, cls: b.groundCls as GroundMotion['cls'] },
    action,
    overlay: b.overlay
      ? { clip: SEAL_ANIMS.swapMoving, serial: b.overlay - 1, t: b.overlayT, seconds: b.overlaySeconds, reversed: (b.flags & BodyFlag.OverlayReversed) !== 0 }
      : null,
    turnRate: b.turnRate,
    traversal: travClip
      ? {
        clip: travClip, frame: b.travFrame, loop: (b.flags & BodyFlag.TravLoop) !== 0,
        rootY: Number.isNaN(b.travRootY) ? null : b.travRootY,
        ...((b.flags & BodyFlag.TravHoldRootTurn) !== 0 ? { holdRootTurn: true } : {}),
        ...(blendClip ? { blend: { clip: blendClip, weight: b.travBlendWeight } } : {}),
      }
      : null,
    peek: (b.peek < 0 ? -1 : b.peek > 0 ? 1 : 0),
    alive: (b.flags & BodyFlag.Alive) !== 0, weapon: (b.weapon ? 1 : 0), aiming: (b.flags & BodyFlag.Aiming) !== 0,
    trigger: (b.flags & BodyFlag.Trigger) !== 0, boost: (b.flags & BodyFlag.Boost) !== 0,
  };
}
