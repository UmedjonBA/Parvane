# Parvane fork: переносимая либа транспорта (cnats + nlohmann/json), без Qt.
# Собирается standalone (probe-бинарь) и как под-проект внутри сборки tdesktop.
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

# ── cnats (Core NATS C-клиент). TLS включён (OpenSSL) — шифрование сигналинга;
# включается на клиенте через PARVANE_NATS_TLS_CA (см. transport.cpp). ──────────
set(NATS_BUILD_STREAMING OFF CACHE INTERNAL "")
set(NATS_BUILD_WITH_TLS ON CACHE INTERNAL "")
set(NATS_BUILD_EXAMPLES OFF CACHE INTERNAL "")
set(NATS_BUILD_LIB_SHARED OFF CACHE INTERNAL "")
set(NATS_BUILD_LIB_STATIC ON CACHE INTERNAL "")
FetchContent_Declare(cnats
    GIT_REPOSITORY https://github.com/nats-io/nats.c.git
    GIT_TAG v3.13.0
    GIT_SHALLOW TRUE)

FetchContent_MakeAvailable(nlohmann_json cnats)

# ── OpenSSL (Ed25519 для аутентификации сигналинга звонков) ───────────────────
find_package(OpenSSL REQUIRED)

# ── parvane-e2e (Rust staticlib, vodozemac Olm) — E2E крипта (Фаза 2) ──────────
# Собираем cargo-крейт и линкуем libparvane_e2e.a. Cargo workspace лежит в
# backend/ — это ../../backend относительно этого файла.
set(PARVANE_BACKEND_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../backend)
set(PARVANE_E2E_LIB ${PARVANE_BACKEND_DIR}/target/debug/libparvane_e2e.a)
find_program(CARGO_EXE cargo REQUIRED)
add_custom_target(parvane_e2e_build ALL
    COMMAND ${CARGO_EXE} build -p parvane-e2e
    WORKING_DIRECTORY ${PARVANE_BACKEND_DIR}
    BYPRODUCTS ${PARVANE_E2E_LIB}
    COMMENT "cargo build parvane-e2e (vodozemac staticlib)")

# ── parvane-protocol-ffi (Rust staticlib, движок протокола v2, spec 007) ──────
# C ABI движка: кадры, конверты, журналы устройств, состояние клиента. Кадры
# и тела v2 разбирает и собирает ТОЛЬКО он (своего protobuf в C++ нет).
# parvane-e2e остаётся: v1-стек живёт до E6 (двойной стек, как в вебе).
# Заголовок parvane_protocol.h генерирует cbindgen при cargo build.
set(PARVANE_PROTOCOL_LIB ${PARVANE_BACKEND_DIR}/target/debug/libparvane_protocol_ffi.a)
add_custom_target(parvane_protocol_build ALL
    COMMAND ${CARGO_EXE} build -p parvane-protocol-ffi
    WORKING_DIRECTORY ${PARVANE_BACKEND_DIR}
    BYPRODUCTS ${PARVANE_PROTOCOL_LIB}
    COMMENT "cargo build parvane-protocol-ffi (движок v2, staticlib)")

# ── parvane_core ─────────────────────────────────────────────────────────────
add_library(parvane_core STATIC
    src/transport.cpp
    src/gateway_transport.cpp
    src/gateway_ws_transport.cpp
    src/e2e.cpp
    src/linking.cpp
    src/blobcrypt.cpp
    src/storecrypt.cpp
    src/keybackup.cpp
    src/map_tiles.cpp
    src/pack_archive.cpp
    src/messenger_client.cpp
    src/cloud_client.cpp
    src/call_client.cpp
    src/crypto.cpp
    src/call_session.cpp
    src/call_manager.cpp
    src/group_client.cpp
    src/group_call_manager.cpp
    src/v2_engine.cpp
    src/v2_content.cpp
    src/v2_link.cpp
    src/v2_legacy.cpp
    src/v2_session.cpp)
add_dependencies(parvane_core parvane_e2e_build parvane_protocol_build)
target_include_directories(parvane_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
           ${PARVANE_BACKEND_DIR}/shared/parvane-e2e/include
           ${PARVANE_BACKEND_DIR}/protocol/ffi/include
    PRIVATE ${cnats_SOURCE_DIR}/src)
target_link_libraries(parvane_core
    PUBLIC nlohmann_json::nlohmann_json
    PRIVATE nats_static OpenSSL::SSL OpenSSL::Crypto
            ${PARVANE_E2E_LIB} ${PARVANE_PROTOCOL_LIB} pthread dl m)

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

option(PARVANE_CORE_BUILD_PROBE "Build standalone NATS probe + tests" ON)
if (PARVANE_CORE_BUILD_PROBE)
    add_executable(parvane_probe probe/main.cpp)
    target_link_libraries(parvane_probe PRIVATE parvane_core)

    add_executable(parvane_core_tests tests/transport_tests.cpp)
    target_link_libraries(parvane_core_tests PRIVATE parvane_core)

    add_executable(parvane_messenger_tests tests/messenger_tests.cpp)
    target_link_libraries(parvane_messenger_tests PRIVATE parvane_core)

    add_executable(parvane_cloud_tests tests/cloud_tests.cpp)
    target_link_libraries(parvane_cloud_tests PRIVATE parvane_core)

    add_executable(parvane_call_tests tests/call_tests.cpp)
    target_link_libraries(parvane_call_tests PRIVATE parvane_core)

    add_executable(parvane_crypto_tests tests/crypto_tests.cpp)
    target_link_libraries(parvane_crypto_tests PRIVATE parvane_core)

    add_executable(parvane_blobcrypt_tests tests/blobcrypt_tests.cpp)
    target_link_libraries(parvane_blobcrypt_tests PRIVATE parvane_core)

    add_executable(parvane_storecrypt_tests tests/storecrypt_tests.cpp)
    target_link_libraries(parvane_storecrypt_tests PRIVATE parvane_core)

    add_executable(parvane_linking_tests tests/linking_tests.cpp)
    target_link_libraries(parvane_linking_tests PRIVATE parvane_core)

    add_executable(parvane_e2e_tests tests/e2e_tests.cpp)
    target_link_libraries(parvane_e2e_tests PRIVATE parvane_core)

    add_executable(parvane_call_session_tests tests/call_session_tests.cpp)
    target_link_libraries(parvane_call_session_tests PRIVATE parvane_core)

    add_executable(parvane_call_manager_tests tests/call_manager_tests.cpp)
    target_link_libraries(parvane_call_manager_tests PRIVATE parvane_core)

    add_executable(parvane_group_tests tests/group_tests.cpp)
    target_link_libraries(parvane_group_tests PRIVATE parvane_core)

    # Управление группой (spec 004): форма запросов и GROUP-2, без стека
    add_executable(parvane_group_client_tests tests/group_client_tests.cpp)
    target_link_libraries(parvane_group_client_tests PRIVATE parvane_core)

    add_executable(parvane_group_call_tests tests/group_call_tests.cpp)
    target_link_libraries(parvane_group_call_tests PRIVATE parvane_core)

    # Геометрия тайлов карты (чистая математика, без стека)
    add_executable(parvane_map_tiles_tests tests/map_tiles_tests.cpp)
    target_link_libraries(parvane_map_tiles_tests PRIVATE parvane_core)

    # PVPK1 / PACK-1 / EMOJI-1 (spec 005, без стека)
    add_executable(parvane_pack_tests tests/pack_tests.cpp)
    target_link_libraries(parvane_pack_tests PRIVATE parvane_core)
    add_executable(parvane_poll_tests tests/poll_tests.cpp)
    target_link_libraries(parvane_poll_tests PRIVATE parvane_core)

    # Протокол v2 (spec 007): C ABI движка и отображение содержимого — без
    # стека; v2-сессия против живого стека — parvane_v2_session_tests.
    add_executable(parvane_v2_tests tests/v2_tests.cpp)
    target_link_libraries(parvane_v2_tests PRIVATE parvane_core)
    add_executable(parvane_v2_session_tests tests/v2_session_tests.cpp)
    target_link_libraries(parvane_v2_session_tests PRIVATE parvane_core)
    # Общие векторы conformance v2 (SEAL-1, GSEAL-1, приглашения) через C ABI
    add_executable(parvane_protocol_vectors_tests tests/protocol_vectors_tests.cpp)
    target_link_libraries(parvane_protocol_vectors_tests PRIVATE parvane_core)
    target_include_directories(parvane_protocol_vectors_tests PRIVATE ${PARVANE_BACKEND_DIR}/protocol/ffi/include)
    target_compile_definitions(parvane_protocol_vectors_tests PRIVATE
        PARVANE_VECTORS_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../proto/parvane/vectors")

    # Кадры перехода на v2 (E6, T110) на v1-транспорте — локальный TCP-сервер, без стека.
    add_executable(parvane_gateway_upgrade_tests tests/gateway_upgrade_tests.cpp)
    target_link_libraries(parvane_gateway_upgrade_tests PRIVATE parvane_core)

    # Живой e2e gateway (нужен запущенный стек nats+identity+messenger+gateway).
    add_executable(parvane_gateway_probe probe/gateway_probe.cpp)
    target_link_libraries(parvane_gateway_probe PRIVATE parvane_core)

    enable_testing()
    add_test(NAME transport COMMAND parvane_core_tests)
    add_test(NAME messenger COMMAND parvane_messenger_tests)
    add_test(NAME cloud COMMAND parvane_cloud_tests)
    add_test(NAME call COMMAND parvane_call_tests)
    add_test(NAME crypto COMMAND parvane_crypto_tests)
    add_test(NAME linking COMMAND parvane_linking_tests)
    add_test(NAME storecrypt COMMAND parvane_storecrypt_tests)
    add_test(NAME blobcrypt COMMAND parvane_blobcrypt_tests)
    add_test(NAME e2e COMMAND parvane_e2e_tests)
    add_test(NAME call_session COMMAND parvane_call_session_tests)
    add_test(NAME call_manager COMMAND parvane_call_manager_tests)
    add_test(NAME group COMMAND parvane_group_tests)
    add_test(NAME group_client COMMAND parvane_group_client_tests)
    add_test(NAME group_call COMMAND parvane_group_call_tests)
    add_test(NAME map_tiles COMMAND parvane_map_tiles_tests)
    add_test(NAME pack COMMAND parvane_pack_tests)
    add_test(NAME poll COMMAND parvane_poll_tests)
    add_test(NAME v2 COMMAND parvane_v2_tests)
    add_test(NAME v2_session COMMAND parvane_v2_session_tests)
    add_test(NAME protocol_vectors COMMAND parvane_protocol_vectors_tests)
    add_test(NAME gateway_upgrade COMMAND parvane_gateway_upgrade_tests)
endif()
