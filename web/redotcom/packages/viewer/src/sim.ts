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
 * - grenades live headless in `@s2u/scene` already (`projectile.ts`: launch, step, the blast's damage);
 * - the reload's clip and length (`./reloadClip`): the page's reload and the room's lock, one table (MJ-1);
 * - the camera's geometry (`./cameraRig`) and the server's accuracy cone over it (`./net/shotCone`, OWNER-3): the room
 *   refuses a round whose eye or aim the page's camera and cone could not have made;
 * - the fire modes' wait (`fireInterval`, `FUN_005c09f0`) the room rates rounds by, and the probe's lift (`PROBE_LIFT`,
 *   the tick's floor pick from the feet + 5) a spawn is placed from.
 */
export * from './mover';
export { Traversal } from './traversal';
export { shortTurn, wrapYaw } from './yaw';
export * from './round';
export * from './magazines';
export * as accuracy from './accuracy';
export { penetrate, fireInterval } from './accuracy';
export { PROBE_LIFT } from '@s2u/scene';
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
export * from './net/blast';
export * from './reloadClip';
export { CAM_FAR, localCamera, lookHeight, scopeEyeHeight, toWorld } from './cameraRig';
export * from './net/shotCone';
