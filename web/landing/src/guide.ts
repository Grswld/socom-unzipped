// The SETUP GUIDE, in the MISSION BRIEFING frame (same Tab shape as about.ts, same screen in main.ts).
// Facts come from ../socom_pc as of 2026-09-27: docs/INSTALL.md, docs/FAQ.md and docs/KNOWN.md. Builds are handed
// to testers for now -- the repository is public (2026-09-22) but there is no public download yet, so this guide
// does not pretend there is one. Servers (owner, 2026-09-27): players will play on the community's servers, which
// run the r0004 revision; the project's own server is the test box, and this guide says so without selling it.
import type { Tab } from './about';

export const GUIDE_TABS: readonly Tab[] = [
  {
    label: 'REQUIREMENTS',
    head: 'BEFORE YOU DEPLOY',
    photo: false,
    body:
      'DISC\n' +
      '  - Your own SOCOM II: U.S. Navy SEALs, NTSC\n' +
      '  - SCUS-97275, release r0001, dumped to an ISO\n' +
      '  - Nothing of the game ships with SOCOM Unzipped\n' +
      'PC\n' +
      '  - Windows 10/11 64-bit, or 64-bit Linux (Ubuntu 24.04 tested)\n' +
      '  - A GPU with OpenGL 3.3 (without one: a slow CPU renderer)\n' +
      '  - About 300 MB of disk, plus your ISO\n' +
      'CONTROLS\n' +
      '  - Xbox, PlayStation or generic pad; keyboard for menus\n' +
      'ONLINE\n' +
      '  - Outbound TCP 10071-10078, UDP 10070 and 50000-50100\n' +
      'THE BUILD\n' +
      '  - Community testing is opening: builds go to testers for now\n' +
      '  - A public download will be linked here',
  },
  {
    label: 'INSTALL',
    head: 'UNZIP, POINT, LAUNCH',
    photo: false,
    body:
      '1. Unzip the portable folder anywhere you can write. Everything lives in it; delete it to uninstall.\n\n' +
      '2. Run socom_unzipped_launcher (Linux: ./socom_unzipped_launcher from the unpacked tarball).\n\n' +
      '3. DISC page: browse to your ISO. READY appears top-right once the disc is verified.\n\n' +
      '4. VIDEO: pick the render scale (1x native, 2x sharp) and window size. AUDIO: volume. ' +
      'CONTROLLER: the live pad shows exactly what the game will see.\n\n' +
      '5. Press LAUNCH. Saves land in cards/<profile>/ as plain files.',
  },
  {
    label: 'GO ONLINE',
    head: 'THE TEST SERVER NOW, THE COMMUNITY\'S LATER',
    photo: false,
    body:
      '1. ONLINE page: SOCOM Unzipped (project server) is preselected. It is the project\'s own test box, in ' +
      'US East (Ohio), where builds are checked against something known. The community preset is greyed with ' +
      '"needs the r0004 game update -- planned": the community\'s servers run that revision, and that is where ' +
      'play is headed once the launcher can install it.\n\n' +
      '2. PERSONAS: pick one your card has made, or NEW PERSONA. LAUNCH, then ONLINE in the game\'s menu, and connect.\n\n' +
      '3. FIRST LOGIN: the game asks for a player name, then a password. Any free name works. ' +
      'Use a throwaway password, not one you use elsewhere. ' +
      'What the server keeps about you, and how to have it deleted: socomunzipped.com/data.html.\n\n' +
      'The game keeps the persona on your card, per server.\n\n' +
      '4. Join a game or create one. SERVER on the main menu here shows who is on the test box right now.',
  },
  {
    label: 'TROUBLE',
    head: 'IF THE MISSION GOES SIDEWAYS',
    photo: false,
    body:
      'BLACK WINDOW, THEN EXIT: read what the launcher says. Exit code 65 means the OpenGL check failed ' +
      'and the CPU renderer took over; update the GPU driver.\n\n' +
      '"NO DISC": the ISO must be the NTSC r0001 release. The DISC page names what it found.\n\n' +
      'CANNOT CONNECT: check SERVER on the main menu here. If the test box is online, your network is blocking ' +
      'outbound TCP 10071-10078 or UDP 10070 and 50000-50100; if the launcher\'s LAST RUN line says the server ' +
      'name did not resolve, check your connection first.\n\n' +
      'ANYTHING ELSE: every run writes logs/run_<time>.log next to the launcher. Use BUG REPORT ' +
      'from the main menu and say what you did just before.',
  },
  {
    label: 'ROADMAP',
    head: 'WHAT IS NOT THERE YET',
    photo: false,
    body:
      'R0004. The community\'s servers run the r0004 revision of the game; the disc holds r0001, and that is ' +
      'what this build starts. The plan: the launcher fetches the community\'s update itself, builds the r0004 ' +
      'program on your machine, and the community preset lights. Until then the project\'s test box is the only ' +
      'server to point this build at.\n\n' +
      'VOICE. The game does not send your voice yet.\n\n' +
      'PUBLIC BUILDS. No download yet. The bar: a stranger, their own disc, a round against another stranger.\n\n' +
      'Found something? BUG REPORT, on the main menu. Want to help test? Say so in a report and leave a contact.',
  },
];
