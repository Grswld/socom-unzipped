#include <stdexcept>
#include "ps2_runtime_macros.h"
#include "ps2_runtime.h"

#include "ps2_syscalls.h"
#include "ps2_stubs.h"

#ifdef PS2_FUNCTION_LOG_TRACKER
#include "ps2_log.h"
#endif

// Synthetic (Sprint 13 Task C1): a hand-written entry in the recompiler's shape. See README.md beside this file.
// Function: entry
// Address: 0x100000 - 0x100020
void entry_0x100000(uint8_t* rdram, R5900Context* ctx, PS2Runtime *runtime) {
#ifdef PS2_FUNCTION_LOG_TRACKER
    PS_LOG_ENTRY("entry_0x100000");
#endif

    switch (ctx->pc) {
        case 0x100010u: goto label_100010;
        default: break;
    }

    ctx->pc = 0x100000u;

    // 0x100000: 0x27bdfff0  addiu       $sp, $sp, -0x10
    ctx->pc = 0x100000u;
    SET_GPR_S32(ctx, 29, (int32_t)ADD32(GPR_U32(ctx, 29), 4294967280));
    // 0x100004: 0xffbf0000  sd          $ra, 0x0($sp)
    ctx->pc = 0x100004u;
    WRITE64(ADD32(GPR_U32(ctx, 29), 0), GPR_U64(ctx, 31));
    // 0x100008: 0xc040008  jal         func_100020
    ctx->pc = 0x100008u;
    SET_GPR_U32(ctx, 31, 0x100010u);
    ctx->pc = 0x10000Cu;
    ctx->in_delay_slot = true;
    ctx->branch_pc = 0x100008u;
    // 0x10000c: 0x24040001  addiu       $a0, $zero, 0x1 (Delay Slot)
    SET_GPR_S32(ctx, 4, (int32_t)ADD32(GPR_U32(ctx, 0), 1));
    ctx->in_delay_slot = false;
    ctx->pc = 0x100020u;
    if (!runtime->dispatchGuestBranch(rdram, ctx, 0x100020u, 0x100008u, 0x100010u, PS2Runtime::GuestBranchKind::DirectCall, "JAL")) {
        return;
    }
    ctx->pc = 0x100010u;
label_100010:
    // 0x100010: 0xdfbf0000  ld          $ra, 0x0($sp)
    ctx->pc = 0x100010u;
    SET_GPR_U64(ctx, 31, READ64(ADD32(GPR_U32(ctx, 29), 0)));
    // 0x100014: 0x3e00008  jr          $ra
    ctx->pc = 0x100014u;
    {
        const uint32_t jumpTarget = GPR_U32(ctx, 31);
        ctx->pc = 0x100018u;
        ctx->in_delay_slot = true;
        ctx->branch_pc = 0x100014u;
        // 0x100018: 0x27bd0010  addiu       $sp, $sp, 0x10 (Delay Slot)
        SET_GPR_S32(ctx, 29, (int32_t)ADD32(GPR_U32(ctx, 29), 16));
        ctx->in_delay_slot = false;
        ctx->pc = jumpTarget;
        #if defined(PS2X_STRICT_RETURN_DIAGNOSTICS) && PS2X_STRICT_RETURN_DIAGNOSTICS
        (void)runtime->dispatchGuestBranch(rdram, ctx, jumpTarget, 0x100014u, 0u, PS2Runtime::GuestBranchKind::Return, "JR $ra");
        return;
        #else
        ctx->pc = jumpTarget;
        return;
        #endif
    }
    ctx->pc = 0x10001Cu;
    // 0x10001c: 0x0  nop
    ctx->pc = 0x10001cu;
    // NOP
    ctx->pc = 0x100020u;
}
