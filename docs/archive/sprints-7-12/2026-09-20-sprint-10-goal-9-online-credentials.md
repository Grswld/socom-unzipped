# Sprint 10, Goal 9 — the ONLINE tab's player name and password reach the game

> **ARCHIVED 2026-09-25 -- a Sprint 10 plan; the sprint is closed and this is its record.**
> Moved here from `docs/superpowers/plans/` in Sprint 13 (Task R1, with the rest of Sprints 7-10's specs and
> plans); nothing below it was edited except citations that pointed at a path that has since moved. It is a
> record, not an instruction.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Written 2026-09-20 by the launcher session (socom-pc-f3) on the owner's "scope out adding online name and
password and slot it into an appropriate section of the ongoing sprint". The investigation it builds on is
`docs/research/37-launcher-online-credentials.md`; the spec is
`docs/archive/sprints-7-12/2026-09-20-sprint-10-console-players-and-it-stays-up-design.md`, Goal 9.

**Goal:** a player types their persona name and password once, on the launcher's ONLINE page, and the game's
two on-screen keyboards open already holding them, so going online is LOGIN, ENTER, ENTER, CONNECT.

**Architecture:** the launcher stores the two strings in `config.json` and hands them to the game as
`PS2X_SOCOM2_LOGIN_NAME` / `PS2X_SOCOM2_LOGIN_PASS`, the same way every other setting travels
(`launcher::environmentFor`). In the runtime, a recompiled-function override at the game's on-screen-keyboard
open routine (the mechanism `game_overrides_socom2.cpp` already uses for the RSA key pair and the exposure
readback) writes the matching string into the keyboard's target buffer before the keyboard draws, so the
player sees their name and password already typed and presses ENTER -- or edits. Nothing is auto-submitted,
and nothing changes in the wire protocol: the game sends what its buffers hold, exactly as if typed.

**Tech Stack:** C++20 (launcher, ps2xShared, runtime override), the MiniTest suite (`ps2x_tests.exe`),
Ghidra (`ghidra_proj/socom.gpr`) for the one address the override binds to, the parity harness
(`tools_py/parity/online_login_ours.py`) for the proof.

**Bar:** a driven login on ours' exe with the two variables set reaches the lobby with the harness pressing
ENTER on each keyboard instead of typing (`--prefilled`), twice in a row on the hosted server; and the owner's
own login with the fields filled on ONLINE. **Stop rule:** if Task 1 cannot name the keyboard-open function
with both call sites in a day, fall back to Route A of research/37 (rewrite the login request in the host
crypto path) and file the Ghidra notes in research/38 for the next attempt.

**Rulings this plan records (the controller numbers them into CURRENT_SPRINT):**
- **R179 -- the password is stored in plain text in `config.json`, masked on screen; superseded by R310 (Sprint 16 L1,
  2026-09-27) for a persona whose card holds the password.** Why: every launcher
  of this kind does the same, the file is the player's own, and a reversible obfuscation would be theatre. The
  ABOUT page's "where things live" line says the password is in that file. Cost if wrong: a player shares
  their config.json with the password in it -- the REPORT A BUG payload never includes config.json's server
  fields, and Task 5 asserts the password is never in a bug report or a diagnostics zip. **Superseded by R310
  (Sprint 16 L1, 2026-09-27) for a persona whose card holds the password.**
  > **Superseded by R310 (Sprint 16 L1, 2026-09-27):** Sprint 13 V6 settled that the memory card keeps the saved
  > password (`docs/KNOWN.md` §3, the W10 row), and Sprint 16 D12 makes the launcher read a persona record the runtime
  > writes at login; `config.json` writes `loginPassword` only while the selected persona's record says the card does
  > not hold it and clears it once the record reads true, so the plain password this ruling allowed lives only until
  > a persona's first saved login. The masked field stays for a persona without a saved password.
- **R180 -- prefill, never auto-submit.** The keyboards open holding the strings; the player presses ENTER.
  Why: the game's own flow (persona list, "save to card?", the write-down notice) stays exactly as the
  console shows it, a wrong password is corrected on the spot, and a stranger who typed nothing on ONLINE
  sees the keyboards empty, as today. Cost if wrong: two ENTER presses per login that a later sprint can remove.

**Proposed rulings from the lock-free pass (2026-09-21, the Goal 9 agent; the controller numbers them):**
- **R200 -- the override is a runtime `replaceFunction` wrap, not a `recomp/socom2.toml` stub; no recompile.** A
  toml `stubs=` entry makes the recompiler emit ONLY the stub for that address and drop the original body
  (`recomp/output/FUN_003b24c0_0x3b24c0.cpp` is the shape), so a "prefill, then let the game's routine run" override
  cannot be one -- it would have to re-implement the keyboard's activation. `PS2Runtime::replaceFunction` +
  `lookupFunction` (the `installRtNetPortShift` pattern) wraps `FUN_0038d770` at startup with the original kept,
  and needs only `./build.sh runtime` (the runner links the runtime library). Task 1 Step 3 and the `recomp` half of
  Task 2 Step 5 are therefore not done, on purpose. Cost if wrong: none found -- the wrap runs on every call of
  the same function the stub would have bound. The owner can overturn it (a toml stub plus a hand-written
  activation, a day's work).
- **R201 -- the persona name keeps every character the game's keyboard has, not only letters and digits.** The
  plan's `normalizeLoginName` kept `[A-Za-z0-9]`; the keyboard (`tools_py/parity/online_login.py:OSK_ROWS`) has the
  whole printable ASCII set but the space, and the name keyboard refuses `"` (`NoDQuote`, research/38). A persona
  `Sgt_Rock` typed on ONLINE would have become `SgtRock` and logged in as a stranger. So: printable ASCII 0x21-0x7E,
  no space, no `"` for the name; the same set with `"` for the password; caps 14 and 12 (research/38), applied
  in the launcher AND re-applied from the live `MaxChars` in the runtime. Cost if wrong: a character the keyboard
  cannot type reaches the wire -- the runtime's own cap and the game's own login refusal are behind it.
- **R202 -- the password is capped at 12 in the launcher (the plan drew its field at 32).** The password keyboard's
  `MaxChars` is 12; a longer one typed on ONLINE would be cut by the prefill and the login would fail with no
  message. The field stops at 12 and says so. Cost if wrong: a 13+-character password from some other client --
  the same game made every password, on the same keyboard.

## Global Constraints

- The runtime override is bound at recompile time through `recomp/socom2.toml` (`"<name>@0x<addr>"`), which
  means `./build.sh recomp` and a runtime rebuild -- **lock-bound** (`scripts/loop_lock.sh run <owner> -- <cmd>`),
  and the built exe's sha goes in the gate record.
  > Superseded 2026-09-21 (proposed ruling R200 above): the override is a runtime `replaceFunction` wrap with
  > the original kept; no toml line, no recompile. Only the runner rebuild (`./build.sh runtime`) is
  > lock-bound, and its exe's sha still goes in the gate record.
- The variables are unset when the ONLINE fields are empty: an empty field sends nothing, and the runtime with
  no variable behaves byte-for-byte as before (the override writes nothing and falls through).
- Persona names: the game's keyboard caps the name; Task 1 records the cap, Task 3 enforces the same cap in
  `normalizeLoginName` so the launcher can never hand the game a string its buffer cannot hold.
- Nothing connects to a server that is not ours (spec, Wishlist). Every driven login in this plan is against
  the hosted box or the local Horizon.
- No question dialogs; rulings in prose (HANDOFF §5).

---

### Task 1: name the keyboard-open function and its two call sites (Ghidra, lock-free)

**Files:**
- Create: `docs/research/38-osk-open-function.md`
- Modify: `recomp/socom2.toml` (one line, the binding -- see Produces)

**Interfaces:**
- Consumes: the game's string table `game/overlays/all_strings.txt`, which already places the login form's
  own names in guest memory: `PLAYERPERSONALIST` at `0x00207b20`, `<New Persona>` at `0x00207b08`,
  `PLAYERPASSWORD` at `0x00207990` (and `0x0020ec28`, `0x00213490`), `SAVEPASSWORD` at `0x0020ed80`,
  `AccountLogin` at `0x0020da80`.
- Produces: `kOskOpenAddr` (the function's entry), its argument order (which register carries the target
  buffer, which the max length, which the prompt/field id), `kOskNameCap` and `kOskPasswordCap` (the two
  caps), and the field id or caller address that tells the persona-name keyboard from the password one.
  All five are written in research/38 as a table Task 2 copies from.

**Result (2026-09-21, static pass; `docs/research/38-osk-open-function.md` has the table and the trail):**
`kOskOpenAddr = 0x0038D770` (`FUN_0038d770`, the `GetTextInput` UI action's handler, action table row `0x3dd5e0`),
called by the dispatcher `FUN_002745a0` as `handler(msg, ctx)` where `msg` is the action's 0xAC-byte argument
block (Purpose key at +0x10, SkbName at +0x58, MaxBytes at +0x98, MaxChars at +0x9C). The "two call sites" are
the login screen's two `GetTextInput` actions in the disc's compiled UI script, not two `jal`s. The target buffer
is the keyboard's initial-text buffer `0x0049EC70` (bss, never written by the game, at least 0x48 bytes), which
`FUN_0038d770` hands to `FUN_0038b440`; the caps are `kOskNameCap = 14`, `kOskPasswordCap = 12` (MaxBytes 31 for
both), decoded from the serialised argument blocks on the disc (ISO offsets `0x7617a984` and `0x7617ac4c`). The
field is told by `Purpose` + `SkbName` (`_455_EnterPlayerName_MSG` / `_604_EnterPassword_MSG` with
`CREATEPLAYERNAME`), not by the UiVar id (a per-screen index). The plan's string addresses were FTSCore.bin file
offsets (guest = offset + 0x1e7000). Step 2 (the dynamic confirmation) is a game launch: the controller's; the
override logs the live caps on every keyboard open so the first driven login IS that confirmation.

- [x] **Step 1: Find the keyboard's open routine from its callers** (done by address arithmetic over the ELF and
  the recompiler's disassembly comments; the callers are a data table, see the result above)

Open `ghidra_proj/socom.gpr`. In the Defined Strings view, go to `PLAYERPASSWORD` (`0x00207990`) and follow
its references: the function that loads this string is the password field's screen object. Do the same for
`PLAYERPERSONALIST` (`0x00207b20`) and `<New Persona>` (`0x00207b08`), the persona list. In each, find the call
made on CROSS that takes a pointer into the object plus a small immediate (the buffer and its cap). The
callee common to both is the keyboard-open routine. Record its `FUN_xxxxxxxx`, the `a0..a3` meanings, and the
two immediates (the caps) in research/38.

- [x] **Step 2: Confirm the buffer dynamically** (DONE 2026-09-21 in Task 6's logins: the buffer is `0x49ec70` as named -- `OskActivate a1=0x49ec70 a1="socom"`, `OskLayout a0="socom"` in `logs/parity/s10_g9_prefill_fix4/run_game.log`; research/38's section "the initial text: what the dynamic confirmation found" has the trace and the unwinding it exposed)

Run the harness's existing login with a known name and read the guest RAM for it:

```
PS2X_RDRAM_DUMP=logs/osk_probe.bin python -m tools_py.parity.online_login_ours --name socomz --password socom
python - <<'EOF'
data = open("logs/osk_probe.bin", "rb").read()
i = data.find(b"socomz")
while i >= 0:
    print(hex(i))
    i = data.find(b"socomz", i + 1)
EOF
```

(`PS2X_RDRAM_DUMP` is the runtime's existing whole-RAM dump, `game_overrides_socom2.cpp:864`.) The hit inside
the persona-list object's range is the name buffer; note its guest address in research/38 next to the static
findings. If the static and dynamic addresses disagree, the static reading is wrong -- go back to Step 1.

- [x] **Step 3: Bind the name in the recompiler's table** -- NOT DONE, on purpose (proposed ruling R200 above): the toml stub would drop the original body; the binding is `installOskPrefill` (`replaceFunction`) in Task 2 instead, and `recomp/socom2.toml` is untouched

Append to the override list in `recomp/socom2.toml`, next to `"socom2_RsaGenerateKeyPair@0x0062B168"`:

```toml
  "socom2_OskOpen@0x<kOskOpenAddr>",
```

- [x] **Step 4: Commit** -- `f2171b0` (research/38 only)

```bash
git add docs/research/38-osk-open-function.md recomp/socom2.toml
git commit -m "research(osk): the keyboard-open routine, its buffer and caps, bound for Sprint 10 Goal 9"
```

---

### Task 2: the runtime override -- prefill the keyboard's buffer from the environment

**Files:**
- Modify: `third_party/ps2recomp/ps2xRuntime/include/ps2_call_list.h:143-146` (add `X(socom2_OskOpen)` to
  `PS2_STUB_LIST`, under `X(socom2_LumReadPixel)`)
- Modify: `third_party/ps2recomp/ps2xRuntime/src/lib/game_overrides_socom2.cpp:66-88` (the new stub, next to
  `socom2_RsaGenerateKeyPair`)
- Create: `third_party/ps2recomp/ps2xRuntime/include/runtime/socom2_osk_prefill.h` (the pure part)
- Create: `third_party/ps2recomp/ps2xTest/src/socom2_osk_prefill_tests.cpp`; register it in
  `third_party/ps2recomp/ps2xTest/CMakeLists.txt` beside `launcher_tests.cpp`

**Interfaces:**
- Consumes: `kOskOpenAddr`, the register layout and the two caps from research/38 (Task 1).
- Produces: `socom2_osk::prefillFor(fieldKind, nameEnv, passEnv, cap) -> std::string` (pure: which string
  goes in, cut to the cap, empty when the variable is unset) and the stub `ps2_stubs::socom2_OskOpen`.

**Result (2026-09-21, the Goal 9 agent):** done as a runtime wrap (proposed ruling R200), not a toml stub, so
there is no `ps2_call_list.h` entry and no `_original` continuation: `installOskPrefill` (called from
`applySocom2` after `installRtNetPortShift`, only when `PS2X_SOCOM2_LOGIN_NAME` or `_PASS` is set) keeps the
original through `lookupFunction(0x38d770)` and `replaceFunction`s it with `socom2_OskOpenPrefill`, which reads
the argument block (`socom2_osk::readRequest`), writes the field's string into the initial-text buffer
`0x49ec70` before the original, and blanks it after. The pure header grew `fieldFor(purpose, skbName)`,
`readRequest(block)`, `capFor(maxChars, maxBytes, bufferBytes)` and `fieldLabel` beside `prefillFor`; the test
file holds four cases (the plan's seven assertions plus the field classifier, the cap and the block layout).
RED: `socom2_osk_prefill_tests.cpp:6:10: fatal error: 'runtime/socom2_osk_prefill.h' file not found`. GREEN:
the four `Socom2OskPrefill` cases pass. Commit: see the record at the end of this file.

- [x] **Step 1: Write the failing test**

```cpp
// socom2_osk_prefill_tests.cpp
#include "MiniTest.h"
#include "runtime/socom2_osk_prefill.h"

void registerSocom2OskPrefillTests(TestCollection &tc)
{
    tc.Run("the keyboard prefill picks the field's own variable, cut to the field's cap, or nothing", [](TestCase &t)
    {
        using socom2_osk::Field;
        t.Equals(socom2_osk::prefillFor(Field::PersonaName, "socomc", "socom", 16), std::string("socomc"), "the name field takes the name");
        t.Equals(socom2_osk::prefillFor(Field::Password, "socomc", "socom", 16), std::string("socom"), "the password field takes the password");
        t.Equals(socom2_osk::prefillFor(Field::PersonaName, nullptr, "socom", 16), std::string(), "no name variable: nothing is written");
        t.Equals(socom2_osk::prefillFor(Field::Password, "socomc", nullptr, 16), std::string(), "no password variable: nothing is written");
        t.Equals(socom2_osk::prefillFor(Field::PersonaName, "", "socom", 16), std::string(), "an empty variable is unset");
        t.Equals(socom2_osk::prefillFor(Field::PersonaName, "abcdefghijklmnopqrstuvwxyz", "", 16), std::string("abcdefghijklmnop"), "cut to the cap, never past the buffer");
        t.Equals(socom2_osk::prefillFor(Field::Other, "socomc", "socom", 16), std::string(), "any other keyboard (a game name, a clan tag) is left alone");
    });
}
```

- [x] **Step 2: Run it to see it fail** (the header-not-found error above)

Run (under the lock): `scripts/loop_lock.sh run <owner> --purpose "osk prefill tests" -- bash -c 'cd third_party/ps2recomp && cmake --build build-clang --target ps2x_tests -j 8 && build-clang/ps2xTest/ps2x_tests.exe'`
Expected: a compile error, `socom2_osk_prefill.h` not found.

- [x] **Step 3: The pure part** (plus `fieldFor`, `readRequest`, `capFor`)

```cpp
// runtime/socom2_osk_prefill.h
#pragma once
#include <cstddef>
#include <string>

namespace socom2_osk
{
    enum class Field { PersonaName, Password, Other };

    // The string the keyboard opens with: the field's own variable, cut to what its buffer holds (cap
    // counts characters, the terminator is the buffer's own). Empty means "write nothing": the keyboard
    // opens as the console's does. Pure; the stub below reads the environment and calls this.
    inline std::string prefillFor(Field field, const char *nameEnv, const char *passEnv, std::size_t cap)
    {
        const char *src = field == Field::PersonaName ? nameEnv : (field == Field::Password ? passEnv : nullptr);
        if (src == nullptr || *src == '\0' || cap == 0)
            return std::string();
        std::string out(src);
        if (out.size() > cap)
            out.resize(cap);
        return out;
    }
}
```

- [x] **Step 4: The stub** -- as a `replaceFunction` wrap with the original kept (R200); the field comes from the Purpose key and SkbName, the cap from the live MaxChars/MaxBytes

In `game_overrides_socom2.cpp`, after `socom2_RsaGenerateKeyPair`:

```cpp
    // Sprint 10 Goal 9 (research/38): the game's on-screen keyboard opens on a target buffer and a cap. When
    // the launcher handed the player's persona name / password down (PS2X_SOCOM2_LOGIN_NAME / _PASS), the
    // matching field's buffer is filled BEFORE the keyboard draws, so it opens already typed (R180: prefill,
    // never submit). Any other keyboard, or no variable, and this is the original function, untouched.
    void socom2_OskOpen(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t bufAddr = GPR_U32(ctx, 4);          // research/38: a0 = target buffer  (CHECK the table)
        const uint32_t cap = GPR_U32(ctx, 5);              // research/38: a1 = max characters (CHECK the table)
        const uint32_t fieldId = GPR_U32(ctx, 6);          // research/38: a2 = field id        (CHECK the table)
        const socom2_osk::Field field = fieldId == kOskFieldPersonaName ? socom2_osk::Field::PersonaName
                                      : (fieldId == kOskFieldPassword ? socom2_osk::Field::Password
                                                                       : socom2_osk::Field::Other);
        const std::string text = socom2_osk::prefillFor(field, std::getenv("PS2X_SOCOM2_LOGIN_NAME"),
                                                        std::getenv("PS2X_SOCOM2_LOGIN_PASS"), cap);
        if (!text.empty())
        {
            char *buf = reinterpret_cast<char *>(rdram + (bufAddr & PS2_RAM_MASK));
            std::memcpy(buf, text.data(), text.size());
            buf[text.size()] = '\0';
            std::cout << "[socom2] on-screen keyboard prefilled: " << (field == socom2_osk::Field::Password ? "password" : "persona name")
                      << " (" << text.size() << " chars)" << std::endl;
        }
        // Then the game's own routine, exactly as recompiled: the override only touched the buffer.
        socom2_OskOpen_original(rdram, ctx, runtime);
    }
```

`kOskFieldPersonaName`, `kOskFieldPassword` and the "original" continuation are the values and the pattern
Task 1's table gives (the recompiler emits the original body under a name the toml binding chooses; use the
same shape `socom2_LumReadPixel` uses to fall through when it does not handle a call -- read that function
before writing this one). The three `CHECK` comments are removed once the registers match research/38.

- [ ] **Step 5: Rebuild the runner, run the suite -- THE CONTROLLER'S (lock-bound); no recompile is needed (R200)**

The library half is done: `./build.sh runtime --no-runner` and `./build.sh test --no-runner` are green in the
agent's worktree (ps2x_tests 709/0 -- the count after Tasks 2-5; Python untouched). What is left is the game
exe, which links the runtime library with the generated code. From the main tree, on `sprint-10` with
`agent/goal9` merged (or from a worktree with the generated code):

```
export LOOP_LOCK_PATH=/c/projects/socom_pc/logs/.loop_lock
bash scripts/loop_lock.sh run <owner> --purpose "Goal 9: runtime rebuild + suite" -- bash -c './build.sh runtime && ./build.sh test'
sha256sum dist/socom2.exe      # goes in the gate record
```

What must come out: `built dist/socom2.exe`; `ps2x_tests` with `Socom2OskPrefill` (4 cases) in its list and
`Failed: 0`; the Python suite OK. **Do NOT run `./build.sh recomp`** for this goal: `recomp/socom2.toml` is
unchanged and a recompile would only cost the hour. Then a gate (`s10_g9_gate`, three runs) on the rebuilt
exe with the variables UNSET proves the wrap is never installed without them (the boot log must NOT contain
`on-screen keyboard prefill armed`).

- [x] **Step 6: Commit** (the runtime side, in the agent's branch; the record at the end names the hash)

```bash
git add third_party/ps2recomp/ps2xRuntime/include/ps2_call_list.h third_party/ps2recomp/ps2xRuntime/include/runtime/socom2_osk_prefill.h third_party/ps2recomp/ps2xRuntime/src/lib/game_overrides_socom2.cpp third_party/ps2recomp/ps2xTest/src/socom2_osk_prefill_tests.cpp third_party/ps2recomp/ps2xTest/CMakeLists.txt
git commit -m "feat(runtime): the on-screen keyboard opens holding the launcher's persona name and password (Sprint 10 Goal 9, R180)"
```

---

### Task 3: the config and the environment (ps2xShared, lock-free)

**Files:**
- Modify: `third_party/ps2recomp/ps2xShared/include/launcher/launcher_config.h:45-70` (`Config`) and the
  declarations after `normalizeProfile`
- Modify: `third_party/ps2recomp/ps2xShared/src/launcher_config.cpp:423-470` (`environmentFor`), the
  `toJson` / `fromJson` key lists (`:212`, `:260`)
- Test: `third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp` (next to "the controller pick and the dead
  zone round-trip and reach the environment", `:105`)

**Interfaces:**
- Consumes: `kOskNameCap` from research/38 (Task 1) as the name cap.
- Produces: `Config::loginName`, `Config::loginPassword` (both `std::string`, default empty);
  `launcher::normalizeLoginName(const std::string&) -> std::string`; the two environment entries.

**Result (2026-09-21):** as written, with R201/R202: `kLoginNameCap = 14`, `kLoginPasswordCap = 12`,
`normalizeLoginName` (printable ASCII, no space, no `"`, cut to 14) and `normalizeLoginPassword` (printable
ASCII, no space, cut to 12), both applied in `environmentFor` so what reaches the game is what the keyboard
could have typed; `toJson`/`fromJson` carry `loginName` / `loginPassword`. RED:
`launcher_tests.cpp:489:24: error: no member named 'loginName' in 'launcher::Config'` (and
`normalizeLoginName`, `kLoginNameCap`...). GREEN: "the persona name and password round-trip the config and
reach the game only when set" passes; the `bare_run` environment case still passes.

- [x] **Step 1: Write the failing test**

```cpp
        tc.Run("the persona name and password round-trip the config and reach the game only when set", [](TestCase &t)
        {
            auto has = [](const std::vector<std::string> &e, const std::string &kv) { return std::find(e.begin(), e.end(), kv) != e.end(); };
            auto hasKey = [](const std::vector<std::string> &e, const std::string &k) { return std::any_of(e.begin(), e.end(), [&](const std::string &s) { return s.rfind(k + "=", 0) == 0; }); };
            launcher::Config c;
            t.IsTrue(c.loginName.empty() && c.loginPassword.empty(), "a fresh config has neither");
            std::vector<std::string> env = launcher::environmentFor(c);
            t.IsFalse(hasKey(env, "PS2X_SOCOM2_LOGIN_NAME"), "nothing typed: the game is not told a name");
            t.IsFalse(hasKey(env, "PS2X_SOCOM2_LOGIN_PASS"), "nor a password -- the keyboards open empty, as today");

            c.loginName = "socomc";
            c.loginPassword = "socom";
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_NAME=socomc"), "the name reaches the game");
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_PASS=socom"), "and the password");

            launcher::Config back;
            t.IsTrue(launcher::fromJson(launcher::toJson(c), back), "parses its own output");
            t.Equals(back.loginName, std::string("socomc"), "the name survives the round trip");
            t.Equals(back.loginPassword, std::string("socom"), "and the password (R179: plain, in the player's own file)");

            // The name is what the game's keyboard could have typed: its characters, its cap.
            t.Equals(launcher::normalizeLoginName("socomc"), std::string("socomc"), "a plain name is kept");
            t.Equals(launcher::normalizeLoginName("so com"), std::string("socom"), "a space is not a keyboard character");
            t.Equals(launcher::normalizeLoginName("abcdefghijklmnopqrstuvwxyz"), std::string("abcdefghijklmnopqrstuvwxyz").substr(0, launcher::kLoginNameCap), "cut to the keyboard's cap");
            t.Equals(launcher::normalizeLoginName(""), std::string(), "empty stays empty");
            c.loginName = "so com";
            env = launcher::environmentFor(c);
            t.IsTrue(has(env, "PS2X_SOCOM2_LOGIN_NAME=socom"), "what reaches the game is the normalised name");
        });
```

- [x] **Step 2: Run it to see it fail**

Run (under the lock, the test target only): `scripts/loop_lock.sh run <owner> --purpose "Goal 9 config tests" -- bash -c 'cd third_party/ps2recomp && cmake --build build-clang --target ps2x_tests -j 8'`
Expected: compile error, `loginName` is not a member of `launcher::Config`.

- [x] **Step 3: The config fields and the normaliser** (caps 14/12, the keyboard's character set -- R201, R202)

In `launcher_config.h`, after `std::string profile = "player";`:

```cpp
        // Sprint 10 Goal 9: the persona the game logs in as and its password, typed once here and handed to
        // the game's keyboards already filled (PS2X_SOCOM2_LOGIN_NAME / _PASS; R179: stored plain in this
        // file, R180: prefilled, never submitted). Empty = nothing is sent and the keyboards open empty.
        std::string loginName;
        std::string loginPassword;
```

After `normalizeProfile`'s declaration:

```cpp
    // The persona name as the game's own keyboard could have typed it: letters and digits only (the keyboard
    // has no space), cut to kLoginNameCap (research/38, the persona-list buffer's cap). Empty stays empty.
    constexpr std::size_t kLoginNameCap = 16;   // research/38 -- replace with the measured cap
    std::string normalizeLoginName(const std::string &value);
```

In `launcher_config.cpp`, next to `normalizeProfile`:

```cpp
    std::string normalizeLoginName(const std::string &value)
    {
        std::string out;
        for (char ch : value)
        {
            const bool ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
            if (ok)
                out.push_back(ch);
            if (out.size() == kLoginNameCap)
                break;
        }
        return out;
    }
```

In `environmentFor`, after the `PS2X_MC_DIR` line:

```cpp
        // Sprint 10 Goal 9: only when typed -- unset means the keyboards open empty, as before the option.
        const std::string loginName = normalizeLoginName(c.loginName);
        if (!loginName.empty())
            env.push_back("PS2X_SOCOM2_LOGIN_NAME=" + loginName);
        if (!c.loginPassword.empty())
            env.push_back("PS2X_SOCOM2_LOGIN_PASS=" + c.loginPassword);
```

In `toJson`, after the `profile` line: `out += "  \"loginName\": " + quote(c.loginName) + ",\n";` and
`out += "  \"loginPassword\": " + quote(c.loginPassword) + ",\n";`. In `fromJson`'s string-key list add
`key == "loginName" || key == "loginPassword"`, and the two assignments beside `micDevice`'s.

- [x] **Step 4: Run the suite**

Same command as Step 2, then `build-clang/ps2xTest/ps2x_tests.exe`. Expected: the new case passes; the
existing `bare_run` case "nothing added, nothing dropped relative to environmentFor" still passes (it
compares against `environmentFor` itself).

- [x] **Step 5: Commit** (the record at the end names the hash)

```bash
git add third_party/ps2recomp/ps2xShared/include/launcher/launcher_config.h third_party/ps2recomp/ps2xShared/src/launcher_config.cpp third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp
git commit -m "feat(config): the persona name and password in config.json and the game's environment (Sprint 10 Goal 9, R179)"
```

---

### Task 4: the ONLINE page -- two fields under PROFILE, the password masked (launcher, lock-free build)

**Files:**
- Modify: `third_party/ps2recomp/ps2xLauncher/src/ui/focus.cpp:167-184` (the ONLINE layout: two nodes,
  `online.name` and `online.password`, and the ADVANCED row moved down)
- Modify: `third_party/ps2recomp/ps2xLauncher/src/ui/focus.cpp` (the help table `kHelp`, two entries)
- Modify: `third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp:62-79` (draw the fields)
- Modify: `third_party/ps2recomp/ps2xLauncher/src/ui/widgets.h:104-105` and `widgets.cpp` (`textField`
  gains a `masked` flag: draws one bullet per character, edits as before)
- Modify: `third_party/ps2recomp/ps2xLauncher/src/ui/page_about.cpp:47-54` ("where things live": the line
  "config -- your server, profile and password are in this file")
- Test: `third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp` (the ONLINE layout tests near "the ONLINE
  page lays out a row for every preset there is")

**Interfaces:**
- Consumes: `Config::loginName`, `Config::loginPassword`, `normalizeLoginName` (Task 3).
- Produces: nodes `online.name`, `online.password` in the ONLINE layout, in focus order after
  `online.profile` and before `online.advanced`.

**Result (2026-09-21):** as written, at both window sizes, plus the focus order (profile, name, password,
ADVANCED) and the help. RED (`logs/osk/build3.log`): "both fields are laid out", "in reading order under
PROFILE", "focus walks profile, name, password, ADVANCED", "both fields have help". The first GREEN attempt
failed ONE assertion, "with its caption still inside the body" (build4.log): five rows on the plan's 56-px
pitch put the open ADVANCED section's caption 30 px past the body at 1100x700. The page's rows now sit on a
52-px pitch (`kOnlineRowPitch`, a 40-px field and the REPORT page's 12-px gap) with 20 px under the presets;
GREEN (build5.log): 709/0. Screenshots: `logs/launcher_shots_g9/` (42 PNGs, the full walk) --
`online_credentials_1100x700.png`: PLAYER NAME "socomc", PASSWORD as seven marks with the focus on it and its
help in the title strip, ADVANCED shut below, nothing under the strip; `online_credentials_800x520.png`: the
same at the small size; `online_advanced_1100x700.png`: the fields empty, the open section and its caption
inside the body; `about_1100x700.png` / `_800x520`: "server, profile, and the password if you typed one -- in
plain text" under the config path. One `--screenshot` run segfaulted at the resize into
`controller_crouch_l3_800x520` (build4.log, before any ONLINE shot, in code this task does not touch); the
rerun completed all 42. Not reproduced since; noted here for whoever sees it next.

- [x] **Step 1: Write the failing layout test**

```cpp
        tc.Run("the ONLINE page holds a name and a masked password under PROFILE, above ADVANCED, clear of each other", [](TestCase &t)
        {
            const ui::Rect window{0.0f, 0.0f, 1100.0f, 700.0f};
            ui::LayoutInputs in;
            in.advancedOpen = true;
            const std::vector<ui::Node> nodes = ui::layoutFor(ui::Page::Online, window, in);
            const ui::Rect profile = ui::rectOf(nodes, "online.profile");
            const ui::Rect name = ui::rectOf(nodes, "online.name");
            const ui::Rect password = ui::rectOf(nodes, "online.password");
            const ui::Rect advanced = ui::rectOf(nodes, "online.advanced");
            const ui::Rect second = ui::rectOf(nodes, "online.second");
            t.IsTrue(ui::drawable(name) && ui::drawable(password), "both fields are laid out");
            t.IsTrue(name.y >= profile.bottom() && password.y >= name.bottom(), "in reading order under PROFILE");
            t.IsTrue(advanced.y >= password.bottom(), "ADVANCED is below them");
            t.IsTrue(second.y >= advanced.bottom(), "and the second-instance toggle below that");
            const ui::Frame f = ui::frameFor(window);
            t.IsTrue(second.bottom() + 40.0f <= f.body.bottom(), "with its caption still inside the body");
            t.IsFalse(ui::helpFor("online.name").empty() && ui::helpFor("online.password").empty(), "both fields have help");
        });
```

- [x] **Step 2: Run it to see it fail**

Run (under the lock): the `ps2x_tests` build and run as in Task 3. Expected: "both fields are laid out" fails.

- [x] **Step 3: The layout, the help, the page** (pitch 52, not 56 -- see the result; the ABOUT line reads "server, profile, and the password if you typed one -- in plain text"; the screenshot is taken at both sizes)

In `focus.cpp`'s ONLINE case, replace the two lines after the profile node:

```cpp
            add(out, page, "online.profile", Rect{b.x + metrics::labelW, y + 56.0f, 300.0f, 40.0f});
            // Sprint 10 Goal 9: the persona and its password, under the profile that keeps the card.
            add(out, page, "online.name", Rect{b.x + metrics::labelW, y + 112.0f, 300.0f, 40.0f});
            add(out, page, "online.password", Rect{b.x + metrics::labelW, y + 168.0f, 300.0f, 40.0f});
            add(out, page, "online.advanced", Rect{b.x, y + 236.0f, b.w, 28.0f});
            if (in.advancedOpen)
                add(out, page, "online.second", Rect{b.x + metrics::labelW, y + 278.0f, 460.0f, 34.0f});
```

In `kHelp`, after the `online.second` entry:

```cpp
            {"online.name",
             "The persona other players see, and the name the game logs in with. Leave it empty and the game "
             "asks on its own keyboard, as it always did."},
            {"online.password",
             "The persona's password. Kept in config.json next to the launcher, in plain text, masked here; "
             "the game's keyboard opens with it already typed and you press ENTER."},
```

In `page_online.cpp`, after the PROFILE field and its caption:

```cpp
        const Rect name = rectOf(nodes, "online.name");
        rowLabel(ctx, name, "PLAYER NAME");
        textField(ctx, name, c.loginName, "online.name", changed, true, launcher::kLoginNameCap);
        caption(ctx, Vec2{name.right() + 18.0f, name.y + 12.0f}, "the persona; empty = the game asks");
        const Rect password = rectOf(nodes, "online.password");
        rowLabel(ctx, password, "PASSWORD");
        textField(ctx, password, c.loginPassword, "online.password", changed, true, 32, true);   // masked
        caption(ctx, Vec2{password.right() + 18.0f, password.y + 12.0f}, "kept in config.json");
```

`textField` gains a trailing `bool masked = false` parameter (widgets.h `:104`); in widgets.cpp the shown
string is `std::string(value.size(), '*')` when masked and the caret arithmetic uses the shown string's
width. In `page_about.cpp` the "config" row's caption becomes "config -- server, profile, and the password if
you typed one". Then `--screenshot` gains one capture, `online_credentials_1100x700.png`, with both fields
filled in the fake config (`main.cpp:1000-1030`, beside `_help`).

- [x] **Step 4: Build, run the suite, take the screenshots, look at them** (709/0, not 689 + 2: the count had moved on since the plan was written)

Run (under the lock): build `socom_unzipped_launcher ps2x_tests`, run the suite, then
`build-clang/ps2xLauncher/socom_unzipped_launcher.exe --screenshot logs/launcher_shots_g9`. Expected:
689 + 2 pass; `online_credentials_1100x700.png` shows PLAYER NAME filled and PASSWORD as bullets, both above
ADVANCED, nothing under the title strip.

- [x] **Step 5: Commit** (the record at the end names the hash)

```bash
git add third_party/ps2recomp/ps2xLauncher/src/ui/focus.cpp third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp third_party/ps2recomp/ps2xLauncher/src/ui/page_about.cpp third_party/ps2recomp/ps2xLauncher/src/ui/widgets.h third_party/ps2recomp/ps2xLauncher/src/ui/widgets.cpp third_party/ps2recomp/ps2xLauncher/src/main.cpp third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp
git commit -m "feat(launcher): PLAYER NAME and a masked PASSWORD on ONLINE (Sprint 10 Goal 9)"
```

---

### Task 5: the password never leaves the machine in a report or a zip (lock-free)

**Files:**
- Modify: `third_party/ps2recomp/ps2xShared/src/diagnostics.cpp:56-65` (`sanitizedConfigJson`, which already
  cuts the disc path to its file name for the zip's `config.json` copy -- the password joins that rule)
- Modify: `third_party/ps2recomp/ps2xShared/src/bug_report.cpp:540-560` (the payload's `add("iso", ...)` block
  -- read it first; it adds named fields from `Config` rather than the whole file, so the password is out
  unless someone adds it, and the test below is the guard)
- Test: `third_party/ps2recomp/ps2xTest/src/diagnostics_tests.cpp:80-95` (beside the `kConfigWithSecrets`
  case), `third_party/ps2recomp/ps2xTest/src/bug_report_tests.cpp`

**Interfaces:**
- Consumes: `Config::loginPassword` (Task 3), `diag::sanitizedConfigJson(const std::string&)` (exists),
  `launcher::bugreport::build(config, form, inputs).json` (exists).
- Produces: nothing new; `sanitizedConfigJson` blanks `loginPassword`.

**Result (2026-09-21):** as written, with the negative controls widened: the whole bundle (`diag::entries` +
`ZipStore::build`, every entry and the archive's bytes) with a planted "zq9pw" (under the text scrubber's
six-character floor) and "hunter2hunter2" (over it); the bug report with a log line carrying
`PS2X_SOCOM2_LOGIN_PASS=hunter2` and the context pairs checked for either key. A first draft planted "socom"
and the log fixture's own `[socom2]` lines matched it -- a planted value must not be a substring of the
fixture. RED (build3.log): "the password is not in the zip's config.json", "the key is there, empty, so a
reader sees it was blanked", "config.json does not contain hunter2hunter2". GREEN (build5.log): both pass.
The bug-report case passed at once, as the plan predicted, and stays as the guard.

- [x] **Step 1: Write the failing tests**

```cpp
        // diagnostics_tests.cpp, after the kConfigWithSecrets case
        tc.Run("the diagnostics zip's config copy has the password blanked", [](TestCase &t)
        {
            launcher::Config c;
            c.loginName = "socomc";
            c.loginPassword = "hunter2";
            const std::string copy = diag::sanitizedConfigJson(launcher::toJson(c));
            t.IsTrue(copy.find("hunter2") == std::string::npos, "the password is not in the zip's config.json");
            t.IsTrue(copy.find("\"loginPassword\": \"\"") != std::string::npos, "the key is there, empty, so a reader sees it was blanked");
            t.IsTrue(copy.find("\"loginName\": \"socomc\"") != std::string::npos, "the name stays: it is what the player sees on screen");
        });
```

```cpp
        // bug_report_tests.cpp
        tc.Run("a bug report never carries the password", [](TestCase &t)
        {
            launcher::Config c;
            c.loginName = "socomc";
            c.loginPassword = "hunter2";
            launcher::bugreport::Form form;
            form.title = "the lobby";
            form.description = "a description long enough to pass the form check, with detail";
            const std::string json = launcher::bugreport::build(c, form, launcher::bugreport::Inputs{}).json;
            t.IsTrue(json.find("hunter2") == std::string::npos, "the password is not in the payload");
            t.IsTrue(json.find("loginPassword") == std::string::npos, "nor its key");
        });
```

- [x] **Step 2: Run them to see the first fail**

Under the lock, the `ps2x_tests` target, then `ps2x_tests.exe`. Expected: "the password is not in the zip's
config.json" fails (`sanitizedConfigJson` round-trips every field today); the bug-report case passes at once
and stays as the guard.

- [x] **Step 3: Blank it in the sanitiser**

In `sanitizedConfigJson`, after the disc-path cut:

```cpp
        config.loginPassword.clear();   // R179: the password stays in the player's own file and nowhere else
```

- [x] **Step 4: Run the suite; commit** (the record at the end names the hash)

```bash
git add third_party/ps2recomp/ps2xShared/src/diagnostics.cpp third_party/ps2recomp/ps2xTest/src/diagnostics_tests.cpp third_party/ps2recomp/ps2xTest/src/bug_report_tests.cpp
git commit -m "fix(diagnostics): the password is blanked out of the zip's config copy; a bug report never carried it (Sprint 10 Goal 9, R179)"
```

---

### Task 6: the harness stops typing on ours -- `--prefilled` (lock-bound proof)

**Files:**
- Modify: `tools_py/parity/online_login_ours.py:1282-1305` (`login`), `create_persona`, the argument
  parser (`:7` usage line), and `Shell.type`
- Create: `tools_py/tests/test_online_login_prefilled.py` (the harness's login flow has no unit test today; this
  is its first, and it imports `tools_py.parity.online_login_ours` with the screen reads monkeypatched away)

**Interfaces:**
- Consumes: `PS2X_SOCOM2_LOGIN_NAME` / `PS2X_SOCOM2_LOGIN_PASS` honoured by the runtime (Task 2).
- Produces: `--prefilled`: the harness exports the two variables to the game it launches and, on each
  keyboard, verifies the typed length equals the expected string's length (the existing `osk_typed`
  read-back) and presses ENTER (`osk_enter_verified`) instead of typing.

**For the controller (2026-09-21, from the lock-free pass).** Not started: the task is lock-bound at Step 4
and its Steps 1-3 are the harness's, which the agent's brief kept out. Three corrections to the steps as
written before running them: (1) the test runner is `python -m unittest tools_py.tests.test_online_login_prefilled`,
never pytest (`test_test_hygiene.py` refuses a pytest-style file, so the `monkeypatch` fixture below becomes
`unittest.mock.patch.object`); (2) the runtime's log line is
`[socom2] on-screen keyboard open: purpose="_455_EnterPlayerName_MSG" skb="CREATEPLAYERNAME" MaxChars=14 MaxBytes=31 -> prefilled: persona name (6 chars)`
and `... purpose="_604_EnterPassword_MSG" ... MaxChars=12 ... -> prefilled: the password (5 chars)` -- grep for
`-> prefilled:`; every other keyboard logs `-> not prefilled` with its own purpose, which is research/38's
dynamic confirmation (Task 1 Step 2) for free; and at boot `[socom2] on-screen keyboard prefill armed:
persona name 6 chars, password 5 chars`; (3) the harness must export BOTH variables into the game's
environment (the launcher's `environmentFor` is not in the driven path), normalised the launcher's way
(`normalizeLoginName`: printable ASCII, no space, no `"`, 14 max; the password 12 max) -- `socomc` / `socom`
need no change. What must come out of Step 4: two `LOBBY class=ok` runs in a row on the hosted server, each
log with the two `-> prefilled:` lines, the persona-name keyboard read back at 6 glyphs and the password one
at 5 BEFORE the ENTER, and no `osk_type_pad` line. Then the owner's own login (HUMAN_TASKS), and a gate on
the rebuilt exe with the variables unset (Task 2 Step 5) so the wrap is proven absent by default.

**Result (2026-09-21, the Task 6 agent, worktree `wt-g9t6`, branch `agent/g9t6` off `sprint-10` at `38579a3`;
Steps 1-3 and the lock-free half of Step 4 done, the two logins the controller's):** `--prefilled` on
`online_login_ours`: `prefill_env(name, password)` checks both against the keyboards' caps (`PREFILL_NAME_CAP`
14, `PREFILL_PASSWORD_CAP` 12) and character set (printable ASCII, no space; no `"` in the name -- research/38)
and REFUSES a value outside them (`ap.error`, exit 2, before any game starts -- not cut the launcher's way,
because the runtime would cut it too and the keyboard would then read back short 90 s in); `launch(seconds,
instance, prefill)` puts the two variables in the game's environment, None adds nothing; `Shell.type(...,
prefilled=True)` keeps the keyboard-open guard (`wait_osk`) and the mode read, then `osk_enter_prefilled`: the
count read back (`osk_typed`) must equal `len(text)` -- else the new class `login:prefill-missing`
(`CLASS_OSK_PREFILL`) with the count in the detail and no press -- then the walk to ENTER from `OSK_START` and
the same `osk_enter_verified` read-back a typed ENTER gets (a keyboard still up is re-pressed, at most
`OSK_ENTER_RETRIES`); `login(..., prefilled=False)` and `create_persona(..., prefilled=False)` pass it to both
keyboards (the form read-back of PLAYER NAME after the name's ENTER is unchanged). Without the flag: the same
calls with the default, byte for byte. Test: `tools_py/tests/test_online_login_prefilled.py`, 17 cases in
five classes -- PrefillValues (d), LaunchEnvironment (a), KeyboardEnter (b/c at `Shell.type`, the real method
over test_osk_typing's synthesised text rows), LoginFlow (b/c across `login`, test_first_login's form frames,
test_online_login_lobby's FakeShell), CommandLine (`main()` with `launch`/`attach`/`login` patched: the flag
reaches the environment and the presses; a 15-character name, a 13-character password and a space stop the
run before `launch`). RED: 12 errors + 1 failure (`no attribute 'prefill_env'`, `login() takes 4 positional
arguments but 5 were given`, `Shell.type() got an unexpected keyword argument 'prefilled'`, `launch() takes
from 1 to 2 positional arguments but 3 were given`, `'[--prefilled]' not found` in the usage line). GREEN:
17/17. Two existing test helpers grew with the signatures: `test_online_login_lobby.FakeShell.type` takes
`prefilled` (records `("enter", text)` instead of `("type", text)`) and `test_first_login.LoginBranch`'s
`create_persona` stub takes the fourth argument. Unverified here (a game launch): that the keyboard's cursor
opens on the accent key (`OSK_START`) when the field is prefilled as it does when empty -- a lost ENTER walk
is caught by `osk_enter_verified`'s re-press either way, and the first driven login says.

**The controller's Step 4, exactly** (the module's argument names are the plan's: `--existing --prefilled
--name --password`; `--out` names the run directory; `PS2X_RUN_LOG` pins the game's own log, `run.sh`):

```bash
export LOOP_LOCK_PATH=/c/projects/socom_pc/logs/.loop_lock
mkdir -p logs/parity/s10_g9_prefill_gate
for n in 1 2; do
  PS2X_RUN_LOG="$PWD/logs/parity/s10_g9_prefill_gate/run${n}_game.log" \
  bash scripts/loop_lock.sh run <owner> --purpose "launch: Goal 9 proof $n/2" -- \
    python -m tools_py.parity.online_login_ours --existing --prefilled --name socomc --password socom \
      --out logs/parity/s10_g9_prefill_gate/run$n 2>&1 | tee logs/parity/s10_g9_prefill_gate/run${n}_drive.txt
done
grep -h "prefill armed\|on-screen keyboard open" logs/parity/s10_g9_prefill_gate/run*_game.log
grep -h "\[osk\]\|LOBBY class" logs/parity/s10_g9_prefill_gate/run*_drive.txt
```

What must come out, per run: in `run<n>_game.log` the boot line `[socom2] on-screen keyboard prefill armed:
persona name 6 chars, password 5 chars` and the two keyboard lines ending `-> prefilled: persona name (6
chars)` and `-> prefilled: the password (5 chars)` (the first login on the hosted box; a persona already saved
there skips the name keyboard and shows only the second); in `run<n>_drive.txt` `[osk] prefilled: 6 of 6 in
the field -> ENTER` and `[osk] prefilled: 5 of 5 in the field -> ENTER` (the read-backs BEFORE the ENTER),
`[osk] enter: keyboard closed` after each, no `[osk] typed` line (the pad typer's) and no `WARNING: the
on-screen keyboard is still up after typing` (the posted-keys typer's -- `main()`'s shell has no pad file, so
"no `osk_type_pad` line" is vacuous there: the absence to check is those two), and `LOBBY class=ok`. A
`LOBBY class=login:prefill-missing` with `0 of 6` means the exe was not rebuilt with Task 2 (or the variables
did not reach it: check `prefill armed` in the game log first).

- [x] **Step 1: Write the failing test** (as unittest, per the correction above: five TestCase classes, the plan's
  case is `LoginFlow.test_a_prefilled_first_login_presses_enter_on_both_keyboards_and_types_nothing`)

```python
def test_prefilled_login_presses_enter_and_never_types(monkeypatch):
    calls = []
    class FakeShell:
        def __init__(self): self.log_lines = []
        def press_until_gone(self, key, screen): calls.append(("press_until_gone", key, screen))
        def wait_for(self, screen, timeout, required=True): calls.append(("wait_for", screen))
        def shot(self, tag): pass
        def log(self, s): self.log_lines.append(s)
        def type(self, text, shots=None, tag=""): calls.append(("type", text))
        def osk_typed(self): return 6
        def osk_enter_verified(self, text, cur): calls.append(("enter", text))
    sh = FakeShell()
    monkeypatch.setattr(online_login_ours, "persona_form_mode", lambda sh, existing: ("create", 0))
    monkeypatch.setattr(online_login_ours, "press_connect", lambda sh: calls.append(("connect",)))
    monkeypatch.setattr(online_login_ours, "login_prompts", lambda sh: None)
    monkeypatch.setattr(online_login_ours, "login_to_lobby", lambda sh: None)
    online_login_ours.login(sh, "socomc", "socom", existing=False, prefilled=True)
    assert ("type", "socomc") not in calls and ("type", "socom") not in calls
    assert ("enter", "socomc") in calls and ("enter", "socom") in calls
```

- [x] **Step 2: Run it to see it fail** (`python -m unittest tools_py.tests.test_online_login_prefilled`: 12 errors
  + 1 failure, the messages in the result above)

Run: `python -m pytest tools_py/tests -k prefilled -q`. Expected: `TypeError: login() got an unexpected
keyword argument 'prefilled'`.
> Superseded 2026-09-21: the runner is `python -m unittest tools_py.tests.test_online_login_prefilled`
> (test_test_hygiene.py refuses pytest); the first error is `login() takes 4 positional arguments but 5 were
> given` -- the flag is positional in `login`'s call from `main()`.

- [x] **Step 3: The flag** (as written, plus the refusal of a value outside the caps / character set -- the
  result above; the class is spelled `CLASS_OSK_PREFILL = "login:prefill-missing"`)

`login(sh, name, password, existing, prefilled=False)`: when `prefilled`, `create_persona` is called with
`typed=False` and presses ENTER through `sh.osk_enter_verified(name, OSK_START)` after `sh.osk_typed() ==
len(name)` (a mismatch is the new failure class `login:prefill-missing`, filed like `login:keyboard-typing`
at `:299`); the password step does the same with `password`. The launcher (`Shell` construction) exports the
two variables into the game's environment when `--prefilled` is given; `main()` adds the flag and the usage
line at `:7` gains `[--prefilled]`.

- [x] **Step 4: Run the harness's tests, then the real login, twice** (the tests: done, the whole suite green --
  the count in the record below; the logins: DONE 2026-09-21, three `LOBBY class=ok` in a row on the hosted
  server after the fix below -- the record "The two logins, and the third" under this task)

**The two logins, and the third (2026-09-21, the Task 6 follow-up agent, main tree, `sprint-10`).** Runs 1
and 2 (`logs/parity/s10_g9_prefill_gate`, the exe of `2bc56ec`) entered the wrap -- the game log had
`on-screen keyboard open: purpose="_604_EnterPassword_MSG" skb="CREATEPLAYERNAME" MaxChars=12 MaxBytes=31 ->
prefilled: the password (5 chars)` -- and the keyboard opened empty (`[osk] prefilled: 0 of 5 in the field`,
`LOBBY class=login:prefill-missing`). Run 3 (`logs/parity/s10_g9_prefill_diag3`, `PS2X_CALL_TRACE` on the
activation chain, `PS2X_WATCH` on the buffer, a temporary dump after the original) found the cause in one
line: `[ret-unwound] OskActivate #0 pc=0x3766a0 ra=0x38d84c` -- `FUN_0038b440` leaves through an EE
scheduler checkpoint (`dispatchGuestBranch`'s unwind) before the text is laid out, the wrap took that for
the original's return and blanked `0x49ec70`, and the resumed guest laid out an empty string. The buffer
research/38 named is the right one; writing AFTER the original was the defect. Fix `f47cfe0`: the wrap
writes the buffer's whole image before the open (the text for a login field, zeros for any other keyboard)
and nothing after it (`socom2_osk::writeBuffer`, one new ps2x_tests case; 732/732). Then:

| run | card / persona | `[osk]` lines | `LOBBY class` |
|---|---|---|---|
| `s10_g9_prefill_fix4` | `mc0`, `socomc` saved (password keyboard only) | `prefilled: 5 of 5 in the field -> ENTER`, `enter: keyboard closed` | `ok` (97.0 s) |
| `s10_g9_prefill_fix5` | the same | the same | `ok` (96.6 s) |
| `s10_g9_prefill_fix6_newpersona` | a scratch copy of `mc0_parity` (no persona for the box), `socomd` | name keyboard `prefilled: 6 of 6 -> ENTER`, `PLAYER NAME reads 6 glyphs`; password `5 of 5 -> ENTER` | `ok` (131.5 s, the first-login prompts) |

The game logs carry both keyboard lines of research/38's table (`_455_EnterPlayerName_MSG` MaxChars=14 ->
`prefilled: persona name (6 chars)`; `_604_EnterPassword_MSG` MaxChars=12 -> `prefilled: the password (5
chars)`), and `OskActivate a1="socom"` / `OskLayout a0="socom"` -- the buffer read by the layout with the
text in it. No `[osk] typed` line (the pad typer's) in any of the three. `socomd` is a throwaway account on
the project's own box. The three-stage gate with the variables unset is still the controller's.

Run: `python -m pytest tools_py/tests -q` (lock-free), then (lock-bound, an away window):
> Superseded 2026-09-21: `python -m unittest discover -s tools_py/tests -t .` (about 5 minutes).
`scripts/loop_lock.sh run <owner> --purpose "Goal 9 proof" -- python -m tools_py.parity.online_login_ours --existing --prefilled --name socomc --password socom`
twice. Expected: `LOBBY class=ok` both times, the log showing `on-screen keyboard prefilled: persona name (6
chars)` and `... password (5 chars)` from the runtime and no `osk_type_pad` lines from the harness. The two
run directories go in the gate record `logs/parity/s10_g9_prefill_gate`.

- [x] **Step 5: Commit** (the record at the end names the hash; the two test helpers that grew are in the pathspec)

```bash
git add tools_py/parity/online_login_ours.py tools_py/tests/test_online_login_prefilled.py
git commit -m "feat(harness): --prefilled -- ours logs in from the launcher's variables, pressing ENTER instead of typing (Sprint 10 Goal 9)"
```

---

### Task 7: the record (lock-free)

**Files:**
- Modify: `docs/CURRENT_SPRINT.md` (Goal 9's row: DONE, the gate, the exe sha; the R179/R180 numbers)
- Modify: `docs/HUMAN_TASKS.md` (one owner check: "fill PLAYER NAME and PASSWORD on ONLINE, launch, go
  online: both keyboards should open already filled; press ENTER twice and CONNECT")
- Modify: `docs/KNOWN.md` (the "saved online personas per server" row gains: a launcher-typed name that
  differs from the card's saved persona is a create-persona login, which is correct)
- Modify: `docs/PLAYTEST.md` step 11 (the login line: "type your name and password on ONLINE first")
- Message `socom-pc-10` (the story session) that ONLINE gained two fields, so `docs/STORY.md`'s launcher entry
  can follow.

**Split (2026-09-21):** the agent's half is this file and research/38 (the controller owns CURRENT_SPRINT,
HUMAN_TASKS, KNOWN, PLAYTEST and the message to the story session); those rows are written when Task 6's two
logins are in, and they need from here: the three proposed rulings (R200, R201, R202 -- to number), the KNOWN
addition (a launcher-typed name that differs from the card's saved persona is a create-persona login, which
is correct; and a name the keyboard cannot type -- a space, an accent -- is silently reduced to what it can,
so a persona with such a character does not exist and cannot be typed on ONLINE either), and the HUMAN_TASKS
check ("fill PLAYER NAME and PASSWORD on ONLINE, launch, go online: both keyboards should open already
filled; press ENTER twice and CONNECT" -- and that the password field stops at 12 characters).

- [ ] **Step 1: Write the rows, commit** -- THE CONTROLLER'S, after Task 6

```bash
git add docs/CURRENT_SPRINT.md docs/HUMAN_TASKS.md docs/KNOWN.md docs/PLAYTEST.md
git commit -m "docs: Sprint 10 Goal 9 recorded -- the ONLINE tab's name and password reach the game's keyboards"
```

## The lock-free record (2026-09-21, the Goal 9 agent, worktree `wt-goal9`, branch `agent/goal9` off `sprint-10`)

| Task | Commit | RED | GREEN |
|---|---|---|---|
| 1 | `f2171b0` research/38 (no toml line: R200) | -- | the table: `0x38D770`, `0x49EC70`, caps 14 / 12, Purpose + SkbName |
| 2 | `103122a` the wrap, the pure header, 4 cases | `'runtime/socom2_osk_prefill.h' file not found` | Socom2OskPrefill 4/4 |
| 3 | `d30729d` config + environment + normalisers | `no member named 'loginName' in 'launcher::Config'` | the round-trip case |
| 4 | `c145d39` ONLINE fields, masked, help, ABOUT, screenshots | "both fields are laid out" (+3); then "with its caption still inside the body" at pitch 56 | the layout case at both sizes; 42 PNGs |
| 5 | `352b429` the zip's config copy blanked; the report guard | "the password is not in the zip's config.json" (+2) | both cases |
| 6 | `c883526` `--prefilled`, `prefill_env`, `osk_enter_prefilled`, `login:prefill-missing`, 17 cases (agent/g9t6, 2026-09-21) | `no attribute 'prefill_env'`, `login() takes 4 positional arguments but 5 were given` (+3 kinds) | 17/17; the Python suite 1639 OK (105 skipped) |
| 7 | this file + research/38 | -- | -- |

Suite sizes after the pass: `ps2x_tests` 709 / 0 (was 700-701 before this goal); the Python suite unchanged
by this goal: 1571 OK (93 skipped), run lock-free after the last commit. Builds: `./build.sh runtime --no-runner` (the library and
the launcher), the `ps2x_tests` target and the screenshot walk, each under the machine lock; `./build.sh
recomp` NOT run (R200), `./build.sh runtime` with the runner NOT run (the controller's, Task 2 Step 5). Logs in
the worktree's git-ignored `logs/osk/` (`build2.log` RED, `build3.log` Tasks 2-3 GREEN / 4-5 RED,
`build4.log` the pitch failure, `build5.log` GREEN) and `logs/launcher_shots_g9/`.

**What is left, in order, all the controller's:** Task 2 Step 5 (rebuild the runner, suite, a gate with the
variables unset); Task 6 (`--prefilled`, two driven logins, `logs/parity/s10_g9_prefill_gate`); Task 7 Step 1
(the rows, the numbering of R200/R201/R202, the story message); the owner's login (HUMAN_TASKS).
> Updated 2026-09-21 (the Task 6 agent): Task 6's harness half is in (`agent/g9t6`); what is left of it is
> Step 4's two logins on the rebuilt exe, the command and the expected lines in Task 6's result.
> Updated 2026-09-21 (the Task 6 follow-up agent): Task 6 is DONE -- `2bc56ec` (the thunk), `f47cfe0` (the
> buffer written before the open, never after: the handler unwinds through a scheduler checkpoint), three
> `LOBBY class=ok` logins including a first login with both keyboards (`s10_g9_prefill_fix4/5/6_newpersona`).
> ps2x_tests 732/732. Left: Task 2 Step 5's gate with the variables unset, Task 7 Step 1, the owner's login.

## Self-review against research/37

- Route B is Tasks 1-2; Route A is the stop rule's fallback, not built unless Task 1 fails.
- The launcher side research/37 describes (two fields, masked, in config.json, the ABOUT line, the caps) is
  Tasks 3-4; the harness win is Task 6; the persona-key hazard from KNOWN is Task 7's row.
- Type consistency: `Config::loginName` / `loginPassword` (Task 3) are what Task 4 draws and Task 5 blanks;
  `socom2_osk::prefillFor` (Task 2) is the only place the cap is applied on the runtime side and
  `normalizeLoginName` (Task 3) the only place on the launcher side; both take the cap from research/38.
- Unknowns are confined to Task 1's table (`kOskOpenAddr`, the register order, the two caps, the field ids)
  and every later task names them by those names.
