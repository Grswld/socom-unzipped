Date: 2026-09-27 (fix round after the first review's fourteen findings; every claim re-read at `main` `b534bd3`)
Spec: `docs/superpowers/specs/2026-09-27-sprint-16-ten-minutes-to-the-server-design.md` (L1; not in this cloud checkout, quoted from the brief). <!-- docmaint: future -->

# Sprint 16 L1 design note -- the profile viewer over the card's personas (issue #73, R295)

Written by a design reader in a cloud checkout with no game files, disc bytes or logs; every claim carries the path:line it was read from, and "not in the
tree" marks a fact the tree does not hold. R295 (`docs/superpowers/plans/2026-09-26-owner-sitting.md:52-56`): "a profile viewer on the ONLINE page replaces
the PROFILE, NAME and PASSWORD fields". Issue #73's body (read over the API, 0 comments) adds the sketch: one row per persona -- name, server "(the config's
server at the time, recorded by the launcher)", last played; picking a row sets the launch; "new persona" stays the game's flow.

## 1. What the card holds per persona

- **The card is a plain host directory.** `PS2X_MC_DIR=cards/<profile>` (`_b` for the second instance) is set by the launcher
  (`third_party/ps2recomp/ps2xShared/src/launcher_config.cpp:544-545`), read into `paths.mcRoot` (`ps2xRuntime/src/lib/ps2_runtime.cpp:1096`,
  `.../Kernel/Stubs/MemoryCard.cpp:171-172`; `mc0` beside the ELF absent the knob, `:171-183`), created on first use (`:217`). The game's save folder inside it is
  `BASCUS-97275SOCOMII` (`docs/HAZARDS.md:145`; `SaveGame0-6`, `docs/research/30-scope-at-spawn.md:69`). **Nothing else may live inside it**: the game's directory
  listing is the host directory's, every regular file unfiltered (`MemoryCard.cpp:1089-1127`), and the free-space count walks every file (`:245-287`).
- **The persona layout inside those files is not in the tree.** `docs/research/38-osk-open-function.md:1` is the keyboard note (the caps, 14 and 12), nothing
  about the card; the issue's citation of it for the card's layout is misplaced. Sprint 13 W10/V6 (`docs/KNOWN.md:201`) record behaviour, not bytes. No reader of
  the save format exists: `grep -rn 'SaveGame\|BASCUS' third_party/ps2recomp/ps2xShared third_party/ps2recomp/ps2xLauncher tools_py` returns six lines naming the
  folder or `APACHE00.ZDB`, none decoding a `SaveGame` record (`tools_py/decrypt_apache.py:319`, `decrypt_card_package.py:9,55`, `tests/test_gate.py:22,528`,
  `tests/test_mc_trace.py:52`); `tools_py/parity/mc_trace.py:1-16` parses the `[MC]` op trace.
- **The per-server key is unknown**: the peer address or MUIS's `DNS` string (`docs/KNOWN.md:62`), never the launcher's preset (`docs/HAZARDS.md:439`).
- **From the card alone** the name and server are not readable, SAVE PASSWORD is not, last played is (the newest host mtime under `BASCUS-97275SOCOMII`; the
  runtime answers the game's listing from host mtimes, `MemoryCard.cpp:529-537`). **For the rest, a ledger the runtime writes BESIDE the card,
  `cards/<profile>.personas.json`** -- the card root's path with `.personas.json` appended (`cards/player_b.personas.json` for the second instance;
  `mc0.personas.json` absent the knob): a sibling of `PS2X_MC_DIR`, never in the game's listing or free-space walk. The runtime sees the login request in the
  clear before RC4 -- the `rc4EncryptFn` seam, `ps2xRuntime/src/lib/socom2_crypto.cpp:311-316` (`docs/research/37-launcher-online-credentials.md:12-15`;
  `docs/research/28-lobby-taxonomy.md:159` quotes the request off the server) -- and knows `PS2X_SOCOM2_SERVER` (`launcher_config.cpp:543`, `effectiveServer`).
  One record per name, `{name, server, lastLogin, savedPassword}`: name and server from the request, last played from the commit, `savedPassword` from §3. **The
  record is committed on the response, not the request**: held pending with its `MessageID`, committed by the first type-0x08 response with that `MessageID` when
  `StatusCode >= 0` and dropped otherwise, so a refused create or a wrong password leaves no phantom row; the write is a temp file renamed over the ledger (a
  crash leaves the old one).
- **The request's layout IS in the tree, in the server's source:** `server/horizon-server/RT.Models/Lobby/MediusAccountLoginRequest.cs:10-32` -- class
  `MessageClassLobby` = 0x01 (`RT.Common/Types.cs:516`), type `AccountLogin` = 0x07 (`:582`), the class/type prefix
  (`RT.Models/RT/RT_MSG_CLIENT_APP_TOSERVER.cs:23-31`), then `MessageID` 21, `SessionKey` 17, `Username` 32, `Password` 32 (`RT.Common/Constants.cs:9-16`): a
  104-byte payload, `Username` at offset 40, `Password` at 72. **The response too:** `MediusAccountLoginResponse.cs:11-37`, type 0x08 (`Types.cs:583`),
  `MessageID`, 3 pad bytes, a 4-byte `StatusCode` at offset 26, success = `StatusCode >= 0` (`:17`); it comes back through `rc4DecryptFn`
  (`socom2_crypto.cpp:318-323`), plain in place after the call. **That the RC4 seams carry these messages whole is inferred, not observed** (research/37:5-6,
  "nothing here was run"): L1b's FIRST step is a Dev knob `PS2X_SOCOM2_LOGIN_TRACE` logging class, type and length at both functions, never a field; the fallback
  seam is the `send` in `socom2_hostnet.cpp:577` (research/37:36).

## 2. The viewer (the ONLINE page after the change)

- **Today.** `third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp:77-108` draws PROFILE, PLAYER NAME (cap 14) and PASSWORD (masked, cap 12) as `textField`s
  (`online.profile/.name/.password`); the nodes are laid at `y + k * kOnlineRowPitch` (`ui/focus.cpp:263-270`, pitch 46 at `focus.cpp:410`), ADVANCED at `y + 188`
  (`focus.cpp:275-277`); their help is data (`focus.cpp:315-332`). ADDRESS is anchored on PROFILE's rect (`page_online.cpp:78-79`).
- **The budget.** The three fields fill `y+46` to ADVANCED at `y+188`: 142 units, and `launcher_tests.cpp:1378-1379` forbids a scroll at the design size 1100x700.
  **After**, in those 142: ADDRESS stays at `y` on its own shared rect `onlineAddressRow(window)` (the page and the layout both call it); the heading PERSONAS is
  drawn 26 above the first row as SERVER is (`page_online.cpp:13`); rows at the presets' 38 pitch and 32 height (`focus.cpp:415`) from `y+72`: three visible rows
  end at `y+180`, 8 clear of ADVANCED (26 + 3 x 38 = 140 of the 142). The list holds every record and NEW PERSONA as its LAST row; past three rows it scrolls
  inside itself (a focus move onto a hidden row scrolls it); the page's other nodes never move.
- **The rows.** One `listRow` (`ui/widgets.h:106`, the presets' widget) per record across every `cards/*.personas.json`, id `online.persona.<i>`, laid by a shared
  `onlinePersonaRow(window, i, scroll)` the way `onlinePresetRow` is (`focus.cpp:412-416`) so the drawn and focusable rects cannot disagree. Row text: the name;
  in caption the server (the preset's `label` via `findServerPreset`, else the address) and "last played <n> days ago". The last row is NEW PERSONA, id
  `online.persona.new`. The row count and the scroll are `LayoutInputs` fields like `padChoices` (`focus.h:64-69`): the layout stays pure. **The password field
  sits beside the selected row**: a masked `textField` (cap 12, `keyboardAccepts(ch, true)`), 32 tall to match the row, at the row's right end, id
  `online.persona.password`; it exists only while the selected row is NEW PERSONA or a record with `savedPassword: false` -- the issue's "a persona without one
  still gets a masked field"; a `true` row sends no `PS2X_SOCOM2_LOGIN_PASS`, the game fills its own form from the card.
- **The empty state's one sentence** (no `cards/` or no record): "No persona yet -- press LAUNCH, the game asks for a name on its own keyboard, and it appears
  here after your first login." A card with no ledger (every card made before this build) gets the sentence with "again" only when `BASCUS-97275SOCOMII` holds a
  `SaveGame*` file: every booted card has the folder from its first boot's controller-config save (`docs/HAZARDS.md:145`), persona or not.
- **Selection.** Picking a row sets `c.profile` to the row's card and `c.loginName` to its name (`launcher_config.h:159`) and `app.dirty`; the row is drawn
  selected when both match (`normalizeLoginName(record.name) == c.loginName`, §4 on names). **Picking a row clears `c.loginPassword`** unless typed for that row
  since: one `loginPassword` serves every row (`launcher_config.h:160`), and B picked after A must not launch with A's password. A row from
  `cards/<p>_b.personas.json` sets `profile = <p>` and `secondInstance` ON (`page_online.cpp:119-126`): `environmentFor` appends `_b` itself
  (`launcher_config.cpp:545`), so `profile = player_b` would land on `cards/player_b_b`. A row made on another server than the selected preset draws the revision
  mismatch's warn line (`page_online.cpp:17-23`) and does not block: the first login there creates a persona by the game's own rule (`docs/KNOWN.md:62`).
- **What a row CANNOT do today: choose which saved persona the game logs in as.** `c.loginName` reaches the game only as the NAME keyboard's prefill
  (`ps2xRuntime/include/runtime/socom2_osk_prefill.h:118-127`, `game_overrides_socom2.cpp:1269`), and that keyboard opens only for `<New Persona>`; a saved
  persona is picked from the game's own list, and the driver takes the list's first entry with one CROSS (`tools_py/parity/online_login_ours.py:1957-1975`;
  `--saved-password`, `:1785-1824`, proves one persona per card, never a choice). Nothing in the runtime touches that list (a `persona` grep over `ps2xRuntime`
  finds only the prefill); its UI variable is not in the tree. Two resolutions: (i) the runtime steers the list -- LATER, filed from this note; (ii) for L1 the
  bar is re-worded: a saved persona's row sets the card, and its caption says "pick <name> in the game's list". **L1b drives a two-persona card FIRST** (two
  create-persona logins on one card, `online_login_ours.py:1913-1940`, then a third launch) and records which persona the form arrives with and how the list
  orders them; "launching with either logs in as it" is claimed from that run alone.
- **NEW PERSONA hands to the game's flow.** It clears `c.loginName` and `c.loginPassword` (an empty name sends no `PS2X_SOCOM2_LOGIN_NAME`,
  `launcher_config.cpp:549-551`, so the name keyboard opens empty, `ps2xShared/include/ps2x/knobs.h:163`) and keeps the selected card (`cards/player` when the
  viewer is empty); LAUNCH then runs a stranger's first run: LOGIN, the universe, `<New Persona>`, the name keyboard (`online_login_ours.py:1913-1940`). Nothing
  in the launcher walks the game's screens.

## 3. The password

- **Today** `loginPassword` is a Config field (`launcher_config.h:159-160`) written plain (`launcher_config.cpp:152-155`, R179), read and normalised (`:250`),
  sent as `PS2X_SOCOM2_LOGIN_PASS` only when non-empty (`:552-554`), blanked in the diagnostics copy (`ps2xShared/src/diagnostics.cpp:65-68`), never printed by
  the knob dump (`knobs.cpp:24`) and scrubbed from reports (`diagnostics.cpp:87`).
- **KNOWN wins over the brief's "R237: the saved password does not survive".** That is the row as written 2026-09-23; V6 settled it 2026-09-25: launch b of
  `v6_20260925_160634` arrived with `*****`, nothing typed, `LOBBY class=ok` (`docs/KNOWN.md:201`). `docs/INSTALL.md:159-162`, `docs/PLAYTEST.md:118` and R237's
  own row (`docs/CURRENT_SPRINT.md:219`, echoed at `:241` and in the generated `docs/RULINGS.md:67`) still state the old finding: false sentences to correct in
  the same task (`docs/HANDOFF.md` §4 rule 11; §5 lists them).
- **How `savedPassword` is known -- per login, from the request alone.** The OSK override tells the login keyboards apart (`Field::Password`,
  `socom2_osk_prefill.h:50-60`). The wrapper is installed ALWAYS (today `installOskPrefill` returns with neither variable set,
  `game_overrides_socom2.cpp:1295-1296`, `:1255`, `:2062`; the buffer write stays gated on a variable, so that path is byte-identical) and sets a flag
  `passwordKeyboardOpened` on each `Field::Password` open. At each login request the writer reads the flag and CLEARS it: `savedPassword = !passwordKeyboardOpened
  && Password non-empty`. The environment variable plays no part: a prefilled password still opens the keyboard and records `false` on its own. Cases: typed,
  prefilled, or a NEW PERSONA login (both keyboards) -> `false`; a second login this run -> its own answer, the flag having been cleared; CONNECT with an empty
  password (research/37:41-43: it reaches the wire) -> `false`; the V6 form, `*****`, nothing typed -> `true`. The SAVE PASSWORD tick itself is not in the tree.
- **What `config.json` stops storing, and the migration.** `loginPassword` is kept only while the selected row's record is absent or `false`; when the launcher
  (re)reads the ledgers and the selected row reads `true`, `Config::loginPassword` is cleared and the file rewritten, the key kept and empty
  (`diagnostics_tests.cpp:109` asserts exactly that of the zip's copy, and stays). A player with a plain password today loses nothing: launch 1 prefills the
  keyboard (R180) and records `false`; the game saves it under SAVE PASSWORD YES; launch 2 arrives with `*****`, no keyboard (V6), and records `true`; the plain
  copy goes at the next launcher read. The help (`focus.cpp:330-332`), the ABOUT line (`ui/page_about.cpp:57`), `docs/INSTALL.md:150-153` and the knob's text
  (`knobs.h:164`, "plain in the player's config.json", regenerating `docs/KNOBS.md:25`) say "only until the game remembers it".
- **The launch half needs no new plumbing.** `--saved-password` (`online_login_ours.py:1785-1826`, `tools_py/tests/test_saved_password.py`) proves a card-held
  password logs in untyped; `--prefilled` proves the env path (`tests/test_online_login_prefilled.py`).

## 4. Tests from fixtures

- **Pattern in the tree.** `ps2xTest/src/preflight_tests.cpp:20-33` (`makeHome`/`removeHome`) builds a stamped directory under `temp_directory_path()` and removes
  it on every platform -- the pattern to copy, not `launcher_tests.cpp:2447-2454`, which sits inside `#ifndef _WIN32` (`:2442-2443`). The reader takes `cards/`:
  the test builds `cards/<name>/BASCUS-97275SOCOMII/` (empty files, no disc bytes) and writes `cards/<name>.personas.json` beside it; the reader reads only
  mtimes.
- **Names are bytes, never normalised.** The request's `Username` is what the game's keyboard typed, accent mode included (`docs/HAZARDS.md:161`: the old harness
  typed `xmfû`), so a record name can hold what `normalizeLoginName` (`launcher_config.cpp:492-494`) would drop; the ledger keeps the field's bytes (`\u00XX` per
  non-ASCII byte), the row shows what the glyph set can, and the match to `c.loginName` is `normalizeLoginName(record.name) == c.loginName` -- of two records on
  one card that normalise alike the first wins (a test pins it, a KNOWN row names it).
- **Reader cases** (one `tc.Run` each): (a) no `cards/`, no ledger, a 0-byte ledger, one holding `[]` -> zero rows, the empty sentence; (b) one record -> one row,
  its name, server label and age; (c) two records -> two rows, newest login first, selection follows `profile+loginName`; (d) `savedPassword: true` ->
  `environmentFor` has no `PS2X_SOCOM2_LOGIN_PASS` and `toJson` writes `"loginPassword": ""`; (e) a name of every keyboard character (0x21-0x7E less `"`:
  backslash, braces, colon, comma) and one holding `û` round-trip `toJson`/`fromJson` byte for byte; (f) a truncated ledger, a record with no name or no server ->
  the ledger is skipped with a one-line note, never a throw; (g) a save folder with a `SaveGame*` file and no ledger -> the "again" sentence, the folder alone ->
  the plain one; (h) a `_b` ledger's row -> `profile` without the suffix and `secondInstance` on; (i) picking B after A -> `loginPassword` empty.
- **Writer cases** (`socom2_persona_record`, pure functions over byte buffers): the request parse (class 0x01, type 0x07, length 104, `Username` at 40, `Password`
  at 72; a wrong class, type or length -> not a login); the inference table above, the flag cleared after each; the response parse (type 0x08, `MessageID` match,
  `StatusCode` at 26: `>= 0` commits, `< 0` drops, an unmatched `MessageID` leaves the pending record); the atomic write (the ledger unchanged until the rename).
- **Tests that change:** `launcher_tests.cpp:1360-1394` (the three fields' order and help) becomes the rows' order and the three-row budget; `:1406-1410` (the
  profile help) moves to the PERSONAS heading's help; `:1419-1430` (`helpedIds` are real nodes) gates the new ids; `:497-541` (the config round trip) keeps
  `loginName`, its `loginPassword` write becomes the conditional above; `diagnostics_tests.cpp:105-110` and `bug_report_tests.cpp:211-223` stay (the key stays,
  blanked).

## 5. Files to modify

- `third_party/ps2recomp/ps2xShared/include/launcher/personas.h` (new) + `ps2xShared/src/personas.cpp` (new, in `ps2x_shared`, `ps2xShared/CMakeLists.txt:5-18`:
  the runtime links only `ps2x_shared` (`ps2xRuntime/CMakeLists.txt:506`), never `ps2x_launcher_core` (`ps2xLauncher/CMakeLists.txt:7-27`), and both ends must
  share one `toJson`): `namespace launcher::personas { struct Persona { std::string name, card, server; std::time_t lastLogin; bool savedPassword; }; constexpr
  const char *kSuffix = ".personas.json"; readLedger(path, out, note), readCards(cardsDir), toJson, fromJson, writeAtomic(path, json) }` -- the parser on
  `ps2xShared/src/json_reader.h:11-135`.
- `third_party/ps2recomp/ps2xRuntime/src/lib/socom2_persona_record.cpp` (new): the pending record from `rc4EncryptFn`, the commit from `rc4DecryptFn`
  (`socom2_crypto.cpp:311-323`; else the hostnet `send`, `socom2_hostnet.cpp:577`), the `passwordKeyboardOpened` flag from the prefill wrapper
  (`game_overrides_socom2.cpp:1261-1290`, installed unconditionally at `:1292-1296`), the ledger path from `getIoPaths().mcRoot` + `kSuffix`; writes through the
  shared `toJson` (the accept-set lesson, `docs/HAZARDS.md:435`).
- `ps2xLauncher/src/ui/page_online.cpp:77-108` (the three fields -> the rows, the sentence, NEW PERSONA, the field beside the row; `:78-79` the ADDRESS row onto
  `onlineAddressRow`); `ui/focus.cpp:263-277` (nodes), `:315-332` (help), `:410-416` (`onlineAddressRow`, `onlinePersonaRow`); `ui/focus.h:64-81`
  (`LayoutInputs::personaRows`, `personaScroll`), `:104-106` (the rects); `main.cpp:1216-1219`, `:2063-2070` (the shots' focus); `ui/page_about.cpp:57`.
- `ps2xShared/include/launcher/launcher_config.h:156-160` (comment), `ps2xShared/src/launcher_config.cpp:152-155` (the conditional value, the key always written),
  `:549-554` (no `PS2X_SOCOM2_LOGIN_PASS` for a saved-password row); `ps2xShared/include/ps2x/knobs.h:164` (text) and the Dev knob `PS2X_SOCOM2_LOGIN_TRACE`;
  `docs/KNOBS.md` regenerated (`python -m tools_py.knobs write`, `tools_py/tests/test_knobs_registry.py:113`). No new `config.json` key.
- Tests: `ps2xTest/src/launcher_tests.cpp` (§4's reader cases), a new `persona_record_tests.cpp` (the writer).
- Docs: `docs/INSTALL.md:148-162`, `docs/PLAYTEST.md:59,118`, `docs/DEVELOPING.md:1176-1178`. **Rule-11 corrections for L1b**, false today whatever the design:
  `docs/INSTALL.md:159-162` and `docs/PLAYTEST.md:118` ("the saved password does not survive"), and R237's row at `docs/CURRENT_SPRINT.md:219` with `:241` (its
  premise was reversed by V6, `docs/KNOWN.md:201`), then `python -m tools_py.rulings` regenerates `docs/RULINGS.md:67` (`RULINGS.md:3`).

## 6. Open questions, each with the default the controller should take

1. **Sidecar or decoder?** Default: the ledger (§1); the decoder (a real card, a Ghidra pass) is a LATER task that would retire the "again" state.
2. **Record on the request or on the response?** Default: pending at the request, committed on the matching success response; both layouts are in the tree (§1).
3. **Where does PROFILE go?** R295 names three fields gone. Default: no field -- the selected row's card, `cards/player` when empty; a second card only by hand in
   `config.json`. A CARD field under ADVANCED would be a ruling from the counter (`docs/HANDOFF.md` §2), since it moves the bar's "three fields gone".
4. **Which server text on a row?** Default: `effectiveServer` at login, as the preset's label when one matches; never MUIS's `DNS` string (`docs/KNOWN.md:62`).
5. **Inference vs the tick.** §3's inference misses a YES tick on a typed login until the next login. Default: accept; the plain copy stays one launch longer.
6. **A record name the keyboard could not have typed** (a hand-edited ledger). Default: kept -- names are bytes (§4); only a structurally corrupt ledger is
   skipped whole, as `normalizeProfile` refuses a path whole (`launcher_config.cpp:445-465`). The first draft's "refused whole" is withdrawn.
7. **Which persona a saved-persona row launches as.** Default: §2's resolution (ii) for L1 -- the row sets the card and says "pick <name> in the game's list" --
   until L1b's two-persona run says what the game does; steering is LATER. A `<p>_b` ledger lists like any other; its row sets `profile = <p>` and the toggle
   (§2).
