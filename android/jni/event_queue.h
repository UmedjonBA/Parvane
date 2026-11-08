// Parvane Android (spec 035 T131/T135, NAT-06, ORDER-1): очередь событий ядра в Kotlin — ПРЕЖНЕЕ поведение,
// вынесенное из jni_main.cpp для теста (до правки): очередь без потолка, по событию за вызов, поток очереди
// присоединяется к JVM и отсоединяется на КАЖДОЕ событие.
#pragma once

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace pvjni {

struct EventQueueLimits {
    std::size_t maxEvents = 4096;
    std::size_t maxBytes = 8u << 20;
    std::size_t maxBatch = 64;
    std::size_t maxBatchBytes = 1u << 20;
    int pushWaitMs = 5000;
};

struct EventQueueStats {
    std::uint64_t pushed = 0;
    std::uint64_t delivered = 0;
    std::uint64_t batches = 0;
    std::uint64_t waits = 0;
    std::uint64_t overflow = 0;
    std::uint64_t attach = 0;
    std::size_t maxQueued = 0;
    std::size_t maxQueuedBytes = 0;
};

class EventQueue {
public:
    using Deliver = std::function<void(const std::vector<std::string> &)>;
    EventQueue(EventQueueLimits limits, Deliver deliver, std::function<bool()> attach, std::function<void()> detach)
        : limits_(limits), deliver_(std::move(deliver)), attach_(std::move(attach)), detach_(std::move(detach)) {}
    ~EventQueue() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_.notify_all();
        if (thread_.joinable()) thread_.join();
    }
    EventQueue(const EventQueue &) = delete;
    EventQueue &operator=(const EventQueue &) = delete;

    void push(std::string ev) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            bytes_ += ev.size();
            q_.push_back(std::move(ev));
            st_.pushed++;
            if (q_.size() > st_.maxQueued) st_.maxQueued = q_.size();
            if (bytes_ > st_.maxQueuedBytes) st_.maxQueuedBytes = bytes_;
            if (!thread_.joinable()) thread_ = std::thread([this] { loop(); });
        }
        cv_.notify_all();
    }

    bool waitIdle(int timeoutMs) {
        std::unique_lock<std::mutex> lk(mu_);
        return idle_.wait_for(lk, std::chrono::milliseconds(timeoutMs), [this] { return q_.empty() && !busy_; });
    }

    EventQueueStats stats() const {
        std::lock_guard<std::mutex> lk(mu_);
        return st_;
    }

private:
    void loop() {
        for (;;) {
            std::string s;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this] { return stop_ || !q_.empty(); });
                if (q_.empty()) return;
                s = std::move(q_.front());
                q_.pop_front();
                bytes_ -= s.size();
                busy_ = true;
            }
            const bool attached = attach_ && attach_();
            if (attached) {
                std::lock_guard<std::mutex> lk(mu_);
                st_.attach++;
            }
            deliver_({s});
            if (attached && detach_) detach_();
            {
                std::lock_guard<std::mutex> lk(mu_);
                st_.delivered++;
                st_.batches++;
                busy_ = false;
            }
            idle_.notify_all();
        }
    }

    EventQueueLimits limits_;
    Deliver deliver_;
    std::function<bool()> attach_;
    std::function<void()> detach_;
    mutable std::mutex mu_;
    std::condition_variable cv_, idle_;
    std::deque<std::string> q_;
    std::size_t bytes_ = 0;
    bool stop_ = false, busy_ = false;
    EventQueueStats st_;
    std::thread thread_;
};

} // namespace pvjni
