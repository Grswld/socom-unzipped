#pragma once

#include "ps2_syscalls.h"

namespace ps2_syscalls
{
    // Sprint 17 Q2 (review finding 5): an in-process restart of the guest closes every host FILE the fio table still
    // holds (the reloaded guest starts with none open, as on the console), and the VAG accumulators with them.
    // Returns how many it closed; openGuestFileCount says how many are open now.
    size_t closeAllGuestFiles();
    size_t openGuestFileCount();
    void fioOpen(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioClose(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioRead(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioWrite(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioLseek(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioMkdir(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioChdir(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioRmdir(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioGetstat(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
    void fioRemove(uint8_t *rdram, R5900Context *ctx, PS2Runtime *runtime);
}
