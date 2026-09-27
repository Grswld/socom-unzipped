# SOCOM Unzipped launcher (Task 8b): the window that owns the game's configuration and starts socom2.exe.
# ps2x_launcher_core holds the launcher's pure UI logic (focus, pad geometry); the ISO 9660 lookup, SHA-256,
# config.json and the environment live in ps2x_shared (Sprint 9 Goal 1), which it links PUBLIC.
# The raylib window is socom_unzipped_launcher.
# Sprint 8 Goal 9: src/ui/focus.cpp joins it -- the page layout, the focus model and the launch-blocked
# reasons are pure (no raylib), and launcher_tests.cpp asserts on the very rects the pages draw.
add_library(ps2x_launcher_core STATIC
    src/ui/focus.cpp
    src/ui/pad_geometry.cpp
    # Sprint 9 Goal 9 (P3): the pad-to-intent gate. Pure, and in the core so the tests can hold a stick
    # down for five simulated seconds and prove the launcher reads nothing while the game has the pad.
    src/ui/pad_input.cpp
    # Sprint 10 Goal 8: the press-the-button-to-bind flow, the cells' order and the pad's own button names.
    # Pure, and in the core so the tests drive a whole bind, a conflict and a restore with no window.
    src/ui/bind_flow.cpp
    # Issue #74: the tooltips -- the mechanism (tips.cpp) and each page's own table, pure so a test walks a page's
    # focus list and holds every control to a line.
    src/ui/tips.cpp
    # Sprint 10 Q4: the menu cues out of the player's own disc -- the HUDUI bank read through iso9660::Reader,
    # rendered by the runtime's 989snd mixer (ps2x_snd989), cached as WAV. Pure; main.cpp plays the files.
    src/menu_sounds.cpp
)
target_include_directories(ps2x_launcher_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src        # "ui/focus.h", "ui/theme.h", "ui/pad_render.h", "ui/glyphs.h"
)
target_compile_features(ps2x_launcher_core PUBLIC cxx_std_20)
# Sprint 9 Goal 1: iso9660, sha256 and launcher_config moved to ps2x_shared (the runner reads config.json too).
# Sprint 10 Q4: ps2x_snd989 is the runtime's own bank reader, VAG decoder and mixer, split out for this.
target_link_libraries(ps2x_launcher_core PUBLIC ps2x_shared ps2x_snd989)

# The window. WIN32 keeps the console away; the runner's raylib target is available here (ps2xRuntime fetched it).
# Sprint 8 Task 1: the WIN32 keyword exists only on Windows, so it is passed through a variable that is empty
# elsewhere; the same win32glue interface is implemented by src/posix_glue.cpp on Unix.
if(WIN32)
    set(PS2X_LAUNCHER_EXE_TYPE WIN32)
else()
    set(PS2X_LAUNCHER_EXE_TYPE "")
endif()
# Sprint 13 Task C7 (audit F21): three faces; Rajdhani Bold was embedded and never drawn (Face::Bold is SemiBold).
# Sprint 11 Task 17 (R247): the embedded faces. src/ui/fonts_embedded/*.h used to be tracked -- 6.8 MB of
# hex for 4.6 MB of .ttf, the same bytes in the tree twice. The .ttf files under assets/fonts/ are the single
# tracked copy now and the headers are generated into the build tree by scripts/embed_font.py, which the repo
# already had. src/ui/fonts.cpp includes them as "fonts_embedded/<name>.h"; that resolves because the generated
# directory is on the target's include path below.
get_filename_component(PS2X_EMBED_FONT_SCRIPT
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../scripts/embed_font.py" REALPATH)
if(NOT EXISTS "${PS2X_EMBED_FONT_SCRIPT}")
    message(FATAL_ERROR "embed_font.py not found at ${PS2X_EMBED_FONT_SCRIPT}; the launcher's fonts are generated from it")
endif()
find_package(Python3 COMPONENTS Interpreter REQUIRED)

set(PS2X_LAUNCHER_FONTS_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(PS2X_LAUNCHER_FONT_HEADERS "")
# <ttf under assets/fonts>|<header basename>|<symbol, as src/ui/fonts.cpp names it>
foreach(PS2X_FONT IN ITEMS
        "Rajdhani-Medium.ttf|rajdhani_medium.h|RajdhaniMedium"
        "Rajdhani-SemiBold.ttf|rajdhani_semibold.h|RajdhaniSemiBold"
        "SairaStencilOne-Regular.ttf|saira_stencil_one.h|SairaStencilOne")
    string(REPLACE "|" ";" PS2X_FONT_PARTS "${PS2X_FONT}")
    list(GET PS2X_FONT_PARTS 0 PS2X_FONT_TTF)
    list(GET PS2X_FONT_PARTS 1 PS2X_FONT_HEADER)
    list(GET PS2X_FONT_PARTS 2 PS2X_FONT_SYMBOL)
    set(PS2X_FONT_IN "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/${PS2X_FONT_TTF}")
    set(PS2X_FONT_OUT "${PS2X_LAUNCHER_FONTS_GENERATED_DIR}/fonts_embedded/${PS2X_FONT_HEADER}")
    add_custom_command(
        OUTPUT "${PS2X_FONT_OUT}"
        COMMAND "${Python3_EXECUTABLE}" "${PS2X_EMBED_FONT_SCRIPT}"
                "${PS2X_FONT_IN}" "${PS2X_FONT_OUT}" "${PS2X_FONT_SYMBOL}"
        DEPENDS "${PS2X_FONT_IN}" "${PS2X_EMBED_FONT_SCRIPT}"
        COMMENT "embed_font: ${PS2X_FONT_TTF} -> fonts_embedded/${PS2X_FONT_HEADER}"
        VERBATIM
    )
    list(APPEND PS2X_LAUNCHER_FONT_HEADERS "${PS2X_FONT_OUT}")
endforeach()

add_executable(socom_unzipped_launcher ${PS2X_LAUNCHER_EXE_TYPE}
    ${PS2X_LAUNCHER_FONT_HEADERS}
    src/main.cpp
    src/win32_glue.cpp
    src/mic_devices.cpp
    # Sprint 8 Goal 9: the redesigned UI. focus.cpp is in ps2x_launcher_core above (it is pure and tested).
    src/ui/fonts.cpp
    src/ui/widgets.cpp
    src/ui/glyphs.cpp
    src/ui/pad_render.cpp
    src/ui/page_play.cpp
    src/ui/page_disc.cpp
    src/ui/page_video.cpp
    src/ui/page_audio.cpp
    src/ui/page_controller.cpp
    src/ui/page_microphone.cpp
    src/ui/page_online.cpp
    src/ui/page_report.cpp
    src/ui/page_about.cpp
)
if(UNIX)
    target_sources(socom_unzipped_launcher PRIVATE src/posix_glue.cpp)
    # Sprint 10 Q4: the window switch opens libX11 with dlopen (glibc < 2.34 keeps dlopen in libdl); the link
    # line gains no X11 and the portable folder's closure does not change.
    target_link_libraries(socom_unzipped_launcher PRIVATE ${CMAKE_DL_LIBS})
endif()
target_link_libraries(socom_unzipped_launcher PRIVATE ps2x_launcher_core raylib)
# Sprint 7 Task 9a: miniaudio ships inside raylib's own sources and is already compiled into libraylib
# (raudio.c:178), so mic_devices.cpp needs only its declarations: it includes the header WITHOUT
# MINIAUDIO_IMPLEMENTATION.
target_include_directories(socom_unzipped_launcher PRIVATE $<TARGET_PROPERTY:raylib,SOURCE_DIR>/external)
# Sprint 11 Task 17 (R247): where the generated fonts_embedded/*.h land, so fonts.cpp's includes resolve.
target_include_directories(socom_unzipped_launcher PRIVATE ${PS2X_LAUNCHER_FONTS_GENERATED_DIR})
if(WIN32)
    # winhttp: Sprint 9 Goal 8's bug report and status line (win32glue::httpRequest). Windows only -- the POSIX
    # glue starts curl instead, so the Linux build links nothing new.
    target_link_libraries(socom_unzipped_launcher PRIVATE comdlg32 shell32 winhttp)
endif()
if(UNIX AND NOT APPLE)
    # The portable folder keeps its non-system .so files in lib/ next to the binary.
    set_target_properties(socom_unzipped_launcher PROPERTIES
        BUILD_RPATH "\$ORIGIN/lib"
        INSTALL_RPATH "\$ORIGIN/lib"
    )
    # F5: DT_RPATH rather than the default DT_RUNPATH -- a RUNPATH is not inherited by this
    # binary's dependencies, so lib/*.so could not find each other on a host without them.
    target_link_options(socom_unzipped_launcher PRIVATE "-Wl,--disable-new-dtags")
endif()
target_compile_features(socom_unzipped_launcher PRIVATE cxx_std_20)
