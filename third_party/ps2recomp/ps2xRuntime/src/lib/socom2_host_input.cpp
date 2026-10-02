#include "socom2_host_input.h"

#include "raylib.h"
#include "runtime/host_crouch_shortcut.h"
#include "runtime/host_gamepad.h"
#include "runtime/host_gamepad_select.h"
#include "runtime/injected_pad_latch.h"
#include "ps2x/knobs.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <type_traits>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

// R139, "touchpad": raylib 5.5 reads pads through GLFW's gamepad mapping, which has no touchpad, so the click is
// read from GLFW's raw joystick buttons (raylib links GLFW on desktop and its joystick ids are raylib's pad slots).
#if !defined(PLATFORM_VITA) && !defined(PLATFORM_ANDROID) && !defined(__ANDROID__)
#define PS2X_HOST_INPUT_HAVE_GLFW_JOYSTICK 1
extern "C" const unsigned char *glfwGetJoystickButtons(int jid, int *count);
extern "C" const char *glfwGetJoystickGUID(int jid);
#endif

namespace ps2_stubs
{
    namespace
    {
        struct ScriptEvent
        {
            double at = 0.0;
            double hold = 0.25;
            uint16_t buttons = 0;          // bit n = button id n
            uint8_t axisValue[4] = {0x80u, 0x80u, 0x80u, 0x80u};
            bool axisSet[4] = {false, false, false, false};
            std::string text;
        };

        struct HostInputConfig
        {
            bool initialised = false;
            // Sprint 10 Goal 8 (R174): the button tables, resolved once from PS2X_INPUT_MAPPING (launcher/mapping.h).
            launcher::mapping::Mapping mapping = launcher::mapping::defaults();
            bool mappingResolved = false;
            bool mappingDefault = true;
            // Sprint 10 Q3 (R210): which half of the key table the game gets -- decided once, from developer mode.
            KeyboardScope keyboardScope = KeyboardScope::Menus;
            std::vector<ScriptEvent> script;
            std::vector<bool> fired;
            std::chrono::steady_clock::time_point start;
        };

        HostInputConfig g_config;

        // R139, "touchpad". Only a Sony pad, told by the vendor id in GLFW's SDL-style GUID (bytes 4-5, little
        // endian: 054c -> "4c05" at characters 8-11), and only raw button 13 -- the touchpad click of a DualShock 4
        // and of a DualSense through Windows' HID joystick driver. Anything else (another vendor's button 13, a
        // Linux driver that puts the touchpad on its own device and reports 13 buttons) reads as "not pressed".
        bool hostTouchpadDown(int padSlot)
        {
#if defined(PS2X_HOST_INPUT_HAVE_GLFW_JOYSTICK)
            const char *const guid = glfwGetJoystickGUID(padSlot);
            if (guid == nullptr || std::strlen(guid) < 12 || std::strncmp(guid + 8, "4c05", 4) != 0)
                return false;
            int count = 0;
            const unsigned char *const buttons = glfwGetJoystickButtons(padSlot, &count);
            return buttons != nullptr && count > 13 && buttons[13] != 0;
#else
            (void)padSlot;
            return false;
#endif
        }

        // PS2X_SOCOM2_INPUT_FILE sampler. The harness holds a press for ~0.09 s of wall clock, but
        // the poll below runs once per rendered frame, so under ~11 fps a whole press fell between
        // two polls and was never seen (ten driven launches, 2026-09-18). A thread samples the file
        // every 2 ms into a latch and the poll takes every button seen since the previous poll, so a
        // press is delivered late rather than dropped. No thread exists unless the variable is set.
        struct InjectedPadSampler
        {
            ps2x::InjectedPadLatch latch;
            std::thread worker;
            std::atomic<bool> stop{false};

            void start(const char *path)
            {
                if (worker.joinable())
                    return;
                stop.store(false, std::memory_order_relaxed);
                const std::string file(path);
                worker = std::thread([this, file]()
                {
                    while (!stop.load(std::memory_order_relaxed))
                    {
                        if (FILE *f = std::fopen(file.c_str(), "rb"))
                        {
                            char line[128] = {0};
                            const size_t n = std::fread(line, 1, sizeof(line) - 1, f);
                            std::fclose(f);
                            line[n] = '\0';
                            ps2x::InjectedPadSample sample;
                            if (ps2x::parseInjectedPadLine(line, sample))
                                latch.observe(sample);
                        }
                        std::this_thread::sleep_for(std::chrono::milliseconds(2));
                    }
                });
            }

            void shutdown()
            {
                stop.store(true, std::memory_order_relaxed);
                if (worker.joinable())
                    worker.join();
            }

            ~InjectedPadSampler() { shutdown(); }
        };

        InjectedPadSampler g_injectedPadSampler;

        int buttonIdFromName(const std::string &name)
        {
            static const char *const names[16] = {
                "SELECT", "L3", "R3", "START", "UP", "RIGHT", "DOWN", "LEFT",
                "L2", "R2", "L1", "R1", "TRIANGLE", "CIRCLE", "CROSS", "SQUARE"};
            for (int index = 0; index < 16; ++index)
            {
                if (name == names[index])
                {
                    return index;
                }
            }
            if (name == "X")
                return kPadCross;
            if (name == "O")
                return kPadCircle;
            return -1;
        }

        int axisIdFromName(const std::string &name)
        {
            if (name == "RX")
                return 0;
            if (name == "RY")
                return 1;
            if (name == "LX")
                return 2;
            if (name == "LY")
                return 3;
            return -1;
        }

        std::vector<std::string> split(const std::string &text, char separator)
        {
            std::vector<std::string> parts;
            std::string current;
            for (char c : text)
            {
                if (c == separator)
                {
                    parts.push_back(current);
                    current.clear();
                }
                else if (c != ' ')
                {
                    current.push_back(c);
                }
            }
            parts.push_back(current);
            return parts;
        }

        // "t:NAME[+NAME|AXIS=v...][:hold]" entries separated by ',' or ';'.
        void parseScript(const char *text)
        {
            std::string all(text);
            std::replace(all.begin(), all.end(), ';', ',');
            for (const std::string &entry : split(all, ','))
            {
                if (entry.empty())
                    continue;
                const std::vector<std::string> fields = split(entry, ':');
                if (fields.size() < 2)
                {
                    std::cout << "[socom2-input] script: ignoring '" << entry << "'" << std::endl;
                    continue;
                }
                ScriptEvent event;
                event.at = std::atof(fields[0].c_str());
                if (fields.size() >= 3)
                    event.hold = std::atof(fields[2].c_str());
                event.text = fields[1];
                for (const std::string &name : split(fields[1], '+'))
                {
                    const size_t eq = name.find('=');
                    if (eq != std::string::npos)
                    {
                        const int axis = axisIdFromName(name.substr(0, eq));
                        if (axis >= 0)
                        {
                            event.axisSet[axis] = true;
                            event.axisValue[axis] = static_cast<uint8_t>(std::clamp(std::atoi(name.substr(eq + 1).c_str()), 0, 255));
                        }
                        continue;
                    }
                    std::string upper = name;
                    std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
                    const int id = buttonIdFromName(upper);
                    if (id >= 0)
                        event.buttons |= static_cast<uint16_t>(1u << id);
                    else
                        std::cout << "[socom2-input] script: unknown button '" << name << "'" << std::endl;
                }
                g_config.script.push_back(event);
            }
            g_config.fired.assign(g_config.script.size(), false);
        }

        // Sprint 10 Goal 8 (R174): the mapping, resolved once from PS2X_INPUT_MAPPING. Unset is the defaults; a
        // value that cannot be read whole is the defaults too, said out loud -- a half-read table would be a
        // binding nobody wrote. Separate from initialise() so a test can read the table without a window.
        void resolveMapping()
        {
            if (g_config.mappingResolved)
                return;
            g_config.mappingResolved = true;
            const char *mappingEnv = ps2x::knob("PS2X_INPUT_MAPPING");
            const bool mappingRead = launcher::mapping::fromEnv(mappingEnv, g_config.mapping);
            g_config.mappingDefault = launcher::mapping::isDefault(g_config.mapping);
            if (!mappingRead)
                std::cout << "[socom2] PS2X_INPUT_MAPPING could not be read; playing the default mapping" << std::endl;
            // One line a gate can pin (Q1b): the resolved table's identity, and whether it is the default.
            std::cout << "[socom2] input mapping hash=" << launcher::mapping::hashHex(g_config.mapping)
                      << (g_config.mappingDefault ? " (default)" : " (custom)") << std::endl;
        }

        void initialise()
        {
            g_config.initialised = true;
            g_config.start = std::chrono::steady_clock::now();
            // R210: the one read of developer mode this file makes. The harness's launches all have it (R203);
            // a player's game gets the menu-and-typing half of the keyboard and plays on the pad.
            g_config.keyboardScope = socom2KeyboardScopeFor(ps2x::knobs::devMode());
            if (const char *script = ps2x::knob("PS2X_SOCOM2_INPUT_SCRIPT"))
                parseScript(script);
            resolveMapping();
            // Task 8: name the pad that is actually read (PS2X_HOST_GAMEPAD_INDEX), not slot 0.
            const int pad = hostGamepadEnabled()
                                ? hostGamepadSelect(hostGamepadIndexKnob(), kHostGamepadSlots, IsGamepadAvailable)
                                : -1;
            std::cout << "[socom2-input] keyboard "
                      << (g_config.keyboardScope == KeyboardScope::Full
                              ? (g_config.mappingDefault ? "full, developer mode (arrows/WASD/IJKL, Enter=START, Backspace=SELECT, ZXCV=Square/Cross/Circle/Triangle, QE=L1/R1, 13=L2/R2, 24=L3/R3)"
                                                         : "full, developer mode (PS2X_INPUT_MAPPING's key table; WASD/IJKL sticks)")
                              : "menus and typing only (d-pad, Enter=START, Backspace=SELECT, ZXCV=Square/Cross/Circle/Triangle; R210)")
                      << "; gamepad " << (!hostGamepadEnabled() ? "off (PS2X_HOST_GAMEPAD=0)" : pad >= 0 ? GetGamepadName(pad) : "none")
                      << "; script events " << g_config.script.size() << std::endl;
        }

        uint8_t clampAxis(float value)
        {
            return static_cast<uint8_t>(std::clamp(std::lround(value), 0L, 255L));
        }
    }

    void socom2HostInputStartSampler(const char *path)
    {
        if (path != nullptr && path[0] != 0)
            g_injectedPadSampler.start(path);
    }

    void socom2HostInputShutdown()
    {
        g_injectedPadSampler.shutdown();
    }

    bool socom2HostInputSamplerRunning()
    {
        return g_injectedPadSampler.worker.joinable();
    }

    const launcher::mapping::Mapping &socom2HostInputMapping()
    {
        resolveMapping();
        return g_config.mapping;
    }

    // ---- Sprint 10 Q3 (R210): the keyboard's scope ------------------------------------------------------------
    // Pure, and the only place the rule is written: what a player's keyboard drives is the d-pad, the four face
    // buttons, START and SELECT -- the game's menus, its pause and its on-screen keyboard read nothing else. The
    // sticks, L1/R1, L2/R2 and L3/R3 are movement, aim, fire, lean and crouch: gameplay, and the pad's for a player.

    KeyboardScope socom2KeyboardScopeFor(bool devMode)
    {
        return devMode ? KeyboardScope::Full : KeyboardScope::Menus;
    }

    bool socom2KeyboardDrivesButton(KeyboardScope scope, uint8_t button)
    {
        if (button >= 16)
            return false;
        if (scope == KeyboardScope::Full)
            return true;
        switch (button)
        {
        case kPadUp: case kPadRight: case kPadDown: case kPadLeft:
        case kPadTriangle: case kPadCircle: case kPadCross: case kPadSquare:
        case kPadStart: case kPadSelect:
            return true;
        default:
            return false;
        }
    }

    bool socom2KeyboardDrivesSticks(KeyboardScope scope)
    {
        return scope == KeyboardScope::Full;
    }

    void socom2ApplyKeyboard(const launcher::mapping::Mapping &mapping, KeyboardScope scope, bool (*isKeyDown)(int key),
                             Socom2PadState &next)
    {
        for (const launcher::mapping::KeyBinding &entry : mapping.keys)
        {
            if (socom2KeyboardDrivesButton(scope, entry.button) && isKeyDown(entry.key))
                next.button[entry.button] = 1u;
        }
        if (!socom2KeyboardDrivesSticks(scope))
            return;
        // WASD = left stick, IJKL = right stick (raylib's key codes are the capitals; the poll static_asserts it).
        static const struct { int negative; int positive; int slot; } kStickKeys[] = {
            {'A', 'D', 2}, {'W', 'S', 3}, {'J', 'L', 0}, {'I', 'K', 1},   // LX, LY (up = 0), RX, RY
        };
        for (const auto &pair : kStickKeys)
        {
            const bool negative = isKeyDown(pair.negative);
            const bool positive = isKeyDown(pair.positive);
            if (negative == positive)
                continue;   // both or neither: the axis stays where it was
            next.axis[pair.slot] = negative ? 0x00u : 0xFFu;
        }
    }

    void socom2HostInputPoll(Socom2PadState &pad)
    {
        if (!IsWindowReady())
        {
            return;
        }
        if (!g_config.initialised)
        {
            initialise();
        }

        Socom2PadState next;

        // Keyboard: the mapping's key table (launcher/mapping.h), whose codes are raylib's (== GLFW's) and whose
        // PS2 ids are libpad2's -- both asserted here, once, against the enums this file can see.
        static_assert(KEY_ENTER == 257 && KEY_ESCAPE == 256 && KEY_BACKSPACE == 259 && KEY_TAB == 258 && KEY_UP == 265 &&
                      KEY_RIGHT == 262 && KEY_DOWN == 264 && KEY_LEFT == 263 && KEY_SPACE == 32 && KEY_Z == 'Z' && KEY_ONE == '1',
                      "launcher/mapping.h's key table is written in raylib's key codes");
        static_assert(static_cast<int>(launcher::mapping::kPs2Select) == static_cast<int>(kPadSelect) &&
                      static_cast<int>(launcher::mapping::kPs2L3) == static_cast<int>(kPadL3) &&
                      static_cast<int>(launcher::mapping::kPs2R3) == static_cast<int>(kPadR3) &&
                      static_cast<int>(launcher::mapping::kPs2Start) == static_cast<int>(kPadStart) &&
                      static_cast<int>(launcher::mapping::kPs2Up) == static_cast<int>(kPadUp) &&
                      static_cast<int>(launcher::mapping::kPs2Right) == static_cast<int>(kPadRight) &&
                      static_cast<int>(launcher::mapping::kPs2Down) == static_cast<int>(kPadDown) &&
                      static_cast<int>(launcher::mapping::kPs2Left) == static_cast<int>(kPadLeft) &&
                      static_cast<int>(launcher::mapping::kPs2L2) == static_cast<int>(kPadL2) &&
                      static_cast<int>(launcher::mapping::kPs2R2) == static_cast<int>(kPadR2) &&
                      static_cast<int>(launcher::mapping::kPs2L1) == static_cast<int>(kPadL1) &&
                      static_cast<int>(launcher::mapping::kPs2R1) == static_cast<int>(kPadR1) &&
                      static_cast<int>(launcher::mapping::kPs2Triangle) == static_cast<int>(kPadTriangle) &&
                      static_cast<int>(launcher::mapping::kPs2Circle) == static_cast<int>(kPadCircle) &&
                      static_cast<int>(launcher::mapping::kPs2Cross) == static_cast<int>(kPadCross) &&
                      static_cast<int>(launcher::mapping::kPs2Square) == static_cast<int>(kPadSquare),
                      "launcher/mapping.h's PS2 ids are libpad2's (Socom2PadButton)");
        static_assert(KEY_A == 'A' && KEY_D == 'D' && KEY_W == 'W' && KEY_S == 'S' && KEY_J == 'J' && KEY_L == 'L' &&
                      KEY_I == 'I' && KEY_K == 'K', "socom2ApplyKeyboard's stick keys are raylib's key codes");
        // R210: the key table and the WASD/IJKL sticks, under the scope decided once in initialise() -- the whole
        // table in developer mode (the harness's path), the menu-and-typing buttons alone for a player.
        socom2ApplyKeyboard(g_config.mapping, g_config.keyboardScope, IsKeyDown, next);
        // R139: a full Triangle from any source outranks the crouch shortcut's light one (tracked stage by stage).
        bool fullTriangle = next.button[kPadTriangle] != 0;
        bool lightTriangle = false;

        // Gamepad 0 (raylib: XInput / DirectInput), OR-ed with the keyboard like the pad file is. The
        // generic pad path (ps2_pad.cpp) read it already, but SOCOM's pad is served by this poll once
        // PS2X_SOCOM2_PAD is set, so an Xbox controller did nothing here until 2026-09-16 (owner's free
        // play: Windows saw the controller, the game did not). A stick overrides the keyboard axis only
        // when deflected past the dead zone, so WASD/IJKL keep working with a pad plugged in (developer mode).
        // Task 8: the pad the launcher picked (PS2X_HOST_GAMEPAD_INDEX), or the first available one.
        // Re-selected every poll rather than latched: pads are hot-pluggable, and a player who plugs one in
        // mid-session should not have to restart.
        // `padSlot`, not `pad`: the poll's own out-parameter is named `pad` (Socom2PadState &).
        const int padSlot = hostGamepadEnabled()
                                ? hostGamepadSelect(hostGamepadIndexKnob(), kHostGamepadSlots, IsGamepadAvailable)
                                : -1;
        if (padSlot >= 0)
        {
            // The pad table: the mapping's rows (launcher/mapping.h), whose host ids are raylib's GamepadButton
            // values -- asserted here, once. A row bound to none (0) is skipped.
            static_assert(static_cast<int>(GAMEPAD_BUTTON_LEFT_FACE_UP) == static_cast<int>(launcher::mapping::kHostDpadUp) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_FACE_RIGHT) == static_cast<int>(launcher::mapping::kHostDpadRight) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_FACE_DOWN) == static_cast<int>(launcher::mapping::kHostDpadDown) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_FACE_LEFT) == static_cast<int>(launcher::mapping::kHostDpadLeft) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_FACE_UP) == static_cast<int>(launcher::mapping::kHostFaceUp) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_FACE_RIGHT) == static_cast<int>(launcher::mapping::kHostFaceRight) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_FACE_DOWN) == static_cast<int>(launcher::mapping::kHostFaceDown) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_FACE_LEFT) == static_cast<int>(launcher::mapping::kHostFaceLeft) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_TRIGGER_1) == static_cast<int>(launcher::mapping::kHostL1) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_TRIGGER_2) == static_cast<int>(launcher::mapping::kHostL2) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_TRIGGER_1) == static_cast<int>(launcher::mapping::kHostR1) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_TRIGGER_2) == static_cast<int>(launcher::mapping::kHostR2) &&
                          static_cast<int>(GAMEPAD_BUTTON_MIDDLE_LEFT) == static_cast<int>(launcher::mapping::kHostSelect) &&
                          static_cast<int>(GAMEPAD_BUTTON_MIDDLE) == static_cast<int>(launcher::mapping::kHostGuide) &&
                          static_cast<int>(GAMEPAD_BUTTON_MIDDLE_RIGHT) == static_cast<int>(launcher::mapping::kHostStart) &&
                          static_cast<int>(GAMEPAD_BUTTON_LEFT_THUMB) == static_cast<int>(launcher::mapping::kHostL3) &&
                          static_cast<int>(GAMEPAD_BUTTON_RIGHT_THUMB) == static_cast<int>(launcher::mapping::kHostR3) &&
                          static_cast<int>(GAMEPAD_BUTTON_UNKNOWN) == static_cast<int>(launcher::mapping::kHostNone),
                          "launcher/mapping.h's host ids are raylib's GamepadButton values");
            // R139: the pad's buttons are gathered into a mask and passed through the crouch shortcut, which is the
            // identity when the option is off (PS2X_PAD_CROUCH_SHORTCUT=off; unset is the registered l3, O12).
            // The keyboard, the script and the harness's injected file never go through it.
            static const CrouchShortcut s_crouch = crouchShortcutFromEnv(ps2x::knobOrDefault("PS2X_PAD_CROUCH_SHORTCUT"));
            uint16_t hostMask = 0;
            for (const launcher::mapping::PadBinding &entry : g_config.mapping.pad)
            {
                if (entry.host != launcher::mapping::kHostNone && entry.button < 16 && IsGamepadButtonDown(padSlot, entry.host))
                    hostMask = static_cast<uint16_t>(hostMask | (1u << entry.button));
            }
            const bool touchpad = s_crouch == CrouchShortcut::Touchpad && hostTouchpadDown(padSlot);
            const HostPadButtons fromPad = applyCrouchShortcut(hostMask, touchpad, s_crouch);
            for (int id = 0; id < 16; ++id)
            {
                if (fromPad.mask & (1u << id))
                    next.button[id] = 1u;
            }
            if (fromPad.mask & kCrouchBitTriangle)
            {
                if (fromPad.trianglePressure == kFullButtonPressure)
                    fullTriangle = true;
                else
                    lightTriangle = true;
            }
            // Triggers: raylib maps the trigger axes (rest -1.0) past 0.1 to GAMEPAD_BUTTON_*_TRIGGER_2 itself
            // (rcore_desktop_glfw.c), so the button table above covers L2/R2; no axis read here.
            static const struct { int axis; int slot; } kSticks[] = {
                {GAMEPAD_AXIS_RIGHT_X, 0}, {GAMEPAD_AXIS_RIGHT_Y, 1}, {GAMEPAD_AXIS_LEFT_X, 2}, {GAMEPAD_AXIS_LEFT_Y, 3},
            };
            const float deadZone = hostPadDeadZone();
            for (const auto &stick : kSticks)
            {
                const float v = hostPadAxis(GetGamepadAxisMovement(padSlot, stick.axis), deadZone);
                if (v != 0.0f)
                    next.axis[stick.slot] = clampAxis(128.0f + v * 127.0f);
            }
        }

        // Scripted presses.
        if (!g_config.script.empty())
        {
            const double now = std::chrono::duration<double>(std::chrono::steady_clock::now() - g_config.start).count();
            for (size_t index = 0; index < g_config.script.size(); ++index)
            {
                const ScriptEvent &event = g_config.script[index];
                if (now < event.at || now > event.at + event.hold)
                    continue;
                if (!g_config.fired[index])
                {
                    g_config.fired[index] = true;
                    std::cout << "[socom2-input] t=" << event.at << " press " << event.text << " for " << event.hold << "s" << std::endl;
                }
                for (int id = 0; id < 16; ++id)
                {
                    if (event.buttons & (1u << id))
                        next.button[id] = 1u;
                }
                if (event.buttons & kCrouchBitTriangle)
                    fullTriangle = true;
                for (int axis = 0; axis < 4; ++axis)
                {
                    if (event.axisSet[axis])
                        next.axis[axis] = event.axisValue[axis];
                }
            }
        }

        // PS2X_SOCOM2_INPUT_FILE=<path>: a driver-written pad state, sampled by a background
        // thread and latched, so every press written to the file is seen by at least one poll. One
        // line: "b=<hex 16-bit button mask> rx=<0-255> ry=<n> lx=<n> ly=<n>". Buttons are OR-ed
        // with the keyboard, an axis overrides the keyboard when it is not neutral (0x80).
        // Posted keyboard messages reach raylib only when the window thread pumps, so scripted
        // holds were dropped or their release was seen only at the next press (probe6, 2026-09-10);
        // the file path is deterministic and works for two instances on one host. Reading the file
        // here only, once per rendered frame, dropped a whole 0.09 s press under ~11 fps: the press
        // lived entirely between two polls (ten driven launches, 2026-09-18).
        {
            static const char *s_file = ps2x::knob("PS2X_SOCOM2_INPUT_FILE");
            if (s_file != nullptr)
            {
                socom2HostInputStartSampler(s_file);
                const ps2x::InjectedPadSample sample = g_injectedPadSampler.latch.take();
                for (int id = 0; id < 16; ++id)
                    if (sample.buttons & (1u << id))
                        next.button[id] = 1u;
                if (sample.buttons & kCrouchBitTriangle)
                    fullTriangle = true;
                const unsigned values[4] = {sample.rx, sample.ry, sample.lx, sample.ly};
                for (int axis = 0; axis < 4; ++axis)
                    if (values[axis] != 0x80u)
                        next.axis[axis] = static_cast<uint8_t>(std::min(values[axis], 255u));
            }
        }

        next.trianglePressure = trianglePressureFor(fullTriangle, lightTriangle);

        // PS2X_SOCOM2_INPUT_TRACE=1: log every change of the pad state the game will read
        // (buttons as a 16-bit mask, the four axes), so a scripted probe's presses are provable.
        {
            static const bool s_trace = ps2x::knob("PS2X_SOCOM2_INPUT_TRACE") != nullptr;
            if (s_trace)
            {
                static Socom2PadState s_last;
                // A byte compare is only sound on a struct without padding; this fails the build if one appears.
                static_assert(std::has_unique_object_representations_v<Socom2PadState>,
                              "Socom2PadState gained padding: compare it field by field, not with memcmp");
                if (std::memcmp(&s_last, &next, sizeof(next)) != 0)
                {
                    unsigned mask = 0;
                    for (int id = 0; id < 16; ++id)
                        if (next.button[id])
                            mask |= 1u << id;
                    std::fprintf(stderr, "[socom2-input] state buttons=%04x rx=%02x ry=%02x lx=%02x ly=%02x\n",
                                 mask, next.axis[0], next.axis[1], next.axis[2], next.axis[3]);
                    s_last = next;
                }
            }
        }
        pad = next;
    }
}
