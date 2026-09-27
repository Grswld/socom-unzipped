# SOCOM Unzipped FAQ

Answers to the things that actually go wrong, for players. Setting it up in the first place is `INSTALL.md`.
Building it is `DEVELOPING.md`. What the project can and cannot prove about itself is `KNOWN.md` — it wins over
this page on any disagreement.

---

## The LAST RUN line: what the game's exit codes mean

When a run ends, the launcher's PLAY page shows a **LAST RUN** line with one sentence. Those sentences come from a
single table in the source (`third_party/ps2recomp/ps2xShared/include/ps2x/exit_codes.h`, which `tools_py/exit_codes.py`
reads rather than copies), so what you see below is what the launcher says, word for word.

Most of these are decided **before a window ever opens**: the game checks its own program image, the card folder,
the disc and the disc's revision first, so a bad setup fails in a second rather than on a black screen.

### 65 — no usable GL

> Your GPU or driver is missing OpenGL 3.3 with dual-source blending; the game ran on the slow CPU renderer.

The game **ran** — you got a picture, just far too slow to play. At startup it reads three things out of the GL
context: the version, dual-source draw buffers, and clip control. Missing version or dual-source blending drops it
to the software rasteriser, once and for good for that run. (Missing clip control is only noted, not fatal: depth
falls back to a fragment-depth mapping and the game plays.)

Where you meet it: any run, from the launcher or from `socom2.exe` on its own — the check is made once the window
has opened, so the game runs, slowly, and the code is what it leaves with.

What to do: update your graphics driver from the vendor, not from Windows Update. On a laptop with two GPUs, make
sure `socom2.exe` runs on the discrete one. If you are inside a virtual machine, its virtual GPU is probably the
problem. There is no setting in the launcher that turns this off — it is a fact about your driver.

### 66 — disc not found

> The disc image was not found. Open the DISC page and choose your SOCOM II ISO again.

The path in `config.json` no longer points at a file: the ISO was moved, renamed, or lives on a drive that is not
mounted right now. Open the DISC page and pick it again.

Where you meet it: the launcher checks the disc when it starts and when you press RE-VERIFY, and greys LAUNCH out
when the check fails — so from the launcher you see this code only if the ISO went away *after* that check (moved
while the launcher was open, or a drive unplugged). Starting `socom2.exe` on its own skips the launcher's check, and
then this is the first thing that stops it.

### 67 — disc not r0001

> That disc image is not SOCOM II NTSC r0001 (SCUS-97275). This build plays only that disc.

See *"Which disc revision do I need"* below.

Where you meet it: the launcher's own disc check stops a wrong disc earlier — LAUNCH greys out with the DISC page's
sentence, *"not SOCOM II NTSC r0001 (SCUS_972.75 differs)"* — so this code reaches you only when the file changed
after that check, or when `socom2.exe` was started on its own. *(Until 2026-09-25 LAUNCH read "that file is not
SOCOM II (NTSC, r0001)" for every failed disc; Sprint 13 V8.)*

*(Until 2026-09-25 this entry did not say where the code can be met; the launcher's check makes it rare from the
launcher. Since the same day every entry here says where its code can be met.)*

### 68 — ELF missing

> socom2_game.elf is missing or damaged. Unpack the download again and keep every file together.

`socom2_game.elf` is the game's own program image and it has to sit beside `socom2.exe`. This is usually an
antivirus quarantine or a half-finished unzip. Unpack the archive again into a clean folder, and check it against
the `SHA256SUMS` that ships beside it.

Where you meet it: from the launcher as well as on its own. The launcher checks the disc, not this file, so LAUNCH
stays lit and the game stops a second later, before its window opens.

### 69 — config unreadable

> config.json could not be read. Delete it and start the launcher, which writes a new one.

Exactly that. You lose your settings, not your saves — those are in `cards/`.

Where you meet it: only when `socom2.exe` is started on its own — that is the one path where the game reads
`config.json` itself. The launcher, given a damaged file, starts from the default settings instead.

### 70 — crashed

> The game crashed. Press SAVE DIAGNOSTICS and send the zip; it holds the crash record.

The game writes a crash record before the process dies, and the diagnostics zip carries it along with the log. This
code also covers a Windows access violation and a Linux fatal signal, which are folded onto it so the launcher has
one sentence to say. Please do send it — a crash without its record is a crash nobody can fix.

Where you meet it: at any moment of a run, from the launcher or on its own.

### 71 — out of memory

> The game ran out of memory. Close other programs, or lower the render scale on the VIDEO page.

The render scale on the VIDEO page is the largest single lever.

Where you meet it: at any moment of a run, from the launcher or on its own.

### 72 — card folder unwritable

> The memory-card folder cannot be written. Move the game out of a protected folder and try again.

The game keeps your saves in `cards/` **inside its own folder**, so that folder has to be writable. `Program Files`,
a read-only network share, an archived OneDrive folder, or a still-mounted zip will all do this. Move the whole
folder somewhere ordinary — your user folder or a second drive — and it goes away. This is checked before the
window opens, so no save is ever lost to it.

Where you meet it: before the window, from either path (the first card slot's folder); or later, when the second
slot's folder cannot be written — then the game carries on without that card and leaves with this code when it closes.

### 73 — wrong revision

> These game files are a different disc revision than this copy of the game was built for. Unpack the download again.

The generated code and the game files it reads are built for one disc revision, and the two have to match. This
almost always means a folder that mixes files from two downloads. Unpack the download again into an empty folder and
point the launcher at your ISO once more.

Where you meet it: at boot, from either path, before the title screen.

### 74 — the game asked to restart

> The game asked to restart itself after an error. This build cannot restart, so it stopped; the log says why.

SOCOM II reboots itself when it hits certain internal errors. On a console that is invisible; here there is nothing
to reboot into, so the run ends instead. The real failure is the one written just above the reboot line in the run
log — send that log with the report.

Where you meet it: in the middle of a run, from either path.

*(Two more you may see: **0** is a normal exit, and **1** or **3** mean the game stopped on an error it could not
name. Both ask you to press SAVE DIAGNOSTICS; the end of the log says more.)*

### Notices on the LAST RUN line

Some things are worth telling you without being the reason a run ended. The game writes them to its log as a
*notice*, and the launcher adds the sentence after whatever the exit was — *"The last run exited normally."*
followed by the notice, for example. They come from the same header as the codes above.

#### No audio device

> No audio device was found; the game ran without sound.

Where you meet it: any run, from the launcher or on its own, on a machine with no playback device when the game
starts (a headset unplugged, every output disabled in Windows' sound settings).

#### Server name did not resolve

> The server name on the ONLINE page did not resolve, so the game stayed offline. Check your connection or the name.

The ONLINE page's server is handed to the game as a name (`socom.scotho.com` by default), and the game looks it up
on its first network call. If the lookup fails — no internet, a DNS outage, a typo in **Custom** — the game refuses
the server instead of guessing: its online menus fail to connect, you can keep playing offline, and the run's own
exit sentence gets this one added.

Where you meet it: from the launcher or on its own, on a run in which the game made its first network call while
the server's name could not be resolved.

What to do: check that the machine is online, and if you typed a server under **Custom**, check the spelling. Then
launch again.

*(Until 2026-09-25 an unresolvable name was silently replaced by this machine's own address, so the failure read as
"the server is down" with nothing in LAST RUN; `docs/HAZARDS.md` (network) records the old hazard. For part of that day it was
exit code 75; ruling S13-R9 made it a notice, so it no longer hides a 65 or a 72.)*

---

## Setup and the disc

### Why isn't the ISO included? Where do I get the game?

Because it is not ours to give. SOCOM II is still the property of its rights holders. The **repository** holds none
of it: no game code, no recompiled C++, no assets — a pull request containing any of it is closed unread
(`../CONTRIBUTING.md`). The **download** holds the recompiled program (`socom2.exe`) and never the disc's code or
data: your disc supplies those, and the program image is built from it on your machine (issue #70).

So you need your own disc, and your own dump of it. This page will not tell you where to download one.

### Which disc revision do I need, and how do I check mine?

The US retail release, `SCUS-97275`, **disc revision r0001**. Nothing else, and not for a while: every other release
is a different code package.

**You do not have to check by hand — the launcher does it.** Point the DISC page at your ISO and it reads the file
`SCUS_972.75` out of the image and hashes it against a digest pinned in the source
(`kSocom2R0001ElfSha256`, in `third_party/ps2recomp/ps2xShared/include/launcher/launcher_config.h`). A green lamp
and the line `SOCOM II U.S. Navy SEALs NTSC r0001` means you have it; `not SOCOM II NTSC r0001 (SCUS_972.75 differs)`
means you have some other revision.

Because it is the *file's* hash and not the image's, how you dumped the disc does not matter — two different tools
that both produce a faithful r0001 image will both pass.

### What is GAME VERSION, and why is "r0004 (community update)" greyed out?

The **GAME VERSION** row sits on both the PLAY page and the ONLINE page and says which build LAUNCH starts. It has
two cells. **r0001 (your disc)** is the one you play. **r0004 (community update)** is the revision the community
servers run; the download does not include an r0004 build, so that cell is drawn greyed with
*"needs the r0004 game update -- planned"* beside it and cannot be picked. It is there so you know the version exists
and why it is not on offer, not because something is wrong with your setup. See *"Can I play on PSRewired or another
community server?"* below for why this client stays on r0001.

### Windows says "Windows protected your PC" and won't run the launcher

The build is not code-signed, by decision — a certificate is a cost and an identity the project has not taken on.
So Windows SmartScreen shows its blue dialog the first time you run an executable it has never seen. Choose
**More info**, then **Run anyway**. It stops asking after that.

Your antivirus may also quarantine `socom2.exe` or `socom2_game.elf` on sight, which shows up later as exit code 68.
Before you trust any build, check the archive against the `SHA256SUMS` published with it; after that, an exclusion
for the game's folder is the right fix. Turning your antivirus off entirely is not.

### What does Linux need installed?

The tarball carries what your distribution might not have — the FFmpeg family and what it pulls in — in a `lib/`
folder beside the binaries, found at run time through an RPATH. What it deliberately does **not** carry is your
machine's own stack, because those libraries have to be the ones that talk to your driver and your sound server:
glibc and the loader, libgcc and libstdc++, the GL/GLX/EGL dispatch, X11/xcb/xkbcommon/wayland, and
ALSA/PulseAudio/dbus. Every desktop distribution ships all of those; shipping our own libstdc++ is the classic way
to break a newer host's GL driver.

So in practice: a working OpenGL driver (your distribution's Mesa or the vendor's), PulseAudio or ALSA, and a normal
desktop. **Optional:** `zenity`, which the launcher uses for its file picker — without it, type the ISO path into
the field instead; and `curl`, which REPORT A BUG uses to send — without it the page says *"curl is not installed, so
nothing can be sent from here"* and saves the report next to your logs instead. **On Wayland** the pad's window
switch (the guide button toggling between the game and the launcher) does nothing when there is no X display to
open: it talks to X11, and says so.

*(Until 2026-09-25 this answer named only `zenity`, and did not say the window switch needs X11.)*

Linux is not a released platform yet; `KNOWN.md` has how far it has got. Builders start at `scripts/build_linux.sh`
(`DEVELOPING.md`).

---

## Online

### Do I need to open ports or forward anything?

To **play**, normally no. Your client makes outgoing connections to the hosted server and outgoing connections are
not what firewalls block. Let the game through the Windows firewall prompt the first time it asks, and that is
usually the end of it.

What it talks to, if you are on a network that filters outbound traffic: the Horizon server's TCP ports for the
universe lookup, authentication, the lobby and world data, one UDP port for the address echo, and a UDP port per
connected client from 50000 upward for game data. The exact numbers are in `../server/README.md`, which owns them —
that page is written for someone hosting a server, and it also lists what to forward if you are the one hosting.

Peer-to-peer play between clients uses the game's own **fixed** UDP ports, 3658 and 3659 — fixed because the
console's were. That matters in exactly one case: two copies running on the same machine would both try to bind
them, which is why the launcher's ONLINE page has a *Second instance on this machine (for testing)* toggle that
shifts the second copy's ports (to 3660/3661) and gives it its own card directory.

### Can I play on PSRewired or another community server?

**No, and please do not try.**

Two separate reasons, and each is enough on its own:

1. **It would not work.** The community servers run SOCOM II **r0004** — a different code package from the r0001
   disc this client is built from. That is why the launcher draws the community preset but refuses to select it,
   with the line *"needs the r0004 game update -- planned"*. An r0004 build now exists, passes the gate and plays
   online on the project's own server (2026-09-24) — but the launcher's community row is still a placeholder, and
   whether this client is ever pointed at somebody else's server is the owner's call, not this page's. Note also
   that r0001 and r0004 clients **cannot join each other's games**: the client's own token filter bounces the join
   silently.
2. **This client's network code has not been audited.** It is the game's own twenty-year-old code, recompiled
   as-is, running as a native program with your user's access — see `../SECURITY.md`. Aiming an unaudited client at
   other people's server is not a thing to do to them or to yourself.

SOCOM Unzipped is **not affiliated with, endorsed by, or connected to** the SOCOM community servers or their
operators. The preset row exists because a player would otherwise wonder; it is not an arrangement with anybody.

The project runs its own Horizon server and the launcher already points at it. That is the supported way to play
online.

---

## Things that go wrong in the game

### My save didn't stick / the game says it can't save

First, the boring cause: if the game's folder is not writable, you get exit code 72 before anything starts. See
above.

There was one more, and it is **fixed** as of 2026-09-22. The first save on a brand-new, never-used memory card
failed at the control-type prompt, and the same save worked on the next launch. The cause turned out to be ours: on
a fresh card the game asks the card for `..`, the current directory *is* the root, and our memory-card code refused
that as an attempt to climb past the root — so the game read the answer as a card it could not use. A trailing `..`
now resolves to the card root (a climb with anything after it is still refused, as it must be), with a regression
test that fails on the old behaviour. Fixed in commit `152579a`.

The instrument that found it stays: **every** build prints a line naming the failing card command and its result
code whenever a card command fails, with no setting to turn on. So if a save still fails on you, that log has the
answer — press **SAVE DIAGNOSTICS** and send the zip.

### The game won't remember my online password

It does. Tick **SAVE PASSWORD = YES** before **CONNECT**, and the persona and password come back from the memory
card on the next start (`KNOWN.md` §3, issue #27).

### The music cuts out, wobbles, or comes and goes

Music and mission ambience are mid-fix, and the fault is **ours**, not your speaker: the same capture on a wired
device dropped as much as on Bluetooth (14 against 11 over sixteen minutes, 2026-09-23), so something between the
mixer and the device loses about 50 ms of audio on **any** endpoint. `docs/KNOWN.md` §2 carries it with the numbers.
Report it anyway — include the log and **say which output you used**; the game writes the audio device, period and
rate into every run's log.

*(Until 2026-09-25 this section asked you whether you were listening over Bluetooth and sent you to try a wired
output. That attribution was retracted by measurement on 2026-09-23 and is now the `docs/KNOWN.md` §1 row "The mission
music's DEVICE dips are OURS" (this sentence said "§1's first row" until 2026-09-25; rows were added above it); it was
our defect the whole time, and this page was sending players after their own hardware.)*

---

## Sending something useful

Whatever the problem, the two things worth sending are the run log (`logs/run_<stamp>.log`) and the diagnostics zip
(**SAVE DIAGNOSTICS** on the PLAY page). The zip is assembled with your home directory scrubbed out of every file in
it and your ISO path cut down to its file name.

Use **REPORT A BUG** in the launcher, or the same form at <https://s2u.scotho.com>. Nothing leaves your machine
until you press SEND, and the page shows you what it would send before you do. `INSTALL.md` §10 walks through it.
