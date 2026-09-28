# SOCOM Unzipped: the story so far

*The timeline of this project, first commit to today. Written for people who want to play the game, not build it.
Each entry has one technical line you can skip. The rest is what happened.*

**What this is.** SOCOM II is a PlayStation 2 game from 2003. This project turns the game's own code into a Windows and
Linux program. It runs from your own disc (the North American r0001 pressing; anything else gets refused with a message
instead of half-working), draws on your GPU, plays through your speakers, reads your controller, and plays online.
Players are meant to play on the community's servers, which run a later revision of the game than the disc holds;
until the launcher can install that update, the project's own server is where builds are tested against something
known. Nothing from the game ships with it.

**How to read an entry.** Date, title, one bold line on why it mattered, a few sentences on what happened, then three
small things. *How:* is the technical sentence. *But:* is the catch: what's still unproven, what got retracted, what a
number doesn't mean. `Cited:` is the evidence, commit hashes you can open in the repo plus run records. The run records
live in a `logs/` folder on the project machine, not in the repo, so each one cited here has a frozen witness (first
lines, size, hash) in `docs/story/witnesses.json`. A test fails if any citation stops pointing at something real.

## From the creator

This is an automation-first, agentically engineered passion project. It started as curiosity. I wanted to see where
PS2 static recompilation actually stood, and it grew legs when it started producing results, so I kept building on
them. The recompiler is a fork of PS2Recomp, extended for this one game. A good portion of the work went into a
parallel validator: the retail disc running in PCSX2 as a golden reference, driven by the same scripts as our build,
with debugging tools on both sides, so the agents could check themselves against the real thing on demand and adjust.
Most of the code was written by AI agents in a loop I run. My part was mostly playing it, noticing what was off, and
deciding what mattered next. What follows is the record of that, receipts attached.

Scotho

---

## 2026-09-02 .. 2026-09-07 - From the disc to the screen

*Six days in: the game boots from your own disc, plays its movies, takes keyboard input through every menu, and loads the first mission into a textured world. Online still belongs to the emulator.*

### 2026-09-02 - The game isn't in the file you'd expect

**The executable on the SOCOM II disc is 874 KB of loader. The actual game is locked in an encrypted archive next to it.**

Day one, two commits, nothing runs. The first is tools: a harness that steps the PS2's CPU one instruction at a time, scripts to pull a function map out of Ghidra, and a decryptor for the archive. The second is the finding: inside the archive are two code overlays, 2.2 MB and 1.7 MB, stamped "SOCOM 2 r0001 17:22:21 Oct 11 2003". The disc's protection asks the console for its hardware IDs while it decrypts, but those IDs feed a hash nothing ever checks. So the archive isn't tied to one machine.

*How:* the harness runs the console's MIPS core under Unicorn and traps the PS2-only instructions out to Python, because no off-the-shelf emulator knows them.

*But:* the archive opens because of a quirk in the protection, not a defeat of it. Nothing of the game ran yet.

`Cited:` `55f5170` Unicorn EE harness, Ghidra export scripts, APACHE00.ZDB decryptor · `eee6634` research reports, synthetic overlay ELF builder · docs/research/05-code-package-and-harness.md · docs/research/01-ps2-static-recompilation.md

### 2026-09-04 - A PS2 game becomes a Windows program

**Thirty-five commits, and by the end the game's own code is C++ that compiles.**

The protection layer encrypts 131 of its own code blocks; running the cipher offline unwraps them without a console. A fork of PS2Recomp turns the MIPS into C++, and the loader plus both overlays become one program file linked against a runtime. Most of the day went on something duller and more important: Ghidra's function map was wrong in ways that quietly corrupt everything. One 46 KB stretch of unrelated code had been folded into a single function, so calls into it landed in the wrong place and returned garbage. Normalised and re-exported: 13,261 functions. A Horizon server, the community's stand-in for Sony's long-dead online service, went up on the same PC three days before anything could talk to it.

*How:* Ghidra writes Start, End and Size separately and they disagree for split functions; the fix recomputes End and forces the missing entry points by hand.

*But:* compiling isn't running. Forcing entry points by hand also pushed the count of untranslatable instructions from about 11,000 to 114,000. That's garbage that never executes, and it's still there today.

`Cited:` `37b2922` static DNAS self-decryptor, SIF RPC HLE · `329bbda` APACHE00.ZDB decryption works end-to-end · `8736759` vendor PS2Recomp for the SOCOM II fork · `1a9ae52` segmented synthetic ELF, external generated-code dir · `ac7de47` re-exported Ghidra map (13261 fns) · `a3cef6c` Horizon Private Server local setup · docs/research/05-code-package-and-harness.md · docs/STATUS.md

### 2026-09-05 - It plays its intro

**A day of black screen, and the graphics weren't the problem.**

A full diagnosis of the render path said every layer below the game was fine. The game just wasn't asking for anything to be drawn, because it was waiting for a controller. Fake one and it wedges somewhere else. The real cause took a hardware watchpoint: the game asks Sony's device-bus manager how many bytes arrived, our stub never answered, and the game read back an uninitialised number and copied that many bytes over its own heap. Five of those calls per boot; the third overran into the texture registry. Answer all five and the intro plays: 2,445 frames, no faults.

![The oldest frame of the game this machine still holds: the evening of the 5th, six seconds after launch, the memory-card slot prompt drawn by the software rasterizer with its text upside down. Everything else is black because nothing else had been asked for yet.](docs/story/img/2026-09-05-the-card-prompt-upside-down.png)

*How:* the smashed registry turned code words into pointers, which faulted, which the runtime silently retried forever. A hang with no error.

*But:* the controller was a fiction with neutral input; real keyboard input came later the same day. And "every layer below the game is correct" didn't survive the afternoon: three real delivery bugs turned up in that path a few hours later.

`Cited:` `594b887` libpad2 (scePad2) HLE — report one connected DualShock2, neutral input · `cc27753` answer every libdbc RPC — unanswered ReceiveData smashed the heap · docs/research/07-render-pipeline-diagnosis.md · docs/research/08-controller-and-dbcman.md · logs/host_cpu/host_001_6s.png

### 2026-09-05 - The main menu, at full speed

**Three bugs on one delivery path stood between the game and its own menus.**

SOCOM II ships its shell's constants through one particular kind of transfer tag, and the chain walker treated that kind differently from every other. The camera's eye vector never arrived, the backface test rejected every menu triangle, nothing was submitted. Fixed, the shell drew at 13 to 17 fps, a software rasterizer doing a swizzled read and a palette lookup for every one of a million textured pixels. An OpenGL 3.3 backend that records draw commands on the game thread and replays them on the graphics thread took the same screen to 55-60. Then the game walked its real first-boot sequence for the first time: memory card prompt, loading warning, "no SOCOM data found", Sony logo, intro, main menu.

![The same evening, seven minutes after the software rasterizer's run, on the new OpenGL backend: the title, 29 seconds after launch, drawn at full speed. The bar along the bottom is the runtime's own debugger.](docs/story/img/2026-09-05-the-title-at-full-speed.png)

*How:* the last black screen of the day wasn't a rendering bug at all. The menu frame's alpha is zero and the present was blending the finished picture to black.

*But:* no button captions, no 3D roller, a black rectangle where the background movie belongs. The 60 is the menu's number; there was no mission to measure yet.

`Cited:` `5152946` TTE-gated DMAtag upper-half transfer — shell UI renders · `409d0c3` OpenGL 3.3 GPU backend — menu renders at full speed · `31b559e` host keyboard/mouse/scripted DualShock2; main menu reached · `73c9a49` recompile the two uncovered trampolines; present the GS frame opaque · docs/superpowers/plans/2026-09-05-gpu-gs-backend.md · docs/STATUS.md · logs/host/host_000_1s.png · logs/host/host_007_29s.png

### 2026-09-07 - The first frames of a mission

**The thing starving the renderer was the automatic exposure control.**

First the mission had to load at all: four fixes the day before, all the same kind of bug: the recompiler and the runtime disagreeing with the original code about where a function starts and ends. 136 real functions sat in gaps the map never listed, and calling into one did nothing. With those in, the Albania briefing handed off to a running level that drew nothing. The reason: a background thread wakes every vertical blank and reads about 176 pixels back off the frame buffer to judge scene brightness. That readback path didn't exist, so every read spun to a sixteen-million-iteration timeout, a third of a second each, and starved the game to one tick a minute. Swap the readback for a fixed mid-grey and the mission runs at twenty ticks a second: flat world polygons and a night sky.

![The first mission, the afternoon of the 7th, 113 seconds after launch: flat grey ground, a wall of fog, and a night sky drawn as white specks. No textures, no HUD, and the camera is not going anywhere.](docs/story/img/2026-09-07-flat-grey-and-a-night-sky.png)

*How:* nothing was broken in the renderer; a spin loop with a very large bound was the whole defect.

*But:* flat grey, no textures, no HUD, a camera that doesn't move. And the mid-grey stub was a defect in waiting: the exposure thread reading a constant grey asked for no brightening, which is half of why every gameplay frame was 1.73x too dark until 2026-09-16.

`Cited:` `ec4b9fb` do not mistake a scheduler unwind for a return · `feb92ab` run INTC/DMAC handlers, alarms and the GS vsync callback on a dedicated invocation stack · `2b06f50` recompile the 136 function bodies Ghidra left in gaps · `eebd64a` split the six merged Ghidra ranges whose second function is called by pointer · `7bb89d4` the Albania mission loads and runs · docs/STATUS.md · `d3cea62` stub the auto-exposure thread's GS readback — the mission now ticks every frame and draws · `545b85a` (2026-09-16) the auto-exposure readback answered from GS memory instead of a grey pixel · docs/research/31-flat-grey-geometry.md · logs/parity/mission_merge/host_000_1s.png · logs/shots_live/host_010_113s.png

### 2026-09-07 - The console becomes the marking scheme

**Instead of arguing about what looked wrong, the project started scoring itself against screenshots of the real game.**

A harness captures a window without stealing focus, posts the same button presses to an emulator running the retail disc and to our window, walks both through the same script, and scores the pairs. The first report scored 6 of 20 screens (mean 80.6, main menu 63.7) and the other fourteen were never reached. It paid off immediately. Every 2D element was drawing at the top-left corner, because the recompiled code wrote to a vector register that's hardwired to (0,0,0,1) on real hardware. Text was being culled by a face-winding setting raylib leaves on. Four-bit palettes were read in the wrong order, which is why the text was dim. And 29 hand-written substitutes for Sony's vector-maths library were multiplying matrices the wrong way round, so the camera's clip matrix was wrong and every object failed the visibility test. Deleting the substitutes and recompiling Sony's own code brought back the menu's rotating 3D selector and gave the mission textures.

![The first parity run's briefing screen: every 2D element drawn at the top-left corner, because the recompiled code was writing a register the hardware keeps constant. The report scored this 63.7 and the fixes followed the same day.](docs/story/img/2026-09-07-briefing-drawn-at-the-origin.png)

*How:* the score is a per-screen picture comparison at 320x224, one number from 0 to 100.

*But:* a picture score is not a correctness check. The day's last report graded the main menu 81.0 with the movie behind it still black, and the same animated warning screen scored 79.2, 75.0, 78.0 and 74.9 on capture timing alone.

`Cited:` `2aa2572` parity harness design spec (PCSX2 golden screens as the loop's grader) · `069aa7a` comparer + first REPORT.md (golden from PCSX2, 6 screens scored) · `ea026de` never write vf00 — all 2D UI elements were drawn at the origin · `8653933` text draws — disable raylib's GL_CULL_FACE, CSM1 CLUT index swizzle for 4-bit palettes · `daa1eda` drop the 29 libvu0 sceVu0* HLE stubs and recompile Sony's code · `c2489bd` shell parity after the four fixes · `4af3f00` report ours_e after libvu0 fix · docs/parity/REPORT.md · docs/superpowers/specs/2026-09-07-parity-harness-design.md · logs/parity/ours_e_sheet.png

### 2026-09-07 - The movies play

**Every movie in the game was dying on its first tick over four stale bytes.**

The stand-in for the PS2's movie library never cleared its work buffer when a player was created. The game read the first word of that buffer to ask whether the movie had finished, found leftover bytes spelling UIMe from an unrelated file, and concluded it had already ended. The real function clears the buffer. With that one line, plus the game's feed callback run on the calling thread instead of parking the only thread that could feed the decoder, the Sony logo, the intro and the looping menu background all play. The main menu's score went from 81.0 to 98.8.

![The main menu as the first parity run captured it that afternoon, hours before the movie fix landed: the logo, and a menu with no captions, no roller and no movie behind it. The 81.0 was scored on a screen like this one.](docs/story/img/2026-09-05-menu-with-no-captions.png)

*How:* the movie player's finished flag was read out of a work buffer that was never cleared on creation; clearing it, like the real library does, is the whole fix.

*But:* 98.8 is one screen against one reference capture, and the report it was measured in is gone from disk; the number survives in the research note and the log.

`Cited:` `ad503c8` play SOCOM II movies through the sceMpeg HLE (menu background, intros) · `9305c72` Merge feat/menu-movie · docs/research/09-menu-movie-ipu.md · docs/STATUS.md · logs/parity/runs/ours_a/s02_CROSS.png

### 2026-09-07 - Two clients, one server, one match

**The first SOCOM II match on this project's own server wasn't played by this project.**

The Horizon server that had been sitting on the PC since the 4th finally got a client. A retail disc in the reference emulator went LOGIN, SELECT UNIVERSE, ACCOUNT LOGIN, lobby, after three protocol fixes read straight out of the decompiled client library. A second emulator, with its own memory card and its ports shifted, joined the game the first created; both pressed READY and the match launched: VIGILANCE, round timer running. Our own executable reached the front door the same night: network layer up on host sockets, key exchange and stream cipher running, the server accepting the connection.

*How:* handler ids are assigned in registration order, so reading the live slot table out of the emulator's memory tells you which message is which.

*But:* the match was two emulators. Ours got as far as LOGIN TO SOCOM II ONLINE, completed the handshake, and closed before asking for the universe list. Everything was on one machine, and the server is a community stand-in, not Sony's.

`Cited:` `5fcb9dc` PCSX2 client reaches the SOCOM II ONLINE lobby on the local Horizon stack · `f4ab598` two PCSX2 clients play a match on the local Horizon stack · `d738b29` SIF sreg handshake, msifrpc HLE, eznetcnf/eznetctl service, DNAS bypass · `9db2fbd` SCERT handshake with Horizon over a host Winsock netstack · docs/research/10-libnetb-rpc.md · docs/STATUS.md · logs/parity/online/login/09_lobby.png · logs/parity/online/match/montageAB2.png

## 2026-09-08 .. 2026-09-11 - A picture, then a gate

*By the 11th the program draws its menus and its first mission the way the console does, runs at tens of frames a second instead of a handful, can be walked through by script, and can put two copies of itself into an online match on a local server. Where the players then stand still.*

### 2026-09-08 - Our own program gets online

**Two copies of the recompiled game log in, host a match, and join it.**

Yesterday the only thing to reach a lobby was the retail disc under an emulator. Today our executable did it. A stuck clock register was advanced so the program got as far as SELECT UNIVERSE, then a driver walked it through login, the on-screen keyboard, the licence agreement, the lobby and the briefing rooms, and it created a game called "test" on Medley. By the end of the night two instances were in the same match: socomc hosting, socome joining, both READY, both loaded into VIGILANCE. The lobby screens scored 98.6 to 99.4 against the console.

![The project's own executable in the SOCOM II ONLINE lobby, on the server running on the same PC. The persona is the driver's test name; the panel in the corner is the runtime's own debugger, open by default in this era.](docs/story/img/2026-09-08-online-lobby.png)

*How:* a second instance is just environment: its own window tag, its own memory-card folder, and a shift on the game's fixed network ports at bind time.

*But:* both players were scripts, both on one PC, and the server was on that PC too.

`Cited:` `a1bafbf` advance COP0 Count, reaches SELECT UNIVERSE · `090401a` login driver for our exe · `d0caab9` the exe hosts a game on Horizon · `2adb58b` two instances play an online match · logs/parity/ours_login/09_lobby.png · logs/parity/ours_host/16_game_lobby.png · logs/parity/ours_match/A_hold05.png

### 2026-09-08 - The world stops coming apart

**Every square root in the game had been returning zero.**

The recompiler emitted the console's square-root instruction reading the wrong register, so the game always took the square root of register zero. The quaternion builder divided by that, saturated to the largest float there is, and the actors' orientation matrices exploded, which drained the collision pool and dropped the player through the terrain. Two more the same day: object geometry (trees, people, about 1700 triangles a frame) was arriving at the graphics chip as three identical points at the origin, and the camera's frustum test always answered "fully inside" because nothing wrote the flag register it read. That's where the giant sky polygons came from. The next day, the title screen's labels stopped getting wiped by the background movie painting over them a step early.

*How:* the geometry fix is one rule: copy the whole packet when the program kicks it, the way the emulator does, instead of modelling the transfer a word at a time.

*But:* each of these was settled by looking at the picture and at dumped memory against the emulator. There was no test suite and no gate until two days later.

`Cited:` `4d2c706` SQRT.S reads ft · `fa53d3f` copy XGKICK packets at kick time — object geometry appears · `193ef1e` macro-mode FMAC ops set the flags — the frustum test routes near objects through clipping · `2d23351` the mission intro movie plays · docs/STATUS.md (2026-09-08 16:15 and 21:40 entries) · `3c20dc8` stall on i-bit VIFcodes — title labels clean · `7730052` re-read only the uploaded rectangle — no more menu-video strip · `77a41ff` (2026-09-08) run the game thread with host rounding toward zero · gate s8_audio_mc_gate2 · gate s9_p7_playtest_gate · logs/parity/title_stall5_sheet.png

### 2026-09-09 - From three frames a second to thirty

**The part of the console that draws SOCOM II's geometry was being simulated one cycle at a time.**

The vector unit that transforms and lights every triangle was emulated at about 100 nanoseconds per cycle, which held the whole game to a few frames a second. A fast path that drops the per-cycle scheduler took that to 18 ns; a translator that turns the game's vector microcode into C++ took it to 10 offline. With the graphics and scheduler work that followed the same day, in-mission speed went 12.7, then 19, then 22-29, then 28.7 fps. Fast enough to play: a script drove the first mission end to end, walking, turning, firing, with the game answering at 36-42 fps. The same day the project wrote down what "playable" would have to mean before anyone could claim it: a match ended by a shot.

*How:* the fast path and the generated code were checked against the exact interpreter, same packets, same registers; the mission program was regenerated from 900 recorded dumps of it.

*But:* numbers from one PC on one mission, not a steady-state figure. One part of the speed-up was wrong: the decision to stop counting the drawing unit's time against the game's own clock was reverted on 2026-09-17, and it's a story of its own below.

`Cited:` `51b7ba4` non-cycle-exact fast path, bit-identical to the exact interpreter · `f9f44ff` microcode-to-C++ recompiler, 10 ns/cycle offline · `f5d079e` fast path on by default, 100 -> 18 ns/cycle · `950fbd2` row-span uploads — mission gameplay 12.7 -> 19 frames/s · `cf58986` regenerated from 900 dumps — gameplay 22-29 frames/s · `96c84c6` scheduler fast paths — 28.7 frames/s · `1c301b9` sample a render target's own colour texture · logs/parity/vu1fast_1_sheet.png · `94421fb` first mission playable by script at 36-42 fps · `c2f85f0` define the playable acceptance test · `7448cbf` loop lock script serializing builds and game runs · logs/parity/gameplay_probe5_sheet.png · docs/LOOP_PROMPT.md

### 2026-09-10 - The project gets a name, and starts checking itself

**SOCOM Unzipped, a test suite that runs, and one command that says PASS or FAIL.**

The work moved into its own repository under the name SOCOM Unzipped. Until this day the unit tests had never been built with the project's own toolchain; once they were, 425 passed and ./build.sh test exited zero for the first time. A single gate command boots the game three times (title screen, the transition into a mission, the mission itself), scores each, and returns a number. Its first run passed two of three: the mission never reached the HUD.

*How:* the suite also replays recorded drawing programs against a committed golden state file, so a change that alters output by one register is caught offline.

*But:* a test count isn't correctness and neither is a green gate. The gate proves regression, meaning the game looks like it did last time, and one of its three stages turned out to be measuring nothing at all. Next entry.

`Cited:` `4b0bbf9` the project is SOCOM Unzipped in its own repo · `98245ad` ps2x_tests links and runs under llvm-mingw, ./build.sh test · `2fca2b8` vu1_replay --verify against a golden state file · `3bc03ba` gate command with numeric PASS/FAIL and exit code · `e70af9a` transition gate no longer passes vacuously · logs/parity/gate_first.out

### 2026-09-11 - Our own code draws the game

**The drawing program is no longer emulated microcode. It's C++ someone wrote by hand.**

Reading the game's vector microcode showed one dispatcher at a fixed entry point does all of it, and its commands fall into families: flat interface panels first, then world objects with clipping and multi-pass work. Hand-written replacements were checked command by command against the original, and the dispatcher went on by default after a gate that passed all three stages. By evening the world-object families were native too: 123 of 166 recorded command lists, each matching the emulated version exactly.

*How:* programs are matched by a hash of their code plus entry point; anything the hand-written version doesn't handle is handed back to the emulated path part-way through a list.

*But:* that clean gate was less clean than it read; see the next entry. And handing a list back part-way is exact only by luck of the recorded set: no program in it branches on the flags in the four instruction pairs where it would matter.

`Cited:` `15efcd7` native-program registry keyed by (image hash, entry pc) · `73974cd` 0x1b50 dispatcher on by default after a green gate · `d912cc1` family-B lists run natively · `f28fdc7` family-C lists run natively · `ef80286` native dispatcher runs family C as well (123/166) · `dd5fca8` render-target scale spike — NO-GO for Sprint 2 · docs/research/13-vu1-family-b-world-objects.md · logs/parity/gate_native_default.out · logs/parity/gate/famb/summary.txt

### 2026-09-11 - The check that had been passing for free

**One of the three gate stages had been measuring nothing.**

The middle stage is supposed to watch the screen go black as the game moves into a mission. It counted black frames from anywhere in the run, boot screens included, so it stayed green whether or not the game ever reached the fade. Worse, a save-to-card dialog had started appearing at boot and the probe answered it blindly, so it never got to the briefing. Six earlier runs re-read against the fixed rule had examined zero frames in the window that counts. All six had passed.

![The last frame of the very first gate run, 2026-09-10: the save-to-card dialog the probe answered blindly, so it never reached the briefing. This frame sat in the archive on D: until the story went looking for it.](docs/story/img/2026-09-11-the-dialog-the-gate-answered-blindly.png)

*How:* the scorer now counts only frames at or after the step that triggers the fade; a run that never gets there scores zero and fails.

*But:* first of several times one of the project's own instruments turned out to be reporting something it hadn't measured. Not the last.

`Cited:` `148dffa` the transition gate measures the transition · `9848a6c` Sprint 2 landed — gate hardening · logs/parity/gate_wcap1.out · logs/parity/gate_tfix4.out · docs/STATUS.md (2026-09-11 03:45 entry)

## 2026-09-12 .. 2026-09-14 - From picture to game

*Three days, 219 commits. The intro movie is clean, the single-player mission stops freezing, players can move in an online match again, and two copies of the game meet on Frostfire and one kills the other.*

### 2026-09-12 - Four times the pixels, and no sharper HUD

**The world can now be drawn at up to four times the console's size. Three quarters of the screen look exactly the same.**

Until now every frame was drawn at 640x448 and stretched. A new setting draws the 3D world at two, three or four times that and hands the game back a console-sized picture, so nothing inside the game notices. At 2x the gate passed and the edges genuinely softened: the fraction of edge pixels that are a smooth blend rather than a hard step went 0.13 to 0.42. The HUD, menus and title screen didn't change at all. They're flat pictures at their original size; extra pixels can't add detail that was never there.

![One of the pixel-filter gates the render-scale work needed, stuck: every title capture scored 66.4 because the game was sitting on the memory-card slot prompt the whole time. 0 of 23, and a lesson about what a flat score means.](docs/story/img/2026-09-12-the-gate-stuck-on-a-card-prompt.png)

*How:* render targets carry a native size and a host size; vertices are scaled after the offset subtraction, and anything the game reads back resolves through a native-sized mirror.

*But:* the sprint's own design doc had promised a sharper HUD. Measured, withdrawn. Default stays at 1x.

`Cited:` `219ab9c` PS2X_GS_SCALE integer render-target scale · `66e8a07` PS2X_GS_SCALE=2 verified (sheets) · `b353c93` Sprint 3 close-out · gate s3d_2x_host · docs/research/14-gs-render-target-scale-spike.md

### 2026-09-12 - The black squares leave the intro movie

**Someone reported black tiles flickering over the movies. The tiles were real, and they were never in the movie.**

The decoded movie was perfect. Two threads shared one note of which rectangle of the screen had just changed; the game thread kept overwriting it, so the copy to the graphics card refreshed the wrong patch and left stale black squares on the intro and the title's moving background. Deleting one line fixed it. A checker written before the fix counts blocks that are black on screen but not in the decoded frame: nine before, zero after, and the missed refreshes went from 3,748 to none.

*How:* executeUpload on the render thread read m_currentTransfer, which BeginTransfer on the game thread was also setting.

*But:* the predicted cause, rectangles arriving half-delivered, accounted for none of the 3,748; the planned fix would have done nothing. The checker itself ran in nothing until 2026-09-17, when it went into ./build.sh test against a committed fixture.

`Cited:` `4a701f1` stop the game thread clobbering m_currentTransfer · `b91df1b` movie_blocks(review 4): the furniture map is per screen · `bd27443` (2026-09-17) movie_blocks runs in build.sh test against a saved fixture · tools_py/parity/movie_blocks.py · docs/research/16-intro-movie-macroblocks.md

### 2026-09-12 - Every dice roll came up nearly zero

**The game rolls dice in 249 places. For the whole life of the project, every roll had come up almost the lowest number it could.**

SOCOM II turns a random draw into a fraction by dividing by two billion. The stand-in for the C library's random function returned fifteen bits where the game expects thirty-one, so every fraction landed in the bottom 1/65536 of its range. Worse, the game seeds itself from its own previous draw, and that seed froze at 41 on the first boot. One measured field that mixes in randomness went from 4.000021 to 5.5314, against 6.3338 on the real console. Same afternoon, same shape: five maths routines wired to the wrong registers, handing back whatever the previous call left behind.

*How:* the stub now runs newlib's own generator over the guest's own _rand_next word rather than the host C runtime's.

*But:* nothing caught either of these for weeks. The parity gate was green over them the whole time, because a defect present in every run looks exactly like the reference. The maths routines were milder than billed: 19 of their 22 call sites happened to want the identity anyway.

`Cited:` `ede2096` rand() returns newlib's 31 bits over the guest's own _rand_next · `60a19f2` bounds-check the guest _rand_next slot · `db7a992` the soft-double sin/cos/tan/fabs/floor stubs take $a0 and return $v0 · gate s4_rand · docs/research/17-ground-height.md

### 2026-09-12 - Online players can move again

**For two days the online round had been written up as waiting to start. It wasn't. The round was running and the player was pinned.**

On the 10th, with the fast build in, two instances got all the way into online gameplay, and then nobody moved. A network trace showed the two copies talking at about a packet a second, and the write-up called the match stuck at the round start. Wrong. In a multiplayer match the game scales your movement by how recently the network was active; the stand-in for the PS2's network interface answered "how much traffic have you seen" with a constant, so the game decided the network had been silent since boot and scaled movement to zero on the first frame. Looking up and down still worked, because that isn't one of the three fields the scale touches. The fix returns a real byte count. One match then carried both legs at once on one binary: one instance with the fix, one with it deliberately off.

*How:* sceInetInterfaceControl code 0x200 now returns a live monotonic byte count instead of a hard-coded zero.

*But:* an hour and 46 minutes earlier a different commit had announced the cause, and it was wrong: three calls matching three dead controls was a coincidence, withdrawn the same day. Both facts that disproved "stuck at the start" (the round clock kept running; look worked) had been sitting in the same paragraph as the claim the whole time.

`Cited:` `334c990` VU1 build gates and the first two-instance gameplay on it · `89d7032` pad-state injection, exact holds · `0421048` net trace counts sends/receives and hex-dumps peer packets · `79c0e91` peer packets decoded, 22-byte reliable channel acked at 1/s · logs/parity/ours_match_play5/ · logs/parity/match_play5_sheet.png · `4114ad4` the gate is named -- multiplayer zeroes the local player's three movement axes · `abf35bb` sceInetInterfaceControl code 0x200 returns a real RX byte count · `5ed29ca` same-binary A/B proves the fix both ways · run ours_task6_fix2 · docs/research/18-online-round-start.md

### 2026-09-12 - The project starts writing down what it got wrong

**Five beliefs died by measurement in one day. So they were written down where they'd been read.**

KNOWN.md is a living list in four parts: what's proven and by which artefact, what's only believed and which experiment would settle it, what was retracted, and what will bite again. On the day it was created it already carried six dead sentences, among them that the console showed the same frozen match ours did, that the online round was waiting for a go, and that a higher render scale would sharpen the HUD. The next night the retracted sentences were struck in place, inside the documents where fresh sessions were still reading them, rather than quietly deleted. One follow-up commit is titled "I broke my own rule".

*How:* the rule adopted the same night: cite item names and dated entries, never file-and-line, because line numbers rot the moment anyone edits above them.

*But:* the file's own first note admits its first three retractions were still false in the tree hours after being disproved. The rule is retract on discovery; the practice was close-out, a day late.

`Cited:` `2d9f73a` KNOWN.md -- what is proven, what is believed, what was retracted · `bacfbb8` S0 -- PCSX2 does NOT reproduce the round-start freeze · docs/KNOWN.md · `0129bb9` four sentences this sprint disproved, corrected in place · `95ecb21` the consequences of a retracted claim, not just its headline · `a1e168b` I broke my own rule · `b2a74dd` changing the health default did not fix the false PASS · `85aa476` retract "kill3 lost its second mover" · `07ffc0a` sceGsSetDefDBuff reads ztest/zpsm/clear from $t0-$t2

### 2026-09-13 - Frostfire gets its ground back

**On one map both players froze where they spawned. The ground was there. The game couldn't find it.**

The game asks every frame whether there's ground under your feet, and online it stops you moving if the answer is no for 0.6 seconds. On Frostfire the answer was always no. The level's ground pieces had been filed into the lookup grid at the coordinates they hold before being moved into place, so every check searched the wrong squares. One missing constant: a hardware register that's always (0,0,0,1) on a real PS2 read as all zeros on every thread but the main one, and the level loader runs on another thread. After the fix both players moved for a full 302-second round and the ground check hit on every one of its 1332 and 1428 calls.

*How:* R5900Context() zeroed VU0's vf0, so vmaddw.xyz vf9, vf7, vf0w in the bounds transform silently dropped the translation term.

*But:* two earlier explanations were retracted on the way: a leftover "ghost" byte (the chain is real; it never fired) and an exhausted lookup grid (503 nodes used, 7689 free). And the fix rested on one usable run until the kill session below supplied a second.

`Cited:` `b625291` vf0 is the hardware constant (0,0,0,1) on every guest context · `aa91a53` the ground models were gridded without their translation · `3f9a100` launch 3 -- the vf0 fix restores Frostfire online control · logs/run_A_20260913_115809.log · docs/research/21-frostfire-control-handover.md

### 2026-09-13 - The single-player mission stops freezing

**A frozen picture with a running clock isn't a hung game. It's a queue.**

In single-player the game thread recorded drawing commands faster than the graphics thread could replay them, and nothing pushed back. The backlog grew from 275 MB to 13 GB in four minutes; the picture updated once every 5 to 25 seconds while the game underneath ran normally. The game thread now waits at its own frame boundary whenever more than three frames are recorded but not drawn, capped at two seconds. A full mission afterwards peaked at 299 MB and never hit the cap.

*How:* the wait sits at the recorder's VBlankStart, not in Present, because Present already runs on the graphics thread.

*But:* the first version of the brake latched shut (a busy but healthy graphics thread looked stalled), fixed in review the same day. And back-pressure means the game slows when the host is busy, which made the parity gate sensitive to whatever else the PC is doing.

`Cited:` `aedd9ff` the single-player gameplay stall is an unbounded GS command backlog · `8281254` bound the GS command backlog -- the EE waits at VBlankStart · `7448601` back-pressure caps consumer silence, not replay time · gate s5_gsbp

### 2026-09-13 - The first kill

**"socomc fragged socome with M4A1." Then twice more in the same lobby.**

Two copies of the game logged in to the project's own server, met on Frostfire along a route picked by arithmetic rather than by eye, and one shot the other. Round 1's kill landed 99 seconds in: the victim's health went 1.0 to 0.298 to 0.0, the killer's burst had landed 0.59 s earlier from 28 units away, and both screens carried the killfeed line within a third of a second. Rounds 2 and 3 killed too. Every bar for what counts as a kill had been written down and committed before any of these matches were scored.

![Both screens of ladder launch 2, round 1, a third of a second apart: the killer's on the left, the victim's on the right, the same killfeed line on each.](docs/story/img/2026-09-13-first-kill.png)

*How:* two independent readers, one watching the actor's health field and the other replaying the round's own state values, had to agree before a round counted.

*But:* one launch, one map, two scripted copies on one PC against a server on the same PC. The kill count stepped on the killer's side only; what moved on both was the victim team's alive count. Round 4 fired 111 bursts at an aim error that never corrected and killed nobody.

`Cited:` `811b886` THE ACCEPTANCE TEST PASSED -- Sprint 5 ladder launch 2 · `5f1de26` first online kill -- ladder launch 2 round 1, both screens tiled · `171290b` match the exact route-no-time tag · `d9b5f33` (2026-09-14) pin the acceptance PASS -- ladder launch 2 round 1 fixture · run s5_t5_ladder2 · docs/archive/sprints-1-6/2026-09-13-sprint-5-control-readout-and-first-kill.md · docs/research/22-kill-readout.md · docs/research/assets/22-first-kill.png

### 2026-09-14 - Two things the owner spotted

**The owner looked at the test frames and saw two things nobody had been looking for.**

Work stopped to chase what a person noticed in the screenshots: grey shards where Seeding Chaos should have water, and a single-player teleport whenever the player turned. The teleport got a confirmed cause. A graphics stub multiplied an address that was already a block number by eight, so seven parking slots in video memory collapsed onto two, and the game's animation clips were overwritten with the wrong chunks while the mission loaded. Fixed the next day: a memory dump 255 seconds into a mission came back with 0 of 8 animation chunks damaged, where every earlier dump had 5 of 8. The water got a cause too, published at 13:39 and refuted by its own author at 13:46, when the shards turned up identical with the depth test switched off entirely.

![A gate frame from the 12th, two days before anyone looked: the first mission's spawn with the HELP pop-up up, and at the bottom left the clipped terrain, a black wedge where the ground should be. The owner spotted it in frames like this one.](docs/story/img/2026-09-14-the-clipped-terrain-the-owner-spotted.png)

*How:* libgraph's vram_addr is already the BITBLTBUF block field, so sceGsExecLoadImage and StoreImage must not scale it.

*But:* the water shards had been sitting in every gameplay test frame for three sprints with no check flagging one. The real cause took two more days and two more theories.

`Cited:` `b09227f` the single-player turn teleport is corrupt animation clip descriptors · `3220e68` record the paused investigations · `3028bf8` the x8 GS block-pointer cause is independently confirmed · `5655f5c` the depth-quantisation theory for the grey water is refuted · docs/research/25-sp-teleport.md · docs/research/26-water-polygons.md · `a81eb74` the libgraph vram_addr is the BITBLTBUF block field · `docs/KNOWN.md` · `logs/parity/gate/s6_blockptr/summary.txt`

## 2026-09-15 .. 2026-09-17 - Light, sound and a launcher

*By the 17th, on the owner's PC, the game starts from a launcher, runs the first mission with an Xbox pad, draws at the brightness a console draws, and makes sound. "Online" still means two scripted copies on one PC.*

### 2026-09-16 - First hands-on session, and the controller work begins

**The first time a person played the PC build instead of a script, and the first evening's notes set the order of everything after.**

Until now every run of the game had been driven by a harness. This evening someone sat down and played it, keyboard first, and the Xbox pad went into the game's input path the same night: sticks, face buttons, shoulders, D-pad, with a fifteen percent dead zone. Two things came out of that session and set the priorities for the week: there was no sound at all, and a flat grey patch of hillside came and went in the first mission. The order after that: water and ground, then the untried online maps, then hardening, then audio, then the launcher.

![The flat grey hillside the owner saw in that first sitting: the ground drawn without its brighten pass, the water a set of dull slabs.](docs/story/img/2026-09-14-grey-hill-before.png)

*How:* every automated run sets PS2X_HOST_GAMEPAD=0, because a configured pad makes the game skip the configuration screens the check keys on at boot.

*But:* the session cost three automatic runs: free play saved a controller config onto the memory card every check booted from, and the transition stage stopped seeing the dialog it watched for. Each stage now boots from a fresh copy of a pristine card.

`Cited:` `7eed518` the owner plays (gamepad, no sound, grey hill) · `6d05b18` host gamepad in the SOCOM input path · `8f3f3be` score the transition by content, boot from a pristine memory card · `93e3639` the owner's order of 2026-09-16 · `docs/STATUS.md` · `docs/research/31-flat-grey-geometry.md`

### 2026-09-16 - Every frame was 1.73 times too dark

**The grey hill in the owner's screenshot was three separate bugs, and one of them had been dimming every frame of the game.**

SOCOM II finishes a frame by drawing it back over itself to brighten it. The renderer mapped that step to "do nothing", so every gameplay frame came out 1.73x too dark, and the water's dark bed pass, the thing brightening exists to lift, stayed a set of flat grey slabs. Underneath, the exposure meter was being fed a constant mid-grey instead of real pixels, so it asked for no brightening at all. The holes in the ground were a third thing: a drawing program that needed more cycles than its budget allowed was left half-finished, and the next chunk resumed it from the wrong place, so a patch of terrain drew two polygons instead of twenty-eight. Which patch depended on how busy the machine was. That's why the hole wandered.

![The same recorded frame after the brighten pass was restored. Same scene, same camera. The difference is the whole bug.](docs/story/img/2026-09-16-brighten-fixed.png)

*How:* the backend had mapped the brighten-by-redrawing pass to nothing; the terrain cut came from a program left half-finished when the next started, where real hardware waits for it.

*But:* third explanation for those shards. The first (depth precision) died in an hour: depth test off, shards identical. The second is superseded here too, and one piece stays open: a flag-timing difference that decides which objects take the clipped path.

`Cited:` `3d37abc` the GL backend dropped the game's full-frame brighten · `545b85a` the auto-exposure readback answered from GS memory instead of a grey pixel · `c63729d` the VIF's MSCAL/MSCNT finish a pending VU1 program · `c539603` the terrain holes are EE draw-list omissions · `c7eb121` the water shards run to ground · `docs/research/31-flat-grey-geometry.md` · `docs/research/26-water-polygons.md` · `docs/research/assets/31-console-dump-gl-replay-fixed.png`

### 2026-09-17 - The game stops running in slow motion

**A round would start, the clock would count down, and nobody could move. The renderer was eating most of every second.**

The brightening fix had a cost nobody saw for a day: it minted a fresh id for every palette the game loaded, and SOCOM II alternates palettes on consecutive draws. An online round reached 55,483 cached textures and 64,000 uploads a second; the render thread fell to two fps and the game's clock crawled at 0.04 seconds per real second. STARTING ROUND sat on screen and never cleared. Keying palettes by content put the cache back to 292 entries and the round back to 43-45 fps. The other half was older and quieter: since the 8th the game's timers had been told to ignore time spent drawing and waiting for the renderer, about 195 and 290 ms out of every second, so the whole game had been running at roughly two-thirds speed. It counts wall time now.

*How:* a bisect over four of the project's own launches found the regression; the old behaviour survives behind PS2X_CLOCK_EXCLUDE=1 for an A/B.

*But:* the clock change's own run failed the transition stage, because that stage's black-frame floor had been calibrated on the slow clock. Recalibrated, test first. The freeze it fixed was the project's own regression, one day old.

`Cited:` `42b2b50` CLUT snapshot ids keyed by palette content · `8238ee1` the guest clock follows wall time · `docs/research/34-online-round-freeze-clut-serials.md` · `logs/parity/gate/s6_clutfix_gate/summary.txt` · `logs/parity/gate/s6_clock_gate/summary.txt` · `logs/parity/ours_control_frostfire_clockoff`

### 2026-09-17 - Twenty maps in one night

**Between a quarter past midnight and a quarter to five, every online map nobody had tried got a round of its own.**

A queue ran one round on each of the twenty untried maps: two copies log in, one hosts, the map is picked by name, both walk their route, nobody shoots, the round runs to its clock. Seventeen played first time and The Mixer on a retry. Two didn't: Foxhunt, whose walking player stepped off a 110-unit drop and took fall damage, failing the harness's own no-damage check, and Requiem, where the joiner's movement came out under the bar. Requiem fell out first, on the morning's clock fix: its 13-unit hold became 128. It had never been a Requiem problem. Foxhunt needed the afternoon: the driver learned that a sudden height drop is a fall, not damage. Then all twenty played.

![How a map is chosen without counting presses: the driver matches the highlighted row against a reference and only then confirms. This is Foxhunt, the map that needed the fall guard.](docs/story/img/2026-09-17-foxhunt-map-select.png)

*How:* the map is confirmed by matching the highlighted row against a reference image, not by counting presses down a scrolling list.

*But:* a control round is a scripted no-kill walk between two copies on one PC against a server on the same machine. Only Frostfire has a route that ends in a kill.

`Cited:` `d2a9a55` control rounds on every untested online map · `99eb304` Task 6b sweep -- 18 of 20 play · `aba04e2` a height drop is a fall · `632d2c2` Foxhunt's control round settled · `8238ee1` the guest clock follows wall time · `logs/parity/online_control_summary.txt` · `docs/research/33-online-map-coverage.md` · `logs/parity/ours_control_foxhunt_guard` · `logs/parity/ours_control_requiem_clock`

### 2026-09-17 - The game has sound

**It had never made a noise. In one day it got effects, voices, mission music and a title theme.**

Four steps. A host mixer that runs the game's little sound scripts and its synth voices, so the menu clicks land. Then mission voice-overs and music, read straight out of the disc image. A 32-bit file seek had been failing silently past two gigabytes, which is why no mission stream had ever played. Then the title music, which the game decodes itself into a ring the sound hardware plays: nineteen instrumented runs to get right, because the first fix stopped the decoder when the game refused a packet, and this game treats a short read as "finished" and then polls an empty decoder 340,000 times a second. With the decoder always taking its whole input, the output matched the disc's audio at a correlation of 0.99, and a fourth fix took the title loop to 1.000.

*How:* refused audio is copied aside and re-offered in order before newer audio, so nothing is lost and nothing stalls.

*But:* all measured against the disc, not heard. The owner's verdict partway through: "still nowhere near accurate; the opening video seems okay; mission audio good". The first ten seconds of each stream still filled short.

`Cited:` `92ac6a0` first sound -- 989snd bank sounds play through a host mixer · `cb0f455` the mission's voice-overs and music play · `52125e6` the title music plays · `4478bff` the title music is clean · `75fe03d` the title screen plays the disc's PCM sample for sample · `5a1b6a8` a plain sceCdRead no longer moves the CD stream cursor · `docs/research/32-audio-path.md` · `docs/STATUS.md` · `logs/parity/gate/s6_audio_title19/summary.txt` · `logs/audio_title19.wav` · `logs/parity/gate/s7_audio_title`

### 2026-09-17 - A launcher, and a folder you can copy

**The project got a front door, and the same day an audit said a stranger still couldn't get through it.**

The launcher is a small window that owns the settings file. It reads the disc image you point it at, hashes the game's executable inside against the r0001 digest this recompilation was made from, and keeps Launch off until it matches. Picture size and sharpness, the pad drawn live, a profile and a server, and a diagnostics folder when something goes wrong. A script turns a build into a 285 MB folder and a 63 MB zip. Then four read-only reviews were run against the project's own goal sentence, and the verdict was blunt: the game plays and nobody else can get to it. The launcher never handed the game the disc it had just verified; a server given by name was silently thrown away; the server advertised the developer's home-network address to anyone who connected. All fixed the same day, and the next sprint opened on the same theme: a PC whose graphics driver can't do what the renderer needs now gets one line naming what's missing and falls back to the CPU renderer instead of a black window.

![The launcher's first cut: a disc path, three picture settings, a drawn pad, a server and a profile, and a Launch button that stays off until the disc matches.](docs/story/img/2026-09-17-launcher-first-cut.png)

*How:* the disc check walks the ISO 9660 root directory for SCUS_972.75; the GL capability probe reads the version, dual-source blending and clip control once and latches the answer.

*But:* nobody had tried the launcher by hand, and the zip had never run on a clean machine. The audit's biggest gap was left alone: every online result was two copies on one machine behind one router.

`Cited:` `770d5fb` SOCOM Unzipped launcher, first cut · `2a8f8e4` scripts/make_portable.sh -- the portable folder · `docs/STATUS.md` · `logs/parity/gate/s6_launcher_gate/summary.txt` · `logs/launcher_server_picker.png` · `docs/research/assets/launcher-first-cut.png` · `09b793a` the 2026-09-17 audit and code review · `fae7d0e` the audit's fix wave · `32aec0b` Sprint 7 opened -- two strangers, two machines, one hosted server · `a843385` the stranger's machine, defensively · `39cd17f` equal-priority guest threads are never time-sliced · `docs/audits/2026-09-17-audit-and-code-review.md` · `logs/parity/gate/s6_fixwave_gate/summary.txt` · `logs/parity/gate/s7_gl_gate/summary.txt` · `logs/parity/gate/s7_gl_gate2/summary.txt`

## 2026-09-18 .. 2026-09-20 - Linux, a server, a stranger

*A player with their own disc can unzip a 56 MB download, start the game on Windows or Linux, save to a memory card, report a bug from inside it, and play online against a server the project hosts in Ohio. As of tonight, against a console player in the same lobby too. Only the owner's PC has done any of it.*

### 2026-09-18 - The launcher learns your pad

**The front door stopped assuming everyone owns the same controller.**

A list of the pads that are plugged in, the chosen one drawn live as you move it; a frame-rate line; detail, resolution and volume; a microphone. One pad selection and one dead zone now serve all three places in the program that read a controller. Before this every one of them took the first pad it found. The same day the online sprint merged, carrying the fix that finally made driven online runs reliable: the automated lobby had been reaching gameplay 6 times in 10, and went to 10 in 10.

*How:* the harness's 90 ms press was falling between two polls of a login screen running at 12-30 fps; a 2 ms sampler now latches every press until a poll has seen it.

*But:* the pad settings are proven by tests and one scored run. Nobody has held a real pad and said they feel right.

`Cited:` `206de19` Goal 8, the launcher a player expects · `6b7a2b3` injected pad presses are latched, never dropped · `d270022` Merge sprint-7 · logs/parity/lobby_rate_summary.txt · `78a81d1` verify-then-act on every fixed press · `d6e417f` every press on the boot-to-lobby path is verified · `ebf13be` burst-to-burst aim correction in the route endgame · `431499b` the kill repeats on the block-pointer exe · `4a9179f` the evening's seven launches, one dropped press each · `d05db14` the night's online launches · `logs/s6_ladder8.done` · `docs/research/28-lobby-taxonomy.md` · `docs/KNOWN.md`

### 2026-09-18 - The sound reports run to ground

**The owner said the sound stopped halfway through a mission. It had.**

Three complaints from one evening, three faults. Sound dying mid-mission was a playback slot never handed back: after six plays every request failed, 237 times in the owner's log. The splice and the buzz in the online menus were a ring buffer with no agreement about who had filled what. The biggest sat under both: a routine the game calls whenever another part of it starts up was resetting the entire sound model, unloading the sound banks that had just been loaded. 971 rejected plays in one log. A second driven mission took those to zero unknown banks and one slot exhaustion.

*How:* sceSifInitRpc reset the IOP model on every call rather than only the first, and a stream that ended by itself never freed its slot.

*But:* measurements of a driven mission, not a listen. The owner's verdict the next day was still no.

`Cited:` `b3e3797` the owner's sound reports · `23a860d` sceSifInitRpc no longer wipes the IOP model on every call · `acc3310` audio_corr --repeat

### 2026-09-18 - The game runs on Linux

**The owner asked for Linux in the morning, offered a spare VM, and by evening the game was drawing frames on Ubuntu.**

An Ubuntu 24.04 machine, a build job on GitHub's Linux runners and the port itself landed the same day, under one rule: the Windows build stays byte-for-byte the same. The boot frame in the VM differs from Windows by 0.008 grey levels; the title check passes there at Windows' own 19 of 23. The first time the C++ suite ran on Linux it paid for itself: the system allocator aborted on a double free in the audio mixer that Windows had been tolerating for the life of the project.

![The first thing the game says on Ubuntu, inside the virtual machine: the same controller prompt Windows shows at boot, drawn by the software renderer.](docs/story/img/2026-09-18-linux-boot-dialog.png)

*How:* a refused stream header closed its file twice (two owners, one handle), fixed under a test that fails on Windows too.

*But:* every Linux number came from a VM on a software renderer at 0.8 to 2.9 fps. No real Linux machine or GPU has run it.

`Cited:` `2aa02c3` the Linux client, part one · `8f8981c` a refused stream header closed its file twice · `955c010` the gate's title stage runs on Linux · `9e70730` (2026-09-19) the tree sync re-stamps what it changed · logs/parity/vm/s8_vm_title5_summary.txt

### 2026-09-19 - The menus stop dropping frames

**The planned fix was thrown out by the measurement that was supposed to justify it.**

The login and lobby screens were the expensive part of the program, and the plan was to batch draw calls. A new trace split the cost term by term and put it somewhere else entirely, so the batching was never built. The texture cache was re-decoding itself every frame: any upload anywhere moved a counter, and a moved counter threw the whole cache away. Cached textures now check themselves against a hash of the bytes their decode read. Lobby decodes went 1331 a second to none; with four cores of the host deliberately busy, the login screen holds 58-60.

*How:* on a stale counter the same decode walk runs over current memory, and a matching hash re-stamps the entry instead of decoding it.

*But:* measured on the login screen and in the lobby, not in a mission. There's still no steady gameplay frame rate on a clean host.

`Cited:` `d238135` PS2X_GS_UPLOAD_TRACE -- the upload path's cost split per term · `4cd42b4` Goal 2 stopped by its own measurement · `759e218` cached textures revalidate by a hash of the bytes their decode read · `06f4072` the login screen holds 58-60 fps under a four-core load · docs/KNOWN.md

### 2026-09-19 - It can save, and it can hear you

**Two things every finished game has, and this one didn't.**

The owner tried to save and was told no memory card was inserted. The card stub had never created or even looked at a card folder. Now the first port always holds an inserted, formatted card whose folder is made on demand, free space is counted from what's actually there, and a guest path is checked one component at a time. The tests found a climbing path really did write outside the card root on Windows. A driven save wrote 12 files and 3020 KB to an empty folder, and a second launch read the profile and seven saves back with no prompt. The headset was the other one: the program answered the game's status question with the wrong number, so the game had never opened the microphone.

*How:* every call merges the reply into one status word and the voice tick reopens only on a merged word of exactly 1; the program had answered 3, then 2.

*But:* no voice has ever travelled. All sixteen pad buttons were held for three seconds each in a live round and nothing started recording. The talk action isn't bound in the control preset the disc loads.

`Cited:` `cef8d83` an empty or missing card folder is an inserted, formatted card · `c753808` a driven save on an empty memory card · `94937ec` the host microphone reaches the game's headset module · `79a9e26` the headset's status word · run s8_save_yes · run s8_save_second · run s8_voice_round4 · docs/KNOWN.md

### 2026-09-19 - The launcher gets a face

**Until now the front door was a box with some checkboxes in it.**

A rail of pages (PLAY, DISC, VIDEO, AUDIO, CONTROLLER, MICROPHONE, ONLINE, ABOUT, and REPORT A BUG by the end of the day), one focus model that behaves identically for keyboard and pad, open-licence type embedded in the executable so the folder stays self-contained, and a controller drawn from scratch whose buttons light up as you press them. A screenshot mode renders every page from a fixed fake state, so the work can be looked at without launching anything. A second pass answered the owner's notes: legible type at every size, a frameless window with its own top bar, a palette sampled from the SOCOM II logo.

![The redesigned launcher's CONTROLLER page, rendered by its own screenshot mode from a fixed fake state: the rail, the drawn pad, and what each button will mean to the game.](docs/story/img/2026-09-19-launcher-controller-page.png)

*How:* the one-frame flash on every page change was the frame being drawn from the old page's node list, so every label landed at the origin for a frame; the list is rebuilt after the page changes now.

*But:* proven by tests and by screenshots the loop reviewed itself. The mouse support it advertises is scheduled to be deleted.

`Cited:` `a8350cd` Sprint 8 spec, Goal 9 -- the launcher redesigned · `4c7a190` the launcher redesigned -- a rail and pages · `841d080` the owner's feedback pass · `dafb724` a preset whose address is still a placeholder is unavailable · `1966fa6` the page-change flash is a stale node list · run launcher_ui

### 2026-09-19 - A server of its own, on the internet

**Every online round the project had ever played was against a server on the same desk.**

A small rented machine went up in Ohio with a static address, start-up units, an installer and a control script that rewrites the advertised address everywhere it appears. The launcher's SOCOM Unzipped entry stopped being a placeholder and became the default. A control round ran to its clock over the internet, both round clocks in step to the second, and a ladder took two kills in four rounds on one lobby session. The server also learned to introduce itself: a message of the day, a channel name and a location that are settings rather than constants, with live statistics served for the project's site.

![Round 1 of the hosted ladder, from the host's side, moments after the kill: the first round ever played against a server that was not on the same desk.](docs/story/img/2026-09-19-hosted-kill-round-1.png)

*How:* an unattended upgrade restarted the stack mid-round, so the box is now told never to restart those units.

*But:* both players were driven copies on the owner's one PC behind one home network. Saved personas are keyed per server, so the box's address is load-bearing: move it and you risk orphaning every one.

`Cited:` `9bf44a9` the hosted Horizon server on Linux · `aa2b7f4` the SOCOM Unzipped preset is real · `52bd232` needrestart never restarts the Horizon units · `ff514f7` a first-time login · `6d31d06` the hosted server is listed by the launcher and was played on · `36559f8` the message of the day, the channel and the location are configuration · run s8_hosted_control2 · run s8_hosted_kill

### 2026-09-19 - It says why it won't start, and it weighs less

**A new sprint with one narrow question: what happens to somebody who has never seen this before.**

Every way the program can refuse now has a number and a plain sentence, shared by the runner, the launcher and the test suite. Started with no launcher at all, the runner reads the launcher's own settings. The LAST RUN line says what happened in words, and SAVE DIAGNOSTICS writes one scrubbed zip. Then the download was measured instead of guessed: a release build in its own tree, both executables stripped with their symbols kept beside them, and the folder cut to what the executables actually import. 15 of the 31 shipped Windows libraries were needed by nothing. The zip came down 15 percent to 55.7 MB, and the gate passed 3/3 on that exact stripped executable.

*How:* an import-closure auditor reads both platforms' import tables in pure Python and writes SHA256SUMS beside each archive.

*But:* the download is unsigned, so Windows warns anyone who runs it. Two promises are believed, not proven: that a double-clicked exe lets go of its console window, and that a missing audio device is reported on screen.

`Cited:` `bbc98ad` the exit-code taxonomy in one header · `6f9996d` a failure explains itself · `434bc3e` SAVE DIAGNOSTICS writes one zip · `8bec122` portable_audit -- PE and ELF import readers · `b3e7906` the portable folder carries the import closure and nothing else · `645ca27` the candidate's zip is 55.7 MB (-15%) · gate s9_g2_release_gate

### 2026-09-19 - A way to report what went wrong

**The only place in the whole program where a player can talk back.**

A REPORT A BUG page joined the rail, mirroring the form on the project's website: a title, what happened, an optional way to reach you, and a preview that says exactly what SEND would send. Attaching the last run's log is off by default; when it's on, the log is cut to 64 KB and scrubbed of your home folder and the folder your disc sits in. The ONLINE page gained a line that asks the server how it's doing every ten seconds. Five answers a server can give were driven against a local one in eight tests, on Windows and on the Linux job.

*How:* WinHTTP on Windows, a curl subprocess on Linux, certificate checks on; plain http is refused anywhere but loopback.

*But:* exactly one real report has ever been sent, from Windows. The project's own notes briefly recorded it as unevidenced, because the id is stored lower-case and shown upper-case, and the inbox mirror was 35 minutes stale. Found the next day.

`Cited:` `778ebcb` the bug report's pure half · `b34ef2d` REPORT A BUG on the rail, after ONLINE and before ABOUT · `ec773ee` the REPORT A BUG page, the ONLINE status line · `c3faf9a` the bug report's JSON reader builds under libstdc++ · `61fe083` Goal 8's live proof exists after all · docs/KNOWN.md

### 2026-09-19 - The things the owner actually noticed

**Not one of these came out of a test. They came out of somebody trying to play.**

Escape closed the game instead of pausing it, because raylib's default exit key had never been turned off; it's Start now. The Runtime Debugger opened over the game on every launch, for everyone, because it defaulted to visible. A PC pad could never crouch: SOCOM II reads how hard Triangle is pressed, and the pad reported every press as full, so the button could only go prone. And while a mission ran the launcher was still reading the pad behind it, so the aiming stick was walking a focus ring around a window nobody could see, and Start was asking for a second launch.

*How:* every pad reading in the launcher now passes through one pure gate that's the only thing which knows the game may own the pad.

*But:* the pause key has no test of its own; it needs a window. The crouch shortcut and the pad gate are proven by tests and unproven by hand.

`Cited:` `8bf72c5` Escape no longer closes the game; it is Start · `2d0463f` the Runtime Debugger starts closed · `c64373a` a crouch shortcut · `3b12fa4` while the game runs the pad belongs to the game · `54d77a2` snd_AutoVol is a timed ramp and reaches streams · `eca5450` a stream played with a parentHandle queues behind the playing one · run s9_p1_m51_audio2 · gate s9_p1_gate

### 2026-09-20 - The first build made for a person to play

**Building it found two bugs that would have shipped. Playing it found the one the whole sprint was for.**

The last code change before the candidate pointed the launcher at socom.scotho.com by default, with the raw address kept as a fallback. Then the candidate was packaged, gated 3/3 on the exact executable inside the archive, and tagged playtest-1: a 55.8 MB zip with its own checksums. It took longer than the hour it was given. The archive wouldn't build, because the bug-report feature had given the launcher a dependency on a Windows system library the packaging allowlist didn't know, and the check only runs when a release is packaged. Then the archive came out 7 MB heavier than the sprint had measured: a decision made six days earlier to build at the lower optimisation level, because the higher one made a larger download, had been written in three documents and applied in none. Both fixed under tests watched failing first. Then the owner sat down with the archive and the fourteen-step script, and stopped at step six. The mission music. Same symptoms as before, with all three of the week's music fixes in the build.

![The playtest candidate in the first mission, at the end of the gate's scripted walk, with the game's own stance tutorial up. This is the build the owner played that evening.](docs/story/img/2026-09-20-playtest-mission.png)

*How:* the trace the fixes were built on showed the mission never queues a stream at all, so the fixes were protocol-correct and inert; the fault was never reproduced by any instrument before it was declared fixed.

*But:* the packaging failure is the one to remember: the build script had already emptied the folder it was about to refill, the packaging step then refused, and the previous archive, twelve hours old and looking perfectly normal, stayed exactly where it was. A tag on that folder rather than on the run would have shipped it with no symptom.

`Cited:` `b723a5d` the project's server is reached by name · `80b1971` socom.scotho.com exists -- a DNS-only A record · `67c0182` P6's persona measurement was the wrong question · docs/PLAYTEST.md · docs/CURRENT_SPRINT.md · `210cb78` the playtest candidate could not be packaged and was built at the optimisation R151 rejected · gate s9_p7_playtest_gate · docs/KNOWN.md

### 2026-09-20 - The music, chased to the speaker

**Every audio measurement the project had ever made ran on a wired endpoint. The owner listens on a Bluetooth speaker.**

Four hours of measuring instead of reading. Recording what Windows actually sent to the owner's JBL Flip 6 during a driven mission, next to the mixer's own output: in one minute the mix dropped out twice, the speaker 42 times, and the emulator on the same speaker zero. raylib opens the device at 10 ms periods, three of them, and under load the device thread misses that deadline about forty times a minute. The runtime now opens its own device at 20 ms x 4: same minute, same speaker, 42 down to 2. The numbers found three more on the way: every music cue was playing 2.3 dB to the right (a sign bit dropped from the pan word), the game's positioned voice lines were starting at volume zero and never being turned up (SetSoundParams never reached a stream), and stream underruns had never been counted anywhere. Ruled out by measurement, not argument: the three fixes from earlier in the week, the reverb, loop flags, master-volume writes.

*How:* a WASAPI loopback of the default endpoint under the driver, scored beside the mixer's dump; the device spec is pinned by a test that was watched failing at "got 10 / got 30 ms".

*But:* the owner listened again an hour later: better, not done. "Stuttering, skipping a bit" walking to the first enemies, and two segments at once in the briefing. The rest of the night is the next entry.

`Cited:` `c611ad6` the mission music, investigated to the speaker · `7c0620f` R177 -- the mix device buffer · gate s9_q0_device_gate · gate s9_q0_trace_gate · docs/archive/sprints-7-12/2026-09-20-sprint-9-q0-mission-music-investigation.md

### 2026-09-20 - An audio parity test, and the sound that was never there

**The owner asked for an audio version of the picture test. It found something no ear had named.**

The picture gate compares our frames to the console's. The new check does the same for sound: a loopback recording of the whole path to the speaker while the driver plays a step script on either target, one score per step window (level, silences, holes, splices, envelope wobble) against a console capture pinned as the reference. Its first verdict on ours was 10 of 48 windows within tolerance, and the honest windows said something specific: at the mission start the console holds a continuous floor of sound where ours is silent 69% of the time. That floor isn't a stream. It's one sound the game plays once at mission load and polls all mission long: a conductor of child sounds, driven by a register the game writes every frame, with markers and a loop. Our mixer skipped every grain type it uses. Modelled from the open 989snd reference and pinned by tests on the real block cut from the disc: the wind, the birds and the insects exist now. 10 of 48 became 31 of 48, with no mission window silent. Later the same day a reading of the original sound driver found why stems ever skipped: on the console a finished stream still answers "playing" until its slot is retaken, and the game's music manager queues the next stem on that answer. Ours answered "done", the manager dropped its cue, and every next stem began fresh or late.

*How:* scripts/parity/audio_parity.sh capture <pcsx2|ours> <stamp>, then compare; the conductor's grains (START/STOP_CHILD_SOUND, register tests, markers, loops) are modelled from open-goal's 989snd.

*But:* the bed plays 7-12 dB quieter than the console's, the logo movies' audio is about 18 dB low at the source, and the still-playing fix is in verification as this is written. The owner's ear closes this, not a number.

`Cited:` `19ae5f6` an audio parity check against the console · `842174c` the mission ambience is a CONDUCTOR sound · `77d5522` a VAG stream that played out still answers snd_SoundIsStillPlaying · gate s9_q0_children_gate · scripts/parity/audio_parity.sh · docs/archive/sprints-7-12/2026-09-20-sprint-9-q0-mission-music-investigation.md

### 2026-09-20 - Version 0.9.0, and a robot that plays every night

**Sprint 9 merged to main and got a tag. Then a scheduled job started playing rounds against the hosted server on its own.**

The sprint that started as "a stranger's first run" closed with the playtest's verdict still open on the music, and the rest of it done: the release build, failures that explain themselves, the launcher finished, the server by name. Merged to main with a merge commit, tagged v0.9.0. The same morning a Windows scheduled task learned to run ladder rounds unattended and write a ledger. Its first two runs failed to create a game. The title matcher had the channel name "Channel 1" baked into its reference, and the hosted box says "US East (Ohio)". Fixed on the title words, and run three was KILL 4/4.

*How:* scripts/ladder_job.sh under the loop lock, tools_py/parity/ladder_ledger.py for the ledger, docs/LADDER.md for the rules; the Task Scheduler entry is created disabled until the owner names a window.

*But:* no GitHub release; that waits on a decision about what can legally ship. The ladder's bar is seven clean runs in a row, and the streak is one.

`Cited:` `4415254` Merge sprint-9: A stranger's first run (v0.9.0) · `19b4270` Sprint 9 closed · `0c20a6a` the first clean ladder row · run ladder_20260920_101741 · docs/LADDER.md

### 2026-09-20 - A console and a PC in the same match

**A PlayStation 2 client and our program, in one game, on the hosted server, both ways round.**

The console side is the reference emulator running the retail disc, driven by the same screen-verified lobby flow ours uses. It presses on what its screen shows, with references cut from console frames where its 7% narrower screen needs them. Leg one: the console joins a game ours hosts. Leg two: ours joins a game the console hosts. Each reached a running round with both players moving, twice in a row. Eleven runs to get there, each failure one specific thing: the narrower screen, the READY label's edges, a 30-second notice, the shared peer port, a host that pressed READY before the join.

![Our program, in a round hosted by the console client on the hosted server: the first time the two have shared a match.](docs/story/img/2026-09-20-mixed-match.png)

*How:* tools_py/parity/pcsx2_shell.py drives PCSX2 through the same step script and the same detectors as ours, over the DNS stub to the hosted box.

*But:* the "console" is an emulator on the same PC as ours, not a PlayStation 2 on a couch. Still owed: each guest's copy of the other's position, so "seen by the other" is measured rather than assumed. And still: no two humans have ever played each other.

`Cited:` `93677a5` the mixed match's leg 1 on the verified flow · `136c635` leg 1 reached · `25690ad` leg 2 reached · `984a342` Sprint 10 Goal 3's bar met · run mixed2_ours_hosts_g · run mixed2_pcsx2_hosts_g · tools_py/parity/pcsx2_shell.py · docs/archive/sprints-7-12/2026-09-20-sprint-10-goal-3-mixed-match.md

## 2026-09-21 .. 2026-09-22 - Public, and played

*The code is public, and a stranger can build it from their own disc in under an hour. The owner played a build end to end and the fixes came out of what they hit. Still: nobody outside this house has played, and the music at the speaker is the open question.*

### 2026-09-21 - Anyone can read it now, and build it

**The repository went public on the evening of the 20th. The next day went on making that safe, and then on proving a stranger could actually use it.**

A leak check now stands at four doors: before a commit, before a push, on the build service over the whole history, and on the release folder before it's archived. It rehearses on 28 planted secret shapes before every scan, and a scanner that didn't run is never a pass. A second, independent scanner reads the same history. Then a fresh clone was made to build on Windows from nothing: a pinned toolchain download of 245 MB, a build in about four minutes on a bare rented runner, the suite green. A licence inventory with a test that fails on any dependency without a row. A release workflow that makes a draft on a tag and never publishes. And the newcomer's path was run for real, from a clone of the public address into an empty folder, every command one the documentation tells a stranger to type: 42 minutes from the clone to the game on screen, about 15 GB of disk.

*How:* tools_py/release/leakcheck.py has six modes and three exit states; gitleaks 8.30.1 pinned by sha256 is the second opinion; scripts/bootstrap_windows.sh pins llvm-mingw, CMake and Ninja by hash.

*But:* a stranger can build the game, not download and play it. That's the owner's order: harden the build first, no easy player setup until then. And an audit of disc-derived bytes in the public tree found five classes of them, sized and listed; whether any of it moves is the owner's decision, not made yet.

`Cited:` `3c06c5d` (2026-09-20) the leak gate in four places -- Sprint 10 reorganized around hardening the now-public repository · `00b0ce3` (2026-09-20) a fresh clone builds on Windows (H3), the suite stops littering the tree (H4), the licence inventory with its test (H5) · `92b92c6` Sprint 10 hardening to main · `110c286` the release-draft workflow (H8) · `eb94301` H7 -- disc-derived bytes in the public tree, five classes and fourteen rows sized · `065bdcc` the newcomer path run from a real clone -- 42 minutes to the game · gate s10_h6_scrub_gate · docs/GIT_STRATEGY.md

### 2026-09-21 - From your disc to a build, in one command

**The one step of the build a newcomer could not do had been run once, by hand, at the start of the project.**

Everything the recompiler needs comes out of the player's own disc: the loader, the encrypted archive, the two code overlays inside it. That path had been walked by hand on the 4th and promised in the contributing guide ever since. Now it's one script: point it at an ISO and it pulls the files, decrypts them, checks every digest against the six the owner recorded the first time, and stops cleanly if any differ. Running it for real, from an empty game folder to a built executable, took 29 minutes and matched the owner's digests byte for byte. Running the whole newcomer path after it found a bug the maintainer's machine could never see: the toolchain bootstrap extracted into one folder and renamed it, and on a fresh clone the rename failed at the very first command a stranger types. Fixed, and the first command finally has a test.

*How:* scripts/disc_to_elf.sh is idempotent and self-verifying, 43 tests; the two decryption scripts became callable so one command could drive them.

*But:* the recompile still reports 114,399 untranslatable instructions, the same number as on the 4th. It's garbage that never runs, and it's still there.

`Cited:` `41eb046` one command from a stranger's ISO to the files ./build.sh recomp needs · `6dfa2c4` merge: agent/disc -- the new-developer build chain closed · `67ff2e8` no rename -- extract each toolchain straight into tools/<name> · `403f593` the first command a stranger types finally has a test · `7e7e1f0` the game build IS supported now -- one command from your own disc, proven from nothing · docs/DEVELOPING.md

### 2026-09-21 - Eleven jobs, eleven worktrees, one gate each

**The most commits in a day so far, 150, and most of them written by agents that never touched the main tree.**

Each job got its own copy of the repository, a bounded brief and a stop rule. The controller merged what came back, rebuilt, and ran the three-stage picture gate before calling anything done. What landed: the gate now records every input it scored against and refuses to score at all if one has drifted. A render stall that used to eat the machine, 1.45 GB of queued commands over 600 frames, is bounded at 67 MB. A test that had been failing on the build service one run in two was fixed at its root, a simulated clock that starved one thread of its turn: 50 failures in 100 runs before, 0 in 300 after. And a console-replay test that had never actually run, runs. Two regressions got through the suite and were caught only by the gate. One was a tidy-up that moved some shared state into one file and quietly made nineteen stubs share a single disc-streaming cursor; the mission never loaded, and the change was reverted whole. The other finding was about the agents, not the code: one pushed to the main branch three times against its brief. The fix is not a stronger sentence in the brief. The next worktree is handed out with no address to push to.

*How:* each chunk ran in its own git worktree on a branch; a merge, ./build.sh runtime and python -m tools_py.parity.gate in the main tree paid for it.

*But:* the suite was green on both sides of the state revert, 764 of 764. Only the gate saw it. And removing the worktrees deleted the toolchain through their folder links, twice, before the order of operations was written down.

`Cited:` `691685d` the gate states what it measured -- PIN lines and pins.json beside the EXE line · `2342d60` a latched stall no longer grows the command queue on its state stream · `c303f74` the simulated Clock runs its threads in lockstep · `99a059c` the console-replay case runs · `955539c` the stub-state header stays per-TU · `1bfc047` the delegation finding -- an agent pushed to main three times against its brief · gate s10_q6_gate · gate s10_q7b_gate

### 2026-09-21 - A stranger's environment can't change the game

**About 150 environment variables could change how the game ran, and nothing said which ones a player was meant to touch.**

Every one of them is now a row in one table with a class: 18 that a player's launcher can send, the rest for developers only. One accessor reads them all, a generated page lists them, and a test fails on a name without a row, a row without a read, or a read that goes around the accessor. Developer settings need developer mode; outside it they read as unset, and the start-up line names what it ignored. Eight settings that switched something on when set to zero became plain flags. The launcher stopped passing on whatever it inherited. Proven by poisoning a launch with every setting at something hostile and watching the gate pass anyway. Found on the way: the start-up line was writing the login password in clear, and a five-letter password slipped under the scrubber's six-letter floor. Same day, the mouse left the launcher and the game entirely, and the keyboard was narrowed to menus and typing for a player. The full gameplay mapping survives in developer mode only, because the harness plays the game through it.

*How:* ps2x::knob is the one read path; --dev or PS2X_DEV=1 is developer mode; the [knobs] line in every log says what was honoured and what was ignored.

*But:* the mouse block that was deleted had never had a test. The count moved three times in a day, 145, 149, 151, as the registry found reads the inventory had missed.

`Cited:` `d76ec8d` the knob registry -- 145 PS2X_* names classified in one table · `1f94bae` docs/KNOBS.md generated from knobs.h · `869356e` a stranger's environment cannot change the game -- Dev knobs need --dev or PS2X_DEV · `2b49124` the scrub redacts PS2X_SOCOM2_LOGIN_PASS at any length · `954154a` Q2 / Goal 3 closed -- 151 knobs classified · `8ff45e7` the mouse leaves and the keyboard is narrowed to menus and typing · gate s9_g3_gating_gate · gate s10_q3_gate · docs/KNOBS.md

### 2026-09-21 - Press a button to bind it, and the game remembers who you are

**The pad's buttons were two tables compiled into the program. Now they're a setting, and the launcher lets you change it with the pad alone.**

On the CONTROLLER page every button of the game has a cell. Press it and the launcher listens for five seconds; the next pad button you let go of becomes the binding, and the drawn pad lights up to show it. Bind a button that's already taken and it asks: swap, replace, or cancel. Restore defaults asks first, and the default answer is no. The game logs a hash of the mapping it was given and the gate pins it. Then the rest of the launcher: the guide button swaps between launcher and game; the game window wears the launcher's name, icon and colours; and the menus click with the game's own sounds, decoded from the player's disc on the first run and cached, never shipped. And the login: the launcher's player name and password now appear in the game's own on-screen keyboard, ready to confirm. That took two findings to work at all. The game's menu calls the keyboard through a tiny forwarding routine the first wrap never intercepted; and once it did, the text vanished, because the wrap's clean-up ran when the game's scheduler unwound the call, before the keyboard had read it. Three logins with nothing typed, and the ladder streak reached four of the seven clean runs the bar wants.

*How:* the mapping is one table resolved from config.json per profile, with today's values as the defaults byte for byte; the four menu cues are the disc's HUDUI bank rendered through the runtime's own mixer.

*But:* the remapping page is proven by tests and screenshots; the owner's hands haven't touched it. The menu sounds were rendered and measured, not heard. And the hold-to-remap gesture the owner would ask for was a day away.

`Cited:` `3d7dd22` Q3b, the mapping data path (R174) · `384dd0d` Goal 8, the controller mapping UI (R174, part 2) · `0acf90b` the window switch -- the guide button swaps launcher and game · `283130c` the game window wears the launcher's name, icon and palette · `0162d71` menu sounds from the game's HUDUI bank, decoded from the player's own ISO on first run and cached, never shipped · `103122a` the on-screen keyboard opens holding the launcher's persona name and password · `2bc56ec` the prefill wrap is installed on the thunk the UI action table calls · `f47cfe0` the prefill buffer is written before the open and never after · `d99dad1` run 4 by hand -- KILL 4/4 on the hosted server · gate s10_g8_gate · gate s10_q4_gate · run s10_g8_control_frostfire · docs/LADDER.md

### 2026-09-21 - One round, on film

**The first kill was on the 13th and came as two stills. This one you can watch.**

Two of our clients on one desk, both on that night's build, both in the same round on the hosted server, both driven by the agent while the owner watched. The whole round, four minutes and a quarter of it, cropped to the two windows and nothing else: the round card, a long circling of the yard, the shot at 3:41, the killfeed on both screens, the scoreboard, and the next round's opening card.

![Round's end, both screens: SOCOM-B on the left has just died, SOCOM-A on the right did it, and the same killfeed line sits on each. Press play for the whole round; the shot is at 3:41.](docs/story/img/2026-09-21-online-kill.mp4)

*But:* it is not graceful. The camera sways, the aim hunts, and the approach takes most of a four-minute round. It is functional: the round ends by a shot, both screens say so, and the scoreboard counts it.

`Cited:` `0eef452` run 2 by hand -- KILL 4/4 on the hosted server · docs/LADDER.md

### 2026-09-22 - The owner plays it, and the save fails the first time

**A new build for one sitting, and the notes that came back were the useful kind: small, specific, and none of them from a test.**

The archive was built the night before, gated on the exact executable inside it and checked for leaks. The owner played it end to end and reported as they went. The pad stopped working in the launcher after a click into a text field, because the only ways out of a field were keyboard keys. A space typed into the player name was shown in the field, saved to disk, and silently dropped before the game got it, so the login failed with nothing on screen to say why. The launcher's default window went back to the game's own 640 by 448. And the one that mattered: on a fresh install the first save failed, and the second launch worked. The build the owner played recorded nothing about it, because a failed memory-card command said nothing at any setting. Fixed first: any failure prints one line, in every build, no setting needed. That line found the bug the same night. The game lists a brand-new card by asking for its parent folder, "..", and our path checker refused that as an attempt to climb out of the card. The game read "permission denied" as a card it couldn't use. On the second launch the save folder existed, the path resolved, and it worked.

*How:* a trailing ".." now resolves to the card's root, which is its own parent; a ".." followed by anything is still refused, so "/../escape.bin" never names a file.

*But:* the first cut of the diagnostics ruling was wrong. It reclassed two developer settings as shipping ones, believing developer settings are compiled out of a player's build. They aren't, and the suite refused the change. Fixing the actual hole, silence on failure, is what found the save bug.

`Cited:` `ffebba2` (2026-09-21) tonight's archive -- built from acbc693, gate s10_playtest2_gate 3/3 on the exe inside the zip · `46a6594` fix wave A (W1-W3, R236-R238): the pad regression, the field accept-set, and a card failure that is never silent · `152579a` finding 3, root cause and fix: the game asks a virgin card for '..' and we answered "card refused" · gate s10_playtest2_gate · gate fixwave_a · docs/archive/sprints-7-12/2026-09-22-fix-wave-playthrough.md

### 2026-09-22 - Hold a button to remap it, and a sound that was never there

**The rest of the owner's notes, and one of the project's own claims that didn't survive being measured.**

The owner asked for a second way to remap: hold any pad button on the CONTROLLER page and the same bind flow opens for it, with hints that walk you through it, a meter that fills as you hold, and a gold ring closing in on the control. Five buttons can't be held, for reasons the code states: the two that move around the page, and three whose press is already spent on tabs and launch. The pad drawing got redone while it was open. The join driver learned that an empty games list is a result of its own and not a failure, after it had pressed JOIN GAME four times into "There are no games to join" trying to reach the owner's lobby. Then the "blop" the owner hears on the online screens. The project's notes had charged it to one sound bank on the strength of a correlation, and the correlation had been drawn by bucketing the owner's log by line number. Log lines are not time. Measured on one clock, with the play commands stamped on the mixer's own frame counter, the bank's one-shots sit 0.2 dB against the music bed. Inaudible. Cleared. What the same instrument did find: over ten minutes on the owner's Bluetooth speaker, 31 dropouts at the speaker that the mixer's own output doesn't contain.

*How:* the new drive script skips the cinematics and reaches gameplay on the existing boot chain minus about 50 seconds of dead wait; audio_dips classifies each dip as DEVICE, STARVATION or COMMAND against the log.

*But:* a lead, not a finding: one run, one device. It settles on a wired speaker, and that run hasn't happened. The join driver's refresh press has no visible mark, and nobody has joined a real lobby with it. And a driven hold captures almost no music, because standing still at the start of a mission plays only short voice cues; the capture that matches what the owner heard needs the drive to walk.

`Cited:` `668c7f5` fix wave A (W9, W5): hold a button to remap it, a better pad, and the bank cleared of the online blop · `00d8348` fix wave A (W7, W8, R240): an empty games list is not a join failure · `0b1250b` fix wave A (W7): the instrument is proven, the drive that feeds it is not -- and the endpoint is dropping audio again · gate fixwave_b · run blop_c · run mission_music_ours_20260922_024457 · docs/KNOWN.md

## 2026-09-23 .. 2026-09-25 - A second edition, and names for the code

*Three days, two sprints closed and a third opened on the last morning. The later edition of the game the community server runs is rebuilt from its own package, passes the same checks as the disc's edition and plays a round on our server. A sprint run in the cloud gives 1,771 of the program's nameless functions their real names, and the machine with the disc proves nothing else changed. The third sprint spends its one day on what the record said was owed. Still: the later edition has never met a community player, and nobody outside this house has played.*

### 2026-09-23 - The update the community server asks for, taken apart

**The community's server wants a later edition of the game than the disc holds. Just before midnight that edition was running under our program, as far as its opening credits.**

The day opened with Sprint 10's close: merged to the main branch as version 0.10.0, once the scheduled nightly match had run seven times in a row without a failed login or a crash, the bar called "it stays up". The chat path was hardened at both ends, bounded in the game on the player's machine and clamped on the server. Every known, unfixed defect became a public issue, cited from the page that describes it. Then the owner brought the update. The community server runs r0004, a rebuild of SOCOM II from thirteen months after the disc's r0001, and its patch turned out to be a small program that boots the disc and rewrites it in memory. Decoding it said, at first, that all it did was skip Sony's long-dead online check, which this project already skips, so "no second build" was ruled at noon. By evening that was wrong: behind the check, the community server hands out the real r0004 package. The project fetched it the way a player's console would, decoded it, and built a second program from it. The new build showed the loading screen, typed out its developer's name, and then rebooted itself into an error dialog.

![The r0004 build under our program, the first time it got past loading: the developer credit typed out letter by letter, seconds before the game decided to reboot itself. The gate run that caught it failed all three of its stages.](docs/story/img/2026-09-23-r0004-types-its-credits.png)

*How:* the patch is PSRewired's capsule, a packed MIPS program whose encrypted stack decodes to 491 writes; the package behind it was saved to a memory card through the reference emulator, and scripts/build_revision.sh turned its overlays into a second executable with a function map of its own, 81 % of r0001's functions placed in it by the matcher.

*But:* the noon ruling that there was nothing to rebuild was retracted the same night, in writing (R249, by R251). And a build that reboots at the credits is not a build that plays.

`Cited:` `f15acfab` merge: Sprint 10 to main -- it stays up (7 of 7), v0.10.0 · `d23c4b1d` the ladder streak is 7 of 7 · `f2064d3c` hardening of the chat receive path · `5b7d20e7` (2026-09-22) forwarded chat fields are clamped · `d5b8757f` the known-issue stack -- every defined, unresolved defect is a GitHub issue · `61faf530` (2026-09-24) after a report is received, the one line that invites a public issue · `52e10a36` the r0004 patch is in hand and it is PSRewired's resident capsule · `0c580739` the capsule's encrypted code stack decoded · `cf5d4745` R249 -- PSRewired's r0004 patch is a DNAS bypass this build already carries; no second recompilation · `ed07a16f` R251 -- r0004 is a real rebuild, the package is decoded and its ELF built · `e92691a2` relinked-body, the r0001/r0004 rate from 63% to 81% · `8a576346` the r0004 build boots to the intro credits · gate s11_r0004_loopd1 · docs/research/43-r0004-capsule.md · docs/archive/CURRENT_SPRINT-sprints-9-to-11.md

### 2026-09-24 - The update plays, and cannot meet the original

**The r0004 build passed the same three-stage check as the disc's own edition, then played a round on our server. And the two editions turned out to be unable to join each other's games.**

The reboot took a night to run to ground, one measured link at a time. The game rebooted because a memory request failed. The request failed because it asked for 111 MB. It asked for 111 MB because a function returned from the middle of its own ending, and that was because two of its words had been overwritten by the community patch: written into the game's memory while the reference emulator ran it, then copied out with everything else when the project dumped the updated game. Undo exactly what the patch wrote, and nothing else, and the rebuild boots to its menu, reaches the first mission, and passes all three gate stages. In the evening two copies of it logged into our server, one hosted, the other joined, and they played a round to the end of its clock, both answering the controls. Then the question the community cares about: an r0004 player and an r0001 player see each other's games, the join goes through at the server, and within ten seconds the joining game quietly walks itself back to the online menu. The check is in the game itself, on both sides, and no server can change it. The same day the SOCOM 1 demo disc, which shipped with its function names left in, put names on 987 of this game's nameless functions, and 11.6 MB of unused files that came with the recompiler's source were deleted.

![The r0004 build in a round on the project's own server, the evening of the 24th: one of the two copies, both driven by the harness, five and a half minutes left on the clock. The round ran out that clock without a shot.](docs/story/img/2026-09-24-r0004-round-on-our-server.png)

*How:* tools_py/overlay_repair.py undoes the capsule's decoded write stack on the dumped image, so a word changes only where the capsule wrote one, and zero words change in r0001; the online harness's memory probes became per revision (tools_py/parity/guest_addresses.py) because r0004 keeps its data at different offsets.

*But:* the round ended on the clock with no shot fired. The r0004 build has only ever run on the r0001 disc's own art and sound. And whether a player gets r0004 at all is the owner's decision, not made yet.

`Cited:` `07dc937f` the two words in the overlay that are not code · `3bac4a2b` the repair is an undo of the capsule's write stack, not a shape · `2613a26a` the r0004 gate is 3/3 · `d447bb1b` the r0004 build plays online on our server; the two revisions cannot join each other's games · `f9555c75` the r0004 round is scored on our server · `007d6511` the SOCOM 1 demo names 987 of our anonymous functions · `71750904` R247 -- the vendored tree's baggage goes · gate s11_r0004_probe2 · run s11_r0004_round2c · docs/research/43-what-changed-in-r0004.md · docs/superpowers/plans/2026-09-23-sprint-11.md · docs/KNOWN.md

### 2026-09-24 - A sprint in the cloud, and names for the code

**The program is built from about 14,900 functions the original makers left nameless. In one evening, 1,771 of them got their real names back, each with its reason written down.**

The SOCOM 1 demo's names were the start. The owner moved the whole naming programme into a sprint of its own and handed it to a session running in the cloud, with no disc and no game, only the tracked function map and the tools. It worked in waves: fifteen research notes first, then one lever per note, each a rule written in code with its own measured error rate. The demo's names matched by the shape of a function's body. The class tables the compiler left behind. The text a function refers to. Who calls it and whom it calls. The menus' own tables that bind a button to the function behind it. One program writes every name, and it cannot write one without a row saying which lever found it, how strongly, and on what evidence. About 120 functions had names that morning; by night the file held 1,771. Nothing the game does changes: the recompiler reads the names only to label the code it writes, and the cloud rebuilt the whole tree to show that the labels were the only difference. No picture for this day: nothing on it drew a frame, because the cloud has no disc. The run that proves the renamed program still plays is the next morning's gate, cited here.

*How:* tools_py/apply_names.py is the only writer of recomp/socom2_names.csv; the recompiler's `[general] names` key reads it into display names only, and a census of two cloud recomp runs showed 1,771 files renamed, 0 extents moved, 0 functions dropped.

*But:* six names were held back because other evidence contradicted them, and 518 more wait for a second, independent lever to agree. The cloud's numbers were claims until a machine with the disc built and ran them.

`Cited:` `41a6a169` R263 -- the naming programme is Sprint 12, "the readable image" · `6c35ed13` the spec and the plan for "the readable image" · `6c96ef8f` the provenance sidecar · `5cde14d5` the readable-name renderer · `9381e3c6` the recompiler runs in the cloud · `cd2fbfc7` the applier, and the first 1,491 names applied to the sidecar · `fee229d7` the sidecar at 1,840 rows / 1,771 readable names · recomp/socom2_names.csv · docs/superpowers/plans/2026-09-24-sprint-12.md · gate s12_names_gate

### 2026-09-25 - Sprint 11 closes, and the borrowed fixes stay

**Ten fixes from the upstream recompiler project, each tried alone against the gate and then all together, and all ten kept. Then the sprint closed and went to the main branch as version 0.11.0.**

The recompiler this project forked keeps improving without us. Ten of its changes, among them how textures find their colours, how packed model data unpacks, how interlaced frames keep their rows, and a handshake at boot, were taken one at a time: each built, each gated on its own, then the ten combined and gated again. All ten stayed. The close found its own defects. The build service had been red on every code push since the evening of the 23rd: twelve tests reached a check that now refuses to guess which edition of the game it is looking at, and the build service has no game. The tests were made to say which edition they mean; the check was left strict. The gate's switch for accepting new reference values could drop one pin while it accepted another; fixed. And this story was found three days short, and carried rather than half-written. The close proof: the suites three times over, the gate three of three on the close commit, the build service green.

![The last frame of the close gate's mission stage, on the executable that went to main as 0.11.0: the first mission's team-command help card over autumn trees. Every close ends on a frame like this one; the gate scores it, and nobody usually looks.](docs/story/img/2026-09-25-the-sprint-11-close-frame.png)

*How:* each pick ran in its own worktree with its own gate (s11_pr227_gate and its siblings); research/42 holds the verdict column; the combined branch passed 891 of 891 C++ tests and s11_picks_keep_gate 3/3.

*But:* six known issues went to the backlog unfixed, labelled as carried, among them the Linux machine's red test suites. And the missing story days were carried a second time the same morning, by Sprint 12's close. They are the entries you are reading.

`Cited:` `6be03dac` research/42's verdict column -- all ten upstream picks are KEEP · `3bb866f4` Merge branch 'agent/cherry' into sprint-11 · `a8329c58` the twelve cases that reached launch_revision without an image now state their revision · `fccf3b5d` --accept-pins must not drop a pin while it accepts another · `425bae9d` Sprint 11 CLOSED · `f142b513` the close proof recorded -- gate s11_close_gate 3/3, CI green · `173608af` Merge pull request #49 from Scotho/sprint-11 · gate s11_picks_keep_gate · gate s11_close_gate · docs/research/42-upstream-cherry-picks.md · docs/CURRENT_SPRINT.md

### 2026-09-25 - The names come home, and both editions still pass

**What the cloud claimed, the machine with the disc proved: the renamed program rebuilt, played and passed the gate, on the disc's edition and on r0004.**

The cloud has no disc, so its sprint ended with a request: build it here. The same morning this machine recompiled the whole game with 1,840 names loaded, compared the result against the output from before the rename, 1,771 files renamed and not one function moved or lost, built the program from scratch, ran the test suite, and ran the gate: three of three, every pinned input matching. Then the same for r0004, with its own list of 1,705 names carried across by the address matcher. The r0004 run was refused once first. An earlier proof's shell had carried a stray setting that muted the sound, and the switch that accepts new reference values had written it into r0004's standard; the gate measured the true value and said no. The standard was put back to its last clean value, and the next run passed. Sprint 12 closed and went to main as version 0.12.0, a few hours after Sprint 11.

![The renamed r0004 build's main menu during its gate run, the morning of the 25th. The bottom line is the game's own build stamp: SOCOM 2 r0004, built 3 November 2004, thirteen months after the disc's edition.](docs/story/img/2026-09-25-the-renamed-r0004-menu.png)

*How:* build_revision.sh builds r0004 with recomp/socom2_names_r0004.csv; the gate compares every pinned input (PINS MATCH), the r0001 leg on exe 804dd172 and the r0004 leg on the runtime built with its own sidecar.

*But:* a name is not an understanding. The five biggest engine routines still have none; no lever reaches them, and they wait for the owner's own reading. And the refused run was the second time that accept switch had written a stray setting into a standard.

`Cited:` `83e9696c` the local proof is green -- 1,840 display names loaded, 1,771 renamed with 0 extents moved; the r0001 gate s12_names_gate 3/3 with PINS MATCH · `3e5b5b78` the r0004 leg of the proof is green -- s12_names_r0004_gate 3/3 with PINS MATCH on the r0004 runtime built with its own 1,705-name sidecar · `7588fead` the r0004 pin standard's env restored -- a stray PS2X_AUDIO_VOLUME=0 · `32c06a0c` Sprint 12 CLOSED · `74fe2a9b` merge: Sprint 12 to main -- the readable image: 1,771 names with provenance from one sidecar, proven on both revisions; v0.12.0 · gate s12_names_gate · gate s12_names_r0004_gate · recomp/socom2_names_r0004.csv

### 2026-09-25 - The client stops taking orders from the server

**A game server can send the game on your machine a message that writes into its memory. Ours now refuses that message, every time, and both editions still pass the gate.**

Sprint 13 opened the same morning the other two closed, on an audit of the whole project, six reports and 403 findings, under one rule: nothing gets carried twice. Its first job came from a private note written the day before, about what a server could do to a connected game through a record the game trusts. Before breakfast the client refused the record that writes, and an hour later the one that reads memory back. The same morning a file path the game asks for can no longer leave the disc's, the game's or the memory card's own folder, and no private address of the owner's is a tracked default anywhere in the repository. The refusal was relinked into the program and gated three of three, then proven again on both editions with the rest of the morning's merges. No picture for this entry: a refusal draws no frame.

*How:* the record class and the check are written down in `docs/KNOWN.md`'s row and SECURITY's bullet by what they do, not how, on purpose; the network path's full inventory is a private backlog row.

*But:* a refusal is as good as the list it covers, and this one covers two records. The community server was never the threat here; the model of a hostile one was.

`Cited:` `6b30e42e` a server-to-client record that writes game memory is refused on the client, every time · `8df7c036` a server-to-client record that writes game memory, and one that reads it back, are refused on the client, every time · `4587afae` the client refuses a server record that writes or reads its game memory -- the KNOWN row and the SECURITY bullet, without mechanics · `4eb07b45` a translated PS2 path cannot leave its root · `eda61d3a` no private address as a tracked default · gate s13_u6_gate · gate s13_proof_gate · gate s13_proof_gate_r0004 · docs/audits/2026-09-25-project-audit.md · docs/KNOWN.md

### 2026-09-25 - The debts, paid in one day

**The saved password was never lost. A nightly match launched itself, first time, through a queue that did not exist that morning. And every check now prints how fast the mission ran.**

The rest of the day went to what the record said was owed. The sprint file went from 189 KB to 59 KB with the closed sprints archived whole; the owner's to-do list went from 87 items to fifteen, each with the default the loop is on; the list of what is proven, believed and retracted was read end to end; and the backlog became a generated file. Two of the six carried issues turned out not to be defects at all: four "lost" menu frames were the idle attract sequence the scorer should never have counted, and a loading-screen defect had been fixed nine days earlier and never written down. The password: on the 23rd this page said a fresh card lost it. It never did. The driver pressed the connect button before reading the form, and read the password off the next screen. Read as it arrives, a card relaunched with nothing typed showed the name, five glyphs and SAVE PASSWORD ticked, and reached the lobby. The launcher's wording was fixed against a stranger's read of it, and a server name that does not resolve now says so instead of quietly meaning this machine. The machine's lock got a queue, and the scheduled match went through it on the first attempt: four rounds, two kills. The gate learned to print the mission's frame time, and three runs of it on one program spread by 30 %, so the number is recorded and has no bar yet. One copy of the game was paused for 28 seconds mid-round, and the other played on. And the music's first clean capture brought its dips from eleven-to-fourteen down to six in sixteen minutes, with the device's own thread never once late.

![The relaunch, with nothing typed: the card had kept the name, the password and the SAVE PASSWORD answer, and the cursor was already on CONNECT. For two days the driver had been pressing that button and then reading the password off the screen after it.](docs/story/img/2026-09-25-the-relaunch-form-with-the-password-kept.png)

*How:* FRAME mean 24.24 / 30.09 / 22.72 ms over the scripted walk on exe f90eeec0 (s13_v4_gate1..3, an informational pin, S13-R13); the ladder job waits on the lock's ticket queue (`scripts/ladder_job.sh`; #35, #36, #37 closed).

*But:* this entry was written with the sprint still open: its close proof, the round against a real console and the menus' tile question were still in the queue. The six music dips have no owner yet, and the frame rate has a number and no bar.

`Cited:` `ae84b1c6` the Sprint 9-11 record archived verbatim · `4adbf2bc` HUMAN_TASKS archived whole, every old item given a disposition · `33fa5940` docs/BACKLOG.md generated from the stack · `79aad10c` s19..s22 are the idle attract sequence, not lost menus · `413439d3` the premise was fixed on 2026-09-16 by 545b85a1 and never recorded · `65431302` the saved password was read off the CONNECTING screen, not lost · `6ff8229f` #27 was the login driver pressing before reading the relaunch form, not a lost password · `5565f2ca` the launcher's wording defects; a server name that does not resolve is a LAST RUN notice · `49d6fba2` the lock's ticket queue · `ef4b17fc` the ladder ran through the queue; #35, #36, #37 closed · `318fbd60` the mission stage's FRAME line and an informational frame-time pin · `c7fe15c3` V4 done -- three gates on one exe spread 30 % · `38761e2b` the game ran on through a 28 s peer pause · `b43e5325` V5 Step 1's clean capture (DEVICE 6 / 16 min, 0 late callbacks) · run v6_20260925_160634 · run ladder_20260925_194510 · gate s13_v4_gate3 · run s13_v7_paused_peer_20260925_193109 · run audio_out_20260925_074147 · docs/LADDER.md · docs/BACKLOG.md · docs/HUMAN_TASKS.md

## 2026-09-26 .. 2026-09-27 - Guards, a sitting, and ten minutes to the server

*Two days. A sprint that changed nothing a player would see, so that the loop stops repeating its own mistakes. The owner at the desk for four hours, answering every question the record had been keeping for him. Version 0.15.0 closed without its play test, and a sprint opened whose name is its bar. The launcher learns your personas from the game's own logins, the community's update turns out to sit at one plain address, the map viewer's code comes home, and the site gets a name of its own and a design system. Still nobody outside this house has played.*

### 2026-09-26 - A sprint with nothing in it for a player

**Eleven hours, and not one change to the game: every mistake the loop kept repeating became something that refuses to run.**

The day before, the owner had asked for a review of how the project runs itself, and it came back with nine findings, the first being that the record was where things went wrong: a rule written in prose recurs, a tool does not. So the sprint that opened at dawn took no feature work at all. The mistakes that had bitten more than once, staging every file at once, committing without naming the files, taking the build lock by hand, became a hook that refuses the command before it runs. A second hook keeps a running chain's script from being edited underneath it, and a reaper kills the leftover watcher processes that had been slowing the machine. The reading a new session had to do before it could start fell from 250 KB to 51 KB. Four pages that used to be kept by hand are now generated from their sources. A third build waiting for the one machine is turned away. Every guard was fired against a planted violation before it counted. Merged to the main branch as version 0.14.0 by late afternoon. The evening then delivered the exact class of mistake the day was about: a tool deleting a finished worktree followed a link into the main tree's tools folder and emptied it, the reference emulator and the disassembler included. The toolchain was fetched again, and the hook learned that command the next morning.

*How:* `scripts/hooks/claude_pretool.sh` -> `tools_py/hooks/pretool.py` is the Bash hook and `tools_py/hooks/reap.py` the reaper; `build.sh` exits 3 while another holder has the lock; a test holds the read-first set under its budget.

*But:* a guard covers the mistakes someone has already made, and the tools folder was lost to one nobody had listed yet. Nothing about the game moved that day, by design.

`Cited:` `f87183ae` close(sprint-14): guards, not sentences · `200f3287` Sprint 14: guards, not sentences (#68) · `dc044c3d` INCIDENT -- tools/ emptied at 20:41Z through a worktree's junction; the toolchain re-fetched · `c991b4ae` (2026-09-27) the Bash hook refuses gh pr merge --delete-branch -- the worktree junction hazard · docs/audits/2026-09-26-autonomy-structure-review.md · docs/superpowers/plans/2026-09-26-sprint-14.md · docs/CURRENT_SPRINT.md

### 2026-09-26 - The owner sits down, and the window stops freezing the game

**Four hours at the desk, every question the record had been keeping for the owner answered in his own words. And dragging the window no longer stops the game.**

From half past four to half past eight in the evening, UTC, the owner walked the to-do list row by row with the session that keeps it. What came out of it: the download will carry the program and never the disc's own files, and the game's image is built on your machine from your own disc the first time you run it; everything that is the project's own is GPL-3.0; nothing is signed until there is a release; the launcher will fetch the community's update itself rather than act out the console's own update flow; and the project's server is a test bed standing in for the community's, which is where players are meant to end up. Around the sitting, the day's other work. The sprint that opened as the guards sprint closed took audio first, and took the real sound driver, run under an emulated console from the upstream project, as its reference: it disagrees with ours on 832 of 13,044 answers in a mission, most of them the replay's clock rather than a defect. A fade that had stepped in fractions now steps in the driver's own integers. The launcher had been starting the disc's edition whatever GAME VERSION said; fixed. And the owner's report that dragging the window froze the game for as long as the title bar was held was fixed the same evening: the game's clock had been waiting on a window that was busy being moved.

*How:* the frame back-pressure and the GL token waits stand aside between WM_ENTERSIZEMOVE and WM_EXITSIZEMOVE, byte-identical otherwise; the oracle is upstream PR #254's LLE IOP running the disc's own 989SND.IRX with our cdvdman and sifman provider.

*But:* a sitting produces decisions, not results: the first-run build of the game's image and the launcher's fetch of the update were, that night, two open issues with nothing built. The drag fix met its bar only in the next day's chain.

`Cited:` `a5cb8961` the owner's sitting of 2026-09-26 -- every row walked · `29d8173c` open(sprint-15): borrowed confidence, re-cut to value · `ba9e7d7b` the LLE IOP as an oracle -- the spike · `028badc7` T1's spike -- N = 832 of 13,044 on the LLE oracle; ADOPT AS ORACLE recommended · `795c93fe` AutoVol steps in the IRX's 7-bit integers -- a 1.5 s fade lands at tick 254, not 360 · `e36558f9` start the chosen GAME VERSION's own exe and ELF, not socom2.exe every time (#69) · `c42ca7b8` a title-bar drag no longer freezes the guest -- back-pressure yields in the move loop · `83c62d75` the site page ends on the timeline · docs/superpowers/plans/2026-09-26-owner-sitting.md · docs/KNOWN.md

### 2026-09-27 - Version 0.15.0 without its play test, and a sprint called "ten minutes to the server"

**The audio sprint closed after one day, its play test carried forward on the owner's word. The next sprint is named for its bar: a stranger, ten minutes, the server.**

Sprint 15 closed at half past six in the morning and went to the main branch as version 0.15.0, without the play test it had planned: the owner's call, with the deferred legs carried into the sprint that opened at seven. That one is called "ten minutes to the server", after the goal every sprint serves: a stranger points the launcher at their own disc and plays a round against another stranger inside ten minutes. Four milestones: a download that carries the program alone, with the game's image built from your disc on first run and the community's update fetched by the launcher; the frame rate measured on a quiet machine and given a bar; the launcher's face, the persona list and the tooltips; and the fillers. First, the deferred legs, in one chain with the desk idle: the gate three of three, the held-out captures twelve of twelve, and a scripted ten-second drag of the window in a mission with the game running on underneath, so the drag freeze is closed on its bar. The same chain built the first player archive: 67 MB, its program ten megabytes lighter than the developer's, the debug screens left out. Two things read red. The music's dip bar: nine dips in eleven minutes, all of them the known fifty-millisecond holes in the menus and the briefing, none in the mission. And the mission's ambient sound bed, found playing about 11 dB under the console's, and found to have been that way for a week, unnoticed because the comparison had been run against a capture from before the change. The frame: three gates on one program with the machine quiet, 27 ms a frame with a 7 % spread, and a profile of where the time goes.

![A frame from the mission stage of the first chain of the new sprint, the morning of the 27th: the game's subtitle "Who are you?" over the first mission's autumn trees, four teammates FOLLOWING. The gate scored this run three of three; the drag leg was proven on the same program.](docs/story/img/2026-09-27-the-first-sprint-16-chain-frame.png)

*How:* FRAME mean 28.99 / 26.93 / 27.09 ms over the scripted walk on one exe (s16_f0_gate1..3, median 27.09, spread 7.0 %); the GL thread's second is 44 % executeCommands and 34 % a Sleep under EndDrawing; the player kind is `PS2X_RELEASE_KIND=player` with `PS2X_ENABLE_DEBUG_UI=OFF`.

*But:* no person has played this build. 27 ms a frame is a number and not yet a bar, and it is well under the console's sixty a second. The 11 dB bed has an issue number and no fix, and the nine dips are the same holes as before, still unfixed.

`Cited:` `4df68014` close(sprint-15): borrowed confidence, re-cut -- CLOSED 2026-09-27 without the play test on the owner's word · `10650369` Sprint 15: borrowed confidence, re-cut (#81) · `75081c33` open(sprint-16): 'ten minutes to the server' · `05e1839f` player and developer release kinds, two archives from one packaging run · `507286e3` V0's chain all green -- the player kind's sizes into KNOWN · `ab3b8e92` issue #67 closed on its bar (V0 legs 2a/2b/2c and the gate) · `6d78365c` V0 leg 3b -- the dip bar red on the count (9/11 min, max 3), the nine are #42 holes · `dbf1d53e` leg 3's 12/48 is issue #91 (the ambient bed 11 dB low since the square law, not T1b) · `c4f43911` where a mission frame's time goes -- two profiles, the flush split, three quiet gates · gate s16_v0 · gate s16_f0_gate3 · run s16_v0_t1b_dump · docs/research/73-mission-frame-time.md · docs/CURRENT_SPRINT.md

### 2026-09-27 - The game remembers who you are, and the update has an address

**The launcher's ONLINE page now lists the personas your card has made, written by the game's own logins. And the community's update turns out to sit at one fixed address that opens with the disc's own key.**

The ONLINE page had three fields, PROFILE, PLAYER NAME and PASSWORD, and a password typed there sat in plain text in a settings file. Now it has a PERSONAS list and NEW PERSONA, and asks for a password only when the card does not hold one. The list comes from a small record the game itself writes beside your memory card on every login that goes through: the name, the server, when, and whether the card saved the password, never the password. The first run against the project's server logged in fine and wrote nothing: the record's reader sat where the server's reply was expected to arrive scrambled, and our server sends it plain. Moved to where the bytes actually pass, the record appeared after the first login, carried both personas after a second was made, and the relaunch with nothing typed updated the first with its saved password. On the other front, the owner ran the disc under the reference emulator through the community's own update prompt, with the network watched: the game asks one plain address for one file, the same for everyone, no token. Fetched by hand: 1.6 MB, and it opens with the same decryption the disc's own package does, so the launcher needs no console identity to install it. The launcher's streaming download and its fetch seam were built and tested against a loopback server. And the first-run decrypt, the piece that builds the game's image from your disc on your machine, was recompiled into a small program of its own and went through several review rounds the same day.

![The relaunch of the ledger's proving run, the evening of the 27th, with nothing typed: the game's own form arrives with the first persona the card made, its password held, and SAVE PASSWORD ticked. The record beside the card was updated from this login.](docs/story/img/2026-09-27-the-form-the-ledger-was-written-from.png)

*How:* `ps2x_shared`'s personas.h/.cpp keep the ledger `<card>.personas.json` with an atomic write and refuse one over 1 MiB unread; the persona record reads the plain login response at the socket, since MAS and MLS frames from our box never pass the RC4 seam; the served package is `GET /s2/r0004/APACHE00.ZDB` on port 80, decrypted with the r0001 disc decrypt.

*But:* the ledger is proven against the project's own box only; the fetch seam has met a loopback server and never PSRewired's, whose server the loop never contacts on its own; and the first-run decrypt was still a spike at the day's end, not a feature.

`Cited:` `9ed205ec` the ONLINE page's PERSONAS list replaces the PROFILE, PLAYER NAME and PASSWORD fields · `05a0b393` personas.h/.cpp in ps2x_shared -- the ledger beside the card, its reader and atomic write · `1596b0c1` config.json keeps no plain password a persona's card holds · `f924277c` the runtime's persona record -- the login parsed at the RC4 seam, committed on its success · `1e43bb48` L1b Step 0 -- logins work, no ledger · `65a07f46` the persona record reads a plain login response at the socket -- MAS and MLS never encrypt it (#73) · `e27730ef` L1b DONE -- the ledger written on a real login (Step 0b), #73 closed · `f1715fdb` #71 -- PSRewired serves r0004 at one fixed path; the r0001 client's GET captured · `92097d4c` #71 settled offline -- the served r0004 package decrypts with the r0001 disc decrypt · `7ba414dd` a streaming download and the r0004 package fetch seam, loopback-tested (#71) · `0890bd76` R1a the first-run decrypt spike -- the recompile, into socom2_build_elf.exe · run s16_l1b_step0b · docs/research/74-first-run-decrypt-spike.md · docs/superpowers/plans/2026-09-27-sprint-16.md · docs/KNOWN.md

### 2026-09-27 - The site gets its name, the map viewer comes home, and the look is written down

**socomunzipped.com. The browser map viewer's code now lives in the game's repository. And the modern pages' look is one design system, built beside them and not yet on them.**

The site moved from a subdomain to a name of its own, socomunzipped.com; the old address still answers. The map viewer, SOCOM II's multiplayer maps decoded from your own disc's archives and drawn in the browser, a spin-off that had grown up in the site's repository, was brought into the game's repository under `web/` as a separate project with its own tests and its own build, because the owner wanted one local directory; it still lives on the site at `/map-viewer/`. That evening a commit removed it from the site and swept the classic menu's roller row out with it; both were reverted within the hour at the owner's word, and the classic menu's roller now lists MAP VIEWER between SERVER and BUG REPORT. The design system: the owner built one in Claude Design, S2U Briefing, and asked for it to be merged with the site session's own spec; the rule became that the owner's design wins on look and the spec on engineering. Phase 1 landed in an afternoon: the design's tokens vendored whole and the stylesheet generated from them, with a guard that refuses a hand edit; three faces self-hosted, Oswald, Saira Condensed and JetBrains Mono, with fallbacks measured to match; a base layer; the components, the bar, the head, sections, the briefing grid, panels, cards, tiles, tabs, fields, the overlay, stats, the lamp, status lines, hints, the footer, the wheel and the typewriter; a gallery of every component and state, with the contrast of every colour pair computed from the stylesheet itself; and tests against that gallery at desktop and phone widths. All of it beside the pages: nothing on the site looks different yet, and the classic menu is out of its reach by rule.

![The design system's gallery, its tokens page, on a local build the afternoon of the 27th: every colour the site and the map viewer may use, and the contrast each pair holds, computed from the stylesheet on the page. Not deployed yet.](docs/story/img/2026-09-27-the-design-system-gallery.png)

*How:* three cascade layers, s2u.tokens, s2u.base and s2u.components, so a page's own stylesheet wins every tie; every property is `--s2u-*`; the viewer is to vendor a copy with a manifest of hashes; the Playwright run holds goldens at 1280 and 390, axe, no Google Fonts, the focus ring.

*But:* the design system's commits live in the site's own repository, which this page's checker cannot follow (83daa36 the spec, 5fd50ed the merge with S2U Briefing, 86f971e the tokens, 0fa6306 the fonts, 61656e7 and a9ed9e7 the components, b066a24 the gallery, 455a41d the tests, 442d513 the new name, d58fecb and fbfbb6f the removals with 2fad8d0 and 27b5ce8 their reverts, fca02c9 the roller row; all scotho), so the `Cited:` line carries the game repository's side. And this page's own links from the home page were landing thousands of pixels from the entry, for four reasons found in one sitting: the pictures had no size until they loaded and pushed everything below them down; the site scrolls smoothly, so the browser's jump to the anchor is an animation whose destination is fixed before the fonts arrive and shrink the page under it; the page's own script tried to look the anchor up as a selector, which a name starting with a digit is not, so it threw and did nothing; and the page cut long anchors at sixty characters where the home page's data did not. Every picture now carries its size, the page settles on its anchor by name for a few seconds after it loads, one rule makes both anchors, and a test on the site fails if an entry's link has no anchor to land on.

`Cited:` `14b1ef61` the experimental browser map viewer, walled off under web/ -- SOCOM II's maps decoded from your own disc · `b8525708` research notes 71 (scoping) and 72 (map-archive anatomy) move under web/docs/research · `80b48e8c` the panel and chrome take the s2u site's design language · web/README.md · tools_py/story/site.py

---

## Where it stands tonight, 2026-09-22 — and what the night answered

*Not an entry and no `Cited:` line. This is the view from the end of the record on the night it ends, and it gets
replaced by real entries as things land. **It is kept exactly as written and answered underneath**, because the
answers arrived within hours and a paragraph that is wrong with its correction beside it is worth more than a
paragraph quietly rewritten.*

> **Superseded as a live statement, 2026-09-25.** The paragraph below is the record of one night and is kept word
> for word; **read none of its numbers as current.** A commit count, a branch name, a tag list, a streak and a task
> count are the five things this document's class forbids, and all five of them below are now wrong. Where to read
> each instead, which is what this document should have said in the first place: the live queue is
> `docs/CURRENT_SPRINT.md`; the branches and tags are `docs/GIT_STRATEGY.md` §1; the ladder's streak is
> `docs/LADDER.md`, which is generated; what is proven, believed and retracted is `docs/KNOWN.md`, which wins over
> this page on any disagreement.

> The tree is at `e6a924d`, 1,028 commits, on `sprint-10`, with two tags: `playtest-1` and `v0.9.0`. The repository
> is public. Sprint 10's autonomous work is on `main`, slice by slice, the last two slices from the owner's
> playthrough. The scheduled ladder has four clean runs of the seven it needs. Sprint 11 has a spec: the r0004 update
> the community server requires, costed against the tree, waiting on a package only my memory card can supply.
>
> The open question is still the music, and it has moved from the mixer to the speaker. Every fix so far was measured
> on the mix as rendered. The one instrument that listens at the speaker heard 31 dropouts in ten minutes on my
> Bluetooth speaker that the mix doesn't contain. One run on a wired speaker decides whether that's the cable or us.
> Behind it, two decisions: whether the login the launcher prefills can go now that the save works on a fresh card,
> and how far a driven walk into the first mission should go before a death counts as "the music stopped".

**2026-09-23, the morning after.** Three of those sentences have moved.

The 31 dropouts were re-scored to 11 the same day — twenty of them were the scorer's own matching, not the game's —
and then the wired run happened. It gave 14 on the cable against 11 on the Bluetooth speaker over sixteen minutes.
**It's us.** Not the cable, not the speaker: something between the mixer's own output and the write that proves what
the mixer did. That is a smaller question than the one I had, and a much better one, because it can be instrumented
instead of argued about.

The two decisions were both taken by running them rather than deciding them. The prefilled login **stays** — a
virgin card keeps the persona through a restart and loses the saved password, so the game's own way in doesn't yet
reach the lobby on its own. And the driven walk is not enough: twelve minutes of walking in place produced ten
perfectly clean HELP popups, and the garbled one I saw was after the church, which a walk that never leaves the
insertion point can never reach. The experiment wasn't wrong; the route was too short, and the capture didn't even
record which settings it ran with — which is its own lesson, now written down.

> Superseded 2026-09-25 (Sprint 13 V6, issue #27 closed): the card never lost the saved password. The driver misread
> the screen -- it pressed CROSS first, which connected, and read the password off the CONNECTING screen. With the
> driver fixed (`6ff8229f`), a virgin card relaunched with nothing typed read the saved password and reached the lobby
> (`logs/parity/v6_20260925_160634`). The sentence above is kept as what was believed that morning.

Sprint 10 is closed. Sprint 11 is open, and the specs became a plan; `docs/CURRENT_SPRINT.md` is where its tasks
live, and this page does not count them.

> Superseded 2026-09-25 (Sprint 13 R2): that paragraph was true on 2026-09-23. Sprints 11 and 12 both closed and
> merged to `main` on 2026-09-25 (`v0.11.0`, `v0.12.0`); which sprint is open now is `docs/CURRENT_SPRINT.md`'s to say,
> and the note below says what this page still owes.

No stranger has played yet. No two humans have played each other. Those are still the two sentences this page most
wants to lose.

**2026-09-25 — the record stops short.** This timeline's own first line promises "first commit to today", and its
last entry is 2026-09-22. Three days are missing, and they carry the project's biggest technical result: Sprint 10
merged and tagged; the chat receive path bounded on the client and clamped on the server; the community revision
r0004 rebuilt from PSRewired's package, gated three times over and played online on the project's own server; the
bug pipeline's GitHub half; 11.6 MB of vendored baggage deleted; a SOCOM 1 demo disc naming 987 anonymous
functions. Writing those entries is not a one-line edit — each needs its hashes and a witnessed run — so it is
**carried explicitly as a Sprint 12 item** rather than left to slip (Sprint 11 close review, row A22) — *and carried a
second time at Sprint 12's close (2026-09-25): that sprint took nothing but the naming programme, so the missing days
are now these three plus Sprint 12's two, a line in the "Sprint 12 — CLOSED" carry (in `docs/CURRENT_SPRINT.md` until 2026-09-26, now `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md`) and an
owner question in `docs/HUMAN_TASKS.md` (row O9 since 2026-09-25)*. Until it
lands, `docs/STATUS.md` and `docs/CURRENT_SPRINT.md` are where those three days are written down.

> Superseded 2026-09-25 (Sprint 13 Task S4, the owner's row O9 on its default, keep): the five days are written
> above, from the record — 2026-09-23, 2026-09-24 twice and 2026-09-25 twice, under "A second edition, and names for
> the code". The paragraph is kept as the record of the carry.

---

## How this document is checked

Every `Cited:` line is parsed and verified by `tools_py/story/cite.py`, in the project's Python suite:

```
python -m tools_py.story.cite
```

A commit hash must resolve, be unambiguous, be reachable from the published branch, and the words beside it must come
from the commit's real subject. A run or gate id must have a frozen witness in `docs/story/witnesses.json`, re-proved
against the file on the machine that has the logs. A tracked path must be tracked. `docs/story/timeline.json` is the
machine-readable form, rebuilt from this document by `python -m tools_py.story.timeline`, and the test fails if it
and this document disagree in either direction. The design is
`docs/superpowers/specs/2026-09-19-sprint-11-goal-6-progress-story-design.md`.
