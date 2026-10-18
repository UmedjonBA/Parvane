// Parvane fork: ровный поток отправки в режиме L2 (spec 025) — порт web `v2/l2Ticks.ts`. Пока у
// пользователя есть хотя бы один чат с «усиленной приватностью», запечатанные записи (личные, групповые,
// квитанции) уходят тактами — раз в такт ровно одна: настоящая из очереди либо пустышка себе. Без L2 —
// отправка сразу. Сигналы звонка — всегда сразу (иначе звонок не соединится).
//
// Потоки: submit() блокирует вызывающего до отправки его записи (как await в web); такты идут своим
// потоком (start), в тестах — вручную (tick). Отправка и пустышка — колбэки хоста; ни один из них не
// должен ждать того, что держит вызывающий submit (сессия даёт такту свои анонимные соединения, а
// пустышки готовит заранее).
#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <utility>

namespace parvane::v2 {

class L2Ticker {
public:
    // Такт 5 с ± 2 с (как web L2_TICK_MS / L2_TICK_JITTER_MS)
    static constexpr std::int64_t kTickMs = 5000;
    static constexpr std::int64_t kJitterMs = 2000;
    [[nodiscard]] static bool isTicked(const std::string &method);

    struct Deps {
        std::function<bool()> isActive;
        // Отправить запись (метод, тело, домен сервера объекта) → тело ответа; бросает при ошибке.
        std::function<std::string(const std::string &method, const std::string &body, const std::string &dest)> send;
        // Пустышка себе: {метод, тело}; nullopt — нет (движок занят или не готов).
        std::function<std::optional<std::pair<std::string, std::string>>()> makeCover;
        std::function<void(const std::string &)> log;
        std::int64_t tickMs = kTickMs;
        std::int64_t jitterMs = kJitterMs;
    };

    explicit L2Ticker(Deps deps);
    ~L2Ticker();
    L2Ticker(const L2Ticker &) = delete;
    L2Ticker &operator=(const L2Ticker &) = delete;

    // Отправить запись: в режиме L2 — в очередь тактов (ждёт своего такта), иначе сразу. Бросает ошибку
    // отправки.
    std::string submit(const std::string &method, const std::string &body, const std::string &dest);
    // Один такт: запись из очереди либо пустышка; режим выключен — накопленное уходит разом.
    void tick();
    // Поток тактов (живёт, пока не stop()); refresh() — режим мог включиться.
    void start();
    void refresh();
    void stop();
    [[nodiscard]] std::size_t pending();
    [[nodiscard]] std::size_t coversSent() const { return covers_; }

private:
    struct Item {
        std::string method, body, dest, result;
        std::exception_ptr error;
        bool done = false;
    };
    void sendItem(const std::shared_ptr<Item> &item);
    std::int64_t nextDelay();

    Deps deps_;
    std::mutex mu_;
    std::condition_variable cv_;     // готовность записей вызывающим
    std::condition_variable wakeCv_; // поток тактов
    std::deque<std::shared_ptr<Item>> queue_;
    std::atomic<std::size_t> covers_{0};
    std::atomic<bool> stopping_{false};
    std::thread thread_;
    std::mt19937 rng_{std::random_device{}()};
};

} // namespace parvane::v2
