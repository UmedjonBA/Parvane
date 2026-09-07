# Parvane Android: сборка parvane_core как статической либы под NDK.
# Отличия от desktop/parvane-core/CMakeLists.txt:
#  - без cnats (src/transport.cpp исключён): на Android транспорт только WSS
#    (GatewayWsTransport), прямой NATS не нужен;
#  - nlohmann/json — вендоренный single-header (без сети/FetchContent);
#  - OpenSSL и libparvane_e2e.a берутся из готовых префиксов под ABI
#    (PARVANE_OPENSSL_DIR, PARVANE_E2E_LIB), собранных заранее скриптами.
cmake_minimum_required(VERSION 3.22)
project(parvane_core_android LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CORE ${CMAKE_CURRENT_SOURCE_DIR}/../../desktop/parvane-core)
set(REPO ${CMAKE_CURRENT_SOURCE_DIR}/../..)

# Из Gradle (externalNativeBuild) префиксы выводим из ANDROID_ABI: OpenSSL —
# android/prebuilt/openssl/<ABI> (build-openssl.sh), e2e — target/<rust>/release
# (cargo ndk … -p parvane-e2e --release, см. build-core.sh).
if(NOT DEFINED PARVANE_OPENSSL_DIR)
  set(PARVANE_OPENSSL_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../prebuilt/openssl/${ANDROID_ABI})
endif()
if(NOT DEFINED PARVANE_E2E_LIB)
  if(ANDROID_ABI STREQUAL "arm64-v8a")
    set(_rust aarch64-linux-android)
  elseif(ANDROID_ABI STREQUAL "armeabi-v7a")
    set(_rust armv7-linux-androideabi)
  elseif(ANDROID_ABI STREQUAL "x86_64")
    set(_rust x86_64-linux-android)
  else()
    set(_rust i686-linux-android)
  endif()
  set(PARVANE_E2E_LIB ${REPO}/target/${_rust}/release/libparvane_e2e.a)
endif()
if(NOT EXISTS ${PARVANE_OPENSSL_DIR}/lib/libcrypto.a)
  message(FATAL_ERROR "нет OpenSSL под ${ANDROID_ABI}: ${PARVANE_OPENSSL_DIR} (android/build-openssl.sh)")
endif()
if(NOT EXISTS ${PARVANE_E2E_LIB})
  message(FATAL_ERROR "нет libparvane_e2e.a: ${PARVANE_E2E_LIB} (android/build-core.sh)")
endif()

add_library(parvane_core STATIC
    ${CORE}/src/gateway_transport.cpp
    ${CORE}/src/gateway_ws_transport.cpp
    ${CORE}/src/e2e.cpp
    ${CORE}/src/linking.cpp
    ${CORE}/src/blobcrypt.cpp
    ${CORE}/src/messenger_client.cpp
    ${CORE}/src/cloud_client.cpp
    ${CORE}/src/call_client.cpp
    ${CORE}/src/crypto.cpp
    ${CORE}/src/call_session.cpp
    ${CORE}/src/call_manager.cpp
    ${CORE}/src/group_client.cpp
    ${CORE}/src/group_call_manager.cpp)

target_include_directories(parvane_core PUBLIC
    ${CORE}/include
    ${REPO}/shared/parvane-e2e/include
    ${CMAKE_CURRENT_SOURCE_DIR}/../third_party        # nlohmann/json.hpp
    ${PARVANE_OPENSSL_DIR}/include)

# nlohmann-джей-сон в исходниках подключается как <nlohmann/json.hpp>
# (вендоренный заголовок лежит в third_party/nlohmann/json.hpp).

target_link_libraries(parvane_core PUBLIC
    ${PARVANE_OPENSSL_DIR}/lib/libssl.a
    ${PARVANE_OPENSSL_DIR}/lib/libcrypto.a
    ${PARVANE_E2E_LIB}
    log)

# ── JNI-фасад для shim'а org.drinkless.tdlib.Client (libparvane_jni.so) ──────
add_library(parvane_jni SHARED ${CMAKE_CURRENT_SOURCE_DIR}/parvane_jni.cpp)
target_link_libraries(parvane_jni PRIVATE parvane_core log)
# Символы JNI наружу, остальное — скрыть (меньше .so, нет конфликтов)
target_compile_options(parvane_jni PRIVATE -fvisibility=hidden)
set_target_properties(parvane_jni PROPERTIES CXX_VISIBILITY_PRESET hidden)
