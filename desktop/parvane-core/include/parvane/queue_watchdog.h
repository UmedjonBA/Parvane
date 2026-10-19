// Parvane fork: сторож очереди задач (spec 029, T025) — как web `SERIAL_WATCHDOG_MS` (controller.ts):
// задача, которая выполняется дольше порога, попадает в лог один раз (с временем), чтобы зависание
// рабочего потока сессии было видно, а не молчало. Свой поток проверки; begin()/end() зовёт владелец
// вокруг каждой задачи.
#pragma once
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace parvane::v2 {

class QueueWatchdog {
public:
    static constexpr std::int64_t kThresholdMs = 20000;

    struct Deps {
        // Зовётся один раз на зависшую задачу: её метка и сколько мс она уже идёт.
        std::function<void(const std::string &label, std::int64_t elapsedMs)> onStuck;
        std::int64_t thresholdMs = kThresholdMs;
        std::int64_t checkMs = 1000;
    };
    explicit QueueWatchdog(Deps deps);
    ~QueueWatchdog();
    QueueWatchdog(const QueueWatchdog &) = delete;
    QueueWatchdog &operator=(const QueueWatchdog &) = delete;

    void start();
    void stop();
    // Задача началась/закончилась (с рабочего потока).
    void begin(std::string label = std::string());
    void end();
    // Сколько раз сторож сообщал о зависании (для тестов и диагностики).
    [[nodiscard]] std::size_t reports() const { return reports_; }

private:
    void loop();
    Deps deps_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
    bool stopping_ = false;
    bool running_ = false;      // задача идёт
    bool reported_ = false;     // о текущей задаче уже сообщено
    std::string label_;
    std::chrono::steady_clock::time_point startedAt_;
    std::atomic<std::size_t> reports_{0};
};

} // namespace parvane::v2
