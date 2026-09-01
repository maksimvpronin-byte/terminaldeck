# Builds td-rdp against a FreeRDP that has already been built and installed.
#
# Separate from FreeRDP's own tree on purpose. Building inside it would mean
# carrying a patch against an upstream project across every version bump, for a
# program that uses nothing but its public headers.
#
# Point CMAKE_PREFIX_PATH at the install prefix that build-<platform>.sh
# produced; there is nothing else to configure.
cmake_minimum_required(VERSION 3.16)
project(td-rdp C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Named as the package names itself, which is not what the directory holding it
# is called: the files are FreeRDPConfig.cmake and friends under lib/cmake/
# FreeRDP3/, and CMake searches by the package name. Asking for FreeRDP3 finds
# nothing and says so at some length.
find_package(FreeRDP 3.31 REQUIRED)
find_package(FreeRDP-Client 3.31 REQUIRED)
find_package(WinPR 3.31 REQUIRED)

add_executable(td-rdp td_rdp.c td_proto.c)
target_link_libraries(td-rdp PRIVATE freerdp-client freerdp winpr)

# Warnings are worth having in a program that reads a socket and writes a
# framebuffer, and this is small enough that keeping it clean costs nothing.
if(NOT MSVC)
  target_compile_options(td-rdp PRIVATE -Wall -Wextra)
endif()

# So the shipped binary finds the libraries beside it rather than at the
# absolute paths of the machine that built it. The rest of making this portable
# — the Homebrew dylibs underneath — is bundle-macos.sh's job.
if(APPLE)
  set_target_properties(td-rdp PROPERTIES
    BUILD_WITH_INSTALL_RPATH TRUE
    INSTALL_RPATH "@executable_path/../lib")
elseif(UNIX)
  set_target_properties(td-rdp PROPERTIES
    BUILD_WITH_INSTALL_RPATH TRUE
    INSTALL_RPATH "$ORIGIN/../lib")
endif()

install(TARGETS td-rdp RUNTIME DESTINATION bin)
