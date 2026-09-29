/**
 * The shared sim (web sprint 3, M2; spec W3.R2): everything the multiplayer server runs of the walk, headless -- no
 * three.js, no DOM, no Web Audio anywhere under it (`test/simBoundary.test.ts` walks the imports and refuses them). The
 * page imports these same modules; the server (`@s2u/server`) imports them through here, so both predict and
 * decide with one code path.
 *
 * - the mover (`./mover`): the stick law, stances, jumps, landings, action root motion, the probe on the hull;
 * - the traversal moves (`./traversal`): ladders, climbs, peeks, dives, water;
 * - the motion table and clip timings the mover and the moves read (`./motionTable`, `./locomotion`, `./clipPath`);
 * - the tuning (`./physics`) and the stature (`./stature`);
 * - the round (`./round`) and its accuracy and penetration (`./accuracy`), the kick (`./rifleKick`);
 * - the magazines (`./magazines`): the game's ring, one a weapon, the page's `Fire` and the room counting alike;
 * - grenades live headless in `@s2u/scene` already (`projectile.ts`: launch, step, the blast's damage).
 */
export * from './mover';
export { Traversal } from './traversal';
export * from './round';
export * from './magazines';
export * as accuracy from './accuracy';
export { penetrate } from './accuracy';
export * from './physics';
export * from './stature';
export * from './motionTable';
export { oneShotSeconds, airBands, SEAL_ANIMS } from './locomotion';
export { RifleKick } from './rifleKick';
export { openingStand } from './stand';
export * from './simMap';
export { DoorSet, doorInReach, pickDoor, readDoors, PHASE_REST, VALVE_LOCKED, type DoorHooks, type DoorSpec } from './doors';
export * from './net/protocol';
export * from './net/codec';
export * from './net/body';
export * from './net/moverSim';
export * from './net/damage';
export * from './net/lobby';
export * from './net/deaths';
export * from './net/rules';
