#include "Common.h"
#include <cstring>
#include <mutex>
#include <unordered_set>
#include "System.h"

namespace ps2_syscalls
{
    void GsSetCrt(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        int interlaced = getRegU32(ctx, 4); // $a0 - 0=non-interlaced, 1=interlaced
        int videoMode = getRegU32(ctx, 5);  // $a1 - 0=NTSC, 1=PAL, 2=VESA, 3=HiVision
        int frameMode = getRegU32(ctx, 6);  // $a2 - 0=field, 1=frame

        if (runtime)
        {
            auto &gs = runtime->memory().gs();
            const uint64_t smode2 =
                (static_cast<uint64_t>(interlaced) & 0x1ull) |
                ((static_cast<uint64_t>(frameMode) & 0x1ull) << 1);

            gs.smode2 = smode2;

            // Keep CRT1 enabled after the BIOS syscall selects a display mode.
            if ((gs.pmode & 0x3ull) == 0ull)
            {
                gs.pmode |= 0x1ull;
            }
        }

        RUNTIME_LOG("PS2 GsSetCrt: interlaced=" << interlaced
                                                << ", videoMode=" << videoMode
                                                << ", frameMode=" << frameMode << std::endl);

        setReturnS32(ctx, 0);
    }

    void SetGsCrt(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        GsSetCrt(rdram, ctx, runtime);
    }

    void GsGetIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint64_t imr = 0;
        if (runtime)
        {
            imr = runtime->memory().gs().imr;
        }

        RUNTIME_LOG("PS2 GsGetIMR: Returning IMR=0x" << std::hex << imr
                                                     << " pc=0x" << ctx->pc
                                                     << " ra=0x" << getRegU32(ctx, 31)
                                                     << std::dec << std::endl);

        setReturnU64(ctx, imr); // Return in $v0/$v1
    }

    void iGsGetIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        GsGetIMR(rdram, ctx, runtime);
    }

    void GsPutIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint64_t newImr = GPR_U64(ctx, 4);
        uint64_t oldImr = 0;
        if (runtime)
        {
            oldImr = runtime->memory().gs().imr;
            runtime->memory().gs().imr = newImr;
        }
        RUNTIME_LOG("PS2 GsPutIMR: " << " new=0x" << newImr
                                     << " a0_64=0x" << GPR_U64(ctx, 4)
                                     << " a0_32=0x" << getRegU32(ctx, 4)
                                     << " a1_32=0x" << getRegU32(ctx, 5)
                                     << " pc=0x" << ctx->pc
                                     << " ra=0x" << getRegU32(ctx, 31)
                                     << std::dec << std::endl);
        setReturnU64(ctx, oldImr);
    }

    void iGsPutIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        GsPutIMR(rdram, ctx, runtime);
    }

    void GsSetVideoMode(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        int mode = getRegU32(ctx, 4); // $a0 - video mode (various flags)

        RUNTIME_LOG("PS2 GsSetVideoMode: mode=0x" << std::hex << mode << std::dec);

        // Do nothing for now.
    }

    void GetOsdConfigParam(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint32_t paramAddr = getRegU32(ctx, 4); // $a0 - pointer to parameter structure

        if (!getMemPtr(rdram, paramAddr))
        {
            std::cerr << "PS2 GetOsdConfigParam error: Invalid parameter address: 0x"
                      << std::hex << paramAddr << std::dec << std::endl;
            setReturnS32(ctx, -1);
            return;
        }

        uint32_t *param = reinterpret_cast<uint32_t *>(getMemPtr(rdram, paramAddr));

        ensureOsdConfigInitialized();
        uint32_t raw;
        {
            std::lock_guard<std::mutex> lock(g_osd_mutex);
            raw = g_osd_config_raw;
        }

        *param = raw;

        setReturnS32(ctx, 0);
    }

    void SetOsdConfigParam(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint32_t paramAddr = getRegU32(ctx, 4); // $a0 - pointer to parameter structure

        if (!getConstMemPtr(rdram, paramAddr))
        {
            std::cerr << "PS2 SetOsdConfigParam error: Invalid parameter address: 0x"
                      << std::hex << paramAddr << std::dec << std::endl;
            setReturnS32(ctx, -1);
            return;
        }

        const uint32_t *param = reinterpret_cast<const uint32_t *>(getConstMemPtr(rdram, paramAddr));
        uint32_t raw = param ? *param : 0;
        raw = sanitizeOsdConfigRaw(raw);
        {
            std::lock_guard<std::mutex> lock(g_osd_mutex);
            g_osd_config_raw = raw;
            g_osd_config2_raw = makeReadableOsdConfig2RawLocked();
            g_osd_config_initialized = true;
        }

        setReturnS32(ctx, 0);
    }

    void SetOsdConfigParam2(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)runtime;
        const uint32_t paramAddr = getRegU32(ctx, 4); // $a0 - Config2Param*
        const uint32_t size = getRegU32(ctx, 5);      // $a1 - sizeof(Config2Param), normally 4

        ensureOsdConfigInitialized();

        if (size == 0u)
        {
            setReturnS32(ctx, 0);
            return;
        }

        uint32_t raw = 0;
        {
            std::lock_guard<std::mutex> lock(g_osd_mutex);
            raw = makeReadableOsdConfig2RawLocked();
        }

        const uint32_t copyBytes = std::min<uint32_t>(size, 4u);
        uint8_t rawBytes[4] = {
            static_cast<uint8_t>(raw & 0xFFu),
            static_cast<uint8_t>((raw >> 8) & 0xFFu),
            static_cast<uint8_t>((raw >> 16) & 0xFFu),
            static_cast<uint8_t>((raw >> 24) & 0xFFu),
        };

        for (uint32_t i = 0; i < copyBytes; ++i)
        {
            const uint8_t *src = getConstMemPtr(rdram, paramAddr + i);
            if (!src)
            {
                std::cerr << "PS2 SetOsdConfigParam2 error: Invalid parameter address: 0x"
                          << std::hex << (paramAddr + i) << std::dec << std::endl;
                setReturnS32(ctx, -1);
                return;
            }
            rawBytes[i] = *src;
        }

        raw = static_cast<uint32_t>(rawBytes[0]) |
              (static_cast<uint32_t>(rawBytes[1]) << 8) |
              (static_cast<uint32_t>(rawBytes[2]) << 16) |
              (static_cast<uint32_t>(rawBytes[3]) << 24);
        raw = sanitizeOsdConfig2Raw(raw);

        {
            std::lock_guard<std::mutex> lock(g_osd_mutex);
            g_osd_config2_raw = raw;

            uint32_t version = (g_osd_config_raw >> 13) & 0x7u;
            uint32_t language = (g_osd_config_raw >> 16) & 0x1Fu;
            if (copyBytes >= 3u)
                version = (raw >> 16) & 0xFFu;
            if (copyBytes >= 4u)
                language = (raw >> 24) & 0xFFu;
            g_osd_config_raw = syncOsdConfigRawVersionLanguage(g_osd_config_raw, version, language);
            g_osd_config_initialized = true;
        }

        setReturnS32(ctx, 0);
    }

    void GetOsdConfigParam2(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)runtime;
        const uint32_t paramAddr = getRegU32(ctx, 4); // $a0 - Config2Param*
        const uint32_t size = getRegU32(ctx, 5);      // $a1 - sizeof(Config2Param), normally 4

        ensureOsdConfigInitialized();

        if (size == 0u)
        {
            setReturnS32(ctx, 0);
            return;
        }

        uint32_t raw = 0;
        {
            std::lock_guard<std::mutex> lock(g_osd_mutex);
            raw = makeReadableOsdConfig2RawLocked();
        }

        const uint8_t rawBytes[4] = {
            static_cast<uint8_t>(raw & 0xFFu),
            static_cast<uint8_t>((raw >> 8) & 0xFFu),
            static_cast<uint8_t>((raw >> 16) & 0xFFu),
            static_cast<uint8_t>((raw >> 24) & 0xFFu),
        };
        const uint32_t copyBytes = std::min<uint32_t>(size, 4u);

        for (uint32_t i = 0; i < copyBytes; ++i)
        {
            uint8_t *dst = getMemPtr(rdram, paramAddr + i);
            if (!dst)
            {
                std::cerr << "PS2 GetOsdConfigParam2 error: Invalid parameter address: 0x"
                          << std::hex << (paramAddr + i) << std::dec << std::endl;
                setReturnS32(ctx, -1);
                return;
            }
            *dst = rawBytes[i];
        }

        setReturnS32(ctx, 0);
    }

    // char *GetRomName(char *romname): copies the 14-byte ROMVER string (no size argument!).
    // Report the US 2004 BIOS ("0200AD20040614"): version 0200, region A, type D, date.
    void GetRomName(uint8_t *rdram, R5900Context *ctx, PS2Runtime *)
    {
        const uint32_t bufAddr = getRegU32(ctx, 4);
        char *hostBuf = reinterpret_cast<char *>(getMemPtr(rdram, bufAddr));
        static const char romName[15] = "0200AD20040614";
        if (hostBuf)
        {
            std::memcpy(hostBuf, romName, 14);
        }
        else
        {
            std::cerr << "GetRomName: invalid buffer 0x" << std::hex << bufAddr << std::dec << std::endl;
        }
        setReturnU32(ctx, bufAddr);
    }

    void SifLoadElfPart(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t pathAddr = getRegU32(ctx, 4);     // $a0 - path
        const uint32_t secNameAddr = getRegU32(ctx, 5);  // $a1 - section name ("all" typically)
        const uint32_t execDataAddr = getRegU32(ctx, 6); // $a2 - t_ExecData*

        std::string secName = readGuestCStringBounded(rdram, secNameAddr, kLoadfileArgMaxBytes);
        if (secName.empty())
        {
            secName = "all";
        }

        const int32_t ret = runSifLoadElfPart(rdram, ctx, runtime, pathAddr, secName, execDataAddr);
        setReturnS32(ctx, ret);
    }

    void sceSifLoadElf(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t pathAddr = getRegU32(ctx, 4);     // $a0 - path
        const uint32_t execDataAddr = getRegU32(ctx, 5); // $a1 - t_ExecData*
        const int32_t ret = runSifLoadElfPart(rdram, ctx, runtime, pathAddr, "all", execDataAddr);
        setReturnS32(ctx, ret);
    }

    void sceSifLoadElfPart(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        SifLoadElfPart(rdram, ctx, runtime);
    }

    void sceSifLoadModule(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        // Use the same tracker as SifLoadModule so both APIs return the same module IDs.
        SifLoadModule(rdram, ctx, runtime);
    }

    void sceSifLoadModuleBuffer(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t bufferAddr = getRegU32(ctx, 4); // $a0
        if (!rdram || bufferAddr == 0u)
        {
            setReturnS32(ctx, -1);
            return;
        }

        // Match buffer-based module loads to stable synthetic tags so module ID lookup remains deterministic.
        const std::string moduleTag = makeSifModuleBufferTag(rdram, bufferAddr);
        const int32_t moduleId = trackSifModuleLoad(moduleTag);
        if (moduleId <= 0)
        {
            setReturnS32(ctx, -1);
            return;
        }

        uint32_t refs = 0;
        {
            std::lock_guard<std::mutex> lock(g_sif_module_mutex);
            auto it = g_sif_modules_by_id.find(moduleId);
            if (it != g_sif_modules_by_id.end())
            {
                refs = it->second.refCount;
            }
        }
        logSifModuleAction("load-buffer", moduleId, moduleTag, refs);
        setReturnS32(ctx, moduleId);
    }

    void TODO(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime, uint32_t encodedSyscallId)
    {
        const uint32_t v0 = getRegU32(ctx, 2);
        const uint32_t v1 = getRegU32(ctx, 3);
        const uint32_t caller_ra = getRegU32(ctx, 31);
        uint32_t syscallId = encodedSyscallId;
        if (syscallId == 0u)
        {
            syscallId = v1;
        }

        // Every block below is rate-limited on one count, not just the last one. Since Sprint 11
        // Task 19 an override whose handler the runtime cannot execute is no longer claimed, so a
        // guest that overrode a syscall this runtime does not implement reaches here on EVERY call
        // instead of being answered -1 in silence -- and two of these blocks used to print
        // unconditionally, which would flood the game log from a per-frame path.
        static std::mutex s_unknownMutex;
        static std::unordered_map<uint32_t, uint64_t> s_unknownCounts;
        uint64_t hits = 0;
        {
            std::lock_guard<std::mutex> lock(s_unknownMutex);
            hits = ++s_unknownCounts[syscallId];
        }
        const bool report = (hits == 1u) || (hits % 5000u) == 0u;

        if (report)
        {
            std::cerr << "[Syscall TODO]"
                      << " encoded=0x" << std::hex << encodedSyscallId
                      << " v1=0x" << v1
                      << " v0=0x" << v0
                      << " a0=0x" << getRegU32(ctx, 4)
                      << " a1=0x" << getRegU32(ctx, 5)
                      << " a2=0x" << getRegU32(ctx, 6)
                      << " a3=0x" << getRegU32(ctx, 7)
                      << " pc=0x" << ctx->pc
                      << std::dec << std::endl;

            std::cerr << "Warning: Unimplemented PS2 syscall called. PC=0x" << std::hex << ctx->pc
                      << ", RA=0x" << caller_ra
                      << ", Encoded=0x" << encodedSyscallId
                      << ", v0=0x" << v0
                      << ", v1=0x" << v1
                      << ", Chosen=0x" << syscallId
                      << ", hits=" << std::dec << hits
                      << std::endl;

            std::cerr << "  Args: $a0=0x" << std::hex << getRegU32(ctx, 4)
                      << ", $a1=0x" << getRegU32(ctx, 5)
                      << ", $a2=0x" << getRegU32(ctx, 6)
                      << ", $a3=0x" << getRegU32(ctx, 7) << std::dec << std::endl;
        }

        // Common syscalls:
        // 0x04: Exit
        // 0x06: LoadExecPS2
        // 0x07: ExecPS2
        if (syscallId == 0x04u)
        {
            if (report)
            {
                std::cerr << "  -> Syscall is Exit(), calling ExitThread stub." << std::endl;
            }
            ExitThread(rdram, ctx, runtime);
            return;
        }

        if (report)
        {
            std::cerr << "  -> Unknown syscallId=0x" << std::hex << syscallId
                      << " hits=" << std::dec << hits << std::endl;
        }

        // Bootstrap default: avoid hard-failing loops that probe syscall availability.
        setReturnS32(ctx, 0);
    }

    void dispatchSyscallOverride(uint32_t syscallNumber, uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint32_t handler = 0u;
        if (!runtime || !ctx ||
            !runtime->findEeSyscallOverride(syscallNumber, handler) ||
            handler == 0u)
        {
            return;
        }

        EeScheduler &scheduler = runtime->eeScheduler();
        scheduler.bindMainContextForSyscall(*ctx, rdram);
        if (scheduler.hasInvocation(GuestInvocationKind::SyscallOverride, syscallNumber))
        {
            return;
        }

        if (!runtime->hasFunction(handler))
        {
            // Sprint 11 Task 19. An override we cannot execute is not an override. SOCOM II's
            // loader (FUN_001ac128) copies 0x330 bytes of its own code to 0x80075000 and registers
            // that copy as the handler for syscall 0x5B, then installs GetEntryAddress' answers as
            // the handlers for the event-flag five (0x55-0x59). None of those addresses is in any
            // function table, so claiming the override and answering KE_ERROR made every later
            // call of those syscalls return -1 for the rest of the run -- in r0001 as much as in
            // r0004. Fall through instead: dispatchNumericSyscall then runs the runtime's own
            // implementation, which is the closest thing to what the guest's copy would have done.
            //
            // The once-per-(syscall, handler) bookkeeping lives on the PS2Runtime, not in a
            // function-local static: two runtimes in one process (ps2xTest makes several) each
            // deserve the diagnostic, and the runtime clears it in initializeEeKernelState, which
            // is its own "the guest kernel is starting over" point.
            if (runtime->noteUnrunnableSyscallOverride(syscallNumber, handler))
            {
                std::cerr << "[SetSyscall] syscall 0x" << std::hex << syscallNumber
                          << " was overridden with handler 0x" << handler
                          << ", which is in no function table (guest-copied code?); running the"
                             " built-in implementation instead." << std::dec << std::endl;
            }
            return;
        }

        GuestInvocation invocation{};
        invocation.kind = GuestInvocationKind::SyscallOverride;
        invocation.tag = syscallNumber;
        invocation.context = *ctx;
        invocation.context.pc = handler;
        SET_GPR_U32(&invocation.context, 29, scheduler.invocationStackTop());
        SET_GPR_U32(&invocation.context, 31, 0u);
        invocation.onComplete = [](const R5900Context &completed, R5900Context &parent)
        {
            parent.r[2] = completed.r[2];
        };
        // [[noreturn]] (EeScheduler::invokeCurrent): the guest handler runs as an invocation frame
        // and control does not come back here, so there is nothing after this line.
        scheduler.invokeCurrent(std::move(invocation));
    }

    static bool tryResolveGuestSyscallMirrorAddr(uint32_t syscallIndex, uint32_t &guestAddr)
    {
        const int64_t offsetBytes =
            static_cast<int64_t>(static_cast<int32_t>(syscallIndex)) * static_cast<int64_t>(sizeof(uint32_t));
        const int64_t guestAddr64 = static_cast<int64_t>(kGuestSyscallTablePhysBase) + offsetBytes;
        if (guestAddr64 < 0 || (guestAddr64 + static_cast<int64_t>(sizeof(uint32_t))) > static_cast<int64_t>(kGuestSyscallMirrorLimit))
        {
            return false;
        }

        guestAddr = static_cast<uint32_t>(guestAddr64);
        return true;
    }

    static void writeGuestKernelWord(uint8_t *rdram, uint32_t guestAddr, uint32_t value)
    {
        if (!rdram)
        {
            return;
        }

        if (uint8_t *ptr = getMemPtr(rdram, guestAddr))
        {
            std::memcpy(ptr, &value, sizeof(value));
        }
    }

    void initializeGuestKernelState(uint8_t *rdram, PS2Runtime *runtime)
    {
        if (!runtime)
        {
            return;
        }
        runtime->initializeEeKernelState(rdram);
    }

    void SetSyscall(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t syscallIndex = getRegU32(ctx, 4);
        const uint32_t handler = getRegU32(ctx, 5);
        runtime->setEeSyscallOverride(rdram, syscallIndex, handler);

        setReturnS32(ctx, 0);
    }

    // 0x3C SetupThread
    // args: $a0 = gp, $a1 = stack, $a2 = stack_size, $a3 = args, $t0 = root_func
    void SetupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t gp = getRegU32(ctx, 4);
        const uint32_t stack = getRegU32(ctx, 5);
        const int32_t stackSizeSigned = static_cast<int32_t>(getRegU32(ctx, 6));
        const uint32_t currentSp = getRegU32(ctx, 29);
        EeScheduler &scheduler = runtime->eeScheduler();
        scheduler.bindMainContextForSyscall(*ctx, rdram);

        if (gp != 0u)
        {
            setRegU32(ctx, 28, gp);
        }

        uint32_t sp = currentSp;
        uint32_t initialStack = 0u;
        const uint32_t stackSize = stackSizeSigned > 0
                                       ? static_cast<uint32_t>(stackSizeSigned)
                                       : 0u;
        if (stack == 0xFFFFFFFFu)
        {
            if (stackSizeSigned > 0)
            {
                const uint32_t requestedSize = static_cast<uint32_t>(stackSizeSigned);
                if (requestedSize < PS2_RAM_SIZE)
                {
                    sp = PS2_RAM_SIZE - requestedSize;
                }
                else
                {
                    sp = PS2_RAM_SIZE;
                }
            }
            else
            {
                sp = PS2_RAM_SIZE;
            }
        }
        else if (stack != 0u)
        {
            if (stackSizeSigned > 0)
            {
                sp = stack + static_cast<uint32_t>(stackSizeSigned);
            }
            else
            {
                sp = stack;
            }
        }

        sp &= ~0xFu;
        if (stack == 0xFFFFFFFFu)
        {
            initialStack = sp;
        }
        else if (stack != 0u)
        {
            initialStack = stack;
        }

        scheduler.setupCurrentThread(initialStack, stackSize, getRegU32(ctx, 28));
        // Sprint 17 Q2: SetupThread(gp, stack, stack_size, args, root) -- $a3 is the crt0's argument block and
        // the kernel fills it with the boot arguments. Only a restart has any (LoadExecPS2's request); a first
        // boot writes nothing, so the block stays what the ELF's zeroed bss makes it (argc 0), as it always has.
        const uint32_t argsAddr = getRegU32(ctx, 7);
        if (runtime && argsAddr != 0u && runtime->hasBootArguments())
        {
            const PS2Runtime::GuestRestartRequest args = runtime->bootArguments();
            writeCrt0Arguments(rdram, argsAddr, args.guestPath, args.argv);
        }
        setReturnU32(ctx, sp);
    }

    uint32_t bootArgumentBlockAddress()
    {
        return guestSyscallEntryScratchAddr(3u);
    }

    uint32_t writeBootArgumentBlock(uint8_t *rdram, const std::string &program, const std::vector<std::string> &argv)
    {
        const uint32_t base = bootArgumentBlockAddress();
        constexpr uint32_t kStringsOffset = 0x40u;          // SetArg: the filename copy at base+0x40
        constexpr uint32_t kMaxArgs = 15u;                   // SetArg: at most 15 arguments after the filename
        const uint32_t capacity = kSyscallEntryScratchStride; // one entry's block
        if (!rdram)
        {
            return base;
        }
        std::memset(rdram + (base & PS2_RAM_MASK), 0, capacity);
        auto put32 = [rdram](uint32_t addr, uint32_t value) { std::memcpy(rdram + (addr & PS2_RAM_MASK), &value, sizeof(value)); };
        uint32_t cursor = base + kStringsOffset;
        auto putString = [&](const std::string &s, uint32_t slot) -> bool
        {
            const uint32_t bytes = static_cast<uint32_t>(s.size()) + 1u;
            if (cursor + bytes > base + capacity)
            {
                return false;
            }
            std::memcpy(rdram + (cursor & PS2_RAM_MASK), s.c_str(), bytes);
            put32(slot, cursor);
            cursor += bytes;
            return true;
        };
        if (!putString(program, base))
        {
            std::cerr << "[LoadExecPS2] the boot-argument block cannot hold the program name (" << program.size()
                      << " bytes); it is left empty" << std::endl;
            return base;
        }
        for (uint32_t i = 0; i < argv.size(); ++i)
        {
            if (i >= kMaxArgs || !putString(argv[i], base + 4u * (i + 1u)))
            {
                std::cerr << "[LoadExecPS2] the boot-argument block holds " << i << " of " << argv.size()
                          << " arguments; the rest are dropped" << std::endl;
                break;
            }
        }
        return base;
    }

    void writeCrt0Arguments(uint8_t *rdram, uint32_t argsAddr, const std::string &program, const std::vector<std::string> &argv)
    {
        constexpr uint32_t kMaxArgv = 16u;                       // char *argv[16]
        constexpr uint32_t kPointersOffset = 4u;                 // after argc
        constexpr uint32_t kPayloadOffset = kPointersOffset + 4u * kMaxArgv;   // 0x44
        constexpr uint32_t kPayloadBytes = 256u;
        if (!rdram || argsAddr == 0u)
        {
            return;
        }
        auto put32 = [rdram](uint32_t addr, uint32_t value) { std::memcpy(rdram + (addr & PS2_RAM_MASK), &value, sizeof(value)); };
        std::memset(rdram + (argsAddr & PS2_RAM_MASK), 0, kPayloadOffset + kPayloadBytes);
        uint32_t cursor = argsAddr + kPayloadOffset;
        uint32_t argc = 0u;
        auto putString = [&](const std::string &s) -> bool
        {
            const uint32_t bytes = static_cast<uint32_t>(s.size()) + 1u;
            // 15 real entries at most: argv[argc] stays the null terminator, as the crt0's block has room for.
            if (argc + 1u >= kMaxArgv || cursor + bytes > argsAddr + kPayloadOffset + kPayloadBytes)
            {
                return false;
            }
            std::memcpy(rdram + (cursor & PS2_RAM_MASK), s.c_str(), bytes);
            put32(argsAddr + kPointersOffset + 4u * argc, cursor);
            cursor += bytes;
            ++argc;
            return true;
        };
        bool dropped = !putString(program);
        for (size_t i = 0; !dropped && i < argv.size(); ++i)
        {
            dropped = !putString(argv[i]);
        }
        if (dropped)
        {
            std::cerr << "[SetupThread] the crt0's argument block holds " << argc << " of " << (argv.size() + 1u)
                      << " arguments (16 slots, 256 bytes); the rest are dropped" << std::endl;
        }
        put32(argsAddr, argc);
    }

    // 0x3D SetupHeap: returns heap base/start pointer
    void SetupHeap(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t heapBaseRaw = getRegU32(ctx, 4); // $a0
        const uint32_t heapSize = getRegU32(ctx, 5);    // $a1 (optional size)

        const uint32_t heapBase = (heapBaseRaw + 0xFu) & ~0xFu;

        // Silent Hill and other games often pass -1 (0xFFFFFFFF) to mean "rest of RAM".
        static constexpr uint32_t kDefaultGuestHeapEnd = 0x01F00000u;
        uint32_t heapLimit = kDefaultGuestHeapEnd;

        if (heapSize != 0u && heapSize != 0xFFFFFFFFu)
        {
            const uint64_t candidate = static_cast<uint64_t>(heapBase) + static_cast<uint64_t>(heapSize);
            heapLimit = static_cast<uint32_t>(std::min<uint64_t>(candidate, kDefaultGuestHeapEnd));
        }

        if (heapLimit <= heapBase)
        {
            heapLimit = kDefaultGuestHeapEnd;
        }

        if (runtime)
        {
            runtime->configureGuestHeap(heapBase, heapLimit);

            PS2_IF_AGRESSIVE_LOGS({
                std::cerr << "[SetupHeap]"
                          << " base=0x" << std::hex << heapBaseRaw
                          << " alignedBase=0x" << heapBase
                          << " size=0x" << heapSize
                          << " runtimeBase=0x" << runtime->guestHeapBase()
                          << " runtimeEnd=0x" << runtime->guestHeapEnd()
                          << std::dec << std::endl;
            });

            setReturnU32(ctx, runtime->guestHeapBase());
            return;
        }

        setReturnU32(ctx, heapBase);
    }

    // 0x3E EndOfHeap: commonly returns current heap end; keep it stable for now.
    void EndOfHeap(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)rdram;

        static constexpr uint32_t kDefaultGuestHeapEnd = 0x01F00000u;

        const uint32_t ret = runtime
                                 ? runtime->guestHeapLimit()
                                 : kDefaultGuestHeapEnd;

        setReturnU32(ctx, ret);
    }

    void GetMemorySize(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)rdram;
        (void)runtime;
        setReturnU32(ctx, PS2_RAM_SIZE);
    }

    void InitTLB(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)rdram;
        // TODO I`m 99% sure we dont need this we could just return ok and should be fine.
        auto &memory = runtime->memory();

        const uint32_t entryCount = static_cast<uint32_t>(memory.tlbEntryCount());
        for (uint32_t entryIndex = 0; entryIndex < entryCount; ++entryIndex)
        {
            memory.tlbWrite(entryIndex, 0u, 0u, 0u, false);
        }

        // Reset basic COP0 TLB bookkeeping to sane post-init values.
        ctx->cop0_index = 0u;
        ctx->cop0_random = entryCount > 0u ? (entryCount - 1u) : 0u;
        ctx->cop0_entrylo0 = 0u;
        ctx->cop0_entrylo1 = 0u;
        ctx->cop0_context = 0u;
        ctx->cop0_pagemask = 0u;
        ctx->cop0_entryhi = 0u;

        setReturnS32(ctx, KE_OK);
    }

    static inline uint32_t normalizeKernelAlias(uint32_t addr)
    {
        if (addr >= 0x80000000u && addr < 0xC0000000u)
        {
            return addr & 0x1FFFFFFFu;
        }
        return addr;
    }

    static uint32_t computeBuiltinFindAddressResult(uint8_t *rdram,
                                                    uint32_t originalStart,
                                                    uint32_t originalEnd,
                                                    uint32_t target)
    {
        uint32_t start = (originalStart + 3u) & ~0x3u;
        uint32_t end = originalEnd & ~0x3u;
        if (start >= end)
        {
            return 0u;
        }

        const uint32_t targetNorm = normalizeKernelAlias(target);
        for (uint32_t addr = start; addr < end; addr += sizeof(uint32_t))
        {
            const uint8_t *entryPtr = getConstMemPtr(rdram, addr);
            if (!entryPtr)
            {
                break;
            }

            uint32_t entry = 0u;
            std::memcpy(&entry, entryPtr, sizeof(entry));
            if (entry == target || normalizeKernelAlias(entry) == targetNorm)
            {
                return addr;
            }
        }

        return 0u;
    }

    struct FindAddressWordSample
    {
        uint32_t addr = 0u;
        uint32_t value = 0u;
    };

    struct FindAddressMatchSample
    {
        uint32_t addr = 0u;
        uint32_t value = 0u;
        bool aliasOnly = false;
    };

    static void logFindAddressDiagnostics(uint32_t callerPc,
                                          uint32_t originalStart,
                                          uint32_t originalEnd,
                                          uint32_t alignedStart,
                                          uint32_t alignedEnd,
                                          uint32_t target,
                                          uint32_t targetNorm,
                                          bool found,
                                          uint32_t resultAddr,
                                          uint32_t scannedWords,
                                          bool allZero,
                                          bool aborted,
                                          uint32_t abortedAddr,
                                          const FindAddressWordSample *firstWords,
                                          uint32_t firstWordCount,
                                          const FindAddressWordSample *nonZeroWords,
                                          uint32_t nonZeroWordCount,
                                          const FindAddressMatchSample *matches,
                                          uint32_t matchCount)
    {
#if !AGRESSIVE_LOGS
        return;
#else
        static std::atomic<uint32_t> s_findAddressHitLogs{0u};
        static std::atomic<uint32_t> s_findAddressMissLogs{0u};
        constexpr uint32_t kMaxFindAddressHitLogs = 16u;
        constexpr uint32_t kMaxFindAddressMissLogs = 128u;

        std::atomic<uint32_t> &counter = found ? s_findAddressHitLogs : s_findAddressMissLogs;
        const uint32_t logIndex = counter.fetch_add(1u, std::memory_order_relaxed);
        const uint32_t logLimit = found ? kMaxFindAddressHitLogs : kMaxFindAddressMissLogs;
        if (logIndex >= logLimit)
        {
            return;
        }

        std::cerr << "[FindAddress:" << (found ? "hit" : "miss") << "]"
                  << " pc=0x" << std::hex << callerPc
                  << " start=0x" << originalStart
                  << " end=0x" << originalEnd
                  << " alignedStart=0x" << alignedStart
                  << " alignedEnd=0x" << alignedEnd
                  << " target=0x" << target
                  << " targetNorm=0x" << targetNorm
                  << " result=0x" << resultAddr
                  << std::dec
                  << " scannedWords=" << scannedWords
                  << " allZero=" << (allZero ? "true" : "false")
                  << " aborted=" << (aborted ? "true" : "false");
        if (aborted)
        {
            std::cerr << " abortedAddr=0x" << std::hex << abortedAddr << std::dec;
        }
        std::cerr << std::endl;

        std::cerr << "  firstWords:";
        if (firstWordCount == 0u)
        {
            std::cerr << " none";
        }
        else
        {
            for (uint32_t i = 0; i < firstWordCount; ++i)
            {
                std::cerr << " [0x" << std::hex << firstWords[i].addr
                          << "]=0x" << firstWords[i].value;
            }
            std::cerr << std::dec;
        }
        std::cerr << std::endl;

        std::cerr << "  nonZeroSample:";
        if (nonZeroWordCount == 0u)
        {
            std::cerr << " none";
        }
        else
        {
            for (uint32_t i = 0; i < nonZeroWordCount; ++i)
            {
                std::cerr << " [0x" << std::hex << nonZeroWords[i].addr
                          << "]=0x" << nonZeroWords[i].value;
            }
            std::cerr << std::dec;
        }
        std::cerr << std::endl;

        std::cerr << "  matches:";
        if (matchCount == 0u)
        {
            std::cerr << " none";
        }
        else
        {
            for (uint32_t i = 0; i < matchCount; ++i)
            {
                std::cerr << " [0x" << std::hex << matches[i].addr
                          << "]=0x" << matches[i].value
                          << (matches[i].aliasOnly ? "(alias)" : "(exact)");
            }
            std::cerr << std::dec;
        }
        std::cerr << std::endl;
#endif
    }

    // 0x83 FindAddress:
    // - a0: table start (inclusive)
    // - a1: table end (exclusive)
    // - a2: target address to locate inside the table (word entries)
    // Returns the guest address of the matching word entry, or 0 if not found.
    void FindAddress(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        (void)runtime;

        constexpr uint32_t kFindAddressWordSamples = 8u;
        constexpr uint32_t kFindAddressMatchSamples = 4u;

        const uint32_t originalStart = getRegU32(ctx, 4);
        const uint32_t originalEnd = getRegU32(ctx, 5);
        const uint32_t target = getRegU32(ctx, 6);
        const uint32_t targetNorm = normalizeKernelAlias(target);
        const uint32_t callerPc = ctx->pc;

        uint32_t start = originalStart;
        uint32_t end = originalEnd;

        // Word-scan semantics: align the search window to uint32 boundaries.
        start = (start + 3u) & ~0x3u;
        end &= ~0x3u;

        if (start >= end)
        {
            logFindAddressDiagnostics(callerPc,
                                      originalStart,
                                      originalEnd,
                                      start,
                                      end,
                                      target,
                                      targetNorm,
                                      false,
                                      0u,
                                      0u,
                                      true,
                                      false,
                                      0u,
                                      nullptr,
                                      0u,
                                      nullptr,
                                      0u,
                                      nullptr,
                                      0u);
            setReturnU32(ctx, 0u);
            return;
        }

        FindAddressWordSample firstWords[kFindAddressWordSamples]{};
        FindAddressWordSample nonZeroWords[kFindAddressWordSamples]{};
        FindAddressMatchSample matches[kFindAddressMatchSamples]{};
        uint32_t firstWordCount = 0u;
        uint32_t nonZeroWordCount = 0u;
        uint32_t matchCount = 0u;
        uint32_t scannedWords = 0u;
        uint32_t resultAddr = 0u;
        uint32_t abortedAddr = 0u;
        bool aborted = false;
        bool allZero = true;
        bool foundMatch = false;

        for (uint32_t addr = start; addr < end; addr += sizeof(uint32_t))
        {
            const uint8_t *entryPtr = getConstMemPtr(rdram, addr);
            if (!entryPtr)
            {
                aborted = true;
                abortedAddr = addr;
                break;
            }

            uint32_t entry = 0;
            std::memcpy(&entry, entryPtr, sizeof(entry));
            ++scannedWords;

            if (firstWordCount < kFindAddressWordSamples)
            {
                firstWords[firstWordCount++] = {addr, entry};
            }

            if (entry != 0u)
            {
                allZero = false;
                if (nonZeroWordCount < kFindAddressWordSamples)
                {
                    nonZeroWords[nonZeroWordCount++] = {addr, entry};
                }
            }

            const bool exactMatch = (entry == target);
            const bool aliasMatch = !exactMatch && (normalizeKernelAlias(entry) == targetNorm);
            if (exactMatch || aliasMatch)
            {
                if (!foundMatch)
                {
                    resultAddr = addr;
                    foundMatch = true;
                }
                if (matchCount < kFindAddressMatchSamples)
                {
                    matches[matchCount++] = {addr, entry, aliasMatch};
                }
            }
        }

        logFindAddressDiagnostics(callerPc,
                                  originalStart,
                                  originalEnd,
                                  start,
                                  end,
                                  target,
                                  targetNorm,
                                  foundMatch,
                                  resultAddr,
                                  scannedWords,
                                  allZero,
                                  aborted,
                                  abortedAddr,
                                  firstWords,
                                  firstWordCount,
                                  nonZeroWords,
                                  nonZeroWordCount,
                                  matches,
                                  matchCount);

        setReturnU32(ctx, resultAddr);
    }

    // QueryBootMode (stub): return 0 for now
    void QueryBootMode(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint32_t mode = getRegU32(ctx, 4);
        ensureBootModeTable(rdram);
        uint32_t addr = 0;
        {
            std::lock_guard<std::mutex> lock(g_bootmode_mutex);
            auto it = g_bootmode_addresses.find(static_cast<uint8_t>(mode));
            if (it != g_bootmode_addresses.end())
                addr = it->second;
        }
        setReturnU32(ctx, addr);
    }

    // GetThreadTLS (stub): return 0
    void GetThreadTLS(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        EeScheduler &ee = runtime->eeScheduler();
        ee.bindMainContextForSyscall(*ctx, rdram);
        GuestThread *info = ee.currentThread();
        if (!info)
        {
            setReturnU32(ctx, 0);
            return;
        }

        if (info->tlsBase == 0)
        {
            info->tlsBase = allocTlsAddr(rdram);
        }

        setReturnU32(ctx, info->tlsBase);
    }

    void Copy(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t dest = getRegU32(ctx, 4);
        const uint32_t src = getRegU32(ctx, 5);
        const uint32_t size = getRegU32(ctx, 6);

        if (rdram && size > 0)
        {
            uint8_t *destPtr = getMemPtr(rdram, dest);
            const uint8_t *srcPtr = getConstMemPtr(rdram, src);
            if (destPtr && srcPtr)
            {
                ps2TraceGuestRangeWrite(rdram, dest, size, "syscallCopy", ctx);
                std::memcpy(destPtr, srcPtr, size);
            }
        }
        setReturnS32(ctx, 0);
    }

    // 0x5B GetEntryAddress(syscall) -> the address of that syscall's kernel entry.
    // A syscall the guest replaced answers with the guest's own handler, as the kernel would. For
    // everything else the kernel still has a real entry, and guests write through the address they
    // get back (see the note on kSyscallEntryScratchBase), so the runtime answers from a block it
    // reserves -- never with whatever an untouched word of low RAM happens to hold.
    //
    // R256 finding 9 (Sprint 13 Task C3): only a handler the runtime can RUN is handed back. The
    // dispatcher already treats an override whose handler is in no function table as no override at
    // all and runs the built-in (dispatchSyscallOverride, above); answering GetEntryAddress with that
    // same handler contradicted it. An unrunnable handler is refused -- the syscall answers the
    // runtime's own entry, as for one nobody overrode -- and says so once per (syscall, handler).
    // SOCOM II is not known to reach this path: at boot it asks GetEntryAddress for 3 and 0x55-0x59,
    // and none of those is overridden when it asks; the refusal is for a guest that does.
    //
    // The once-per-pair set is process-wide (a diagnostic; it does not re-arm when a guest kernel
    // starts over), kept here rather than on PS2Runtime so the change stays out of ps2_runtime.h.
    static bool noteRefusedEntryAddress(uint32_t syscallNumber, uint32_t handler)
    {
        static std::mutex s_mutex;
        static std::unordered_set<uint64_t> s_seen;
        constexpr size_t kMaxReported = 64u;
        const uint64_t key = (static_cast<uint64_t>(syscallNumber) << 32) | static_cast<uint64_t>(handler);
        std::lock_guard<std::mutex> lock(s_mutex);
        if (s_seen.size() >= kMaxReported && s_seen.find(key) == s_seen.end())
        {
            return false;
        }
        return s_seen.insert(key).second;
    }

    void GetEntryAddress(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        const uint32_t syscallNum = getRegU32(ctx, 4);

        uint32_t handler = 0;
        if (runtime && runtime->findEeSyscallOverride(syscallNum, handler) && handler != 0u)
        {
            if (runtime->hasFunction(handler))
            {
                setReturnU32(ctx, handler);
                return;
            }
            if (noteRefusedEntryAddress(syscallNum, handler))
            {
                std::cerr << "[GetEntryAddress] syscall 0x" << std::hex << syscallNum
                          << "'s handler 0x" << handler
                          << " is in no function table (guest-copied code?); answering the runtime's entry 0x"
                          << guestSyscallEntryScratchAddr(syscallNum) << " instead." << std::dec << std::endl;
            }
        }

        setReturnU32(ctx, guestSyscallEntryScratchAddr(syscallNum));
    }

    // 0x74 RegisterExitHandler (stub): return 0
    void RegisterExitHandler(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime)
    {
        uint32_t func = getRegU32(ctx, 4);
        uint32_t arg = getRegU32(ctx, 5);
        if (func == 0)
        {
            setReturnS32(ctx, -1);
            return;
        }

        EeScheduler &ee = runtime->eeScheduler();
        ee.bindMainContextForSyscall(*ctx, rdram);
        const int tid = ee.currentThreadId();
        runtime->addEeExitHandler(tid, func, arg);

        setReturnS32(ctx, 0);
    }
}
