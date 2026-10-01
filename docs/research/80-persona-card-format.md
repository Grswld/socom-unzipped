# 80 -- The memory card's persona file, decoded

**Asked by the owner, 2026-09-28:** "we have examples to validate those assumptions against surely? why block it if we
match the exact format of the parallel files on disk" -- on Sprint 16 D12/R310's claim that the card's persona record
is "an opaque block nothing decodes". Written by the persona-card session the same day from the example cards under
`logs/parity/*/mc0/` and the recompiled code; nothing here needed a game run. The plan that builds on it is
`docs/superpowers/plans/2026-09-28-persona-card-creator.md`; the reference decoder is `tools_py/card_save.py`.

## Short answer

Every file the game writes into `BASCUS-97275SOCOMII/` except the icons is a ZAR version-2 archive (the same
container as `READERC.ZAR`, reCOM's `zar.h`) passed through a fixed-seed byte scrambler with no key. The persona
store is the archive key `CAcctDB/AcctInfo.rdr`, a serialised rdr tree with one record per persona: `HOST` (the
resolved server address), `NAME`, `TOWN`, `GENDER`, `PORT`, `PASSWORD` **in plain text**, `SAVEPASSWORD`, `PROFILES`.
A Python decoder/encoder round-trips all 72 example files byte for byte. "Opaque" was an assumption; it was never
tested against the seven persona files on disk.

## How it was found

1. `game/overlays/all_strings.txt` names the classes: `CSaveManager::Save`, `CSaveModuleList`, `zSaveHeader`,
   `CAcctDB`, `CLobbySaveModule`. An lui/addiu scan over `ftscore.bin` (load `0x1e7000`) put `CSaveManager::Save` at
   `0x33dff0` (`recomp/output/CSaveManager_Save_0x33dff0.cpp`) and its header reader at `sub_0033D4A0`.
2. `CSaveManager::Save` builds the archive in a `CBufferIO` with `zar::CZAR` (ctor `0x2590a0`, `Open` `0x258920`
   with mode `0x1a` and padding 16, `Insert` `0x25a2f0`, `NewKey`/`CloseKey` `0x258740`/`0x258720`, `WriteDirectory`
   `0x258bd0`), calls `sub_0033DC30(buffer, size)` and writes the buffer to the card through the `CIO` vtable
   (`+0x2C`). `FUN_0033de00` is the inverse, called by the loader.
3. `sub_0033DC30` is 114 instructions: a forward pass with `k = 0x96`, per byte `c = p ^ (s8)k; k = (k ^ (k + p)) &
   0xff` (`p` the plaintext byte, signed), then a backward pass from the second-last byte seeded by the last byte, the
   same step. Decoding runs the backward pass first (advancing `k` with the decoded byte), then the forward pass.
4. The decoded file parses as a ZAR V2 with `flags 0, padding 16, crc 0, appversion 14` under reCOM's
   `ReadDirectory_V2` (`docs/research/11-recom-applicability.md`, "zArchive"). Its keys: root -> `zSaveHeader` (268 B)
   and `CSaveModuleList` -> {`CUIVarManager` -> ten 64-byte `MPLOCALSOP<n>.rdr` / `MPTAUNTMSG<n>.rdr` children once the
   game has been online, `CValveSaveManager` -> `PersistentValves.rdr` (4144 B), `CAcctDB` -> `AcctInfo.rdr`}.
   `SaveGame<n>` files are the same container with `CMission` -> `MissionData.rdr`.
5. `AcctInfo.rdr` is the in-memory rdr node format (`tools_py/rdr_tree.py`) flattened: header `{u32 1, u32
   stable_size, u32 node_ofs}` (node_ofs = 12 + stable_size rounded up to 16), a NUL-separated string table, then
   8-byte nodes `{u8 type, u8 flags, u16 count, u32 value}`; type 1 int, type 3 string (value = table offset), type 4
   list (count nodes at node-section offset value); flags 4 marks a node the game shared between records. The root
   is the persona list; a persona is 16 nodes, name/value pairs: `HOST` [str], `NAME` [str], `TOWN` [str], `GENDER`
   [int], `PORT` [int], `PASSWORD` [str], `SAVEPASSWORD` [int], `PROFILES` [str `PROFILE_CHECKSUM`, 16 ints, str
   `PROFILE_INFO`, empty list]. A virgin card's blob is 24 bytes: the header and an empty list.

## What the examples say

| Card | Records | HOST | NAME / PASSWORD | SAVEPASSWORD | Checksum |
|---|---|---|---|---|---|
| `virgin_card`, `_card2`, `_card3`, `_card5`, `f0`, `f2` (4784 B) | 0 | -- | -- | -- | -- |
| `s16_l1b_step0` (6208 B) | 1 | `3.143.65.100` | `s27pa` / `s27pa2` | 1 | 16 zeros |
| `s16_l1b_step0b` (6400 B) | 2 | `3.143.65.100` | `s16pc` / `pwsixc`, then `s16pd` / `pwsixd` | 1 | 16 zeros |
| `w10_virgin` (6208 B, a LAN run) | 1 | the box's private LAN address | `w2-test` / `socom` | 1 | 16 zeros |

- **HOST is the resolved address the game connected to**, which settles KNOWN §1's per-server row: the discriminator
  is the address, not MUIS's `DNS` string as such and not the launcher's preset.
- **The password is stored plain.** `SecurePassword` in the string list is a UI variable, not a transform.
- **The form shows the first record** (Step 0b); the order in the file is the order of the game's list.
- `zSaveHeader` holds `{268, 14, ...}` then guest heap pointers and floats that differ on every run; the loader reads
  the 268 bytes and, in `sub_0033D4A0`, checks nothing else; a writer copies a template's.
- The one-persona and two-persona files differ by exactly one appended record and the archive's string table.

## What it changes

- Sprint 16 D12/R310's sidecar ledger was a workaround for a decode that did not exist; the card is the store (the
  plan's R-A). LATER row 46's "runtime steer" is a file reorder (R-C).
- The plain `PASSWORD` on the card is the game's own storage, on a folder the player owns; `SECURITY.md` says so.
- Fixtures: `third_party/ps2recomp/ps2xTest/fixtures/cards/{virgin,one,two}.bin` are `virgin_card`,
  `s16_l1b_step0` and `s16_l1b_step0b`'s persona files; the C++ tests and `tools_py/tests/test_card_save.py` read them.
