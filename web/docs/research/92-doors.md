# 92 -- Doors: what the action button does to a door, and the viewer's (2026-09-29)

Written 2026-09-29 after the owner's play test ("opening doors: I can see the action but they do not open or close").
Sources: the SOCOM II decompilation `analysis/socom2_game.elf.decomp.c` (cited `FUN_x` and its line), reCOM
(`recom/src/gamez/zAnim/zanim.h`) for the zAnim structures, and the disc: each map's `READERM.ZAR/actions.rdr`,
`MZANIM.ZAR` and `MP*_GEO.ZED`. Values marked [reading] are the viewer's interpretation where the decompilation
stops.

## 1. The game's door

A door is a **map action**. `READERM.ZAR/actions.rdr` (loader `FUN_002b4230`, registered by `FUN_002b4190` as
`EXECUTE_ACTION`, 0x3f2070) lists records with `node`, `valve`, `anim`, `type`, `range`, `elevation`, `bitmap`
(the keys are the strings at 0x3f20f0-0x3f2130). A `CZAction` holds (from its uses below):

| offset | field | use |
|---|---|---|
| +0x08 / +0x0c | the animation count and list (`anim`) | `FUN_002b44e0` 156787 picks one by index |
| +0x10 | the running animation, or 0 | `FUN_002b44e0` refuses while it runs (`FUN_00270e40`); cleared by its end callback `LAB_002b46d0` |
| +0x14 | the scene node (`node`) | passed to the animation as context type 3 |
| +0x18 | the `CValve` (`valve`): its short at +4 is the door's state | 0 shut, non-zero open (`FUN_002b4760` 156891: "Open/Close target door under reticule"; `FUN_002b4820`: "OPEN DOOR"/"CLOSE DOOR"); 99 locked (`FUN_002b46f0` 156872, `FUN_005aa240` 463830) |
| +0x1c / +0x20 | `range` / `elevation` (-1 none) | the reach test in `FUN_005aa240` |
| +0x24 | the type: 0 door, 2 switch, 3 defuse, 4 MP bomb, 5 breach, 6 satchel, 7 take item | `FUN_002b4820` |
| +0x3c | the net log id | `FUN_002bb5b0` |

**The pick** (`FUN_005aa240`, 463830-463905): the node under the reticle (actor +0x3fc, else +0x3dc), or one of its
parents up to six levels (`FUN_005aa470`), names an action; the action is refused when its valve reads 99 or its type
is 8; then the reticle's point on it (actor +0x3c0 / +0x3e0) against the SEAL's place (actor +0x1c): the ground-plane
distance squared under `range` squared, and when `elevation` is not -1, the height difference squared under
`elevation` squared.

**The button** (`FUN_00592d50`, the `0x2000` branch at 452002-452022): with an action picked and offered
(`FUN_002b46f0`: no animation of it running, not locked; the team mask +0x30 against the actor's), a non-MP-bomb
action runs `FUN_002b44e0(action, actor, FUN_005ec4e0(...))` and the branch ends -- the press goes to nothing else.

**The use** (`FUN_002b44e0`, 156787-156865): refused while its animation still runs; else animation `index` starts
through `FUN_00272bb0(anim, 1, 3, node, 4, valve, 1, actor+0x3b0)`: the node and the valve are its context. `index`
is `FUN_005ec4e0` (500519): 1 only when the action has two animations, is a door, a float of the controller (+0x120)
is at least `DAT_00650ae8`, the controller or the actor's +0x264 bit says so, a netlog record's kind is 1 and
`FUN_00519080` on the actor is positive -- the `kick_door` animations of Sandstorm, Chain Reaction, Guidance and
Requiem; else 0. Online the use is logged to the net (`FUN_002bb5b0`), and every valve that is non-zero is replayed
to a joiner (`FUN_002b4440` 156767).

**Nothing shuts a door by itself**: no timer or valve watch touches the door's valve outside its own animation.

## 2. The door animations on the disc

Frostfire's three doors all run `MZANIM.ZAR`'s `singleDoor_right` (dumped with `npx tsx tools/dump-effects.ts MP2
--mission 'singleDoor*'`). Its sequences:

- `seq_0` (activation 1, runs at the start): `IF VALVE == 0` -> `CALL_SEQUENCE open`, `ELSE` -> `CALL_SEQUENCE close`.
  The `VALVE` command's flags byte (+13) is 3: bit 0 takes the valve from the animation's context (`FUN_00353fd0`
  252128-252150: `FUN_002721c0(context, ref)`), which is the door's own valve; bit 1 would be a name index.
- `open` (activation 2, called): three set-2 commands (5, 16, 20; not the base set -- read as AI notices by their
  payloads: a radius 100 over 0.25 s, a 13-by-18 box [reading]; the viewer runs no AI and skips them), `VALVE` set 1
  (0x0b) on the context valve, `SOUND .DOOR_WOOD_OPEN` at the caller's node, then `OBJECT_MOTION_FROM_TO` with flags
  0x61 on the caller's node: the rotation form (0x40), relative (1): from the node's rotation now, to
  `(0, -0.766, 0, 0.643)` (100 degrees about -y) after it, over 0.7 s (+0x34).
- `close`: the same with the valve set 0, the turn `(0, 0.766, 0, 0.643)` and `.DOOR_WOOD_CLS` after the swing.

`singleDoor_left` turns the other way. So the valve changes at the start of the swing, the swing is a slerp
(`FUN_0025f9b0` 108850: `FUN_00306ae0` by elapsed / +0x34, the end set exactly; begin `FUN_0025fe70` 109034 reads the
node's rotation into +0x10 for flag 1, `FUN_003070c0(+0x20, +0x10)` makes the end), and the door's collision is the
node's: the leaf's `di` polygons hang under the node (`worldmodel/bdoor_4/door1=door1/door_slab`, 20 polygons, and
`.../pane1`, 2), so the engine's hull turns with the node.

The 22 maps hold 43 `DOOR` actions on 10 maps: Blizzard 6 (`singleDoor`, 1.0 s, with an `ELSEIF`), Frostfire 3
(0.7 s), Vigilance 4, Desert Glory 1 (`.DOOR_METAL_OPN`), Fish Hook 6, Sandstorm 7, Chain Reaction 2, Guidance 9,
Requiem 5 (1.0 s each). Sandstorm, Guidance, Requiem and Chain Reaction name a second animation (`kick_door`,
`kick_Door_left`/`_right`); Chain Reaction's two are not in its `MZANIM.ZAR`. The first animation of every door
swings its leaf 16-32 units out at its far edge and back to within 0.0002 (the survey in section 5).

## 3. What the viewer did, and why the doors never moved

Before this change the viewer read `actions.rdr` only for the HUD's prompt (`./mapActions`, research 87 section 5):
within 30 of a door's node the door icon showed. Nothing else read a door. The action button went to the traversal
(the climb, the ladder's slide) and nothing answered it at a door; the zAnim door animations were never decoded for
their rotation (`OBJECT_MOTION_FROM_TO` was read in its scale form only, for the muzzle flashes); the leaf was drawn
as a static prop (`door1` placed under the door node, one mesh per placement), and its collision polygons were baked
into the static hull the grid files once and the mover caches per cell. So the prompt showed and nothing moved.

## 4. What the viewer does now

- **Read** (`./doors` `readDoors`, from `./loadMap` and `./simMap`): each `DOOR` record on its scene node, its valve,
  range and elevation, its animations out of `MZANIM.ZAR` decoded (`decodeEffectProgram`, whose `fromTo` now carries
  the rotation form's two quaternions and whose `VALVE` carries the context flag), the collision owners under the node
  and the box the leaf can reach round its hinge. The owners are marked (`CollisionOwner.sweep`) before the hull is
  packed: the grid files them under the whole swing (so a polygon can be turned in place without relinking) and the
  mover reads their walls fresh every step instead of from its per-cell cache (`Walker.wallsNear`).
- **Run** (`DoorSet`, headless: the page and the server): the action starts the door's first animation on the effects'
  sequencer (`./effectRunner`) with a host that knows one node and one valve -- the `IF` on the valve, the calls, the
  valve set, the sound, the slerp -- and each step turns the leaf's polygons in the hull the movers read, from their
  rest positions through the node's rest-to-now matrix. Refused while it runs, as `FUN_002b44e0`. The kick is not run.
- **Pick** (`pickDoor`): the view's segment from the eye to the aim point (`WalkMode.fireAim`), bit-18 surfaces passed
  over [reading], the first polygon a door's (a tie within 0.05 unit with a frame's wall goes to the door [reading]),
  the feet within `range` on the ground plane and `elevation` in height, the door not swinging (`FUN_002b46f0`).
  The HUD's door prompt is this pick now, not the distance to the node.
- **Button** (`WalkMode.setActionFilter`, `./doorPage`): a door picked takes the press before the traversal does, as
  the game's branch does.
- **Draw** (`WorldView.moveNode`): every prop placement at or under the door's node path is drawn at the node's
  rest-to-now matrix after its own -- the leaf, its pane, the frame model's root -- so no copy is left where it was.
  The sound goes to the audio catalog by name (`.DOOR_WOOD_OPEN`, `.DOOR_WOOD_CLS`, `.DOOR_METAL_OPN`).
- **Multiplayer** (protocol 2): the client sends `{ type: 'door', seq, door }`; the server (`Room.useDoor`) checks the
  player's reach to the leaf as it stands (range and elevation plus 8, `doorInReach`) and runs the same `DoorSet` on
  the hull every player's mover reads; each snapshot carries every door in two bytes (`DoorWire`: the valve, the
  swing's phase 0-254, 255 at rest). A page follows: a swing the server began is run here too, heard and caught up to
  its phase; a door at rest with another valve (a late join) is run out silently.

## 5. Checks

- `test/doors.test.ts` (Frostfire): the three doors read; `bdoor_4` stops the SEAL shut, swings open on the action,
  refuses a second press mid-swing, lets the SEAL through, shuts on the next and stops it again; the sound and the
  drawn move, back to the identity when shut; the pick (on the leaf, not looking away, not past the range, `wdoor_2`
  from `hud.spec.ts`'s stand, not while swinging); the wire followed by a page.
- `test/doorPage.test.ts`: offline use, a match's `door` event and the snapshot-driven swing heard once, a spectator's
  press refused, a late joiner's silent catch-up.
- `test/worldDoors.test.ts`: `moveNode` on an own mesh and on one instance of a shared draw, and back.
- `server/test/room.test.ts`: the server's door on a synthetic map -- out of range refused, the swing's phase in the
  snapshots, open at rest, the leaf turned in the hull every mover reads.
- `test/netCodec.test.ts`: the doors on the wire, clamped, and the frame one byte longer without them.
- The survey of the 43 doors (every one swings and comes back) was a scratch script, not a test: the fixtures hold
  only MP2, MP6 and MP72.
- Owed: `e2e/doors.spec.ts` (X at `bdoor_4`, through, X again) and the full e2e (the HUD's prompt at `wdoor_2` is the
  pick now), in a browser window the host rule allows.

## 6. Not done

- The kick (`kick_door`, `FUN_005ec4e0`'s second animation): its conditions are not traced far enough to model.
- The set-2 commands of the door animations (AI notices by their payloads) are skipped: there is no AI in a round.
- Bullet marks made on a leaf stay where they were made when it swings (the game's own behaviour is not traced).
- The climb's per-grid polygon caches (`./climb`) do not know a leaf moves; a door is not a climb (its top is 23 up).
- The client does not predict its own door: the swing starts when the server's snapshot says so (a round trip).
