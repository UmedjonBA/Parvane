// Parvane fork: CallManager и GroupCallManager без стека (spec 029: сигналы только v2). Менеджеры соединены
// колбэком sendV2 через очередь доставки на своём потоке — как сигнал, прошедший сервер (handleV2Signal);
// медиа — StubMediaBackend. Проверка: личный звонок до Active у обоих, состояние микрофона/камеры у
// собеседника, отказ «занято»; групповой mesh из трёх участников.
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "parvane/call_manager.h"
#include "parvane/crypto.h"
#include "parvane/group_call_manager.h"
#include "parvane/stub_media_backend.h"

using namespace parvane;

static int g_total = 0, g_fail = 0;
static void check(bool ok, const std::string &name) {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s\n", ok ? "ok  " : "FAIL", name.c_str());
}

// «Сервер»: доставка сигналов адресатам на отдельном потоке (без повторного входа в менеджер отправителя)
class Relay {
public:
    using Handler = std::function<void(const std::string &from, const json &signal)>;
    Relay() : thread_([this] { loop(); }) {}
    ~Relay() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_.notify_all();
        thread_.join();
    }
    void attach(const std::string &who, Handler h) {
        std::lock_guard<std::mutex> lk(mu_);
        handlers_[who] = std::move(h);
    }
    void send(const std::string &from, const std::string &to, const json &signal) {
        {
            std::lock_guard<std::mutex> lk(mu_);
            queue_.push_back({from, to, signal});
        }
        cv_.notify_all();
    }

private:
    struct Item {
        std::string from, to;
        json signal;
    };
    void loop() {
        for (;;) {
            Item item;
            Handler h;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [&] { return stop_ || !queue_.empty(); });
                if (stop_ && queue_.empty()) return;
                item = std::move(queue_.front());
                queue_.pop_front();
                if (const auto it = handlers_.find(item.to); it != handlers_.end()) h = it->second;
            }
            if (h) h(item.from, item.signal);
        }
    }
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Item> queue_;
    std::map<std::string, Handler> handlers_;
    bool stop_ = false;
    std::thread thread_;
};

template <typename Pred>
static bool waitFor(Pred p, int ms = 3000) {
    for (int i = 0; i < ms / 10; ++i) {
        if (p()) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return p();
}

static std::unique_ptr<MediaBackend> stub() { return std::make_unique<StubMediaBackend>(); }

int main() {
    std::printf("=== parvane-core: менеджеры звонков (v2, без стека) ===\n");
    {
        Relay relay;
        const auto keyA = crypto::SigningKey::generate(), keyB = crypto::SigningKey::generate(),
                   keyC = crypto::SigningKey::generate();
        std::atomic<bool> bobRang{false};
        std::atomic<bool> bobSawMuted{false};
        CallManager::Callbacks ca, cb, cc;
        ca.sendV2 = [&](const std::string &peer, const json &s) {
            relay.send("alice@local", peer, s);
            return true;
        };
        cb.sendV2 = [&](const std::string &peer, const json &s) {
            relay.send("bob@local", peer, s);
            return true;
        };
        cc.sendV2 = [&](const std::string &peer, const json &s) {
            relay.send("carol@local", peer, s);
            return true;
        };
        cb.onIncoming = [&](std::string, std::string) { bobRang = true; };
        cb.onMediaState = [&](const std::string &peer, bool audio, bool video) {
            if (peer == "alice@local" && audio && !video) bobSawMuted = true;
        };
        CallManager alice("alice@local", &keyA, stub, ca);
        CallManager bob("bob@local", &keyB, stub, cb);
        CallManager carol("carol@local", &keyC, stub, cc);
        relay.attach("alice@local", [&](const std::string &from, const json &s) { alice.handleV2Signal(from, s); });
        relay.attach("bob@local", [&](const std::string &from, const json &s) { bob.handleV2Signal(from, s); });
        relay.attach("carol@local", [&](const std::string &from, const json &s) { carol.handleV2Signal(from, s); });

        alice.placeCall("bob@local", "audio");
        check(waitFor([&] { return bobRang.load(); }), "bob: входящий звонок (v2-сигнал без подписи SDP)");
        check(bob.state() == CallState::Incoming, "bob: состояние Incoming");
        bob.accept();
        check(waitFor([&] { return alice.state() == CallState::Active && bob.state() == CallState::Active; }),
              "оба в звонке (Active)");
        check(!alice.callId().empty() && alice.callId() == bob.callId(), "общий id звонка");
        alice.sendMediaState(true, false);
        check(waitFor([&] { return bobSawMuted.load(); }), "spec 024: bob видит, что у alice выключен микрофон");
        // carol звонит занятому bob — «занято»
        carol.placeCall("bob@local", "audio");
        check(waitFor([&] { return carol.state() == CallState::Ended; }), "занятый собеседник — отказ «занято»");
        alice.hangup();
        check(waitFor([&] { return bob.state() == CallState::Ended; }), "отбой доходит до собеседника");
    }
    {
        Relay relay;
        const auto k1 = crypto::SigningKey::generate(), k2 = crypto::SigningKey::generate(), k3 = crypto::SigningKey::generate();
        std::vector<std::unique_ptr<GroupCallManager>> m;
        const std::vector<std::string> who = {"a@local", "b@local", "c@local"};
        const crypto::SigningKey *keys[] = {&k1, &k2, &k3};
        std::atomic<int> mediaSeen{0};
        for (std::size_t i = 0; i < who.size(); ++i) {
            GroupCallManager::Callbacks cb;
            const auto self = who[i];
            cb.sendV2 = [&relay, self](const std::string &peer, const json &s, const std::string &gcid) {
                auto signal = s;
                if (!gcid.empty()) signal["group_call_id"] = gcid; // как callSignalFromV2 для попарных сигналов
                relay.send(self, peer, signal);
                return true;
            };
            cb.onMediaState = [&](const std::string &, bool, bool video) {
                if (video) ++mediaSeen;
            };
            m.push_back(std::make_unique<GroupCallManager>(self, keys[i], stub, cb));
        }
        for (std::size_t i = 0; i < who.size(); ++i) {
            auto *mgr = m[i].get();
            relay.attach(who[i], [mgr](const std::string &from, const json &s) { mgr->handleV2Signal(from, s); });
        }
        m[0]->startCall("0192f1a2-2222-7000-8000-000000000001", who, "audio", "v2g:00aa", "Семья");
        check(waitFor([&] { return m[0]->connectedCount() == 2 && m[1]->connectedCount() == 2 && m[2]->connectedCount() == 2; }, 5000),
              "групповой mesh: у каждого из трёх два соединения");
        m[1]->sendMediaState(false, true);
        check(waitFor([&] { return mediaSeen.load() >= 2; }), "spec 024: остальные видят выключенную камеру участника");
        for (auto &x : m) x->leave();
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
