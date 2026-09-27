#pragma once
// Owner request 2026-09-19, ruling R139: the "Crouch shortcut" -- one host control that crouches.
//
// WHY IT EXISTS. SOCOM II's stance is TRIANGLE, and it is PRESSURE sensitive. PlayerUpd (FUN_00594cf0) tracks the
// peak of Triangle's pressure (libpad2 id 0x18, scaled by 1/255) while the button is down: a peak under 0.3,
// acted on at release, toggles stand <-> crouch; a peak of 0.3 or more acts at once and goes prone (or stands up
// from prone). A host pad's Y / Triangle is digital, the HLE reports it as 0xFF, and so it can only ever go
// prone -- the "cannot crouch" every emulator player of this game meets. The community's answer on PCSX2 is a
// second binding, "Triangle at light pressure", on the left stick click (Xbox pads) or the touchpad click
// (DualShock 4 / DualSense). This is that binding.
//
// R139. The chosen control sends a LIGHT Triangle (kCrouchShortcutPressure) and does NOT also send the PS2
// button it sends today -- a stick click that crouched and changed fire mode at once would be worse than either.
// So "l3" gives up fire mode on the pad and "l2" gives up the secondary-weapon swap on the pad; both stay on the
// keyboard (2 and 1), which is always read, and the launcher says so under the option. "touchpad" gives up
// nothing: the runtime maps that control to nothing today. A full Triangle from any source (Y, the keyboard's V,
// a script, the harness's injected file) wins over the light one, so prone is always still reachable.
// Off is byte-identical to the runtime before this option. Since O12 (2026-09-26) it is not the default: the
// variable unset is the knob table's registered l3 (ps2x::knobOrDefault), and off has to be sent as "off".
//
// Pure: no raylib, no environment read. socom2_host_input.cpp reads PS2X_PAD_CROUCH_SHORTCUT and the pad.
#include <cstdint>
#include <cstring>

enum class CrouchShortcut : uint8_t
{
    Off = 0,
    L3,        // left stick click -- the community's Xbox-pad convention
    Touchpad,  // DualShock 4 / DualSense touchpad click
    L2,
};

constexpr uint8_t kFullButtonPressure = 0xFFu;
// 64/255 = 0.25: under the game's 0.3 threshold with room to spare, and well clear of 0.
constexpr uint8_t kCrouchShortcutPressure = 0x40u;

// libpad2 button bits (socom2_host_input.h's Socom2PadButton ids).
constexpr uint16_t kCrouchBitL3 = 1u << 1;
constexpr uint16_t kCrouchBitL2 = 1u << 8;
constexpr uint16_t kCrouchBitTriangle = 1u << 12;

// PS2X_PAD_CROUCH_SHORTCUT's value: "l3" | "touchpad" | "l2"; null, empty, "off" and anything else are Off.
// The caller resolves an unset variable to the registered default (knobOrDefault) before asking.
inline CrouchShortcut crouchShortcutFromEnv(const char *value)
{
    if (value == nullptr)
        return CrouchShortcut::Off;
    if (std::strcmp(value, "l3") == 0)
        return CrouchShortcut::L3;
    if (std::strcmp(value, "touchpad") == 0)
        return CrouchShortcut::Touchpad;
    if (std::strcmp(value, "l2") == 0)
        return CrouchShortcut::L2;
    return CrouchShortcut::Off;
}

struct HostPadButtons
{
    uint16_t mask = 0;                                  // what the host pad presses, as libpad2 bits
    uint8_t trianglePressure = kFullButtonPressure;     // the pressure to report for Triangle while it is down
};

// `hostMask`: the host pad's controls as the PS2 bits they map to with no shortcut. `touchpad`: the touchpad
// click, which maps to nothing. Returns what the pad contributes to the PS2 state under `option`.
inline HostPadButtons applyCrouchShortcut(uint16_t hostMask, bool touchpad, CrouchShortcut option)
{
    HostPadButtons out;
    out.mask = hostMask;
    // The control's own PS2 bit (0 for the touchpad, which has none) and whether the control is down.
    uint16_t own = 0;
    bool down = false;
    switch (option)
    {
    case CrouchShortcut::Off:
        return out;
    case CrouchShortcut::L3:
        own = kCrouchBitL3;
        down = (hostMask & own) != 0;
        break;
    case CrouchShortcut::L2:
        own = kCrouchBitL2;
        down = (hostMask & own) != 0;
        break;
    case CrouchShortcut::Touchpad:
        down = touchpad;
        break;
    }
    if (!down)
        return out;
    const bool ownTriangle = (hostMask & kCrouchBitTriangle) != 0;   // the pad's Y / Triangle, a full press
    out.mask = static_cast<uint16_t>((hostMask & ~own) | kCrouchBitTriangle);
    out.trianglePressure = ownTriangle ? kFullButtonPressure : kCrouchShortcutPressure;
    return out;
}

// The pressure the game reads for Triangle: full when any full source holds it, light when only the shortcut does.
inline uint8_t trianglePressureFor(bool fullSource, bool lightSource)
{
    return (lightSource && !fullSource) ? kCrouchShortcutPressure : kFullButtonPressure;
}
