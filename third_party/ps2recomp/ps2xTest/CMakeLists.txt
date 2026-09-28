cmake_minimum_required(VERSION 3.21)

project(ps2xTest LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(PS2X_IOP_ENABLE_PLUGINS AND (WIN32 OR (UNIX AND NOT APPLE)))
    add_library(ps2_iop_fake_plugin MODULE
        src/fake_iop_plugin.cpp
    )
    add_library(ps2_iop_bad_abi_plugin MODULE
        src/fake_iop_bad_abi.c
    )
    add_library(ps2_iop_missing_symbol_plugin MODULE
        src/fake_iop_missing_symbol.cpp
    )

    foreach(plugin_target IN ITEMS
            ps2_iop_fake_plugin
            ps2_iop_bad_abi_plugin
            ps2_iop_missing_symbol_plugin)
        target_compile_features(${plugin_target} PRIVATE cxx_std_20)
        target_include_directories(${plugin_target} PRIVATE
            ${CMAKE_SOURCE_DIR}/ps2xIOP/include
        )
        set_target_properties(${plugin_target} PROPERTIES
            PREFIX ""
            RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/iop_test_plugins"
            LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/iop_test_plugins"
        )
    endforeach()
endif()

# Static library with test logic (no main). Upstream's workbench was its only consumer and that tree is gone
# (Sprint 11 Task 17, R247); the object library stays because ps2x_tests links its objects (below).
add_library(ps2_test_function_table OBJECT
    src/test_function_table.cpp
)

target_include_directories(ps2_test_function_table PRIVATE
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/include
    ${CMAKE_SOURCE_DIR}/ps2xIOP/include
)

add_library(ps2_test_lib STATIC
    src/code_generator_tests.cpp
    src/r5900_decoder_tests.cpp
    src/elf_analyzer_tests.cpp
    src/pad_input_tests.cpp
    src/ps2_runtime_io_tests.cpp
    src/ps2_runtime_kernel_tests.cpp
    src/ps2_runtime_interrupt_tests.cpp
    src/ps2_memory_tests.cpp
    src/ps2_vu1_tests.cpp
    src/vu1_native_tests.cpp
    src/ps2_vu_tests.cpp
    src/ps2_gs_tests.cpp
    src/gs_frame_backpressure_tests.cpp
    src/shot_queue_tests.cpp   # Sprint 17 F0 Step 5b: the screenshot encode off the GL thread
    src/ps2_iop_tests.cpp
    src/ps2_sif_rpc_tests.cpp
    src/ps2_sif_dma_tests.cpp
    src/ps2_recompiler_tests.cpp
    src/ps2_runtime_expansion_tests.cpp
    src/socom2_libnetb_tests.cpp
    src/socom2_chat_tests.cpp   # Sprint 11 milestone S
    src/socom2_audio_tests.cpp
    src/audio_cb_trace_tests.cpp   # Sprint 11 audio-out
    src/socom2_lgaud_tests.cpp
    src/host_config_tests.cpp
    src/launcher_tests.cpp
    src/font_advances.cpp   # issue #74: the footer tip measured in the launcher's own face
    src/exit_codes_tests.cpp
    src/preflight_tests.cpp
    src/bare_run_tests.cpp
    src/zip_store_tests.cpp
    src/diagnostics_tests.cpp
    src/bug_report_tests.cpp
    src/patch_fetch_tests.cpp   # Sprint 16 R2a (#71)
    src/mapping_tests.cpp
    src/socom2_osk_prefill_tests.cpp
    src/knobs_tests.cpp
    src/menu_sounds_tests.cpp   # Sprint 10 Q4
    src/socom2_addresses_tests.cpp   # Sprint 11 Task 10
    src/socom2_revision_guard_tests.cpp   # Sprint 11 Task 19
    src/ps2_save_state_tests.cpp   # Sprint 11 Task 8c
    src/runtime_state_tests.cpp         # Sprint 11 Task 8b
    src/support_state_tests.cpp         # issue #51
    src/socom2_after_return_tests.cpp   # Sprint 13 Task C3 (audit F10, F11)
    src/socom2_peek_tests.cpp           # Sprint 13 Task C3 (#39)
    src/socom2_pad2_hle_tests.cpp       # Sprint 13 Task C8 (audit F8)
    src/socom2_msifrpc_tests.cpp        # Sprint 13 Task C8 (audit F8)
    src/socom2_crypto_tests.cpp         # Sprint 13 Task C8 (audit F9)
    src/persona_record_tests.cpp        # Sprint 16 L1b (#73): the runtime's persona record
    src/card_save_tests.cpp             # the persona-card plan Task 1: the card's persona file, from fixtures
    src/runtime_seams_tests.cpp         # Sprint 13 Task C8 (audit F22)
    src/socom2_net_bounds_tests.cpp     # the network receive path's bounds (runtime/socom2_net_bounds.h)
    src/socom2_msg_bounds_tests.cpp     # the message dispatcher's bounds (runtime/socom2_msg_bounds.h)
)

target_include_directories(ps2_test_lib PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/ps2xRecomp/include
    ${CMAKE_SOURCE_DIR}/ps2xAnalyzer/include
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/include
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib
    # Sprint 8 Goal 3 Task 2: socom2_lgaud_tests.cpp drives the module through its own factory
    # (detail::createLgAudService), which lives beside the modules rather than in the public headers.
    ${CMAKE_SOURCE_DIR}/ps2xIOP/src
)

target_link_libraries(ps2_test_lib PRIVATE
    ps2_recomp_lib
    ps2_analyzer_lib
    ps2_runtime
    ps2_iop
)
target_link_libraries(ps2_test_lib PUBLIC ps2x_launcher_core)   # launcher_tests.cpp (Task 8b)

# Sprint 8 Task 4: launcher_tests.cpp's two POSIX-only cases exercise the win32glue interface's Unix body,
# so that one translation unit joins the test library on Unix. On Windows nothing changes: win32_glue.cpp is
# the launcher executable's alone and the tests around it are compiled out.
if(UNIX)
    target_sources(ps2_test_lib PRIVATE ${CMAKE_SOURCE_DIR}/ps2xLauncher/src/posix_glue.cpp)
endif()

if(UNIX AND NOT APPLE)
    target_link_libraries(ps2_test_lib PRIVATE ${CMAKE_DL_LIBS})
endif()

# Issue #74: font_advances.cpp measures the launcher's lines in the embedded face itself (raylib's LoadFontData).
target_compile_definitions(ps2_test_lib PRIVATE PS2X_LAUNCHER_FONTS_DIR="${CMAKE_SOURCE_DIR}/ps2xLauncher/assets/fonts")
# The persona-card plan Task 1: card_save_tests.cpp reads the fixture cards under ps2xTest/fixtures/cards/, never a real card.
target_compile_definitions(ps2_test_lib PRIVATE PS2X_TEST_FIXTURES_DIR="${CMAKE_SOURCE_DIR}/ps2xTest/fixtures")

if(TARGET ps2_iop_fake_plugin)
    target_compile_definitions(ps2_test_lib PRIVATE
        PS2X_TEST_IOP_PLUGIN_DIR="$<TARGET_FILE_DIR:ps2_iop_fake_plugin>"
    )
    add_dependencies(ps2_test_lib
        ps2_iop_fake_plugin
        ps2_iop_bad_abi_plugin
        ps2_iop_missing_symbol_plugin
    )
endif()

add_executable(ps2x_tests
    src/main.cpp
    $<TARGET_OBJECTS:ps2_test_function_table>
)

# libps2_runtime.a references SOCOM II handlers by name through its stub table (ps2_call_list.h). Sprint 13 Task C8
# (audit F8, F9, F22): no stand-ins -- the runner's own files that define them are compiled here too and tested
# (socom2_pad2_hle_tests.cpp, socom2_msifrpc_tests.cpp, socom2_crypto_tests.cpp); ps2HostProfStart and
# g_ps2xTraceArmed are the runtime's own (a weak no-op default, runtime/host_prof_start.h; ps2_trace_armed.cpp).
target_sources(ps2x_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_pad2_hle.cpp
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_msifrpc.cpp
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_crypto.cpp
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_persona_record.cpp   # Sprint 16 L1b (#73): the seams' record, tested
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_lum_pixel.cpp
)
# The libnetb HLE and its host socket table are runner-only sources too; the 0x200 stats test
# (socom2_libnetb_tests.cpp) drives them directly.
target_sources(ps2x_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_libnetb.cpp
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_hostnet.cpp
)
# Sprint 7 review finding F12: socom2_host_input.cpp is a runner-only source too, and ps2_runtime's teardown
# now calls its socom2HostInputShutdown(); pad_input_tests.cpp drives that shutdown directly.
target_sources(ps2x_tests PRIVATE
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib/socom2_host_input.cpp
)
target_include_directories(ps2x_tests PRIVATE ${CMAKE_SOURCE_DIR}/ps2xRuntime/src/lib)
if(WIN32)
    target_link_libraries(ps2x_tests PRIVATE ws2_32)
endif()

option(PRINT_GENERATED_CODE "Print generated code in tests" OFF)
if(PRINT_GENERATED_CODE)

    target_compile_definitions(ps2x_tests PRIVATE PRINT_GENERATED_CODE)
    target_compile_definitions(ps2_test_lib PRIVATE PRINT_GENERATED_CODE)
endif()

target_include_directories(ps2x_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_SOURCE_DIR}/ps2xRecomp/include
    ${CMAKE_SOURCE_DIR}/ps2xAnalyzer/include
    ${CMAKE_SOURCE_DIR}/ps2xRuntime/include
)

target_link_libraries(ps2x_tests PRIVATE
    ps2_test_lib
    ps2_recomp_lib
    ps2_analyzer_lib
    ps2_runtime
)

# VU/GS tests intentionally instantiate large interpreter state.
# Windows executables default to a much smaller stack than Linux, and
# sanitizer/debug instrumentation can push these test frames over 1 MiB.
if(MSVC)
    target_link_options(ps2x_tests PRIVATE "/STACK:8388608")
elseif(MINGW)
    target_link_options(ps2x_tests PRIVATE "-Wl,--stack,8388608")
endif()

if(COMMAND ps2x_stage_ffmpeg_runtime_dlls)
    ps2x_stage_ffmpeg_runtime_dlls(ps2x_tests)
endif()

include("${CMAKE_SOURCE_DIR}/ps2xRuntime/cmake/ReleaseMode.cmake")

if(CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
    EnableFastReleaseMode(ps2_test_lib)
    EnableFastReleaseMode(ps2x_tests)
endif()
