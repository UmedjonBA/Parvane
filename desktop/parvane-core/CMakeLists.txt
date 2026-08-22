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
# Собираем cargo-крейт и линкуем libparvane_e2e.a. Путь workspace-target —
# ../../target относительно этого файла (desktop/parvane-core → корень репо).
set(PARVANE_E2E_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../..)
set(PARVANE_E2E_LIB ${PARVANE_E2E_DIR}/target/debug/libparvane_e2e.a)
find_program(CARGO_EXE cargo REQUIRED)
add_custom_target(parvane_e2e_build ALL
    COMMAND ${CARGO_EXE} build -p parvane-e2e
    WORKING_DIRECTORY ${PARVANE_E2E_DIR}
    BYPRODUCTS ${PARVANE_E2E_LIB}
    COMMENT "cargo build parvane-e2e (vodozemac staticlib)")

# ── parvane_core ─────────────────────────────────────────────────────────────
add_library(parvane_core STATIC
    src/transport.cpp
    src/gateway_transport.cpp
    src/e2e.cpp
    src/linking.cpp
    src/blobcrypt.cpp
    src/messenger_client.cpp
    src/cloud_client.cpp
    src/call_client.cpp
    src/crypto.cpp
    src/call_session.cpp
    src/call_manager.cpp
    src/group_client.cpp
    src/group_call_manager.cpp)
add_dependencies(parvane_core parvane_e2e_build)
target_include_directories(parvane_core
    PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include
           ${PARVANE_E2E_DIR}/shared/parvane-e2e/include
    PRIVATE ${cnats_SOURCE_DIR}/src)
target_link_libraries(parvane_core
    PUBLIC nlohmann_json::nlohmann_json
    PRIVATE nats_static OpenSSL::Crypto
            ${PARVANE_E2E_LIB} pthread dl m)

# ── probe-бинарь + тесты (де-риск транспорта; нужен живой backend) ────────────
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

    add_executable(parvane_group_call_tests tests/group_call_tests.cpp)
    target_link_libraries(parvane_group_call_tests PRIVATE parvane_core)

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
    add_test(NAME e2e COMMAND parvane_e2e_tests)
    add_test(NAME call_session COMMAND parvane_call_session_tests)
    add_test(NAME call_manager COMMAND parvane_call_manager_tests)
    add_test(NAME group COMMAND parvane_group_tests)
    add_test(NAME group_call COMMAND parvane_group_call_tests)
endif()
