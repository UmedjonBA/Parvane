# Parvane Android: ядро parvane-core и JNI-фасад под NDK (spec 031 — только протокол v2, как desktop spec 029).
# Список исходников ядра — ТОТ ЖЕ, что у desktop/parvane-core/CMakeLists.txt (сторож android/tools/check_core_sources.sh);
# разделы «План», «Знания», «Облако» — библиотека parvane_sections (C++20, все src/sections/*.cpp).
# Отличия от desktop: nlohmann/json — вендоренный single-header; OpenSSL и libparvane_protocol_ffi.a (движок v2,
# cargo ndk) — из готовых префиксов под ABI (android/build-core.sh); без cnats и без parvane-e2e (v1 удалён).
cmake_minimum_required(VERSION 3.22)
project(parvane_core_android LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../../desktop/parvane-core)
set(REPO ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(BACKEND ${REPO}/backend)

if(NOT DEFINED PARVANE_OPENSSL_DIR)
  set(PARVANE_OPENSSL_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../prebuilt/openssl/${ANDROID_ABI})
endif()
if(NOT DEFINED PARVANE_PROTOCOL_LIB)
  if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(_rust aarch64-linux-android)
  elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(_rust armv7-linux-androideabi)
  elseif(ANDROID_ABI STREQUAL "x86_64")
    set(_rust x86_64-linux-android)
  else()
    set(_rust i686-linux-android)
  endif()
  set(PARVANE_PROTOCOL_LIB ${BACKEND}/target/${_rust}/release/libparvane_protocol_ffi.a)
endif()
if(NOT EXISTS ${PARVANE_OPENSSL_DIR}/lib/libcrypto.a)
  message(FATAL_ERROR "нет OpenSSL под ${ANDROID_ABI}: ${PARVANE_OPENSSL_DIR} (android/build-openssl.sh)")
endif()
if(NOT EXISTS ${PARVANE_PROTOCOL_LIB})
  message(FATAL_ERROR "нет libparvane_protocol_ffi.a: ${PARVANE_PROTOCOL_LIB} (android/build-core.sh)")
endif()

# ── ядро: тот же список, что у desktop (сторож сверяет) ─────────────────────
add_library(parvane_core STATIC
    ${CORE}/src/gateway_ws_transport.cpp
    ${CORE}/src/linking.cpp
    ${CORE}/src/blobcrypt.cpp
    ${CORE}/src/storecrypt.cpp
    ${CORE}/src/local_files.cpp
    ${CORE}/src/keybackup.cpp
    ${CORE}/src/keybundle.cpp
    ${CORE}/src/l2_ticker.cpp
    ${CORE}/src/queue_watchdog.cpp
    ${CORE}/src/map_tiles.cpp
    ${CORE}/src/pack_archive.cpp
    ${CORE}/src/crypto.cpp
    ${CORE}/src/call_session.cpp
    ${CORE}/src/call_manager.cpp
    ${CORE}/src/group_call_manager.cpp
    ${CORE}/src/v2_engine.cpp
    ${CORE}/src/v2_content.cpp
    ${CORE}/src/v2_link.cpp
    ${CORE}/src/v2_control.cpp
    ${CORE}/src/v2_account.cpp
    ${CORE}/src/v2_session.cpp
    ${CORE}/src/v2_session_account.cpp
    ${CORE}/src/v2_session_groups.cpp)
target_include_directories(parvane_core PUBLIC
    ${CORE}/include
    ${BACKEND}/protocol/ffi/include                    # parvane_protocol.h (cbindgen)
    ${CMAKE_CURRENT_SOURCE_DIR}/../third_party        # nlohmann/json.hpp
    ${PARVANE_OPENSSL_DIR}/include)
target_link_libraries(parvane_core PUBLIC
    ${PARVANE_OPENSSL_DIR}/lib/libssl.a
    ${PARVANE_OPENSSL_DIR}/lib/libcrypto.a
    ${PARVANE_PROTOCOL_LIB}
    log)

# ── разделы (порт web с тестами в desktop/parvane-core/tests/sections) ──────
file(GLOB PARVANE_SECTIONS_SRC CONFIGURE_DEPENDS ${CORE}/src/sections/*.cpp)
add_library(parvane_sections STATIC ${PARVANE_SECTIONS_SRC})
target_include_directories(parvane_sections PUBLIC
    ${CORE}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../third_party)

# ── JNI-фасад для шва org.drinkless.tdlib.Client (libparvane_jni.so) ────────
add_library(parvane_jni SHARED
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_main.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_session.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_messages.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_groups.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_account.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_calls.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_push.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_sections.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/jni_planner_ops.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/protocol_jni.cpp)   # ParvaneProtocol (движок v2 без сети, векторы)
target_link_libraries(parvane_jni PRIVATE parvane_sections parvane_core log)
target_compile_options(parvane_jni PRIVATE -fvisibility=hidden)
set_target_properties(parvane_jni PROPERTIES CXX_VISIBILITY_PRESET hidden)
# Вне Debug — стрипаем при линковке (AGP не стрипает .so из библиотечного модуля с NDK вне SDK)
target_link_options(parvane_jni PRIVATE $<$<NOT:$<CONFIG:Debug>>:-s>)
