#pragma once

#include "ps2_syscalls.h"

#include <cstdint>
#include <string>
#include <vector>

namespace ps2_syscalls
{
    // Sprint 17 Q2: the kernel's boot-argument area -- the block syscall 0x5B (GetEntryAddress) answers for
    // entry 3, which the SDK's LoadExecPS2 marshaller (SOCOM II's SetArg, 0x1ACCF8) writes the request into
    // before the kernel call: a pointer to the filename at base+0, the argv pointers at base+4*(i+1), the
    // strings from base+0x40. A restart rewrites it there from the decoded request, so the reloaded guest
    // finds what it wrote. Returns the block's guest address.
    uint32_t bootArgumentBlockAddress();
    uint32_t writeBootArgumentBlock(uint8_t *rdram, const std::string &program, const std::vector<std::string> &argv);
    // What SetupThread (syscall 0x3C) copies into the crt0's own block ($a3): the ps2sdk crt0 `_args` shape
    // { int argc; char *argv[16]; char payload[256]; } with argv[0] the program the kernel loaded and the
    // request's arguments after it (SOCOM II's main, FUN_001c4cc0, keeps argv[0] as the program name and reads
    // argc-1 options from argv+1). Arguments past the 16 slots or the 256-byte payload are dropped with a line.
    void writeCrt0Arguments(uint8_t *rdram, uint32_t argsAddr, const std::string &program, const std::vector<std::string> &argv);

    // Runs the guest's registered handler for this syscall, if there is one the runtime can
    // execute. It either does not return (the handler runs as a scheduler invocation, which is
    // [[noreturn]]) or returns having changed nothing, so the caller always goes on to the
    // built-in: since Sprint 11 Task 19 there is no "claimed with an error" answer for the
    // caller to distinguish, and a bool return would document a contract this cannot honour.
    void dispatchSyscallOverride(uint32_t syscallNumber, uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GsSetCrt(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetGsCrt(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GsGetIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iGsGetIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GsPutIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iGsPutIMR(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GsSetVideoMode(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetOsdConfigParam(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetOsdConfigParam(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetOsdConfigParam2(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetOsdConfigParam2(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetRomName(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SifLoadElfPart(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void sceSifLoadElf(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void sceSifLoadElfPart(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void sceSifLoadModule(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void sceSifLoadModuleBuffer(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void TODO(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime, uint32_t encodedSyscallId);
    void initializeGuestKernelState(uint8_t *rdram, PS2Runtime *runtime);
    void SetSyscall(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetupHeap(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void EndOfHeap(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetMemorySize(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void InitTLB(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void FindAddress(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void Deci2Call(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void QueryBootMode(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetThreadTLS(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void Copy(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetEntryAddress(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void RegisterExitHandler(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
}
