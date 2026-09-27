#include "MiniTest.h"
#include "ps2_stubs.h"
#include "ps2_syscalls.h"
#include "Stubs/Pad.h"
#include "runtime/host_gamepad.h"
#include "runtime/host_crouch_shortcut.h"
#include "runtime/host_gamepad_select.h"
#include "runtime/injected_pad_latch.h"
#include "socom2_host_input.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <vector>
#include <cstdint>
#include <string>


namespace
{
    constexpr uint32_t kPadDataAddr = 0x1000;

    constexpr uint16_t kPadBtnSelect = 1u << 0;
    constexpr uint16_t kPadBtnL3 = 1u << 1;
    constexpr uint16_t kPadBtnR3 = 1u << 2;
    constexpr uint16_t kPadBtnStart = 1u << 3;
    constexpr uint16_t kPadBtnUp = 1u << 4;
    constexpr uint16_t kPadBtnRight = 1u << 5;
    constexpr uint16_t kPadBtnDown = 1u << 6;
    constexpr uint16_t kPadBtnLeft = 1u << 7;
    constexpr uint16_t kPadBtnL2 = 1u << 8;
    constexpr uint16_t kPadBtnR2 = 1u << 9;
    constexpr uint16_t kPadBtnL1 = 1u << 10;
    constexpr uint16_t kPadBtnR1 = 1u << 11;
    constexpr uint16_t kPadBtnTriangle = 1u << 12;
    constexpr uint16_t kPadBtnCircle = 1u << 13;
    constexpr uint16_t kPadBtnCross = 1u << 14;
    constexpr uint16_t kPadBtnSquare = 1u << 15;

    void setRegU32(R5900Context &ctx, int reg, uint32_t value)
    {
        ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    void openPadPort(R5900Context &ctx, std::vector<uint8_t> &rdram, uint32_t port = 0, uint32_t slot = 0)
    {
        setRegU32(ctx, 4, port);
        setRegU32(ctx, 5, slot);
        setRegU32(ctx, 6, kPadDataAddr + 0x200u);
        ps2_stubs::scePadPortOpen(rdram.data(), &ctx, nullptr);
    }

    void closePadPort(R5900Context &ctx, std::vector<uint8_t> &rdram, uint32_t port = 0, uint32_t slot = 0)
    {
        setRegU32(ctx, 4, port);
        setRegU32(ctx, 5, slot);
        ps2_stubs::scePadPortClose(rdram.data(), &ctx, nullptr);
    }

    void runPadRead(R5900Context &ctx, std::vector<uint8_t> &rdram)
    {
        setRegU32(ctx, 4, 0u);
        setRegU32(ctx, 5, 0u);
        setRegU32(ctx, 6, kPadDataAddr); // a2
        ps2_stubs::scePadRead(rdram.data(), &ctx, nullptr);
    }

    uint16_t readButtons(const std::vector<uint8_t> &rdram)
    {
        const uint8_t *data = rdram.data() + kPadDataAddr;
        return static_cast<uint16_t>(data[2] | (data[3] << 8));
    }
}

void register_pad_input_tests()
{
    // PS2X_HOST_GAMEPAD: a gate or launch boots with no controller (s6_gamepad/s6_gamepad2, 2026-09-16 -- a plugged-in
    // Xbox pad made the libpad HLE report a configured controller and the boot skipped the screens the transition
    // stage keys on). Only the literal "0" disables the host gamepad; unset/empty/anything else keeps the player's default.
    MiniTest::Case("HostGamepadKnob", [](TestCase &tc)
    {
        tc.Run("PS2X_HOST_GAMEPAD=0 disables the host gamepad, everything else keeps it", [](TestCase &t)
        {
            t.IsTrue(!hostGamepadAllowed("0"), "0 disables");
            t.IsTrue(hostGamepadAllowed(nullptr), "unset keeps it");
            t.IsTrue(hostGamepadAllowed(""), "empty keeps it");
            t.IsTrue(hostGamepadAllowed("1"), "1 keeps it");
            t.IsTrue(hostGamepadAllowed("off"), "a word is not 0");
        });

        tc.Run("PS2X_HOST_GAMEPAD_INDEX picks a pad when it is there, otherwise the first available one", [](TestCase &t)
        {
            // A fake `available` so the case runs the same on a machine with no pad and on one with four.
            static bool s_present[kHostGamepadSlots];
            auto available = [](int i) { return i >= 0 && i < kHostGamepadSlots && s_present[i]; };
            for (bool &p : s_present) p = false;
            s_present[0] = true;
            s_present[2] = true;
            t.Equals(hostGamepadSelect("2", kHostGamepadSlots, available), 2, "the env names pad 2 and pad 2 is there");
            t.Equals(hostGamepadSelect("1", kHostGamepadSlots, available), 0, "the env names an absent pad: the first available one instead");
            t.Equals(hostGamepadSelect(nullptr, kHostGamepadSlots, available), 0, "unset: the first available one");
            t.Equals(hostGamepadSelect("", kHostGamepadSlots, available), 0, "empty: the first available one");
            t.Equals(hostGamepadSelect("nonsense", kHostGamepadSlots, available), 0, "unparseable: the first available one");
            t.Equals(hostGamepadSelect("9", kHostGamepadSlots, available), 0, "out of range: the first available one");
            t.Equals(hostGamepadSelect("-1", kHostGamepadSlots, available), 0, "negative: the first available one");
            for (bool &p : s_present) p = false;
            t.Equals(hostGamepadSelect("2", kHostGamepadSlots, available), -1, "no pad at all: -1, and every caller reads the keyboard");
            t.Equals(hostGamepadSelect(nullptr, kHostGamepadSlots, available), -1, "no pad at all, no preference: -1");
            s_present[3] = true;
            t.Equals(hostGamepadSelect(nullptr, kHostGamepadSlots, available), 3, "only the last slot: it is the first available");
            t.Equals(hostGamepadSelect("3", 0, available), -1, "a zero count selects nothing");
            t.Equals(hostGamepadSelect("3", kHostGamepadSlots, nullptr), -1, "no probe selects nothing");
        });
    });

    // PS2X_SOCOM2_INPUT_FILE presses were read only inside the game's own pad poll, once per
    // rendered frame; below ~11 fps a whole 0.09 s press fell between two polls and was dropped
    // (ten driven launches, 2026-09-18). A sampler thread observes the file and the latch keeps
    // every button seen since the previous poll, so a press is delivered late, never lost.
    MiniTest::Case("InjectedPadLatch", [](TestCase &tc)
    {
        tc.Run("parseInjectedPadLine takes the harness line and rejects anything else", [](TestCase &t)
        {
            ps2x::InjectedPadSample s;
            t.IsTrue(ps2x::parseInjectedPadLine("b=4000 rx=128 ry=128 lx=128 ly=128", s), "the harness line parses");
            t.Equals(s.buttons, static_cast<uint32_t>(0x4000u), "buttons should be the hex mask");
            t.Equals(s.rx, static_cast<uint8_t>(128), "rx should be neutral");
            t.Equals(s.ly, static_cast<uint8_t>(128), "ly should be neutral");

            ps2x::InjectedPadSample rejected;
            t.IsTrue(!ps2x::parseInjectedPadLine("garbage", rejected), "garbage is not a pad line");
            t.IsTrue(!ps2x::parseInjectedPadLine("b=4000 rx=128 ry=128 lx=128", rejected), "a line missing ly is not a pad line");
        });

        tc.Run("a press that lives between two takes is delivered to exactly one take", [](TestCase &t)
        {
            ps2x::InjectedPadLatch latch;
            ps2x::InjectedPadSample neutral;
            latch.observe(neutral);
            t.Equals(latch.take().buttons, static_cast<uint32_t>(0u), "nothing pressed yet");

            ps2x::InjectedPadSample pressed;
            pressed.buttons = 0x4000u;
            latch.observe(pressed);
            latch.observe(neutral);

            t.Equals(latch.take().buttons, static_cast<uint32_t>(0x4000u), "the press between polls is delivered");
            t.Equals(latch.take().buttons, static_cast<uint32_t>(0u), "and released on the next poll");
        });

        tc.Run("a press still held is delivered on every take while held", [](TestCase &t)
        {
            ps2x::InjectedPadLatch latch;
            ps2x::InjectedPadSample pressed;
            pressed.buttons = 1u;
            latch.observe(pressed);
            t.Equals(latch.take().buttons, static_cast<uint32_t>(1u), "held press is down");
            t.Equals(latch.take().buttons, static_cast<uint32_t>(1u), "still down on the next poll");

            ps2x::InjectedPadSample neutral;
            latch.observe(neutral);
            t.Equals(latch.take().buttons, static_cast<uint32_t>(0u), "released once the file says neutral");
        });

        tc.Run("axes are the latest sample's", [](TestCase &t)
        {
            ps2x::InjectedPadLatch latch;
            ps2x::InjectedPadSample low;
            low.lx = 0;
            latch.observe(low);
            ps2x::InjectedPadSample high;
            high.lx = 255;
            latch.observe(high);
            t.Equals(latch.take().lx, static_cast<uint8_t>(255), "lx should be the latest sample's");
        });
    });

    MiniTest::Case("PadInput", [](TestCase &tc)
                   {
        tc.Run("scePadRead uses override state", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            const uint16_t buttons = static_cast<uint16_t>(0xFFFFu & ~kPadBtnCross & ~kPadBtnStart);
            ps2_stubs::setPadOverrideState(buttons, 0x00, 0xFF, 0x10, 0xEE);

            runPadRead(ctx, rdram);

            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadRead should return 1");
            t.Equals(readButtons(rdram), buttons, "button bitmask should match override state");
            const uint8_t *data = rdram.data() + kPadDataAddr;
            t.Equals(data[4], static_cast<uint8_t>(0x10), "rx should match override");
            t.Equals(data[5], static_cast<uint8_t>(0xEE), "ry should match override");
            t.Equals(data[6], static_cast<uint8_t>(0x00), "lx should match override");
            t.Equals(data[7], static_cast<uint8_t>(0xFF), "ly should match override");

            ps2_stubs::clearPadOverrideState();
            closePadPort(ctx, rdram);
        });

        tc.Run("scePadRead button bits are active-low", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            struct ButtonCase
            {
                uint16_t mask;
                const char *name;
            };

            const ButtonCase cases[] = {
                {kPadBtnSelect, "select"},
                {kPadBtnL3, "l3"},
                {kPadBtnR3, "r3"},
                {kPadBtnStart, "start"},
                {kPadBtnUp, "up"},
                {kPadBtnRight, "right"},
                {kPadBtnDown, "down"},
                {kPadBtnLeft, "left"},
                {kPadBtnL2, "l2"},
                {kPadBtnR2, "r2"},
                {kPadBtnL1, "l1"},
                {kPadBtnR1, "r1"},
                {kPadBtnTriangle, "triangle"},
                {kPadBtnCircle, "circle"},
                {kPadBtnCross, "cross"},
                {kPadBtnSquare, "square"}};

            for (const auto &entry : cases)
            {
                const uint16_t buttons = static_cast<uint16_t>(0xFFFFu & ~entry.mask);
                ps2_stubs::setPadOverrideState(buttons, 0x80, 0x80, 0x80, 0x80);
                runPadRead(ctx, rdram);

                t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadRead should succeed for opened ports");
                const uint16_t mask = readButtons(rdram);
                t.IsTrue((mask & entry.mask) == 0, std::string("button should be active-low: ").append(entry.name));
            }

            ps2_stubs::clearPadOverrideState();
            closePadPort(ctx, rdram);
        });

        tc.Run("scePadGetButtonMask returns all buttons", [](TestCase &t)
               {
            R5900Context ctx;
            ps2_stubs::scePadGetButtonMask(nullptr, &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0xFFFF), "button mask should be 0xFFFF");
        });

        tc.Run("basic pad init/port/state functions return expected values", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadInit should succeed");

            ps2_stubs::scePadInit2(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadInit2 should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0), "closed port should report DISCONNECTED");

            openPadPort(ctx, rdram);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadPortOpen should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(6), "scePadGetState should return STABLE");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetReqState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0), "scePadGetReqState should return completed");

            ps2_stubs::scePadGetPortMax(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(2), "scePadGetPortMax should be 2");

            setRegU32(ctx, 4, 0u);
            ps2_stubs::scePadGetSlotMax(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadGetSlotMax should be 1");

            ps2_stubs::scePadGetModVersion(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0x0200), "scePadGetModVersion should be 0x0200");

            closePadPort(ctx, rdram);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadPortClose should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0), "closed port should return DISCONNECTED after close");
        });

        tc.Run("pad command state reports EXECCMD once before returning STABLE", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1u);
            setRegU32(ctx, 7, 3u);
            ps2_stubs::scePadSetMainMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetMainMode should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(5), "first state after mode command should be EXECCMD");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(6), "second state after mode command should return STABLE");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadEnterPressMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadEnterPressMode should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(5), "first state after press-mode command should be EXECCMD");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(6), "second state after press-mode command should return STABLE");

            closePadPort(ctx, rdram);
        });

        tc.Run("pad info and mode helpers return consistent values", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            setRegU32(ctx, 6, static_cast<uint32_t>(-1));
            ps2_stubs::scePadInfoAct(rdram.data(), &ctx, nullptr);
            t.IsTrue(static_cast<uint32_t>(getRegU32(&ctx, 2)) >= 1u, "scePadInfoAct should report at least one actuator descriptor");

            ps2_stubs::scePadInfoComb(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0), "scePadInfoComb should return 0");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1);
            setRegU32(ctx, 7, 0);
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(4), "scePadInfoMode CURID should return digital at open");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 4);
            setRegU32(ctx, 7, static_cast<uint32_t>(-1));
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.IsTrue(static_cast<uint32_t>(getRegU32(&ctx, 2)) >= 1u, "scePadInfoMode table count should be non-zero");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadInfoPressMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadInfoPressMode should report pressure support");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 0u);
            setRegU32(ctx, 7, 3u);
            ps2_stubs::scePadSetMainMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetMainMode should accept digital mode");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1u);
            setRegU32(ctx, 7, 0u);
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(4), "CURID should switch to digital mode");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1u);
            setRegU32(ctx, 7, 3u);
            ps2_stubs::scePadSetMainMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetMainMode should accept analog mode");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 4);
            setRegU32(ctx, 7, 0u);
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(7), "mode table entry should return DualShock in analog mode");

            closePadPort(ctx, rdram);
        });

        tc.Run("pads open in digital mode and switch to analog on scePadSetMainMode", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(6), "freshly opened port should report STABLE");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1);
            setRegU32(ctx, 7, 0);
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(4), "scePadInfoMode CURID should return digital at open");

            runPadRead(ctx, rdram);
            const uint8_t *data = rdram.data() + kPadDataAddr;
            t.Equals(data[1], static_cast<uint8_t>(0x41), "mode byte should be 0x41 (digital) at open");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1);
            setRegU32(ctx, 7, 3);
            ps2_stubs::scePadSetMainMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetMainMode should succeed switching to analog");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1);
            setRegU32(ctx, 7, 0);
            ps2_stubs::scePadInfoMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(7), "scePadInfoMode CURID should return analog after SetMainMode");

            // scePadSetMainMode queues a one-shot EXECCMD transient state; pump scePadGetState
            // once so the port settles back to STABLE before reading, mirroring the existing
            // "pad command state reports EXECCMD once before returning STABLE" test.
            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadGetState(rdram.data(), &ctx, nullptr);

            runPadRead(ctx, rdram);
            t.Equals(data[1], static_cast<uint8_t>(0x73), "mode byte should be 0x73 (analog) after SetMainMode");

            closePadPort(ctx, rdram);
        });

        tc.Run("pad setters return success", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadSetActAlign(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetActAlign should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadSetActDirect(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetActDirect should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 0xFFFFu);
            ps2_stubs::scePadSetButtonInfo(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetButtonInfo should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 1u);
            setRegU32(ctx, 7, 3u);
            ps2_stubs::scePadSetMainMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetMainMode should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadSetReqState(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetReqState should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadSetVrefParam(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetVrefParam should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadSetWarningLevel(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(0), "scePadSetWarningLevel should return 0");

            ps2_stubs::scePadEnd(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadEnd should succeed");

            openPadPort(ctx, rdram);
            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadEnterPressMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadEnterPressMode should succeed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadExitPressMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadExitPressMode should succeed");

            closePadPort(ctx, rdram);
        });

        tc.Run("scePadRead fills pressure bytes and honors button info mask", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            ps2_stubs::scePadInit(rdram.data(), &ctx, nullptr);
            openPadPort(ctx, rdram);

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, 0xFFFFu);
            ps2_stubs::scePadSetButtonInfo(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetButtonInfo should accept all buttons");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            ps2_stubs::scePadEnterPressMode(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadEnterPressMode should enable pressure data");

            const uint16_t pressedButtons = static_cast<uint16_t>(0xFFFFu &
                                                                   ~kPadBtnLeft &
                                                                   ~kPadBtnUp &
                                                                   ~kPadBtnTriangle &
                                                                   ~kPadBtnCross &
                                                                   ~kPadBtnL1 &
                                                                   ~kPadBtnR2);
            ps2_stubs::setPadOverrideState(pressedButtons, 0x80, 0x80, 0x80, 0x80);
            runPadRead(ctx, rdram);

            const uint8_t *data = rdram.data() + kPadDataAddr;
            t.Equals(data[8], static_cast<uint8_t>(0x00), "right pressure should be clear when not pressed");
            t.Equals(data[9], static_cast<uint8_t>(0xFF), "left pressure should be populated when pressed");
            t.Equals(data[10], static_cast<uint8_t>(0xFF), "up pressure should be populated when pressed");
            t.Equals(data[11], static_cast<uint8_t>(0x00), "down pressure should be clear when not pressed");
            t.Equals(data[12], static_cast<uint8_t>(0xFF), "triangle pressure should be populated when pressed");
            t.Equals(data[13], static_cast<uint8_t>(0x00), "circle pressure should be clear when not pressed");
            t.Equals(data[14], static_cast<uint8_t>(0xFF), "cross pressure should be populated when pressed");
            t.Equals(data[15], static_cast<uint8_t>(0x00), "square pressure should be clear when not pressed");
            t.Equals(data[16], static_cast<uint8_t>(0xFF), "L1 pressure should be populated when pressed");
            t.Equals(data[17], static_cast<uint8_t>(0x00), "L2 pressure should be clear when not pressed");
            t.Equals(data[18], static_cast<uint8_t>(0x00), "R1 pressure should be clear when not pressed");
            t.Equals(data[19], static_cast<uint8_t>(0xFF), "R2 pressure should be populated when pressed");

            setRegU32(ctx, 4, 0u);
            setRegU32(ctx, 5, 0u);
            setRegU32(ctx, 6, static_cast<uint32_t>(kPadBtnL1 | kPadBtnR2));
            ps2_stubs::scePadSetButtonInfo(rdram.data(), &ctx, nullptr);
            t.Equals(static_cast<uint32_t>(getRegU32(&ctx, 2)), static_cast<uint32_t>(1), "scePadSetButtonInfo should narrow the enabled pressure mask");

            runPadRead(ctx, rdram);

            t.Equals(data[9], static_cast<uint8_t>(0x00), "masked-out direction pressure should clear");
            t.Equals(data[10], static_cast<uint8_t>(0x00), "masked-out direction pressure should clear");
            t.Equals(data[12], static_cast<uint8_t>(0x00), "masked-out face-button pressure should clear");
            t.Equals(data[14], static_cast<uint8_t>(0x00), "masked-out face-button pressure should clear");
            t.Equals(data[16], static_cast<uint8_t>(0xFF), "enabled L1 pressure should remain populated");
            t.Equals(data[19], static_cast<uint8_t>(0xFF), "enabled R2 pressure should remain populated");

            ps2_stubs::clearPadOverrideState();
            closePadPort(ctx, rdram);
        });

        tc.Run("pad string helpers map state codes", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            setRegU32(ctx, 4, 1);
            setRegU32(ctx, 5, kPadDataAddr);
            ps2_stubs::scePadStateIntToStr(rdram.data(), &ctx, nullptr);
            t.IsTrue(std::string(reinterpret_cast<const char *>(rdram.data() + kPadDataAddr)).find("FINDPAD") != std::string::npos,
                     "state 1 should map to FINDPAD");

            setRegU32(ctx, 4, 0);
            setRegU32(ctx, 5, kPadDataAddr + 64);
            ps2_stubs::scePadStateIntToStr(rdram.data(), &ctx, nullptr);
            t.IsTrue(std::string(reinterpret_cast<const char *>(rdram.data() + kPadDataAddr + 64)).find("DISCONNECTED") != std::string::npos,
                     "state 0 should map to DISCONNECTED");

            setRegU32(ctx, 4, 1);
            setRegU32(ctx, 5, kPadDataAddr + 128);
            ps2_stubs::scePadReqIntToStr(rdram.data(), &ctx, nullptr);
            t.IsTrue(std::string(reinterpret_cast<const char *>(rdram.data() + kPadDataAddr + 128)).find("BUSY") != std::string::npos,
                     "req state 1 should map to BUSY");
        });
        tc.Run("scePadGetFrameCount increments", [](TestCase &t)
               {
            R5900Context ctx;
            ps2_stubs::scePadGetFrameCount(nullptr, &ctx, nullptr);
            const uint32_t first = getRegU32(&ctx, 2);
            ps2_stubs::scePadGetFrameCount(nullptr, &ctx, nullptr);
            const uint32_t second = getRegU32(&ctx, 2);
            t.Equals(second, first + 1, "frame count should increment");
        });

        tc.Run("scePadStateIntToStr and scePadReqIntToStr write strings", [](TestCase &t)
               {
            std::vector<uint8_t> rdram(PS2_RAM_SIZE, 0);
            R5900Context ctx;

            setRegU32(ctx, 4, 6);
            setRegU32(ctx, 5, kPadDataAddr);
            ps2_stubs::scePadStateIntToStr(rdram.data(), &ctx, nullptr);
            const char *stateStr = reinterpret_cast<const char *>(rdram.data() + kPadDataAddr);
            t.IsTrue(std::string(stateStr).find("STABLE") != std::string::npos, "state string should include STABLE");

            setRegU32(ctx, 4, 0);
            setRegU32(ctx, 5, kPadDataAddr + 64);
            ps2_stubs::scePadReqIntToStr(rdram.data(), &ctx, nullptr);
            const char *reqStr = reinterpret_cast<const char *>(rdram.data() + kPadDataAddr + 64);
            t.IsTrue(std::string(reqStr).find("COMPLETE") != std::string::npos, "req string should include COMPLETE");
        });

        // Sprint 7 review finding F12: the sampler thread was joined only by the destructor of a namespace-scope
        // static, and main leaves through std::_Exit, so that destructor never ran -- the thread was still
        // reading the pad file while the process tore its runtime down. The shutdown is explicit now.
        tc.Run("the injected-pad sampler is stopped and joined by socom2HostInputShutdown", [](TestCase &t)
        {
            const std::string path = "ps2x_test_injected_pad.txt";
            if (FILE *f = std::fopen(path.c_str(), "wb"))
            {
                std::fputs("b=0008 rx=128 ry=128 lx=128 ly=128\n", f);
                std::fclose(f);
            }

            ps2_stubs::socom2HostInputStartSampler(path.c_str());
            t.IsTrue(ps2_stubs::socom2HostInputSamplerRunning(), "the sampler thread is running");

            const auto started = std::chrono::steady_clock::now();
            ps2_stubs::socom2HostInputShutdown();
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
            t.IsTrue(!ps2_stubs::socom2HostInputSamplerRunning(), "and it is stopped and joined afterwards");
            t.IsTrue(ms < 500.0, "the join returns promptly rather than outliving the process");

            ps2_stubs::socom2HostInputShutdown();   // the teardown runs at both of PS2Runtime's exits
            t.IsTrue(!ps2_stubs::socom2HostInputSamplerRunning(), "a second shutdown is a no-op");

            std::remove(path.c_str());
        });
    });
    // Owner request 2026-09-19, ruling R139 (runtime/host_crouch_shortcut.h): the crouch shortcut. SOCOM II's
    // stance is Triangle's PRESSURE -- a peak under 0.3 crouches, 0.3 or more goes prone (FUN_00594cf0) -- so the
    // shortcut is a light Triangle on a host control, sent INSTEAD of that control's own PS2 button.
    MiniTest::Case("CrouchShortcut", [](TestCase &tc)
    {
        tc.Run("PS2X_PAD_CROUCH_SHORTCUT parses its three values and treats everything else as off", [](TestCase &t)
        {
            // The parse alone: the runtime asks it about knobOrDefault's value, which is l3 when unset (O12).
            t.IsTrue(crouchShortcutFromEnv(nullptr) == CrouchShortcut::Off, "a null value parses as off");
            t.IsTrue(crouchShortcutFromEnv("") == CrouchShortcut::Off, "empty is off");
            t.IsTrue(crouchShortcutFromEnv("off") == CrouchShortcut::Off, "off is off");
            t.IsTrue(crouchShortcutFromEnv("l3") == CrouchShortcut::L3, "l3");
            t.IsTrue(crouchShortcutFromEnv("touchpad") == CrouchShortcut::Touchpad, "touchpad");
            t.IsTrue(crouchShortcutFromEnv("l2") == CrouchShortcut::L2, "l2");
            t.IsTrue(crouchShortcutFromEnv("r3") == CrouchShortcut::Off, "an unknown value is off, not a guess");
            t.IsTrue(crouchShortcutFromEnv("L3") == CrouchShortcut::Off, "the launcher writes lower case; nothing else is accepted");
        });

        // Owner 2026-09-20: Escape no longer closes the game (SetExitKey(KEY_NULL)); it is Start, the pause a PC
        // player expects from that key. Enter stays Start as well. Since Sprint 10 Goal 8 the table is
        // launcher/mapping.h's default key table (the runtime resolves it from PS2X_INPUT_MAPPING, unset here).
        tc.Run("the keyboard map: Escape and Enter are both Start, and every PS2 button has a key", [](TestCase &t)
        {
            using namespace ps2_stubs;
            const std::vector<launcher::mapping::KeyBinding> kSocom2Keys = launcher::mapping::defaults().keys;
            t.IsTrue(socom2HostInputMapping().keys == kSocom2Keys, "and the runtime's resolved table is that default (no PS2X_INPUT_MAPPING in the test process)");
            t.IsTrue(launcher::mapping::isDefault(socom2HostInputMapping()), "whole");
            auto buttonsFor = [&](int key) { std::vector<int> out; for (const auto &k : kSocom2Keys) if (k.key == key) out.push_back(k.button); return out; };
            t.IsTrue(buttonsFor(256) == std::vector<int>{kPadStart}, "Escape (256) is Start");
            t.IsTrue(buttonsFor(257) == std::vector<int>{kPadStart}, "Enter (257) is still Start");
            t.IsTrue(buttonsFor(259) == std::vector<int>{kPadSelect}, "Backspace is Select");
            bool seen[16] = {};
            for (const auto &k : kSocom2Keys) { t.IsTrue(k.button < 16, "a button index is in range"); if (k.button < 16) seen[k.button] = true; }
            for (int i = 0; i < 16; ++i) t.IsTrue(seen[i], "PS2 button " + std::to_string(i) + " is reachable from the keyboard");
        });

        // Sprint 10 Q3 (R210, owner 2026-09-20: "keyboard support ONLY for menu navigation and typing"). The
        // keyboard's gameplay half -- the sticks and the shoulders, triggers and stick clicks -- is honoured only
        // in developer mode, where it is the harness's scripted path (HANDOFF trap 1: every gate, ladder and
        // control round posts exactly these keys into the window, and every harness launch has PS2X_DEV=1, R203).
        // The menu-and-typing half -- d-pad, the four face buttons, START, SELECT -- is everyone's.
        tc.Run("the keyboard scope: developer mode is the whole table, a player's game is menus and typing (R210)", [](TestCase &t)
        {
            using namespace ps2_stubs;
            t.IsTrue(socom2KeyboardScopeFor(true) == KeyboardScope::Full, "developer mode: the whole table, the harness's path");
            t.IsTrue(socom2KeyboardScopeFor(false) == KeyboardScope::Menus, "a player's game: menus and typing");
            for (int id = 0; id < 16; ++id)
                t.IsTrue(socom2KeyboardDrivesButton(KeyboardScope::Full, static_cast<uint8_t>(id)), "Full drives PS2 button " + std::to_string(id));
            t.IsTrue(socom2KeyboardDrivesSticks(KeyboardScope::Full), "Full moves the sticks");
            for (int id : {kPadUp, kPadRight, kPadDown, kPadLeft, kPadTriangle, kPadCircle, kPadCross, kPadSquare, kPadStart, kPadSelect})
                t.IsTrue(socom2KeyboardDrivesButton(KeyboardScope::Menus, static_cast<uint8_t>(id)), "Menus drives PS2 button " + std::to_string(id) + " (menus and the on-screen keyboard read it)");
            for (int id : {kPadL1, kPadR1, kPadL2, kPadR2, kPadL3, kPadR3})
                t.IsFalse(socom2KeyboardDrivesButton(KeyboardScope::Menus, static_cast<uint8_t>(id)), "Menus leaves PS2 button " + std::to_string(id) + " to the pad");
            t.IsFalse(socom2KeyboardDrivesSticks(KeyboardScope::Menus), "Menus never moves a stick");
            t.IsFalse(socom2KeyboardDrivesButton(KeyboardScope::Full, 16) || socom2KeyboardDrivesButton(KeyboardScope::Menus, 16), "an id out of range is nothing, in either scope");
        });

        // The inert-in-developer-mode proof: with the scope Full, every key of the resolved table is consumed
        // exactly as the poll consumed it before Q3 (the reference loop below IS that code), so the gate's harness
        // sees no difference. Without developer mode the same presses reach only the menu buttons.
        tc.Run("the keyboard applied: under Full every default key lands as before; under Menus only the menu keys land (R210)", [](TestCase &t)
        {
            using namespace ps2_stubs;
            const launcher::mapping::Mapping def = launcher::mapping::defaults();
            static std::vector<int> s_down;
            const auto isDown = [](int key) { return std::find(s_down.begin(), s_down.end(), key) != s_down.end(); };
            const auto reference = [&](Socom2PadState &out)
            {
                // socom2HostInputPoll's keyboard half as it was on 2026-09-21 before Q3.
                for (const launcher::mapping::KeyBinding &entry : def.keys)
                    if (entry.button < 16 && isDown(entry.key))
                        out.button[entry.button] = 1u;
                const auto axis = [&](int negative, int positive) -> uint8_t
                {
                    const bool n = isDown(negative), p = isDown(positive);
                    return n == p ? 0x80u : (n ? 0x00u : 0xFFu);
                };
                out.axis[2] = axis('A', 'D');
                out.axis[3] = axis('W', 'S');
                out.axis[0] = axis('J', 'L');
                out.axis[1] = axis('I', 'K');
            };

            // One key at a time: every entry of the table, and each stick key.
            std::vector<int> keys;
            for (const launcher::mapping::KeyBinding &entry : def.keys)
                keys.push_back(entry.key);
            for (int k : {'W', 'A', 'S', 'D', 'I', 'J', 'K', 'L'})
                keys.push_back(k);
            for (int key : keys)
            {
                s_down = {key};
                Socom2PadState expected, full, menus;
                reference(expected);
                socom2ApplyKeyboard(def, KeyboardScope::Full, isDown, full);
                t.IsTrue(std::memcmp(&full, &expected, sizeof(full)) == 0, "Full: key " + launcher::mapping::keyName(key) + " lands exactly as before");
                socom2ApplyKeyboard(def, KeyboardScope::Menus, isDown, menus);
                for (int id = 0; id < 16; ++id)
                    t.Equals(static_cast<int>(menus.button[id]),
                             socom2KeyboardDrivesButton(KeyboardScope::Menus, static_cast<uint8_t>(id)) ? static_cast<int>(expected.button[id]) : 0,
                             "Menus: key " + launcher::mapping::keyName(key) + " and PS2 button " + std::to_string(id));
                for (int axis = 0; axis < 4; ++axis)
                    t.Equals(static_cast<int>(menus.axis[axis]), 0x80, "Menus: key " + launcher::mapping::keyName(key) + " moves no stick");
            }

            // A chord the harness holds (hold:W with R1 to fire, and START): the whole thing under Full, START alone under Menus.
            s_down = {'W', 'E', 257};
            Socom2PadState expected, full, menus;
            reference(expected);
            socom2ApplyKeyboard(def, KeyboardScope::Full, isDown, full);
            t.IsTrue(std::memcmp(&full, &expected, sizeof(full)) == 0, "Full: W+E+Enter is forward, R1 and START as before");
            t.IsTrue(full.axis[3] == 0x00u && full.button[kPadR1] == 1u && full.button[kPadStart] == 1u, "and that is what the reference says too");
            socom2ApplyKeyboard(def, KeyboardScope::Menus, isDown, menus);
            t.IsTrue(menus.axis[3] == 0x80u && menus.button[kPadR1] == 0u && menus.button[kPadStart] == 1u, "Menus: START, no movement, no fire");

            // The contribution is OR-ed into what is already there; an axis at rest is left alone (the pad's stick may hold it).
            s_down = {};
            Socom2PadState kept;
            kept.button[kPadCross] = 1u;
            kept.axis[2] = 0xFFu;
            socom2ApplyKeyboard(def, KeyboardScope::Full, isDown, kept);
            t.IsTrue(kept.button[kPadCross] == 1u && kept.axis[2] == 0xFFu, "nothing down: nothing changes");

            // A custom table from PS2X_INPUT_MAPPING is gated by the PS2 button it names, not by the key.
            launcher::mapping::Mapping custom = def;
            custom.keys = {{'P', static_cast<uint8_t>(kPadL1)}, {'O', static_cast<uint8_t>(kPadCross)}};
            s_down = {'P', 'O'};
            Socom2PadState c1, c2;
            socom2ApplyKeyboard(custom, KeyboardScope::Full, isDown, c1);
            t.IsTrue(c1.button[kPadL1] == 1u && c1.button[kPadCross] == 1u, "Full: a custom key table, both entries");
            socom2ApplyKeyboard(custom, KeyboardScope::Menus, isDown, c2);
            t.IsTrue(c2.button[kPadL1] == 0u && c2.button[kPadCross] == 1u, "Menus: the entry bound to L1 is gameplay whatever key it is on");
        });

        tc.Run("off is today's pad, for every button and with or without the touchpad", [](TestCase &t)
        {
            for (int id = 0; id < 16; ++id)
            {
                const uint16_t bit = static_cast<uint16_t>(1u << id);
                for (int touch = 0; touch < 2; ++touch)
                {
                    const HostPadButtons r = applyCrouchShortcut(bit, touch != 0, CrouchShortcut::Off);
                    t.Equals(static_cast<int>(r.mask), static_cast<int>(bit), "off: the mask passes through untouched");
                    t.Equals(static_cast<int>(r.trianglePressure), 0xFF, "off: Triangle is a full press, as it always was");
                }
            }
            const HostPadButtons all = applyCrouchShortcut(0xFFFFu, true, CrouchShortcut::Off);
            t.Equals(static_cast<int>(all.mask), 0xFFFF, "off: every button at once, still untouched");
        });

        tc.Run("l3: the stick click is a light Triangle instead of L3, and nothing else moves", [](TestCase &t)
        {
            HostPadButtons r = applyCrouchShortcut(kCrouchBitL3, false, CrouchShortcut::L3);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitTriangle), "down: Triangle, and NOT L3 (fire mode does not also fire)");
            t.Equals(static_cast<int>(r.trianglePressure), static_cast<int>(kCrouchShortcutPressure), "at the light pressure");
            t.IsTrue(kCrouchShortcutPressure > 0 && kCrouchShortcutPressure / 255.0 < 0.3, "which is under the game's 0.3 prone threshold");

            r = applyCrouchShortcut(0u, false, CrouchShortcut::L3);
            t.Equals(static_cast<int>(r.mask), 0, "up: nothing is pressed");

            for (int id = 0; id < 16; ++id)
            {
                const uint16_t bit = static_cast<uint16_t>(1u << id);
                if (bit == kCrouchBitL3 || bit == kCrouchBitTriangle)
                    continue;
                r = applyCrouchShortcut(bit, true, CrouchShortcut::L3);
                t.Equals(static_cast<int>(r.mask), static_cast<int>(bit), "every other button (and the touchpad) is left alone");
                r = applyCrouchShortcut(static_cast<uint16_t>(bit | kCrouchBitL3), false, CrouchShortcut::L3);
                t.Equals(static_cast<int>(r.mask), static_cast<int>(bit | kCrouchBitTriangle), "and rides along with the shortcut unchanged");
            }

            r = applyCrouchShortcut(static_cast<uint16_t>(kCrouchBitL3 | kCrouchBitTriangle), false, CrouchShortcut::L3);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitTriangle), "the pad's own Triangle with the shortcut: still one Triangle");
            t.Equals(static_cast<int>(r.trianglePressure), 0xFF, "and the real, full press wins -- prone stays reachable");
            r = applyCrouchShortcut(kCrouchBitTriangle, false, CrouchShortcut::L3);
            t.Equals(static_cast<int>(r.trianglePressure), 0xFF, "the pad's own Triangle alone is a full press under every option");
        });

        tc.Run("l2: the trigger is a light Triangle instead of L2", [](TestCase &t)
        {
            HostPadButtons r = applyCrouchShortcut(kCrouchBitL2, false, CrouchShortcut::L2);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitTriangle), "down: Triangle, and NOT L2");
            t.Equals(static_cast<int>(r.trianglePressure), static_cast<int>(kCrouchShortcutPressure), "light");
            r = applyCrouchShortcut(kCrouchBitL3, false, CrouchShortcut::L2);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitL3), "L3 is still L3: only the chosen control is taken");
            r = applyCrouchShortcut(0u, false, CrouchShortcut::L2);
            t.Equals(static_cast<int>(r.mask), 0, "up: released");
        });

        tc.Run("touchpad: the click adds a light Triangle and takes nothing away", [](TestCase &t)
        {
            HostPadButtons r = applyCrouchShortcut(0u, true, CrouchShortcut::Touchpad);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitTriangle), "down: Triangle");
            t.Equals(static_cast<int>(r.trianglePressure), static_cast<int>(kCrouchShortcutPressure), "light");
            r = applyCrouchShortcut(0u, false, CrouchShortcut::Touchpad);
            t.Equals(static_cast<int>(r.mask), 0, "up: released");
            r = applyCrouchShortcut(static_cast<uint16_t>(kCrouchBitL3 | kCrouchBitL2), true, CrouchShortcut::Touchpad);
            t.Equals(static_cast<int>(r.mask), static_cast<int>(kCrouchBitL3 | kCrouchBitL2 | kCrouchBitTriangle), "L3 and L2 keep their own buttons");
            r = applyCrouchShortcut(0u, true, CrouchShortcut::L3);
            t.Equals(static_cast<int>(r.mask), 0, "and the touchpad does nothing under another option");
        });

        tc.Run("a full Triangle from any other source wins, so the harness's injected pad is unaffected", [](TestCase &t)
        {
            t.Equals(static_cast<int>(trianglePressureFor(false, true)), static_cast<int>(kCrouchShortcutPressure), "only the shortcut: light");
            t.Equals(static_cast<int>(trianglePressureFor(true, true)), 0xFF, "the keyboard, a script or the injected file as well: full");
            t.Equals(static_cast<int>(trianglePressureFor(true, false)), 0xFF, "a full source alone: full");
            t.Equals(static_cast<int>(trianglePressureFor(false, false)), 0xFF, "nobody: the default the state has always carried");
        });

        tc.Run("the HLE reports the state's Triangle pressure and 0xFF for every other button", [](TestCase &t)
        {
            ps2_stubs::Socom2PadState pad;
            t.Equals(static_cast<int>(pad.trianglePressure), 0xFF, "a fresh state is a full Triangle: the default is today's");
            for (int field = 0; field < 12; ++field)
                t.Equals(static_cast<int>(ps2_stubs::socom2PressureOf(pad, field)), 0, "up is 0");
            for (int id = 0; id < 16; ++id)
                pad.button[id] = 1u;
            for (int field = 0; field < 12; ++field)
                t.Equals(static_cast<int>(ps2_stubs::socom2PressureOf(pad, field)), 0xFF, "down is 0xFF, Triangle included, by default");
            pad.trianglePressure = kCrouchShortcutPressure;
            for (int field = 0; field < 12; ++field)
            {
                const bool triangle = ps2_stubs::kSocom2PressureButton[field] == ps2_stubs::kPadTriangle;
                t.Equals(static_cast<int>(ps2_stubs::socom2PressureOf(pad, field)),
                         triangle ? static_cast<int>(kCrouchShortcutPressure) : 0xFF,
                         triangle ? "the light Triangle reaches the game" : "and no other pressure moves");
            }
            t.Equals(static_cast<int>(ps2_stubs::socom2PressureOf(pad, 12)), 0, "out of range is 0");
        });
    });
}
