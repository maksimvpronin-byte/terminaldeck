# The registry still provides 1.3.2. Use the official 1.4 release archive until
# it catches up; the digest also prevents a cached older archive being reused.
vcpkg_download_distfile(ARCHIVE
    URLS "https://github.com/madler/zlib/releases/download/v${VERSION}/zlib-${VERSION}.tar.gz"
    FILENAME "zlib-${VERSION}.tar.gz"
    SHA512 13f02285da85956ff722d814695b96807aff7a511ebf4b6d98cf708c353920666093cc18b6653cd7992c8e75c103f7b4baf2de3a105c2db9dcd62bab2c940859
)
vcpkg_extract_source_archive(SOURCE_PATH ARCHIVE "${ARCHIVE}")
string(COMPARE EQUAL "${VCPKG_LIBRARY_LINKAGE}" "dynamic" ZLIB_BUILD_SHARED)
string(COMPARE EQUAL "${VCPKG_LIBRARY_LINKAGE}" "static" ZLIB_BUILD_STATIC)
vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DZLIB_BUILD_TESTING=OFF
        -DZLIB_BUILD_SHARED=${ZLIB_BUILD_SHARED}
        -DZLIB_BUILD_STATIC=${ZLIB_BUILD_STATIC}
)
vcpkg_cmake_install()
vcpkg_copy_pdbs()
vcpkg_cmake_config_fixup(CONFIG_PATH "lib/cmake/zlib")
vcpkg_fixup_pkgconfig()

# zlib 1.4 calls the MSVC libraries libz/libzs, including in pkg-config.
if(VCPKG_TARGET_IS_WINDOWS)
    if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
        set(PC_LIBRARY libzs)
    else()
        set(PC_LIBRARY libz)
    endif()
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/lib/pkgconfig/zlib.pc" " -lz" " -l${PC_LIBRARY}")
    if(NOT VCPKG_BUILD_TYPE)
        vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/zlib.pc" " -lz" " -l${PC_LIBRARY}d")
    endif()
endif()
if(NOT VCPKG_BUILD_TYPE)
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/debug/lib/pkgconfig/zlib.pc" "/include" "/../include")
endif()
if(VCPKG_LIBRARY_LINKAGE STREQUAL "static")
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/include/zconf.h" "ifdef ZLIB_DLL" "if 0")
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/share/zlib/ZLIBConfig.cmake" [[_ZLIB_supported_components "shared" "static"]] [[_ZLIB_supported_components "static"]])
else()
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/include/zconf.h" "ifdef ZLIB_DLL" "if 1")
    vcpkg_replace_string("${CURRENT_PACKAGES_DIR}/share/zlib/ZLIBConfig.cmake" [[_ZLIB_supported_components "shared" "static"]] [[_ZLIB_supported_components "shared"]])
endif()
file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include" "${CURRENT_PACKAGES_DIR}/debug/share")
file(INSTALL "${CMAKE_CURRENT_LIST_DIR}/vcpkg-cmake-wrapper.cmake" DESTINATION "${CURRENT_PACKAGES_DIR}/share/${PORT}")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/LICENSE")
