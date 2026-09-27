# Sprint 9 Goal 1: what the runner (socom2) and the launcher both need, and nothing either of them owns.
# Plain C++20: no raylib, no GL, no ps2_runtime. The runner links this so that it never links the launcher;
# the launcher's tested core (ps2x_launcher_core) links it PUBLIC, so every existing
# #include "launcher/launcher_config.h" keeps resolving.
add_library(ps2x_shared STATIC
    src/iso9660.cpp
    src/sha256.cpp
    src/launcher_config.cpp
    src/preflight.cpp
    src/exe_dir.cpp
    src/bare_run.cpp
    src/process_fatal.cpp
    src/zip_store.cpp
    src/diagnostics.cpp
    src/bug_report.cpp
    src/patch_fetch.cpp   # Sprint 16 R2a (#71): the r0004 package's URL and its check
    src/mapping.cpp
    src/knobs.cpp
    src/host_window.cpp   # Sprint 10 Q4: the game window's title and the launcher's palette on its chrome
)
target_include_directories(ps2x_shared PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(ps2x_shared PUBLIC cxx_std_20)
# PIC: kept from upstream's SHARED Android runner (removed by Sprint 13 Task C7); a harmless default here.
set_target_properties(ps2x_shared PROPERTIES POSITION_INDEPENDENT_CODE ON)
