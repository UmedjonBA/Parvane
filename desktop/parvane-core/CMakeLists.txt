# Parvane fork: переносимое ядро клиента (движок v2 через C ABI, WebSocket/TCP, nlohmann/json), без Qt.
# Собирается standalone (тесты) и как под-проект внутри сборки tdesktop; общее с Android (jni).
cmake_minimum_required(VERSION 3.20)
project(parvane_core LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# ── nlohmann/json (header-only) ───────────────────────────────────────────────
set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_Declare(nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.12.0
    GIT_SHALLOW TRUE)

FetchContent_MakeAvailable(nlohmann_json)

# ── OpenSSL (Ed25519 для аутентификации сигналинга звонков) ───────────────────
find_package(OpenSSL REQUIRED)

# Cargo workspace — backend/ (../../backend относительно этого файла).
set(PARVANE_BACKEND_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../backend)
find_program(CARGO_EXE cargo REQUIRED)

# ── parvane-protocol-ffi (Rust staticlib, движок протокола v2, spec 007) ──────
# C ABI движка: кадры, конверты, журналы устройств, состояние клиента. Кадры
# и тела v2 разбирает и собирает ТОЛЬКО он (своего protobuf в C++ нет).
# Протокол v1 (Olm/Megolm, parvane-e2e, NATS) удалён в spec 029 — только движок v2.
# Заголовок parvane_protocol.h генерирует cbindgen при cargo build.
set(PARVANE_PROTOCOL_LIB ${PARVANE_BACKEND_DIR}/target/debug/libparvane_protocol_ffi.a)
add_custom_target(parvane_protocol_build ALL
    COMMAND ${CARGO_EXE} build -p parvane-protocol-ffi
    WORKING_DIRECTORY ${PARVANE_BACKEND_DIR}
    BYPRODUCTS ${PARVANE_PROTOCOL_LIB}
    COMMENT "cargo build parvane-protocol-ffi (движок v2, staticlib)")

# ── parvane_core ─────────────────────────────────────────────────────────────
add_library(parvane_core STATIC
    src/gateway_transport.cpp
    src/gateway_ws_transport.cpp
    src/linking.cpp
    src/blobcrypt.cpp
    src/storecrypt.cpp
    src/keybackup.cpp
    src/keybundle.cpp
    src/l2_ticker.cpp
    src/map_tiles.cpp
    src/pack_archive.cpp
    src/cloud_client.cpp
    src/crypto.cpp
    src/call_session.cpp
    src/call_manager.cpp
    src/group_call_manager.cpp
    src/v2_engine.cpp
    src/v2_content.cpp
    src/v2_link.cpp
    src/v2_control.cpp
    src/v2_bridge.cpp
    src/v2_session.cpp
    src/v2_session_account.cpp
    src/v2_session_groups.cpp)
add_dependencies(parvane_core parvane_protocol_build)
target_include_directories(parvane_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
           ${PARVANE_BACKEND_DIR}/protocol/ffi/include)
target_link_libraries(parvane_core
    PUBLIC nlohmann_json::nlohmann_json
    PRIVATE OpenSSL::SSL OpenSSL::Crypto
            ${PARVANE_PROTOCOL_LIB} pthread dl m)

# ── логика разделов (spec 029: порт web — «План», «Знания», «Облако», палитра, выгрузка) ──
# Чистая логика без Qt и сети; экраны tdesktop подключат её на этапе L3. C++20, как tdesktop.
file(GLOB PARVANE_SECTIONS_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/sections/*.cpp)
add_library(parvane_sections STATIC ${PARVANE_SECTIONS_SRC})
target_compile_features(parvane_sections PUBLIC cxx_std_20)
target_include_directories(parvane_sections PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(parvane_sections PUBLIC nlohmann_json::nlohmann_json)

# ── probe-бинарь + тесты (де-риск транспорта; нужен живой backend) ────────────
# P-45/P-46: dev-хуки (PARVANE_WSS_INSECURE, ws:// к gateway, PARVANE_AUTO* в
# tdesktop) компилируются ТОЛЬКО с -DPARVANE_DEV=ON. В релизе их нет вовсе —
# переменная окружения в прод-запуске не отключит проверку TLS.
option(PARVANE_DEV "Compile dev/e2e hooks (insecure TLS, ws://, PARVANE_AUTO*)" OFF)
# PRIVATE: заголовки ядра PARVANE_DEV не используют; потребителям (tdesktop)
# определение ставится точечно на файлы с хуками — иначе смена флага
# пересобирает все ~3600 объектов Telegram.
if (PARVANE_DEV)
    target_compile_definitions(parvane_core PRIVATE PARVANE_DEV=1)
endif()

option(PARVANE_CORE_BUILD_PROBE "Build parvane-core tests" ON)
if (PARVANE_CORE_BUILD_PROBE)
    set(PARVANE_VECTORS ${CMAKE_CURRENT_SOURCE_DIR}/../../proto/parvane/vectors)
    foreach(t crypto blobcrypt storecrypt linking call_session call_manager map_tiles pack poll v2 v2_session
              l2_ticker)
        add_executable(parvane_${t}_tests tests/${t}_tests.cpp)
        target_link_libraries(parvane_${t}_tests PRIVATE parvane_core)
    endforeach()
    # Общие векторы conformance v2 (SEAL-1, GSEAL-1, приглашения) через C ABI и векторы форматов web ↔ desktop
    foreach(t protocol_vectors webcompat)
        add_executable(parvane_${t}_tests tests/${t}_tests.cpp)
        target_link_libraries(parvane_${t}_tests PRIVATE parvane_core)
        target_include_directories(parvane_${t}_tests PRIVATE ${PARVANE_BACKEND_DIR}/protocol/ffi/include)
        target_compile_definitions(parvane_${t}_tests PRIVATE PARVANE_VECTORS_DIR="${PARVANE_VECTORS}")
    endforeach()

    enable_testing()
    foreach(t crypto blobcrypt storecrypt linking call_session call_manager map_tiles pack poll v2 l2_ticker
              protocol_vectors webcompat)
        add_test(NAME ${t} COMMAND parvane_${t}_tests)
    endforeach()
    # Тесты разделов (порт vitest web): по бинарю на файл
    file(GLOB PARVANE_SECTIONS_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/tests/sections/*_tests.cpp)
    foreach(src ${PARVANE_SECTIONS_TESTS})
        get_filename_component(t ${src} NAME_WE)
        add_executable(parvane_sections_${t} ${src})
        target_link_libraries(parvane_sections_${t} PRIVATE parvane_sections)
        target_include_directories(parvane_sections_${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src/sections)
        add_test(NAME sections_${t} COMMAND parvane_sections_${t})
    endforeach()
    # Живой: v2-сессия против стека (tests/run_v2_session_live.sh)
    add_test(NAME v2_session COMMAND parvane_v2_session_tests)
endif()
