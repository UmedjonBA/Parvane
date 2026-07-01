// Parvane fork: генерация идентификаторов и меток времени для конвертов событий.
// Вынесено из messenger_client.cpp, чтобы cloud/call-клиенты не дублировали.
#pragma once

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <random>
#include <string>

namespace parvane {

// Unix-время в секундах (поле ts конверта ParvaneEvent).
inline std::int64_t nowUnix() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// UUID v7 (RFC 9562): 48-бит unix-millis в старших битах → строки лексикографически
// упорядочены по времени. КРИТИЧНО: messenger-шард фильтрует sync через
// `id > last_seen_id` строковым сравнением и рассчитывает именно на v7-порядок
// (как Uuid::now_v7 на Rust-стороне). v4 сломал бы инкрементальный sync.
inline std::string newUuidV7() {
    using namespace std::chrono;
    const std::uint64_t ms =
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    static thread_local std::mt19937_64 rng(std::random_device{}());
    const std::uint64_t r = rng();
    const std::uint16_t randA = static_cast<std::uint16_t>(rng() & 0x0FFF);

    std::uint8_t b[16];
    b[0] = (ms >> 40) & 0xFF;
    b[1] = (ms >> 32) & 0xFF;
    b[2] = (ms >> 24) & 0xFF;
    b[3] = (ms >> 16) & 0xFF;
    b[4] = (ms >> 8) & 0xFF;
    b[5] = ms & 0xFF;
    b[6] = 0x70 | ((randA >> 8) & 0x0F); // версия 7
    b[7] = randA & 0xFF;
    b[8] = 0x80 | ((r >> 56) & 0x3F);    // вариант 10
    b[9] = (r >> 48) & 0xFF;
    b[10] = (r >> 40) & 0xFF;
    b[11] = (r >> 32) & 0xFF;
    b[12] = (r >> 24) & 0xFF;
    b[13] = (r >> 16) & 0xFF;
    b[14] = (r >> 8) & 0xFF;
    b[15] = r & 0xFF;

    char buf[37];
    std::snprintf(buf, sizeof(buf),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return std::string(buf);
}

} // namespace parvane
