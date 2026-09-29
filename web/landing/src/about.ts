// The About screen, dressed as SOCOM II's MISSION BRIEFING: a column of tabs on the left, a
// headed panel on the right whose text types itself out, DEPLOY at the bottom. Content is the
// socom_pc project (SOCOM Unzipped); the numbers are docs/STATUS.md's of 2026-09-21 (read 2026-09-22).

export interface Tab {
  readonly label: string;
  readonly head: string;
  readonly body: string;
  /** Whether the intel photo shows under the text (the game shows one on most tabs). */
  readonly photo: boolean;
}

export const TABS: readonly Tab[] = [
  {
    label: 'OVERVIEW',
    head: 'SOCOM UNZIPPED MISSION OVERVIEW',
    photo: true,
    body:
      "SOCOM 2 Unzipped brings SOCOM II: U.S. Navy SEALs, the 2003 PlayStation 2 classic, to " +
      "modern PCs. A faithful native port: the game's MIPS code, statically " +
      "recompiled into C++ and built as a native Windows or Linux program, with the PS2's graphics, vector units " +
      "and sound chip reimplemented on the host and checked frame by frame against PCSX2.",
  },
  {
    label: 'MISSION DETAILS',
    head: 'HOW THE PACKAGE WAS OPENED',
    photo: true,
    body:
      'Ghidra mapped the functions. A fork of PS2Recomp turned the MIPS into C++. The runtime ' +
      'supplies the EE kernel, DMAC, VIF, GIF, a software GS, a VU1 that runs 162 of 166 lists ' +
      'natively, and the IOP services at the SIF-RPC level. The 989snd mixer plays the disc\'s ' +
      'audio sample for sample.',
  },
  {
    label: 'OBJECTIVES',
    head: 'MISSION OBJECTIVES',
    photo: false,
    body:
      '[X] Boot to the title with the movie and music\n' +
      '[X] Play the single-player missions\n' +
      '[X] Run a control round on all 20 online maps\n' +
      '[X] Controller support and a launcher\n' +
      '[X] Windows and Linux builds\n' +
      '[X] A test server of the project\'s own: US East (Ohio), live stats here\n' +
      '[X] First rounds and kills on the test server\n' +
      '[ ] Community testing: strangers, two machines, bug reports\n' +
      '[ ] The r0004 update installed by the launcher, to play on the community\'s servers\n' +
      '[ ] Voice chat through the headset',
  },
  {
    label: 'MAPS/INTEL',
    head: 'INTEL: THE NUMBERS',
    photo: false,
    body:
      'Runtime tests ........... 764 pass\n' +
      'Python suite ............ 1671 tests\n' +
      'Parity gate ............. 3/3 (title, transition, mission)\n' +
      'VU1 microprograms ....... 166 lists, 162 native, bit-exact\n' +
      'Disc ..................... 35 ZDB packs, 69 movies, 577 MB of VAG\n' +
      'Title music ............. 0.99 correlation with the disc PCM\n' +
      'Portable download ....... 56 MB (Windows), 99 MB (Linux)',
  },
  {
    label: 'ARMORY',
    head: 'FIRETEAM LOADOUT. THE TOOLCHAIN.',
    photo: false,
    body:
      'PS2Recomp (vendored fork, GPL-3)   Ghidra 12.1 + EE extension\n' +
      'Unicorn EE harness                 llvm-mingw clang, CMake, Ninja\n' +
      'FFmpeg (sceMpeg HLE)               raylib + miniaudio\n' +
      'Horizon Private Server (online)    PCSX2 2.8.1 (the reference)\n' +
      'Python 3 + Playwright (parity)     A lot of Claude',
  },
];

export { GITHUB_URL } from './github';
// The development story: authored and cited in socom_pc (docs/STORY.md), rendered by its tools_py/story/site.py
// into this site's story.html, shipped with every s2u deploy.
export const STORY_URL = '/story.html';

export interface AboutState {
  readonly index: number;
}

/** `count` is the number of tabs on the screen (the SETUP GUIDE shares this state with its own tab set). */
export function createAbout(index = 0, count = TABS.length): AboutState {
  return { index: Math.min(Math.max(index, 0), count - 1) };
}

/** Tabs do not wrap in the game: moving past the ends stays put. */
export function moveTab(state: AboutState, delta: number, count = TABS.length): AboutState {
  return { index: Math.min(Math.max(state.index + delta, 0), count - 1) };
}

export function currentTab(state: AboutState, tabs: readonly Tab[] = TABS): Tab {
  return tabs[state.index];
}
