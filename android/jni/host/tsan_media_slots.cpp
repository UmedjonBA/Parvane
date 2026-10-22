// NAT-06 (spec 031, T044): гонка колбэка WebRTC с разрушением моста медиа звонка — реестр media_slots.h под TSan.
// Сборка и запуск — android/tools/tsan_media_slots.sh (clang++ -fsanitize=thread). Без ожидания идущих колбэков в
// retire() TSan сообщает гонку/обращение к освобождённой памяти, а проверка значения падает.
#include "media_slots.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

namespace {

struct Bridge {
    int payload = 42; // не атомарное: разрушение после retire() не должно пересечься с чтением в колбэке
    std::atomic<int> calls{0};
};

pvjni::MediaSlots<Bridge> g_slots;
std::atomic<int> g_bad{0};

void callback(Bridge &b) {
    if (b.payload != 42) g_bad++;
    b.calls++;
    std::this_thread::yield();
    if (b.payload != 42) g_bad++;
}

// 1. Колбэки с нескольких потоков, пока другой поток создаёт и разрушает мосты
void stressRetire() {
    std::atomic<std::int64_t> current{0};
    std::atomic<bool> stop{false};
    std::vector<std::thread> workers;
    for (int i = 0; i < 4; ++i) {
        workers.emplace_back([&] {
            while (!stop) g_slots.with(current.load(), callback);
        });
    }
    for (int round = 0; round < 3000; ++round) {
        auto *b = new Bridge;
        const auto h = g_slots.add(b);
        current = h;
        std::this_thread::sleep_for(std::chrono::microseconds(50));
        g_slots.retire(h);
        b->payload = 0;
        delete b;
    }
    stop = true;
    for (auto &t : workers) t.join();
}

// 2. Ядро завершает звонок прямо из колбэка (своего потока): retire() не ждёт сам себя, другой поток — ждётся
void retireFromOwnCallback() {
    for (int round = 0; round < 500; ++round) {
        auto *b = new Bridge;
        const auto h = g_slots.add(b);
        std::atomic<bool> go{false};
        std::thread other([&] {
            while (!go) std::this_thread::yield();
            g_slots.with(h, callback);
        });
        const bool found = g_slots.with(h, [&](Bridge &self) {
            go = true;
            callback(self);
            g_slots.retire(h);
            self.payload = 0;
            delete &self;
        });
        other.join();
        if (!found) g_bad++;
        if (g_slots.with(h, callback)) g_bad++; // после retire() дескриптор не находится
    }
}

} // namespace

int main() {
    // сторож: взаимная блокировка в retire() — провал, а не зависший прогон
    std::thread([] {
        std::this_thread::sleep_for(std::chrono::seconds(120));
        std::fprintf(stderr, "FAIL: взаимная блокировка (120 с)\n");
        std::_Exit(3);
    }).detach();
    stressRetire();
    retireFromOwnCallback();
    if (g_bad) {
        std::fprintf(stderr, "FAIL: колбэк видел разрушенный мост (%d)\n", g_bad.load());
        return 1;
    }
    std::printf("tsan_media_slots: OK\n");
    return 0;
}
