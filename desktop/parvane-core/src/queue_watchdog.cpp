// Parvane fork: сторож очереди задач — см. queue_watchdog.h.
#include "parvane/queue_watchdog.h"

namespace parvane::v2 {

QueueWatchdog::QueueWatchdog(Deps deps) : deps_(std::move(deps)) {}

QueueWatchdog::~QueueWatchdog() { stop(); }

void QueueWatchdog::start() {
    std::lock_guard<std::mutex> lk(mu_);
    if (thread_.joinable()) return;
    stopping_ = false;
    thread_ = std::thread(&QueueWatchdog::loop, this);
}

void QueueWatchdog::stop() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        stopping_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
}

void QueueWatchdog::begin(std::string label) {
    std::lock_guard<std::mutex> lk(mu_);
    running_ = true;
    reported_ = false;
    label_ = std::move(label);
    startedAt_ = std::chrono::steady_clock::now();
}

void QueueWatchdog::end() {
    std::lock_guard<std::mutex> lk(mu_);
    running_ = false;
    reported_ = false;
}

void QueueWatchdog::loop() {
    std::unique_lock<std::mutex> lk(mu_);
    while (!stopping_) {
        cv_.wait_for(lk, std::chrono::milliseconds(deps_.checkMs), [&] { return stopping_; });
        if (stopping_) return;
        if (!running_ || reported_) continue;
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - startedAt_).count();
        if (elapsed < deps_.thresholdMs) continue;
        reported_ = true;
        ++reports_;
        const auto label = label_;
        if (!deps_.onStuck) continue;
        lk.unlock();
        try {
            deps_.onStuck(label, elapsed);
        } catch (...) {
        }
        lk.lock();
    }
}

} // namespace parvane::v2
