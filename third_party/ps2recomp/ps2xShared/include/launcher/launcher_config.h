#pragma once
// config.json next to the launcher, and the PS2X_* environment it becomes (Task 8b, packaging outline section 3).
#include "launcher/mapping.h"   // Sprint 10 Goal 8 (R174): the input mapping, a field of Config

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace launcher::personas
{
    struct Persona;   // launcher/personas.h: the ledger's records beside the cards (Sprint 16 L1b)
}

namespace launcher
{
    // The r0001 NTSC disc's SCUS_972.75, as hashed out of the image (and the loose file) on 2026-09-17.
    constexpr const char *kSocom2R0001ElfSha256 = "0172dc0bec19c83d1fe2d0fec0a290f41cc5d32efa14ed6859ca92773c05346c";
    constexpr const char *kSocom2ElfName = "SCUS_972.75";

    // Task 11 (Sprint 11 Goal D): the discs this launcher can NAME. One row today -- and the row is the
    // point. SOCOM II shipped in more than one revision, the community server runs r0004, and the disc
    // check used to answer a bool against a single pinned digest; a second disc was therefore a second
    // branch through checkDisc rather than a line of data. An image whose digest is in no row is refused
    // exactly as it always was, with the sentence exit 67 (ExitCodes::kDiscNotR0001) has always carried.
    struct DiscRevision
    {
        const char *sha256;
        const char *revision;
    };
    constexpr DiscRevision kDiscRevisions[] = {
        {kSocom2R0001ElfSha256, "r0001"},
    };
    constexpr size_t kDiscRevisionCount = sizeof(kDiscRevisions) / sizeof(kDiscRevisions[0]);
    // The revision that digest names, or "" for a digest in no row (and for an empty one).
    std::string discRevisionForDigest(const std::string &digest);

    // Task 11: the game code the launcher can start. r0001 is the recompilation of the player's own disc
    // and is always there -- it IS this build -- so it names no executable. r0004 is the revision the
    // community server runs: a whole second code package, a second recompilation, and therefore a second
    // executable beside this one. `exeName` empty means "this build", which is what makes the missing-file
    // question a table lookup instead of a special case for index 1.
    struct GameRevision
    {
        const char *id;
        const char *label;
        const char *exeName;   // "" = this launcher's own game; otherwise a file beside the launcher
        // Issue #69: the program image that executable is started with, beside the launcher. Never empty: every
        // row's ELF has a name (build_revision.sh packages r0004's as socom2_game_<rev>.elf).
        const char *elfName;
    };
    constexpr GameRevision kGameRevisions[] = {
        {"r0001", "r0001 (your disc)",         "",                 "socom2_game.elf"},
        {"r0004", "r0004 (community update)",  "socom2_r0004.exe", "socom2_game_r0004.elf"},
    };
    constexpr size_t kGameRevisionCount = sizeof(kGameRevisions) / sizeof(kGameRevisions[0]);
    static_assert(kGameRevisionCount <= 32, "the installed-revision mask is a uint32_t: one bit per table row");
    // What the greyed cell says when the build it names is not installed. The ONLINE page already drew this
    // sentence on the community preset's row; it is one string now, so the two places cannot drift apart.
    constexpr const char *kRevisionMissingNote = "needs the r0004 game update -- planned";

    const GameRevision *findGameRevision(const std::string &id);
    // The ROW `id` names, or kGameRevisionCount when it is not one of ours.
    size_t gameRevisionIndex(const std::string &id);
    // One of kGameRevisions' ids; anything else (a typo, a value from a newer build, empty) is "r0001".
    std::string normalizeGameRevision(const std::string &value);
    // Can the version in row `index` actually be started? `installed` is a bitmask over kGameRevisions --
    // bit i set when row i's own executable was found beside the launcher. Asked of the world ONCE, by
    // main.cpp, and handed down: a page never touches the disk.
    //
    // A MASK, not a bool: this took a single `present` until the Sprint 11 review, which is the one place
    // the task's own rule ("a revision is a row, not a branch") was still a branch -- main.cpp probed for
    // kGameRevisions[1] by name, and every executable-bearing row was then reported installed whenever
    // that one was. Each row is now gated by its own bit and by no other's, so a third row needs no code.
    bool gameRevisionAvailable(size_t index, uint32_t installed);

    // Issue #69: the two files `startGame` spawns for `gameRevision`, relative to the launcher's folder. Until
    // this, both glues named socom2.exe + socom2_game.elf outright, so picking r0004 ran r0001. `defaultExe`
    // is the platform's own name for "this build" ("socom2.exe" on Windows, "socom2" on POSIX) -- the row
    // whose exeName is "" -- and an unknown id (a typo, empty) is r0001, as normalizeGameRevision says.
    struct GameFiles
    {
        std::string exe;
        std::string elf;
    };
    GameFiles gameFilesFor(const std::string &gameRevision, const std::string &defaultExe);
    // The row whose elfName is `elfName` (a bare file name, compared ignoring ASCII case), or nullptr. The
    // runner's "this is SOCOM II" question (its disc preflight) asks this, not one literal name (issue #69).
    const GameRevision *gameRevisionForElfName(const std::string &elfName);

    struct ServerPreset
    {
        const char *id;
        const char *label;
        const char *address;
        const char *note;
        // Task 11: the game revision that server runs, or "" for UNKNOWN -- say nothing. Only the two
        // named servers have a revision we can state; a custom address is any server on earth, and the
        // launcher guessing one is how it comes to contradict the player (see kServerPresets below).
        const char *requiresRevision;
    };

    // The servers a player can pick. Ours is hosted (AWS Lightsail, us-east-2, a static address; Sprint 8 Goal 12). The
    // community server is PSRewired (67.222.156.250), which runs SOCOM II r0004 -- a different code package from the r0001
    // this client is built from -- so its preset keeps a placeholder until an r0004 build exists (a wishlist item).
    //
    // Sprint 9 P6 (R175): the project's server is reached BY NAME. Switching this string cannot orphan a
    // persona, because it never reaches the game -- loadHosts() resolves it to a uint32 and maps the seven
    // retail Sony hostnames to that (ps2xRuntime/src/lib/socom2_hostnet.cpp:303-316). What it does
    // introduce is a name that might not resolve, and parseServerAddress answering 0 leaves the runtime
    // pointing at 127.0.0.1 with nothing on screen to say so. P6 kept the raw address on offer as a fourth
    // preset for that case; the owner had it removed on 2026-09-20 ("just remove the by address line for
    // now") -- a player whose network will not resolve the name types 3.143.65.100 under Custom, and a
    // config that still names "unzipped-ip" heals to "unzipped" (kRetiredPresets). The ids are the stable
    // thing: an old config naming "unzipped" keeps working and simply starts reaching the box by name.
    constexpr ServerPreset kServerPresets[] = {
        {"community",   "SOCOM Community (public Horizon)", "COMMUNITY_SERVER_ADDRESS_TBC", "the public community server",          "r0004"},
        {"unzipped",    "SOCOM Unzipped (project server)",  "socom.scotho.com",             "the project's hosted server (US East)", "r0001"},
        {"custom",      "Custom",                            "",                             "any address or hostname",              ""},
    };
    // Custom's revision is EMPTY, not "r0001". The Task 11 brief said r0001 and the Sprint 11 review
    // overruled it, rightly: a typed address is any server there is -- including PSRewired, which is
    // exactly how a player reaches r0004 before the community preset has an address of its own. Telling
    // them "the r0001 servers run r0001" would be the launcher contradicting the one route that works.
    // The two named presets are the only servers whose revision this project can state.
    // Ids a shipped build once wrote and this one no longer offers, each with the preset it means today.
    // fromJson reads through this before findServerPreset, so retiring a preset never costs a player their
    // server. `unzipped-ip` was the same box by its raw address (Sprint 9 P6; removed 2026-09-20).
    struct RetiredPreset
    {
        const char *id;
        const char *now;
    };
    constexpr RetiredPreset kRetiredPresets[] = {
        {"unzipped-ip", "unzipped"},
    };
    constexpr size_t kRetiredPresetCount = sizeof(kRetiredPresets) / sizeof(kRetiredPresets[0]);
    // Nothing may count these in a literal: P6 made them four, and two loops and one y-offset said three.
    constexpr size_t kServerPresetCount = sizeof(kServerPresets) / sizeof(kServerPresets[0]);

    // Sprint 10 Goal 8: one profile's saved mapping (config.json's "mappings" block, keyed by profile name).
    struct ProfileMapping
    {
        std::string profile;
        mapping::Mapping mapping;
        bool operator==(const ProfileMapping &) const = default;
    };

    struct Config
    {
        std::string isoPath;
        int gsScale = 1;                       // 1 native, 2 sharp, 3 sharper (experimental), 4 sharpest
        std::string presentFilter = "linear";  // linear | integer | point
        // The launcher opens at the game's own 640x448 (the owner, 2026-09-22 playthrough: "the default res
        // should be the 640x448"), which overrides Sprint 7 Task 1c's 2x default (R92). The runtime's default was
        // already 640x448 with PS2X_WINDOW_SIZE unset, so the launcher and the parity gate now agree; 1280x896
        // stays one click away on the VIDEO page.
        std::string windowSize = "640x448";    // <w>x<h> | fullscreen
        bool fpsOverlay = false;               // Sprint 7 Task 10: PS2X_FPS_OVERLAY, off unless asked for
        int audioVolume = 100;                 // Sprint 7 Task 11: PS2X_AUDIO_VOLUME, 0-100, 100 = unity
        // Sprint 10 Q3 (R210): mouseLook and mouseSensitivity left on 2026-09-21; an old config.json's keys are ignored on load.
        // Sprint 7 Task 8: which host pad to read (-1 = the first available one, as the runtime did before)
        // and the stick dead zone the three pad paths apply.
        int gamepadIndex = -1;
        double padDeadZone = 0.15;
        // Owner request 2026-09-19, R139: the host control that crouches -- "off" | "l3" | "touchpad" | "l2".
        // The default is "l3" (owner 2026-09-20: with no shortcut a pad cannot crouch at all). "off" is sent as PS2X_PAD_CROUCH_SHORTCUT=off (O12, 2026-09-27: an unset variable resolves to the registered l3, so off must be said).
        std::string crouchShortcut = "l3";   // owner 2026-09-20: without a shortcut a pad cannot crouch at all
        // Sprint 7 Task 9: the capture device by name; "" = none (no PS2X_MIC_DEVICE, no device opened).
        std::string micDevice;
        // Task 11: which game code to start -- an id out of kGameRevisions. A fresh config plays the disc's
        // own build, and so does a config naming a version whose executable is not installed (main.cpp
        // clamps it on load): the launcher must never be left pointing at a game that is not there.
        std::string gameRevision = "r0001";
        std::string serverPreset = "unzipped"; // an id out of kServerPresets; a fresh config plays on the project's hosted server (Sprint 8 Goal 12); "custom" means the address below
        std::string server = "127.0.0.1";
        std::string profile = "player";
        // Sprint 10 Goal 9: the persona the game logs in as and its password, typed once here and handed to
        // the game's keyboards already filled (PS2X_SOCOM2_LOGIN_NAME / _PASS; R179: stored plain in this
        // file, R180: prefilled, never submitted). Empty = nothing is sent and the keyboards open empty.
        std::string loginName;
        std::string loginPassword;
        bool secondInstance = false;
        // Sprint 10 Goal 8 (R174): what the pad's buttons and the keyboard's keys drive, SAVED PER PROFILE -- a
        // profile is one player's save and persona, and two people sharing a machine hold their pads
        // differently. A profile with no entry plays the defaults (the tables the runtime carried at compile
        // time until 2026-09-21); an old config.json with no block keeps them for everyone; and a default
        // mapping sends nothing to the game (launcher/mapping.h). activeMapping() reads the current profile's.
        std::vector<ProfileMapping> mappings;
        // Sprint 10 Q4 (owner 2026-09-20: "pressing the XBOX or PLAYSTATION button should toggle the launcher
        // focus"): the host button that swaps the front window between the launcher and the running game. A
        // host button NAME as mapping.h spells them ("guide" by default; "none" switches it off), not a PS2
        // button: the game never sees this one. Launcher-only -- no environment variable carries it.
        std::string focusToggle = "guide";
        // Sprint 10 Q4: the launcher's own menu sounds -- the game's HUD cues, decoded from the player's disc
        // (launcher/menu_sounds.h). On by default and launcher-only: the game's mix is PS2X_AUDIO_VOLUME's.
        bool menuSounds = true;
    };

    // Q4: the switch's host button as mapping.h numbers them (kHostNone when off); the name normalised --
    // a known host name or "none" stays, anything else (a typo, a newer build's word) is "guide".
    std::string normalizeFocusToggle(const std::string &value);
    int focusToggleHost(const Config &config);

    // The mapping the current profile plays (the defaults when it has none), and the setter that keeps the
    // list clean: a profile set back to the defaults loses its entry rather than carrying a copy of them.
    mapping::Mapping activeMapping(const Config &config);
    void setActiveMapping(Config &config, const mapping::Mapping &m);

    // R139, the crouch shortcut (owner request 2026-09-19; runtime/host_crouch_shortcut.h has the mechanism).
    // SOCOM II's stance is TRIANGLE's pressure: a light press crouches, a firm one goes prone, and a PC pad's
    // digital Y / Triangle is always firm -- so on a PC pad crouch is unreachable, which is why the community binds
    // "Triangle, lightly" to a spare control. The ruling: the chosen host control sends that light Triangle INSTEAD
    // of its own PS2 button, never as well as it. "l3" therefore trades away fire mode on the pad and "l2" the
    // second weapon swap; both remain on the keyboard (2 and 1), which the runtime always reads, and the launcher
    // says so under the option. "touchpad" trades nothing: that control is unmapped today. The player's own
    // Triangle stays a firm press, so prone is always reachable. -- why: a plain rebind is what the convention is
    // on PCSX2, and one control doing two things at once is the surprise to avoid. -- cost if wrong: a player who
    // wanted fire mode moved somewhere else on the pad; the mapping is one table in host_crouch_shortcut.h.
    constexpr const char *kCrouchShortcuts[] = {"off", "l3", "touchpad", "l2"};
    constexpr int kCrouchShortcutCount = 4;
    // One of kCrouchShortcuts; anything else (a typo, a value from a newer build) is "off".
    std::string normalizeCrouchShortcut(const std::string &value);

    // The profile names a directory -- PS2X_MC_DIR is "cards/" + profile, and the runner resolves a relative
    // value under its own home -- so it must stay a NAME. Letters, digits, space, '_', '-' and '.' are kept and
    // the result is cut to 64; anything else (a separator, a drive letter, "." or ".." alone, empty) is refused
    // whole and becomes "player". Refused whole, not patched up: a config.json can be handed to a player by
    // someone else, and half-cleaning a path is how a cleaner gets walked around.
    std::string normalizeProfile(const std::string &value);

    // Sprint 10 Goal 9: the persona name and password as the game's own on-screen keyboard could have typed
    // them -- every printable ASCII character but the space (the keyboard has none), the double quote refused on
    // the name keyboard (its NoDQuote flag), and each cut to its keyboard's MaxChars (research/38: 14 and 12,
    // read off the login screen's two GetTextInput actions on the disc). The runtime re-applies the live cap
    // when it fills the keyboard, so nothing longer can reach the game's buffer either way. Empty stays empty.
    constexpr std::size_t kLoginNameCap = 14;
    constexpr std::size_t kLoginPasswordCap = 12;
    std::string normalizeLoginName(const std::string &value);
    std::string normalizeLoginPassword(const std::string &value);
    // The accept-set ABOVE, as a predicate, so the field that takes the characters and the normaliser that
    // sends them cannot disagree (the 2026-09-22 audit: the field took a space, config.json kept it, and the
    // game was handed the string without it -- the keyboard opened with the wrong text and the login failed
    // with nothing on screen to explain it). The field refuses what the keyboard cannot hold, which is what
    // makes "what the player sees in the field is exactly what the keyboard will hold" true.
    bool keyboardAccepts(char ch, bool allowDoubleQuote);
    // The cell's label and the one line under the row that states the trade. Never empty.
    const char *crouchShortcutLabel(const std::string &value);
    const char *crouchShortcutHint(const std::string &value);

    // Sprint 7 review finding F5: "Match display" resolved to TextFormat("%dx%d", GetMonitorWidth(...),
    // GetMonitorHeight(...)) in main.cpp, and raylib answers 0 for both before a monitor is known -- so a click
    // at the wrong moment stored "0x0" in config.json and the game opened at nothing at all. This is that
    // resolution as a pure function: "" when either dimension is not a usable size, so the caller keeps what it
    // had, and "<w>x<h>" otherwise.
    std::string monitorSizeOrEmpty(int width, int height);

    // Task 11: the two mismatch warnings, as DATA. Neither can fire in today's shipped build -- the
    // community preset is not playable and no r0004 executable exists -- which is exactly why they are
    // written now: the moment either half arrives, a player who has one without the other is told so in
    // the launcher, rather than by a login that fails with nothing on screen to explain it. The sentence
    // names both revisions, so a player can tell which half they are missing.
    struct RevisionMismatch
    {
        const char *serverRevision;   // what the chosen server runs
        const char *buildRevision;    // what the chosen GAME VERSION is
        const char *warning;
    };
    constexpr RevisionMismatch kRevisionWarnings[] = {
        {"r0004", "r0001", "the community server runs r0004; this is the r0001 build"},
        {"r0001", "r0004", "the r0001 servers run r0001; this is the r0004 build"},
    };
    constexpr size_t kRevisionWarningCount = sizeof(kRevisionWarnings) / sizeof(kRevisionWarnings[0]);
    // The warning for this pairing, or "" when the two agree -- and "" for a preset or a revision that is
    // not one of ours, because a launcher must not invent a sentence about a server it does not know.
    std::string revisionWarning(const std::string &presetId, const std::string &gameRevision);

    // Sprint 8 Goal 9 (fourth pass): can this preset actually be played? A preset carries a placeholder
    // address until its server exists -- the community one still does, because PSRewired runs game revision
    // r0004 and this client cannot play that yet. Custom is always available: the player types the address.
    bool presetAvailable(const ServerPreset &preset);

    // The preset with that id, or nullptr when the id is not one of ours.
    const ServerPreset *findServerPreset(const std::string &id);
    // Sprint 16 L1b (#73): the preset whose address this is (a persona record holds effectiveServer's address), or
    // nullptr -- Custom's empty address and a placeholder match nothing.
    const ServerPreset *findServerPresetByAddress(const std::string &address);
    // The address the game is actually pointed at: the preset's for community/unzipped, the typed one for custom
    // (127.0.0.1 when nothing is typed).
    std::string effectiveServer(const Config &config);

    // config.json <-> Config. Unknown keys are ignored; a missing key keeps the default. parse returns false on
    // malformed JSON (the config is then the defaults).
    std::string toJson(const Config &config);
    bool fromJson(const std::string &json, Config &out);
    // Sprint 16 L1b (#73, R295): the file as written beside the PERSONAS list -- "loginPassword" is written only while
    // the selected row's record is absent, false or on another server (personas::cardHoldsPassword), and is otherwise
    // the key kept and empty (the diagnostics copy's reader expects the key either way).
    std::string toJson(const Config &config, const std::vector<personas::Persona> &rows);

    // What the game's exit status means, in a sentence for the player: ExitCodes::describe (ps2x/exit_codes.h). Never empty.
    std::string exitMessage(int exitCode);

    // Sprint 9 Goal 1: the PLAY page's LAST RUN line. `rawExitStatus` is GameProcess::exitCode() as the
    // glue reports it (an NT status on Windows, 128 + signal on POSIX, else the runner's own code);
    // `logText` is the head of that run's log, read for "[notice] " lines (no audio device), whose
    // sentences follow the exit's own.
    std::string lastRunLine(long long rawExitStatus, const std::string &logText);

    // What --selftest prints: "exit <code> <slug>: <sentence>" for every row of ExitCodes::kTable.
    std::vector<std::string> selftestExitLines();


    // The environment socom2.exe is started with, as KEY=VALUE strings (PS2X_SOCOM2_PAD=1 always;
    // the second instance gets PS2X_SOCOM2_UDP_SHIFT=2, PS2X_SOCOM2_RSA_KEY=b and its own card directory).
    std::vector<std::string> environmentFor(const Config &config);
    // Sprint 16 L1b: the same, with no PS2X_SOCOM2_LOGIN_PASS for a row whose card holds the password.
    std::vector<std::string> environmentFor(const Config &config, const std::vector<personas::Persona> &rows);

    // Sprint 9 Goal 3 (R156): is this environment key one of ours? "PS2X_" as a prefix, either case (Windows
    // variable names are case-insensitive).
    bool isKnobKey(const std::string &key);
    // Sprint 8 Task 4: the child's environment, as both glues build it. `base` is a NULL-terminated KEY=VALUE
    // array (the Windows block widened, or POSIX `environ`); `ours` is environmentFor()'s knobs. Ours win by
    // key: an overridden base entry is dropped rather than duplicated, the rest of the base keeps its order,
    // and ours follow in theirs. Entries with no '=' are not environment entries and are skipped on both
    // sides (a bare key in `ours`, and Windows' "=C:"-style drive entries in `base`). Pure; both platforms.
    // With keepInheritedKnobs false an inherited PS2X_* variable the launcher did not itself choose is dropped,
    // so a stranger's forgotten variable cannot reach the game; the launcher passes true only when it was
    // itself started in developer mode (Sprint 9 Goal 3 Task 7, R156).
    std::vector<std::string> mergeEnvironment(const char *const *base, const std::vector<std::string> &ours, bool keepInheritedKnobs);
    inline std::vector<std::string> mergeEnvironment(const char *const *base, const std::vector<std::string> &ours)
    {
        return mergeEnvironment(base, ours, true);   // the pure merge, as the existing cases test it
    }
}
