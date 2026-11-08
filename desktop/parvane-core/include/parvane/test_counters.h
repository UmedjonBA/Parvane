// Parvane fork: счётчики-базис SC-009 (spec 035, T009) — сколько раз сессия сохраняет состояние движка и шлёт ack
// инбокса на записи, сколько раз JNI присоединяет поток к JVM на событие. Только счёт (атомарные инкременты), поведение
// выпуска не меняют; читают тесты, dev-хук выгрузки desktop (строка журнала рядом с audit dump) и debug-команда
// Android. Общий для desktop и android.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>

namespace parvane::counters {

struct Counters {
    std::atomic<std::uint64_t> persist{0};        // Session::persistLocked — запись состояния на диск
    std::atomic<std::uint64_t> inboxRecords{0};   // записи инбокса, разобранные openPendingRecords
    std::atomic<std::uint64_t> inboxPersist{0};   // из них — сохранений состояния на пути записи инбокса
    std::atomic<std::uint64_t> inboxAck{0};       // ack инбокса на пути записи инбокса
    std::atomic<std::uint64_t> syncPages{0};      // страницы msg.inbox.sync (syncAllLocked)
    std::atomic<std::uint64_t> syncAck{0};        // ack после sync
    std::atomic<std::uint64_t> jniEvents{0};      // android: событий ядра отдано в Kotlin
    std::atomic<std::uint64_t> jniAttach{0};      // android: AttachCurrentThread на этих событиях
};

inline Counters &get() {
    static Counters c;
    return c;
}

inline std::string summary() {
    const auto &c = get();
    return "persist=" + std::to_string(c.persist.load()) + " inboxRecords=" + std::to_string(c.inboxRecords.load())
        + " inboxPersist=" + std::to_string(c.inboxPersist.load()) + " inboxAck=" + std::to_string(c.inboxAck.load())
        + " syncPages=" + std::to_string(c.syncPages.load()) + " syncAck=" + std::to_string(c.syncAck.load())
        + " jniEvents=" + std::to_string(c.jniEvents.load()) + " jniAttach=" + std::to_string(c.jniAttach.load());
}

} // namespace parvane::counters
