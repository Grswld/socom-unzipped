# Pictures in the story — the inventory (spec §5.3)

One row per image `docs/STORY.md` shows. Every picture is a frame the project's own program produced, at the
resolution it runs, uncropped except to remove a desktop; none is an asset lifted out of the disc. A video row is the same thing at
length: a screen recording of the program's own windows, cropped to remove the desktop and cut down, with a poster frame beside it. The four that were
already tracked under `docs/research/assets/` are copied here so the story has one published path. This table is
also the input to Sprint 11 Goal 1's disc-derived decision table and Goal 5's accreditation inventory. **The line is
the owner's** (spec §9 Q1); `tools_py/story/cite.py` only keeps this list and the document in step.

| File | Entry | Bytes | Copied from | What it is |
|---|---|---:|---|---|
| `2026-09-08-online-lobby.png` | 2026-09-08 — The project's own program gets online | 70,290 | `logs/parity/ours_login/09_lobby.png` | our program's window, run ours_login |
| `2026-09-13-first-kill.png` | 2026-09-13 — The first kill | 491,420 | `docs/research/assets/22-first-kill.png` | our program's two windows, run s5_t5_ladder2; already tracked as docs/research/assets/22-first-kill.png |
| `2026-09-14-grey-hill-before.png` | 2026-09-16 — First hands-on session, and the controller work begins | 326,272 | `docs/research/assets/31-console-dump-gl-replay-before.png` | our renderer's output over a console-recorded command stream; already tracked as docs/research/assets/31-console-dump-gl-replay-before.png |
| `2026-09-16-brighten-fixed.png` | 2026-09-16 — Every frame was 1.73 times too dark | 435,440 | `docs/research/assets/31-console-dump-gl-replay-fixed.png` | our renderer's output over the same command stream; already tracked as docs/research/assets/31-console-dump-gl-replay-fixed.png |
| `2026-09-17-launcher-first-cut.png` | 2026-09-17 — A launcher, and a folder you can copy | 30,842 | `docs/research/assets/launcher-first-cut.png` | our launcher's window; already tracked as docs/research/assets/launcher-first-cut.png |
| `2026-09-17-foxhunt-map-select.png` | 2026-09-17 — Twenty maps in one night | 187,316 | `logs/parity/ours_control_foxhunt_guard/A_14b_map_foxhunt.png` | our program's window, run ours_control_foxhunt_guard |
| `2026-09-18-linux-boot-dialog.png` | 2026-09-18 — The game runs on Linux | 41,872 | `logs/parity/vm/latest_frame.png` | our program's window in the Linux VM, logs/parity/vm |
| `2026-09-19-launcher-controller-page.png` | 2026-09-19 — The launcher gets a face | 107,817 | `logs/parity/launcher_ui/controller_1100x700.png` | our launcher's window, run launcher_ui |
| `2026-09-19-hosted-kill-round-1.png` | 2026-09-19 — A server of its own, on the internet | 307,490 | `logs/parity/s8_hosted_kill/A_kill_r1.png` | our program's window, run s8_hosted_kill; frame inspected, carries the test persona only |
| `2026-09-20-playtest-mission.png` | 2026-09-20 — The first build made for a person to play | 274,392 | `logs/parity/gate/s9_p7_playtest_gate/mission/final.png` | our program's window, gate s9_p7_playtest_gate |
| `2026-09-20-mixed-match.png` | A console and a PC in the same match | 220,003 | `logs/parity/mixed2_pcsx2_hosts_g/play02.png` | our program's window, run mixed2_pcsx2_hosts_g |
| `2026-09-11-the-dialog-the-gate-answered-blindly.png` | The check that had been passing for free | 128,879 | `D:/socom_archive/gate/first/mission/final.png` | our program's window, the first gate run (archived to D:\\socom_archive\\gate\\first on 2026-09-13; logs/parity/gate_first.out is its surviving readout) |
| `2026-09-12-the-gate-stuck-on-a-card-prompt.png` | Four times the pixels, and no sharper HUD | 183,516 | `D:/socom_archive/gate/pf_point_stuck/title/final.png` | our program's window, gate pf_point_stuck (archived to D:\socom_archive\gate on 2026-09-13) |
| `2026-09-07-briefing-drawn-at-the-origin.png` | The console becomes the marking scheme | 311,091 | `logs/parity/runs/ours_a/s05_CROSS.png` | our program's window, run ours_a, logs/parity/runs/ours_a |
| `2026-09-05-menu-with-no-captions.png` | 2026-09-07 — The movies play | 127,064 | `logs/parity/runs/ours_a/s02_CROSS.png` | our program's window, run ours_a (2026-09-07 14:32, before the movie fix of that evening), logs/parity/runs/ours_a |
| `2026-09-05-the-card-prompt-upside-down.png` | 2026-09-05 — It plays its intro | 12,980 | `logs/host_cpu/host_001_6s.png` | our program's window, the software rasterizer's run of 2026-09-05 19:20, logs/host_cpu; the oldest frame on the project machine |
| `2026-09-05-the-title-at-full-speed.png` | 2026-09-05 — The main menu, at full speed | 203,332 | `logs/host/host_007_29s.png` | our program's window, the OpenGL backend's run of 2026-09-05 19:27, logs/host |
| `2026-09-07-flat-grey-and-a-night-sky.png` | 2026-09-07 — The first frames of a mission | 112,244 | `logs/shots_live/host_010_113s.png` | our program's window, the live-shot run of 2026-09-07 13:41, logs/shots_live |
| `2026-09-14-the-clipped-terrain-the-owner-spotted.png` | Two things the owner spotted | 287,637 | `D:/socom_archive/gate/20260912_143356/mission/final.png` | our program's window, gate 20260912_143356 (archived to D:\socom_archive\gate on 2026-09-13) |
| `2026-09-21-online-kill.mp4` | 2026-09-21 — One round, on film | 10,822,738 | `E:/ForClaude/online_kill.mp4` (a 4:14 screen recording of the desktop, 70.9 MB) | our program's two windows, one round on the hosted server, both clients agent-driven; the whole recording, cropped to the two windows (1022x378 at 49,216) and re-encoded (H.264 CRF 25); its poster `2026-09-21-online-kill.png` (323,661 bytes) is the frame at 3:42.5 of the recording, the killfeed on both screens |
| `2026-09-23-r0004-types-its-credits.png` | 2026-09-23 — The update the community server asks for, taken apart | 26,352 | `logs/parity/gate/s11_r0004_loopd1/title/w00_006.png` | our program's window running the r0004 build, gate s11_r0004_loopd1 (2026-09-23 23:38, a failing run; the frame is the developer credit before the reboot) |
| `2026-09-24-r0004-round-on-our-server.png` | 2026-09-24 — The update plays, and cannot meet the original | 330,558 | `logs/parity/s11_r0004_round2c/A_hold02.png` | our program's window running the r0004 build in a round on the project's own server, run s11_r0004_round2c; frame inspected, carries the test persona only |
| `2026-09-25-the-sprint-11-close-frame.png` | 2026-09-25 — Sprint 11 closes, and the borrowed fixes stay | 393,090 | `logs/parity/gate/s11_close_gate/mission/final.png` | our program's window, gate s11_close_gate (the close proof on exe b74a6132) |
| `2026-09-25-the-renamed-r0004-menu.png` | 2026-09-25 — The names come home, and both editions still pass | 289,045 | `logs/parity/gate/s12_names_r0004_gate/title/s04_none.png` | our program's window running the renamed r0004 build, gate s12_names_r0004_gate |
| `2026-09-25-the-relaunch-form-with-the-password-kept.png` | 2026-09-25 — The debts, paid in one day | 161,437 | `logs/parity/v6_20260925_160634/b/02_persona.png` | our program's window on the relaunch of run v6_20260925_160634 (launch b, nothing typed); frame inspected, carries the test persona only |
| `2026-09-27-the-first-sprint-16-chain-frame.png` | 2026-09-27 — Version 0.15.0 without its play test, and a sprint called "ten minutes to the server" | 392,142 | `logs/parity/gate/s16_v0/mission/w46_001.png` | our program's window, gate s16_v0 (the first Sprint 16 chain, the tree at 39bff922), mission stage step 46 |
| `2026-09-27-the-form-the-ledger-was-written-from.png` | 2026-09-27 — The game remembers who you are, and the update has an address | 161,125 | `logs/parity/s16_l1b_step0b/launch3/02_persona.png` | our program's window on the relaunch of run s16_l1b_step0b (launch 3, nothing typed); frame inspected, carries the test persona only |
| `2026-09-27-the-design-system-gallery.png` | 2026-09-27 — The site gets its name, the map viewer comes home, and the look is written down | 94,497 | a Playwright screenshot of `http://localhost:5181/ds/` (the scotho repository's dev server, branch s2u-design-system at 3487276), 1280x900, not full page | the site's own design-system gallery, not a frame of the game and nothing from the disc; the one picture here that is not the program's window (the owner's ask, 2026-09-27) |

Total: 27 pictures and 1 video with its poster, 16,854,542 bytes.

*(2026-09-25: `2026-09-14-grey-hill-before.png` was an **orphan row** — a row for a picture `docs/STORY.md` no
longer showed, which `tools_py/story/cite.py` cannot catch because it only checks the other direction. It is the
"before" half of the brighten pair whose "after" was already shown, so it is restored to the 2026-09-16 hands-on
entry — the sitting where the owner saw that hillside; the brighten entry already has its one picture, which spec
§5.3 caps — and its Entry column corrected. The counts and the byte total above already included it and are
unchanged.)*
