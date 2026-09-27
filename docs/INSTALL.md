# Installing SOCOM Unzipped

SOCOM II: U.S. Navy SEALs, statically recompiled into a native PC program. **It plays from your own disc.** No game
data, and nothing from your disc, will be distributed with the public download (#70); tester archives carry the ELF
by the owner's hand. Nothing on this page works without your own ISO of the US
retail release.

This page is for players. Building it yourself is `DEVELOPING.md`; what is proven and what is still open is
`KNOWN.md`; what to do when something specific goes wrong is `FAQ.md`.

> **Multiplayer has not been audited for security** — read `../SECURITY.md` before you go online.

---

## 1. What you need

- **A Windows 10 or 11 PC (64-bit).** Windows is the platform the project plays on today. A Linux tarball is built
  by the same packaging step and the client boots and draws in the project's test VM, but Linux is not a released
  platform yet — `KNOWN.md` has the state of it.
- **A GPU and driver with OpenGL 3.3 and dual-source blending.** The launcher does not test this; the game does, once,
  at startup. Without it the game still runs — on a software rasteriser, far too slowly to play — and leaves with
  exit code 65, whose sentence the launcher shows on its LAST RUN line. `FAQ.md` has that entry.
- **Your own SOCOM II disc, as an ISO**: the US retail release, `SCUS-97275`, **disc revision r0001**. No other disc
  works, and the launcher will not start the game on one.
- **A controller** — an Xbox pad, or any DirectInput pad Windows recognises. The keyboard walks the menus and types,
  but the launcher's own CONTROLLER page says it plainly: *"Playing needs a controller."*
- **Optional: a microphone.** The game does not send your voice yet; the MICROPHONE page lets you pick the device and
  watch its meter, so it is ready when voice lands (`KNOWN.md`'s voice row).

Nothing else is installed and nothing is written outside the game's own folder.

## 2. Get the archive

**There is no public download yet.** Builds are handed to testers by hand. The download will be the program; the game's
image is built from your own disc on first run (#70). When there is a download, it will be announced at <https://s2u.scotho.com>, which also carries the setup guide
and the server's live status.

Every archive ships with a `SHA256SUMS` file beside it. Check the archive against it before you unzip.

## 3. Unzip it

- **Windows:** `socom2-portable.zip` unpacks to a folder called `socom2`.
- **Linux:** `socom2-linux.tar.gz` unpacks to `socom2-linux`.

Put it wherever you like. There is no installer, no registry entry and no administrator prompt; **delete the folder
to uninstall.**

Keep every file in it together. The folder holds the game (`socom2.exe`), the game's program image
(`socom2_game.elf` — the tester archive today; the public download builds it from your disc, #70), the launcher (`socom_unzipped_launcher.exe`), the libraries those two import, `LICENSES/`, a
short `README.txt`, and empty `cards/` and `logs/` folders. Move or lose `socom2_game.elf` and the game refuses to
start with exit code 68: *"The game's program image (.elf) is missing or damaged. Unpack the download again and keep
every file together."*

## 4. Run the launcher

- **Windows:** double-click **`socom_unzipped_launcher.exe`**.
- **Linux:** open a terminal in the folder and run

  ```
  ./socom_unzipped_launcher
  ```

The executable is not code-signed, so the first launch on Windows brings up SmartScreen. `FAQ.md` says what it shows
and what to do about it.

The launcher is one window with a page rail down the side: **PLAY**, **DISC**, **VIDEO**, **AUDIO**, **CONTROLLER**,
**MICROPHONE**, **ONLINE**, **REPORT A BUG**, **ABOUT**. It owns every setting; the game itself has no options
screen of its own beyond the ones on the disc.

## 5. Point it at your ISO — the DISC page

Press **BROWSE...** and pick your ISO, or type the path into the DISC IMAGE field. The launcher reads the file
`SCUS_972.75` out of the image and hashes it against the pinned NTSC r0001 digest, then shows a lamp and one
sentence. These are the sentences, exactly as it prints them:

| The verdict | What it means |
|---|---|
| `SOCOM II U.S. Navy SEALs NTSC r0001` | Green. This is the disc; you can play. |
| `choose your SOCOM II disc image first` | No image is set yet. |
| `cannot open the file` | The path is wrong (the file was moved or renamed, or its drive is not there), or the file cannot be read. |
| `not a SOCOM II disc image (no SCUS_972.75)` | The image opened, but it is not SOCOM II. |
| `cannot read SCUS_972.75` | The file is on the disc but the image is damaged there. |
| `not SOCOM II NTSC r0001 (SCUS_972.75 differs)` | A SOCOM II disc, but not the revision this build plays. |

**RE-VERIFY (F5)** checks again — after replacing the file, for instance. The page says what it does with your image
and means it: *"Nothing is copied and nothing is installed: the game reads your image where it sits."* and *"The
disc image is yours; none of it ships with SOCOM Unzipped."*

## 6. Set up your pad — the CONTROLLER page

The page has two sections.

**SETUP** picks which pad the game reads and sets the stick **DEAD ZONE**. A drawing of a pad sits above:
*"Press a button: what lights up above is what the game reads. The ring is the dead zone."* If no pad is found it
says so instead. Under the dead zone, the launcher states what the keyboard is for: *"Menus and typing: arrows, Enter, Esc, Backspace, Space, Z/X/C/V."*
and *"Q/E/1/2/3/4: L1/R1/L2/L3/R2/R3. Playing needs a controller."* -- the second line is why the crouch shortcut
below can move fire mode to the 2 key. *(Until 2026-09-25 the first line said "only" and the second named no keys,
which the crouch hint contradicted; Sprint 13 V8.)*

**BUTTONS** rebinds what each pad button and each key sends to the game. A mapping is saved **per profile**, so two
people sharing one machine keep their own.

One row there is worth reading before your first mission: **CROUCH = LIGHT** (a light Triangle). On the console, crouch is a *light*
press of Triangle, which no PC pad can produce — so without a shortcut a pad can only go prone. The default
shortcut is **L-STICK CLICK**: *"Left stick click crouches (the community's Xbox layout). Fire mode moves to the
keyboard's 2 key."* **TOUCHPAD** and **L2** are the alternatives, and **OFF** turns it off.

## 7. Play — the PLAY page

The PLAY page is four rows — DISC, VIDEO, CONTROLLER, ONLINE — each showing what the game is about to do, each with
a **CHANGE** button that jumps to the page that owns it. Under them is **GAME VERSION**, which says which build
LAUNCH starts. Then **LAUNCH**.

**GAME VERSION** has two cells, **r0001 (your disc)**, the one you play, and **r0004 (community update)**, greyed
for now — `FAQ.md`'s *"What is GAME VERSION, and why is "r0004 (community update)" greyed out?"* says why.

*(Until 2026-09-25 this page did not mention the GAME VERSION row, so its greyed cell went unexplained.)*

If LAUNCH is greyed out, the line above it says why: `the game is running`, or the DISC page's own sentence for the
disc's state (the table in section 5) -- `choose your SOCOM II disc image first`, `cannot open the file`, and so on.
*(Until 2026-09-25 every failed disc read `that file is not SOCOM II (NTSC, r0001)` here, a moved ISO included;
Sprint 13 V8.)*

After a run ends, a **LAST RUN** line appears between the rows and the button, carrying the sentence for however the
game exited. Every one of those sentences has an entry in `FAQ.md`.

## 8. Play online — the ONLINE page

**SERVER.** The default is already the right one: **SOCOM Unzipped (project server)**, *"the project's hosted server
(US East)"*, reached by name at `socom.scotho.com`. When the launcher can reach it, a status line from the server
itself appears at the top right of the page; when you are offline the line is simply blank. **Custom** takes any
address or hostname — your own Horizon server's, for instance. That server ships with no address of its own: its
configs hold the documentation placeholder `192.0.2.1` and `server/start-servers.ps1` will not start until you give
it this machine's address with `-PublicIp` (`server/README.md`, "Advertised address").

The community preset, **SOCOM Community (public Horizon)**, is drawn at the top of the list but is not on offer, and the launcher says why:
*"needs the r0004 game update -- planned"*. It cannot be selected, and pointing this client at a community server is
not supported — see `FAQ.md`.

**GAME VERSION** is the same row as on the PLAY page (§7).

**PERSONAS** lists every persona your memory cards have logged in with through this build, newest first: its name,
the server it was made on and when it last played. Pick one, press **LAUNCH**, then pick the same persona in the
game's own list. The last row, **NEW PERSONA**, is for one you have not made yet: *"the game asks for a name on its
own keyboard"*, keeps it on the memory card, and it joins the list after its first login. The cards live in
`cards/<profile>/` (`cards/player/` unless you name another `profile` in `config.json` by hand).

Beside the selected row sits a masked **PASSWORD** field, shown only while the card does not hold that persona's
password: for NEW PERSONA, for a persona made on another server, and for one whose card has no password saved. A
password typed there opens the game's password keyboard already typed, and it is kept in plain text in `config.json`
beside the exe, only until the game remembers it. Every login that goes through writes a record beside the card
(`cards/<profile>.personas.json`: the name, the server, when, and whether the card holds the password -- never the
password itself); once a login goes through with nothing typed, the card holds the password, the launcher empties
that key and the field goes. Until then, hand `config.json` to nobody.

Two things to expect on your first round:

- **Your first login on any server is a create-persona login** — the name keyboard comes first. The game keeps saved
  personas per server, so a persona made on one server is not there on another; the list's heading says so when you
  pick it (*"made on ...; on this server the game makes a new persona"*).
- **The game's own SAVE PASSWORD works**; tick it and the next login goes through with nothing typed, which is what
  empties the launcher's PASSWORD field.

## 9. Where your saves, settings and logs live

Everything is inside the game's folder, beside the executables:

| Where | What |
|---|---|
| `cards/<profile>/` | Your simulated memory card — every in-game save. A second instance uses `cards/<profile>_b/`. |
| `logs/run_<stamp>.log` | One log per run of the game. The newest is the one to send with a report. |
| `config.json` | Every launcher setting: the ISO path, video, pad, server, profile — and a password typed on the ONLINE page, in plain text, until the card holds it. |
| `cards/<profile>.personas.json` | The PERSONAS list's record, beside the card, written on each login that goes through: name, server, when, and whether the card holds the password (never the password). |
| `diagnostics/` | The zips SAVE DIAGNOSTICS writes (created when you first press it). |

The launcher's **ABOUT** page shows the real paths for the first two, with an **OPEN LOGS** button, and repeats the
promise: *"Nothing is installed; delete the folder to remove it."* If the folder itself is not writable — a
protected location such as `Program Files` — the game exits 72 rather than losing a save: *"The memory-card folder
cannot be written. Move the game out of a protected folder and try again."*

## 10. Sending diagnostics and reporting a bug

**SAVE DIAGNOSTICS**, on the PLAY page, writes one zip into `diagnostics/`: the last log (clipped), your settings
through an allowlist that cuts the ISO down to its file name, what the GL driver reported, the crash record if there
was one, and the build's versions. Your home directory is scrubbed out of every file in it. **OPEN LOGS**, next to
it and also on ABOUT, opens the `logs/` folder.

If the launcher will not open at all, the same zip can be written without a window:

```
socom_unzipped_launcher.exe --diagnostics diagnostics.zip
```

**REPORT A BUG**, on the rail, is the launcher's own form — *"tell us what went wrong; nothing is sent until you
press SEND"*. It has **TITLE**, **WHAT HAPPENED**, **CONTACT (OPTIONAL)**, and a
tick box, **Attach the last run's log**, which is **off** until you turn it on. A line above the button spells out
exactly what would be sent, and until you press **SEND REPORT** the page says *"Nothing leaves this machine until
you press it."* On success the page prints a reference and copies it to your clipboard where it can — quote it if you
talk to us. If the site cannot be reached, the report is saved next to your logs instead, and the page tells you
where.

Reports also go through the **REPORT A BUG** form at <https://s2u.scotho.com>.
