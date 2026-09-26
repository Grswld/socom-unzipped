#include "launcher/launcher_config.h"
#include "ps2x/exit_codes.h"

#include "json_reader.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>

// config.json is a flat object of strings, numbers and booleans; a hand-rolled reader/writer covers it (no
// dependency for the launcher). Unknown keys are ignored, missing keys keep their defaults.
namespace launcher
{
    namespace
    {
        std::string quote(const std::string &s)
        {
            std::string out = "\"";
            for (char c : s)
            {
                switch (c)
                {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default: out.push_back(c); break;
                }
            }
            out.push_back('"');
            return out;
        }

        using Parser = detail::JsonReader;   // Sprint 10 Goal 8: the reader moved to json_reader.h, shared with mapping.cpp
    }

    const ServerPreset *findServerPreset(const std::string &id)
    {
        for (const ServerPreset &p : kServerPresets)
            if (id == p.id)
                return &p;
        return nullptr;
    }

    // ---- Task 11: the revisions -----------------------------------------------------------------------

    std::string discRevisionForDigest(const std::string &digest)
    {
        if (digest.empty())
            return {};   // nothing was hashed: not a revision, and certainly not the pinned one
        for (const DiscRevision &r : kDiscRevisions)
            if (digest == r.sha256)
                return r.revision;
        return {};
    }

    size_t gameRevisionIndex(const std::string &id)
    {
        for (size_t i = 0; i < kGameRevisionCount; ++i)
            if (id == kGameRevisions[i].id)
                return i;
        return kGameRevisionCount;
    }

    const GameRevision *findGameRevision(const std::string &id)
    {
        const size_t i = gameRevisionIndex(id);
        return i < kGameRevisionCount ? &kGameRevisions[i] : nullptr;
    }

    std::string normalizeGameRevision(const std::string &value)
    {
        return findGameRevision(value) != nullptr ? value : std::string(kGameRevisions[0].id);
    }

    GameFiles gameFilesFor(const std::string &gameRevision, const std::string &defaultExe)
    {
        const GameRevision *rev = findGameRevision(normalizeGameRevision(gameRevision));
        if (rev == nullptr)
            rev = &kGameRevisions[0];   // unreachable while normalize answers a row's id; kept so it cannot crash
        return {rev->exeName[0] == '\0' ? defaultExe : std::string(rev->exeName), std::string(rev->elfName)};
    }

    bool gameRevisionAvailable(size_t index, uint32_t installed)
    {
        if (index >= kGameRevisionCount)
            return false;   // not a row of ours: nothing to start
        // A row that names no executable IS this build: it is there whenever the launcher is. Every other
        // row is gated by ITS OWN bit -- another row's presence says nothing about this one.
        return kGameRevisions[index].exeName[0] == '\0' || (installed & (1u << index)) != 0u;
    }

    std::string revisionWarning(const std::string &presetId, const std::string &gameRevision)
    {
        const ServerPreset *preset = findServerPreset(presetId);
        if (preset == nullptr || findGameRevision(gameRevision) == nullptr)
            return {};   // not a server of ours, or not a version of ours: say nothing rather than guess
        if (preset->requiresRevision[0] == '\0')
            return {};   // a preset whose revision is UNKNOWN (Custom): the same rule, for the same reason
        for (const RevisionMismatch &m : kRevisionWarnings)
            if (gameRevision == m.buildRevision && std::string(preset->requiresRevision) == m.serverRevision)
                return m.warning;
        return {};
    }

    bool presetAvailable(const ServerPreset &preset)
    {
        if (preset.address[0] == '\0')
            return true;   // Custom: the player types the address
        return std::string(preset.address).find("_TBC") == std::string::npos;
    }

    namespace
    {
        // The preset a config falls back to when the one it names cannot be played.
        const ServerPreset &playableFallback()
        {
            for (const ServerPreset &p : kServerPresets)
                if (p.address[0] != '\0' && presetAvailable(p))
                    return p;
            return kServerPresets[0];
        }
    }

    std::string effectiveServer(const Config &c)
    {
        const ServerPreset *preset = findServerPreset(c.serverPreset);
        // A preset whose server does not exist yet must never reach the game: a config that still names one
        // (the owner's did) plays on the project's own server instead of on a placeholder string.
        if (preset && !presetAvailable(*preset))
            preset = &playableFallback();
        if (preset && preset->address[0] != '\0')
            return preset->address;
        return c.server.empty() ? std::string("127.0.0.1") : c.server;
    }

    std::string toJson(const Config &c)
    {
        std::string out = "{\n";
        out += "  \"isoPath\": " + quote(c.isoPath) + ",\n";
        out += "  \"gsScale\": " + std::to_string(c.gsScale) + ",\n";
        out += "  \"presentFilter\": " + quote(c.presentFilter) + ",\n";
        out += "  \"windowSize\": " + quote(c.windowSize) + ",\n";
        out += std::string("  \"fpsOverlay\": ") + (c.fpsOverlay ? "true" : "false") + ",\n";
        out += "  \"audioVolume\": " + std::to_string(c.audioVolume) + ",\n";
        out += "  \"gamepadIndex\": " + std::to_string(c.gamepadIndex) + ",\n";
        char dz[32];
        std::snprintf(dz, sizeof(dz), "%g", c.padDeadZone);
        out += std::string("  \"padDeadZone\": ") + dz + ",\n";
        out += "  \"crouchShortcut\": " + quote(normalizeCrouchShortcut(c.crouchShortcut)) + ",\n";
        out += "  \"focusToggle\": " + quote(normalizeFocusToggle(c.focusToggle)) + ",\n";   // Sprint 10 Q4
        out += std::string("  \"menuSounds\": ") + (c.menuSounds ? "true" : "false") + ",\n";
        out += "  \"micDevice\": " + quote(c.micDevice) + ",\n";
        out += "  \"gameRevision\": " + quote(normalizeGameRevision(c.gameRevision)) + ",\n";   // Task 11
        out += "  \"serverPreset\": " + quote(c.serverPreset) + ",\n";
        out += "  \"server\": " + quote(c.server) + ",\n";
        out += "  \"profile\": " + quote(c.profile) + ",\n";
        // Sprint 10 Goal 9, R179: the password is written plain -- this is the player's own file; the
        // diagnostics zip's copy of it blanks the field (diagnostics::sanitizedConfigJson).
        out += "  \"loginName\": " + quote(c.loginName) + ",\n";
        out += "  \"loginPassword\": " + quote(c.loginPassword) + ",\n";
        out += std::string("  \"secondInstance\": ") + (c.secondInstance ? "true" : "false") + ",\n";
        // Sprint 10 Goal 8 (R174): the input mappings, one block per profile that has one -- a stranger can read
        // what their pad does, and an older build skips the block as an unknown key. A profile at the defaults
        // is not written: the file says what was changed, not what was not.
        out += "  \"mappings\": {";
        bool first = true;
        for (const ProfileMapping &pm : c.mappings)
        {
            if (mapping::isDefault(pm.mapping) || normalizeProfile(pm.profile) != pm.profile)
                continue;
            out += first ? "\n" : ",\n";
            out += "    " + quote(pm.profile) + ": " + mapping::toJson(pm.mapping, "    ");
            first = false;
        }
        out += first ? "}\n" : "\n  }\n";
        out += "}\n";
        return out;
    }

    std::string monitorSizeOrEmpty(int width, int height)
    {
        if (width <= 0 || height <= 0)
            return std::string();   // raylib has no monitor yet: store nothing rather than "0x0"
        return std::to_string(width) + "x" + std::to_string(height);
    }

    namespace
    {
        // "<w>x<h>" with a zero (or negative, or unreadable) dimension is not a window size, whoever wrote it:
        // an older build's "Match display", a hand-edited config.json. Anything that is not of that shape at all
        // ("fullscreen") is left to the runtime's own parser.
        bool isUsableWindowSize(const std::string &value)
        {
            const size_t x = value.find_first_of("xX");
            if (x == std::string::npos)
                return true;
            const std::string w = value.substr(0, x);
            const std::string h = value.substr(x + 1);
            if (w.empty() || h.empty())
                return true;
            return std::atoi(w.c_str()) > 0 && std::atoi(h.c_str()) > 0;
        }
    }

    bool fromJson(const std::string &json, Config &out)
    {
        out = Config{};   // malformed input leaves the defaults
        Config c;
        bool sawServer = false, sawPreset = false;   // a pre-picker config: a typed server and no preset
        Parser p(json);
        if (!p.take('{'))
            return false;
        if (!p.take('}'))
        {
            for (;;)
            {
                std::string key;
                if (!p.string(key) || !p.take(':'))
                    return false;
                if (key == "isoPath" || key == "presentFilter" || key == "windowSize" || key == "server" || key == "serverPreset" || key == "profile" || key == "micDevice" || key == "crouchShortcut" || key == "focusToggle" || key == "gameRevision" || key == "loginName" || key == "loginPassword")
                {
                    std::string v;
                    if (!p.string(v))
                        return false;
                    if (key == "isoPath") c.isoPath = v;
                    else if (key == "presentFilter") c.presentFilter = v;
                    else if (key == "crouchShortcut") c.crouchShortcut = normalizeCrouchShortcut(v);
                    else if (key == "focusToggle") c.focusToggle = normalizeFocusToggle(v);
                    // Task 11: normalised on the way in, like the two above -- an id from a newer build, or
                    // a hand-edited one, must not leave the selector with a version it cannot draw.
                    else if (key == "gameRevision") c.gameRevision = normalizeGameRevision(v);
                    // Review finding F5: a stored 0x0 (or any zero dimension) keeps the default instead.
                    else if (key == "windowSize") { if (isUsableWindowSize(v)) c.windowSize = v; }
                    else if (key == "server") { c.server = v; sawServer = true; }
                    // a preset we do not know (an older or newer build's) falls back to the typed address
                    else if (key == "serverPreset")
                    {
                        // An unknown id means an older or hand-edited file: keep the typed address. A KNOWN
                        // but unplayable one heals to the server that exists, so the picker opens on it.
                        // A retired id (a preset a shipped build wrote and this one no longer offers) is
                        // read as the preset it meant, so a player keeps their server across the change.
                        for (const RetiredPreset &r : kRetiredPresets)
                            if (v == r.id)
                                v = r.now;
                        const ServerPreset *saved = findServerPreset(v);
                        c.serverPreset = saved == nullptr ? std::string("custom")
                                                          : (presetAvailable(*saved) ? v : std::string(playableFallback().id));
                        sawPreset = true;
                    }
                    else if (key == "micDevice") c.micDevice = v;
                    // Normalised on the way IN (the 2026-09-22 audit): a config.json written by hand, or by a
                    // launcher from before the field refused these characters, must not leave a value in the
                    // field that differs from what the game will be handed.
                    else if (key == "loginName") c.loginName = normalizeLoginName(v);
                    else if (key == "loginPassword") c.loginPassword = normalizeLoginPassword(v);
                    else c.profile = normalizeProfile(v);
                }
                // Sprint 10 Q3 (R210): "mouseLook" and "mouseSensitivity", written by every launcher before 2026-09-21,
                // are no longer keys of ours; they fall through to the unknown-key skip below like any other.
                else if (key == "gsScale" || key == "secondInstance" || key == "gamepadIndex" || key == "padDeadZone" || key == "fpsOverlay" || key == "audioVolume" || key == "menuSounds")
                {
                    std::string raw;
                    if (!p.scalar(raw))
                        return false;
                    if (key == "gsScale") c.gsScale = std::atoi(raw.c_str());
                    else if (key == "fpsOverlay") c.fpsOverlay = raw == "true";
                    else if (key == "audioVolume") c.audioVolume = std::atoi(raw.c_str());
                    else if (key == "gamepadIndex") c.gamepadIndex = std::atoi(raw.c_str());
                    else if (key == "padDeadZone") c.padDeadZone = std::atof(raw.c_str());
                    else if (key == "menuSounds") c.menuSounds = raw == "true";
                    else c.secondInstance = raw == "true";
                }
                else if (key == "mappings")
                {
                    // Sprint 10 Goal 8: {"<profile>": {mapping block}, ...}. Each block's own text goes to its own
                    // reader. A value that is not JSON is a malformed file like any other; one that is JSON but
                    // not a mapping is that profile at the defaults, and the rest of the file is kept
                    // (mapping::fromJson leaves its `out` at the defaults on false). A "mappings" that is not an
                    // object at all is skipped whole: nobody has a mapping, the file is otherwise read.
                    if (p.peek() != '{')
                    {
                        if (!p.skipValue())
                            return false;
                    }
                    else
                    {
                        p.take('{');
                        if (!p.take('}'))
                        {
                            for (;;)
                            {
                                std::string profile, block;
                                if (!p.string(profile) || !p.take(':') || !p.rawValue(block))
                                    return false;
                                ProfileMapping pm;
                                pm.profile = normalizeProfile(profile);
                                mapping::fromJson(block, pm.mapping);
                                if (pm.profile == profile && !mapping::isDefault(pm.mapping))
                                    c.mappings.push_back(pm);
                                if (p.take(','))
                                    continue;
                                if (!p.take('}'))
                                    return false;
                                break;
                            }
                        }
                    }
                }
                else if (!p.skipValue())
                    return false;
                if (p.take(','))
                    continue;
                if (!p.take('}'))
                    return false;
                break;
            }
        }
        // Sprint 8 Goal 12: the default preset became the hosted server. A config written before the picker existed
        // carries the player's own address and no preset; it stays theirs instead of silently moving to ours.
        if (sawServer && !sawPreset)
            c.serverPreset = "custom";
        out = c;
        return true;
    }

    std::string exitMessage(int exitCode)
    {
        // Sprint 9 Goal 1: the sentence lives in the one table the runner also reads (ps2x/exit_codes.h).
        return ExitCodes::describe(exitCode);
    }

    std::string lastRunLine(long long rawExitStatus, const std::string &logText)
    {
        std::string line = ExitCodes::describe(rawExitStatus);
        for (const std::string &notice : ExitCodes::noticesIn(logText))
            line += " " + notice;
        return line;
    }

    std::vector<std::string> selftestExitLines()
    {
        std::vector<std::string> lines;
        for (const ExitCodes::Entry &e : ExitCodes::kTable)
        {
            char head[64];
            std::snprintf(head, sizeof(head), "exit %3d %s: ", e.code, e.slug);
            lines.push_back(std::string(head) + e.sentence);
        }
        return lines;
    }


    bool isKnobKey(const std::string &key)
    {
        static const char kPrefix[] = "PS2X_";
        if (key.size() < sizeof(kPrefix) - 1)
            return false;
        for (size_t i = 0; i + 1 < sizeof(kPrefix); ++i)
        {
            char c = key[i];
            if (c >= 'a' && c <= 'z')
                c = static_cast<char>(c - 'a' + 'A');
            if (c != kPrefix[i])
                return false;
        }
        return true;
    }

    std::vector<std::string> mergeEnvironment(const char *const *base, const std::vector<std::string> &ours, bool keepInheritedKnobs)
    {
        // Ours, minus anything that is not a KEY=VALUE pair: execve would carry a bare "D" into the child's
        // environ, where nothing can read it back.
        std::vector<std::string> mine;
        mine.reserve(ours.size());
        for (const std::string &o : ours)
            if (o.find('=') != std::string::npos)
                mine.push_back(o);

        std::vector<std::string> merged;
        for (const char *const *p = base; p != nullptr && *p != nullptr; ++p)
        {
            const std::string s(*p);
            const size_t eq = s.find('=');
            const std::string key = eq == std::string::npos ? s : s.substr(0, eq);
            // Windows hands out "=C:=C:\path" per-drive cwd entries; an empty key is not a variable either.
            if (key.empty() || key[0] == '=')
                continue;
            bool overridden = false;
            for (const std::string &o : mine)
                if (o.rfind(key + "=", 0) == 0)
                    overridden = true;
            // R156: an inherited PS2X_* the launcher did not choose stays behind unless this is a developer's launcher.
            if (!overridden && (keepInheritedKnobs || !isKnobKey(key)))
                merged.push_back(s);
        }
        for (const std::string &o : mine)
            merged.push_back(o);
        return merged;
    }

    mapping::Mapping activeMapping(const Config &c)
    {
        const std::string profile = normalizeProfile(c.profile);
        for (const ProfileMapping &pm : c.mappings)
            if (pm.profile == profile)
                return pm.mapping;
        return mapping::defaults();
    }

    void setActiveMapping(Config &c, const mapping::Mapping &m)
    {
        const std::string profile = normalizeProfile(c.profile);
        for (size_t i = 0; i < c.mappings.size(); ++i)
        {
            if (c.mappings[i].profile != profile)
                continue;
            if (mapping::isDefault(m))
                c.mappings.erase(c.mappings.begin() + static_cast<std::ptrdiff_t>(i));
            else
                c.mappings[i].mapping = m;
            return;
        }
        if (!mapping::isDefault(m))
            c.mappings.push_back(ProfileMapping{profile, m});
    }

    std::string normalizeCrouchShortcut(const std::string &value)
    {
        for (const char *known : kCrouchShortcuts)
            if (value == known)
                return known;
        return "off";
    }

    std::string normalizeFocusToggle(const std::string &value)
    {
        if (value == "none")
            return value;
        // hostButtonFromName answers 0 (kHostNone) for "none" and -1 for a name it does not know; "none" is
        // taken above, so a bound button and "off" are both kept and only nonsense becomes the default.
        return mapping::hostButtonFromName(value) > mapping::kHostNone ? value : std::string("guide");
    }

    int focusToggleHost(const Config &config)
    {
        const std::string name = normalizeFocusToggle(config.focusToggle);
        return name == "none" ? mapping::kHostNone : mapping::hostButtonFromName(name);
    }

    std::string normalizeProfile(const std::string &value)
    {
        // A name, not a path. Anything with a separator, a colon, a control character or any other punctuation
        // is refused WHOLE -- no stripping, no collapsing -- because a half-cleaned path is the one that gets
        // walked around. "." and ".." are refused for the same reason even though their characters are allowed.
        if (value.empty() || value == "." || value == "..")
            return "player";
        for (const char c : value)
        {
            const unsigned char u = static_cast<unsigned char>(c);
            const bool ok = (u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z') || (u >= '0' && u <= '9') ||
                            c == ' ' || c == '_' || c == '-' || c == '.';
            if (!ok)
                return "player";
        }
        return value.size() > 64 ? value.substr(0, 64) : value;
    }

    bool keyboardAccepts(const char ch, const bool allowDoubleQuote)
    {
        const unsigned char u = static_cast<unsigned char>(ch);
        return u > 0x20 && u < 0x7F && (allowDoubleQuote || ch != '"');
    }

    namespace
    {
        // Sprint 10 Goal 9: what the game's keyboard can type. Printable ASCII, no space; the double quote only
        // where the keyboard offers it (the name keyboard's NoDQuote flag refuses it, research/38). Anything
        // else -- a space, an accent, a control character -- is dropped, not refused whole: a name is not a path.
        // The accept-set lives in keyboardAccepts and the launcher's field applies the same predicate as the
        // player types, so this pass is a backstop for a config.json written by hand or by an older launcher,
        // not the place a space is silently lost (the 2026-09-22 audit's finding 1).
        std::string keyboardText(const std::string &value, std::size_t cap, bool allowDoubleQuote)
        {
            std::string out;
            for (const char ch : value)
            {
                if (!keyboardAccepts(ch, allowDoubleQuote))
                    continue;
                out.push_back(ch);
                if (out.size() == cap)
                    break;
            }
            return out;
        }
    }

    std::string normalizeLoginName(const std::string &value)
    {
        return keyboardText(value, kLoginNameCap, false);
    }

    std::string normalizeLoginPassword(const std::string &value)
    {
        return keyboardText(value, kLoginPasswordCap, true);
    }

    const char *crouchShortcutLabel(const std::string &value)
    {
        const std::string v = normalizeCrouchShortcut(value);
        if (v == "l3")
            return "L-STICK CLICK";
        if (v == "touchpad")
            return "TOUCHPAD";
        if (v == "l2")
            return "L2";
        return "OFF";
    }

    const char *crouchShortcutHint(const std::string &value)
    {
        const std::string v = normalizeCrouchShortcut(value);
        if (v == "l3")
            return "Left stick click crouches (the community's Xbox layout). Fire mode moves to the keyboard's 2 key.";
        if (v == "touchpad")
            return "Touchpad click crouches (DualShock 4 / DualSense, Windows). Nothing else changes.";
        if (v == "l2")
            return "L2 crouches. The second weapon swap moves to the keyboard's 1 key.";
        return "Crouch is a LIGHT press of Triangle, which a PC pad cannot make: Y only goes prone. Pick a control.";
    }

    std::vector<std::string> environmentFor(const Config &c)
    {
        std::vector<std::string> env;
        env.push_back("PS2X_SOCOM2_PAD=1");
        // The runtime mounts the disc from PS2X_CD_IMAGE (game_overrides_socom2.cpp,
        // configureCdImage); without it the verified ISO is ignored and the runtime falls
        // back to hunting for any .iso next to the ELF.
        if (!c.isoPath.empty())
            env.push_back("PS2X_CD_IMAGE=" + c.isoPath);
        env.push_back("PS2X_GS_SCALE=" + std::to_string(c.gsScale < 1 ? 1 : c.gsScale));
        env.push_back("PS2X_PRESENT_FILTER=" + (c.presentFilter.empty() ? std::string("linear") : c.presentFilter));
        const int volume = c.audioVolume < 0 ? 0 : (c.audioVolume > 100 ? 100 : c.audioVolume);
        env.push_back("PS2X_AUDIO_VOLUME=" + std::to_string(volume));
        const bool sizeUsable = !c.windowSize.empty() && isUsableWindowSize(c.windowSize);
        env.push_back("PS2X_WINDOW_SIZE=" + (sizeUsable ? c.windowSize : Config{}.windowSize));
        if (c.fpsOverlay)
            env.push_back("PS2X_FPS_OVERLAY=1");
        env.push_back("PS2X_SOCOM2_SERVER=" + effectiveServer(c));
        const std::string profile = normalizeProfile(c.profile);
        env.push_back("PS2X_MC_DIR=cards/" + profile + (c.secondInstance ? "_b" : ""));
        // Sprint 10 Goal 9: only when typed -- unset means the keyboards open empty, as before the option -- and
        // as the keyboard could have typed it (normalizeLogin*), so the game is never handed a string its
        // buffer cannot hold.
        const std::string loginName = normalizeLoginName(c.loginName);
        if (!loginName.empty())
            env.push_back("PS2X_SOCOM2_LOGIN_NAME=" + loginName);
        const std::string loginPassword = normalizeLoginPassword(c.loginPassword);
        if (!loginPassword.empty())
            env.push_back("PS2X_SOCOM2_LOGIN_PASS=" + loginPassword);
        // Sprint 7 Task 8: the pad the player picked (only when they picked one -- unset means the runtime's
        // own "first available" rule), and the dead zone, always, so what they tuned is what the game gets.
        if (c.gamepadIndex >= 0)
            env.push_back("PS2X_HOST_GAMEPAD_INDEX=" + std::to_string(c.gamepadIndex));
        char dz[32];
        std::snprintf(dz, sizeof(dz), "%g", c.padDeadZone < 0.0 ? 0.0 : (c.padDeadZone > 0.5 ? 0.5 : c.padDeadZone));
        env.push_back(std::string("PS2X_PAD_DEADZONE=") + dz);
        // R139: only when a shortcut is on -- "off" sends nothing, so the default environment is what it was.
        const std::string crouch = normalizeCrouchShortcut(c.crouchShortcut);
        if (crouch != "off")
            env.push_back("PS2X_PAD_CROUCH_SHORTCUT=" + crouch);
        // Sprint 10 Goal 8 (R174): the profile's input mapping, only when it is not the default -- the default
        // environment is byte for byte what it was, and the runtime's defaults ARE this table (launcher/mapping.h).
        const mapping::Mapping active = activeMapping(c);
        if (!mapping::isDefault(active))
            env.push_back("PS2X_INPUT_MAPPING=" + mapping::toEnv(active));
        // Sprint 7 Task 9: only when the player picked one -- unset means the runtime opens no capture device.
        if (!c.micDevice.empty())
            env.push_back("PS2X_MIC_DEVICE=" + c.micDevice);
        // Sprint 10 Q3 (R210): no PS2X_SOCOM2_MOUSE / _SENS any more -- the mouse left the launcher and the runtime.
        if (c.secondInstance)
        {
            env.push_back("PS2X_SOCOM2_UDP_SHIFT=2");
            env.push_back("PS2X_SOCOM2_RSA_KEY=b");
        }
        return env;
    }
}
