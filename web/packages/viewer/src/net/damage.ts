/**
 * The game's damage, headless (web sprint 3, M6; web research 91 sections 1-5): what the multiplayer server applies to
 * a SEAL when a round, a fragment or a fall reaches it. Every number is the decompilation's; the two it does not give
 * (constants in the ELF's `.data`, not in the handoff) are named placeholders.
 */

/** The six hit locations, in the order `FUN_005a4840` loads the death lists (research 91, vocabulary). */
export const PART = { HEAD: 0, RARM: 1, LARM: 2, BODY: 3, RLEG: 4, LLEG: 5 } as const;
export type Part = (typeof PART)[keyof typeof PART];
export const PARTS = 6;

/** MP part health, head/rarm/larm/body/rleg/lleg (`character.rdr` `mp_seal`/`mp_terror`; `FUN_0053ddb0` L406804). */
export const MP_HEALTH: readonly number[] = [8, 30, 30, 50, 30, 30];
/** MP part armour (`FUN_0053ddb0` L406826-406833). */
export const MP_ARMOUR: readonly number[] = [0, 25, 25, 25, 25, 25];
/** Every damage is multiplied by this after falloff (`FUN_003c5950`, L318767). */
export const DAMAGE_SCALE = 14;
/** The world's units a weapon-table metre (`Effective_Range` x 10, L318752). */
const RANGE_UNITS = 10;

/**
 * `DAT_006508a8` / `DAT_006508b0`: a hit on an arm or leg already at 0 goes to BODY as `dmg x` this, at this piercing
 * (`FUN_005a5830` L461487-461490). The constants are in `.data`, not in the handoff: PLACEHOLDER -- 0.5 and the round's
 * own piercing, so limb shots can finish a SEAL, slower than body shots.
 */
export const LIMB_SPILL_PLACEHOLDER = 0.5;

/** A SEAL's health and armour per part. */
export interface Health { hp: number[]; armour: number[] }

export function freshHealth(): Health {
  return { hp: [...MP_HEALTH], armour: [...MP_ARMOUR] };
}

/** Dead: the head or the body at 0 (`FUN_005a54d0` L461376-461380). */
export function isDead(h: Health): boolean {
  return h.hp[PART.HEAD]! <= 0 || h.hp[PART.BODY]! <= 0;
}

/** The HUD's bar, 0..1: `(3 head + arms + body + legs) / (3 headMax + ...)` (`FUN_005a56d0` L461416-461437). */
export function overall(h: Health): number {
  const w = (i: number): number => (i === PART.HEAD ? 3 : 1);
  let have = 0, max = 0;
  for (let i = 0; i < PARTS; i++) { have += w(i) * Math.max(0, h.hp[i]!); max += w(i) * MP_HEALTH[i]!; }
  return max > 0 ? have / max : 0;
}

/**
 * A round's damage at `distance` world units (`FUN_003c7600`): `ImpactDamage + Damage_Modifier`, full to
 * `Effective_Range` x 10, linearly to 0 at `Maximum_Range` x 10, times 14; null beyond the maximum (the round is
 * ignored, L318752-318760, `FUN_003c8920` L319410).
 */
export function bulletDamage(w: { impactDamage?: number; damageModifier?: number; effectiveRange: number; maximumRange: number }, distance: number): number | null {
  const base = (w.impactDamage ?? 0) + (w.damageModifier ?? 0);
  const e = w.effectiveRange * RANGE_UNITS, m = w.maximumRange * RANGE_UNITS;
  if (distance > m) return null;
  const falloff = distance <= e || m <= e ? 1 : 1 - (distance - e) / (m - e);
  return base * falloff * DAMAGE_SCALE;
}

/**
 * The armour step on one part (`FUN_003c7400` L318568-318590): the armour takes `A x (10 - P)/10` off the damage and
 * loses a quarter of what it took; the rest comes off the part's health; nothing goes below 0.
 */
function armourStep(h: Health, part: number, dmg: number, piercing: number): void {
  const a = h.armour[part]!;
  const eff = Math.max(0, dmg - (a * (10 - piercing)) / 10);
  h.armour[part] = Math.max(0, a - (dmg - eff) / 4);
  h.hp[part] = Math.max(0, h.hp[part]! - eff);
}

/**
 * One hit on one part (`FUN_005a5830` L461469-461547): a live head, arm or leg takes the armour step; an arm or leg at
 * 0 passes `LIMB_SPILL_PLACEHOLDER` of it to the body; a head at 0 takes nothing; a body hit takes the step and then
 * caps each limb at `limb max x body / body max` (the head uncapped). Returns whether the SEAL died of it.
 */
export function applyHit(h: Health, part: number, dmg: number, piercing: number): boolean {
  if (isDead(h)) return false;
  if (part === PART.BODY) {
    armourStep(h, PART.BODY, dmg, piercing);
    const share = h.hp[PART.BODY]! / MP_HEALTH[PART.BODY]!;
    for (const limb of [PART.RARM, PART.LARM, PART.RLEG, PART.LLEG]) h.hp[limb] = Math.min(h.hp[limb]!, MP_HEALTH[limb]! * share);
  } else if (h.hp[part]! > 0) {
    armourStep(h, part, dmg, piercing);
  } else if (part !== PART.HEAD) {
    return applyHit(h, PART.BODY, dmg * LIMB_SPILL_PLACEHOLDER, piercing);
  }
  return isDead(h);
}

/** `FALLING_DAMAGE_LIGHT` and `_DEATH` as landing speeds: `sqrt(2 g h)` at g 235, h 62 and 120 (`FUN_0059ba80`). */
export const FALL_HURT_SPEED = 170.7, FALL_DEATH_SPEED = 237.5;

/** A landing at `speed` (units a second, downward): every part loses `max x f`, `f = clamp((v-170.7)/(237.5-170.7))` (`FUN_005ac1f0` L464864-464960). */
export function applyFall(h: Health, speed: number): boolean {
  const f = Math.max(0, Math.min(1, (speed - FALL_HURT_SPEED) / (FALL_DEATH_SPEED - FALL_HURT_SPEED)));
  if (f <= 0) return false;
  for (let i = 0; i < PARTS; i++) h.hp[i] = Math.max(0, h.hp[i]! - MP_HEALTH[i]! * f);
  return isDead(h);
}

/**
 * The fragments a blast sends at a SEAL `distance` away (`FUN_005a18b0` L459394-459460): within 30 units 8 plus one of
 * 1/2/4/5/6/7 at 5/10/35/35/10/5 %, one fewer crouched and three fewer prone; beyond 30 that count x `900 / d^2`,
 * rounded up or down at random by its fraction.
 */
export function fragmentCount(distance: number, posture: 'stand' | 'crouch' | 'prone', random: () => number): number {
  const roll = random();
  const extra = roll < 0.05 ? 1 : roll < 0.15 ? 2 : roll < 0.5 ? 4 : roll < 0.85 ? 5 : roll < 0.95 ? 6 : 7;
  let n = 8 + extra - (posture === 'crouch' ? 1 : posture === 'prone' ? 3 : 0);
  if (distance > 30) {
    const scaled = n * (900 / (distance * distance));
    n = Math.floor(scaled) + (random() < scaled - Math.floor(scaled) ? 1 : 0);
  }
  return Math.max(0, n);
}

/**
 * One fragment's damage (`FUN_005a0e70` L459235-459256): `(Explosion_Damage + Dmg_Mod) x falloff x 14`, the falloff
 * full to half the radius and linear to 0 at it (research 85 section 7.1).
 */
export function fragmentDamage(explosionDamage: number, radius: number, distance: number): number {
  if (distance >= radius) return 0;
  const falloff = distance <= radius / 2 ? 1 : 1 - (distance - radius / 2) / (radius / 2);
  return explosionDamage * falloff * DAMAGE_SCALE;
}

/**
 * The part a fragment strikes (`DAT_006508d0`/`e0`, in `.data`, not in the handoff): PLACEHOLDER -- every part alike,
 * at random (`FRAGMENT_PART_PLACEHOLDER`).
 */
export function fragmentPart(random: () => number): number {
  return Math.min(PARTS - 1, Math.floor(random() * PARTS));
}
