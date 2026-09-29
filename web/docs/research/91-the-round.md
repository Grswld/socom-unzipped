# 91 -- The round: damage, death, respawn, teams, score, names (web sprint 3, M1)

Written 2026-09-29 for web sprint 3 (spec `web/docs/specs/2026-09-29-web-sprint-3-multiplayer-design.md`, ruling W3.R1: the server-authoritative respawn round, every value cited). Read-only research. Sources: the SOCOM II decompilation `analysis/socom2_game.elf.decomp.c` (cited `FUN_x Lnnn`, `Lnnn` = its line; strings by address, e.g. `0x65c480`), reCOM (`recom/`) where the decompilation is silent, the disc's `READERC.ZAR` tables (`character.rdr`, `damanim.rdr`, `dynamics.rdr`, `cheats.rdr`, `HudCLOC`/`UIMnLOC`, `global_valves.rdr`), `RUN/ZWEAPON.ZAR/zweapon.rdr`, each map's `READERM.ZAR/chartype.rdr`, `missionlist.rdr`, and the console frames `parity/s4_pcsx2/`. This merges two notes (91a: damage, health, death, respawn; 91b: teams, score, kill lines, scoreboard, names, kits). Handoff paths are given relative to the handoff root. `DAT_` values that live in `.data` could not be read (no ELF available to either note); each is a placeholder in §16. Units: 1 unit = 0.1 m (`DAT_003dfe10` = 10, research 85 §1). Not repeated here: research 87 §8 (round-start banner timing), §12 (scoreboard geometry), §14 (message window).

Vocabulary. **Part** = the 6-slot hit location, 0 HEAD, 1 RARM, 2 LARM, 3 BODY, 4 RLEG, 5 LLEG (the order `FUN_005a4840` L460950 loads `HEAD/RARM/LARM/BODY/RLEG/LLEG_DEATH_ANIMATIONS` into). **Local/remote**: controller vtable `+0x34` true = the actor is driven from another console. `DAT_0045a0c1` != 0 = online; `DAT_0045a0c0` = host. **Game** = `DAT_00437ce8` (the MP game object, `FUN_002a76d0` L149485). **Player** = a character (`+0x14` name, `+200` team flags, `+0xe1` bit 4 alive, `+0xfc8` player slot 0..23). Actor part fields: `+0xffc..+0x1010` health[6], `+0x1014..+0x1028` max[6], `+0x102c..+0x1040` armour[6], `+0x1044` overall health 0..1, `+0xfb0` death cause, `+0xfb4` death time. **Round stats** = the block at character `+0x58c`; **match stats** = `+0x544` (the round block is added into it at round end, `FUN_00223970` L76010-76062). Team ids 0 = SEALs, 8 = Terrorists (`aiteam_00`/`aiteam_08`, `mp_score00`/`mp_score08`). `FUN_002c31d0(p)` = is a SEAL, `FUN_002c30b0(p)` = is a Terrorist, `FUN_002c2fd0(p)` = is a spectator.

## 0. The answers in one table

| rule | value | citation |
|---|---|---|
| health per part (MP) | head 8, body 50, each arm 30, each leg 30 (all MP kits inherit `mp_seal`/`mp_terror`) | `character.rdr`; `FUN_0053ddb0` L406804 |
| armour per part (MP) | head 0, body 25, each limb 25 | `character.rdr`; `FUN_0053ddb0` L406826-406833 |
| bullet damage | (ammo `ImpactDamage` + weapon `Damage_Modifier`) x 14, after falloff | `FUN_003c7600` L318738-318740, L318767; `FUN_003c5950`; loaders `FUN_003d45a0` L322675, `FUN_003d2060` L322476 |
| falloff | full to `Effective_Range` x10, linear to 0 at `Maximum_Range` x10; beyond it the round is ignored | L318752-318760 (`FUN_003d27e0`, `FUN_003d27f0`); `FUN_003c8920` L319410 |
| armour step | `eff = max(0, dmg - A x (10-P)/10)`; `A = max(0, A - (dmg-eff)/4)`; `H = max(0, H - eff)` | `FUN_003c7400` L318568-318590 |
| hit location | the skeleton node the round's collision hit (§1.3); hands, feet, scapulas: no damage; one hit per actor per round | `FUN_005abbc0` L464672-464803; `FUN_003c8920` L319390-319405 |
| headshot | head node hit: part 0, death cause 3 | L464739-464743 |
| limb rules | limbs never kill; a hit on a zeroed limb goes to BODY as `dmg x DAT_006508a8` (placeholder); a body hit caps each limb at `limb max x body/bodyMax` | `FUN_005a5830` L461469-461547 |
| explosion damage | `(Explosion_Damage + Dmg_Mod) x falloff x 14` per fragment, random part; M67 140 to 75 units, 0 at 150 | `FUN_005a0e70` L459235-459256; `FUN_005a18b0` L459394-459460; zweapon.rdr |
| fall damage | every part `-= max x f`, `f = clamp((v-170.7)/(237.5-170.7))`; 62-unit fall starts it, 120 kills | `FUN_005ac1f0` L464864-464960; `FUN_0059ba80` L456671-456682; dynamics.rdr |
| death condition | head <= 0 or body <= 0 (or not alive) | `FUN_005a54d0` L461376-461380 |
| respawn availability | SUPPRESSION (game type 5) and host option `mp_allow_respawn`; no respawn game type | `FUN_002a7560` L149405-149431, caller L55619-55620 |
| respawn delay | prompt and press count from 5.0 s dead; the press works only once the body has faded (0.1 alpha/s from 1, 10 s) | `FUN_00592560` L451680-451701, L451724-451726; `FUN_001f97b0` L57070-57080 |
| respawn fade-in | alpha 0 -> 1 at 4/s (0.25 s); no banner or countdown | `FUN_00599b60` L455695 |
| respawn point choice | key 1/3 record in the slot's block whose nearest enemy is farthest (max-min squared distance) | `FUN_002b7ee0` L158655-158718; `FUN_002b8100` L158720 |
| round-start slots | key 0/2 record: non-respawn game = record `+0xfc8`; respawn game = random in the slot's block (`count/24` records) | `FUN_00598b90(a,0)` L75931; L158760-158787 |
| loadout on respawn | fresh full kit: the type's `default_weapons`, ammo `Ammo_Capacity` x `NumMags`; kit re-choosable while dead; stats kept | `FUN_00599f00` L455760-455800; `FUN_00599b60` L455604-455700; `FUN_00598b90` L455100-455230 |
| spawn protection | none | cheats.rdr; strings |
| friendly fire | host flag game-info bit 0 `mp_friendly_fire` -> `DAT_0044cdb8`; enforcement not found; create-game default "Friendly Fire is disabled." | L150754-150761, L163354-163369; frame `A_49_creategame` |
| team assignment | joiner: Terrorists if Terrorists < SEALs, or SEALs = 8, or both empty; else SEALs (ties to SEALs); host: SEALs | `FUN_002bc620` L161359-161395; `FUN_002c5450` L166238-166262; frame `A_55` |
| team size | 8 a team (slots 0-7); 16 players + 8 spectators (24 lobby records) | `FUN_002c4500` L165660; `FUN_002c4290` L165534, L165551; `FUN_002bc620` L161329-161334 |
| score, kills and penalties | enemy kill +2 (kills +1); suicide or fall -2 (suicides +1); team kill -2 (team kills +1); victim: deaths +1, 0 score; hostage/escortee kill -2 (in ESCORT a Terrorist +3) | `FUN_00545290` L411473-411512; `FUN_00545c90` L411872; `FUN_00545c10` L411850; `FUN_00545d10` L411894; `FUN_00545390` L411516-411547 |
| score, round bonuses | round win +5 to each player on the winning side; alive at round end +1 | `FUN_00545b10` L411806; `FUN_00223970` L76146-76160; `FUN_00545b90` L411828; L76162-76165 |
| defaults, players | 16 | frame `A_49_creategame`; `FUN_002bc620` L161328-161332 |
| defaults, rounds | 11 on the create-game screen (9 if the valve is 0 at load) | `A_49`; `FUN_001f5e70` L55628-55631 |
| defaults, round time | 6 minutes (choices 4-10; 300 s if 0 at load); seconds = menu x 60, clock ms x 1000 | `A_49`; UIMnLOC 273-279; L55621-55626; `FUN_002f83b0` L197274; `FUN_002a6c50` L149156 |
| defaults, FF / respawn | FF "disabled"; Respawn "disabled"; spectators YES, no password | `A_49`; UIMnLOC 249-250 |
| match win | first team to `mp_half_rounds` = (`mp_max_rounds` + 1) >> 1 (6 of 11); tiebreaker round past the last; no score or kill limit | `FUN_002a6c50` L149073-149082; `FUN_001fb420` L57633-57648 |
| kill lines | "%s fragged %s with %s" (enemy and team kills), "%s commits suicide with %s", "%s falls to their death"; weapon = ZWEAPON `DisplayName` | `FUN_00547860` L412879-412891; `FUN_003d19a0` L324284 |
| scoreboard sort | score (`+0x580` + `+0x5c8`) descending, ties keep join order; <= 8 rows a team | `FUN_00229d00` L78910-78941; `FUN_0022de60` L80575-80620 |
| scoreboard dimming | dead rows both colours x 0.6 (`0x3f19999a`) | `FUN_0022a290` L79022-79024 |
| name length | 30 characters kept in game; clan tag 15; lobby field 32 bytes | `FUN_005442c0` L410582-410590; L166266-166293 |
| name charset | printable ASCII plus an accented page on the on-screen keyboard | frame `A_37_namekbd` |
| name default | `"Player%d"` (network index), create path `"Player"` | L166268-166271; L410582-410585; L159304-159309 |
| name duplicates | resolved by the server ("already logged in" UIMnLOC 543, "questionable content" 544, game names "already in use" 294) | UIMnLOC |
| spectator modes | 0 follow a player, 1 free, 2 the map's scenic views; jump to visible player | `FUN_00295260` L139448 |

## 1. Damage and hit zones

### 1.1 Bullet damage (`FUN_003c7600` "GetDamage" L318650-318830, `FUN_003c7400` L318568)

| value | meaning | citation |
|---|---|---|
| `ammo+0xc` + `weapon+0x64` | base = `ImpactDamage` + `Damage_Modifier` (additive; absent = 0) | `FUN_003c7600` L318738-318740 (`FUN_003d4530`, `FUN_003d2050`) |
| `weapon+0x40` / `+0x3c` | `Effective_Range` / `Maximum_Range` x10: full to E, `x (1 - (d-E)/(M-E))` to M | L318752-318760 |
| beyond `Maximum_Range` | the round is ignored (projectile `+0x94`) | research 85 §1; `FUN_003c8920` L319410 |
| x 14 | every damage multiplied by 14 (`FUN_003c5950`) after falloff | L318767; inverse `FUN_003c5930` (/14) |
| `ammo+0x14` `Piercing` | armour bypass, 0..10 | `FUN_003c7400` L318568-318590 |
| `ammo+0x10` `Stun` | loaded, reader not traced | loader L322680-322684 |
| penetration | passing a material sets the round's remaining range to `(R + R x P x 0.1) x material+0x24` if smaller; damage not scaled | `FUN_003c8920` L319506-319516 |
| shotgun class (IDs 81-90) | pellets `FUN_005a1620` L459317: 8 if within `DAT_006508b8` (SP) / `DAT_006508c0` (MP) sq-distance, else 4 within `DAT_006508c8` (MP), plus 1/2/4/5/6/7 at 5/10/35/35/10/5 %, thinned by range; each pellet full `ImpactDamage x14` to a random part | `FUN_005abbc0` L464704-464737 (MP: the blast to BODY, L464735); `FUN_005a1b80` L459540-459570 |

Weapon class codes (`FUN_003d1a60` L324329): ID 4-30 pistol, 31-50 SMG, 51-80 rifle, 81-90 shotgun (`'Q'`), 91-100 MG, 101-120 sniper, 121-140 grenade (`'y'`), 151-170 placed explosives, 171-184 launcher rounds, 201-204 armour.

### 1.2 Per-weapon numbers (zweapon.rdr; x14 within `Effective_Range`; vs the MP character)

Shots columns assume full damage, each shot on the same part; "limb" = shots to zero one limb (not a kill).

| weapon (ID) | ammo | Impact | Dmg_Mod | Pierce | dmg/shot | head (8/0) | body (50/25) | limb (30/25) | E / M units |
|---|---|---|---|---|---|---|---|---|---|
| M4A1 (54) | 5.56x45 | 2.3 | +0.3 | 3 | 36.4 | 1 | 3 | 2 | 6000 / 10000 |
| M4A1 SD (62) | 5.56x45 | 2.3 | +0.15 | 3 | 34.3 | 1 | 3 | 2 | 5500 / 8000 |
| Mark 23 (15) | 45 ACP | 3 | 0 | 4 | 42.0 | 1 | 2 | 2 | 500 / 1250 |
| 226 / P228 / M9 / Model 18 | 9x19P | 1.5 | 0 | 2.1 | 21.0 | 1 | 6 | 5 | 450 / 950 |
| F57 (4) | 5.7x28 | 1.4 | 0 | 3.5 | 19.6 | 1 | 6 | 5 | 500 / 1250 |
| DE .50 (7) | 50 AE | 6.4 | 0 | 5 | 89.6 | 1 | 1 | 1 | 600 / 1750 |
| SR-1 Gyurza (13) | 9x21 | 2.2 | 0 | 8.5 | 30.8 | 1 | 2 | 2 | 500 / 1500 |
| HK5 (31) | 9x19P | 1.5 | 0 | 2.1 | 21.0 | 1 | 6 | 5 | 1500 / 3000 |
| MP5K (38) | 9x19P | 1.5 | 0 | 2.1 | 21.0 | 1 | 6 | 5 | 250 / 1000 |
| F90 (34) | 5.7x28 | 1.4 | 0 | 3.5 | 19.6 | 1 | 6 | 5 | 1500 / 3000 |
| Steyr Aug (68) | 5.56x45 | 2.3 | 0 | 3 | 32.2 | 1 | 3 | 2 | 1500 / 3000 |
| 552 (57) | 5.56x45 | 2.3 | 0 | 3 | 32.2 | 1 | 3 | 2 | 6000 / 10000 |
| 552SD (67) | 5.56x45 | 2.3 | -0.2 | 3 | 29.4 | 1 | 4 | 3 | 6000 / 10000 |
| AK-47 (58) | 7.62x39 | 2.3 | 0 | 6 | 32.2 | 1 | 3 | 2 | 6000 / 10000 |
| AK-105 (65) | 5.45x39 | 2.7 | 0 | 4 | 37.8 | 1 | 3 | 2 | 6000 / 10000 |
| SA-80 A2 (64) | 5.56x45 | 2.3 | 0 | 3 | 32.2 | 1 | 3 | 2 | 5000 / 12000 |
| Groza (66) | 7.62x39 | 2.3 | -0.3 | 6 | 28.0 | 1 | 3 | 2 | 6000 / 10000 |
| M63A (92) | 5.56x45 | 2.3 | -0.4 | 3 | 26.6 | 1 | 4 | 3 | 4000 / 8000 |
| SR-25 (106) | 7.62x51 | 2.3 | +0.4 | 8 | 37.8 | 1 | 2 | 1 | 12000 / 17000 |
| M82A1A (101) | .50 Cal | 9 | 0 | 7 | 126.0 | 1 | 1 | 1 | 18000 / 24000 |
| 870 (84) / Spas 12 (81) | 12 Gauge | 2.5 | 0 | 6 | 35.0 / pellet | 1 | 2 | 2 | 410/840, 400/850 |

The kits are in §14; no kit sets `ammo_count`/`mag_count`, so the weapon record's `Ammo_Capacity` x `NumMags` apply (§4.3).

### 1.3 Hit location (`FUN_005abbc0` L464672-464803, nodes bound in `FUN_00553ea0` L419606-419652)

| collision node (actor offset, bone) | part | citation |
|---|---|---|
| `+0x308`, `+0x30c` (bone names at 0x65c500, 0x65c508: short strings, [inferred] `head`, `neck`) | 0 HEAD (cause becomes 3 "headshot") | L464739-464743 |
| `+0x320` rbicep, `+0x324` rforearm | 1 RARM | L464749-464752 |
| `+0x328` lbicep, `+0x32c` lforearm | 2 LARM | L464744-464748 |
| `+0x310` spinehi, `+0x2fc` spinelo, `+0x304` (0x65c4f8, [inferred] `hips`) | 3 BODY | L464753-464757 |
| `+0x318` rthigh, `+0x31c` rcalf | 4 RLEG | L464763-464766 |
| `+0x314` lthigh, `+0x340` lcalf | 5 LLEG | L464759-464762 |
| hands, feet, scapulas, shoulder weights | none (no damage) | no branch |

The round's hit polygon must carry the flesh material (`DAT_003e14f8`); its owner is walked up to the actor, and `projectile+0x78` remembers it so a round hits an actor once (`FUN_003c8920` L319390-319405).

### 1.4 Part damage bookkeeping (`FUN_005a5830` L461469-461547)

| rule | citation |
|---|---|
| head/arm/leg with health > 0: armour step on that part | L461478-461486 |
| arm/leg already at 0: the hit goes to BODY as `dmg x DAT_006508a8` with piercing `DAT_006508b0` (placeholders); head at 0: nothing | L461487-461490 |
| BODY hit: armour step on body, then each limb's health capped at `limb max x body/bodyMax` (head not capped) | L461492-461526 |
| all parts clamp at 0 | L461528-461545 |

## 2. Health and armour

| value | meaning | citation |
|---|---|---|
| head 8 / body 50 / larm 30 / rarm 30 / lleg 30 / rleg 30 | MP part health (`mp_seal`, `mp_terror`; all MP kits inherit) | `character.rdr`; `FUN_0053ddb0` L406804 |
| armour head 0 / body 25 / limbs 25 | MP part armour | `character.rdr`; `FUN_0053ddb0` L406826-406833 |
| (SP for contrast) `basic_seal` 25/140/20/20/25/25, armour 0/35/10 | single-player SEAL | `character.rdr` |
| item 201 `Kevlar Armor` body armour >= 30; item 202 `Kevlar Armor with inserts` >= 60 | kit armour; no MP kit carries either | `FUN_005a0cd0` L459014; `FUN_005a0da0` L459041; `FUN_005c7840` L480330-480381 |
| `+0x1044 = (3 head + rarm + larm + body + rleg + lleg) / (3 headMax + ...)` | overall health 0..1 (the HUD bar) | `FUN_005a56d0` L461416-461437; `FUN_00241cc0` L89955 |
| reset on (re)spawn: parts = character values, health 1.0 | | `FUN_00553ea0` L419759-419762 |
| wounded groans every 0-3 s when health < 1 | single player only (`DAT_0045a0c1 == 0`) | `FUN_005a33b0` L460231 |
| flinch clip on any non-lethal loss (by part x stance, random; MP skips three long clips) | `*_FLINCH_ANIMATIONS`, damanim.rdr | `FUN_005a0270` L458712; `FUN_005a54d0` L461395-461410 |
| limp / leg slow-down | none: no reader of leg health affects movement; no limp clip or string in S2 (reCOM `zseal.h:722` `m_limp` is SOCOM 1) | searched `0x100c`/`0x1010`, `limp` |
| healing, bleed-out | none found; only mission scripts set health | `FUN_005d4770` L488010 |
| `strength` 4, `recovery_factor` 2 | loaded into the character type (`+0x2f4`, `+0x2f8`), readers not traced | `FUN_0053ce00` L406404-406405 |

## 3. Death

| value | meaning | citation |
|---|---|---|
| head <= 0 or body <= 0 (or not alive) | death | `FUN_005a54d0` L461376-461380 |
| death -> health 0, cause at `+0xfb0`, vtable `+0x58` | `+0xfb4` = clock at death, alive bit cleared | `FUN_005477a0` L412821; `FUN_00547af0` L413049 |
| cause codes | 5 bullet (3 when part 0), 4 explosion, 7 fall, 6 ghost/cleanup, 2/0 scripts | `FUN_005a54d0`, `FUN_005a0e70` L459285, `FUN_005ac1f0` L464954 |
| death clip | `{HEAD,BODY}_DEATH_ANIMATIONS[STAND/CROUCH/PRONE]`, random in the list; limb parts have no list -> BODY list's first clip for the stance; pistol variants when holding a pistol | `FUN_005a0700` L458831, `FUN_005a0950` L458898; damanim.rdr |
| head lists | stand: Death stand head01-04; crouch: Death crouch head01, chest01; prone: Death prone chest01 | damanim.rdr |
| body lists | stand: Die, Death02, Death stand chest03, rarm01, larm01, larm02, Crawl death01/02; crouch: back01, chest01, chest02; prone: prone chest01 | damanim.rdr |
| no clip for causes 4 and 7 | fall and blast play their own landing/knock clips | `FUN_005a54d0` L461384 |
| death sound | cause 1/2/3 -> sound 0x3d, else 0x3c, cause 6 none | `FUN_005979a0` L454470-454478 |
| ragdoll | none (no string, no physics body) | strings |
| camera, round games (respawn off) | spectate: `FUN_005ef2f0(0x18)` message 0x22, "cycle through living teammates"; the dead spectate for the rest of the round | `FUN_005979a0` L454484-454489; `FUN_001f97b0` L57059 |
| camera, respawn game | no switch found; body fades 1 -> 0 at 0.1/s (10 s) | `FUN_005979a0` L454491; applier `FUN_00551ec0` L418494 |
| silenced-weapon kill flag | IDs 16, 33, 62, 67, 105 -> stealth kill stat | `FUN_003c5ac0`; `FUN_005a5a80` L461597 |
| death counted | deaths +1 whatever the cause, also with no killer found | `FUN_00545d10` L411894; L458147, L464655 |

## 4. Respawn (SUPPRESSION + RESPAWN only)

### 4.1 When

Game types (every MP map has one fixed type, `missionlist.rdr` `TYPE`, game `+0x111`): 1 BREACH, 2 DEMOLITION, 3 ESCORT, 4 EXTRACTION, 5 SUPPRESSION (`FUN_002c9540` L168878-168906; names L184050-184060). There is no respawn game type; respawn is a create-game option (UIMnLOC 283 "Set respawn option for SUPPRESSION maps", 285). SUPPRESSION maps: Frostfire (2), Abandoned (5), Rat's Nest (8), Vigilance (51), Shadow Falls (64), Chain Reaction (81).

| value | meaning | citation |
|---|---|---|
| respawn on = `mp_allow_respawn` != 0 and game type == 5 | game `+0xdc` (the `Respawn` valve); game-info flags bit 0 FRIENDLY FIRE, bit 1 RESPAWN (L184080-184087, L191375-191383) | `FUN_002a7560` L149405-149431, caller L55619-55620 |
| 5.0 s | minimum since death (`now - player+0xfb4`) before the prompt and the press count | `FUN_00592560` L451680-451701; `FUN_001f97b0` L57080 |
| body alpha must be 0 (fade 0.1/s from 1 -> 10 s) | respawn fires only once faded | `FUN_00592560` L451724-451726; prompt `FUN_001f97b0` L57070-57080 |
| button: `FUN_002c64e0(0,pad) == 1`; pad result 0 = `Action` (X in Default config) | "Press the %c button to respawn." (0x3e3220; X 0x3e3310, alt 0x3e3330) | `FUN_00592560` L451675, L451656-451658; L57008-57030 |
| late joiner/ghost (`+0xd2`, bit 0x10000) never respawns | "You are a ghost..." | L451680; `FUN_002c2fd0` L164609 |
| `+0xfcf = 1` -> `FUN_00598b90(actor, 1)` | the respawn | `FUN_00547350` L412726 |
| fade in: alpha 0 -> 1 at 4/s (0.25 s) | new body | `FUN_00599b60` L455695 |
| `respawn_time`/`respawn_fade`/`respawn_range` | single-player mission AI (`ai_params`, reCOM defaults 5.0 / 0.75), not MP | `FUN_002aab20` L151333-151353; reCOM `src/gamez/zFTS/fts_mission.cpp:346-353` |
| respawn off | the dead spectate for the rest of the round; "select weapons for the next round" (HudCLOC 60488) | L454484-454487 |

### 4.2 Where (`FUN_002b8100` L158720, `FUN_002b7ee0` L158655, `FUN_0052fe60` L398400, `FUN_0052b5c0` L395740)

| value | meaning | citation |
|---|---|---|
| list key = record `flags >> 4`: 0 side-0 slot, 1 side-0 respawn ("twin"), 2 side-1 slot, 3 side-1 respawn | `AIMAPS.MPS` trailer list, grouped by key | `FUN_0052fe60` L398436 |
| side = 1 when `FUN_002c30b0(actor)` (team word 0x40000001, or 0x80000100 when `DAT_004412d8` is 0) | | `FUN_00598b90` L455229-455241; `FUN_002c30b0` L164662 |
| round start (`FUN_00598b90(a,0)`, L75931): key 0/2; non-respawn game: record = player slot `+0xfc8`; respawn game: random in the slot's block | block = `count/24` records from `slot x count/24` | L158760-158787 |
| respawn (`FUN_00598b90(a,1)`): key 1/3, in the slot's block, the record whose nearest enemy (team mask disjoint) is farthest | max-min squared distance over all actors | `FUN_002b7ee0` L158655-158718 |
| index >= count wraps (`index % count`) | | `FUN_0052b5c0` L395760 |
| facing = flags & 0xf: 0 (0,0,-1), 1 (.707,0,-.707), 2 (1,0,0) ... 7, then negated | 8 headings | L395768-395800 |
| y + 1.0 | lifted a unit above the cell | `FUN_002b8100` L158793 |
| 96-record maps: 24 respawn records a side -> 1 per slot; Frostfire/Rat's Nest (hundreds of twins) -> ~10 per slot | from research 75 §5.5 counts | research 75 |

Where the notes overlap: 91b listed `RESPAWN_POINT_PLACEHOLDER` (the rebuild copies the body's own matrix, L455645; the placement not traced) as not found. 91a's is a cited function chain (`FUN_00598b90` -> `FUN_002b8100` -> `FUN_002b7ee0`), so it is the stronger evidence and resolves that placeholder. 91b's copy of the old matrix is the rebuild step, not the placement. Open: 91a's slot is the player slot `+0xfc8` (0..23); 91b found the lobby team slot `+0x3e` (0-7) with "no link to type found"; the link between the two slot numbers was not read.

### 4.3 What

| value | meaning | citation |
|---|---|---|
| actor rebuilt from the chosen character type (kit may be re-chosen while dead: "%c Select new weapons") | full part health, alive; stats (`+0x544..+0x5ce`) saved before and written back after | `FUN_00599b60` L455604-455700; `FUN_00598b90` L455100-455230, L454977-455170 |
| inventory = the type's `default_weapons`; `ammo_count x mag_count` when given, else the weapon's defaults (`FUN_005bde20`) | fresh full kit, grenades included; 91b's "two weapon-state values restored [inferred: the kit is kept]" is the same rebuild (`FUN_005c7840` L455675), and 91a's cited default-weapons path wins | `FUN_00599f00` L455760-455800 |
| spawn protection / invulnerability | none found (`NoDie` is a debug cheat; `MPRespawn` cheat also exists) | `cheats.rdr`; strings |
| `%s_valve_alive` = 1, camera effects node re-added | | L455330-455337 |
| a respawn's own start | none: no banner or countdown, only the 4/s fade-in | `FUN_00599b60` L455695 |

## 5. Explosives and falls

| value | meaning | citation |
|---|---|---|
| explosion reaches an actor only with LOS from the blast to the head node (or a penetrable blocker) | queued at `+0x104c` | `FUN_005ac070` L464806; `FUN_005a0e70` L459090-459150 |
| fragments: 8 within 30 units + 1/2/4/5/6/7 (5/10/35/35/10/5 %); -1 crouched, -3 prone (not shotguns); beyond 30: `x 900/d^2`, stochastic rounding | | `FUN_005a18b0` L459394-459460 |
| each fragment: `(Explosion_Damage + Dmg_Mod) x falloff x 14` at `Piercing`, random part (`DAT_006508d0/e0`) | falloff: full to r/2, linear to 0 at r (research 85 §7.1) | `FUN_005a0e70` L459235-459256; `FUN_003c7600` L318720-318735 |
| M67: 10 -> 140/fragment to 75 units, 0 at 150 (P 4) | one head or body fragment kills | zweapon.rdr; §1.1 |
| HE: 11 -> 154 to 50, 0 at 100 (P 1); Claymore 16 -> 224 to 125, 0 at 250, /32 outside its cone; C4 18 r 50; PMN 6.5 r 40; Satchel 20 r 280 | | zweapon.rdr; research 85 §9.7 |
| knock-down factor `1 - d^2/r^2`; push `FUN_0057ed10(dmg/14)` | | L459178-459191, L459277 |
| fall: speeds `m_landSpeed = g sqrt(2h/g)`, g 235, h 62/91/120 (`FALLING_DAMAGE_LIGHT/HEAVY/DEATH` 6.2/9.1/12 x10) = 170.7 / 206.8 / 237.5 | | `FUN_0059ba80` L456671-456682; dynamics.rdr |
| fall damage: `f = clamp((v-170.7)/(237.5-170.7))`, every part `-= max x f`; class 2 (>= 206.8) a hit clip, 3 death | victim-local | `FUN_005ac1f0` L464864-464960 |
| fall death posts "%s falls to their death" (cause 0xfd), counts a suicide (the killer is set to the local player) | -2 score | L464955-464959 |

## 6. Hit feedback (victim)

| value | meaning | citation |
|---|---|---|
| health bar (488,396) 134x18, flashes on change | the only HUD damage cue | `CHealthBar` `FUN_00241cc0` L89935; research 87 §1.8 |
| damage-direction markers, red screen, blood on screen | none (no strings, no HUD element) | strings, `hud.rdr` |
| flinch clip by part and stance | | §2 |
| blast: `.RINGING_EARS` and every sound channel held at 0.35 volume for 5 s | local player, not shotguns | `FUN_005a0e70` L459193-459199; `FUN_003412f0` L241195 |
| landing jolt `FUN_00578150` +0.66 (class 2) / +0.33 (class 1) | | L464924-464929 |

## 7. Teams: assignment, balance, switching

SOCOM II has no in-round auto-balance: the host places each joiner once, on the lobby's rule, and a player may switch only to a team with a free slot.

| value | meaning | citation |
|---|---|---|
| 24 lobby records, `0x4c` bytes | `DAT_004414c4[i*2]`, i < 0x18; +0 team word, +0xe name, +0x2e clan tag, +0x3e team slot | `FUN_002c4500` L165621-165660; `FUN_002c5450` L166234 |
| team words `0x40000001` / `0x80000100` | SEALs / Terrorists while `DAT_004412d8` (sides swapped) is 0; swap when 1; `0x10000` bit = spectator | `FUN_002c4500` L165635-165655; lists `FUN_002c4b50` (first = `BSEALLISTVAR`) |
| 8 a team | "too big" at 9 or more (`mp_teams_too_big` = 1); switches and joins refuse at 8 | `FUN_002c4500` L165660; `FUN_002c4290` L165534, L165551 |
| team slot = lowest free 0..7 | `+0x3e` = first index with no teammate (`FUN_002c4810` terror / `FUN_002c4a20` SEAL, -1 when full) | L165718-165811, L165812-165900 |
| MaxPlayersValve default 16 | join refused ("Too many players", code 3) when SEALs + Terrorists >= it | `FUN_002bc620` L161329-161334; `FUN_002f83b0` L197194 |
| MaxSpectatorsValve default 8 | refused at it ("Too many spectators", code 2); 8, or 4 in a ladder game | L161397-161401; `FUN_002f83b0` L197370-197385; `FUN_002baf30` L160324 |
| host's own team | SEALs, unless the clan option is "Terrorist team" or the host spectates | `FUN_002c5450` L166238-166262; frame `A_55` (host socomp under SEALS) |
| joiner's team (no clan option) | Terrorists if Terrorists < SEALs, or SEALs = 8, or both empty; else SEALs (ties to SEALs); refused if the chosen side is full | `FUN_002bc620` L161359-161395; frame `A_55` (joiner socomq under TERRORISTS) |
| clan options | 1 "Terrorist team", 2 "SEAL team" (clan's members forced), 3 "Members only" (others refused, code 4 "Closed clan game"), 4 "Alternate teams" (swap each full game) | `FUN_002bc620` L161256-161299; UIMnLOC 264-272 |
| lobby SWITCH TEAMS | host toggles the record between teams if the other has < 8, re-slotting; no score or count condition | `FUN_002c4290` L165516-165570 (`FUN_002bae70` L160288) |
| "All Switch" | toggles `DAT_004412d8` and re-sends the team lists | `FUN_002bada0` L160253 -> `FUN_002c0040` L162971 |
| launch rule | "There must be players on both teams to launch": `mp_team_unbalance` = 1 while a team is empty (and neither too big) | `FUN_002c3cf0` L165325-165352; UIMnLOC 350, 356 |
| READY after 30 s | "The READY button will be available in 30 seconds" | UIMnLOC 350; `mp_prog_timer1` created at 30 (`FUN_002a76d0` L149587) [link inferred] |
| empty game | both teams empty mid-game with spectators left: `dlgNetAbandoned.rdr` | `FUN_002c4500` L165673-165676 |
| late joiner | "appear as a ghost ... wait until the next round" (game `+0xd2`); or spectate | UIMnLOC 352-353; `FUN_001f97b0` L57048 |

## 8. Scoring

Each client counts only its own local player's points (`param_2 == FUN_002b3580()` in every writer) and syncs them; deaths likewise. The scoreboard's SCORE = match `+0x580` + round `+0x5c8`; KILLS `+0x550` + `+0x598`; DEATHS `+0x556` + `+0x59e` (research 87 §12).

| event | stat | score | citation |
|---|---|---|---|
| kill of an enemy player | kills +1 (`+0x598`), `total_mp_kills` +1 | +2 (`+0x5c8`) | `FUN_00545290` L411473-411512, from `FUN_0059ee20` L458090 |
| suicide (killer == victim; a fall is one) | suicides (`+0x14`) +1 | -2 | `FUN_00545c90` L411872; L458084-458085; fall L464957-464959 |
| team kill (killer and victim share a `+200` team bit) | team kills (`+0x16` / `+0x5a2`) +1 | -2 | `FUN_00545c10` L411850; L458112-458113; via `FUN_0059ee20` L458059 |
| victim | deaths (`+0x12` / `+0x59e`) +1, whatever the cause | 0 | `FUN_00545d10` L411894; L458147, L464655 |
| kill of an escortee/hostage/VIP (victim `+200 & 0x20000`) | `+0x18` +1; `mp_hostages_by_seals`/`_turds` +1 | -2; in ESCORT a Terrorist +3 | `FUN_00545390` L411516-411547; L458117-458145 |
| team won the round (`mp_winner` = own team) | `+0x3e` +1 | +5 | `FUN_00545b10` L411806; `FUN_00223970` L76146-76160 |
| alive at the round's end | `+0x42` +1 | +1 | `FUN_00545b90` L411828; L76162-76165 |
| objective events (not suppression) | as listed | +3 (`FUN_00545480`, SEAL), +N (`FUN_00545530`), +2 (`FUN_005455d0`, `FUN_00545650`), +4/+2 (`FUN_00545750`, +4 in BREACH) | L411552-411700 |
| friendly hits counted | `stats+6` | -- | `FUN_005458a0` L411735 |
| no credit | a kill line and credit need the killer found as a player (`+0x10 == 2`); the victim's killer id `+0xfc4` is taken once | -- | `FUN_0059ee20` L458071-458076 |
| MP penalty | `mp_penalty` (0x3f1140) created and zeroed; script use not read | -- | L149589 |

Team score (`seals_team_score` / `terrs_team_score`, game `+0x74`/`+0x78`) = the sum of that team's players' round score `+0x5c8` plus game `+0x7c`/`+0x80`, which grow by 1 per live teammate of an objective scorer (`FUN_00544d60` L411238-411300; team pick L411264-411280); reset at mission start (L149718-149731) and at the MP exit (`FUN_002232a0` L75823-75834). It is not drawn on the scoreboard (the team line shows round wins).

## 9. Round and match

| setting | default / range | citation |
|---|---|---|
| create-game defaults | players 16; rounds 11 (9 if the valve is 0 at load); round time 6 minutes (choices 4-10, UIMnLOC 273-279; 300 s if 0 at load; seconds = menu x 60, clock ms x 1000); "Friendly Fire is disabled."; "Respawn is disabled." (UIMnLOC 249-250); spectators YES, no password | frame `A_49_creategame`; `FUN_002bc620` L161328-161332; `FUN_001f5e70` L55628-55631; L55621-55626; `FUN_002f83b0` L197274; `FUN_002a6c50` L149156 |
| score limit / kill limit | none exists: no valve in `global_valves.rdr`, no string ("limit", "frag", "kills to") | strings |
| match win | first team to `mp_half_rounds` = (`mp_max_rounds` + 1) >> 1 wins (6 of 11) [comparison itself not found] | `FUN_002a6c50` L149073-149082 |
| tie after the last round | "PLAYING TIEBREAKER ROUND" when (`mp_round_count` + 1) > `mp_max_rounds` | `FUN_001fb420` L57633-57648 |
| round result | valves `mp_score00`, `mp_score08` (round wins -> game `+0x120`/`+0x124`), `mp_winner` (0 SEALs, 8 Terrorists, 0x40 none -> `+0x128`); read 3.0 s after the round's end state; `mp_game_over` set -> state 6 else 4 (next round) | `FUN_002a9b30` L150629-150672; reset `FUN_002a72d0` L149250 |
| round-start banner | "STARTING ROUND %d OF %d" (%d = `mp_round_count` + 1, `mp_max_rounds`), scale 0.9 (`0x3f666666`, x 1.1429 in the window), centred, colour 0, the window's 7 s | `FUN_001fb420` L57633-57649 |
| help lines reset | the death/spectator lines' timer (`+0x1a0e8`) zeroed at round start | L57663 |
| lobby countdown | "GAME STARTS IN" n "SECONDS" (UIMnLOC 354-355); host may "Launch all players, ready or not" (359) | UIMnLOC |
| fade, second message | fade from black and "OBJECTIVE:" 5 s later | research 87 §8 (`A_ready021-034`) |

At match end (`FUN_00223970`, the MP exit state): stats folded into the match block, the three message windows cleared (L76084-76086); the stats upload `FUN_00225a00`/`FUN_00225070` runs only when respawn is off and not a ladder game (L76078-76082); in state 6 the timers reset and the lobby returns (L76134-76144). `A_rend050`'s "ROUND COMPLETE" screen (research 87 §12) is the round end, not in this capture. SUPPRESSION objective (mp51LOC 5100, research 87 §8): "ELIMINATE THE TERRORISTS" for the SEALs; what ends a SUPPRESSION round is a placeholder (§16).

## 10. Kill messages (the message window)

Posted by `FUN_00547860` (L412845, from `FUN_00547aa0` L412997) and `FUN_00547a90` (L412920, the cause set first), online only, into the main window `0x4366a0` at scale 0.9, colour 0 (128,128,128 a100), not centred (`FUN_002b6530(0,0x4366a0,text,0,0,0)` L412893, L412970). Victim `+0xfbc` = killer id (0xff: nothing posted), `+0xfc0` = cause (weapon id, or 0xfd = a fall; 0 or less: nothing posted).

| format (address) | when | arguments | citation |
|---|---|---|---|
| `"%s falls to their death"` (0x65c440) | cause 0xfd | the killer's name, i.e. the local player who fell | L412879-412880 |
| `"%s commits suicide with %s"` (0x65c460) | killer == victim, any weapon | victim name, weapon name | L412882-412885 |
| `"%s fragged %s with %s"` (0x65c480) | any other killer: enemy and team kills alike | killer, victim, weapon | L412887-412891 |
| (none) | escortee/VIP killed (`+200 & 0x20000`): auto comm 0x44 instead | -- | L412905-412907 |

- Weapon name = `FUN_003d19a0(id)` (L324284): 0xfd -> `"falling damage"` (0x3fd520); else the ZWEAPON record whose
  `+0x7c` id matches, its `DisplayName` (record `+8`, `FUN_003d2b30` in `FUN_003cda30` L322168); no match -> `"Unknown
  Weapon"` (0x3fc548, `FUN_003c4b90` L316452). DisplayName differs from the kit name for: Spas 12 "TA 12 GAUGE", 870
  "12 GAUGE PUMP", JACKHAMMER "M3 12 GAUGE", P228 "M11", SR-1 Gyurza "SP-10", F2000 "OICW", SA-80 A2 "IW-80 A2", KBP
  OTs-14 Groza "RA-14", Steyr Aug "STG 77", MP5K "HK5K", Dragunov "SASR", LAW "AT-4", Double Ammo Load "2X AMMO"; the
  rest print as named (M4A1, 552, M67, HE, AN-M8, Claymore, "PMN Mine", C4 ...).
- No headshot, grenade-specific or team-kill wording exists; no "killed" format string (research 87 §1.18).
- After the line, for a victim other than the local player: an automatic radio comm, 0x27 said by the killer when the
  victim is not on the local player's team, else 0x28 said by the victim (`FUN_005e7f20` L412898-412903) [text not
  traced; candidates HudCLOC 60555 "%s : Enemy Killed" / 60556 "%s : Man down"].
- The dead player's own screen (offline only, `FUN_001f93c0` L56900-56976): "KILLED BY" (HudCLOC 60495) and the killer's
  name upper-cased, centred at y 25 and 25 + the line step. HudCLOC 60490-60494 ("YOU COMMITTED SUICIDE", "YOU WERE
  KILLED BY $1s WITH $2s" ...) have no reader by id (searched `0xec4a`-`0xec4e`).

## 11. Scoreboard (beyond research 87 §12)

| item | value | citation |
|---|---|---|
| rows per team | at most 8; excludes spectators, players with no name (`+0x14` = 0) and `+0xfd1` set [ghosts, inferred] | `FUN_0022de60` L80575-80620 |
| sort | score (`+0x580` + `+0x5c8`) descending, selection sort; ties keep list (join) order (strict `<`) | `FUN_00229d00` L78910-78941, L78929 |
| grouping | SEALs block on top (y0 104), TERRORISTS below (y0 267) | 87 §12; `FUN_0022cc10` L80018-80020 |
| dead rows | a player without `+0xe1` bit 4 has both colours x 0.6 (`0x3f19999a`), confirming 87's inference | `FUN_0022a290` L79022-79024 |
| spectator list | online: up to 8 spectator names, each cut with "-" to column width - 24 | `FUN_0022cc10` L80025-80062 |
| game details | type word by `+0x111`: 1 BREACH ... 5 SUPPRESSION (0x3e5828-0x3e5850) | L79741-79760 |
| rebuilt | every 1.0 s while SELECT is held (87 §12) | L79866 |
| console frame | none in the capture | -- |

## 12. Spectator and the help lines

The 6 help lines (x 324, baseline 380 + 18i, research 87 §1.18) are chosen by `FUN_001f7ff0` (L56515): local alive and viewing self: hidden; viewing someone else: `FUN_001f9f20`; dead offline: `FUN_001f93c0` (KILLED BY); dead online and not a spectator: viewing self `FUN_001f97b0`, else `FUN_001f9f20`; spectator: `FUN_001f9160` (L56563-56600). They hold 10.0 s, then fade to 0 over 0.5 s (L56544-56561). `%c` is a pad glyph: 0xa6 = X (Default config), 0xb7 the Sure Shot alternative; 0xbd/0xbe the Inventory button (R2 in Default; HudCLOC 60488 says "R2"). Strings with a glyph inside are cut in the strings dump at the glyph; the leading text of those is unrecovered.

| state | lines (address) | citation |
|---|---|---|
| dead, respawn off | "You have died.  %c Select new weapons." (0x3e32e0); 0x3e3350 "...<glyph> directional buttons" + "to cycle through living teammates" (0x3e3380) | `FUN_001f97b0` L57000-57007 |
| dead, respawn on | line 1 as above; line 2 after 5.0 s dead: "Press the %c button to respawn." (0x3e3310 X / 0x3e3330 alt), alpha 100 | L57008-57030 |
| ghost (late joiner) | "You are a ghost.  You will play the next" / "round as a real player.  %c Select new" (0x3e31c0/0x3e31f0), then "weapons." or, respawn on and 5 s past, "Press the %c button to respawn." (0x3e3220; 0x3e3240 "weapons. Press the %c button to respawn." when the line fits) | L57047-57097 |
| viewing a teammate | 0x3e3430 / "directional buttons to cycle through" (0x3e3450) / "living teammates." (0x3e3410); ghost variant 0x3e33b0/0x3e33e0 | `FUN_001f9f20` L57146-57165 |
| spectator | "You are a spectator.  Use the directional" (0x3e30f0), "buttons to cycle through active players" (0x3e3120), 0x3e3150 "...<glyph> Use the Free-Motion", 0x3e3180 "...<glyph> Jump to visible players." | `FUN_001f9160` L56869-56872 |

Spectator camera (`FUN_00295260` L139448): three modes in its byte 0: 0 follow a player, 1 free (the camera takes the local player, mode 6), 2 the map's scenic views (`FUN_002ab260` over `mission.rdr`'s `Scenic_Views`). Pad bytes +5 / +6 step the scenic view +1 / -1 (L139520, L139558); +10 toggles follow <-> free/scenic (L139477-139516); +7 "jump to visible player" = `FUN_00294f40` (L139348): the non-spectator nearest the view's centre line, preferring the nearer within 10 %. The dead (non-spectator) cycle only living teammates. Which physical buttons bytes +5/+6/+7/+10 are: `SPECTATOR_PAD_PLACEHOLDER`.

## 13. Player names

| value | meaning | citation |
|---|---|---|
| lobby name field | 32 bytes at record `+0xe` (`+0xe..+0x2d`) | `FUN_002c5450` L166266-166280 |
| in-game name | copied with a 0x1f limit into a 30-byte buffer, byte 30 zeroed: at most 30 characters kept | `FUN_005442c0` L410582-410590 |
| clan tag | 16 bytes at `+0x2e`, byte 15 zeroed: at most 15 characters; drawn "[clan]" on the scoreboard | L166284-166293; 87 §12 |
| blank / unset name | `PLAYERNAMEVAR` missing -> `"Player%d"` with the network index (0x3f2ab0, 0x65c310); the create path defaults to "Player" (0x3f25b8) | L166268-166271; L410582-410585; L159304-159309 |
| keyboard | on-screen: printable ASCII ``~!@#$%^&*()_+`1234567890-=[]\;',./qwerty..`` plus a TEAM key and an accented page (`äèî`) | frame `A_37_namekbd` |
| duplicates | resolved by the server: "already logged in" (UIMnLOC 543), "questionable content" (544), game names "already in use" (294) | UIMnLOC |
| entry-box length limit | not found (the screen's `.rdr` is in `READERX.ZAR`/`run/ui`, not in this disc subset); use 30 | `NAME_MAXLEN_PLACEHOLDER` |

## 14. Character types and default kits per map

Each map's `READERM.ZAR/chartype.rdr` lists four `navyseals` (Seal1-4), four `terrorists` (Terrorist1-4) and up to three `escortees`; `character.rdr` (READERC) resolves each through its base chain (`mpN_sealK : mp_sealK : mp_seal`, `mpN_terrorK : mp_terrorK_<region> : mp_terror`) to a `model_name` and `default_weapons` in slot order primary, secondary, then three equipment slots. Players pick SEAL 1-4 / TERRORIST 1-4 in the lobby ARMORY (UIMnLOC 6-14, 30-37) and may change the kit there; up to 8 players share 4 types. The type a player gets without choosing: `DEFAULT_CHARTYPE_PLACEHOLDER`. The name-to-type lookup is `FUN_0053b4b0` (L405168; `chartype.rdr` `navyseals`/`terrorists`/`escortees`). Weapons the map allows each side: `mission.rdr` `Valves` `Enable_<weapon>` 1 SEAL, 8 Terrorist, 9 both, 0 none. Kit patterns across maps: SEAL 1 M4A1 + Mark 23 + M67/HE/AN-M8 + Double Ammo Load or C4; SEAL 2 870 + Mark 23 (226 on MP7); SEAL 3 HK5 + Mark 23 (Groza + SR-1 on MP81-83); SEAL 4 SR-25 + Mark 23 + Claymore (MP5K/P228, M63A, SA-80/P228, AK-105/SR-1 on the 5x-8x maps). Terrorist 1 552 + M9 (M82A1A + Model 18 on MP62); 2 Spas 12 + DE .50 (F57/M9 variants) + PMN; 3 F90 + F57 (Model 18/DE .50); 4 M82A1A + Model 18 (Steyr Aug, AK-47 + DE .50, 552SD + DE .50 variants).

### MP1 Blizzard (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp1_seal1 (`seal_A_arc`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp1_terror1 (`al_arctic02`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp1_seal2 (`seal_E_arctic`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp1_terror2 (`al_gman01`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp1_seal3 (`seal_A_arc`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp1_terror3 (`al_kola`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp1_seal4 (`seal_A_arc`) | SR-25 / Mark 23 / M67, Claymore, AN-M8 | mp1_terror4 (`al_gman02`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP2 Frostfire (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp2_seal1 (`seal_A_scuba`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp2_terror1 (`al_gman01`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp2_seal2 (`seal_E_scuba`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp2_terror2 (`al_gman02`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp2_seal3 (`seal_D_scuba`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp2_terror3 (`al_leader`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp2_seal4 (`seal_C_scuba`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp2_terror4 (`al_captain`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP5 Abandoned (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp5_seal1 (`seal_A`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp5_terror1 (`thai_terrorist02`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp5_seal2 (`seal_E_jungle_flak`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp5_terror2 (`thai_terrorist01`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp5_seal3 (`seal_C`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp5_terror3 (`thai_adv02`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp5_seal4 (`seal_D`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp5_terror4 (`thai_leader`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP6 Desert Glory (EXTRACTION) -- escortees: mp_fem1 (`thai_biologist01`), mp_fem2 (`thai_biologist02`), mp_fem3 (`thai_wife`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp6_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, HE, C4 | mp6_terror1 (`afg_taliban03_mp`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp6_seal2 (`seal_E_desert_flak`) | 870 / Mark 23 / Double Ammo Load, AN-M8, C4 | mp6_terror2 (`afg_ter02_mp`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp6_seal3 (`seal_C_des_flak`) | HK5 / Mark 23 / M67, HE, C4 | mp6_terror3 (`afg_taliban04_mp`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp6_seal4 (`seal_D_des`) | SR-25 / 226 / M67, Claymore, C4 | mp6_terror4 (`afg_taliban05_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP7 Night Stalker (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp7_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp7_terror1 (`afg_taliban03_mp`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp7_seal2 (`seal_E_desert_flak`) | 870 / 226 / M67, AN-M8, Double Ammo Load | mp7_terror2 (`afg_ter02_mp`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp7_seal3 (`seal_C_des_flak`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp7_terror3 (`afg_taliban04_mp`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp7_seal4 (`seal_D_des`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp7_terror4 (`afg_taliban05_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP8 Rat'S Nest (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp8_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp8_terror1 (`afg_taliban03_mp`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp8_seal2 (`seal_E_desert_flak`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp8_terror2 (`afg_ter02_mp`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp8_seal3 (`seal_C_des_flak`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp8_terror3 (`afg_taliban04_mp`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp8_seal4 (`seal_D_des`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp8_terror4 (`afg_taliban05_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP9 Bitter Jungle (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp9_seal1 (`seal_A`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp9_terror1 (`con_merc03`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp9_seal2 (`seal_E_jungle_flak`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp9_terror2 (`con_cook`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp9_seal3 (`seal_C`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp9_terror3 (`con_leader`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp9_seal4 (`seal_D`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp9_terror4 (`con_torturer_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP10 Blood Lake (EXTRACTION) -- escortees: mp_pow1 (`con_pow01`), mp_pow2 (`con_pow02`), mp_pow3 (`con_pow01`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp10_seal1 (`seal_A`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp10_terror1 (`con_merc03`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp10_seal2 (`seal_E_jungle_flak`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp10_terror2 (`con_cook`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp10_seal3 (`seal_C`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp10_terror3 (`con_leader`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp10_seal4 (`seal_D`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp10_terror4 (`con_torturer_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP11 Death Trap (EXTRACTION) -- escortees: mp_pow1 (`con_pow01`), mp_pow2 (`con_pow02`), mp_pow3 (`con_pow01`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp11_seal1 (`seal_A`) | M4A1 / Mark 23 / M67, HE, C4 | mp11_terror1 (`con_merc03`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp11_seal2 (`seal_E_jungle_flak`) | 870 / Mark 23 / HE, Double Ammo Load, C4 | mp11_terror2 (`con_cook`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp11_seal3 (`seal_C`) | HK5 / Mark 23 / M67, HE, C4 | mp11_terror3 (`con_leader`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp11_seal4 (`seal_D`) | SR-25 / Mark 23 / M67, Claymore, C4 | mp11_terror4 (`con_torturer_mp`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP12 The Ruins (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp12_seal1 (`seal_A`) | M4A1 / Mark 23 / M67, HE, Double Ammo Load | mp12_terror1 (`thai_terrorist02`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp12_seal2 (`seal_E_jungle_flak`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp12_terror2 (`thai_terrorist01`) | Spas 12 / DE .50 / M67, AN-M8, PMN Mine |
| 3 | mp12_seal3 (`seal_C`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp12_terror3 (`thai_adv02`) | F90 / F57 / M67, HE, PMN Mine |
| 4 | mp12_seal4 (`seal_D`) | SR-25 / Mark 23 / M67, Claymore, Double Ammo Load | mp12_terror4 (`thai_leader`) | M82A1A / Model 18 / M67, PMN Mine, HE |
### MP51 Vigilance (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp51_seal1 (`seal_B_woodland`) | M4A1 / Mark 23 / AN-M8, Double Ammo Load, C4 | mp51_terror1 (`alban_Castrioti`) | 552 / M9 / M67, Double Ammo Load, C4 |
| 2 | mp51_seal2 (`seal_E_woodland`) | 870 / Mark 23 / M67, Double Ammo Load, C4 | mp51_terror2 (`alban_foreman`) | Spas 12 / F57 / HE, PMN Mine, C4 |
| 3 | mp51_seal3 (`seal_C_woodland`) | HK5 / Mark 23 / HE, Double Ammo Load, C4 | mp51_terror3 (`alban_Rugova`) | F90 / Model 18 / M67, PMN Mine, C4 |
| 4 | mp51_seal4 (`SAS_01`) | MP5K / P228 / M67, Claymore, C4 | mp51_terror4 (`alban_Pius`) | Steyr Aug / Model 18 / M67, PMN Mine, C4 |
### MP52 The Mixer (ESCORT) -- escortees: mp_algerian_h1 (`alg_UN01`), mp_algerian_h2 (`alg_UN02`), mp_algerian_h3 (`alg_UNworker`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp52_seal1 (`seal_B_woodland`) | M4A1 / Mark 23 / AN-M8, M67, Double Ammo Load | mp52_terror1 (`alban_Castrioti`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp52_seal2 (`seal_E_woodland`) | 870 / Mark 23 / M67, HE, Double Ammo Load | mp52_terror2 (`alban_foreman`) | Spas 12 / F57 / HE, PMN Mine, Double Ammo Load |
| 3 | mp52_seal3 (`seal_C_woodland`) | HK5 / Mark 23 / AN-M8, HE, Double Ammo Load | mp52_terror3 (`alban_Rugova`) | F90 / Model 18 / M67, PMN Mine, Double Ammo Load |
| 4 | mp52_seal4 (`SAS_01`) | MP5K / P228 / M67, Claymore, Double Ammo Load | mp52_terror4 (`alban_Pius`) | Steyr Aug / Model 18 / M67, PMN Mine, Double Ammo Load |
### MP53 Foxhunt (ESCORT) -- escortees: mp_algerian_h1 (`alg_UN01`), mp_algerian_h2 (`alg_UN02`), mp_algerian_h3 (`alg_UNworker`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp53_seal1 (`seal_B_woodland_LO`) | M4A1 / Mark 23 / M67, AN-M8, Double Ammo Load | mp53_terror1 (`alban_Castrioti`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp53_seal2 (`seal_E_woodland_LO`) | 870 / Mark 23 / M67, HE, Double Ammo Load | mp53_terror2 (`alban_foreman`) | Spas 12 / F57 / M67, HE, PMN Mine |
| 3 | mp53_seal3 (`seal_C_woodland_LO`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp53_terror3 (`alban_Rugova`) | F90 / Model 18 / M67, PMN Mine, HE |
| 4 | mp53_seal4 (`SAS_01`) | MP5K / P228 / M67, Claymore, Double Ammo Load | mp53_terror4 (`alban_Pius`) | Steyr Aug / Model 18 / M67, HE, PMN Mine |
### MP61 Sujo (BREACH)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp61_seal1 (`seal_A_tiger_jungle`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp61_terror1 (`braz_ter02`) | 552 / Model 18 / M67, PMN Mine, Double Ammo Load |
| 2 | mp61_seal2 (`seal_E_tiger_jungle`) | 870 / Mark 23 / M67, Double Ammo Load, C4 | mp61_terror2 (`braz_Lucimar`) | Spas 12 / M9 / M67, HE, Double Ammo Load |
| 3 | mp61_seal3 (`seal_C_tiger_jungle`) | HK5 / Mark 23 / M67, Double Ammo Load, C4 | mp61_terror3 (`braz_butcher`) | F90 / DE .50 / M67, HE, Double Ammo Load |
| 4 | mp61_seal4 (`seal_Marcela`) | M63A / Mark 23 / M67, HE, C4 | mp61_terror4 (`braz_leader`) | AK-47 / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP62 Enowapi (BREACH)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp62_seal1 (`seal_A_tiger_jungle`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp62_terror1 (`braz_ter02`) | M82A1A / Model 18 / M67, PMN Mine, Double Ammo Load |
| 2 | mp62_seal2 (`seal_E_tiger_jungle`) | 870 / Mark 23 / M67, Double Ammo Load, C4 | mp62_terror2 (`braz_Lucimar`) | Spas 12 / M9 / M67, HE, Double Ammo Load |
| 3 | mp62_seal3 (`seal_C_tiger_jungle`) | HK5 / Mark 23 / M67, Double Ammo Load, C4 | mp62_terror3 (`braz_butcher`) | F90 / DE .50 / M67, HE, Double Ammo Load |
| 4 | mp62_seal4 (`seal_Marcela`) | M63A / Mark 23 / M67, Double Ammo Load, C4 | mp62_terror4 (`braz_leader`) | AK-47 / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP64 Shadow Falls (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp64_seal1 (`seal_A_tiger_jungle`) | M4A1 / Mark 23 / M67, AN-M8, Double Ammo Load | mp64_terror1 (`braz_ter02`) | 552 / Model 18 / M67, PMN Mine, Double Ammo Load |
| 2 | mp64_seal2 (`seal_E_tiger_jungle`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp64_terror2 (`braz_Lucimar`) | Spas 12 / M9 / M67, HE, Double Ammo Load |
| 3 | mp64_seal3 (`seal_C_tiger_jungle`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp64_terror3 (`braz_butcher`) | F90 / DE .50 / M67, HE, Double Ammo Load |
| 4 | mp64_seal4 (`seal_Marcela`) | M63A / Mark 23 / M67, HE, Double Ammo Load | mp64_terror4 (`braz_leader`) | AK-47 / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP71 Fish Hook (EXTRACTION) -- escortees: mp_algerian_h1 (`alg_UN01`), mp_algerian_h2 (`alg_UN02`), mp_algerian_h3 (`alg_UNworker`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp71_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp71_terror1 (`alg_ter01`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp71_seal2 (`seal_E_desert_flak`) | 870 / Mark 23 / AN-M8, Double Ammo Load, C4 | mp71_terror2 (`alg_ter03`) | Spas 12 / DE .50 / M67, HE, Double Ammo Load |
| 3 | mp71_seal3 (`seal_D_des_flak`) | HK5 / Mark 23 / M67, HE, C4 | mp71_terror3 (`alg_ter02`) | F90 / F57 / M67, HE, Double Ammo Load |
| 4 | mp71_seal4 (`SAS_01`) | SA-80 A2 / P228 / M67, Claymore, C4 | mp71_terror4 (`alg_officer`) | 552SD / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP72 Crossroads (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp72_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, AN-M8, Double Ammo Load | mp72_terror1 (`alg_ter01`) | 552 / M9 / M67, HE, PMN Mine |
| 2 | mp72_seal2 (`seal_E_desert_flak`) | 870 / Mark 23 / AN-M8, Double Ammo Load, HE | mp72_terror2 (`alg_ter03`) | Spas 12 / DE .50 / M67, HE, Double Ammo Load |
| 3 | mp72_seal3 (`seal_D_des_flak`) | HK5 / Mark 23 / M67, HE, Double Ammo Load | mp72_terror3 (`alg_ter02`) | F90 / F57 / M67, HE, Double Ammo Load |
| 4 | mp72_seal4 (`SAS_01`) | SA-80 A2 / P228 / M67, Claymore, HE | mp72_terror4 (`alg_officer`) | 552SD / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP73 Sandstorm (BREACH)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp73_seal1 (`seal_A_des`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp73_terror1 (`alg_ter01`) | 552 / M9 / M67, PMN Mine, Double Ammo Load |
| 2 | mp73_seal2 (`seal_E_desert_flak`) | 870 / Mark 23 / AN-M8, Double Ammo Load, C4 | mp73_terror2 (`alg_ter03`) | Spas 12 / DE .50 / M67, HE, Double Ammo Load |
| 3 | mp73_seal3 (`seal_D_des_flak`) | HK5 / Mark 23 / M67, HE, C4 | mp73_terror3 (`alg_ter02`) | F90 / F57 / M67, HE, Double Ammo Load |
| 4 | mp73_seal4 (`SAS_01`) | SA-80 A2 / P228 / M67, Claymore, C4 | mp73_terror4 (`alg_officer`) | 552SD / DE .50 / M67, PMN Mine, Double Ammo Load |
### MP81 Chain Reaction (SUPPRESSION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp81_seal1 (`seal_A_scuba`) | M4A1 / Mark 23 / M67, AN-M8, Double Ammo Load | mp81_terror1 (`rus_snowter01`) | 552 / M9 / M67, HE, Double Ammo Load |
| 2 | mp81_seal2 (`seal_E_scuba`) | 870 / Mark 23 / M67, AN-M8, Double Ammo Load | mp81_terror2 (`rus_snowter03`) | Spas 12 / DE .50 / M67, HE, Double Ammo Load |
| 3 | mp81_seal3 (`Spetsnaz`) | KBP OTs-14 Groza / SR-1 Gyurza / M67, HE, Double Ammo Load | mp81_terror3 (`rus_ter01`) | F90 / F57 / M67, HE, Double Ammo Load |
| 4 | mp81_seal4 (`rus_specialist`) | AK-105 / SR-1 Gyurza / M67, Claymore, Double Ammo Load | mp81_terror4 (`rus_Valeska`) | Steyr Aug / Model 18 / M67, PMN Mine, Double Ammo Load |
### MP82 Guidance (ESCORT) -- escortees: mp_vip1 (`rus_escort01`), mp_vip2 (`rus_escort03`), mp_vip3 (`rus_escort03`)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp82_seal1 (`seal_A_arc`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp82_terror1 (`rus_snowter01`) | 552 / M9 / M67, PMN Mine, Double Ammo Load |
| 2 | mp82_seal2 (`seal_E_arctic`) | 870 / Mark 23 / M67, Double Ammo Load, C4 | mp82_terror2 (`rus_snowter03`) | Spas 12 / DE .50 / M67, HE, Double Ammo Load |
| 3 | mp82_seal3 (`Spetsnaz`) | KBP OTs-14 Groza / SR-1 Gyurza / M67, HE, C4 | mp82_terror3 (`rus_ter01`) | F90 / F57 / M67, HE, Double Ammo Load |
| 4 | mp82_seal4 (`rus_specialist`) | AK-105 / SR-1 Gyurza / M67, Claymore, C4 | mp82_terror4 (`rus_Valeska`) | Steyr Aug / Model 18 / M67, PMN Mine, Double Ammo Load |
### MP83 Requiem (DEMOLITION)
| slot | SEAL type (`model`) | SEAL kit: primary / secondary / equipment | Terrorist type (`model`) | Terrorist kit |
|---|---|---|---|---|
| 1 | mp83_seal1 (`seal_A_arc`) | M4A1 / Mark 23 / M67, AN-M8, C4 | mp83_terror1 (`rus_snowter01`) | 552 / M9 / M67, PMN Mine, C4 |
| 2 | mp83_seal2 (`seal_E_arctic`) | 870 / Mark 23 / M67, Double Ammo Load, C4 | mp83_terror2 (`rus_snowter03`) | Spas 12 / DE .50 / M67, Double Ammo Load, C4 |
| 3 | mp83_seal3 (`Spetsnaz`) | KBP OTs-14 Groza / SR-1 Gyurza / M67, HE, C4 | mp83_terror3 (`rus_ter01`) | F90 / F57 / M67, HE, C4 |
| 4 | mp83_seal4 (`rus_specialist`) | AK-105 / SR-1 Gyurza / M67, Claymore, C4 | mp83_terror4 (`rus_Valeska`) | Steyr Aug / Model 18 / M67, PMN Mine, C4 |

## 15. The original's network authority (who decided hits)

| function | role | mode |
|---|---|---|
| `FUN_005abbc0` | round hits actor -> part; in MP only for rounds flagged local (`proj+4` bit 2) | both; MP guard L464698 |
| `FUN_005a5a80` L461552 | MP: sends `FUN_005a1ff0` -> `FUN_002bbda0` msg 0x40 (dmg byte, piercing x20, shooter, victim, part 4 bits); applies locally only if victim is local | MP |
| `FUN_005a1b80` L459488 (from L160838) | receiver: applies the message's damage (pellets for shotguns) | MP |
| `FUN_002be150` L162326-162346 | receiver of part-health sync (6 bytes /255) | MP |
| `FUN_005ac070`, `FUN_005ac1f0` | explosion / fall damage, victim-local | both |
| `FUN_00592560`, `FUN_00598b90`, `FUN_00599b60`, `FUN_002b8100`, `FUN_002b7ee0`, `FUN_001f97b0` | MP death wait, respawn, spawn pick, prompt | MP respawn |
| `FUN_005994a0` L455401 | SP restart at a checkpoint | SP |
| `FUN_005a0950` TEAMMATE_* death lists, `FUN_005a33b0` groans | | SP |

Bullets are resolved on the shooter's console and sent as a damage message; explosions and falls on the victim's;
score and death counts on the local player's own console (§8). For the server: compute §1.1 once on the server, keep
`(part, damage, piercing)` as the message, apply §1.4 and §3 there, and broadcast part health; this replaces the
shooter/victim split above.

## 16. Placeholders

Neither note could read `.data` (no ELF). Deduplicated from both notes.

| name | stands for / searched | status |
|---|---|---|
| `RESPAWN_POINT_PLACEHOLDER` (91b) | where a respawned player is placed; searched `FUN_00598b90`, `FUN_00599b60` (copies the old matrix), strings "respawn", "respawn_setup" (0x65b0e8, an AI script key), "on_respawn" (AI); `PlayerStart`/`spectator` readers not traced | resolved by 91a: `FUN_002b7ee0` farthest-from-nearest-enemy on flag-bit-4 `AIMAPS.MPS` records (§4.2) |
| `FRIENDLY_FIRE_DEFAULT_PLACEHOLDER` (91a) | host-menu default; searched writers of `0x3f2860`/`0x3f5940`/`0x3f6230`/`0x3f1220` (only copies from the settings struct, `FUN_002e34d0` L197221) | resolved by 91b: the create-game screen reads "Friendly Fire is disabled." (`A_49_creategame`) |
| `RESPAWN_OPTION_DEFAULT_PLACEHOLDER` (91a) | as above for respawn | resolved by 91b: "Respawn is disabled." (`A_49`, UIMnLOC 249-250) |
| `RESPAWN_WAIT_CAMERA_PLACEHOLDER` (91a) | camera during the respawn wait (no call in `FUN_005979a0`) | partly: 91b says with respawn off the dead spectate (L454484-454487); respawn on still unknown |
| `LIMB_SPILL_SCALE_PLACEHOLDER` / `LIMB_SPILL_PIERCING_PLACEHOLDER` (91a) | `DAT_006508a8` / `DAT_006508b0`, `.data`; read from `socom2_game.elf` at those addresses | open |
| `FRAGMENT_PART_TABLE_PLACEHOLDER` (91a) | `DAT_006508e0` 6 thresholds, `DAT_006508d0` 6 parts; receiver's copy `DAT_00650900`/`DAT_006508f8`; `.data` | open |
| `SHOTGUN_PELLET_RANGE_SQ_PLACEHOLDER` (91a) | `DAT_006508b8` SP, `DAT_006508c0` MP 8 pellets, `DAT_006508c8` MP 4; `.data` | open |
| `FRIENDLY_FIRE_ENFORCEMENT_PLACEHOLDER` (91a) | searched `DAT_0044cdb8`/`44cdb8`, team-mask tests (`+200 & +200`) in L455000-466000, `FUN_005abbc0`, `FUN_005a5a80`, `FUN_005a1b80`; reCOM has no friendly-fire code. Next: the net receive of msg 0x40 before `FUN_005a1b80` (L160800-160840) | open |
| `HEAD_NODE_NAMES_PLACEHOLDER` (91a) | strings at 0x65c4f8/0x65c500/0x65c508 under the strings dump's length cut; inferred `hips`, `head`, `neck` from research 78's skeleton | open (inferred) |
| `DEATH_SOUND_IDS_PLACEHOLDER` (91a) | 0x3c/0x3d not mapped to `CHRSND_*` names | open |
| `RESPAWN_BUTTON_PLACEHOLDER` (91a) | `FUN_002c64e0(0,pad)` state 1; glyphs 0xa6/0xb7 not decoded | partly: 91b maps pad result 0 to `Action` (X in Default config) |
| `NET_DAMAGE_CLAMP_PLACEHOLDER` (91a) | `FUN_002bd220` bounds `DAT_003de728..750` | open |
| `STUN_EFFECT_PLACEHOLDER`, `RECOVERY_FACTOR_PLACEHOLDER` (91a) | readers of ammo `+0x10` and char `+0x2f8` not traced | open |
| `DOUBLE_AMMO_LOAD_PLACEHOLDER` (91a) | item 194: effect on the kit's magazines not traced | open |
| `MP_PENALTY_PLACEHOLDER` (91a) | `mp_penalty` (0x3f1140) created and zeroed (L149589); game-script use not read | open |
| `SPECTATOR_PAD_PLACEHOLDER` (91b) | buttons behind pad bytes +5, +6, +7, +10; searched `FUN_00295260`, `controller.rdr` (no spectator mappings); help-string glyphs cut | open |
| `NAME_MAXLEN_PLACEHOLDER` (91b) | the name keyboard's own limit; searched UIMnLOC/`UIXLOC`/`UIMPXLOC`, "maxlength" (only `messages.rdr`'s); buffers give 30 (name) and 15 (clan) | open (use 30) |
| `DEFAULT_CHARTYPE_PLACEHOLDER` (91b) | the type a player gets without choosing; searched `FUN_0053b4b0`, `UiCharType` (SP only, `FUN_002af8c0`), team slot `+0x3e` (0-7, no link found) | open |
| `MATCH_WIN_COMPARE_PLACEHOLDER` (91b) | the test "round wins >= `mp_half_rounds`" and who sets `mp_game_over`, `mp_score00/08`, `mp_winner`; searched refs of 0x3f0fd8/0x3f0fe8/0x3f0ff8/0x3f0f88 (only reads and resets), "= 8" valve writes, type-5 branches | open |
| `SUPPRESSION_ROUND_END_PLACEHOLDER` (91b) | what ends a SUPPRESSION round (elimination, clock) and which side wins on time; `mp_45_sec_clock`, `mp_x_sec_clock` created only (L149578-149586) | open |
| `AUTOCOMM_TEXT_PLACEHOLDER` (91b) | text of comms 0x27/0x28/0x44; searched `FUN_005e7f20`; HudCLOC 60555-60561 candidates | open |
| `GHOST_ROW_PLACEHOLDER` (91b) | that `+0xfd1` (rows hidden from the scoreboard) is the ghost flag; `FUN_0022de60` L80608; `FUN_00223970` L76148 copies `+0xfd1` to `+0xfd2` | open (91a's `+0xd2` bit 0x10000 ghost test is a related but different field) |
