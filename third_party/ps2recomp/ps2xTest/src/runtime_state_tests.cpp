// Sprint 11 Task 8b: the per-subsystem *RuntimeState split, adapted from the MrCoolTheCucumber fork.
//
// docs/KNOWN.md #4: Kernel/Stubs/Helpers/Support.h defined its state in an anonymous namespace, so
// each of the nineteen stub translation units that pull it in through Stubs/Common.h got its own
// private copy. 955539c moved the whole 2041-line header to a .cpp in one go -- one definition
// instead of nineteen -- the C++ suite stayed green, and the gate's mission stage then never
// reached the HUD. It was reverted.
//
// The shape that makes the same move safe is the fork's: one named struct per subsystem, OWNED BY
// the PS2Runtime the stub was called with. These cases are what pins that ownership. Each drives a
// stub compiled in a DIFFERENT translation unit with TWO PS2Runtime instances and asserts that
//   (a) the stub reached the state of the runtime it was handed, and
//   (b) the other runtime saw none of it.
// Process-global state -- an anonymous namespace per TU, or the single function-local static this
// task's first pass used -- fails (b) or (a) respectively, which is exactly what a regression to
// either would look like.

#include "MiniTest.h"
#include "ps2_runtime.h"
#include "ps2_runtime_macros.h"
#include "ps2_stubs.h"
#include "Kernel/Stubs/Unimplemented.h"
#include "Kernel/Stubs/DMA.h"
#include "Kernel/Stubs/GS.h"
#include "Kernel/Stubs/LibC.h"
#include "Kernel/Stubs/Helpers/StubLogRuntimeState.h"
#include "Kernel/Stubs/Helpers/DmaRuntimeState.h"
#include "Kernel/Stubs/Helpers/GsRuntimeState.h"
#include "Kernel/Stubs/Helpers/LibCRuntimeState.h"
#include "Kernel/Syscalls/System.h"   // Sprint 17 Q2: the boot-argument block, SetupThread
#include "Kernel/Syscalls/Thread.h"   // Sprint 17 Q2: LoadExecPS2 and its ELF-name decision
#include "Kernel/Syscalls/RPC.h"      // Sprint 17 Q2: the IOP module table
#include "runtime/ee_scheduler.h"

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
    // Stub names no other test uses, so the counters' values are ours alone.
    const char *const kProbeStubName = "s11t8b_probe_stub";
    const char *const kResetProbeStubName = "s11t8b_reset_probe_stub";

    constexpr uint32_t kVif1ChannelBase = 0x10009000u;

    void setRegU32(R5900Context &ctx, int reg, uint32_t value)
    {
        ctx.r[reg] = _mm_set_epi64x(0, static_cast<int64_t>(value));
    }

    void markDmaChannelPending(PS2Runtime &runtime, uint32_t channelBase)
    {
        ps2_stubs::DmaRuntimeState &state = runtime.dmaRuntimeState();
        std::lock_guard<std::mutex> lock(state.mutex);
        state.pendingPolls[channelBase] = 1u;
    }

    bool dmaChannelPending(PS2Runtime &runtime, uint32_t channelBase)
    {
        ps2_stubs::DmaRuntimeState &state = runtime.dmaRuntimeState();
        std::lock_guard<std::mutex> lock(state.mutex);
        auto it = state.pendingPolls.find(channelBase);
        return it != state.pendingPolls.end() && it->second > 0;
    }

    uint32_t registerGuestFile(PS2Runtime &runtime, FILE *file)
    {
        ps2_stubs::LibCRuntimeState &state = runtime.libcRuntimeState();
        std::lock_guard<std::mutex> lock(state.mutex);
        const uint32_t handle = state.allocateHandleLocked();
        state.openFiles[handle] = file;
        return handle;
    }

    bool guestFileOpen(PS2Runtime &runtime, uint32_t handle)
    {
        ps2_stubs::LibCRuntimeState &state = runtime.libcRuntimeState();
        std::lock_guard<std::mutex> lock(state.mutex);
        return state.openFiles.count(handle) != 0;
    }

    uint32_t stubWarningsFor(PS2Runtime &runtime, const char *name)
    {
        ps2_stubs::StubLogRuntimeState &state = runtime.stubLogRuntimeState();
        std::lock_guard<std::mutex> lock(state.warningMutex);
        auto it = state.warningCount.find(name);
        return (it != state.warningCount.end()) ? it->second : 0u;
    }
}

// Sprint 17 Task Q2: LoadExecPS2 as an in-process restart of the guest (D3).
//
// Leaving SOCOM Online is the game's own LoadExecPS2("cdrom0:\SCUS_972.75;1", 3, {"--menu_state",
// "dlgAfterErrorReboot.rdr", ""}) from 0x22ED54 (docs/research/78-back-to-the-main-menu.md). On the console the
// kernel reloads the ELF and the crt0 hands main() the arguments; this runtime used to exit 74.
//
// What the guest reads after a boot (game/analysis/SCUS_972.75.decomp.c, cited by address):
//   - the crt0 `entry` zeroes the bss, calls SetupThread (syscall 0x3C) with its own argument block `_args` at
//     0x1D5800 as $a3, then calls main(argc = *0x1D5800, argv = 0x1D5804) (FUN_001c4cc0);
//   - main() keeps argv[0] as the program name (PTR_DAT_001ce650) and reads argc-1 options from argv+1, so the
//     kernel's argv[0] is the ELF path LoadExecPS2 was given and the request's own arguments follow it;
//   - the SDK's SetArg (0x1ACCF8) writes the request into the kernel's boot-argument area, the block syscall 0x5B
//     answers for entry 3 (_InitSys caches it at 0x1CD0F0): a pointer to the filename at base+0, the argv
//     pointers at base+4*(i+1), the strings from base+0x40.
// So the restart rewrites the kernel block from the decoded request at the same 0x5B address, and the runtime's
// SetupThread copies it into the crt0's block, which is the path main() reads.
namespace
{
    namespace fs = std::filesystem;

    constexpr uint32_t kQ2Entry = 0x00100000u;
    constexpr uint32_t kQ2SegmentBytes = 32u;
    constexpr uint32_t kQ2SegmentMemBytes = 64u;
    // Where this test's crt0 keeps its argument block (SOCOM II's is at 0x1D5800; any address in RAM does).
    constexpr uint32_t kQ2Crt0ArgsAddr = 0x00110000u;
    constexpr uint32_t kQ2ModulePathAddr = 0x00002000u;
    constexpr uint32_t kQ2DirtyByteAddr = 0x00300000u;

    void q2Put32(uint8_t *rdram, uint32_t addr, uint32_t value)
    {
        std::memcpy(rdram + (addr & PS2_RAM_MASK), &value, sizeof(value));
    }

    uint32_t q2Get32(const uint8_t *rdram, uint32_t addr)
    {
        uint32_t value = 0;
        std::memcpy(&value, rdram + (addr & PS2_RAM_MASK), sizeof(value));
        return value;
    }

    std::string q2GetStr(const uint8_t *rdram, uint32_t addr)
    {
        std::string out;
        for (uint32_t i = 0; addr != 0u && i < 256u; ++i)
        {
            const char c = static_cast<char>(rdram[(addr + i) & PS2_RAM_MASK]);
            if (!c)
                break;
            out.push_back(c);
        }
        return out;
    }

    void q2PutStr(uint8_t *rdram, uint32_t addr, const std::string &s)
    {
        std::memcpy(rdram + (addr & PS2_RAM_MASK), s.c_str(), s.size() + 1u);
    }

    // A MIPS ET_EXEC with one PT_LOAD segment: 32 bytes of a pattern at kQ2Entry, 64 bytes in memory (the rest
    // zeroed bss), exactly the shape PS2Runtime::loadELF reads.
    fs::path q2WriteTestElf()
    {
        static int counter = 0;
        const auto ticks = std::chrono::steady_clock::now().time_since_epoch().count();
        const fs::path dir = fs::temp_directory_path() / ("ps2x_q2_" + std::to_string(ticks) + "_" + std::to_string(counter++));
        std::error_code ec;
        fs::create_directories(dir, ec);
        const fs::path elf = dir / "q2_test.elf";

        std::vector<uint8_t> bytes(52u + 32u + kQ2SegmentBytes, 0u);
        auto w16 = [&](size_t at, uint16_t v) { std::memcpy(bytes.data() + at, &v, 2); };
        auto w32 = [&](size_t at, uint32_t v) { std::memcpy(bytes.data() + at, &v, 4); };
        bytes[0] = 0x7F; bytes[1] = 'E'; bytes[2] = 'L'; bytes[3] = 'F';
        bytes[4] = 1;   // ELFCLASS32
        bytes[5] = 1;   // little-endian
        bytes[6] = 1;   // EV_CURRENT
        w16(16, 2);     // ET_EXEC
        w16(18, 8);     // EM_MIPS
        w32(20, 1);     // version
        w32(24, kQ2Entry);
        w32(28, 52);    // phoff
        w32(32, 0);     // shoff
        w32(36, 0);     // flags
        w16(40, 52);    // ehsize
        w16(42, 32);    // phentsize
        w16(44, 1);     // phnum
        // the one program header
        w32(52 + 0, 1);                    // PT_LOAD
        w32(52 + 4, 84);                   // offset
        w32(52 + 8, kQ2Entry);             // vaddr
        w32(52 + 12, kQ2Entry);            // paddr
        w32(52 + 16, kQ2SegmentBytes);     // filesz
        w32(52 + 20, kQ2SegmentMemBytes);  // memsz
        w32(52 + 24, 5);                   // PF_R | PF_X
        w32(52 + 28, 16);                  // align
        for (uint32_t i = 0; i < kQ2SegmentBytes; ++i)
            bytes[84u + i] = static_cast<uint8_t>(0x11u + i);

        std::ofstream out(elf, std::ios::binary | std::ios::trunc);
        out.write(reinterpret_cast<const char *>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        return elf;
    }

    void q2RemoveTestElf(const fs::path &elf)
    {
        std::error_code ec;
        fs::remove_all(elf.parent_path(), ec);
    }

    // The IOP module table gets a row the way the game puts one there: sceSifLoadModule of a path in guest RAM.
    void q2LoadOneIopModule(PS2Runtime &runtime, uint8_t *rdram)
    {
        q2PutStr(rdram, kQ2ModulePathAddr, "host0:/q2/fake_module.irx");
        R5900Context ctx{};
        setRegU32(ctx, 4, kQ2ModulePathAddr);
        ps2_syscalls::SifLoadModule(rdram, &ctx, &runtime);
    }

    // The crt0's SetupThread(gp, stack, stack_size, args, root): $a3 is the block the kernel fills.
    void q2Crt0SetupThread(PS2Runtime &runtime, uint8_t *rdram)
    {
        R5900Context ctx{};
        setRegU32(ctx, 4, 0x00108000u);      // gp
        setRegU32(ctx, 5, 0xFFFFFFFFu);      // stack: the top of RAM
        setRegU32(ctx, 6, 0x00080000u);      // stack size, as SOCOM II's crt0 passes it
        setRegU32(ctx, 7, kQ2Crt0ArgsAddr);  // args
        setRegU32(ctx, 29, PS2_RAM_SIZE - 0x10u);
        ps2_syscalls::SetupThread(rdram, &ctx, &runtime);
    }
}

void register_runtime_state_tests()
{
    MiniTest::Case("Kernel stub runtime state (Sprint 11 Task 8b)", [](TestCase &tc)
    {
        tc.Run("Stubs/Unimplemented.cpp bumps the stub-warning counter of the runtime it was handed", [](TestCase &t)
        {
            PS2Runtime first;
            PS2Runtime second;

            // TODO_NAMED lives in Stubs/Unimplemented.cpp -- a different translation unit. Its
            // first kMaxStubWarningsPerName calls bump the counter and then throw.
            R5900Context ctx{};
            bool threw = false;
            try
            {
                ps2_stubs::TODO_NAMED(kProbeStubName, nullptr, &ctx, &first);
            }
            catch (const std::runtime_error &)
            {
                threw = true;
            }
            t.IsTrue(threw, "TODO_NAMED should still throw on an unimplemented stub");

            t.Equals(stubWarningsFor(first, kProbeStubName), 1u,
                     "the counter of the runtime the stub was called with should hold that call; "
                     "0 means Stubs/Unimplemented.cpp bumped process-wide state instead of this "
                     "runtime's (docs/KNOWN.md #4)");
            t.Equals(stubWarningsFor(second, kProbeStubName), 0u,
                     "a second runtime in the same process must not see the first one's "
                     "stub-warning count");
        });

        tc.Run("Stubs/DMA.cpp's sceDmaSync reads the pending-poll map of the runtime it was handed", [](TestCase &t)
        {
            PS2Runtime first;
            PS2Runtime second;

            markDmaChannelPending(first, kVif1ChannelBase);

            // sceDmaSync lives in Stubs/DMA.cpp -- a different translation unit. Non-blocking mode
            // ($a1 != 0) reports the transfer busy once and consumes the mark.
            R5900Context ctx{};
            setRegU32(ctx, 4, kVif1ChannelBase);
            setRegU32(ctx, 5, 1u);

            ps2_stubs::sceDmaSync(nullptr, &ctx, &second);
            t.Equals(getRegU32(&ctx, 2), 0u,
                     "a second runtime in the same process must not see the transfer the first one "
                     "has in flight");
            t.IsTrue(dmaChannelPending(first, kVif1ChannelBase),
                     "and it must not consume the first runtime's pending mark either");

            ps2_stubs::sceDmaSync(nullptr, &ctx, &first);
            t.Equals(getRegU32(&ctx, 2), 1u,
                     "sceDmaSync should report busy for the channel THIS runtime marked pending; "
                     "0 means Stubs/DMA.cpp read process-wide state instead of the runtime's "
                     "(docs/KNOWN.md #4)");
            t.IsFalse(dmaChannelPending(first, kVif1ChannelBase),
                      "and it should have consumed that runtime's mark");
        });

        tc.Run("Stubs/DMA.cpp's sceDmaReset clears only its own runtime's DMA state", [](TestCase &t)
        {
            PS2Runtime first;
            PS2Runtime second;
            // sceDmaReset writes the DMAC's control registers, so this pair needs real memory.
            t.IsTrue(first.memory().initialize(), "runtime memory initialize should succeed");
            markDmaChannelPending(first, kVif1ChannelBase);
            markDmaChannelPending(second, kVif1ChannelBase);
            first.dmaRuntimeState().currentEnvironment.pcr = 0xFFu;
            second.dmaRuntimeState().currentEnvironment.pcr = 0xFFu;

            R5900Context ctx{};
            ps2_stubs::sceDmaReset(nullptr, &ctx, &first);

            t.IsFalse(dmaChannelPending(first, kVif1ChannelBase),
                      "a controller reset means no transfer is in flight, so sceDmaReset clears "
                      "the pending-poll map as well as the environment block");
            t.Equals(static_cast<uint32_t>(first.dmaRuntimeState().currentEnvironment.pcr), 0u,
                     "sceDmaReset should clear its runtime's environment block");
            t.IsTrue(dmaChannelPending(second, kVif1ChannelBase),
                     "and it must leave a second runtime's DMA state alone");
            t.Equals(static_cast<uint32_t>(second.dmaRuntimeState().currentEnvironment.pcr), 0xFFu,
                     "including that runtime's environment block");
        });

        tc.Run("Stubs/GS.cpp's sceGsResetGraph writes the GParam of the runtime it was handed", [](TestCase &t)
        {
            PS2Runtime first;
            PS2Runtime second;
            // sceGsResetGraph's mode-0 path runs syncCoreSubsystems and kicks a GIF packet, so
            // this pair needs real memory.
            t.IsTrue(first.memory().initialize(), "runtime memory initialize should succeed");

            R5900Context ctx{};
            setRegU32(ctx, 4, 0u);    // $a0 = mode 0
            setRegU32(ctx, 5, 1u);    // $a1 = interlace
            setRegU32(ctx, 6, 3u);    // $a2 = omode  (3, not the default 2)
            setRegU32(ctx, 7, 0u);    // $a3 = ffmode (0, not the default 1)
            ps2_stubs::sceGsResetGraph(nullptr, &ctx, &first);

            t.Equals(static_cast<uint32_t>(first.gsRuntimeState().gparam.omode), 3u,
                     "the GParam of the runtime the stub was called with should hold the omode "
                     "Stubs/GS.cpp just stored; 2 (the default) means that TU wrote process-wide "
                     "state instead of this runtime's (docs/KNOWN.md #4)");
            t.Equals(static_cast<uint32_t>(first.gsRuntimeState().gparam.ffmode), 0u,
                     "sceGsResetGraph's ffmode should have reached that runtime's state");
            t.Equals(static_cast<uint32_t>(second.gsRuntimeState().gparam.omode), 2u,
                     "a second runtime in the same process must keep its own video mode");
            t.Equals(static_cast<uint32_t>(second.gsRuntimeState().gparam.ffmode), 1u,
                     "including its own field mode");
        });

        tc.Run("Stubs/LibC.cpp's fclose closes the handle in the runtime it was handed", [](TestCase &t)
        {
            FILE *first_fp = std::tmpfile();
            FILE *second_fp = std::tmpfile();
            t.IsTrue(first_fp != nullptr && second_fp != nullptr,
                     "the host should give this test two temporary FILEs to hand over");
            if (!first_fp || !second_fp)
                return;

            PS2Runtime first;
            PS2Runtime second;
            // Both runtimes hand out handle 1, for two different host files. That is the whole
            // point: one shared table could not.
            const uint32_t firstHandle = registerGuestFile(first, first_fp);
            const uint32_t secondHandle = registerGuestFile(second, second_fp);
            t.Equals(firstHandle, secondHandle,
                     "each runtime numbers its own guest files from 1");

            R5900Context ctx{};
            setRegU32(ctx, 4, firstHandle);
            ps2_stubs::fclose(nullptr, &ctx, &first);

            t.Equals(static_cast<int32_t>(getRegU32(&ctx, 2)), 0,
                     "fclose should have found the handle registered with THIS runtime; EOF means "
                     "Stubs/LibC.cpp searched process-wide state instead (docs/KNOWN.md #4)");
            t.IsFalse(guestFileOpen(first, firstHandle),
                      "fclose should have erased the handle from that runtime's table");
            t.IsTrue(guestFileOpen(second, secondHandle),
                     "and it must not touch a second runtime's file of the same handle number");
        });

        tc.Run("Stubs/LibC.cpp's rand keeps its cursor in the runtime it was handed", [](TestCase &t)
        {
            PS2Runtime first;
            PS2Runtime second;

            // With no registered guest _impure_ptr the pair runs off the runtime's own fallback
            // cursor, so two runtimes seeded the same way must produce the same first number and
            // then diverge only because each advanced its own.
            R5900Context ctx{};
            setRegU32(ctx, 4, 12345u);
            ps2_stubs::srand(nullptr, &ctx, &first);
            ps2_stubs::rand(nullptr, &ctx, &first);
            const uint32_t firstDraw = getRegU32(&ctx, 2);

            setRegU32(ctx, 4, 12345u);
            ps2_stubs::srand(nullptr, &ctx, &second);
            ps2_stubs::rand(nullptr, &ctx, &second);
            const uint32_t secondDraw = getRegU32(&ctx, 2);

            t.Equals(secondDraw, firstDraw,
                     "the same seed in a fresh runtime should give the same first draw");

            ps2_stubs::rand(nullptr, &ctx, &first);
            const uint32_t firstSecondDraw = getRegU32(&ctx, 2);
            ps2_stubs::rand(nullptr, &ctx, &second);
            t.Equals(getRegU32(&ctx, 2), firstSecondDraw,
                     "and each runtime should advance its OWN cursor; a differing second draw "
                     "means Stubs/LibC.cpp shares one process-wide rand cursor");
        });

        tc.Run("PS2Runtime::resetStubRuntimeState, which run() calls, clears every subsystem's session state", [](TestCase &t)
        {
            PS2Runtime runtime;
            R5900Context ctx{};

            // StubLog: a warning count put there by the stub in Stubs/Unimplemented.cpp, and a
            // printf budget partly spent.
            try
            {
                ps2_stubs::TODO_NAMED(kResetProbeStubName, nullptr, &ctx, &runtime);
            }
            catch (const std::runtime_error &)
            {
            }
            {
                ps2_stubs::StubLogRuntimeState &log = runtime.stubLogRuntimeState();
                std::lock_guard<std::mutex> lock(log.printfMutex);
                log.printfLogCount = 7u;
            }
            t.Equals(stubWarningsFor(runtime, kResetProbeStubName), 1u,
                     "the stub-warning count should be set before the reset");

            // GS: a video mode that is not the default {1, 2, 1, 3}.
            runtime.gsRuntimeState().gparam = ps2_stubs::GsGParam{0, 3, 0, 3};

            // DMA: a transfer in flight.
            markDmaChannelPending(runtime, kVif1ChannelBase);

            // libc: an open guest FILE, and the rand registration the game override installs
            // during loadELF -- which runs BEFORE run().
            FILE *fp = std::tmpfile();
            t.IsTrue(fp != nullptr, "the host should give this test a temporary FILE");
            if (!fp)
                return;
            const uint32_t handle = registerGuestFile(runtime, fp);
            ps2_stubs::setLibcRandState(&runtime, 0x6000u, 0xA8u);

            runtime.resetStubRuntimeState();

            t.Equals(stubWarningsFor(runtime, kResetProbeStubName), 0u,
                     "resetStubRuntimeState should clear the stub-warning counts; a non-zero count "
                     "means StubLogRuntimeState::reset() never ran");
            {
                ps2_stubs::StubLogRuntimeState &log = runtime.stubLogRuntimeState();
                std::lock_guard<std::mutex> lock(log.printfMutex);
                t.Equals(log.printfLogCount, 0u,
                         "and it should give the run a fresh PS2-printf budget");
            }
            t.Equals(static_cast<uint32_t>(runtime.gsRuntimeState().gparam.omode), 2u,
                     "the GParam should be back to the default video mode; 3 means "
                     "GsRuntimeState::reset() never ran");
            t.Equals(static_cast<uint32_t>(runtime.gsRuntimeState().gparam.ffmode), 1u,
                     "including the default field mode");
            t.IsFalse(dmaChannelPending(runtime, kVif1ChannelBase),
                      "a new run starts with no DMA transfer in flight");
            t.IsFalse(guestFileOpen(runtime, handle),
                      "and with no guest FILE open; a surviving handle means "
                      "LibCRuntimeState::reset() never ran");

            // What the reset must NOT clear: the registration is the override's, installed before
            // run(), and wiping it would drop rand() back to its internal cursor.
            {
                ps2_stubs::LibCRuntimeState &libc = runtime.libcRuntimeState();
                std::lock_guard<std::mutex> lock(libc.randMutex);
                t.Equals(libc.impurePtrAddr, 0x6000u,
                         "the game override's _impure_ptr registration must survive the run-path "
                         "reset -- applySocom2 installs it inside loadELF, before run()");
                t.Equals(libc.randNextOffset, 0xA8u,
                         "and so must the _rand_next offset beside it");
            }
        });
    });

    MiniTest::Case("Guest restart: LoadExecPS2 in-process (Sprint 17 Q2)", [](TestCase &tc)
    {
        tc.Run("a requested restart reloads the ELF, zeroes RAM, resets the kernel and hands the crt0 the arguments", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *rdram = runtime.memory().getRDRAM();
            const fs::path elf = q2WriteTestElf();

            // The old guest's state: a loaded IRX, a byte of its RAM, a stale kernel block.
            q2LoadOneIopModule(runtime, rdram);
            t.IsTrue(ps2_syscalls::SifLoadedModuleCount() >= 1u, "the IOP module table holds the module the old guest loaded");
            rdram[kQ2DirtyByteAddr] = 0xABu;
            const uint32_t block = ps2_syscalls::bootArgumentBlockAddress();
            q2Put32(rdram, block, 0xDEADBEEFu);

            const std::vector<std::string> argv{"--menu_state", "x.rdr", ""};
            t.IsTrue(runtime.requestGuestRestart(elf.string(), argv, "cdrom0:\\Q2_TEST.ELF;1"), "the first request is taken");
            t.IsTrue(runtime.guestRestartPending(), "and is pending until the loop thread performs it");
            t.IsTrue(runtime.restartGuest(), "restartGuest performs the pending request");
            t.IsFalse(runtime.guestRestartPending(), "which is then no longer pending");
            t.Equals(runtime.guestRestartCount(), static_cast<uint64_t>(1u), "one restart performed");

            // Guest RAM: zeroed, then the ELF reloaded through the same loader main() uses.
            t.Equals(static_cast<uint32_t>(rdram[kQ2DirtyByteAddr]), 0u, "the old guest's RAM is gone");
            t.Equals(static_cast<uint32_t>(rdram[kQ2Entry]), 0x11u, "the ELF's first segment byte is back at its vaddr");
            t.Equals(static_cast<uint32_t>(rdram[kQ2Entry + kQ2SegmentBytes - 1u]), 0x11u + kQ2SegmentBytes - 1u, "and its last");
            t.Equals(static_cast<uint32_t>(rdram[kQ2Entry + kQ2SegmentBytes]), 0u, "the bss past filesz is zero");
            t.Equals(runtime.cpu().pc, kQ2Entry, "the CPU restarts at the ELF's entry");

            // The kernel's boot-argument area, in SetArg's layout at the address syscall 0x5B answers for entry 3:
            // argc=3 worth of argv pointers at base+4*(i+1), the strings from base+0x40, a null after the third.
            t.Equals(q2Get32(rdram, block), block + 0x40u, "base+0 points at the filename copy at base+0x40 (SetArg's layout)");
            t.Equals(q2GetStr(rdram, block + 0x40u), std::string("cdrom0:\\Q2_TEST.ELF;1"), "the filename is the guest's own request path");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, block + 4u)), std::string("--menu_state"), "argv[0] pointer at base+4");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, block + 8u)), std::string("x.rdr"), "argv[1] pointer at base+8");
            t.IsTrue(q2Get32(rdram, block + 12u) != 0u, "argv[2] pointer at base+12 is set");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, block + 12u)), std::string(""), "and names the empty string");
            t.Equals(q2Get32(rdram, block + 16u), 0u, "no fourth argument: argc is 3");

            // The crt0's block, through the same syscall the crt0 uses: SetupThread's $a3. main() reads argc-1
            // options from argv+1, so argc counts the program name the kernel puts at argv[0].
            q2Crt0SetupThread(runtime, rdram);
            t.Equals(q2Get32(rdram, kQ2Crt0ArgsAddr), 4u, "argc is 1 + 3: the program name and the three arguments");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, kQ2Crt0ArgsAddr + 4u)), std::string("cdrom0:\\Q2_TEST.ELF;1"), "argv[0] is the program");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, kQ2Crt0ArgsAddr + 8u)), std::string("--menu_state"), "argv[1]");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, kQ2Crt0ArgsAddr + 12u)), std::string("x.rdr"), "argv[2]");
            t.IsTrue(q2Get32(rdram, kQ2Crt0ArgsAddr + 16u) != 0u, "argv[3] is a real pointer");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, kQ2Crt0ArgsAddr + 16u)), std::string(""), "to the empty string");
            t.Equals(q2Get32(rdram, kQ2Crt0ArgsAddr + 20u), 0u, "argv[4] is the null terminator");
            const uint32_t firstString = q2Get32(rdram, kQ2Crt0ArgsAddr + 4u);
            t.IsTrue(firstString >= kQ2Crt0ArgsAddr + 0x44u && firstString < kQ2Crt0ArgsAddr + 0x44u + 256u,
                     "the strings live inside the crt0 block's own payload (4 + 16*4 pointers, then 256 bytes)");

            // The rest of the machine.
            t.Equals(runtime.eeScheduler().currentVSyncTick(), static_cast<uint64_t>(0u), "the scheduler's VBlank tick is 0");
            t.Equals(ps2_syscalls::SifLoadedModuleCount(), static_cast<size_t>(0u), "the IOP module table is empty: the boot re-loads the IRXs");
            t.Equals(runtime.audioBackend().mixerActiveHandlers(), static_cast<size_t>(0u), "the mixer has no live handler");
            t.Equals(runtime.audioBackend().mixerActiveStreams(), static_cast<size_t>(0u), "no live stream");
            t.Equals(runtime.audioBackend().mixerActiveVoices(), static_cast<size_t>(0u), "no live voice");
            t.IsFalse(runtime.audioBackend().mixerPcmStreamActive(), "and no PCM ring playing");
            q2RemoveTestElf(elf);
        });

        tc.Run("argc=0: a restart with no arguments hands the crt0 the program name alone and faults nothing", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *rdram = runtime.memory().getRDRAM();
            const fs::path elf = q2WriteTestElf();

            t.IsTrue(runtime.requestGuestRestart(elf.string(), {}), "the request with argc=0 is taken");
            bool threw = false;
            bool performed = false;
            try
            {
                performed = runtime.restartGuest();
            }
            catch (...)
            {
                threw = true;
            }
            t.IsFalse(threw, "argc=0 must not fault the restart (Review Focus 3)");
            t.IsTrue(performed, "and the restart is performed");

            const uint32_t block = ps2_syscalls::bootArgumentBlockAddress();
            t.Equals(q2Get32(rdram, block), block + 0x40u, "the kernel block still points at the filename");
            t.Equals(q2GetStr(rdram, block + 0x40u), std::string("q2_test.elf"), "which defaults to the ELF's own name when the guest path is not given");
            t.Equals(q2Get32(rdram, block + 4u), 0u, "and carries no argv pointer: argc is 0 at the block");

            q2Crt0SetupThread(runtime, rdram);
            t.Equals(q2Get32(rdram, kQ2Crt0ArgsAddr), 1u, "argc is 1: the program name alone, as the kernel hands a bare boot");
            t.Equals(q2GetStr(rdram, q2Get32(rdram, kQ2Crt0ArgsAddr + 4u)), std::string("q2_test.elf"), "argv[0] is the program");
            t.Equals(q2Get32(rdram, kQ2Crt0ArgsAddr + 8u), 0u, "argv[1] is the null terminator");
            t.Equals(runtime.eeScheduler().currentVSyncTick(), static_cast<uint64_t>(0u), "the scheduler's VBlank tick is 0");
            q2RemoveTestElf(elf);
        });

        tc.Run("a restart requested twice before the first completes performs one", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            const fs::path elf = q2WriteTestElf();

            t.IsTrue(runtime.requestGuestRestart(elf.string(), {"--menu_state", "first.rdr"}), "the first request is taken");
            t.IsFalse(runtime.requestGuestRestart(elf.string(), {"--menu_state", "second.rdr"}), "the second, before the first completes, is refused");
            const PS2Runtime::GuestRestartRequest pending = runtime.guestRestartRequest();
            t.Equals(pending.argv.size(), static_cast<size_t>(2u), "the pending request is the first one's");
            t.Equals(pending.argv[1], std::string("first.rdr"), "with its own arguments");

            t.IsTrue(runtime.restartGuest(), "one restart is performed");
            t.IsFalse(runtime.restartGuest(), "and there is nothing left to perform");
            t.Equals(runtime.guestRestartCount(), static_cast<uint64_t>(1u), "exactly one");
            t.IsTrue(runtime.requestGuestRestart(elf.string(), {}), "after it completed a new request is taken again");
            q2RemoveTestElf(elf);
        });

        tc.Run("the LoadExecPS2 decision: the game's own ELF restarts, a foreign path keeps exit 74", [](TestCase &t)
        {
            using ps2_syscalls::loadExecTargetsLoadedElf;
            t.IsTrue(loadExecTargetsLoadedElf("cdrom0:\\SCUS_972.75;1", "socom2_game.elf"), "the disc's SCUS_972.75 is the r0001 ELF the runtime booted");
            t.IsTrue(loadExecTargetsLoadedElf("cdrom0:\\SCUS_972.75;1", "socom2_game_r0004.elf"), "and the r0004 one (issue #69: every revision's ELF is SOCOM II)");
            t.IsTrue(loadExecTargetsLoadedElf("cdrom0:\\scus_972.75;1", "SOCOM2_GAME.ELF"), "case does not matter on either side");
            t.IsTrue(loadExecTargetsLoadedElf("cdrom0:\\Q2_TEST.ELF;1", "q2_test.elf"), "a path naming the loaded ELF's own file name restarts too");
            t.IsTrue(loadExecTargetsLoadedElf("host0:/x/y/q2_test.elf", "q2_test.elf"), "whatever the device and directories");
            t.IsFalse(loadExecTargetsLoadedElf("rom0:OSDSYS", "socom2_game.elf"), "the browser is a foreign ELF: 74 stays honest");
            t.IsFalse(loadExecTargetsLoadedElf("cdrom0:\\SCUS_972.75;1", "other_game.elf"), "SCUS_972.75 is not another game's ELF");
            t.IsFalse(loadExecTargetsLoadedElf("cdrom0:\\NETGUI.ELF;1", "socom2_game.elf"), "the network GUI is foreign");
            t.IsFalse(loadExecTargetsLoadedElf("", "socom2_game.elf"), "an empty path is foreign");
            t.IsFalse(loadExecTargetsLoadedElf("cdrom0:\\SCUS_972.75;1", ""), "and so is a runtime that booted nothing");
        });

        tc.Run("LoadExecPS2 with the loaded ELF's path requests the restart and stops the scheduler instead of exiting", [](TestCase &t)
        {
            PS2Runtime runtime;
            t.IsTrue(runtime.memory().initialize(), "runtime memory initialize should succeed");
            uint8_t *rdram = runtime.memory().getRDRAM();
            const fs::path elf = q2WriteTestElf();
            PS2Runtime::configureIoPathsFromElf(elf.string());   // what loadELF records: the ELF the runtime booted

            // The game's request as SetArg laid it out: the path, argc=2, the pointer table.
            constexpr uint32_t kPath = 0x00003000u, kArg0 = 0x00003100u, kArg1 = 0x00003200u, kTable = 0x00003300u;
            q2PutStr(rdram, kPath, "cdrom0:\\Q2_TEST.ELF;1");
            q2PutStr(rdram, kArg0, "--menu_state");
            q2PutStr(rdram, kArg1, "dlgAfterErrorReboot.rdr");
            q2Put32(rdram, kTable, kArg0);
            q2Put32(rdram, kTable + 4u, kArg1);
            R5900Context ctx{};
            setRegU32(ctx, 4, kPath);
            setRegU32(ctx, 5, 2u);
            setRegU32(ctx, 6, kTable);
            setRegU32(ctx, 29, PS2_RAM_SIZE - 0x10u);

            bool transferred = false;
            try
            {
                ps2_syscalls::LoadExecPS2(rdram, &ctx, &runtime);
            }
            catch (const EeDispatcherTransfer &)
            {
                transferred = true;   // the requesting thread never returns from LoadExecPS2: it unwinds to the dispatcher
            }
            t.IsTrue(transferred, "the handler leaves the guest through the dispatcher, not through std::exit");
            t.IsTrue(runtime.guestRestartPending(), "and the restart is pending for the loop thread");
            const PS2Runtime::GuestRestartRequest request = runtime.guestRestartRequest();
            std::error_code eqEc;
            t.IsTrue(fs::equivalent(fs::path(request.elfPath), elf, eqEc), "the host ELF to reload is the one the runtime booted");
            t.Equals(fs::path(request.elfPath).filename().string(), std::string("q2_test.elf"), "by name too");
            t.Equals(request.guestPath, std::string("cdrom0:\\Q2_TEST.ELF;1"), "the guest's own path is kept for argv[0]");
            t.Equals(request.argv.size(), static_cast<size_t>(2u), "with the request's two arguments");
            t.Equals(request.argv[0], std::string("--menu_state"), "argv[0]");
            t.Equals(request.argv[1], std::string("dlgAfterErrorReboot.rdr"), "argv[1]");
            q2RemoveTestElf(elf);
        });
    });
}
