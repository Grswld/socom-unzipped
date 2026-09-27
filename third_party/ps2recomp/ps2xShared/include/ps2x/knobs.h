#pragma once

// Sprint 9 Goal 3: every PS2X_* environment name the shipped executables read, decided once. This table
// IS the accessor's lookup (ps2x::knob), the source of docs/KNOBS.md (tools_py/knobs.py reads the rows with
// a regex, so a row's shape is part of the contract) and the launcher's list of settings:
//
//     X("PS2X_NAME", Class, Kind, "default", "One line, at most 110 characters, no double quote.")
//
// A Shipping or Switch row ends with where its name is read, /* read: <file>:<function> [...] */ -- the file
// relative to third_party/ps2recomp, the function the read sits in -- and the line names what that code does.
// tools_py/tests/test_knob_read_sites.py fails when a cited function no longer reads the name or a read is not
// cited (Sprint 13 C9: PS2X_SOCOM2_NET_STATS was described as a log line it never printed). Any other row may
// cite too, and is then held to the same rule. A read in a constructor's member-initialiser list names the
// constructor; a read in a namespace-scope initialiser has no function and cannot be cited.
//
// Rows are sorted by name in strcmp order (find() is a binary search; the Knobs suite and
// tools_py/tests/test_knobs_registry.py both check it). Adding a getenv of a PS2X_* name anywhere in
// ps2xRuntime, ps2xIOP, ps2xShared or ps2xLauncher without a row here fails the Python suite, and so does a
// row nothing reads.
//
// Class:  Shipping  a player-facing setting; launcher::Config has a field behind it; always honoured. The
//                   Knobs suite ENFORCES the second half ("the Shipping class is exactly what the launcher
//                   can send"), so a knob with no config.json key cannot be Shipping. R238 (2026-09-22)
//                   first tried to reclass PS2X_MC_TRACE and PS2X_AUDIO_DUMP here so a player could produce
//                   evidence; that was wrong twice over -- it broke the enforced rule, and it was not needed:
//                   devMode() reads PS2X_DEV from the environment in EVERY build (knobs.cpp), so a Dev knob
//                   is already reachable in a shipped executable with PS2X_DEV=1. What was actually missing
//                   is that a FAILURE said nothing at all; see MemoryCard.cpp's unconditional line.
//         Dev       a probe, trace, dump or A/B switch; honoured only in developer mode (--dev on the runner's
//                   command line, or PS2X_DEV=1). A stranger's environment cannot switch one on by accident,
//                   but the owner of any build can, which is how a player-reported fault gets instrumented.
//         Dev       a probe, trace, dump or A/B switch; honoured only in developer mode (--dev on the runner's
//                   command line, or PS2X_DEV=1). A stranger's environment cannot switch one on.
//         Test      read by ps2x_tests only, never by a shipped executable.
//         Switch    PS2X_DEV itself.
// Kind:   Flag      read with ps2x::knobOn -- unset or empty is the default; 0, false, off are false; anything
//                   else is true.
//         Presence  any value, including 0, switches it on (traces; see docs/KNOBS.md).
//         Int, Float, Text, Path, Spec   parsed where they are read. A Path a stranger sets must lie under the
//                   game folder or it reads as unset (pathInsideHome, R207); the disc image is the exception.

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#define PS2X_KNOB_TABLE(X) \
    X("PS2X_AUDIO_CB_TRACE", Dev, Path, "", "Every host audio callback's wall clock to this CSV; the live counts in [audio-trace] need PS2X_AUDIO_TRACE.") \
    X("PS2X_AUDIO_DUMP", Dev, Path, "", "Write the mixed host audio (48 kHz stereo s16) to this file.") \
    X("PS2X_AUDIO_INSTRUMENT", Dev, Presence, "", "Stamp every 989snd command that can change a route level with the output-frame clock (research/36).") \
    X("PS2X_AUDIO_PCM_DUMP", Dev, Path, "", "Write what the EE DMAs into the 989snd PCM ring to this file (first 16 MiB).") \
    X("PS2X_AUDIO_TRACE", Dev, Presence, "", "Every 5 s: how the host audio callback is serviced against wall time.") \
    X("PS2X_AUDIO_VOLUME", Shipping, Int, "100", "Master volume 0-100; 100 is unity and touches no sample.") /* read: ps2xRuntime/src/lib/ps2_audio.cpp:mixerRender */ \
    X("PS2X_CALL_TRACE", Dev, Spec, "", "0xADDR:Name[,...]: wrap these guest functions and log their calls.") \
    X("PS2X_CALL_TRACE_DUMP", Dev, Spec, "", "Name:a<k>[+off][*]:<words>: dump guest words reached from an argument after a traced call.") \
    X("PS2X_CALL_TRACE_EVERY", Dev, Int, "500", "After the first 300 traced calls log every k-th.") \
    X("PS2X_CD_IMAGE", Shipping, Path, "", "The disc image to mount (preflight checks it is r0001); unset takes an .iso beside the ELF or one folder up.") /* read: ps2xRuntime/src/main.cpp:main ps2xRuntime/src/lib/game_overrides_socom2.cpp:configureCdImage */ \
    X("PS2X_CD_STREAM_TRACE", Dev, Presence, "", "Log the CD stream reads the movie feeder waits on and the MPEG gate holds and resumes.") \
    X("PS2X_CD_TRACE", Dev, Presence, "", "Print CD file lookups and sector reads.") \
    X("PS2X_CLOCK_CAP_MS", Dev, Float, "100", "Longest single gap of host time the guest clock may absorb; 0 = uncapped.") \
    X("PS2X_CLOCK_EXCLUDE", Dev, Int, "0", "1 restores the 2026-09-08 exclusion of VU1 and render waits from guest time (A/B).") \
    X("PS2X_CLOCK_TRACE", Dev, Presence, "", "Once a second: the cycle clock against host time, T0, the next deadline.") \
    X("PS2X_CONSOLE_REPLAY_DIR", Test, Path, "", "ps2x_tests: folder holding a console GS dump to replay through the rasterisers.") \
    X("PS2X_CONSOLE_REPLAY_FBP", Test, Int, "", "ps2x_tests: frame buffer page to compare in the console replay.") \
    X("PS2X_CONSOLE_REPLAY_GL", Test, Presence, "", "ps2x_tests: replay through the GL backend as well.") \
    X("PS2X_CONSOLE_REPLAY_PIXEL", Test, Text, "", "ps2x_tests: x,y of a pixel to watch during the console replay.") \
    X("PS2X_CONSOLE_REPLAY_STOP", Test, Int, "", "ps2x_tests: stop the console replay after this packet.") \
    X("PS2X_CULL_PARTIAL_CLIP", Dev, Int, "0", "Experiment (research/31 s16): answer needs-clipping for partial boxes inside the guard band.") \
    X("PS2X_CULL_TRACE", Dev, Spec, "", "Trace the terrain cull/LOD/detail decisions to a file (research/31 tools read it).") \
    X("PS2X_CYCLE_CLOCK", Dev, Text, "", "guest = estimate-driven cycle accounting instead of wall time (not an A/B of pre-R54).") \
    X("PS2X_DETAIL_FAR", Dev, Int, "0", "Experiment: force the far detail level by writing guest byte 0x4b4a88.") \
    X("PS2X_DEV", Switch, Flag, "0", "Developer mode (--dev): Dev knobs honoured, Path knobs may point outside the game folder, full keyboard.") /* read: ps2xShared/src/knobs.cpp:devMode */ \
    X("PS2X_EE_ROUND", Dev, Text, "", "nearest = host FPU rounds to nearest on the game thread instead of toward zero.") \
    X("PS2X_FPS_OVERLAY", Shipping, Int, "0", "Any value but 0 draws host fps, guest vsync Hz and frame ms in the window (never in exported frames).") /* read: ps2xRuntime/src/lib/ps2_runtime.cpp:run */ \
    X("PS2X_FPU_TRAP", Dev, Float, "-1", "Seconds after which EE divisions by zero and saturated square roots are reported with their pc.") \
    X("PS2X_FRAME_DUMP", Dev, Path, "", "Directory: a PPM every 60 presents plus the VU1 trace dumps; forces a pixel readback per present.") \
    X("PS2X_GIF_DUMP", Dev, Spec, "", "<file>[:<seconds>]: record the GIF stream and a VRAM snapshot in PCSX2-dump shape.") \
    X("PS2X_GIF_PRIORITY_SORT", Dev, Flag, "0", "Restore the GIF arbiter priority sort (A/B of the 2026-09-08 change).") \
    X("PS2X_GIF_TRACE", Dev, Int, "0", "Print the first n GIF submissions with their path and BITBLTBUF.") \
    X("PS2X_GS_BACKEND", Dev, Text, "gpu", "cpu selects the CPU rasteriser; the GL probe falls back to it by itself (exit 65).") \
    X("PS2X_GS_DEPTH_LEGACY", Dev, Int, "0", "1 forces the legacy depth mapping instead of clip control.") \
    X("PS2X_GS_DISABLE_EARLY_DEPTH", Dev, Presence, "", "CPU raster: restore shading before the depth test, the behaviour upstream #246 replaced (A/B).") \
    X("PS2X_GS_DUMP_DISPLAY", Dev, Spec, "", "<dir>:<t0>:<t1>: every ~2 s write the displayed buffer three ways (gpu, shadow, cpu).") \
    X("PS2X_GS_DUMP_TEX", Dev, Path, "", "Directory: write every decoded texture as PPM + PGM, and the CLUT diagnostic.") \
    X("PS2X_GS_DUMP_TEX_EVERY", Dev, Int, "1", "With GS_DUMP_TEX: keep one decode in n.") \
    X("PS2X_GS_DUMP_TEX_FROM", Dev, Int, "", "With GS_DUMP_TEX: start at this frame, or trig.") \
    X("PS2X_GS_DUMP_TEX_MAX", Dev, Int, "6", "With GS_DUMP_TEX: files per texture.") \
    X("PS2X_GS_DUMP_TEX_TBP0", Dev, Spec, "", "With GS_DUMP_TEX: only these texture base blocks.") \
    X("PS2X_GS_GL_DEBUG_AFTER", Dev, Int, "0", "Presents to wait before GS_GL_DEBUG_PSM and GS_DUMP_TEX act.") \
    X("PS2X_GS_GL_DEBUG_PSM", Dev, Int, "-1", "Print the first batches drawn with this texture format (native coordinates; wrong above scale 1).") \
    X("PS2X_GS_GL_FORCE_FAIL", Dev, Text, "", "Make the GL capability probe fail (the only way to reach exit 65 on a machine that works).") \
    X("PS2X_GS_MAX_PENDING_FRAMES", Dev, Int, "3", "Back-pressure: presents the render thread may fall behind; 0 = unbounded.") \
    X("PS2X_GS_NO_DIRTY_REFRESH", Dev, Flag, "0", "Drop pending dirty rows instead of re-reading them (A/B).") \
    X("PS2X_GS_NO_TEX_REVALIDATE", Dev, Flag, "0", "Restore decode-on-every-invalidation instead of content-hash revalidation (A/B of R117-R125).") \
    X("PS2X_GS_NO_ZTEST", Dev, Flag, "0", "Every draw passes the depth test (A/B).") \
    X("PS2X_GS_PENDING_CAP_MB", Dev, Int, "64", "Soft ceiling on pending render bytes.") \
    X("PS2X_GS_PENDING_HARD_CAP_MB", Dev, Int, "1024", "Hard ceiling on pending render bytes (R124).") \
    X("PS2X_GS_RT_TEXTURE", Dev, Int, "1", "0 restores the readback + decode for render targets used as textures.") \
    X("PS2X_GS_SCALE", Shipping, Int, "1", "The GL backend's internal render scale, clamped to 1-4 (the CPU rasteriser ignores it).") /* read: ps2xRuntime/src/lib/gs/gs_gl_backend.cpp:renderScale */ \
    X("PS2X_GS_SCALE_FILTER", Dev, Text, "", "box = box-filter the resolve of a scaled target.") \
    X("PS2X_GS_SCALE_SELFTEST", Dev, Int, "0", "1 checks the native mirror of a scaled target against a fresh resolve each frame.") \
    X("PS2X_GS_SKIP_TBP0", Dev, Spec, "", "Drop every textured draw binding one of these texture blocks (a bisect).") \
    X("PS2X_GS_STATS", Dev, Presence, "", "The [gs-gl stats] line every 60 command buffers.") \
    X("PS2X_GS_TRACE_CMDS", Dev, Int, "", "Presents to skip (or trig), then print the replayed GS commands.") \
    X("PS2X_GS_TRACE_CMDS_BOX", Dev, Spec, "", "With GS_TRACE_CMDS: only draws touching this screen box.") \
    X("PS2X_GS_TRACE_CMDS_FROM", Dev, Int, "-1", "With GS_TRACE_CMDS: start at this frame.") \
    X("PS2X_GS_TRACE_CMDS_MAX", Dev, Int, "4000", "With GS_TRACE_CMDS: line budget.") \
    X("PS2X_GS_TRACE_CMDS_PER_FRAME", Dev, Int, "0", "With GS_TRACE_CMDS: lines per frame; 0 = no per-frame limit.") \
    X("PS2X_GS_TRACE_CMDS_TBP0", Dev, Spec, "", "With GS_TRACE_CMDS: only draws binding these texture blocks.") \
    X("PS2X_GS_TRACE_DIRTY", Dev, Int, "-1", "From this frame: log dirty marks landing in the visible rows of a display buffer.") \
    X("PS2X_GS_TRACE_DISPFB", Dev, Presence, "", "Log display-buffer selection and clears.") \
    X("PS2X_GS_TRACE_PAGES", Dev, Spec, "", "<page>[:count]: log every event touching these VRAM pages, with the frame number.") \
    X("PS2X_GS_TRACE_PRESENT", Dev, Int, "-1", "Presents to skip (or trig), then trace uploads, downloads and the present path.") \
    X("PS2X_GS_UPLOAD_SKIP", Dev, Flag, "0", "Skip an upload whose bytes are already in the shadow and every target (#32); see the reasons line.") \
    X("PS2X_GS_UPLOAD_TRACE", Dev, Presence, "", "Per-call timing of the tile upload path on the [gs-gl stats] cadence.") \
    X("PS2X_HLE_STATS", Dev, Flag, "0", "Count calls per bound HLE stub and print the table periodically.") \
    X("PS2X_HLE_STATS_PERIOD", Dev, Int, "30", "With HLE_STATS: seconds between tables.") \
    X("PS2X_HLE_STATS_TOML", Dev, Path, "recomp/socom2.toml", "With HLE_STATS: the recompiler config naming the stubs.") \
    X("PS2X_HOST_GAMEPAD", Dev, Int, "1", "0 disables every host gamepad read (a harness run must not depend on what is plugged in).") \
    X("PS2X_HOST_GAMEPAD_INDEX", Shipping, Int, "", "The host pad slot (0-3) all three pad paths read; unset, invalid or absent = the first available.") /* read: ps2xRuntime/include/runtime/host_gamepad_select.h:hostGamepadIndexKnob */ \
    X("PS2X_HOST_PROF", Dev, Float, "", "Sampling host profiler period in ms (min 0.2).") \
    X("PS2X_HOST_PROF_ALL", Dev, Presence, "", "With HOST_PROF: sample every thread.") \
    X("PS2X_HOST_PROF_MAIN", Dev, Presence, "", "With HOST_PROF: sample the main (GL) thread instead of the game thread.") \
    X("PS2X_HOST_PROF_OUT", Dev, Path, "logs/hostprof.txt", "With HOST_PROF: the histogram file.") \
    X("PS2X_HOST_PROF_STACKS", Dev, Presence, "", "With HOST_PROF: record call stacks.") \
    X("PS2X_HOST_SCREENSHOT", Dev, Spec, "", "<dir>[:<seconds>]: save what the window shows every n seconds (default 5).") \
    X("PS2X_HOST_SCREENSHOT_LATEST", Dev, Path, "", "Rewrite this PNG with the current frame twice a second; every harness capture reads it.") \
    X("PS2X_INPUT_MAPPING", Shipping, Spec, "", "The profile pad and key tables (launcher/mapping.h toEnv); unset or unreadable = the default mapping (R174).") /* read: ps2xRuntime/src/lib/socom2_host_input.cpp:resolveMapping */ \
    X("PS2X_JALR_TRACE", Dev, Spec, "", "0xSRC[,...]: log the resolved target of indirect calls issued from these pcs.") \
    X("PS2X_LAUNCHER_API_BASE", Dev, Text, "https://s2u.scotho.com", "Launcher tests only: a loopback base URL for the bug-report and stats calls.") \
    X("PS2X_LAUNCHER_SHOT", Dev, Path, "", "Launcher: after 120 frames save the real window to this PNG and quit.") \
    X("PS2X_LOD_SCALE", Dev, Float, "0", "Experiment: force both LOD scale floats of the camera (writes guest memory).") \
    X("PS2X_MC_DIR", Shipping, Path, "", "Memory-card folder for slot 0; unset = mc0 beside the ELF.") /* read: ps2xRuntime/src/main.cpp:main ps2xRuntime/src/lib/ps2_runtime.cpp:setIoPaths ps2xRuntime/src/lib/ps2_runtime.cpp:configureIoPathsFromElf */ \
    X("PS2X_MC_DIR_SLOT1", Dev, Path, "", "A folder to serve as the second card slot; unset = no card in slot 1.") \
    X("PS2X_MC_TRACE", Dev, Presence, "", "Log every memory-card command, not only the ones that failed.") \
    X("PS2X_MIC_DEVICE", Shipping, Text, "", "Capture device name for the headset; unset = no microphone.") /* read: ps2xRuntime/src/lib/host_mic.cpp:startHostMicFromEnvironment */ \
    X("PS2X_MIC_DUMP", Dev, Path, "", "Tee the captured microphone PCM to this WAV.") \
    X("PS2X_MIC_DUMP_PLAYBACK", Dev, Path, "", "WAV of what lgaud 0x09 asked the headset to play ({title} expands to the window tag).") \
    X("PS2X_MIC_FAKE", Dev, Path, "", "Feed this WAV as the microphone; beats MIC_DEVICE (R115).") \
    X("PS2X_MIC_GAMEREAD_DUMP", Dev, Path, "", "WAV of what lgaud 0x08 served the game.") \
    X("PS2X_MPEG_TRACE", Dev, Presence, "", "Log the sceMpeg HLE lifecycle and the IOP stream opens.") \
    X("PS2X_PACK_TRACE", Dev, Path, "", "Trace the terrain pack function 0x25a5d0 to this file (research/31 s17).") \
    X("PS2X_PAD_CROUCH_SHORTCUT", Shipping, Text, "off", "l3 | touchpad | l2: the host control that sends a light Triangle (R139).") /* read: ps2xRuntime/src/lib/socom2_host_input.cpp:socom2HostInputPoll */ \
    X("PS2X_PAD_DEADZONE", Shipping, Float, "0.15", "Stick dead zone 0-0.5 on all three pad paths.") /* read: ps2xRuntime/include/runtime/host_gamepad_select.h:hostPadDeadZone */ \
    X("PS2X_PC_SAMPLER", Dev, Float, "", "Seconds between [pc-sampler] rows (guest pc/ra per thread); PEEK rides on it.") \
    X("PS2X_PEEK", Dev, Spec, "", "0xADDR[:words][,...] with * dereferences: guest words printed with each sampler row.") \
    X("PS2X_PK_REPLAY", Test, Path, "", "ps2x_tests: a vu1_replay packet file to push through the GS frontend.") \
    X("PS2X_PRESENT_FILTER", Shipping, Text, "linear", "linear | integer | point: how the frame is scaled into the window.") /* read: ps2xRuntime/src/lib/ps2_runtime.cpp:run */ \
    X("PS2X_RDRAM_DUMP", Dev, Spec, "", "<file>[:<seconds>]: dump guest RAM after n seconds (default 10).") \
    X("PS2X_RDRAM_DUMP_AT", Dev, Spec, "", "<file>:<0xPC>#<count>: dump guest RAM when a pc has been reached n times.") \
    X("PS2X_SCHED_TRACE", Dev, Flag, "0", "The per-guest-thread scheduler trace: switches, waits, samples and slow stubs (research/36 item 16).") \
    X("PS2X_SCHED_TRACE_MAX_LINES_PER_S", Dev, Int, "4000", "With SCHED_TRACE: lines per host second before the trace is capped.") \
    X("PS2X_SCHED_TRACE_SAMPLE_MS", Dev, Float, "20", "With SCHED_TRACE: host ms between samples of the running thread.") \
    X("PS2X_SCHED_TRACE_STUBS", Dev, Spec, "", "With SCHED_TRACE: name[,...] of stubs traced on every call, with arguments and return.") \
    X("PS2X_SCHED_TRACE_STUB_MS", Dev, Float, "1", "With SCHED_TRACE: a bound stub slower than this many host ms is reported.") \
    X("PS2X_SCHED_TRACE_TOML", Dev, Path, "recomp/socom2.toml", "With SCHED_TRACE: the recompiler config naming the stubs.") \
    X("PS2X_SND_MUTE_BANK", Dev, Spec, "", "0xHANDLE[,...]: play nothing from these 989snd banks (which sound is the stray one).") \
    X("PS2X_SND_STREAM_WORKER", Dev, Int, "1", "0 reads audio streams on the mixer thread instead of the worker (A/B).") \
    X("PS2X_SOCOM2_HOSTS", Dev, Spec, "", "name=ip[,...]: extra host-name answers for the resolver the game uses.") \
    X("PS2X_SOCOM2_INPUT_FILE", Dev, Path, "", "Pad-state injection file polled by a sampler thread; how the harness presses buttons.") \
    X("PS2X_SOCOM2_INPUT_SCRIPT", Dev, Spec, "", "t:BTN[+BTN][:hold],...: press buttons at those seconds.") \
    X("PS2X_SOCOM2_INPUT_TRACE", Dev, Presence, "", "Log every change of the pad state the game will read.") \
    X("PS2X_SOCOM2_LOGIN_NAME", Shipping, Text, "", "The persona name the login keyboard opens with (Goal 9, R180: prefilled, never submitted); unset = empty.") /* read: ps2xRuntime/src/lib/game_overrides_socom2.cpp:socom2_OskOpenPrefill ps2xRuntime/src/lib/game_overrides_socom2.cpp:installOskPrefill */ \
    X("PS2X_SOCOM2_LOGIN_PASS", Shipping, Text, "", "The password the login keyboard opens with (R179: plain in the player's config.json, blanked from reports).") /* read: ps2xRuntime/src/lib/game_overrides_socom2.cpp:socom2_OskOpenPrefill ps2xRuntime/src/lib/game_overrides_socom2.cpp:installOskPrefill */ \
    X("PS2X_SOCOM2_MUSIC_TRACE", Dev, Presence, "", "Log the music manager and every cue push with the mixer frame clock (music round four).") \
    X("PS2X_SOCOM2_NET_STATS", Dev, Flag, "1", "sceInetInterfaceControl 0x200 answers the RX byte count; 0 restores the constant that froze online movement.") /* read: ps2xRuntime/src/lib/socom2_libnetb.cpp:netStatsEnabled */ \
    X("PS2X_SOCOM2_NET_TRACE", Dev, Presence, "", "Verbose libnetb: every RPC, socket and datagram header.") \
    X("PS2X_SOCOM2_NET_TRACE_ALL", Dev, Flag, "0", "With NET_TRACE: hex-dump datagrams on every port, not only the peer ports.") \
    X("PS2X_SOCOM2_NET_TRACE_PEERS", Dev, Int, "16", "With NET_TRACE: peer packets to hex-dump in each direction.") \
    X("PS2X_SOCOM2_PAD", Shipping, Flag, "1", "The libpad2 HLE and host input path; 0 boots with no controller.") /* read: ps2xRuntime/src/lib/socom2_pad2_hle.cpp:socom2PadEnabled */ \
    X("PS2X_SOCOM2_PAD_TRACE", Dev, Presence, "", "Log the scePad2 socket lifecycle and reads.") \
    X("PS2X_SOCOM2_RSA_KEY", Shipping, Text, "a", "b (or B, 1) selects the second precomputed RSA pair (a second instance on one host).") /* read: ps2xRuntime/src/lib/socom2_crypto.cpp:socom2_RsaGenerateKeyPair */ \
    X("PS2X_SOCOM2_SERVER", Shipping, Text, "127.0.0.1", "Address or name every Medius/DNAS host name resolves to.") /* read: ps2xRuntime/src/lib/socom2_hostnet.cpp:loadHosts */ \
    X("PS2X_SOCOM2_UDP_SHIFT", Shipping, Int, "0", "Shift the fixed UDP ports 3658.. by n, in the host bind and the port rt_net advertises (a second instance).") /* read: ps2xRuntime/src/lib/game_overrides_socom2.cpp:socom2UdpShift ps2xRuntime/src/lib/socom2_libnetb.cpp:doCreate */ \
    X("PS2X_TEST_SKIP", Test, Text, "", "ps2x_tests: skip tests whose name contains one of these substrings.") \
    X("PS2X_TEST_SUITE", Test, Text, "", "ps2x_tests: run only suites whose name contains this.") \
    X("PS2X_TRACE_FIFO", Dev, Presence, "", "Log VIF1/GIF FIFO stalls, resumes and the IRQ dispatch.") \
    X("PS2X_TRACE_VIF", Dev, Spec, "", "<skip> | t<seconds> | trig: print VIF1 codes and chain tags.") \
    X("PS2X_TRACE_VU", Dev, Int, "", "Skip n VU1 programs then dump the next three; forces the cycle-exact scheduler.") \
    X("PS2X_TRACE_VU_FLAGS", Dev, Presence, "", "Log what the VU flag readers see.") \
    X("PS2X_TRACE_VU_STEPS", Dev, Int, "1200", "With TRACE_VU: instruction budget per traced program.") \
    X("PS2X_TRIGGER", Dev, Spec, "", "lo:hi: arm the trig trace modes when the first PEEK word, as a float, lies in the range.") \
    X("PS2X_VIF1_NO_IRQ_STALL", Dev, Flag, "0", "Restore VIF1 without the i-bit stall (A/B).") \
    X("PS2X_VU0_FAST", Dev, Int, "1", "0 keeps VU0 micro programs on the cycle-exact scheduler.") \
    X("PS2X_VU1_BAILHIST", Dev, Presence, "", "Histogram of where generated VU1 code bails to the interpreter.") \
    X("PS2X_VU1_DUMP", Dev, Path, "", "Dump VU1 program state at each run for vu1_replay (armed by TRIGGER or VU1_DUMP_AFTER).") \
    X("PS2X_VU1_DUMP_AFTER", Dev, Float, "0", "With VU1_DUMP: arm after this many seconds.") \
    X("PS2X_VU1_FAST", Dev, Int, "1", "0 selects the cycle-exact VU1 scheduler.") \
    X("PS2X_VU1_FMAC_CHECK", Dev, Flag, "0", "Cross-check the SIMD MAC-flag classifier against the long double path.") \
    X("PS2X_VU1_GEN", Dev, Int, "1", "0 disables the generated VU1 programs.") \
    X("PS2X_VU1_HOST_DRAW", Dev, Int, "0", "1 draws the native dispatcher triangles in host space instead of kicking GIF packets.") \
    X("PS2X_VU1_NATIVE", Dev, Int, "1", "0 reverts the hand-written native VU1 programs to the generated/interpreted path.") \
    X("PS2X_VU1_NATIVE_TEST_CEILING", Dev, Int, "", "Test hook: lower the native dispatcher vertex and triangle ceilings.") \
    X("PS2X_VU1_NATIVE_TEST_CLIP_CEILING", Dev, Int, "", "Test hook: lower the native dispatcher clipped-vertex ceiling.") \
    X("PS2X_VU1_XGKICK_CYCLE_EXACT", Dev, Flag, "0", "Restore the per-cycle XGKICK transfer model (drops SOCOM II object geometry).") \
    X("PS2X_VU_STATS", Dev, Presence, "", "Once a second: VU1 programs, cycles and host time.") \
    X("PS2X_WATCH", Dev, Spec, "", "0xADDR[,...]: poll guest words every ~0.5 ms and print each change with pc/ra.") \
    X("PS2X_WATCH_HUGE", Dev, Spec, "", "0xADDR:words: report floats in the range that turn huge or NaN.") \
    X("PS2X_WINDOW_SIZE", Shipping, Text, "640x448", "<w>x<h> (64-16384) | fullscreen (borderless): the window at creation; unset or invalid = 640x448.") /* read: ps2xRuntime/src/lib/ps2_runtime.cpp:initialize */ \
    X("PS2X_WINDOW_TITLE", Dev, Text, "", "Window-title tag for a second instance; the harness finds windows by it.")

namespace ps2x
{
    // The value of a registered knob, or nullptr: when the variable is unset or empty, when the name is not in
    // the table, when the knob is Dev and the process is not in developer mode, or when it is a Path outside
    // the game folder for a stranger (pathInsideHome). With enforcement off (the Knobs suite only) this is a
    // plain std::getenv(name). Never caches -- tests and BareRun::applyEnvironment change
    // the environment while the process runs -- so a site on a hot path reads once into its own static.
    const char *knob(const char *name);

    // The one flag rule on top of knob(): dflt when knob() is nullptr (or empty); false for "0", "false", "off";
    // true for anything else.
    bool knobOn(const char *name, bool dflt = false);

    namespace knobs
    {
        enum class Class { Shipping, Dev, Test, Switch };
        enum class Kind { Flag, Presence, Int, Float, Text, Path, Spec };

        struct Entry
        {
            const char *name;
            Class cls;
            Kind kind;
            const char *dflt;
            const char *meaning;
        };

#define PS2X_KNOB_ENTRY(name, cls, kind, dflt, meaning) Entry{name, Class::cls, Kind::kind, dflt, meaning},
        inline constexpr Entry kTable[] = {PS2X_KNOB_TABLE(PS2X_KNOB_ENTRY)};
#undef PS2X_KNOB_ENTRY
        inline constexpr size_t kTableSize = sizeof(kTable) / sizeof(kTable[0]);

        const Entry *find(const char *name);
        const char *className(Class cls);
        const char *kindName(Kind kind);
        bool flagValue(const char *value, bool dflt);

        // Sprint 10 Q2 (R207): a Path knob's value must lie under the game folder -- the process's current
        // directory, which both launcher glues and the bare run set to the folder the executable lives in --
        // or, for a stranger, it reads as unset. The disc image is the one file that is only read and lives
        // where the player keeps it. Developer mode lifts the rule (the gate's card and frame live under logs/).
        bool pathInsideHome(const char *name, const char *value);

        // Developer mode: setDevMode() (the runner's --dev, ps2x_tests, vu1_replay) or, failing that,
        // PS2X_DEV under the flag rule, read once on first use.
        bool devMode();
        void setDevMode(bool on);
        void resetDevModeForTests();   // forget the decision so the next devMode() reads PS2X_DEV again

        // On. setEnforcement(false) exists for the Knobs suite, which proves what off meant.
        bool enforcement();
        void setEnforcement(bool on);

        // Removes every "--dev" after argv[0], closes the gap, keeps argv null-terminated. True when one was there.
        bool consumeDevFlag(int &argc, char **argv);

        // One line for the log: what is set and honoured, what was set and ignored, what was refused. `set` is the non-empty
        // PS2X_* variables in table order. A Shipping value equal to its default is not news; a Path is cut to
        // its last component (the diagnostics zip must not carry a home directory); 40 characters a value; a
        // credential (PS2X_SOCOM2_LOGIN_PASS) is written as [redacted], whoever is asking (R208).
        using Pairs = std::vector<std::pair<std::string, std::string>>;
        std::string describe(const Pairs &set, bool honourDev);
        std::string startupLine();     // describe() over this process's environment
    }
}
