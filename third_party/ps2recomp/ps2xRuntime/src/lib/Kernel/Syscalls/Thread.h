#pragma once

#include "ps2_syscalls.h"

#include <string>

namespace ps2_syscalls
{
    // Sprint 17 Q2: does a LoadExecPS2 request name the ELF this runtime booted? "cdrom0:\SCUS_972.75;1" is the
    // disc's boot file, which every SOCOM II ELF the launcher knows (socom2_game.elf, socom2_game_r0004.elf;
    // issue #69's revision table) is a copy of; a request naming the loaded file itself counts too. Anything
    // else (rom0:OSDSYS, the network GUI) is a foreign ELF and keeps the honest exit 74. Pure: no runtime.
    bool loadExecTargetsLoadedElf(const std::string &requestPath, const std::string &loadedElfName);

    void FlushCache(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iFlushCache(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void EnableCache(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void DisableCache(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ResetEE(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void LoadExecPS2(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SetMemoryMode(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void InitThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void CreateThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void DeleteThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void StartThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ExitThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ExitDeleteThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void TerminateThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SuspendThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ResumeThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void GetThreadId(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ReferThreadStatus(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iReferThreadStatus(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void SleepThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void WakeupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iWakeupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void CancelWakeupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iCancelWakeupThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ChangeThreadPriority(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iChangeThreadPriority(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void RotateThreadReadyQueue(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iRotateThreadReadyQueue(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void ReleaseWaitThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void iReleaseWaitThread(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
}
