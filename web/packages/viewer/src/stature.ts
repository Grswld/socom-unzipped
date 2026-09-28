/**
 * The SEAL's measured statures, units over the soles (web sprint 2, W2.3; kept from the stand-in body when the
 * merge of the two sprint 2s replaced it with the real model): the derivation -- the console dump's skeleton and
 * the console frame `scripts/parity/refs/console_spawn_slot8.png` -- is in the spec's section 7, "The SEAL is 19.6
 * units tall". The first-person eye and the camera's stance limits read them (`./playerCamera`).
 */

/** The crown over the feet, standing (above: the dump's head joint 17.37 + the frame's head 2.23). */
export const STANDING_HEIGHT = 19.6;
/** The crown over the feet, crouched: the console frame at spawn, the SEAL crouched (above). */
export const CROUCH_HEIGHT = 12.4;
/** The body's top lying prone [estimate: the torso's depth on the floor]. */
export const PRONE_HEIGHT = 3;
/** The eye over the feet, standing [estimate: 0.936 of the stature], for the first-person switch (W2.1). */
export const HEAD_HEIGHT = 18.3;
