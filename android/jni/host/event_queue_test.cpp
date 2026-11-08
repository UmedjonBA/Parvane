// spec 035 T131 (NAT-06, ORDER-1, SC-009): очередь событий ядра → Kotlin (jni/event_queue.h) на хосте под TSan, без
// JVM. Сборка и запуск — android/tools/tsan_event_queue.sh. Проверки:
//  1. 300 событий одного производителя → в получателе строго по порядку, пачками (вызовов получателя меньше 300),
//     присоединение потока очереди к JVM — один раз за жизнь потока (а не на событие);
//  2. потолок очереди по числу и байтам: медленный получатель → производитель ждёт (пауза чтения), ни одно событие
//     не теряется и потолок не превышается;
//  3. событие, поставленное из самого получателя (обработчик Kotlin зовёт ядро), не ждёт места — взаимной
//     блокировки нет.
#include "event_queue.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace {

int g_fail = 0;
void check(bool ok, const std::string &what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
    if (!ok) ++g_fail;
}

int numberOf(const std::string &ev) {
    const auto p = ev.find("\"n\":");
    return p == std::string::npos ? -1 : std::atoi(ev.c_str() + p + 4);
}

std::string event(int n, std::size_t pad = 0) {
    return "{\"type\":\"probe\",\"n\":" + std::to_string(n) + ",\"pad\":\"" + std::string(pad, 'x') + "\"}";
}

void orderAndBatches() {
    pvjni::EventQueueLimits lim;
    lim.maxEvents = 16;
    lim.maxBatch = 32;
    std::vector<int> got;
    std::mutex gotMu;
    std::atomic<int> attaches{0}, detaches{0};
    pvjni::EventQueueStats st;
    {
        pvjni::EventQueue q(
            lim,
            [&](const std::vector<std::string> &batch) {
                {
                    std::lock_guard<std::mutex> lk(gotMu);
                    for (const auto &e : batch) got.push_back(numberOf(e));
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(2)); // медленный получатель
            },
            [&] { attaches++; return true; }, [&] { detaches++; });
        std::thread producer([&] {
            for (int i = 0; i < 300; ++i) q.push(event(i));
        });
        producer.join();
        check(q.waitIdle(20000), "очередь разобрана");
        st = q.stats();
    }
    bool ordered = got.size() == 300;
    for (int i = 0; ordered && i < 300; ++i) ordered = got[static_cast<std::size_t>(i)] == i;
    check(ordered, "300 событий строго по порядку (получено " + std::to_string(got.size()) + ")");
    check(st.attach == 1 && attaches == 1, "AttachCurrentThread — один раз за жизнь потока (было " + std::to_string(attaches.load()) + ")");
    check(detaches == 1, "DetachCurrentThread — один раз, при остановке потока (было " + std::to_string(detaches.load()) + ")");
    check(st.batches < 300 && st.batches > 0, "события пачками: " + std::to_string(st.batches) + " вызовов получателя на 300");
    check(st.maxQueued <= lim.maxEvents, "потолок числа: в очереди не больше " + std::to_string(lim.maxEvents) + " (было " + std::to_string(st.maxQueued) + ")");
    check(st.waits > 0, "переполнение — пауза производителя (ожиданий " + std::to_string(st.waits) + ")");
    check(st.overflow == 0 && st.delivered == 300, "ничего не потеряно и потолок не обойдён");
}

void bytesLimit() {
    pvjni::EventQueueLimits lim;
    lim.maxEvents = 1000;
    lim.maxBytes = 2000;
    std::atomic<int> n{0};
    pvjni::EventQueueStats st;
    {
        pvjni::EventQueue q(
            lim,
            [&](const std::vector<std::string> &batch) {
                n += static_cast<int>(batch.size());
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            },
            [] { return true; }, [] {});
        for (int i = 0; i < 100; ++i) q.push(event(i, 300));
        check(q.waitIdle(20000), "очередь разобрана (байты)");
        st = q.stats();
    }
    check(n == 100, "все 100 крупных событий доставлены");
    check(st.maxQueuedBytes <= lim.maxBytes, "потолок байт: " + std::to_string(st.maxQueuedBytes) + " ≤ " + std::to_string(lim.maxBytes));
}

void reentrant() {
    pvjni::EventQueueLimits lim;
    lim.maxEvents = 4;
    lim.pushWaitMs = 30000; // если бы получатель ждал места сам у себя — тест висел бы 30 с на событие
    std::atomic<int> n{0};
    pvjni::EventQueue *self = nullptr;
    const auto t0 = std::chrono::steady_clock::now();
    {
        pvjni::EventQueue q(
            lim,
            [&](const std::vector<std::string> &batch) {
                for (const auto &e : batch) {
                    n++;
                    if (numberOf(e) == 0) {
                        for (int i = 1; i <= 50; ++i) self->push(event(i)); // обработчик зовёт ядро, ядро шлёт события
                    }
                }
            },
            [] { return true; }, [] {});
        self = &q;
        q.push(event(0));
        check(q.waitIdle(20000), "очередь разобрана (повторный вход)");
    }
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    check(n == 51 && ms < 10000, "событие из получателя не ждёт места: " + std::to_string(n.load()) + " за " + std::to_string(ms) + " мс");
}

} // namespace

int main() {
    orderAndBatches();
    bytesLimit();
    reentrant();
    std::printf("%s event_queue: ошибок %d\n", g_fail ? "[FAIL]" : "[ok]", g_fail);
    return g_fail ? 1 : 0;
}
