// Parvane fork: пауза переподключения (spec 029, T025) — порт web `v2/reconnectBackoff.ts` (perf A5).
// Повторы 1 → 2 → 4 … до потолка с разбросом ±50 %, сброс при успехе. Без потоков и замков: владелец
// зовёт next()/reset() сам.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <random>

namespace parvane::v2 {

class ReconnectBackoff {
public:
    static constexpr std::int64_t kBaseMs = 1000;
    static constexpr std::int64_t kMaxMs = 60000;

    // random — [0, 1); по умолчанию — свой генератор.
    explicit ReconnectBackoff(std::int64_t baseMs = kBaseMs, std::int64_t maxMs = kMaxMs,
                              std::function<double()> random = nullptr)
    : baseMs_(baseMs), maxMs_(maxMs), random_(std::move(random)) {}

    // Задержка следующей попытки (мс); каждая следующая — длиннее.
    [[nodiscard]] std::int64_t next() {
        const auto power = std::min(attempt_, 30);
        const auto base = std::min<double>(double(maxMs_), double(baseMs_) * std::ldexp(1.0, power));
        ++attempt_;
        return std::int64_t(std::llround(base * (0.5 + rnd())));
    }
    void reset() { attempt_ = 0; }
    [[nodiscard]] int attempts() const { return attempt_; }

private:
    double rnd() {
        if (random_) return random_();
        if (!engine_) {
            std::random_device seed;
            engine_.emplace(seed());
        }
        return std::uniform_real_distribution<double>(0.0, 1.0)(*engine_);
    }
    std::int64_t baseMs_;
    std::int64_t maxMs_;
    std::function<double()> random_;
    std::optional<std::mt19937> engine_;
    int attempt_ = 0;
};

} // namespace parvane::v2
