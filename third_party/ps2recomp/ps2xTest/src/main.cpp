#include "MiniTest.h"
#include "ps2x/knobs.h"
#include <cstdio>
#include <cstdlib>
#include <iostream>

void register_code_generator_tests();
void register_r5900_decoder_tests();
void register_elf_analyzer_tests();
void register_pad_input_tests();
void register_ps2_runtime_io_tests();
void register_ps2_runtime_kernel_tests();
void register_ps2_runtime_interrupt_tests();
void register_ps2_memory_tests();
void register_ps2_vu1_tests();
void register_vu1_native_tests();
void register_ps2_vu_tests();
void register_ps2_gs_tests();
void register_gs_frame_backpressure_tests();
void register_ps2_iop_tests();
void register_ps2_sif_rpc_tests();
void register_ps2_sif_dma_tests();
void register_ps2_recompiler_tests();
void register_ps2_runtime_expansion_tests();
void register_socom2_libnetb_tests();
void register_socom2_chat_tests();   // Sprint 11 milestone S
void register_socom2_audio_tests();
void register_audio_cb_trace_tests();   // Sprint 11 audio-out: the per-callback trace
void register_socom2_lgaud_tests();
void register_host_config_tests();
void register_launcher_tests();
void register_exit_codes_tests();
void register_preflight_tests();
void register_bare_run_tests();
void register_zip_store_tests();
void register_diagnostics_tests();
void register_bug_report_tests();
void register_patch_fetch_tests();
void register_mapping_tests();
void register_socom2_osk_prefill_tests();
void register_knobs_tests();
void register_menu_sounds_tests();   // Sprint 10 Q4
void register_socom2_addresses_tests();   // Sprint 11 Task 10
void register_socom2_revision_guard_tests();   // Sprint 11 Task 19
void register_ps2_save_state_tests();   // Sprint 11 Task 8c
void register_runtime_state_tests();      // Sprint 11 Task 8b
void register_support_state_tests();      // issue #51
void register_socom2_after_return_tests();   // Sprint 13 Task C3
void register_socom2_peek_tests();           // Sprint 13 Task C3 (#39)
void register_socom2_pad2_hle_tests();       // Sprint 13 Task C8 (audit F8)
void register_socom2_msifrpc_tests();        // Sprint 13 Task C8 (audit F8)
void register_socom2_crypto_tests();         // Sprint 13 Task C8 (audit F9)
void register_runtime_seams_tests();         // Sprint 13 Task C8 (audit F22)
void reset_ps2_test_function_table();

namespace
{
    // Set name=value only when the environment has not already chosen a value.
    void setEnvDefault(const char *name, const char *value)
    {
        if (std::getenv(name))
            return;
#ifdef _WIN32
        _putenv_s(name, value);
#else
        setenv(name, value, 0);
#endif
    }
}

int main()
{
    // Unbuffered stdout: a crash mid-suite must leave the last [Run] line in a redirected log (2026-09-17).
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    ps2x::knobs::setDevMode(true);   // the suite selects reference paths through Dev knobs (below) and tests set more
    // These tests cover the reference implementations, but the runtime defaults to the faster
    // paths this fork added for the game. Each is chosen per process from the environment and
    // read once, before any test runs, so select the reference ones here. An A/B run can
    // override the value-tested ones from the environment (setEnvDefault yields to a value
    // that is already set).
    //   PS2X_GS_BACKEND: the OpenGL backend (gs_frontend.cpp) is the default and needs a real
    //     GL context, which a console test process has none of; the GS tests read back the CPU
    //     rasterizer's framebuffer.
    //   PS2X_VU1_FAST: the non-cycle-exact VU1 path (ps2_vu1_core.cpp) is the default and
    //     commits FMAC results immediately; the VU1 tests assert the architectural four-cycle
    //     writeback latency of the cycle-exact scheduler.
    //   PS2X_VU1_XGKICK_CYCLE_EXACT: XGKICK copies the whole packet at kick time by default; the PATH1 test
    //     asserts the per-cycle model. A Flag since Sprint 9 Goal 3: 0 in the environment selects the
    //     immediate copy for an A/B.
    setEnvDefault("PS2X_GS_BACKEND", "cpu");
    setEnvDefault("PS2X_VU1_FAST", "0");
    setEnvDefault("PS2X_VU1_XGKICK_CYCLE_EXACT", "1");

    MiniTest::BeforeEach(reset_ps2_test_function_table);

    register_code_generator_tests();
    register_r5900_decoder_tests();
    register_elf_analyzer_tests();
    register_pad_input_tests();
    register_ps2_runtime_io_tests();
    register_ps2_runtime_kernel_tests();
    register_ps2_runtime_interrupt_tests();
    register_ps2_memory_tests();
    register_ps2_vu1_tests();
    register_vu1_native_tests();
    register_ps2_vu_tests();
    register_ps2_gs_tests();
    register_gs_frame_backpressure_tests();
    register_ps2_iop_tests();
    register_ps2_sif_rpc_tests();
    register_ps2_sif_dma_tests();
    register_ps2_recompiler_tests();
    register_ps2_runtime_expansion_tests();
    register_socom2_libnetb_tests();
    register_socom2_chat_tests();
    register_socom2_audio_tests();
    register_audio_cb_trace_tests();
    register_socom2_lgaud_tests();
    register_host_config_tests();
    register_launcher_tests();
    register_exit_codes_tests();
    register_preflight_tests();
    register_bare_run_tests();
    register_zip_store_tests();
    register_diagnostics_tests();
    register_bug_report_tests();
    register_patch_fetch_tests();
    register_mapping_tests();
    register_socom2_osk_prefill_tests();
    register_knobs_tests();
    register_menu_sounds_tests();
    register_socom2_addresses_tests();
    register_socom2_revision_guard_tests();
    register_ps2_save_state_tests();
    register_runtime_state_tests();
    register_support_state_tests();
    register_socom2_after_return_tests();
    register_socom2_peek_tests();
    register_socom2_pad2_hle_tests();
    register_socom2_msifrpc_tests();
    register_socom2_crypto_tests();
    register_runtime_seams_tests();
    int res = MiniTest::Run();
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(res);
}
