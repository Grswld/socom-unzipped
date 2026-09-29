# 80 — The jump, the landings and the locomotion blend: how SOCOM II plays the SEAL's clips (2026-09-28)

The motion workstream of the browser walk (the owner's playtest: "the jump height and duration is way off", "jumps are
floaty", "the walk sideways animation is off"). Everything below is read from `game/analysis/socom2_game.elf.decomp.c`
(cited as `FUN_<address>` and the file's line numbers), the ELF's data (`game/disc/socom2_game.elf`, read with capstone
where the decompilation lost an argument), and the disc's `RUN/READERC.ZAR` (`motion.rdr`, `animset.rdr`,
`dynamics.rdr`) and `RUN/MOTION_P.ZAR`. No console run: §8 lists what one would confirm. The viewer's code is
`web/packages/viewer/src/{walk,locomotion,animator,play,playerCamera}.ts`; the tests pin every number here.

## 0. The answers

- **There are two jumps, chosen by speed** (`FUN_0057e1b0`, 440776-440867): at **15 units a second or more**
  (`225 <= |v|^2`, the local velocity) the **running jump** -- a real leap off the floor; under it the **standing
  jump** -- a clip on the floor, the feet never leaving it.
- **The running jump's rise is an impulse, not a clip**: `actor+0x1364 = jump_factor x gravity x -0.4` (0.85 x 235 x
  0.4 = **79.9 units a second up**), written into the fall speed **0.1 s after the take-off** (`actor+0x1360`), then
  `dynamics.rdr`'s 235 a second squared. The top is **13.58 units (1.36 m)** in closed form, **12.9 at the game's 60
  Hz** (the fall speed takes `g dt` before it moves the height) over where the rise began -- which is **0.98 under the
  floor**, the wind-up's sink (§6b), so **11.95 over the floor**; **0.75 s** from take-off to landing on flat ground.
  The take-off's velocity is carried through the air with **no stick** (`FUN_0054d9a0`).
- **The standing jump's rise is the clip's skeleton root only**: `seal_jump` (20 keys, `playback` 1.1) lifts the
  root from 10.51 to **15.08** at key 12; the actor's height comes from a clip only for `UseVelY` motions
  (`FUN_0059afd0`), and `seal_jump` is none. It lasts **0.993 s** (`1.1 x (19/20)^2`, §3). While it plays the stick
  drives the SEAL at each set's top speed -- the only air control in the game (`FUN_0057a330`).
- **The landing** (`FUN_005af590`): over `land_hard_fall_rate` 115 `seal_land_hard`; else with the stick at rest (or
  the last airborne velocity under 20) `seal_land_soft`; else **no landing clip** -- the run goes on at once. No jump
  for 0.4 s after a landing (`actor+0x135c`).
- **Prone cannot jump** (`FUN_005b4340(.., 0xb)`); crouched can (the same `Jump` clip, the stance kept).
- **The camera reads the posed root** (`FUN_0029a950` through `FUN_002869d0`): it rises with the standing jump's
  clip and sinks through a crouch; the running jump lifts the whole actor.
- **The locomotion is a pick-and-blend, every clip rate-matched with no clamp** (`FUN_0058bdf0`, `FUN_00583030`): the
  forward set (`seal_walk_alert`, `seal_jog_alert`, `seal_run` -- the player's `Seal anim set`, not `seal_walk`/`seal_jog`,
  which are the guards') and the strafe set (`seal_rstrafe`, `seal_rstrafe_fast`, `seal_run_90r`, and the left three)
  share the weight by the stick's angle; inside a set the clip whose band holds `m x 65` plays, two split across an
  overlap. **At full sideways stick the game plays `seal_run_90r`/`_90l`** (a 55-a-second root, at 1.18x), never the
  slow strafe (a 14.6-a-second root) the viewer was flailing at 3x.

## 1. The actions and their names

The SEAL's animation is an action stack (`actor+0x1c0`) over plays on the skeleton (`actor+0x170`). An action is a
`short`: the ELF's name table at **0x661060** lists them in order -- 0 Reference, 1 Stand, 2 Walk, 3 Jog, 4 Run, 5 Walk
backwards, 6 Jog backwards, 7 Die, **8 Jump launch, 9 Jump fall, 10 Jump land, 11 Jump land hard**, 12 Strafe right,
13 Strafe left, 14 Strafe right fast, 15 Strafe left fast, 16 Step, 17 Stand -> Crouch, 18 Crouch, 19 Crouch -> Prone,
20 Crouch walk, 21 Crouch step, 22 Crouch strafe right, 23 Crouch strafe right fast, 24 Crouch walk backwards, 25 Stand
-> Prone, 26 Prone, 27 Prone crawl ... Later ones are looked up by name at start-up (`FUN_005e4f90`, 495177-495418):
`DAT_003deae8` is **"Jump"** (the string at 0x661510, too short for the strings dump), `DAT_003decc0`/`d0` the prone
strafes, `DAT_003def08` "dive_to_prone", `DAT_003def50` "Ladderslide". `READERC.ZAR/animset.rdr` maps each action to
clips per anim set; `character.rdr` gives `mp_seal` the **`Seal anim set`** (with `include (GLOBAL SOLDIER)`), whose
default modes are: Stand `seal_stand`, Walk **`seal_walk_alert`**, Jog **`seal_jog_alert`**, Run `seal_run`, Walk
backwards `seal_walk_bw`, Jog backwards `seal_run_bw`, the strafes, Run right/left `seal_run_90r/l`, Crouch **one of
`seal_crouch` 0.3 / `seal_crouch_alert01` 0.3 / `seal_crouch_alert02` 0.4** (drawn), the crouch walks and strafes, Prone,
Prone crawl, Prone rstrafe/lstrafe, Prone turn; `GLOBAL` gives Jump `seal_jump`, Jump launch
`seal_runningjump_launch`, Jump fall `seal_runningjump_in_air`, Jump land `seal_land_soft`, Jump land hard
`seal_land_hard`. The network replay `FUN_005880e0` (445738-446012) re-starts the same actions for a remote SEAL --
case 1 the standing jump, case 2 the running jump (with the same `0.1`, `0.4` and `jump_factor x gravity x -0.4`),
case 3 the fall -- which confirms the reading of the local path.

## 2. The jump, step by step

### 2.1 The request and its gates

- **The press** sets `actor+0x105e` bit 2 (`FUN_005469c0`, a controller command); `FUN_00550ef0` (418100-418160)
  takes it on the next update, when the current action is a locomotion one (the stack entry's flag 0x40), and calls
  `FUN_0057e1b0`.
- **`FUN_0057e1b0`** (440776-440867) refuses: an AI-controlled actor; `actor+0x105e` bit 5 (airborne);
  `actor+0x135c > 0` (the lock); the floor's normal y `actor+0x1348` under `DAT_0044c268` (cos `max_slope`,
  0.643: not walkable); `FUN_005b4340(actor, 0xb)` false; states 9 and 10 (`actor+0x174`); a carry (`+0xeac`).
- **`FUN_005b4340(.., 0xb)`** (469305-469561): among its tests, **stance 2 (prone) returns 0** -- prone cannot jump;
  stances 0 and 1 can.

### 2.2 The running jump (`speed^2 >= 225`)

`FUN_00588bc0(actor, 8, 6, 0, 0xd)` -- action 8 `Jump launch` -- then `actor+0x1360 = 0.1`, `actor+0x135c = 0.4`,
`actor+0x1364 = DAT_0044c258 x DAT_0044c250 x -0.4` (the tuning table's `+0x08` `jump_factor` and `+0x00` `gravity`),
`actor+0x1061` bit 1 set (the jump's own airborne flag) and bit 2 cleared, and `actor+0x1350..0x1358 = actor+0x38..0x40`
(the world velocity at take-off). Then each tick:

- **`FUN_005af930`** (466729-467019): `0x135c -= dt` (floored at 0); while `0x1360 > 0` it counts down and, **on the
  tick it reaches 0, `0x133c = 0x1364`** -- the fall speed becomes -79.9 (up). The airborne bit 5 is set, then
  `FUN_0059b440` clears it on a floor.
- **`FUN_0059b440`** (456467-456570): `0x133c += g x dt; height -= 0x133c x dt` (the fall speed first, so at 60 Hz the
  rise is `sum(79.9 - k g dt) dt`, a top of 12.92), `g x 0.8` only in `Ladderslide`. With bit 1 set there is no floor
  clamp here; the landing is **`FUN_0059ad30`** (456261-456327): the height under the floor, bit 1 set, bit 2 clear and
  **`0x1360 <= 0`** -- so no landing during the 0.1 s wind-up.
- **`FUN_0054d9a0`** (416501-416555): in actions 8 or 9 (or falling, or the dive) the local velocity is `(0, -0x133c,
  0)` and the world velocity's x and z are `0x1350`/`0x1358`: **the take-off velocity, carried, no stick**. After a
  landing, while a landing action plays, the same carried velocity runs down by `dt x 150`.
- **The clip**: `seal_runningjump_launch` (25 keys, `looped 0`, `playback` 2.4, `max_velocity` 6.5, `BlendTime` 0.2,
  `jump_whoosh` at 0.1). Its root height is constant (10.57): the rise is the actor's. A one-shot of 2.4 s runs its
  keys at `(n-1)/(playback (n-1)/n)`... in practice about 10.9 keys a second, so a flat running jump lands about key 8.

### 2.3 The standing jump (`speed^2 < 225`)

`FUN_0058a4d0(actor, 0)` (pops the stack to the stance's base) and `FUN_00588bc0(actor, "Jump", stance, 0, 0xd)`. No
impulse, no airborne bit: **the actor's height stays on the floor**. `FUN_0059afd0` (456328-456466) takes the actor's
height from the clip only when the motion carries `UseVelY` (`seal_stand2hang`, `seal_stand2ladder`: there the root's y
over 11.487 is moved into the actor); `seal_jump` has no `UseVelY`. Its root, per key: 10.51 ... 10.77 (key 8), 11.46,
13.09, 14.55, **15.08 (key 12)**, 14.94, 14.33, 12.83, 11.27 (key 16) -- the body leaps and lands inside the clip.
**Air control** (`FUN_0057a330`, 438955-438985): in the `Jump` action, with the stick off rest, the throttle ramp
(`FUN_00586c10`) and then `x = lateral x (top of the side sets)`, `z = -forward x (top of the forward set, or the back
set's backing up)`, the tops from `FUN_0058bb50` / `FUN_0058bc00` (447619-447686) by stance -- the per-stance table
`FUN_005e0450` (494496-494629) fills with each set's highest band end: **65 ahead, 37 back, 65 aside standing; 20 each
way crouched**. `DAT_0064fc80` is 1 here (no renormalisation). At rest the velocity is the clip's root motion:
`seal_jump`'s root does not travel.

### 2.4 The landing

The landing branch of `FUN_005af930` (bit 5 now clear, set the tick before): `0x135c = 0.4` (no jump for 0.4 s), and
**`FUN_005af590`** (466641-466728) with the contact's fall speed:

- `FUN_005ac1f0` (464864-464968) classes it against `m_landSpeed[3]` (`+0x30..0x38`, reCOM's
  `sqrt(2 g h)` of `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` 62 / 91 / 120 units: 170.7 / 206.8 / 237.5) and plays the
  surface's landing sound for every class;
- **over `land_hard_fall_rate` (`DAT_0044c260`, 115)**: class 3 `Land forward` (death), class 2 a hit clip, else action
  11 **`Jump land hard`**;
- **else**, when `|actor+0x38|^2 <= 400` (the world velocity of the last airborne tick, the fall included:
  `FUN_005483d0` 413963) or the stick is at rest: action 10 **`Jump land`**;
- **else no clip**: the blend times set to 0.4 and the ramp skipped (`actor+0x248 = +0x244`) -- the run goes on.

`land_fall_rate` (`+0x0c`, 40) is not read here. A walk-off becomes airborne in `FUN_0059b440` and plays **`Jump
fall`** (`FUN_0057e130` / `FUN_0057e050`, 440716-440775; the gate `actor+0x1044 > 0` is not read); a 42-unit drop
lands at 140 -- the hard landing.

### 2.5 The camera

`FUN_0029a950` (142412-142562) takes the root through `FUN_002869d0(actor+0x170, *(actor+0x2e8), 0, &root, 0)`
(142450-142460): the **posed** skeleton root in model space, after the animation update. So the target
`rootY + ramp(rootY)` rises 3.6 with the standing jump's root, moves through the stance transitions' clips and drops
1.2 running (`seal_run`'s root is 10.30 against the stand's 11.48); the running jump carries the whole actor up. The
prone clips' root, 2.17, is exactly the ramp's floor `2.169155`.

## 3. The motion player

**A loaded motion** (the clip reader `FUN_0028a5c0` keeps the file's duration at `+0x10` and its 1.0 at `+0x14`; the
`motion.rdr` loader **`FUN_00287620`**, 131191-131653, then; `FUN_0028ab10` / `FUN_0028aa20`, 133194-133292):

| field | value |
|---|---|
| `+0x49` bit 6 / bit 7 | `looped` / `max_velocity < 0` (then read as 0) |
| `+0x1c` V | looped: `max_velocity x 10 / 100`, or 1 when that is 0; one-shot: 1 |
| `+0x10` T | one-shot or bit 7: `playback`; a looped locomotion clip: `duration / playback` |
| `+0x18` D | the root's travel key 0 to key n-1 in x and z, x `n/(n-1)` looped |
| `+0x14` K | looped with D > 0.2: `(bit 7 ? T : 100 T) / D`; else 1 |
| `+0x20` | `BlendTime`, **0.4** when absent (`0x3ecccccd`) |
| callbacks | `time > 1 ? time / (T (n-1)/n) : time`, the phase |
| transitions | `(motion, A, B)` kept in file order when A or B is not 0 |

**A play** (`FUN_0028dc90`, 135117-135227) is a list of nodes -- motion, weight `+0x08`, speed `+0x24`, phase offset
`+0x0c` -- and one phase. `FUN_0028d570` sets a speed x K on a looped motion. **`FUN_0028c4f0`** (134223-134280) moves
the phase by `dt x sum(w x speed / (T x a))`, `a = 1` looped and `(n-1)/n` otherwise (`FUN_0028ada0`), wrapping a loop
and stopping a one-shot at `(n-1)/n`; `FUN_0028d670` samples key `phase x n`. So **a one-shot plays keys 0 to n-1 in
`playback x ((n-1)/n)^2`** (`seal_jump` 0.993 s, `seal_land_soft` 0.632, `seal_land_hard` 0.903, the transitions 0.603,
0.846, 0.945) and **a locomotion cycle turns at `target / D` cycles a second** -- its root travels exactly the target
speed. The velocity (`FUN_0028c250`, 134145-134183, through `FUN_00289bb0`) is the weighted root motion x speed:
research 25's traced `+0x24` **1.1265** for the full run is `0.65 x 63.3 / 36.54` here. `FUN_0028bef0` (133997-134079)
swaps a play's nodes with no blend; a new play snapshots the pose (`FUN_0028e3e0`, 135387-135414) and blends over the
new motion's `BlendTime`, the phase kept between two loops; `FUN_0028c160` plays a one-shot backwards from its end.
`FUN_0028c9e0` / `FUN_0028c7c0` (134311-134449) fire a callback when the phase steps over it (forward
`from <= t <= to`; a wrapped loop `from - 1 <= t <= to`).

## 4. The locomotion

- **The sets** (`FUN_005e30f0` 495581 walks `motion.rdr`'s transition records in file order into `FUN_005e0030`,
  494313-494495, which multiplies A and B by 10 and files each action): `+0x60` Walk, Jog, Run; `+0x90` Walk/Jog
  backwards; `+0xf0` Strafe right, Strafe right fast, Run right (0x42); `+0xc0` the left three; `+0x120` Crouch walk;
  `+0x150` Crouch walk backwards; `+0x180` Crouch strafe left; `+0x1b0` Crouch strafe right (fast). Only an action's
  default-mode motion matches, so the Walk band is `seal_walk_alert`'s 0-4 m/s.
- **`FUN_0058bdf0(m, weight, set)`** (447743-447913): `v = |m| x 100 x V` of the set's first clip (units a second,
  `m x 65`); every clip whose `[A, B]` holds v is taken at speed `m x V_i` (x K_i); two taken split by `f = (v - max A)
  / (min B - max A)`, the earlier `(1 - f) weight`, the later `f weight`; none: under all bands the lowest-starting clip
  at `min A / 100`, over all the highest-ending at `max B / 100`. `weight < 1` first scales the play's nodes by
  `1 - weight` (`FUN_0028cfc0`). The back and left sets are called with `-m` and their speeds negated back
  (`FUN_0058bab0(-1)`): they play forward.
- **Standing, `FUN_00583030`** (443246-443323) with **`FUN_00583350`** (443324-443368: `m = min(1, |s|)`, the forward
  axis dead within 0.03, `w = asin(|lat| / |s|) x 2/pi`, `DAT_0064fc80 = 1/sqrt(w^2 + (1-w)^2)`): the forward (or back)
  set at weight **1.0** -- the decompilation drops the argument; the disassembly loads `$f13 = 1.0` at 0x5830b8 -- when
  `|fwd| > 0.03` and `w < 1`, then the strafe set at weight `w`, leaving the forward clips `1 - w`. The idle-to-move
  change pushes the `Walk` action first (`FUN_00586570`, 444793-444954): a cross-fade of 0.4.
- **Crouched, `FUN_00582d10`** (443164-443245): one set by the direction class at weight 1; the `+0x1b0` (right) clips
  half a cycle on; a class change snapshots and blends over the new clip's `BlendTime`.
- **Prone, `FUN_00583500`** (443369-443496): the class keeps one axis; `Prone crawl` at `max(|f|, |l|) x V`, negative
  (the crawl backwards) backing up, or `Prone rstrafe`/`lstrafe`; each its own action. Turning in place prone plays
  `seal_prone_turn` (web research 83).
- **The stance changes** (`FUN_005817d0`, `FUN_00581c10`, `FUN_00581540`, 442170-442660): to crouch, `Stand -> Crouch`
  unless moving (`speed^2 > 400` goes straight to the crouch's run, `> 100` to the crouch walk); to stand from crouch,
  the same clip backwards (`FUN_00588bc0`'s fourth argument, `FUN_0028c160`) unless `speed^2 > 100`; to prone
  `Stand -> Prone` / `Crouch -> Prone`; out of prone those backwards. The ground state runs only on a locomotion
  action (`FUN_005870e0` 445089-445250 tests the entry's flag 0x40): a transition holds the mover.
- **The footfalls** (`FUN_005a3570`, 460266-460382): on a locomotion action, moving (stance 0: `FUN_0058a820() > 1`;
  crouched or prone: `|v|^2 > 0.25`) and not airborne, the left foot's sound when the play's phase is in (0, 0.5) and
  was not, the right's in (0.5, 1); the surface's step sound at the foot node (`actor+0x2f0` / `+0x2f4`, `lfoot` /
  `rfoot`).

**Why the sideways walk looked wrong.** The viewer played `seal_lstrafe`/`seal_rstrafe` at every speed by a 45-degree
split, rate-matched and clamped at 3x: the full strafe (65) ran a clip whose root travels 14.8 at 3x -- 44 -- so the feet
slid. The game plays `seal_run_90r/l` at full stick (1.18x), `seal_rstrafe_fast` between, the slow strafe only under
28 (right) / 23 (left), and mixes them with the forward set by the stick's angle.

## 5. What the viewer does

- `walk.ts`: `Walker.jump` (the gates, the two jumps), the running jump's delayed impulse (`runningJumpSpeed`,
  `JUMP_DELAY`, `JUMP_LOCK`), the carried velocity and its run-down (`CARRY_DECAY`), the landing's clip, the standing
  jump's stick (`jumpControl`, `./locomotion` `airBands`), the walk-off's `Jump fall`, the stance transitions
  (`changeStance`, `ACTION_CLIPS` / `ACTION_SECONDS`); the snapshot carries the ground state (`GroundMotion`) and the
  action (`MoverAction`); `WalkMode.setPosedRoot` feeds the camera. The walk has no sprint: the mover never reads the
  boost.
- `locomotion.ts`: the motion constants (`motionOf`), the sets (`SEAL_SETS`, `SEAL_ANIMS`, `CROUCH_IDLES`, pinned
  against `animset.rdr`), `bandPick`, `standPlay`, `crouchPlay`, `pronePlay`, `oneShotSeconds`.
- `animator.ts`: the plays, the shared phase, the cross-fades, the events (`onEvent`: `callback`, `footfall`, `play`).
- `play.ts`: the posed root to the walk; `onEvent` for the page (the animator's, a footfall's world point, `takeoff`,
  `land`).
- `playerCamera.ts`: `tick(.., posed)` takes the posed root as it is.

## 6. The second round: what the game does after the clip (2026-09-28, later)

- **`NoInterrupt`** (`FUN_00587c20`, decomp 445514-445576; the stick test in `FUN_00550ef0`, 418180-418190): an action
  whose play is not ending this tick and whose phase is past its motion's `NoInterrupt` (`+0x30`: the loader's 0 when
  the key is absent, 1 when bare) gives way when a move axis passes 0.1 -- `FUN_005870e0(actor, 1)` runs the ground
  state. So the soft landing (no `NoInterrupt`) is cut the moment the stick moves, the hard landing past 0.35 of its
  phase (0.33 s), the standing jump past 0.7 (0.73 s), the hits and the get-up past 0.8; the launch (`NoInterrupt ()`)
  never. When the controller's `+0x30` answers (read as the player's), actions 100, 99, 25 (Stand -> Prone), 19
  (Crouch -> Prone), 17 (Stand -> Crouch) and `Pistol stand -> Prone` are never cut. A transition played backwards
  (getting up) has its node's bit 1 cleared (`FUN_00580b70`, `FUN_00581c10`): never cut either. The third axis the
  test reads (`actor+0x23c`, the turn): applied in the third round (§6b).
- **The heavy falls** (`FUN_005af590` with `FUN_005ac1f0`): over `land_hard_fall_rate` the class decides -- 3 (at or
  over `m_landSpeed[2]` 237.5, a 120-unit fall) `Land forward` (`seal_landforward01`) and the actor's death, 2 (over
  206.8, 91 units) `Hit01` (`guard_hit01`, 3.7 s) or `Hit stomach01` (`guard_hit_stomach01`, 2.9 s) by a draw
  (`FUN_00197740 x 4.656613e-10 <= 0.5` the stomach), 0 or 1 `Jump land hard`. `m_landSpeed[i] = g sqrt(2 h_i / g)`
  (reCOM `char_dyn.cpp:32-35`). The viewer has no death: after `Land forward` it plays `Get up forward`
  (`seal_getupforward01`, named). The hits, the death landing and the transitions move the actor by their clips' root
  motion (the velocity is `FUN_0028c250`'s for every action but the jumps and the landings); key by key since the
  third round (§6b).
- **`actor+0x1044`** is the actor's health: `FUN_005477a0` (412819-412844) writes it and calls the death when it reaches 0.
  `FUN_005af930`'s in-air clip starts only for a living SEAL -- always, in the walk.
- **`FUN_0058a820`** (446874-446894) is the speed class: 1 under 0.5 a second (`|v|^2 < 0.25`), 2 under 20, 3 from 20. The
  standing footfall wants a class over 1: moving at 0.5 or more, as the animator had it.
- **The engine's node blend** (`FUN_00577ea0` 437415-437474 samples each node with `FUN_005777d0`, 437177-437297; `FUN_00577000`
  436853-437136 merges them): the translations a weighted sum (six parts only take the clip's: the root, `hips`, the
  biceps and the shoulder weights -- the rest keep the skeleton's own; applied in the third round, §6b); the rotations two at a time -- first the `Lateral` motions among themselves, then the
  others, then what is left -- each pair by `FUN_00576e30`: the engine's slerp at `wb / (wa + wb)`, the weights summed.
  `FUN_00306ae0`, the slerp, takes a normalised lerp over a dot of 0.95. And the player's own actor (the LOD bit 3 of
  `actor+0xe0`, set for it) samples between keys with `FUN_00289570` (slerp) and `FUN_002898a0`: the blend-or-hold
  question of research 77 §7 is answered -- blended (distant actors take the nearest key, `FUN_00289470`).
- **The turn in place exists standing and crouched** (web research 83 said it does not): `FUN_00586570` with the move
  stick at rest and the turn axis `actor+0x23c` off rest calls `FUN_00586050`, which pushes action 16 **Step**
  (`seal_step`; `seal_alert_step` in the ready mode) -- crouched `FUN_00584c60` pushes 21 **Crouch step**
  (`seal_crouch_step`), prone `FUN_005845c0` the Prone turn -- and `FUN_00583960` (443497-443545) sets its speed to
  `|axis| x 0.6` (0.3 crouched, 0.35 prone, 0.6 for states 9 and 10), capped there, negative for a positive (left) axis.
  The axis is the turn over `turn_maxrate`. Entering from a loop whose phase x 60 is in 17..47, the step starts at
  phase 0.5.
- **The spine's nodes** (`FUN_00553ea0` 419595-419660, the ELF's names at 0x65c4c0...): `actor+0x2e8` skel_root,
  `+0x2ec` aimnodes, `+0x2f0` lfoot, `+0x2f4` rfoot, `+0x2f8` lhand, **`+0x2fc` spinelo**, `+0x300` rhand, `+0x304`
  hips (the headroom ray's start), `+0x308` head, `+0x30c` neck, `+0x310` spinehi, then the thighs, calves, arms,
  scapulae, the shoulder weights and the toes.
- **The run's bank** (`FUN_0057a330` 439197-439204): with the near-LOD bit 4 of `actor+0xe0` (set for the player), on
  the floor, `spinelo`'s rotation is pre-multiplied by a turn about z of `-0.000375 x actor+0x48 x actor+0x34` (the
  turn, rad/s left positive, and the local z speed): 3.1 degrees into a full turn at the run, leaning into the turn.
- **The aim's twist** (`FUN_005aca70`, 465019-465336; gated in `FUN_0057a330` 439152 by the aim envelope and
  `FUN_00587a30`, 445445-445479, which reads `NoPitchtwist` off the play's nodes): not prone; the aim (`actor+0x144c`,
  into model space) and the model's forward (`DAT_003f6500`, set at start-up: (0, 0, -1) read) are carried into each
  spine node's frame; their cross, times the envelope `FUN_00286b80(actor+0x1160)` and 0.1 (`spinelo`) or 0.4
  (`spinehi`), is a rotation vector turned into `(v sin|v| / |v|, cos|v|)` (`FUN_003067b0`) and pre-multiplied into
  the node. For a pitch p the two turn by 0.2 sin p and 0.8 sin p: about the whole pitch. The envelope is the weapon's
  raise (`FUN_005dfc80` over `actor+0xf74`); the walk's rifle being up, the viewer takes it at 1 (named).

## 6b. The third round: the feel's last readings closed (2026-09-29)

- **The turn axis cuts too** (`FUN_00550ef0` 418180-418190): the interrupt test reads `actor+0x23c` beside the two move
  axes -- the turn over `turn_maxrate` -- with the same 0.1. Turning the view past a tenth of the full rate cuts an
  interruptible landing, hit or get-up as the stick does. Applied (`Walker.turn`, set from the look each frame).
- **The actions move by their root key by key** (`FUN_0057a330` about 438957: the velocity is `FUN_0028c250`'s, which
  `FUN_00289bb0` reads as the root's change between the key the phase is on and the next -- the last key paired with
  the one before -- times keys over the play's length): the hits, the death landing, the get-up and the transitions
  carry the mover by that, so the SEAL stands still where the clip's root does and slides only while it moves; played
  backwards (getting up), the phase runs from the end and the motion turns round. Applied (`Walker.actionVelocity`,
  fed the pack's root keys through `WalkMode.setActionRoots`; the clip's mean stands in when the pack has none). **The
  landings' drift is not applied by the game**: `FUN_0054d9a0` (416501-416555) sets actions 10 and 11's velocity to
  the carried take-off velocity running down by `dt x 150`, so the soft landing's 3.3-unit root drift never moves the
  SEAL -- the viewer already did so.
- **The within-stride shape does not exist on the disc**: the same per-key velocity drives the ground locomotion, but
  every locomotion clip in the sets and the crawl moves its root the same distance each key (to 1.5 %, a fixture
  test): the per-key velocity is the constant target speed the mover already runs at. The weight is the clips' and
  the speed rules' (§4), not a surge within the stride.
- **The translations the engine takes** (`FUN_005777d0`, 437177-437297): only `skel_root`, `hips`, `lbicep`, `rbicep`,
  `lshoulder_wgt` and `rshoulder_wgt` take the clip's translation; the other 20 body parts keep the skeleton's own.
  A part outside the body (the rifle node, the props) keeps the clip's. After the update the root's x and z are zeroed
  (`FUN_0057a330` 439110-439130): the root's travel is the mover's, never the pose's. Applied (`BODY_PARTS`,
  `SAMPLED_TRANSLATIONS`), in the pose layers too.
- **The wind-up sinks** (`FUN_005af930` 466729-467019, `FUN_0059b440` 456467-456570, `FUN_0059ad30` 456261-456327):
  through the 0.1 s the fall integrates from rest and the landing is gated off by `0x1360 > 0`, so the feet sink
  0.98 in the five ticks; on the sixth the fall speed becomes -79.9 before the step, so the rise starts from -0.98
  (+0.287 after that tick). The top is 11.95 over the floor, the flight 0.75 s. Applied; the floor test lets the
  sunk feet move on through the wind-up.
- **The player plays the default mode**: the anim mode `actor+0x1336` is written only by `FUN_0057d710`, which only
  the AI and script paths reach (`FUN_005604c0`, `FUN_0056fd00` through `FUN_0058c5d0`); the player's actor is set up
  in mode 0 (`FUN_00553ea0`, 419517) and nothing on its path changes it. `ready`'s alert clips are the bots'.
- **The pistol's action set** (`FUN_0058c9e0` / `FUN_0058c820`, 448153-448283): with the item byte `actor+0xf79` at 2
  each node's action maps through the anim set's table (`+0x5c`, `FUN_005e1a50`) to its `Pistol ...` action where
  there is one, a sub-node at weight 1 that `FUN_00576bb0` lays over the parts it carries before the nodes are merged
  (`FUN_00577ea0`). Applied per node (`PISTOL_ANIMS`, pinned against `animset.rdr` by the `Pistol <action>` name
  rule); `Animator.setWeapon` switches with a cross-fade over the playing motion's `BlendTime` [reading].
- **The launch covers a flat flight; the fall is for what outlasts it** (research 90 issue 10): `FUN_005af930`'s
  airborne branch pushes `Jump fall` (`FUN_0057e130` -> `FUN_0057e050`, action 9) only with neither action 8 nor 9
  current, and the launch (`NoInterrupt ()`) ends only with its play (`FUN_00582540` on `FUN_0028c6e0`, 2.21 s) or the
  landing's pop. A flat running jump (0.75 s) lands in the launch, about its key 8; `seal_runningjump_in_air` plays on
  a walk-off and after 2.21 s of a running jump's flight. At a landing with no clip, `FUN_00589aa0` pops the launch
  and `FUN_0028da00` hands back the play it was pushed over -- the run -- so no frame of the stand shows; the viewer
  showed one (the landing tick's ground state was at rest) and now poses the run it left in. The game pushes the fall
  the tick after the launch's pop; the viewer on the same tick [reading].

## 7. Readings and placeholders (named in the code)

- **The jump's gate while an action plays**: refused in any action but the fall.
- **Death**: the viewer gets up after `Land forward`; no damage is kept.
- **The aim weight**: 1 (the weapon's raise envelope not run).
- **The weapon switch's blend**: the playing motion's `BlendTime` (the swap clips, `seal_rifle2pistol`..., are the
  weapon's to play).
- **Not applied**: the head's look (`FUN_005ad400`, cosmetic); the bots' modes (§6b).

## 8. The numbers the tests pin

79.9 up, 0.1 s wind-up, 12.92 top at 60 Hz (13.58 closed form), 0.78 s flight, the carried 65, no landing clip with
the stick held and `seal_land_soft` without, 0.4 s lock; the standing jump on the floor 0.993 s, its stick 65 / 37 /
65 / 20; a 42-unit walk-off lands hard, glides 13.5 to a stop and runs on after 0.903 s; the full run `seal_run` at
1.1265; full aside `seal_run_90r` its root at 65; a 0.3 stick aside the slow and fast strafes split, both at 19.5; the
crouch right strafe half a cycle on; the crawl backwards; the one-shots' `playback x ((n-1)/n)^2`; `jump_whoosh` at
0.418 s; the footfalls alternating; the transitions by stance and speed. The second round: the soft landing cut at
once, the hard at 0.35 and the jump at 0.7 of their phases, a transition never; 170.7 / 206.8 / 237.5; a 100-unit fall a
hit by the draw, 130 the death landing and the get-up; the hit's root travel; the lateral-first merge; the step at
0.6 / 0.3 / 0.35 and backwards to the left; the twist 0.2 sin p + 0.8 sin p; the bank 3.1 degrees. The third round:
the turn axis's cut at 0.1; a transition carried key by key, backwards when getting up, the mean without keys; the
six translated parts and the zeroed root; the locomotion roots flat to 1.5 %; the 0.98 sink and the 11.95 top; the
pistol table and its per-node overlay.

## 9. What a console run would settle

The flight time and top of a flat running jump (0.75 s, 11.95 over the floor); the wind-up's 0.98 sink; the standing
jump's 0.99 s; the landing clip choice with the stick held; the transitions' holds; the crouch idle's draw.
