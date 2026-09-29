# 77 — The skeletal motion format (`MOTION_S.ZAR`, `MOTION_P.ZAR`) and the zAnim command archives

**Status: read from the disc, 2026-09-28, web sprint 2 task W2.2a.**

- Every field below was read with `web/redotcom/tools/dump-motion.ts`. It is held by `web/redotcom/packages/scene/src/motion.ts` and
  `zanim.ts`, whose tests pin it on:
  - Frostfire's fixture;
  - all 22 maps;
  - the owner's `RUN/MOTION_P.ZAR`, the player's 334 clips, handed over mid-task.
- The layout was settled on the seven victory clips first. The reader written against them then read all 334
  player clips unchanged.
- Of the decomp bodies, only `zAnimObjectMotionBegin` bears on this. §11 reads it: it is zAnim's object-motion
  command, not the clip sampler, and it settles nothing in the clip format.

Each claim is marked:
- **[shown]**: read from the bytes on more than one clip, and held by a test;
- **[inference]**: reasoned from the bytes and a named source, not shown directly;
- **[unknown]**: not decoded; the reader skips it or passes it through raw.

Sources:
- the 22 map archives: `RUN/MP*.ZDB` members `RUN\MP\MPn\MOTION_S.ZAR`, `RUN\CZANIM.ZAR`, `RUN\MP\MPn\MZANIM.ZAR`,
  `RUN\LDZANIM.ZAR`, and `CLIB_GEO.ZED` for the bind skeleton;
- the owner's `RUN/MOTION_P.ZAR` and `RUN/READERC.ZAR` (`motion.rdr`);
- docs/research/25 (§2 and §8: the player's motion pack as it sits in memory);
- docs/research/50 and reCOM `zSeal/zseal.h:534-558` (the body parts);
- reCOM `zAnim/zanim.h` and `anim_main.cpp`;
- `recomp/socom2_names.csv`, for names;
- the decomp `zAnimObjectMotionBegin_0x262690` and `CZSealBody_Tick_0_0x57a330` (the handoff, reference only).

Commands: `npx tsx tools/dump-motion.ts [MPn] [--hex] [--strings] [--all] [--zanim [--names]] [--pack [clip ...]]`.

---

## 1. Where the motions are

- **Every map archive carries the same seven clips [shown].** Each `MOTION_S.ZAR` is 237,668 B and holds
  `victory_backflip`, `victory_break`, `victory_chicken`, `victory_face`, `victory_funky`, `victory_macarena` and
  `victory_rodeo`.
  - Across the 22 maps, each clip's head, names and tracks are byte-identical (one payload SHA-1 per clip, 22 of 22).
  - Only the 16-byte object records differ between maps (§3).
- **The player's pack [shown].** `RUN/MOTION_P.ZAR` (1,856,512 B, 334 clips, §12) is a loose file on the disc, not
  a ZDB member.
- **A clip is one flat key [shown].** The key has no children. Its bytes are the whole clip, and the clip's name is
  the key's.
- **Per-clip play parameters are outside the clip [shown].** They are in `motion.rdr` in `RUN/READERC.ZAR` (§7).

## 2. The clip head (0x20 bytes)

| off | type | value | meaning |
|---|---|---|---|
| 0x00 | u32 | 5 on all 341 clips | version [shown]; the reader refuses any other |
| 0x04 | f32 | e.g. 5.1667 (backflip), 0.6333 (seal_run) | duration in seconds [shown]: frame count / 30 on all 341 |
| 0x08 | u32 | 1 … 205 | frame count *n* [shown] |
| 0x0c | u32 | 4 … 28 | part (track) count [shown] |
| 0x10 | f32 | −1.0 on all 341 | [unknown] |
| 0x14 | f32 | 1.0 on all 341 | [unknown] |
| 0x18 | u32 | 0x20 + 16 × count | name table offset [shown; the reader requires it] |
| 0x1c | u32 | the end of the name table | track data offset [shown; required] |

Backflip's head as stored: `00000005 40a55555 0000009b 0000001a bf800000 3f800000 000001c0 000002b0`.

## 3. The object records (16 bytes × count): the tool's memory, patched at load

- **The records are reCOM's `CZSIObject` (`zAnim/zanim.h:809-820`) [inference].**
  - The fields are `f32* m_positionData`, `CQuat* m_rotations`, a bitfield word (`m_inUse`, `m_constPos`,
    `m_constRot`, `m_body_part_id`) and `char* m_pName`.
  - The file holds the export tool's heap pointers, e.g. backflip's first record is `11cf2010 11c68450 00000000
    118fcbe0`.
  - The third word is uninitialised: 0 on some clips, `0x80100` or text-like `0x006f6670` on others.
- **What the pointer gaps show [shown].** The gap between a record's two pointers is (*n* + 1) × 12 + 8: 1880 on
  backflip, 1160 on break, 248 on `seal_run`. The tool held *n* + 1 float3 positions per part, plus an 8-byte
  allocator header.
- **What the loader does to them [shown, against research 25's console read].**
  - Research 25 §8.2 read the console's in-memory record for `seal_crouch_step`'s root as `00912cf4 00912cfc
    006f6677`. In the file the same record is `11cee240 11cee338 006f6670 11cee1e0`. So the loader (`CZSIObject_Read`
    0x289380, `Read(unsigned char*, unsigned int, const char*)`, names only):
    - points word 0 at the translation keys (record + 0x294);
    - points word 1 at the rotation keys (8 bytes on, because the translation is constant);
    - **ORs 0x07 into the tool's stale word**: `m_inUse`, `m_constPos` and `m_constRot` for a 0x3c track.
  - Research 25's "descriptor byte +8, bit 1 set: no root motion" is therefore `m_constPos`, the loader's copy of
    the track flag 0x20 (§5).
- **The reader skips these records [shown].** Its test fills them with garbage and gets the same clip.

## 4. The name table

- **Format [shown].** One NUL-terminated name per track, padded with `-` (0x2d) to four bytes:
  `skel_root\0--hips\0---aimnodes\0---spinelo\0…`.
- **The victory clips' 26, in track order [shown, the same on all seven]:** `skel_root hips aimnodes spinelo spinehi
  neck head lshoulder_wgt lscap rscap rshoulder_wgt rbicep rforearm rhand weapon lbicep lforearm lhand rthigh rcalf
  rfoot rtoe lthigh lcalf lfoot ltoe`.
- **These are `CZSealBody`'s 25 body parts plus the weapon [shown by the test].**
  - The 25 are `m_root` … `m_rtoe` (reCOM `zseal.h:534-558`; research 50's run of 25 constructor stores).
  - `m_root` is `skel_root`, and `weapon` is `m_weapon`.
- **The pack adds six prop parts [shown]:** `rifle`, `pistol`, `launcher`, `back`, `rifle_out` and `do_not_use`.
- **Clips may carry a subset [shown].** Part counts run 4, 7, 11, 14, 15, 16, 25, 26, 27 and 28, in 34 distinct
  sets (§12).
- **Parts are matched by name [inference].**
  - `CBody::FindPart` matches on the node name (reCOM `zBody/zbody.cpp:7-19`).
  - Every body-part name is a node of `seal_A_scuba` in `CLIB_GEO.ZED`.
  - The track order is not the model's node order, and varies between clips (e.g. `lbicep` right after `spinehi`
    in `civ_jog`).
  - **The clip carries no parent links; the hierarchy is the skeleton's.**

## 5. The tracks

**Track layout [shown].** Each track is a flag word, then its translation channel, then its rotation channel:

```
u32 flags                      0x0c | 0x10 (rotation constant) | 0x20 (translation constant)
translation: flags & 0x20 ? int16 x, y, z, lane4          (8 bytes)
                          : int16 x, y, z  x (n + 1) keys  (6 (n + 1) bytes, then zero-padded to 4)
rotation:    flags & 0x10 ? int16 x, y, z, w              (8 bytes)
                          : int16 x, y, z, w x (n + 1) keys
```

- **Flags [shown].** Only 0x0c, 0x1c, 0x2c and 0x3c occur, on all 341 clips. 0x0c is set on every track; what its
  two bits mean is [unknown]. The reader refuses any other value.
  - The victory clips share one pattern: `skel_root` 0x1c; `hips`, the shoulder weights, `rbicep`, `lbicep`,
    `weapon` 0x0c; the toes 0x3c; the rest 0x2c; `spinehi` 0x2c on three clips and 0x3c on four.
  - The pack's clips vary, e.g. `seal_crouch_step`'s root is 0x3c: it stands still.
- **The alignment pad [shown].** An odd key count leaves an animated translation two bytes short of 4. Chicken has
  one (*n* + 1 = 191), followed by `00 00`. Without the pad the stream reads garbage flags from the next track on.
- **Each channel closes on its first key [shown].** An animated channel stores *n* + 1 keys, and key *n* equals
  key 0. That holds for every animated channel of the seven victory clips and all 7,309 of the pack. It includes the
  one-shot clips, e.g. `seal_jump`, `looped (0)`, so it is the format's, not a loop property.
- **No other compression [shown].** There is no keyframe reduction, curve or delta coding. The only savings are
  int16 fixed point and a constant channel stored once.
- **The constant translation's fourth int16 [unknown, not read].** It varies by clip for the same part, e.g. 26,
  434, 483 on backflip and 7 on `seal_run`. It is tool residue.
- **Every clip is read to its last byte [shown].** All 341 of them.

## 6. Scales and conventions

- **Translation is int16 / 256 [shown].**
  - This is the decomp's root-key scale `0x3b800000` (research 25 §8.2).
  - An independent check: every constant translation of the victory clips lies within one step (1/256) of
    `seal_A_scuba`'s bind node translation, e.g. `rcalf` 1108 ↔ 4.330 × 256, `rtoe` (167, −426, 9) ↔
    (167.9, −426.7, 9.7). The worst is 0.94 of a step.
  - The residual is always toward zero, so the tool truncated.
  - `seal_E_scuba` agrees too. On `al_gman01` the constants are up to 44 steps off: the clips carry the SEAL
    skeleton's bone lengths.
- **Rotation is x, y, z, w as int16 / 32767 [shown].**
  - The norms of the victory clips' 23,384 keys run 32764.8-32767.8, with a mean of 32766.5. That fits 32767 with
    truncated components.
  - All 165,028 keys of the pack are unit within 8.4e-5 after scaling.
  - `w` is last: `skel_root`'s constant is (0, 0, 0, 32767).
  - The engine may read the keys with VU0 `ITOF15` (1/32768) or renormalise them. The difference, 3.1e-5 relative,
    is below one step [unknown].
- **The matrix convention [shown].** A key is three.js's quaternion as it stands.
  - `partMatrix(q, t)` builds three.js's `makeRotationFromQuaternion` elements, which are the engine's stored
    row-major, row-vector floats (sceneGraph.ts `toColumnMajor`).
  - Backflip's constant `rtoe` (−417, −417, −23165, 23166) gives row 0 (0.000, −0.999, 0.036), and `seal_A_scuba`'s
    `rtoe` node stores (−0.000, −0.999, 0.036). `ltoe` and `skel_root` agree the same way, within 2e-3.
- **Adjacent keys can sit in opposite hemispheres [shown].** 592 of the victory clips' 23,202 adjacent
  rotation-key pairs, and 4,632 of the pack's 156,771, have a negative dot product, most near −1: the same rotation
  stored as −q. Any blend must take the shorter arc.
- **What the root carries [shown].** `skel_root` moves on the ground plane and holds its hip height.
  - In the victory clips its y stays 10.1-11.6 (bind 11.67), it travels in x/z, and its rotation is the identity
    constant.
  - The body's vertical travel and turn are in `hips`: backflip's hips y runs −2.70 to +6.38 and turns up to 177°.
  - `seal_run`'s root z falls 492.5/256 units a key: 57.7 units a second at 30 keys a second, research 25's
    "−58/s".

## 7. Time, loop and playback

- **Timing [shown].** Key *i* sits at *i* × duration / *n* seconds, and key *n* at the duration. The clip's own rate
  is *n* / duration: 30 keys a second on all 341 clips.
- **Loop and playback come from `motion.rdr` [shown].** It lives in `RUN/READERC.ZAR` and holds 398 entries of
  `anim_name`, `looped`, `playback`, `max_velocity`, `BlendTime`, `transition_speed_A/B`, `zanim_callback`,
  `NoFire`, `NoInterrupt` …
  - It names 326 of the pack's 334 clips and all 7 victory clips.
  - `looped` is 1 on 150 entries and 0 on 248: `seal_run` 1, `seal_stand` 1, `seal_jump` 0, `seal_land_hard` 0,
    every victory clip 0.
  - This is the loop bit research 25 reads at the loaded clip's `+0x49` bit 6 [inference]. `sampleClip` takes
    `loop` from the caller; the victory clips play once.
- **`playback` is not simply a speed [shown on one clip, inference beyond].**
  - It sets the in-game duration of at least some clips. `seal_crouch_step`'s `playback (0.4)` is the duration
    research 25 §8.2 read in memory (0.4 s), against the file's 0.633 s.
  - It is not a duration for all of them. `seal_run`'s `playback (1)` sits beside the in-memory duration research
    25 read, which is the file's 0.633 s.
  - Reading: locomotion clips (`max_velocity` > 0: `seal_walk`, `seal_run` 6.5) keep the clip's own duration and
    are rate-driven by speed through the transition speeds. Others (`max_velocity` < 0) play in `playback` seconds.
    The victory clips' 4.8, 2.8, 5.9, 4.6, 2.5, 6.6 and 4.7 s sit 0.23-0.43 s under their files' durations
    (2.83-6.83 s).
  - This is for W2.2b, where `motion.rdr` is read. Here it is recorded, not decoded.
- **The game's time function** (research 25 §2, `FUN_0028d670`):
  - it wraps a looping clip's normalised t into [0, 1];
  - it keeps `node+0x1c = t × n`, the fractional frame;
  - it takes `idx = floor(t × n)`.
- **Blend or hold [unknown].**
  - The data allows either reading.
  - The kept fraction and the 30-a-second keys under the 60 Hz tick (research 71 §1.5) suggest a blend, and
    `motion.rdr`'s `BlendTime` is a cross-fade between clips, not within one.
  - `motion.ts` names the blend as the placeholder `MOTION_BLEND = 'slerp'`: lerp translations, slerp rotations on
    the shorter arc. `hold: true` gives the other reading.
  - The engine carries `CQuat_Slerp` 0x306ae0 and `CQuat_SlerpFaster` 0x306890.
  - The sampler is on `CZSealBody_Tick_0`'s path. The decomp shows the calls at 0x57a818 (`FUN_0028c4f0`), 0x57a820
    (`FUN_0028c380`) and 0x57a82c (`FUN_0028c250`) (decomp `CZSealBody_Tick_0_0x57a330` lines 3527, 3553 and 3583).
    The callees' bodies are not in the handoff, so the blend stays a placeholder (§10).

## 8. The 22-map survey (`motion.test.ts`, `dump-motion.ts --all`)

| map | backflip | break | chicken | face | funky | macarena | rodeo |
|---|---|---|---|---|---|---|---|
| all 22 (MP1 … MP83) | 155 / 26 | 95 / 26 | 190 / 26 | 149 / 26 | 85 / 26 | 205 / 26 | 153 / 26 |
| key size, B | 36,224 | 21,904 | 44,148 | 33,676 | 19,724 | 45,884 | 35,772 |
| payload SHA-1 (head + names + tracks) | 321d6d2f3792 | e14b30e68be1 | ba6f5a57ca5c | 2cc4b8fa1bfe | d0551f3db472 | 41b6a112d26d | fc2b2a65e26c |

The cells read frames / parts. Each payload is identical on all 22 maps; each map's copy differs only in the object
records.

## 9. The zAnim command archives (`CZANIM.ZAR`, `MZANIM.ZAR`, `LDZANIM.ZAR`)

All 66 archives (22 maps × 3) are read to the byte by `parseAnimSets` [shown]. Their key tree:

```
Anim_Main_Params          16 B  _zanim_main_params (zanim.h:357-364): version 72, gravity -98.0, flags 0, user action 0 -- on all 66
Name_Table_Count, Name_Table    0 and empty on all 66
Anim_Set_Count, Anim_Sets/<set>
  Name_Table_Count, Name_Table/<name>...        the names are the child keys' names; count = children on all 2,134 sets
  RdrPath_Count, RdrPath_List/<path>...         absent on the loading screen's empty `Anim_Set`s (88 of 2,134 sets have it)
  SoftImage_Script_Count, SoftImage_Script_List/SoftImage_Script/{Script_Params 24 B, Script_Data}
  Animation_List_Count, Animation_List/<anim>/
    Anim_Params 24 B      _zanim_anim_params (zanim.h:366-394)
    Name_Index_Table_Count, Name_Index_Table     u16 per entry into the set's name table
    Node_Ref_Count, Node_Ref_List                8 B per reference
    Seq_Data_Size, Seq_Data                      the command stream (absent when 0)
    Anim_Health 24 B      on 227 animations; not decoded
```

- **Gravity [shown].** It is −98 on all 66. reCOM's `Open` default is −9.8 (`anim_main.cpp:24`), so zAnim's units
  are ten to the metre.
- **Animation names [shown, 9,912 of 9,912].** `Anim_Params` byte 0 indexes the animation's own name table, and
  resolves to the animation's key name every time. A set may hold two animations of one name (Frostfire's `fan1`),
  so they are read by position.
- **Node references [shown, 11,418 of 11,418].**
  - Bits 0-7 are the parent, an index into the same list.
  - Bits 8-18 are the name, through the local table.
  - Bits 19-21 are a search mode.
  - The second word is 0 on 11,154 [unknown].
- **The command stream [shown].**
  - `Seq_Data` is sequences back to back, 18,642 in all.
  - Each sequence is a 28-byte `_zsequence` head (zanim.h:463-481) followed by its commands:
    - a u16 name index, through the local table, e.g. `fire_rotate`, `light_at_muzzle`, `make_arrow`;
    - a word, 0x102 or 0x104 on most;
    - a pc of 0;
    - the size in bytes, head included;
    - three timers of 0.
  - Each command is a `_zanim_cmd_hdr` (zanim.h:342-348): type in bits 0-15 (the command in the low byte, the set in
    the high), `quad_align` bit 16, `timeless` bit 17, the size in bytes bits 18-31 (header included).
  - The 73,634 commands tile their sequences exactly, and the sequences tile every stream.
  - The four `Anim_Params` sequence offsets (u16 at +16..+22: damage, activation, execution, cleanup) always land on
    a sequence start.
  - Payloads are [unknown].
- **Command types.** There are 64 distinct types over all 66 archives.
  - 0x02 and 0x05 balance: 4,280 against 4,279.
  - In 18,641 of the 18,642 sequences, every 0x02 … 0x05 pair nests cleanly with 0x03 and 0x04 only inside one.
    `fire_rotate` reads 0x02, then 0x03 five times, then 0x04, then 0x05.
  - That fits reCOM's `DATATYPE_IF` 0x02 and `DATATYPE_END_IF` 0x05, with 0x03/0x04 as ELSEIF/ELSE [inference].
  - **reCOM's other numbers do not all hold.** Its `OBJECT_MOTION` 0x13 is a 20-byte command on all 1,777 uses, but
    the SOCOM II `OBJECT_MOTION` begin reads to +0x7c (§11). The dump prints reCOM's names as hints only.
- **SoftImage scripts [shown].** There are 30, on 8 maps' `MZANIM`: MP6, MP10, MP11, MP52, MP53, MP62, MP73, MP82.
  - `Script_Params` is two u16 name indices (the `.anm` path and the object), a word (0x19 or 0x11, [unknown]), an
    f32 frame time (1/30, 1/20, 1/15, 1/40), a frame count, the data size (it equals `Script_Data`'s length) and a
    stale pointer.
  - All 30 are the helicopter and F-18 flight paths: `chop_hover.anm`, `chop_path1.anm`, `f18_path1.anm` …
    MP6's six `f18_*.zan` carry no data.
  - MP10's `chop_hover.anm` reads as float keys, not this format. The data is not decoded.
- **The zAnim archives name no body motion [shown].**
  - No name table of the 66 carries a clip of `MOTION_S.ZAR` or `MOTION_P.ZAR`, and Frostfire's three carry no
    SoftImage script.
  - **The link runs the other way.** `motion.rdr`'s `zanim_callback (name … time …)` calls zAnim animations from a
    clip at a fraction of its time, e.g. `seal_jump` → `jump_whoosh` at 0.4 and `seal_stand` → `cold_breath` at
    0.1. 24 of its 26 callback names are animations of `CZANIM`'s `common` set: `jump_whoosh`, `seal_thud`,
    `dive_prone`, `ladder_rung`, `pull_up`, `climb_up`, `throw_whoosh`, `shotgun_pump`, `headshot_kill` … The other
    two, `cold_breath` and `knife_blood_squirt`, are not in it.
  - `CZANIM` also names the per-weapon effects (the `muzzle_*` flashes, `muzzle_m4SD`, `muzzle_Beretta_M9`,
    `shell_eject`, `tracer_ally_anim`) and the footfall ripples (`big_ripple_anim_walk/run`).
  - The map's `MZANIM` holds its doors and fans (`singleDoor_left`, `singleDoor_right`, `fan1`, `fanblade1_start`
    on Frostfire) as zAnim animations, not as motion clips.
- **The 22-map counts.**
  - `CZANIM` is 1 set / 624 names / 288 animations on every map.
  - `LDZANIM` is 95 sets / 63 animations on every map.
  - `MZANIM` varies: MP2 281 names / 76 animations, MP6 609 / 222 with 6 SoftImage scripts, MP73 515 / 132 …
  - The totals are 9,912 animations, 18,642 sequences, 73,634 commands and 30 SoftImage scripts. `zanim.test.ts`
    prints the table.

## 10. What is settled, what is not, and what would settle it

- **Settled:**
  - the clip layout to the last byte on 341 clips (7 × 22 maps and the pack's 334);
  - the head's version, duration, frame count and part count;
  - the part names and their mapping to `CZSealBody`'s parts;
  - the track flags and the loader's use of them;
  - the two channels, the alignment and the closing key;
  - both scales, the quaternion order and the matrix convention (against the bind skeleton);
  - loop and playback living in `motion.rdr`;
  - the zAnim archives' tree, names, sequences and command tiling on 66 archives.
- **Not settled:**
  - the head's f32s at +0x10/+0x14 (−1, 1);
  - the meaning of flag bits 0x04/0x08;
  - the pad lane;
  - blend or hold, and which slerp;
  - `playback`'s rule beyond `seal_crouch_step`;
  - ITOF15 against 1/32767;
  - the zAnim command payloads and types beyond IF/END_IF, and the SoftImage `.anm` data.
- **What would settle them:**
  - blend or hold: the bodies of `FUN_0028c380` (time → key) and the pose blend beside it, called from
    `CZSealBody_Tick_0` (§7). Research 25 also names `FUN_00289bb0` and `FUN_0028d670`.
  - the flag bits and the pad lane: `CZSIObject_Read` 0x289380 and `FUN_0028a100`, the pack's loader.
  - `playback`, `looped` and `max_velocity` as the engine applies them: the `motion.rdr` reader (W2.2b).
  - the `Anim_Params` bitfield and the unknown node-reference word: `CZAnimSet_Load` 0x26bc50 and
    `CZAnim_Load` 0x26d370.

## 11. What `zAnimObjectMotionBegin` 0x262690 is (decomp, reference only)

The owner supplied its body as "the motion player". It is not the skeletal clip player [shown by its code].

- **It is `OBJECT_MOTION`'s begin hook** (reCOM `anim_main.cpp:315`). It takes one zAnim command header (`$a0`):
  - it reads the node index byte at +8 (line 139) and fetches the node through `func_26F4E0` (line 142);
  - it reads a flag word at +4 and tests 0x1 (line 173), 0x8 (line 398), 0x1000 (line 414), 0x2000 (line 833) and
    0x4000 (line 843);
  - it follows two s16 self-relative offsets, at +0x7a (line 190) and +0x20 (line 411), to blocks of four floats
    inside the command.
- **It draws random values [shown].** `rand` 0x197740 is called 8 times (first at line 215), each result scaled by
  `0x30000000` = 2⁻³¹ (line 239) and multiplied into a range: base + range × random.
- **It builds a direction** with `zAnimGetDirectionFromAzimuthZenith` 0x25cb00 (line 380), inverts the node's
  matrix with `Vu0MatrixInverseWithUniformScale` 0x308160 (line 1132), and copies with `memcpy` (line 2088 on).
- **It writes the command's run-time state** at +0x24..+0x4c and +0x7c (from line 616).
- **In sum:** it sets up a node's velocity and spin with random ranges, the shell-eject and debris kind of motion.
  It reads no clip, frame count, key or quaternion track, and **settles nothing in §2-§7**.
- **One thing it does settle, the numbering.** The command it reads is at least 0x80 bytes, so SOCOM II's
  `OBJECT_MOTION` is not the 20-byte type 0x13 of reCOM's table (§9). Which on-disc type it is was not settled
  here: types 0x15, 0x1b, 0x101 and 0x20 reach that size.

## 12. The player's pack, `RUN/MOTION_P.ZAR` (the owner's file, 2026-09-28)

- **Reading [shown].**
  - 334 clips, 335 keys, every clip read to its last byte by the unchanged reader.
  - Version 5, +0x10/+0x14 = −1/1 and 30 keys a second on every clip.
  - 1-81 frames (0.033-2.7 s): 81 on the three buddy-carry pickups, 1 on the held poses such as `seal_fp_prone`,
    `civ_sitting01` and `guard_restrained`.
  - Flags are only the four of §5, and all 7,309 animated channels close on key 0.
- **Families [shown].** `seal_*` 154, `seal_p_*` 79 (pistol), `seal_fp_*` 13 and `seal_pfp_*` 12 (first person),
  `seal_mv_*` 6 (moving upper-body overlays), `guard_*` 34, `death_*` 22, `civ_*` 12, `torturer_*` 2.
- **The cycles a mover needs, with frames:**
  - stand and locomotion: `seal_stand` 16, `seal_walk` 25, `seal_jog` 22, `seal_run` 19, `seal_walk_bw` 16,
    `seal_run_bw` 18, `seal_lstrafe` 22, `seal_rstrafe` 23;
  - crouch and prone: `seal_crouch` 21, `seal_crouchwalk` 28, `seal_prone` 10, `seal_prone_crawl` 26;
  - jump and land: `seal_jump` 20, `seal_runningjump_launch` 25, `seal_runningjump_in_air` 14, `seal_land_soft` 20,
    `seal_land_hard` 20;
  - weapon: `seal_recoil` 2, `seal_reload` 45;
  - first person: `seal_fp_stand` 8, `seal_fp_walk` 25, `seal_fp_run` 18.

  `motion.test.ts` pins these.
- **Layers [shown].** 34 distinct part sets.
  - The full body is 25-28 parts, the extras being weapon props.
  - The upper-body layers (`seal_p_walk`, `seal_pfp_*`, `seal_mv_*`) carry 14-16 parts: spine, arms, head, a prop,
    and no root or legs.
  - `seal_headlooks` carries 4 (spinelo, spinehi, neck, head).
  - **The game composes a pose from more than one clip.** How is the pose sampler's business (§10).
- **Research 25 is this pack [shown].**
  - Its "walk" keys (41, 2638, 7233 − 492.5·*i*; *n* = 19, 0.633 s) are `seal_run`'s root, byte for byte.
  - Its `seal_crouch_step` descriptor is that clip's 0x3c root with the loader's bits (§3).
  - Its corrupted-memory keys k12 = (−934, −81, 208) and k13 = (32753, …) are `seal_step`'s `spinehi` rotation
    key 9, read at the translation stride.
  - Its in-memory table (99 clips, `seal_crouch_step` at index 64) is not the file's order or count
    (`seal_crouch_step` is key 102 of 334). The game loads a subset or re-orders it [unknown].
- **The bytes stay out of the tree.** The file lives beside the maps in the git-ignored `public/maps/RUN`, and the
  tests read it there and skip when it is absent.
