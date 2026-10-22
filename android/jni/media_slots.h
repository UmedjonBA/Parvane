// Реестр мостов медиа звонка (NAT-06): дескриптор → объект для колбэков Kotlin (поток наблюдателя WebRTC).
// Колбэк может прийти, пока ядро разрушает мост (отбой, выход участника из сетки): реестр считает идущие колбэки, и
// retire() ждёт их — кроме колбэков своего же потока (ядро может завершить звонок прямо из колбэка; после возврата
// объект уже не трогается). Без JNI — проверяется на хосте под TSan (host/tsan_media_slots.cpp).
#pragma once

#include <algorithm>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <mutex>
#include <vector>

namespace pvjni {

template <typename T>
class MediaSlots {
public:
    std::int64_t add(T *object) {
        std::lock_guard<std::mutex> lk(mu_);
        const auto handle = next_++;
        slots_[handle].object = object;
        return handle;
    }

    // Снять объект: новые колбэки больше не находят его, идущие на других потоках — дожидаемся.
    void retire(std::int64_t handle) {
        std::unique_lock<std::mutex> lk(mu_);
        const auto own = static_cast<int>(std::count(active_.begin(), active_.end(), handle));
        const auto it = slots_.find(handle);
        if (it == slots_.end()) return;
        it->second.dead = true;
        cv_.wait(lk, [&] {
            const auto cur = slots_.find(handle);
            return cur == slots_.end() || cur->second.inflight <= own;
        });
        slots_.erase(handle);
    }

    // Колбэк по дескриптору: f(T&) зовётся без замка реестра (сессия звонка берёт свои замки). false — объекта нет.
    template <typename F>
    bool with(std::int64_t handle, F &&f) {
        T *object = nullptr;
        {
            std::lock_guard<std::mutex> lk(mu_);
            const auto it = slots_.find(handle);
            if (it == slots_.end() || it->second.dead || !it->second.object) return false;
            object = it->second.object;
            ++it->second.inflight;
        }
        struct Done {
            MediaSlots &self;
            std::int64_t handle;
            ~Done() {
                active_.pop_back();
                {
                    std::lock_guard<std::mutex> lk(self.mu_);
                    if (const auto it = self.slots_.find(handle); it != self.slots_.end()) --it->second.inflight;
                }
                self.cv_.notify_all();
            }
        };
        active_.push_back(handle);
        Done done{*this, handle};
        f(*object);
        return true;
    }

private:
    struct Slot {
        T *object = nullptr;
        int inflight = 0;
        bool dead = false;
    };
    std::mutex mu_;
    std::condition_variable cv_;
    std::map<std::int64_t, Slot> slots_;
    std::int64_t next_ = 1;
    static inline thread_local std::vector<std::int64_t> active_; // дескрипторы, чей колбэк идёт на этом потоке
};

} // namespace pvjni
