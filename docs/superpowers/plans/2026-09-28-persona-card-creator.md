# Persona creator on the card -- the launcher writes the persona the game reads

Written 2026-09-28 19:55Z by the persona-card session (worktree `wt-persona-card`, branch `agent/persona-card` off
`sprint-17` at `42809322`) on the owner's ruling of the same hour: "proceed ... ensure you test new writes against an
empty dist with no card yet, and that the game boots and recognizes the profile up to online. no further testing
needs to be done." It revisits Sprint 16 L1 (#73): the owner's intent was always a persona creator that takes a name
and a password and writes them to the memory card; L1 shipped a viewer over a sidecar ledger because D12/R310 held
the card's persona record to be "an opaque block nothing decodes". That was never tested. The decode is in section 1.

**Goal:** on the launcher's ONLINE page, NEW PERSONA takes a NAME and a PASSWORD and writes the persona into the
selected card exactly as the game writes it; the PERSONAS list reads the card itself; picking a row puts that persona
first on the card so the game's login form arrives with it. Proof: from an empty dist with no `cards/` directory, the
launcher writes the card, the game boots and the CONNECT TO SOCOM II form shows the persona with its password saved.

**Rulings this plan proposes (the controller numbers them):**
- **R-A -- the card is the persona store; the ledger stays for `lastLogin` only.** The viewer's rows come from the
  card's `AcctInfo.rdr` records; a ledger record with the same name and host adds "last played"; a ledger record with
  no card record is not a row. Why: the card is what the game reads, so what the card holds is the truth; the ledger
  was a workaround for a decode that did not exist. D12/R310 are revised in KNOWN by this evidence (Task 4).
- **R-B -- the password is written to the card in plain text with SAVEPASSWORD = 1, because that is the game's own
  storage** (every example card holds it so; section 1). `config.json` never keeps a password for a persona the card
  holds, as R310 already ruled; the launcher's masked PASSWORD field for NEW PERSONA becomes the creator's input and
  is cleared once the card is written.
- **R-C -- picking a row rewrites the card with that record first.** The game's form arrives with the first record
  (Step 0b, LATER row 46); reordering the list is the steer, in the file, no runtime change.

## 1. The card's persona file, decoded (2026-09-28, this session; the evidence is on disk)

`cards/<profile>/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII` (and every `SaveGame<n>`) is:

1. **A fixed-seed byte scrambler** over the whole file -- `sub_0033DC30` encodes, `FUN_0033de00` decodes
   (`recomp/output/`), called by `CSaveManager::Save` (0x33dff0) on the in-memory archive right before the card
   write. Encode, forward pass with `k = 0x96`: for each byte `p` (signed), `c = p ^ (s8)k; k = (k ^ (k + p)) & 0xff`;
   then a backward pass from the second-last byte down to the first seeded with `k = last byte (unsigned)`, the same
   step. Decode is the backward pass first (using the decoded byte to advance `k`), then the forward pass. No key.
2. **A ZAR version-2 archive** (reCOM `research/recom/src/gamez/zArchive/zar.h`; `docs/research/11-recom-applicability.md`
   "zArchive"): HEAD 25 words `{flags=0, key_count, stable_size, stable_ofs, padding=16, reserved[16], offset=data
   size, crc=0, appversion=14, version=0x20002}`, the string table, `key_count` 16-byte keys `{s32 name_ofs, u32
   offset, u32 size, s32 child_count}` in pre-order (root first, `name_ofs` relative to `stable_ofs`, the root's
   `name_ofs` 0 = unnamed), align to 16, then the data. Keys of the persona file: root -> `zSaveHeader` (268 B: word 0
   = 268, word 1 = 14, the rest guest heap pointers and floats that differ on every run -- the loader
   `sub_0033D4A0` reads the 268 bytes and checks nothing else in that routine), `CSaveModuleList` -> `CUIVarManager`
   (0 or 10 children of 64 B: `MPLOCALSOP1-5.rdr`, `MPTAUNTMSG1-5.rdr`), `CValveSaveManager` -> `PersistentValves.rdr`
   (4144 B), `CAcctDB` -> `AcctInfo.rdr`.
3. **`AcctInfo.rdr`, a serialised rdr tree**: header `{u32 1, u32 stable_size, u32 node_ofs}` (node_ofs = 12 +
   stable_size rounded up to 16), the string table (NUL-terminated strings), then 8-byte nodes `{u8 type, u8 flags,
   u16 count, u32 value}` -- type 1 int (value), type 3 string (value = offset into the string table), type 4 list
   (count children at node-section offset `value`); flags 4 marks a node shared with an earlier record (the game's
   dedupe; a writer may write 0 and its own copy). The root is a list of personas; each persona is a list of 16
   nodes: `HOST` -> [str], `NAME` -> [str], `TOWN` -> [str], `GENDER` -> [int], `PORT` -> [int], `PASSWORD` -> [str],
   `SAVEPASSWORD` -> [int], `PROFILES` -> [str `PROFILE_CHECKSUM`, list of 16 ints, str `PROFILE_INFO`, list of 0].
   Examples: `{HOST "3.143.65.100", NAME "s16pc", TOWN "", GENDER 0, PORT 10075, PASSWORD "pwsixc", SAVEPASSWORD 1,
   checksum all zero}` (`logs/parity/s16_l1b_step0b`, two records, `s16pd`/`pwsixd` second); W10's card (a LAN run) holds
   the box's private LAN address as HOST -- **HOST is the address the game connected to, resolved**, and it is the per-server key
   KNOWN §1 left open. A virgin card's `AcctInfo.rdr` is 24 bytes: the header and one empty list.

The Python reference decoder/encoder (`tools_py/card_save.py`, Task 1) round-trips all 72 files under
`logs/parity/*/mc0/BASCUS-97275SOCOMII/` byte for byte. Fixtures for the C++ tests: `virgin_card`, `s16_l1b_step0`,
`s16_l1b_step0b` copied to `third_party/ps2recomp/ps2xTest/fixtures/cards/` (Task 1).

## 2. Global constraints

- Work only in `C:\projects\wt-persona-card`; commits with explicit pathspecs; no push (the URL is dead).
- A build is lock-bound: `bash scripts/loop_lock.sh run agent-persona-card --class build --wait 120 --purpose "..."
  -- ./build.sh test --no-runner`, announced to the controller (socom-pc-e0) by the controller session first; syntax
  checks (`clang -fsyntax-only`) need no lock. The ONE game run (Task 5) is the controller's window.
- Nothing connects to a server that is not ours. The proof logs in to the hosted box only if the driver gets that far;
  the bar is the form.
- Every agent dispatched is Opus (the owner's word). Tests first: RED then GREEN pasted in the report.
- The test suite never reads a real card: fixtures and temp directories only.

## 3. Tasks

### Task 1: the codec and the record -- `launcher/card_save.h` in ps2xShared, tests from fixtures

**Files:** create `third_party/ps2recomp/ps2xShared/include/launcher/card_save.h`,
`third_party/ps2recomp/ps2xShared/src/card_save.cpp` (add to `ps2xShared/CMakeLists.txt`); create
`third_party/ps2recomp/ps2xTest/src/card_save_tests.cpp` (add to `ps2xTest/CMakeLists.txt` beside
`persona_record_tests.cpp`, plus `target_compile_definitions(ps2_test_lib PRIVATE
PS2X_TEST_FIXTURES_DIR="${CMAKE_SOURCE_DIR}/ps2xTest/fixtures")`); fixtures under
`third_party/ps2recomp/ps2xTest/fixtures/cards/{virgin,one,two}.bin` (already copied); create `tools_py/card_save.py`
(the Python reference, already in place) and `tools_py/tests/test_card_save.py`.

**Interface (`namespace launcher::card`):**
```cpp
std::vector<uint8_t> unscramble(const std::vector<uint8_t> &);   // section 1 item 1
std::vector<uint8_t> scramble(const std::vector<uint8_t> &);
struct ZarKey { std::string name; std::vector<uint8_t> data; std::vector<ZarKey> children; };
bool parseZar(const std::vector<uint8_t> &plain, ZarKey &root, std::string &why);   // V2 only, flags 0
std::vector<uint8_t> buildZar(const ZarKey &root);                                  // appversion 14, padding 16, crc 0
struct Persona { std::string host, name, town, password; int gender = 0, port = 10075; bool savePassword = true;
                 std::array<int32_t,16> checksum{}; };
bool readPersonas(const std::vector<uint8_t> &acctInfo, std::vector<Persona> &out, std::string &why);
std::vector<uint8_t> writePersonas(const std::vector<Persona> &);
// The whole file: decode, find CAcctDB/AcctInfo.rdr, replace, rebuild, encode. `file` empty = start from the
// embedded virgin template (card_template.h, generated from fixtures/cards/virgin.bin, decoded).
bool readCardFile(const std::vector<uint8_t> &file, std::vector<Persona> &out, std::string &why);
std::vector<uint8_t> writeCardFile(const std::vector<uint8_t> &fileOrEmpty, const std::vector<Persona> &);
```

**Tests (write first, RED):** (a) `unscramble` of `two.bin` yields a V2 head (`version 0x20002`, 18 keys) and
`scramble(unscramble(x)) == x` for all three fixtures; (b) `parseZar` names the keys in section 1's order and
`buildZar(parse(x))` re-parses to the same tree (a byte-identical rebuild is NOT required: `stable_ofs` is a guest
address); (c) `readPersonas` on `two.bin`'s `AcctInfo.rdr` gives `s16pc/pwsixc/3.143.65.100/10075/save=1` then
`s16pd/pwsixd`; on `virgin.bin` gives none; (d) `writePersonas(readPersonas(two)) ` re-reads equal; (e)
`writeCardFile({}, {p})` decodes with the Python reference (`python -m tools_py.card_save --dump <file>` prints the
records as JSON; the C++ test writes a temp file and the Python unittest covers the reverse direction on the same
fixtures) and `readCardFile` of it gives `{p}`; (f) `writeCardFile(one.bin, {q, p})` reads back `q` then `p` and keeps
the other keys' bytes identical (`zSaveHeader`, `PersistentValves.rdr`, the ten `CUIVarManager` children).

**Verification:** `./build.sh test --no-runner` (lock-bound, announced) -> `ps2x_tests.exe` green;
`python -m unittest tools_py.tests.test_card_save`.

### Task 2: the creator, the CLI, the card-backed viewer and the reorder-on-pick (ps2xShared + launcher)

**Files:** `ps2xShared/include/launcher/personas.h`, `src/personas.cpp` (readCards reads the cards; `pick` reorders;
`createPersona`); `ps2xLauncher/src/main.cpp` (`--create-persona <name> <password> [profile]`, headless, prints the
card path, exit 0/1, after the `--report-bug` pattern at line 1085); `ps2xLauncher/src/ui/page_online.cpp`,
`ui/focus.cpp`/`focus.h` (NEW PERSONA selected: `online.persona.name` (cap 14, `keyboardAccepts(ch,false)`) and
`online.persona.password` (cap 12) and a `online.persona.create` row "CREATE ON CARD"; the caption under NEW
PERSONA becomes "type a name and a password, then CREATE"; help strings); `launcher_tests.cpp` (nodes present for NEW
PERSONA, absent for a record row); `persona`/`personas_tests` cases for readCards over a temp `cards/<p>/BASCUS.../`
built from `writeCardFile`.

**Behaviour:**
- `createPersona(home, config, name, password, note)`: `normalizeLoginName`/`normalizeLoginPassword` (R201/R202 caps);
  HOST = the IPv4 `effectiveServer(c)` resolves to (`getaddrinfo`; a dotted address as is; failure -> note, no
  write); PORT 10075 unless the address carries `:port`; reads `cards/<profile>[_b]/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII`
  if present else the template; upserts by (host, name) and puts the record FIRST; writes atomically (temp + rename);
  creates the directories. It writes only that file: the game makes `icon.sys`, `LIST.ICO`, `SaveGame*` itself when
  it next saves (Task 5 proves the game accepts a folder holding only the persona file; if it does not, the fallback
  is copying `icon.sys` and `LIST.ICO` from the ISO's `RUN/ICONS/NETCNF/` -- record the outcome in the Log).
- `readCards(cardsDir)`: for each `cards/<leaf>/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII`, `readCardFile` -> rows
  `{name, card=leaf, server=host, savedPassword = savePassword && !password.empty(), second = leaf ends "_b"}`; the
  ledger beside it (if any) supplies `lastLogin` for a matching (name, host or preset address); `counts(row, c)`
  compares the row's host with the resolved `effectiveServer(c)` (resolve once per read, cache in `Cards`). The
  "again" sentence and `savesWithoutLedger` go; the empty sentence becomes "No persona yet -- pick NEW PERSONA, type a
  name and a password, and CREATE writes it to your memory card."
- `pick(c, row)`: as today, plus `writeCardFile` with that record first when it is not already first.
- After CREATE: rows re-read, the new row selected, `loginPassword` and the typed name cleared, `app.dirty`.
- `environmentFor`: unchanged (a card-held password sends no `PS2X_SOCOM2_LOGIN_PASS`; `loginName` still prefills
  the keyboard for the create path a player takes in the game).

**Verification:** `./build.sh test --no-runner` green; `dist/socom_unzipped_launcher.exe --create-persona s17pc pwsevc`
in an empty temp home makes `cards/player/BASCUS-97275SOCOMII/BASCUS-97275SOCOMII` that
`python -m tools_py.card_save --dump` reads as one record.

### Task 3: review (a fresh Opus reviewer per `.claude/agents/reviewer.md`) of Tasks 1 and 2

### Task 4: the documents (this session)

`docs/KNOWN.md`: D12/R310's "opaque block" revised in place with the artefacts (R320 form); the per-server key row
settled (HOST = the resolved address); `docs/research/80-persona-card-format.md` (section 1 expanded, the routine
addresses, the fixtures); `docs/INSTALL.md` 144-176 (the creator replaces the "again" text; the password lives on the
card as the game keeps it); `SECURITY.md` one sentence (the card's plain PASSWORD is the game's own storage, the folder
is the player's); `docs/LATER.md` row 46 closed by R-C; `docs/HUMAN_TASKS.md` nothing.

### Task 5: the proof (this session with the controller's window) -- ONE game run

1. Fresh home: `mkdir <tmp>/dist_empty`, copy `dist/socom_unzipped_launcher.exe`'s config with the ISO path and the
   hosted preset, NO `cards/`. `socom_unzipped_launcher.exe --create-persona s17pc pwsevc` -> the card path printed.
2. `python -m tools_py.parity.online_login_ours --saved-password --mc-dir <that cards/player> --name s17pc --password
   pwsevc --out logs/parity/persona_card_proof --clean-exit` under the lock (the controller's window). Bar: the log's
   `[login] saved password: PASSWORD reads 6 glyphs, SAVE PASSWORD reads yes, focus connect` and `02_persona.png`
   showing `s17pc` -- the form recognised the persona. What follows (the lobby) is a bonus, not the bar.
3. The outcome in the Log, KNOWN's row and the hand-over to the controller: "reviewed, ready to merge", the branch,
   the reviewer's verdict, the verification command.

## Log

- 2026-09-28 19:55Z plan written; fixtures and `tools_py/card_save.py` copied in; Task 1 dispatched next.
- 2026-09-28 20:20Z Task 4 drafted: KNOWN's ledger row rewritten as the card-is-the-store row (it said the ledger was the persona record, written at the socket seam) and the per-server row settled to the address; LATER row 46 left the file (R-C); SECURITY's sentence; INSTALL's PERSONAS section and two table rows; research/80. Task 1 (Opus) is writing the codec; its build is held until the controller's "chain done" (~21:15Z) because a queued lock taker flips the chain's loop-lock smoke test.
- 2026-09-29 15:07Z Task 5 PASSED on the batch-4 exe (`logs/parity/persona_card_proof2/`): a fresh home with the launcher, its DLLs and no config.json; `--create-persona s17pc pwsevc player <home>` wrote the card with HOST 3.143.65.100; the game read it (`[login] persona: PLAYER NAME 5 glyphs, focus connect -> saved`; the saved password read; `LOBBY class=ok` at 84.5 s). The game accepts a folder holding only the persona file: the icon fallback is not needed. The first attempt (14:16Z) showed an empty form because the copied config.json pointed the card's HOST at the owner's custom server while the harness logged into the hosted one (the game keeps personas per server); `card_save --check-host` now guards the recipe (550a624e). A fresh home also needs the launcher's DLLs beside the exe.
