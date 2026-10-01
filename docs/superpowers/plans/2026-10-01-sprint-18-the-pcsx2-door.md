# Sprint 18 Implementation Plan — "the PCSX2 door" (OPEN 2026-10-01 02:40Z on `sprint-18` off `sprint-17` at the opening commit; proposed 02:10Z; GitHub milestone 8)

> **For agentic workers:** REQUIRED SUB-SKILL: the project's `loop-iteration` skill runs this plan (one task at a time,
> a failing test first, a fresh reviewer per task, the lock for every build and run, every lock-bound step a window);
> it is the project's form of superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

> Spec: `docs/superpowers/specs/2026-10-01-sprint-18-the-pcsx2-door-design.md` (the owner's word of 2026-10-01
> ~02:00Z, quoted in its head). Written by the main-tree controller session against `sprint-17` at `caa149d9`. Task
> bodies (files, steps, tests, verification) are in `docs/superpowers/plans/2026-10-01-sprint-18-tasks.md`
> <!-- docmaint: future -->; this file holds the table, the rulings, the Outcome and the Log.

**Goal:** the launcher has a global NATIVE / PCSX2 client toggle with entirely separate saved settings; in the PCSX2
client a player selects or installs PCSX2 (one INSTALL button, the official GitHub release, verified), picks our
server or a custom address (the community server stays "coming soon"), and LAUNCH starts PCSX2 on their ISO with the
network pointed at the server's name service and the DNAS bypass in place; the hosted box answers SOCOM II's host
names on 53/udp; one proof from this host reaches our lobby through PCSX2.

**Architecture:** a pure core in `ps2xShared` (`client_mode`, `pcsx2_config`, `pcsx2_files`, `pcsx2_install`: JSON,
the ini merge, the pnach, the release parse, the DNS pick — all testable without raylib or a socket), four glue
additions (`startProcess`, a redirect-following download, `runAndWait`, `resolveIpv4` + the adapter list), and a UI
that reuses the pages: a rail per mode, one new page (PCSX2), the PLAY / DISC / ONLINE pages reading the active mode's
config and filtering the rows that do not apply. On the box, a Python DNS answerer as a fifth systemd unit, installed
by the same `install.sh`. Spike first, box second, proof last.

**Tech Stack:** C++17 (llvm-mingw, `build.sh runtime`), `ps2xTest` (MiniTest), Python 3 unittest, raylib UI,
WinHTTP, `C:\Windows\System32\tar.exe` (bsdtar), systemd, `aws lightsail`, `vm/lightsail/ssh.sh`, PCSX2 v2.8.x.

## Global Constraints

- **Order:** T0 (spike, a window) and T1 (box, lock-free) first and in parallel; T2 → T3 → T4 pure, lock-free, each in
  its own agent worktree on `agent/s18-*`; T5 → T6 UI (a launcher build under the lock each); T7 the proof (a window the
  owner names, O20); T8 the documents. A task out of order needs a ruling.
- **Rulings R339–R344** (the spec §2.2's R-A…R-F, numbered at the open) bind every task.
- **Nothing of the native client changes behaviour:** `config.json`'s keys, `Config`, `environmentFor`, the nine native
  pages' layout tests all pass unchanged except where a test names the rail or `kPageCount` (T5 updates those).
- **No file of a player's own PCSX2 is rewritten whole** (R-F): the ini is merged key by key inside `[DEV9/Eth]`; the
  pnach is written only when its bytes differ, the old one kept once as `.bak-<stamp>`.
- **No PCSX2 bytes in our repository or archives** (R-C): the launcher downloads; tests use a loopback server and a
  tiny stand-in archive built by the test.
- **The box:** `open-instance-public-ports` only (adds); `muis.json` untouched; the unit runs as `horizon`, binds the
  private interface, answers the six names only; verified from off the box before T1 closes.
- **Windows (R297):** every launcher build announced as a window; every PCSX2 boot in a window the owner names; nothing
  heavy under 3 GB free; the lock for both.
- **Commits:** `type(scope): what and why` ≤ 120 chars, `-- <paths>` on every commit, the session trailer.
- **Documents:** the `doc-maintenance` skill before writing into KNOWN, HAZARDS, LATER, DEVELOPING, HUMAN_TASKS.

## Review Focus

Inputs the spec implies that a task's own tests must pin (each line names its owning task; the test is written there):

1. **A `config.pcsx2.json` from a newer or older build** — unknown keys ignored, a missing key keeps its default, a
   malformed file is the defaults with one stderr line, never a crash or a half-read struct (T2).
2. **A player's PCSX2.ini with `[DEV9/Eth]` already present and other sections after it** — the merge replaces only
   our keys in that section, keeps every other line byte for byte, and appends the section when absent (T3).
3. **A server preset whose name does not resolve, or a Custom field holding a name, an IP with spaces, or nothing** —
   LAUNCH is refused with the sentence naming the name, never a PCSX2 started with `DNS1 =` empty (T3, T6).
4. **A release JSON with no Windows 7z asset, a digest in another algorithm, or a redirect to a host that is not
   `*.githubusercontent.com`** — INSTALL stops with a sentence, downloads nothing or deletes the partial file (T4).
5. **Switching the client while the native config is dirty, or while a game runs** — the dirty file is saved first,
   the other file is never written, and the running process keeps its own mode's LAST RUN line (T5, T6).

---

## The task table

| # | Task | Kind | Where | Verification | State |
|---|---|---|---|---|---|
| T0 | The spike: five PCSX2 questions on a fresh v2.8.2 (spec §3) | lock-bound (one PCSX2 boot, a window) | main tree, scratch folder under `logs/s18_spike/` | `docs/research/83-pcsx2-door-spike.md` answers 1-5 with the emulog lines | open | <!-- docmaint: future -->
| T1 | The box's name service: `socom-dns.py`, its unit, `install.sh`/`horizon-ctl.sh`, 53/udp | lock-free; the owner's authority for the firewall (spec head) | `agent/s18-dns`; the box by `vm/lightsail/ssh.sh` | `python -m unittest tools_py.tests.test_socom_dns`; `nslookup socom2-prod.pdonline.scea.com 3.143.65.100` from this host answers 3.143.65.100 | open |
| T2 | The mode and the second config: `client_mode`, `pcsx2_config`, JSON, `kPresetComingSoonNote` | lock-free, pure | `agent/s18-config` | `ps2x_tests --filter pcsx2_config` and `client_mode` green; the launcher suite unchanged | open |
| T3 | What the launcher writes for PCSX2: the ini merge, the pnach (embedded from the masters), the root, the DNS pick | lock-free, pure | `agent/s18-files` | `ps2x_tests --filter pcsx2_files`; `tools_py/tests/test_pcsx2_masters.py` extended to the embedded copy | open |
| T4 | INSTALL: the release parse, the redirect-following download, `runAndWait`, `resolveIpv4`, adapters | lock-free; glue + pure | `agent/s18-install` | `ps2x_tests --filter pcsx2_install` with the loopback server; `--install-pcsx2 <dir>` headless on this host (one real download, 26 MB) | open |
| T5 | The UI, part one: the top-bar toggle, the rail per mode, `Page::Pcsx2` (layout, page, tips) | a launcher build (lock) | `agent/s18-ui1` | the focus tests for both rails; `--screenshot` walk adds `pcsx2` shots; the pcsx2 tips test | open |
| T6 | The UI, part two: PLAY / DISC / ONLINE in the PCSX2 view, the launch block, LAST RUN | a launcher build (lock) | `agent/s18-ui2` | `--selftest` prints both configs; the PCSX2 PLAY blocked-reasons test; a launch from the window starts PCSX2 (T7 proves the rest) | open |
| T7 | The proof: INSTALL → BIOS → LAUNCH → wizard → our lobby, from this host, against the public box | lock-bound, a window (O20) | main tree | `logs/s18_proof/` (the emulog, the launcher log, the lobby shot); a KNOWN row | open |
| T8 | The documents: DEVELOPING (launcher files, the box's DNS), `server/README.md`, `docs/PCSX2_PLAY.md`, LATER rows, HUMAN_TASKS rows, CURRENT_SPRINT | lock-free | main tree | `python -m unittest tools_py.tests.test_doc_maintenance`; the ceilings | open | <!-- docmaint: future -->

GitHub issues, milestone 8: T0 #121, T1 #122, T2 #123, T3 #124, T4 #125, T5 #126, T6 #127, T7 #128, T8 #129.

Owner's rows this sprint adds to `docs/HUMAN_TASKS.md` (T1 and T8 write them): **O28** the firewall rule if the AWS
session is not live when T1 runs; **O29** the two-home hosted round (two players, two routers, one hosts) and the
first run with the player group; **O30** the guide's copy on the site (`From your disc to the lobby`, a PCSX2
subsection) once the scotho design system lands.

## Rulings (numbered at the open from HANDOFF §2's counter; the full text and the reasons are the spec §2.2)

- **R339 (2026-10-01 02:40Z, Sprint 18 open, the spec's R-A) — two clients, one toggle, two files: a global NATIVE / PCSX2 client mode in the top bar, saved in `launcher.json`; the native client keeps `config.json` unchanged; the PCSX2 client has `config.pcsx2.json` and its own struct; no key shared, no value copied, switching never writes the other file.** Owner: "the global settings/saved settings for the two should be entirely unique."
- **R340 (2026-10-01 02:40Z, Sprint 18 open, R-B) — the community server stays "coming soon" in both views: the `community` preset keeps its placeholder address, its row is drawn greyed with the note `kPresetComingSoonNote` = "coming soon"; our server and Custom are live in both.** Owner: "Continue to block the community server as coming soon but prepare everything required to connect to our server or an arbitrary dns."
- **R341 (2026-10-01 02:40Z, Sprint 18 open, R-C) — PCSX2 comes from its official GitHub release, verified by the API's sha256 and size, downloaded over https following redirects only from `github.com` to a `*.githubusercontent.com` host, extracted by the system's `tar.exe`; nothing of PCSX2 ships in our repository or archives; SELECT names a player's own `pcsx2-qt.exe` instead.** Owner: "a single install button that obtains it from their official repo."
- **R342 (2026-10-01 02:40Z, Sprint 18 open, R-D) — the hosted box answers SOCOM II's six retail host names on 53/udp with `muis.json`'s `Endpoint`, NXDOMAIN for every other name, rate-capped per source, as a fifth systemd unit installed by `server/linux/install.sh`; the firewall gains 53/udp by `open-instance-public-ports` (adds), never `put-`.** Owner: "I grant you authority to make the dns changes on the lightsail machine if you have access in the sprint; if not the agent doing it can request them from me." An expired AWS session is the owner's row (O28), never a login by the loop.
- **R343 (2026-10-01 02:40Z, Sprint 18 open, R-E) — the PCSX2 client plays r0001 this sprint: its GAME VERSION row draws r0004 greyed with `kPcsx2RevisionNote`; r0004 on PCSX2 (the card package writer) is a `docs/LATER.md` row.** Why: everyone on the plain disc is one revision, so everyone can join everyone (KNOWN: the two revisions cannot join each other's games).
- **R344 (2026-10-01 02:40Z, Sprint 18 open, R-F) — PCSX2 owns what PCSX2 owns: the launcher writes `[DEV9/Eth]` (merged key by key) and `patches/0F6FC6CF.pnach` (the guarded master, replaced only when different, the old copy kept once as `.bak-<stamp>`) and nothing else in a PCSX2 the player selected; in the one it installed it may also lay out the folders; video, audio, controller, microphone and the BIOS are PCSX2's own pages, so the PCSX2 view has none of ours.** Owner: "everything else pcsx takes over"; "filter out what cannot be used."

## Outcome

(filled at the close: what landed, the proof's artefacts, the KNOWN rows moved, the LATER rows written, the owner's
rows left)

## Log (newest first)

- **2026-10-01 02:40Z** — OPEN. The owner approved the write-up ("excellent. write this up as a formal sprint 18"):
  the spec to APPROVED, rulings R339–R344 numbered (HANDOFF §2's counter bumped past them, `docs/RULINGS.md` regenerated),
  GitHub milestone 8 with one issue per task, `sprint-18` cut off `sprint-17` at the opening commit, CURRENT_SPRINT's
  header carries the second open branch. First items: T0 (a window) and T1 (lock-free), in parallel.
- **2026-10-01 02:10Z** — spec and plan written in the main tree on `sprint-17` at `caa149d9` by the controller
  session, on the owner's word of this hour; the branch `sprint-18` is not cut yet; T0 and T1 are the first items.
