#include <stdexcept>
#include "ps2_runtime_macros.h"
#include "ps2_runtime.h"

#include "ps2_syscalls.h"
#include "ps2_stubs.h"

#ifdef PS2_FUNCTION_LOG_TRACKER
#include "ps2_log.h"
#endif

// Synthetic (Sprint 13 Task C1): a hand-written leaf in the recompiler's shape. See README.md beside this file.
// Function: sub_00100020
// Address: 0x100020 - 0x100030
void sub_00100020_0x100020(uint8_t* rdram, R5900Context* ctx, PS2Runtime *runtime) {
#ifdef PS2_FUNCTION_LOG_TRACKER
    PS_LOG_ENTRY("sub_00100020_0x100020");
#endif

    ctx->pc = 0x100020u;

    // 0x100020: 0x851021  addu        $v0, $a0, $a1
    ctx->pc = 0x100020u;
    SET_GPR_S32(ctx, 2, (int32_t)ADD32(GPR_U32(ctx, 4), GPR_U32(ctx, 5)));
    // 0x100024: 0x3e00008  jr          $ra
    ctx->pc = 0x100024u;
    {
        const uint32_t jumpTarget = GPR_U32(ctx, 31);
        ctx->pc = 0x100028u;
        ctx->in_delay_slot = true;
        ctx->branch_pc = 0x100024u;
        // 0x100028: 0x0  nop (Delay Slot)
        ctx->in_delay_slot = false;
        ctx->pc = jumpTarget;
        #if defined(PS2X_STRICT_RETURN_DIAGNOSTICS) && PS2X_STRICT_RETURN_DIAGNOSTICS
        (void)runtime->dispatchGuestBranch(rdram, ctx, jumpTarget, 0x100024u, 0u, PS2Runtime::GuestBranchKind::Return, "JR $ra");
        return;
        #else
        ctx->pc = jumpTarget;
        return;
        #endif
    }
    ctx->pc = 0x10002Cu;
    // 0x10002c: 0x0  nop
    ctx->pc = 0x10002cu;
    // NOP
    ctx->pc = 0x100030u;
}
