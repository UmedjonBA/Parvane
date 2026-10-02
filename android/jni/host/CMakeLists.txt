# Parvane Android: хостовая libparvane_protocol_jni.so для JVM-тестов шва
# (spec 007, T067) — тот же protocol_jni.cpp и v2_bridge.h, что в
# libparvane_jni.so на устройстве, но под хост (linux x86_64) и без сети:
# движок — хостовый libparvane_protocol_ffi.a (cargo build -p parvane-protocol-ffi),
# отображение содержимого — v2_content.cpp parvane-core. Сборка —
# android/build-host-jni.sh; Gradle (:libtd:test*) зовёт её сам.
cmake_minimum_required(VERSION 3.20)
project(parvane_protocol_jni_host LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(JNI_DIR ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(REPO ${JNI_DIR}/../..)
set(CORE ${REPO}/desktop/parvane-core)
set(BACKEND ${REPO}/backend)
if(NOT DEFINED PARVANE_PROTOCOL_LIB)
  set(PARVANE_PROTOCOL_LIB ${BACKEND}/target/debug/libparvane_protocol_ffi.a)
endif()
if(NOT EXISTS ${PARVANE_PROTOCOL_LIB})
  message(FATAL_ERROR "нет ${PARVANE_PROTOCOL_LIB} (cargo build -p parvane-protocol-ffi)")
endif()
if(NOT DEFINED JDK_HOME)
  set(JDK_HOME $ENV{JAVA_HOME})
endif()
if(NOT EXISTS ${JDK_HOME}/include/jni.h)
  message(FATAL_ERROR "нет jni.h: задай JAVA_HOME/JDK_HOME (${JDK_HOME})")
endif()
find_package(OpenSSL REQUIRED)

add_library(parvane_protocol_jni SHARED
    ${JNI_DIR}/protocol_jni.cpp
    ${CORE}/src/v2_engine.cpp
    ${CORE}/src/v2_content.cpp)
target_include_directories(parvane_protocol_jni PRIVATE
    ${JNI_DIR}
    ${CORE}/include
    ${BACKEND}/protocol/ffi/include
    ${JNI_DIR}/../third_party
    ${JDK_HOME}/include
    ${JDK_HOME}/include/linux)
target_compile_options(parvane_protocol_jni PRIVATE -fvisibility=hidden)
target_link_libraries(parvane_protocol_jni PRIVATE ${PARVANE_PROTOCOL_LIB} OpenSSL::Crypto pthread dl m)
