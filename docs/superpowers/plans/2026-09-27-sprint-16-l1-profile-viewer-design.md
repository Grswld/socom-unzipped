Date: 2026-09-27
Spec: `docs/superpowers/specs/2026-09-27-sprint-16-ten-minutes-to-the-server-design.md` (L1; not in this cloud checkout of `main` at `b534bd3`, quoted from the brief). <!-- docmaint: future -->

# Sprint 16 L1 design note -- the profile viewer over the card's personas (issue #73, R295)

Written by a design reader in a cloud checkout with no game files, disc bytes or logs; every claim carries the path:line it was read from,
and "not in the tree" marks a fact the tree does not hold. R295 (`docs/superpowers/plans/2026-09-26-owner-sitting.md:52-56`): "a profile
viewer on the ONLINE page replaces the PROFILE, NAME and PASSWORD fields". Issue #73's body (read over the API, 0 comments) adds the sketch: one
row per persona -- name, the server it was made on "(the config's server at the time, recorded by the launcher)", last played; picking a row
sets the launch; "new persona" stays the game's flow; the typed PASSWORD goes where the card carries it.

## 1. What the card holds per persona

- **The card is a plain host directory.** `PS2X_MC_DIR=cards/<profile>` (`_b` for the second instance) is set by the launcher
  (`third_party/ps2recomp/ps2xShared/src/launcher_config.cpp:544-545`); the runtime maps every guest path onto it one validated
  component at a time (`third_party/ps2recomp/ps2xRuntime/src/lib/Kernel/Stubs/MemoryCard.cpp:467-477`), creates it on first use
  (`MemoryCard.cpp:217`) and, absent the knob, uses `mc0` beside the ELF (`MemoryCard.cpp:171-183`). The game's save folder inside it is
  `BASCUS-97275SOCOMII` (`docs/HAZARDS.md:145`: that file 4784 -> 6160 B plus `SCRATCHPAD.DAT`; `docs/research/30-scope-at-spawn.md:69`:
  `SaveGame0-6`; `docs/KNOWN.md:66`: 12 files / 3020 KB on a driven save).
- **The persona layout inside those files is not in the tree.** `docs/research/38-osk-open-function.md:1` is the on-screen keyboard note:
  it gives the name and password caps (14 and 12 characters, its table rows `kOskNameCap`/`kOskPasswordCap`) and nothing about the card;
  the issue's citation of it for "the card's persona layout" is misplaced. Sprint 13 W10/V6 (`docs/superpowers/plans/2026-09-25-sprint-13.md:50`,
  `docs/KNOWN.md:201`) record behaviour -- a persona is kept per server, and the card DID keep the password (the V6 pair) -- not bytes.
  No reader of the save format exists: `grep -rn 'SaveGame\|BASCUS' third_party/ps2recomp/ps2xShared third_party/ps2recomp/ps2xLauncher
  tools_py` finds nothing, and `tools_py/parity/mc_trace.py:1-16` parses the `[MC]` op trace, never file contents.
- **The per-server key is unknown**: the peer address or MUIS's `DNS` string (`docs/KNOWN.md:62`), never the launcher's preset (`docs/HAZARDS.md:439`).
- **Of the spec's three columns, from the card alone:** name -- not readable; server -- not readable; last played -- readable as the newest
  host mtime under `BASCUS-97275SOCOMII` (the runtime itself answers the game's directory listing from host mtimes, `MemoryCard.cpp:529-537`,
  so the two agree). SAVE PASSWORD -- not readable.
- **Fallback for every missing column: a sidecar the runtime writes, `cards/<profile>/personas.json`.** The runtime sees the login request in
  the clear before RC4 -- the `rc4EncryptFn` seam, `third_party/ps2recomp/ps2xRuntime/src/lib/socom2_crypto.cpp:311`
  (`docs/research/37-launcher-online-credentials.md:12-15`; `docs/research/28-lobby-taxonomy.md:159` quotes `MediusAccountLoginRequest
  USERNAME:socome PASS:ocom` off the server) -- and knows `PS2X_SOCOM2_SERVER` (`launcher_config.cpp:543`, `effectiveServer`). One record per
  name: `{name, server, lastLogin, savedPassword}`. Name and server come from the request, last played from the write, `savedPassword` from
  §3. The message's type byte and field offsets are **not in the tree** (`grep -rn AccountLogin third_party/ps2recomp/ps2xRuntime` is empty);
  the implementer reads them from `server/horizon-server` (the same source research/28 read).

## 2. The viewer (the ONLINE page after the change)

- **Today.** `third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp:77-108` draws PROFILE (`online.profile`, the caption "picks
  cards/<profile>"), PLAYER NAME (`online.name`, cap 14, `keyboardAccepts`) and PASSWORD (`online.password`, masked, cap 12) as
  `textField`s; the nodes are laid at `y + k * kOnlineRowPitch` (`ui/focus.cpp:263-270`, pitch 46 at `focus.cpp:411`), ADVANCED at
  `y + 188` and the second-instance toggle at `y + 224` (`focus.cpp:276-278`); their help is data (`focus.cpp:315-332`). The game starts
  through `environmentFor` (`launcher_config.cpp:526-576`) and `startGame` (`main.cpp:1003`, `:1880`; `posix_glue.cpp:247` creates `cards/`).
- **After.** The three nodes go. In their place, under GAME VERSION: a heading PERSONAS and one `listRow` (`ui/widgets.h:106`, the
  presets' widget) per record across every `cards/*/personas.json`, id `online.persona.<i>`, laid by a shared `onlinePersonaRow(window, i)`
  the way `onlinePresetRow` is (`focus.cpp:413-417`) so the drawn rect and the focusable rect cannot disagree. Row text: the name; right,
  in caption: the server (the preset's `label` when `findServerPreset` knows the address, else the address) and "last played <n> days ago".
  Below the rows one `button` (`widgets.h:103`) NEW PERSONA, id `online.persona.new`. The row count is a `LayoutInputs` field like
  `padChoices` (`focus.h:64-69`), so the layout stays pure and testable.
- **The empty state's one sentence** (a fresh install, no `cards/` or no record): "No persona yet -- press LAUNCH, the game asks for a name
  on its own keyboard, and it appears here after your first login." A card with a `BASCUS-97275SOCOMII` folder and no sidecar (every card
  made before this build) gets the same sentence with "again" -- its personas are real and unreadable (§1) until the next login records them.
- **Selection.** Picking a row sets `c.profile` to the row's card and `c.loginName` to its name (`launcher_config.h:159`; R180 prefill,
  `knobs.h:163`), and `app.dirty`; the row is drawn selected when both match. A row made on a server other than the selected preset draws
  the warn line the revision mismatch uses (`page_online.cpp:17-23`) -- "this persona was made on <server>" -- and does not block: the
  first login there is a create-persona login by the game's own rule (`docs/KNOWN.md:62`).
- **NEW PERSONA hands to the game's flow.** It clears `c.loginName` (an empty name sends no `PS2X_SOCOM2_LOGIN_NAME`,
  `launcher_config.cpp:549-551`, so the name keyboard opens empty, `knobs.h:163`) and keeps the selected card (`cards/player` when the
  viewer is empty); LAUNCH then runs what a stranger's first run does today: LOGIN, the universe, `<New Persona>`, the name keyboard
  (`tools_py/parity/online_login_ours.py:1913-1940`). Nothing in the launcher walks the game's screens.

## 3. The password

- **Today** `loginPassword` is a Config field (`launcher_config.h:159-160`) written plain (`launcher_config.cpp:152-155`, R179), read and
  normalised (`:250`), sent as `PS2X_SOCOM2_LOGIN_PASS` only when non-empty (`:552-554`), blanked in the diagnostics copy
  (`ps2xShared/src/diagnostics.cpp:65-68`), never printed by the knob dump (`knobs.cpp:24`) and scrubbed from reports (`diagnostics.cpp:87`).
- **KNOWN wins over the brief's "R237: the saved password does not survive".** That is the row as written 2026-09-23; V6 settled it
  2026-09-25: launch b of `v6_20260925_160634` arrived with `*****`, SAVE PASSWORD YES, cursor on CONNECT, nothing typed, `LOBBY class=ok`
  (`docs/KNOWN.md:201`). `docs/INSTALL.md:159-162` and `docs/PLAYTEST.md:118` still state the old finding: a false sentence to correct in
  the same task (`docs/HANDOFF.md` §4 rule 11).
- **Where the typed PASSWORD goes.** A row whose record says `savedPassword: true` has no password field and sends no
  `PS2X_SOCOM2_LOGIN_PASS`: the game fills its own form from the card. A row with `false`, and a NEW PERSONA, keeps one masked
  `textField` (cap 12, `keyboardAccepts(ch, true)`) exactly as today -- the issue's "a persona without one still gets a masked field".
- **What `config.json` stops storing, and the migration.** `loginPassword` is written only while the selected persona has no saved
  password; on the first launch after which its record reads `true`, `Config::loginPassword` is cleared and the file rewritten. A player
  with a plain password today loses nothing: the next login is prefilled from it (R180), the game saves it when SAVE PASSWORD is YES, the
  record flips, the plain copy goes. The help (`focus.cpp:330-332`), the ABOUT line (`ui/page_about.cpp:57`) and `docs/INSTALL.md:150-153`
  say "only until the game remembers it".
- **How `savedPassword` is known.** The OSK override tells the two login keyboards apart (`Field::Password`,
  `ps2xRuntime/include/runtime/socom2_osk_prefill.h:50-60`). A login request seen with no password keyboard opened this run and no
  `PS2X_SOCOM2_LOGIN_PASS` set means the card supplied the password: `true`. A keyboard opened or a prefill sent: `false` (correct also for
  a SAVE PASSWORD = NO login). The runtime cannot see the tick itself -- not in the tree.
- **The launch half needs no new plumbing.** `--saved-password` (`online_login_ours.py:1785-1826`, `tools_py/tests/test_saved_password.py`) proves a
  card-held password logs in with nothing typed; `--prefilled` proves the env path (`tools_py/tests/test_online_login_prefilled.py`).

## 4. Tests from fixtures

- **Pattern in the tree.** `ps2xTest/src/launcher_tests.cpp:2447-2454` builds a stamped directory under `temp_directory_path()`, writes
  files into it and removes it (POSIX-only block, `:2442-2443`); the pure layout is tested through `layoutFor`/`FocusGraph::build`
  (`launcher_tests.cpp:1360-1394`). No fixture for files under the game folder exists yet -- the card reader takes a directory, so the
  test builds `cards/<name>/BASCUS-97275SOCOMII/` (empty files, no disc bytes) plus `personas.json`; the reader never opens the game's
  files, only their mtimes, so the format's minimum is a folder and a JSON text.
- **Cases** (one `tc.Run` each): (a) no `cards/` and a `cards/` with no folders -> zero rows, the empty sentence; (b) one record ->
  one row with its name, server label and age; (c) two records -> two rows, newest login first, selection follows `profile+loginName`;
  (d) `savedPassword: true` -> `environmentFor` has no `PS2X_SOCOM2_LOGIN_PASS` and `toJson` has no `loginPassword` key; (e) corrupt:
  a truncated `personas.json`, a record with no name, a name over 14 characters (`normalizeLoginName`, `launcher_config.cpp:492-494`)
  -> the card is skipped with a one-line note, never a throw; (f) a save folder with no sidecar -> the "again" sentence.
- **Tests that change:** `launcher_tests.cpp:1360-1394` (the three fields' order and help) becomes the rows' order; `:1406-1410` (the
  profile help names `cards/` and `persona`) moves to the PERSONAS heading's help; `:1419-1430` (`helpedIds` must all be real nodes) gates
  the new ids; `:497-541` (the config round trip) keeps `loginName`, its `loginPassword` write becomes the conditional above;
  `diagnostics_tests.cpp:105-110` and `bug_report_tests.cpp:211-223` stay (the key is still blanked when present).

## 5. Files to modify

- `third_party/ps2recomp/ps2xShared/include/launcher/personas.h` (new) + `ps2xShared/src/personas.cpp` (new, `ps2x_launcher_core`):
  `namespace launcher::personas { struct Persona { std::string name, card, server; std::time_t lastLogin; bool savedPassword; };
  constexpr const char *kFile = "personas.json"; bool readCard(const std::filesystem::path &cardDir, std::vector<Persona> &out,
  std::string &note); std::vector<Persona> readCards(const std::filesystem::path &cardsDir); std::string toJson(const
  std::vector<Persona> &); bool fromJson(const std::string &, std::vector<Persona> &); }` -- the parser on `ps2xShared/src/json_reader.h:11-135`.
- `third_party/ps2recomp/ps2xRuntime/src/lib/socom2_persona_record.cpp` (new): the writer, called from the login-request seam
  (`socom2_crypto.cpp:311` or the `send` in `socom2_hostnet.cpp`, research/37:57) with `passwordKeyboardOpened` from the prefill override;
  writes through the shared `toJson` so the two ends cannot drift (the accept-set lesson, `docs/HAZARDS.md:435`).
- `ps2xLauncher/src/ui/page_online.cpp:77-108` (the three fields -> the rows, the sentence, NEW PERSONA, the conditional password field);
  `ui/focus.cpp:263-278` (nodes), `:315-332` (help), `:411-417` (`onlinePersonaRow`); `ui/focus.h:64-81` (`LayoutInputs::personaRows`),
  `:104-106` (declare the row rect); `ps2xLauncher/src/main.cpp:1216-1219` and `:2063-2070` (the `_help`/`_credentials` shots focus
  `online.persona.0`); `ui/page_about.cpp:57`.
- `ps2xShared/include/launcher/launcher_config.h:156-160` (comment), `ps2xShared/src/launcher_config.cpp:152-155` (conditional write),
  `:549-554` (no `PS2X_SOCOM2_LOGIN_PASS` for a saved-password row); no new `config.json` key -- `profile` is the card, `loginName` the
  persona; `personas.json` under each card is the new file.
- Tests: `ps2xTest/src/launcher_tests.cpp` (§4), the reader's cases beside the config's. Docs: `docs/INSTALL.md:148-162`,
  `docs/PLAYTEST.md:59,118`, `docs/DEVELOPING.md:1176-1178`; `docs/KNOBS.md:24-25` regenerates only if a knob's text changes
  (`python -m tools_py.knobs write`, `tools_py/tests/test_knobs_registry.py:113`).

## 6. Open questions, each with the default the controller should take

1. **Sidecar or decoder?** Decoding `BASCUS-97275SOCOMII` needs a real card and a Ghidra pass (the owner's machine; nothing here).
   Default: the sidecar (§1); the decoder is a LATER research task, filed from this note, that would retire the "again" state.
2. **Record on the request or on the response?** The response's type is also not in the tree. Default: on the request, overwritten by the
   next request for the same name (a failed login leaves a row the next good one corrects); the bar's two-persona card is one that logged in here.
3. **Where does PROFILE go?** R295 names three fields gone; the card is still a thing a player may need to make. Default: no field --
   the selected row's card, `cards/player` when empty; a second card only by hand in `config.json`. If the controller wants a CARD field
   under ADVANCED, that is a ruling from the counter (`docs/HANDOFF.md` §2), since it moves the bar's "three fields gone".
4. **Which server text on a row?** The launcher's resolved value at login (`effectiveServer`), shown as the preset's label when one
   matches. Default: that, never the MUIS `DNS` string the game keys on (unknown key, `docs/KNOWN.md:62`); the mismatch warn line covers it.
5. **`savedPassword` inference vs the tick.** The inference in §3 is blind to a YES tick on a typed login until the next run. Default: accept;
   the record flips on the following launch, and the plain password stays one launch longer than the card needs it.
6. **The second instance's `<profile>_b` card.** Default: listed like any card; picking it does not set `secondInstance` (`page_online.cpp:119-126`).
7. **A record name the keyboard could not have typed** (a hand-edited sidecar). Default: refused whole, as `normalizeProfile` refuses a path
   (`launcher_config.cpp:445-465`): one predicate, the stored value a fixed point (`docs/HAZARDS.md:435`).
