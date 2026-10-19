// Parvane fork: сторож очереди задач (spec 029, T025) — зависшая задача попадает в лог один раз, быстрые —
// никогда; после end() сторож молчит.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "parvane/queue_watchdog.h"

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

int main() {
    using namespace std::chrono_literals;
    using parvane::v2::QueueWatchdog;
    std::printf("=== parvane-core queue watchdog tests ===\n");
    std::mutex mu;
    std::vector<std::pair<std::string, std::int64_t>> stuck;
    QueueWatchdog dog(QueueWatchdog::Deps{
        [&](const std::string &label, std::int64_t elapsed) {
            std::lock_guard<std::mutex> lk(mu);
            stuck.emplace_back(label, elapsed);
        },
        /*thresholdMs=*/120, /*checkMs=*/20});
    dog.start();

    dog.begin("быстрая");
    std::this_thread::sleep_for(40ms);
    dog.end();
    std::this_thread::sleep_for(200ms);
    {
        std::lock_guard<std::mutex> lk(mu);
        check(stuck.empty(), "быстрая задача — сторож молчит");
    }

    dog.begin("зависшая");
    std::this_thread::sleep_for(400ms);
    {
        std::lock_guard<std::mutex> lk(mu);
        check(stuck.size() == 1, "зависшая задача — ровно одно сообщение");
        check(!stuck.empty() && stuck[0].first == "зависшая", "сообщение несёт метку задачи");
        check(!stuck.empty() && stuck[0].second >= 120, "сообщение несёт время не меньше порога");
    }
    dog.end();
    std::this_thread::sleep_for(200ms);
    {
        std::lock_guard<std::mutex> lk(mu);
        check(stuck.size() == 1, "после end() повторов нет");
    }
    check(dog.reports() == 1, "счётчик сообщений = 1");

    dog.begin("вторая зависшая");
    std::this_thread::sleep_for(300ms);
    dog.end();
    check(dog.reports() == 2, "следующая зависшая — своё сообщение");
    dog.stop();
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
