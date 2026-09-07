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

if(NOT DEFINED PARVANE_OPENSSL_DIR)
  message(FATAL_ERROR "PARVANE_OPENSSL_DIR не задан (префикс OpenSSL под ABI)")
endif()
if(NOT DEFINED PARVANE_E2E_LIB)
  message(FATAL_ERROR "PARVANE_E2E_LIB не задан (путь к libparvane_e2e.a под ABI)")
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
