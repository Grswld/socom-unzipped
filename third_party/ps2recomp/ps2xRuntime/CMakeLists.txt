cmake_minimum_required(VERSION 3.20)

project(PS2Runtime VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(PS2X_ENABLE_RUNNER_UNITY_BUILD "Build ps2EntryRunner with CMake unity build" ON)
set(PS2X_RUNNER_UNITY_BUILD_BATCH_SIZE 32 CACHE STRING "Unity build batch size for ps2EntryRunner")
option(PS2X_ENABLE_RUNNER_PCH "Precompile the heavy runtime headers for ps2EntryRunner" ON)
option(PS2X_ENABLE_SCCACHE "Use sccache as compiler launcher when available" ON)

option(PS2X_ENABLE_RUNTIME_LOGS "Enable PS2 runtime logs" OFF)
option(PS2X_ENABLE_AGRESSIVE_LOGS "Enable very verbose/agressive PS2 runtime logs" OFF)
option(PS2X_ENABLE_IOP_RPC_TRACE "Log unhandled IOP/SIF RPC trace suggestions" ON)
option(PS2X_STRICT_RETURN_DIAGNOSTICS "Route generated JR $ra returns through runtime branch diagnostics" OFF)
option(PS2X_SHOW_WINDOWS_CONSOLE "Show a console window for ps2EntryRunner on Windows release builds" ON)
option(PS2X_ENABLE_DEBUG_UI "Build the desktop runtime debug UI" ON)

if(PS2X_ENABLE_SCCACHE)
    find_program(PS2X_SCCACHE_PROGRAM sccache)

    if(PS2X_SCCACHE_PROGRAM)
        if(CMAKE_C_COMPILER)
            set(CMAKE_C_COMPILER_LAUNCHER "${PS2X_SCCACHE_PROGRAM}")
        endif()

        set(CMAKE_CXX_COMPILER_LAUNCHER "${PS2X_SCCACHE_PROGRAM}")
        message(STATUS "Using sccache: ${PS2X_SCCACHE_PROGRAM}")
    else()
        message(STATUS "sccache not found; continuing without compiler launcher")
    endif()
endif()

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/ReleaseMode.cmake")

# Sprint 13 Task C7 (audit F20): the Vita and Android backends (PS2X_IS_VITA, PS2X_IS_ANDROID, the VitaSDK
# library list, the VPK packager, the SHARED Android runner and their two source files) are removed.
set(PS2X_DEFAULT_BOOT_ELF "" CACHE STRING "Guest ELF path compiled in as the default when none is given on the command line")

include(FetchContent)
set(FETCHCONTENT_QUIET FALSE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_GAMES OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    raylib
    GIT_REPOSITORY "https://github.com/raysan5/raylib.git"
    GIT_TAG c1ab645ca298a2801097931d1079b10ff7eb9df8 # 5.5
    GIT_PROGRESS TRUE
)
FetchContent_MakeAvailable(raylib)

if(PS2X_ENABLE_DEBUG_UI)
    FetchContent_Declare(
        imgui
        GIT_REPOSITORY https://github.com/ocornut/imgui.git
        GIT_TAG b1bcb12a624af7509894c8e77dd47416997777fa # v1.92.7-docking (the annotated tag's commit)
    )
    FetchContent_GetProperties(imgui)

    if(NOT imgui_POPULATED)
        FetchContent_Populate(imgui)
    endif()

    set(PS2X_IMGUI_SOURCE_DIR "${imgui_SOURCE_DIR}")

    add_library(imgui STATIC
        "${PS2X_IMGUI_SOURCE_DIR}/imgui.cpp"
        "${PS2X_IMGUI_SOURCE_DIR}/imgui_draw.cpp"
        "${PS2X_IMGUI_SOURCE_DIR}/imgui_tables.cpp"
        "${PS2X_IMGUI_SOURCE_DIR}/imgui_widgets.cpp"
        "${PS2X_IMGUI_SOURCE_DIR}/imgui_demo.cpp"
    )
    target_include_directories(imgui PUBLIC "${PS2X_IMGUI_SOURCE_DIR}")

    FetchContent_Declare(
        rlImGui
        GIT_REPOSITORY https://github.com/raylib-extras/rlImGui.git
        GIT_TAG 118221c8a532501a3c2c236b62950877cbefc2b4 # Raylib_5_5
    )
    FetchContent_GetProperties(rlImGui)

    if(NOT rlimgui_POPULATED)
        FetchContent_Populate(rlImGui)
    endif()

    set(PS2X_RLIMGUI_SOURCE_DIR "${rlimgui_SOURCE_DIR}")

    add_library(rlImGui STATIC
        "${PS2X_RLIMGUI_SOURCE_DIR}/rlImGui.cpp"
    )
    target_include_directories(rlImGui PUBLIC "${PS2X_RLIMGUI_SOURCE_DIR}")
    target_link_libraries(rlImGui PUBLIC raylib imgui)
endif()

add_library(ps2_host_backend INTERFACE)

set(PS2X_DEFAULT_BOOT_ELF_DEFINE "")

if(PS2X_DEFAULT_BOOT_ELF)
    set(PS2X_DEFAULT_BOOT_ELF_DEFINE "${PS2X_DEFAULT_BOOT_ELF}")
    string(REPLACE "\\" "\\\\" PS2X_DEFAULT_BOOT_ELF_DEFINE "${PS2X_DEFAULT_BOOT_ELF_DEFINE}")
    string(REPLACE "\"" "\\\"" PS2X_DEFAULT_BOOT_ELF_DEFINE "${PS2X_DEFAULT_BOOT_ELF_DEFINE}")
endif()

target_link_libraries(ps2_host_backend INTERFACE raylib)

option(PS2X_ENABLE_FFMPEG "Enable FFmpeg-backed MPEG video decoding" ON)

if(NOT PS2X_ENABLE_FFMPEG)
    message(STATUS "FFmpeg disabled; MPEG video decode falls back to stub frames")
    add_library(ffmpeg INTERFACE)
elseif(WIN32)
    include(ExternalProject)

    # Sprint 13 C6: FFmpeg 7.1.5 (was n7.1-241205, 7.1.0 of 2024-12-05, before the 7.1.1/7.1.2 CVE fixes) from the
    # same channel, System233/ffmpeg-msvc-prebuilt, pinned to the archive's bytes. The channel's builds are vcpkg's
    # since 2026-06: the import libraries are in lib/ (they were in bin/), and the third-party codecs are linked
    # statically into the FFmpeg DLLs (no jxl/webp/brotli/zlib DLLs beside them; THIRD_PARTY_NOTICES.md lists what
    # is inside). The hash is GitHub's own asset digest for this file, recomputed on download 2026-09-25.
    set(FFMPEG_PREBUILT_TAG "ffmpeg-7.1.5")
    set(FFMPEG_PREBUILT_URL
        "https://github.com/System233/ffmpeg-msvc-prebuilt/releases/download/${FFMPEG_PREBUILT_TAG}/ffmpeg-7.1.5_x64-windows-shared-lgpl.zip")

    set(FFMPEG_PREFIX_DIR "${CMAKE_BINARY_DIR}/ThirdParty/ffmpeg-prefix")
    set(FFMPEG_SOURCE_DIR "${FFMPEG_PREFIX_DIR}/src/ffmpeg_external")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_SOURCE_DIR}/include")
    set(FFMPEG_LIB_DIR "${FFMPEG_SOURCE_DIR}/lib")
    set(FFMPEG_BIN_DIR "${FFMPEG_SOURCE_DIR}/bin")

    ExternalProject_Add(ffmpeg_external
        URL "${FFMPEG_PREBUILT_URL}"
        URL_HASH SHA256=6c9fcb0ef3136a1e5947319f8043ec60589da3a87e8044775f89b694d236e95c
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        PREFIX "${FFMPEG_PREFIX_DIR}"
        CONFIGURE_COMMAND ""
        BUILD_COMMAND ""
        INSTALL_COMMAND ""
        BUILD_BYPRODUCTS
        "${FFMPEG_LIB_DIR}/avcodec.lib"
        "${FFMPEG_LIB_DIR}/avformat.lib"
        "${FFMPEG_LIB_DIR}/avutil.lib"
        "${FFMPEG_LIB_DIR}/swresample.lib"
        "${FFMPEG_LIB_DIR}/swscale.lib"
    )

    # Link against the import libraries shipped with the Windows DLLs.
    add_library(ffmpeg_avcodec STATIC IMPORTED GLOBAL)
    set_target_properties(ffmpeg_avcodec PROPERTIES
        IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/avcodec.lib"
        INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
    )
    add_dependencies(ffmpeg_avcodec ffmpeg_external)

    add_library(ffmpeg_avformat STATIC IMPORTED GLOBAL)
    set_target_properties(ffmpeg_avformat PROPERTIES
        IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/avformat.lib"
        INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
    )
    add_dependencies(ffmpeg_avformat ffmpeg_external)

    add_library(ffmpeg_avutil STATIC IMPORTED GLOBAL)
    set_target_properties(ffmpeg_avutil PROPERTIES
        IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/avutil.lib"
        INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
    )
    add_dependencies(ffmpeg_avutil ffmpeg_external)

    add_library(ffmpeg_swresample STATIC IMPORTED GLOBAL)
    set_target_properties(ffmpeg_swresample PROPERTIES
        IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/swresample.lib"
        INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
    )
    add_dependencies(ffmpeg_swresample ffmpeg_external)

    add_library(ffmpeg_swscale STATIC IMPORTED GLOBAL)
    set_target_properties(ffmpeg_swscale PROPERTIES
        IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/swscale.lib"
        INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
    )
    add_dependencies(ffmpeg_swscale ffmpeg_external)

    add_library(ffmpeg INTERFACE)
    target_link_libraries(ffmpeg INTERFACE
        ffmpeg_avcodec
        ffmpeg_avformat
        ffmpeg_avutil
        ffmpeg_swresample
        ffmpeg_swscale
        bcrypt
        secur32
        ws2_32
        user32
        advapi32
        ole32
        shell32
    )

    set(PS2X_FFMPEG_BIN_DIR "${FFMPEG_BIN_DIR}" CACHE INTERNAL "Directory containing FFmpeg runtime DLLs")
    set(PS2X_COPY_FFMPEG_DLLS_SCRIPT
        "${CMAKE_CURRENT_SOURCE_DIR}/cmake/CopyFfmpegDlls.cmake"
        CACHE INTERNAL
        "Script used to stage FFmpeg runtime DLLs beside executables")
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(FFMPEG REQUIRED IMPORTED_TARGET GLOBAL
        libavcodec
        libavformat
        libavutil
        libswresample
        libswscale
    )

    add_library(ffmpeg INTERFACE)
    target_link_libraries(ffmpeg INTERFACE PkgConfig::FFMPEG)
endif()

function(ps2x_stage_ffmpeg_runtime_dlls target_name)
    if(NOT WIN32)
        return()
    endif()

    if(NOT PS2X_FFMPEG_BIN_DIR OR NOT PS2X_COPY_FFMPEG_DLLS_SCRIPT)
        return()
    endif()

    if(TARGET ffmpeg_external)
        add_dependencies(${target_name} ffmpeg_external)
    endif()

    add_custom_command(
        TARGET ${target_name} POST_BUILD
        COMMAND "${CMAKE_COMMAND}"
        "-Dsource_dir=${PS2X_FFMPEG_BIN_DIR}"
        "-Ddest_dir=$<TARGET_FILE_DIR:${target_name}>"
        -P "${PS2X_COPY_FFMPEG_DLLS_SCRIPT}"
        VERBATIM
    )
endfunction()

# VU1 known programs: microcode images recompiled to C++ by vu1_replay --gen (see
# src/lib/vu/ps2_vu1_ops.h); vu1_known_programs.cpp is the table the interpreter looks up by hash.
file(GLOB PS2X_VU1_GENERATED_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/lib/vu/generated/*.cpp)
# Line tables for the generated VU1 code so vu1_replay --prof samples map back to pairs.
set_source_files_properties(${PS2X_VU1_GENERATED_SOURCES} PROPERTIES COMPILE_OPTIONS "-g1")
# VU1 native programs: hand-written host replacements of one microprogram entry point
# (vu1_native_programs.cpp is the table the interpreter looks up by image hash and entry pc).
file(GLOB PS2X_VU1_NATIVE_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/lib/vu/native/*.cpp)

# Sprint 10 Q4: the host 989snd -- the bank reader, the VAG decoder and the mixer -- as a library of its own, so
# the launcher can render the game's own menu cues from the player's disc through the very code the game plays
# them with (launcher/menu_sounds.h), without linking the runtime. The three files are exactly the ones
# ps2_runtime carried; they include nothing of the runtime but ps2_vag.h's neighbour ps2_memory.h (unused).
add_library(ps2x_snd989 STATIC
    src/lib/ps2_audio_vag.cpp
    src/lib/socom2_bank.cpp
    src/lib/snd989_mixer.cpp
)
target_include_directories(ps2x_snd989 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(ps2x_snd989 PUBLIC cxx_std_20)
target_link_libraries(ps2x_snd989 PUBLIC ps2x_shared)
if(UNIX AND NOT APPLE)
    find_package(Threads REQUIRED)
    target_link_libraries(ps2x_snd989 PUBLIC Threads::Threads)   # the mixer's stream worker is a std::thread
endif()
set_target_properties(ps2x_snd989 PROPERTIES POSITION_INDEPENDENT_CODE ON)   # as ps2x_shared (kept after C7 removed the SHARED Android runner)

add_library(ps2_runtime STATIC
    src/lib/game_overrides.cpp
    src/lib/gs/ps2_gif_arbiter.cpp
    src/lib/ps2_audio.cpp
    src/lib/host_mic.cpp
    # Sprint 10 Q4: the launcher's icon and palette on the game window's chrome (two files: raylib and windows.h
    # cannot share one).
    src/lib/host_window_chrome.cpp
    src/lib/host_window_chrome_win32.cpp
    src/lib/gs/ps2_gs_memory.cpp
    src/lib/gs/gs_frontend.cpp
    src/lib/gs/gs_cpu_backend.cpp
    src/lib/gs/gs_gl_backend.cpp
    src/lib/gs/gs_frame_backpressure.cpp
    src/lib/gs/gs_stall_coalescer.cpp
    src/lib/ps2_iop_host.cpp
    src/lib/ps2_fpu_trap.cpp
    src/lib/ps2_memory.cpp
    src/lib/ps2_pad.cpp
    src/lib/ps2_runtime.cpp
    src/lib/ps2_trace_armed.cpp   # Sprint 13 C8: PS2X_TRIGGER's latch, the runtime's own (was the game file's)
    src/lib/ps2_save_state.cpp   # Sprint 11 Task 8c: the save-state container (no runtime dependency)
    src/lib/ps2_vif1_interpreter.cpp
    src/lib/vu/ps2_vu1_core.cpp
    src/lib/vu/ps2_vu1_upper.cpp
    src/lib/vu/ps2_vu1_lower.cpp
    src/lib/games_database.cpp
    ${PS2X_VU1_GENERATED_SOURCES}
    ${PS2X_VU1_NATIVE_SOURCES}
)

if(PS2X_ENABLE_RUNTIME_LOGS)
    target_compile_definitions(ps2_runtime PUBLIC
        PS2_RUNTIME_LOGS=1
    )
endif()

if(PS2X_ENABLE_AGRESSIVE_LOGS)
    target_compile_definitions(ps2_runtime PUBLIC
        AGRESSIVE_LOGS=1
        PS2_FUNCTION_LOG_TRACKER=1
    )
endif()

if(PS2X_ENABLE_IOP_RPC_TRACE)
    target_compile_definitions(ps2_runtime PUBLIC
        PS2X_ENABLE_IOP_RPC_TRACE=1
    )
else()
    target_compile_definitions(ps2_runtime PUBLIC
        PS2X_ENABLE_IOP_RPC_TRACE=0
    )
endif()

if(PS2X_STRICT_RETURN_DIAGNOSTICS)
    target_compile_definitions(ps2_runtime PUBLIC
        PS2X_STRICT_RETURN_DIAGNOSTICS=1
    )
endif()

target_compile_definitions(ps2_runtime PRIVATE
    PS2X_HAS_FFMPEG=$<BOOL:${PS2X_ENABLE_FFMPEG}>
)

# Sprint 11 Task 19: WHICH PRESSING OF THE GAME THIS BUILD'S GENERATED CODE CAME FROM.
#
# The recompiled code is one revision's; the overlay image it runs against is a separate file chosen at
# launch. Nothing tied the two together until this define, and two parity gates on 2026-09-23 ran the
# r0004 executable on r0001's image and hung at the loading screen with nothing in the log to say why.
# build.sh passes r0001 (the default chain) and scripts/build_revision.sh passes the revision it builds;
# runtime/socom2_revision_guard.h compares it with the image's own build banner at boot and REFUSES a
# mismatch with ExitCodes::kRevisionMismatch (73). PUBLIC, so the runner, the library and ps2x_tests --
# which pins that the define really arrives -- all see the same value.
set(PS2X_GAME_REVISION "r0001" CACHE STRING "Disc revision this build's generated code was recompiled from (r0001, r0004, ...)")
target_compile_definitions(ps2_runtime PUBLIC
    PS2X_GAME_REVISION="${PS2X_GAME_REVISION}"
)

file(GLOB_RECURSE KERNEL_SRC_FILES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/lib/Kernel/*.cpp"
)

target_sources(ps2_runtime PRIVATE
    ${KERNEL_SRC_FILES}
)

set(PS2X_RUNNER_GENERATED_DIR "" CACHE PATH "Directory holding recompiler output (sub_*.cpp, register_functions.cpp, ps2_recompiled_*.h). Empty = use src/runner and include/.")
if(PS2X_RUNNER_GENERATED_DIR)
    file(GLOB RUNNER_SRC_FILES CONFIGURE_DEPENDS
        "${PS2X_RUNNER_GENERATED_DIR}/*.cpp"
    )
    # Issue #57: the unity build batches these files in list order, and GLOB orders them by name, so a rename
    # (FUN_00123450 -> a real name) moved one file across the list and shifted every batch in between: a build
    # after one rename recompiled hundreds of batches. Ordered by the guest address every generated file name
    # ends in (`_0x<start>.cpp`, kept by clampFilenameLength), a rename leaves every other batch as it was.
    # Files with no address (register_functions.cpp) go last, by name.
    set(PS2X_RUNNER_KEYED_SOURCES "")
    foreach(PS2X_RUNNER_SOURCE IN LISTS RUNNER_SRC_FILES)
        get_filename_component(PS2X_RUNNER_SOURCE_NAME "${PS2X_RUNNER_SOURCE}" NAME_WE)
        if(PS2X_RUNNER_SOURCE_NAME MATCHES "_0x([0-9a-f]+)$")
            set(PS2X_RUNNER_SOURCE_ADDRESS "${CMAKE_MATCH_1}")
            string(LENGTH "${PS2X_RUNNER_SOURCE_ADDRESS}" PS2X_RUNNER_SOURCE_ADDRESS_LENGTH)
            if(PS2X_RUNNER_SOURCE_ADDRESS_LENGTH LESS 8)
                math(EXPR PS2X_RUNNER_SOURCE_PAD "8 - ${PS2X_RUNNER_SOURCE_ADDRESS_LENGTH}")
                string(REPEAT "0" ${PS2X_RUNNER_SOURCE_PAD} PS2X_RUNNER_SOURCE_ZEROS)
                string(PREPEND PS2X_RUNNER_SOURCE_ADDRESS "${PS2X_RUNNER_SOURCE_ZEROS}")
            endif()
            set(PS2X_RUNNER_SOURCE_KEY "a${PS2X_RUNNER_SOURCE_ADDRESS}")
        else()
            set(PS2X_RUNNER_SOURCE_KEY "z${PS2X_RUNNER_SOURCE_NAME}")
        endif()
        list(APPEND PS2X_RUNNER_KEYED_SOURCES "${PS2X_RUNNER_SOURCE_KEY}|${PS2X_RUNNER_SOURCE}")
    endforeach()
    list(SORT PS2X_RUNNER_KEYED_SOURCES)
    list(TRANSFORM PS2X_RUNNER_KEYED_SOURCES REPLACE "^[^|]*\\|" "")
    set(RUNNER_SRC_FILES ${PS2X_RUNNER_KEYED_SOURCES})
    set(PS2X_GENERATED_INCLUDE_DIR "${PS2X_RUNNER_GENERATED_DIR}")
else()
    file(GLOB RUNNER_SRC_FILES CONFIGURE_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/src/runner/*.cpp"
    )
    set(PS2X_GENERATED_INCLUDE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/include")
endif()

# Sprint 8 Task 1 (Goal 1 design item 1): the runner IS the recompiled game, and the generated code is
# not in the repository. Where it is absent -- CI, a fresh clone -- the runner target and every rule that
# hangs off it is SKIPPED, not configured into a build that cannot link. ps2_runtime, ps2x_tests and the
# launcher still configure and build.
if(PS2X_RUNNER_GENERATED_DIR AND RUNNER_SRC_FILES)
    set(PS2X_BUILD_RUNNER ON)
else()
    set(PS2X_BUILD_RUNNER OFF)
    message(STATUS "ps2EntryRunner skipped: no generated code (PS2X_RUNNER_GENERATED_DIR='${PS2X_RUNNER_GENERATED_DIR}')")
endif()

set(RUNNER_MAIN_CPP "${CMAKE_CURRENT_SOURCE_DIR}/src/runner/main.cpp")
set(ROOT_MAIN_CPP "${CMAKE_CURRENT_SOURCE_DIR}/src/main.cpp")

if(EXISTS "${RUNNER_MAIN_CPP}")
    list(APPEND RUNNER_SRC_FILES "${RUNNER_MAIN_CPP}")
elseif(EXISTS "${ROOT_MAIN_CPP}")
    list(APPEND RUNNER_SRC_FILES "${ROOT_MAIN_CPP}")
endif()

if(PS2X_BUILD_RUNNER)
add_executable(ps2EntryRunner
    ${RUNNER_SRC_FILES}
)
target_include_directories(ps2EntryRunner PRIVATE "${PS2X_GENERATED_INCLUDE_DIR}")
if(UNIX AND NOT APPLE)
    # The portable folder keeps its non-system .so files in lib/ next to the binary.
    set_target_properties(ps2EntryRunner PROPERTIES
        BUILD_RPATH "\$ORIGIN/lib"
        INSTALL_RPATH "\$ORIGIN/lib"
    )
    # F5: with the modern linker default that search path is emitted as DT_RUNPATH, which
    # applies ONLY to this binary -- its dependencies do not inherit it. lib/libavcodec would
    # then look for lib/libvpx through the host's own search path and fail on a machine that
    # has no libvpx installed, which is exactly the machine the tarball exists for. DT_RPATH is
    # inherited by the whole dependency chain, so the old dtags are asked for explicitly.
    target_link_options(ps2EntryRunner PRIVATE "-Wl,--disable-new-dtags")
endif()
endif() # PS2X_BUILD_RUNNER
if(NOT MSVC AND (CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64"))
    # generated code uses SSE4.1 intrinsics (MMI/VU0 lowering)
    if(PS2X_BUILD_RUNNER)
        target_compile_options(ps2EntryRunner PRIVATE -msse4.1)
    endif()
    target_compile_options(ps2_runtime PRIVATE -msse4.1)
    target_compile_options(ps2x_snd989 PRIVATE -msse4.1)   # Q4: the mixer keeps the flags it was built with
endif()
set(PS2X_GENERATED_OPT "" CACHE STRING "Optimization flag override for the generated (recompiled) code, e.g. -O1 for fast bring-up builds")
if(PS2X_BUILD_RUNNER AND PS2X_GENERATED_OPT AND NOT MSVC)
    # Later flags win on clang: this overrides the configuration's -O3 for the runner only.
    target_compile_options(ps2EntryRunner PRIVATE ${PS2X_GENERATED_OPT})
    message("> generated code optimization override: ${PS2X_GENERATED_OPT}")
endif()
if(PS2X_BUILD_RUNNER)
# Game-specific override modules self-register via static objects; they must live in the
# executable (not the static runtime library) or the linker drops them.
target_sources(ps2EntryRunner PRIVATE src/lib/game_overrides_socom2.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_host_input.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_hostnet.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_libnetb.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_crypto.cpp)
# Sprint 13 Task C8 (audit F8): the libpad2 HLE, the msifrpc HLE and the exposure readback, out of the overrides file
# so ps2x_tests compiles the same files (ps2xTest/CMakeLists.txt) and tests them instead of linking stand-ins.
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_pad2_hle.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_msifrpc.cpp)
target_sources(ps2EntryRunner PRIVATE src/lib/socom2_lum_pixel.cpp)
set_source_files_properties(src/lib/game_overrides_socom2.cpp PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)
set_source_files_properties(src/lib/socom2_pad2_hle.cpp src/lib/socom2_msifrpc.cpp src/lib/socom2_lum_pixel.cpp
    PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)
set_source_files_properties(src/lib/socom2_hostnet.cpp PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)
set_source_files_properties(src/lib/socom2_libnetb.cpp PROPERTIES SKIP_UNITY_BUILD_INCLUSION TRUE)

if(PS2X_ENABLE_RUNNER_UNITY_BUILD)
    set_target_properties(ps2EntryRunner PROPERTIES
        UNITY_BUILD ON
        UNITY_BUILD_BATCH_SIZE "${PS2X_RUNNER_UNITY_BUILD_BATCH_SIZE}"
    )
endif()

if(PS2X_ENABLE_RUNNER_PCH)
    # Issue #57: the generated headers (ps2_recompiled_functions.h, ps2_recompiled_stubs.h) are NOT in the
    # precompiled header. They change with every rename, and a PCH every object reads would rebuild them all;
    # a generated file declares the functions it calls itself, and only register_functions.cpp includes them.
    set(PS2X_RUNNER_PCH_HEADERS
        "${CMAKE_CURRENT_SOURCE_DIR}/include/ps2_runtime_macros.h"
        "${CMAKE_CURRENT_SOURCE_DIR}/include/ps2_runtime.h"
    )

    list(APPEND PS2X_RUNNER_PCH_HEADERS
        "${CMAKE_CURRENT_SOURCE_DIR}/include/ps2_syscalls.h"
        "${CMAKE_CURRENT_SOURCE_DIR}/include/ps2_stubs.h"
    )

    target_precompile_headers(ps2EntryRunner PRIVATE ${PS2X_RUNNER_PCH_HEADERS})
endif()

if(PS2X_DEFAULT_BOOT_ELF_DEFINE)
    target_compile_definitions(ps2EntryRunner PRIVATE
        PS2X_DEFAULT_BOOT_ELF="${PS2X_DEFAULT_BOOT_ELF_DEFINE}"
    )
endif()

if(MSVC)
    target_compile_options(ps2EntryRunner PRIVATE /FS)
endif()
endif() # PS2X_BUILD_RUNNER

target_include_directories(ps2_runtime PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src/lib/Kernel
)

target_link_libraries(ps2_runtime PUBLIC ps2_host_backend ffmpeg ps2_iop ps2x_shared ps2x_snd989)
if(UNIX AND NOT APPLE)
    # Sprint 8 Goal 1: dladdr (the crash handler and the sampler's module base), timer_create (glibc < 2.34 keeps it
    # in librt), pthreads -- on the library so the runner, the tests and the tools inherit them.
    find_package(Threads REQUIRED)
    # F10: timer_create lives in librt only on glibc < 2.34; newer glibc folded it into libc and
    # some distributions ship no librt at all, where an unconditional -lrt fails the link. Ask
    # for it, link it when it is there.
    find_library(PS2X_RT_LIB rt)
    target_link_libraries(ps2_runtime PUBLIC ${CMAKE_DL_LIBS} Threads::Threads)
    if(PS2X_RT_LIB)
        target_link_libraries(ps2_runtime PUBLIC ${PS2X_RT_LIB})
    endif()
endif()

# Sprint 7 Task 9b: host_mic.cpp includes raylib's own miniaudio.h (without MINIAUDIO_IMPLEMENTATION --
# raudio.c already compiled it into libraylib), so it needs the raylib source tree on the include path.
if(TARGET raylib)
    target_include_directories(ps2_runtime PRIVATE $<TARGET_PROPERTY:raylib,SOURCE_DIR>/external)
endif()
if(PS2X_BUILD_RUNNER)
target_link_libraries(ps2EntryRunner
    PRIVATE
    ps2_runtime
)

if(PS2X_ENABLE_DEBUG_UI)
    target_sources(ps2EntryRunner PRIVATE
        src/lib/ps2_debug_panel.cpp
    )
    target_link_libraries(ps2EntryRunner PRIVATE rlImGui imgui)
    target_compile_definitions(ps2EntryRunner PRIVATE PS2X_ENABLE_DEBUG_UI=1)
endif()

ps2x_stage_ffmpeg_runtime_dlls(ps2EntryRunner)
endif() # PS2X_BUILD_RUNNER

if(CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo")
    EnableFastReleaseMode(ps2_runtime)
    EnableFastReleaseMode(ps2x_snd989)
    if(PS2X_BUILD_RUNNER)
        EnableFastReleaseMode(ps2EntryRunner)
    endif()

    if(PS2X_BUILD_RUNNER AND WIN32 AND NOT PS2X_SHOW_WINDOWS_CONSOLE)
        if(MSVC)
            target_link_options(ps2EntryRunner PRIVATE
                $<$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>>:/SUBSYSTEM:WINDOWS>
                $<$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>>:/ENTRY:mainCRTStartup>
            )
        elseif(MINGW)
            target_link_options(ps2EntryRunner PRIVATE
                $<$<OR:$<CONFIG:Release>,$<CONFIG:RelWithDebInfo>>:-mwindows>
            )
        endif()
    endif()
endif()

# Work around WinAPI vs raylib symbol clash for CloseWindow/ShowCursor on x64 (Windows only by
# construction: there is no such clash on Linux, so the flag never reaches that link).
if(PS2X_BUILD_RUNNER)
if(MSVC)
    target_link_options(ps2EntryRunner PRIVATE "/FORCE:MULTIPLE")
elseif(WIN32)
    target_link_options(ps2EntryRunner PRIVATE "-Wl,--allow-multiple-definition")
endif()
endif() # PS2X_BUILD_RUNNER

install(TARGETS ps2_runtime
    RUNTIME DESTINATION bin
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
)

if(PS2X_BUILD_RUNNER)
    install(TARGETS ps2EntryRunner
        RUNTIME DESTINATION bin
        LIBRARY DESTINATION lib
        ARCHIVE DESTINATION lib
    )
endif()

if(WIN32 AND PS2X_ENABLE_FFMPEG)
    install(DIRECTORY "${FFMPEG_BIN_DIR}/"
        DESTINATION bin
        FILES_MATCHING
        PATTERN "*.dll"
    )
endif()

install(DIRECTORY include/
    DESTINATION include
)

# Offline VU1 program replay (tools_py/vu1dis.py + PS2X_VU1_DUMP dumps); no generated code needed.
add_executable(vu1_replay src/tools/vu1_replay.cpp src/tools/vu1_gen.cpp)
target_link_libraries(vu1_replay PRIVATE ps2_runtime)
if(NOT MSVC AND (CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64"))
    target_compile_options(vu1_replay PRIVATE -msse4.1)
endif()
