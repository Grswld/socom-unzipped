# Sprint 18 design — "the PCSX2 door": the launcher gets a second client, PCSX2, that plays the retail disc on our server

Date: 2026-10-01 02:10Z (by `date -u`). Status: **APPROVED** by the owner 2026-10-01 ~02:35Z ("excellent. write this
up as a formal sprint 18"); the sprint is OPEN on `sprint-18` off `sprint-17` (GitHub milestone 8), its rulings
R339–R344 are the plan's. Written in the main tree on `sprint-17` at `caa149d9` on the owner's word of this hour,
verbatim in substance: *"Write this up as a sprint and make a global toggle for the
client (pcsx2 / native). Continue to block the community server as coming soon but prepare everything required to
connect to our server or an arbitrary dns. Offer the option to select your pcsx2 instance, and beside it, a single
install button that obtains it from their official repo with a little tooltip ui. Use the existing components of our
launcher, just create two views and filter out what cannot be used. The global settings/saved settings for the two
should be entirely unique. I grant you authority to make the dns changes on the lightsail machine if you have access
in the sprint; if not the agent doing it can request them from me."*

The vocabulary is `docs/KNOWN.md`'s; KNOWN wins on any disagreement. Every fact in §1 names where it was read on
2026-10-01 in this tree.

## Why this is a sprint and not a task

A group of players holds the disc image and wants to play on our server now, and the owner does not call the native
client's netcode safe yet. The retail disc running in PCSX2 against our Horizon box is a path every piece of which the
harness has already walked on one LAN (§1.1), and nothing on the server side distinguishes a PCSX2 client from ours.
What is missing is the last mile for a player who is not technical: a DNS answer the disc can find from any home, a
PCSX2 pointed at it with the DNAS bypass in place, and one button that does both. That is a launcher mode, a box
service and a proof, across the launcher's shared library, its UI, the server tree and the hosted box — four places,
one order, one proof at the end.

## 1. What is established (2026-10-01) — **[verified: the tree and the notes named]**

### 1.1 The PCSX2 path, as the harness walks it

- The disc resolves `socom2-prod.pdonline.scea.com`, `socom2-prod.muis.pdonline.scea.com` and the three
  `gate1.*.dnas.playstation.org` names; `tools_py/parity/dns_stub.py` answers exactly those (and
  `www.playstation.org`) with one address and NXDOMAIN for everything else (`NAMES`, lines 29-36).
- PCSX2's `[DEV9/Eth]` in Sockets mode with `InterceptDHCP = true` hands the guest `DNS1`/`DNS2` through its own DHCP;
  the guest's network wizard on "Automatic" takes them (`docs/research/18-online-round-start.md:137-160`). PCSX2's own
  `[DEV9/Eth/Hosts]` table was found **not honoured** there (line 136); this sprint does not rely on it.
- The DNAS check is stubbed by one guarded pnach that is safe on both disc layouts
  (`scripts/parity/pcsx2/0F6FC6CF.pnach`; the guard words and `tools_py/tests/test_pcsx2_masters.py`, issue #112). An
  unlabeled pnach under PCSX2's `patches/` folder is applied (the reboot-loop of 2026-09-28 was that file applying
  unconditionally: `docs/HAZARDS.md:349`).
- A PCSX2 client has played a full online round against our own Horizon, advancing to round 2 (`docs/KNOWN.md:62`,
  research/18 §1). r0004 presents r0001's AppId, so the box answers either revision unchanged, but **the two revisions
  cannot join each other's games** (`docs/KNOWN.md:29`).
- The match itself is peer to peer on UDP 3658 between the players (host style); Medius, DME and the NAT echo on the
  box carry the lobby, the chat and the bookkeeping only (research/18; the owner, 2026-09-30).

### 1.2 The box

`vm/lightsail/README.md` (git-ignored): `socom-unzipped-server`, static IP **3.143.65.100**, Ubuntu 24.04, the four
Horizon units under `/opt/socom-unzipped-server` installed by `server/linux/install.sh`, console output to the
journal. Firewall: 10071, 10073, 10075, 10078/tcp, 10070/udp, 50000-50100/udp from anywhere; **no 53/udp**.
`put-instance-public-ports` replaces the whole set; `open-instance-public-ports` adds a rule (README line 79). AWS
access is `aws login` (browser, the owner approves); an expired session is asked of the owner before a new login.
`muis.json`'s `Endpoint` is the IP literal and must stay so (personas key on it; README "Restart and update").

### 1.3 The launcher

- `launcher::Config` ↔ `config.json` (`ps2xShared/include/launcher/launcher_config.h`): the ISO, the game revision,
  the server preset (`community` with a `_TBC` address = not playable, `unzipped` = `socom.scotho.com`, `custom`), the
  typed address, the personas, the second instance, and the native client's video, audio, pad and microphone settings.
  `presetAvailable` greys the community row and the note drawn on it is `kRevisionMissingNote` ("needs the r0004 game
  update -- planned"), shared with the greyed revision cell.
- Nine pages in a fixed rail (`ui/focus.h` `Page`, `kPageCount = 9`; `focus.cpp` `kPages`); `FocusGraph::build` lays
  every page out; a page raises request flags and `main.cpp`'s loop acts (`ui/pages.h`). The top bar is
  `drawTopBar` (`main.cpp:531`), with the UNSAVED pill.
- Tooltips are one pure table per page (`ui/tips.h`, `page_<slug>_tips.cpp`), shown on hover and in the bottom bar
  on focus (#74).
- Glue (`win32_glue.h`): `startGame` spawns the game with an environment and a log; `httpRequest` (1 MB cap, https
  only) and `httpDownload` (streamed to `<dest>.part`, renamed when complete, **redirects refused**); `openFolder`.
  `launcher::patchfetch::verifyPackage(path, bytes, sha256)` deletes a file that is the wrong size or digest.
- PCSX2 v2.8.2 (2026-09-04) ships Windows as `pcsx2-v2.8.2-windows-x64-Qt.7z` (25,670,075 bytes) and an installer;
  the GitHub releases API carries each asset's `digest` (`sha256:…`) and `browser_download_url`, which 302-redirects to
  `*.githubusercontent.com` (read 2026-10-01 02:00Z from `api.github.com/repos/PCSX2/pcsx2/releases/latest`). Windows
  ships `C:\Windows\System32\tar.exe` = bsdtar 3.8.8 with liblzma, which reads 7z archives (this host, 02:05Z).
- PCSX2 is GPL v3. Redistributing it is lawful with the license and the matching source; downloading the official
  release instead ships nothing of theirs and keeps the players on their binary (the owner's conversation of this
  evening).

## 2. The sprint

### 2.1 Goal

A player with the r0001 disc image and a PS2 BIOS dump switches the launcher to PCSX2, presses INSTALL, puts the BIOS
in the folder the page names, presses LAUNCH, runs the game's network wizard on automatic answers once, and reaches
our lobby — without editing a file. The box answers SOCOM II's host names for anyone on the internet. The native
client is untouched: its pages, its `config.json`, its behaviour.

### 2.2 The six decisions (rulings R339–R344, numbered at the open; R-A = R339 … R-F = R344)

- **R-A — two clients, one toggle, two files.** The launcher has a global client mode, NATIVE or PCSX2, in the top bar
  on every page, saved in its own file `launcher.json` (`{"client": "native"}`). The native client keeps
  `config.json` unchanged; the PCSX2 client has `config.pcsx2.json` and a struct of its own (`Pcsx2Config`). No key is
  shared, no value is copied between them, and switching never writes the other file. *Why:* the owner's "entirely
  unique"; a setting that leaks across modes is a setting a player cannot find.
- **R-B — the community server stays "coming soon" in both views.** The `community` preset keeps its `_TBC` address;
  the row is drawn greyed with the note **"coming soon"** (one new string `kPresetComingSoonNote`, in place of
  `kRevisionMissingNote` on the preset row; the revision cell keeps its own note). Our server and Custom are live in
  both. *Why:* the owner's word; and a PCSX2 client could reach PSRewired today, which is exactly why the row must say
  "coming soon" rather than vanish.
- **R-C — PCSX2 comes from its official release, verified, never from us.** INSTALL reads
  `api.github.com/repos/PCSX2/pcsx2/releases/latest`, picks the `-windows-x64-Qt.7z` asset, downloads it over https
  following redirects only from `github.com` to a `*.githubusercontent.com` host, checks size and the API's sha256
  with the existing `verifyPackage`, extracts with the system's `tar.exe` into `<launcher>/pcsx2/`, and writes
  `portable.txt` there. The archive never ships in ours. SELECT lets a player name a `pcsx2-qt.exe` they already have
  instead. *Why:* no redistribution question, their updates intact, their team's preference respected.
- **R-D — the box answers SOCOM II's names on 53/udp, those names only.** A `socom-dns` unit beside the four Horizon
  units runs the stub's logic (the six names → `muis.json`'s `Endpoint`; NXDOMAIN otherwise; a per-source rate cap;
  quiet logging), bound to the box's private interface. The firewall gains 53/udp from anywhere by
  `open-instance-public-ports` (adds; never `put-`). *Why:* a player's PCSX2 then needs one IP, the server's own,
  and a self-hoster who runs our `install.sh` gets the same door.
- **R-E — the PCSX2 client plays r0001 in this sprint.** Its GAME VERSION row draws r0004 greyed, "needs the card
  package -- later": r0004 on PCSX2 is the PSRewired package on the memory card, a card writer this sprint does not
  build (a `docs/LATER.md` row). The DNAS pnach the launcher writes is the guarded master, safe on either layout.
  *Why:* everyone on the plain disc is one revision, so everyone can join everyone (§1.1).
- **R-F — PCSX2 owns what PCSX2 owns.** The launcher writes `[DEV9/Eth]` (network on, Sockets, DHCP interception,
  DNS1/DNS2 = the chosen server's address, the adapter), `patches/0F6FC6CF.pnach`, and nothing else in a PCSX2 the
  player selected; in the one it installed it may also lay out the folders. Video, audio, controller, microphone and
  the BIOS are PCSX2's own pages: the PCSX2 view has none of ours, and its PCSX2 page says where PCSX2 keeps them.
  *Why:* "everything else PCSX2 takes over" (the owner); a merge that touches one section cannot wreck a player's
  install.

### 2.3 Scope — in

1. **The box's name service** (R-D): `server/linux/socom-dns.py`, `socom-dns.service`, `install.sh` and
   `horizon-ctl.sh` carrying it, the firewall rule, `server/README.md`'s hosting section; verified with `nslookup
   socom2-prod.pdonline.scea.com 3.143.65.100` from this host.
2. **The mode and the second config** (R-A): `launcher/client_mode.h`, `launcher/pcsx2_config.h`, their JSON, the
   top-bar toggle, the rail per mode.
3. **The PCSX2 page**: INSTANCE (the path, SELECT, INSTALL with its tooltip and progress), VERSION, BIOS (the folder,
   found or not, OPEN FOLDER), the sentence on PCSX2's own settings, the license line.
4. **The PCSX2 view of PLAY, DISC and ONLINE**: PLAY's rows and LAUNCH start PCSX2; DISC binds to the PCSX2 config's
   ISO; ONLINE keeps SERVER (community "coming soon"), GAME VERSION (r0004 greyed), ADDRESS, and tells the player
   personas are made in the game; the second instance, the personas list and the password are filtered out.
5. **What the launcher writes before a PCSX2 launch** (R-F): the ini merge, the pnach, the folders of a managed
   install; the server name resolved to an address; the adapter picked.
6. **The proof**: from this host, the launcher installs PCSX2, the game boots the player's ISO, the wizard on automatic
   answers, the lobby on the public box; recorded in KNOWN with its artefacts. The two-home hosted round is the
   owner's row (two players, two routers), and the first test with the player group is the owner's.
7. **The player guide**: `docs/PCSX2_PLAY.md` — from the ISO to the lobby in the PCSX2 client, with the hosting <!-- docmaint: future -->
   paragraph (the host's UDP 3658; pick the player with the friendliest router); its site copy is the owner's row.

### 2.4 Scope — out (each a `docs/LATER.md` row at the close)

r0004 on PCSX2 (the card package writer); the personas list and creator for the PCSX2 client (PCSX2 folder cards
would make it the same code; unproven); a second PCSX2 instance from the launcher; a Linux PCSX2 client (AppImage);
answering the names from a public DNS zone instead of the box; a real PS2 (a LAN DNS and the card: the guide's
last paragraph names the path, nothing is built).

### 2.5 Order and shape

T0 the spike, lock-bound in a window (one PCSX2 boot on this host, five questions, §3); T1 the box, lock-free,
first, because every later proof needs it; T2 → T3 → T4 pure code with tests, lock-free, in agent worktrees; T5 → T6
the UI; T7 the proof (a window); T8 the documents. Four to five loop days. Branch `sprint-18` off `sprint-17` (the
persona creator the PCSX2 page builds on is on `sprint-17`, not `main`); its PR targets `sprint-17` while Sprint 17
is open, `main` after. Every task's review by a fresh reviewer; the launcher builds under the lock; no game run
outside a window.

## 3. The spike's questions (T0; the answers go to `docs/research/83-pcsx2-door-spike.md`) <!-- docmaint: future -->

1. Does `C:\Windows\System32\tar.exe -xf <the 7z> -C <dir>` extract `pcsx2-v2.8.2-windows-x64-Qt.7z` whole
   (`pcsx2-qt.exe` present, the DLLs beside it)?
2. Does a fresh extracted PCSX2 with `portable.txt`, a BIOS under `bios/` and our `[DEV9/Eth]` boot an ISO from the
   command line (`pcsx2-qt.exe -batch -- <iso>`; confirm the flags against `pcsx2-qt.exe --help`), and does it exit
   when the game stops?
3. Does the unlabeled pnach under `patches/` apply on that fresh install (the emulog's "Loaded … patches" line, and
   the game passing DNAS without a network)?
4. What does PCSX2 do with `Slot1_Filename` naming a card that does not exist: create `Mcd001.ps2`, or refuse? Does an
   empty directory of that name count as a folder card?
5. With `EthApi = Sockets`, does an empty `EthDevice` bind, or must the launcher name an adapter GUID (and which API
   lists them: `GetAdaptersAddresses`' `AdapterName`)?

A "no" to 1 or 2 changes T4's design (an installer run, or a bundled decoder) and is a ruling before T4 begins.
