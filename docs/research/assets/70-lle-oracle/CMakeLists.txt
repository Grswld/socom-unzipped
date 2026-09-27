cmake_minimum_required(VERSION 3.21)
project(lle_oracle LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 1. The slice as #254 ships it (Sinan-Karakaya/PS2Recomp@e42efbe ps2xIOP/src/lle), unpatched: does it build?
set(FORK_LLE "${CMAKE_CURRENT_SOURCE_DIR}/../fork/ps2xIOP/src/lle")
add_library(lle_pristine STATIC ${FORK_LLE}/cpu.cpp ${FORK_LLE}/iop.cpp ${FORK_LLE}/irx.cpp ${FORK_LLE}/kernel.cpp ${FORK_LLE}/spu2.cpp)

# 2. The patched copy (ORACLE PATCH) and the harness with the cdvdman/ioman/sifman provider.
set(LLE "${CMAKE_CURRENT_SOURCE_DIR}/lle")
add_executable(harness_lle harness_lle.cpp ${LLE}/cpu.cpp ${LLE}/iop.cpp ${LLE}/irx.cpp ${LLE}/kernel.cpp ${LLE}/spu2.cpp)
target_include_directories(harness_lle PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_link_options(harness_lle PRIVATE -static)
