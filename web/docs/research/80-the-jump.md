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
  Hz** (the fall speed takes `g dt` before it moves the height); **0.78 s** from take-off to landing on flat ground.
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

## 6. Readings and placeholders (named in the code)

- **The 0.1 s wind-up** holds the feet on the floor: the decompilation's fall integrator runs through it (a sink of
  1.4 at most) with the landing gated off; that the collision holds them is the reading.
- **The jump's gate while an action plays**: refused in any action but the fall (the stack takes the `Jump` only from a
  locomotion action, `FUN_00550ef0`'s flag 0x40 test; not every branch read).
- **`actor+0x1044`**, the walk-off's in-air gate: not read; the in-air clip starts on the first airborne tick.
- **`NoInterrupt`**: not read; the landings hold the mover their full length (the ground state does not run on them).
- **Damage classes 2 and 3** play a hit or the death fall in the game; the viewer plays the hard landing.
- **The node blend**: several nodes' poses are a weighted, normalised quaternion average (the skeleton evaluation's
  own blend is not read); the cross-fade's ease is research 17's traced one.
- **Modes**: only the default mode is played (`ready`'s `seal_stand_alert01/02`, `seal_walk_alert02` are not).
- **The pistol** plays its `seal_p_*` version or layer (the game's `Pistol ...` actions are a set of their own).
- **Not applied**: the run's bank and the upper body's pitch (web research 83: the node `actor+0x2fc` is not named);
  `Step` (16) and the crouch step; the velocity's shape within a stride (the mover moves at the target speed).
- **`FUN_0058a820`** (the standing footfall's gate) is read as "moving".

## 7. The numbers the tests pin

79.9 up, 0.1 s wind-up, 12.92 top at 60 Hz (13.58 closed form), 0.78 s flight, the carried 65, no landing clip with
the stick held and `seal_land_soft` without, 0.4 s lock; the standing jump on the floor 0.993 s, its stick 65 / 37 /
65 / 20; a 42-unit walk-off lands hard, glides 13.5 to a stop and runs on after 0.903 s; the full run `seal_run` at
1.1265; full aside `seal_run_90r` its root at 65; a 0.3 stick aside the slow and fast strafes split, both at 19.5; the
crouch right strafe half a cycle on; the crawl backwards; the one-shots' `playback x ((n-1)/n)^2`; `jump_whoosh` at
0.418 s; the footfalls alternating; the transitions by stance and speed.

## 8. What a console run would settle

The flight time and top of a flat running jump (0.78 s, 12.9); that the feet do not sink in the wind-up; the standing
jump's 0.99 s; the landing clip choice with the stick held; the transitions' holds; the crouch idle's draw.
