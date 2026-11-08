// Parvane Android (spec 035 T131/T135, NAT-06, ORDER-1, SC-009): очередь событий ядра → Kotlin.
//  - Один поток очереди на всё время жизни очереди: присоединяется к JVM ОДИН раз (`attach` при старте потока,
//    `detach` при остановке), а не на каждое событие.
//  - Пачки: всё, что накопилось к моменту разбора (не больше `maxBatch` событий и `maxBatchBytes` байт), уходит
//    одним вызовом `deliver` строго по порядку постановки.
//  - Потолок очереди по числу событий и байтам. Переполнение — пауза производителя (поток чтения соединения ждёт
//    места), а не рост очереди и не потеря. Событие, поставленное с самого потока очереди (обработчик Kotlin зовёт
//    ядро, ядро шлёт событие), не ждёт — иначе поток ждал бы сам себя. Ожидание не дольше `pushWaitMs`: дольше —
//    событие всё равно ставится (счётчик `overflow`), лучше превысить потолок, чем потерять событие или повиснуть
//    навсегда на взаимной блокировке с потоком, который держит Kotlin.
//  - Одно событие крупнее потолка байт ставится, когда очередь пуста (иначе не прошло бы никогда).
// Без JNI — проверяется на хосте под TSan (jni/host/event_queue_test.cpp) и через настоящую JVM (event_probe_jni.cpp).
#pragma once

#include <algorithm>
#include <chrono>
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
    std::size_t maxEvents = 4096;          // событий в очереди
    std::size_t maxBytes = 8u << 20;       // байт в очереди
    std::size_t maxBatch = 64;             // событий в одной пачке
    std::size_t maxBatchBytes = 1u << 20;  // байт в одной пачке (одно крупное событие — пачка само по себе)
    int pushWaitMs = 5000;                 // предел ожидания места производителем
};

struct EventQueueStats {
    std::uint64_t pushed = 0;
    std::uint64_t delivered = 0;
    std::uint64_t batches = 0;
    std::uint64_t waits = 0;     // постановок, ждавших места (пауза производителя)
    std::uint64_t overflow = 0;  // постановок сверх потолка после `pushWaitMs`
    std::uint64_t attach = 0;    // присоединений потока очереди
    std::size_t maxQueued = 0;
    std::size_t maxQueuedBytes = 0;
};

class EventQueue {
public:
    using Deliver = std::function<void(const std::vector<std::string> &)>;

    // attach — на потоке очереди при его старте (false — поток не присоединён: события отбрасываются, как и прежде
    // при отказе AttachCurrentThread); detach — при его остановке.
    EventQueue(EventQueueLimits limits, Deliver deliver, std::function<bool()> attach, std::function<void()> detach)
        : limits_(limits), deliver_(std::move(deliver)), attach_(std::move(attach)), detach_(std::move(detach)) {
        if (limits_.maxEvents == 0) limits_.maxEvents = 1;
        if (limits_.maxBatch == 0) limits_.maxBatch = 1;
    }
    ~EventQueue() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_.notify_all();
        space_.notify_all();
        if (thread_.joinable()) thread_.join();
    }
    EventQueue(const EventQueue &) = delete;
    EventQueue &operator=(const EventQueue &) = delete;

    void push(std::string ev) {
        std::unique_lock<std::mutex> lk(mu_);
        if (stop_) return;
        const bool self = thread_.joinable() && std::this_thread::get_id() == thread_.get_id();
        if (!self && !fits(ev.size())) {
            st_.waits++;
            const auto ok = space_.wait_for(lk, std::chrono::milliseconds(limits_.pushWaitMs),
                                            [&] { return stop_ || fits(ev.size()); });
            if (stop_) return;
            if (!ok) st_.overflow++;
        }
        bytes_ += ev.size();
        q_.push_back(std::move(ev));
        st_.pushed++;
        st_.maxQueued = std::max(st_.maxQueued, q_.size());
        st_.maxQueuedBytes = std::max(st_.maxQueuedBytes, bytes_);
        if (!thread_.joinable()) thread_ = std::thread([this] { loop(); });
        lk.unlock();
        cv_.notify_one();
    }

    // Тесты: дождаться, пока очередь опустеет и пачка в получателе закончится.
    bool waitIdle(int timeoutMs) {
        std::unique_lock<std::mutex> lk(mu_);
        return idle_.wait_for(lk, std::chrono::milliseconds(timeoutMs), [this] { return q_.empty() && !busy_; });
    }

    EventQueueStats stats() const {
        std::lock_guard<std::mutex> lk(mu_);
        return st_;
    }

private:
    bool fits(std::size_t size) const {
        if (q_.empty()) return true; // крупное одиночное событие
        return q_.size() < limits_.maxEvents && bytes_ + size <= limits_.maxBytes;
    }

    void loop() {
        const bool attached = !attach_ || attach_();
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (attached && attach_) st_.attach++;
        }
        std::vector<std::string> batch;
        for (;;) {
            batch.clear();
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this] { return stop_ || !q_.empty(); });
                if (q_.empty()) break; // остановка, всё разобрано
                std::size_t taken = 0;
                while (!q_.empty() && batch.size() < limits_.maxBatch
                       && (batch.empty() || taken + q_.front().size() <= limits_.maxBatchBytes)) {
                    taken += q_.front().size();
                    bytes_ -= q_.front().size();
                    batch.push_back(std::move(q_.front()));
                    q_.pop_front();
                }
                busy_ = true;
            }
            space_.notify_all();
            if (attached) deliver_(batch);
            {
                std::lock_guard<std::mutex> lk(mu_);
                st_.delivered += batch.size();
                st_.batches++;
                busy_ = false;
            }
            idle_.notify_all();
        }
        if (attached && detach_) detach_();
        idle_.notify_all();
    }

    EventQueueLimits limits_;
    Deliver deliver_;
    std::function<bool()> attach_;
    std::function<void()> detach_;
    mutable std::mutex mu_;
    std::condition_variable cv_, space_, idle_;
    std::deque<std::string> q_;
    std::size_t bytes_ = 0;
    bool stop_ = false, busy_ = false;
    EventQueueStats st_;
    std::thread thread_;
};

} // namespace pvjni
