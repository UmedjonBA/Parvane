// Parvane fork: CallManager и GroupCallManager без стека (spec 029: сигналы только v2). Менеджеры соединены
// колбэком sendV2 через очередь доставки на своём потоке — как сигнал, прошедший сервер (handleV2Signal);
// медиа — StubMediaBackend. Проверка: личный звонок до Active у обоих, состояние микрофона/камеры у
// собеседника, отказ «занято»; групповой mesh из трёх участников.
#include <algorithm>
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
#include <vector>

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
        // spec 024: входящий, принятый другим своим устройством, закрывается молча — без отказа звонящему
        std::atomic<bool> carolGotReject{false};
        relay.attach("carol@local", [&](const std::string &from, const json &s) {
            if (s.value("type", std::string()) == "reject") carolGotReject = true;
            carol.handleV2Signal(from, s);
        });
        bobRang = false;
        carol.placeCall("bob@local", "audio");
        check(waitFor([&] { return bobRang.load(); }), "bob: новый входящий от carol");
        const auto incoming = bob.callId();
        bob.handleV2Signal("bob@local", rejectSignal(incoming, "answered_elsewhere"));
        check(bob.state() == CallState::Ended, "spec 024: принят на другом своём устройстве — здесь закрыт");
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
        check(!carolGotReject.load() && carol.state() == CallState::Outgoing,
              "spec 024: звонящему отказ не уходит, у него звонок продолжается");
        check(!bob.dismissIncoming("нет-такого"), "чужой id звонка — не закрывает");
        carol.hangup();
    }
    {
        Relay relay;
        const auto k1 = crypto::SigningKey::generate(), k2 = crypto::SigningKey::generate(), k3 = crypto::SigningKey::generate();
        std::vector<std::unique_ptr<GroupCallManager>> m;
        const std::vector<std::string> who = {"a@local", "b@local", "c@local"};
        const crypto::SigningKey *keys[] = {&k1, &k2, &k3};
        std::atomic<int> mediaSeen{0};
        std::mutex evMu;
        std::vector<std::string> invites[3], closed[3], declined[3];
        std::atomic<bool> busy[3] = {false, false, false};
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
            cb.onInvite = [&, i](const std::string &, const std::string &gcid, const std::vector<std::string> &,
                                 const std::string &, const std::string &group, const std::string &title) {
                std::lock_guard<std::mutex> lk(evMu);
                invites[i].push_back(gcid + "|" + group + "|" + title);
            };
            cb.onInviteClosed = [&, i](const std::string &gcid) {
                std::lock_guard<std::mutex> lk(evMu);
                closed[i].push_back(gcid);
            };
            cb.onPeerDeclined = [&, i](const std::string &peer, const std::string &reason) {
                std::lock_guard<std::mutex> lk(evMu);
                declined[i].push_back(peer + ":" + reason);
            };
            cb.isBusy = [&, i] { return busy[i].load(); };
            m.push_back(std::make_unique<GroupCallManager>(self, keys[i], stub, cb));
        }
        for (std::size_t i = 0; i < who.size(); ++i) {
            auto *mgr = m[i].get();
            relay.attach(who[i], [mgr](const std::string &from, const json &s) { mgr->handleV2Signal(from, s); });
        }
        const auto has = [&](std::vector<std::string> *list, std::size_t i, const std::string &value) {
            std::lock_guard<std::mutex> lk(evMu);
            return std::find(list[i].begin(), list[i].end(), value) != list[i].end();
        };
        const std::string g1 = "0192f1a2-2222-7000-8000-000000000001";
        m[0]->startCall(g1, who, "audio", "v2g:00aa", "Семья");
        check(waitFor([&] { return m[1]->pendingInviteId() == g1 && m[2]->pendingInviteId() == g1; }),
              "приглашение ждёт решения у b и c (не входят сами)");
        check(has(invites, 1, g1 + "|v2g:00aa|Семья"), "CALL-2: во входящем — группа и её название");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        check(m[1]->connectedCount() == 0, "до «Принять» соединений нет (сигналы копятся)");
        check(m[1]->acceptInvite() && m[2]->acceptInvite(), "b и c приняли");
        check(waitFor([&] { return m[0]->connectedCount() == 2 && m[1]->connectedCount() == 2 && m[2]->connectedCount() == 2; }, 5000),
              "групповой mesh: у каждого из трёх два соединения (накопленные сигналы разобраны)");
        m[1]->sendMediaState(false, true);
        check(waitFor([&] { return mediaSeen.load() >= 2; }), "spec 024: остальные видят выключенную камеру участника");
        for (auto &x : m) x->leave();

        // Отказ: b отклоняет — инициатор сразу закрывает строку b; c принимает и соединяется
        const std::string g2 = "0192f1a2-2222-7000-8000-000000000002";
        m[0]->startCall(g2, who, "audio");
        check(waitFor([&] { return m[1]->pendingInviteId() == g2 && m[2]->pendingInviteId() == g2; }), "второе приглашение");
        check(m[1]->declineInvite(), "b отклонил");
        check(waitFor([&] { return has(declined, 0, "b@local:declined"); }), "инициатор: b отклонил (строка закрыта сразу)");
        check(has(closed, 1, g2), "b: приглашение закрыто");
        check(m[2]->acceptInvite(), "c принял");
        check(waitFor([&] { return m[0]->connectedCount() == 1 && m[2]->connectedCount() == 1; }, 5000),
              "a и c соединились без b (a=" + std::to_string(m[0]->connectedCount()) + ", c="
                  + std::to_string(m[2]->connectedCount()) + ")");
        for (auto &x : m) x->leave();

        // Своё другое устройство приняло приглашение — здесь оно замолкает без отказа
        {
            std::lock_guard<std::mutex> lk(evMu);
            for (auto &list : declined) list.clear();
        }
        const std::string g3 = "0192f1a2-2222-7000-8000-000000000003";
        m[0]->startCall(g3, who, "audio");
        check(waitFor([&] { return m[1]->pendingInviteId() == g3; }), "третье приглашение у b");
        m[1]->handleV2Signal("b@local", rejectSignal(g3, "answered_elsewhere"));
        check(m[1]->pendingInviteId().empty() && has(closed, 1, g3), "spec 024: принято на другом своём устройстве — замолчало");
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        check(!has(declined, 0, "b@local:declined"), "звонящему отказ от b не ушёл");
        m[1]->handleV2Signal("a@local", groupInviteSignal(g3, who, "audio"));
        check(m[1]->pendingInviteId().empty(), "повтор приглашения замолчавшего звонка не звонит");
        m[2]->declineInvite();
        for (auto &x : m) x->leave();

        // Занят личным звонком — «занят» всем участникам
        const std::string g4 = "0192f1a2-2222-7000-8000-000000000004";
        busy[1] = true;
        m[0]->startCall(g4, who, "audio");
        check(waitFor([&] { return has(declined, 0, "b@local:busy"); }), "занятый участник отвечает «занят»");
        check(m[1]->pendingInviteId().empty(), "занятому приглашение не звонит");
        busy[1] = false;
        m[2]->expireInvite(g4);
        check(waitFor([&] { return has(declined, 0, "c@local:declined"); }), "таймаут приглашения — отказ звонящему");
        for (auto &x : m) x->leave();
    }
    {
        // T185 (desktop): отправка участнику ждёт его ключ доступа (до 8 с). С asyncSend ожидание идёт в
        // очереди участника, не под замком менеджера: «Принять» возвращается сразу, входящие сигналы
        // разбираются, остальные участники соединяются, и после ожидания mesh полный.
        Relay relay;
        const auto k1 = crypto::SigningKey::generate(), k2 = crypto::SigningKey::generate(), k3 = crypto::SigningKey::generate();
        std::vector<std::unique_ptr<GroupCallManager>> m;
        const std::vector<std::string> who = {"a@local", "b@local", "c@local"};
        const crypto::SigningKey *keys[] = {&k1, &k2, &k3};
        std::atomic<bool> slowDone{false};
        for (std::size_t i = 0; i < who.size(); ++i) {
            GroupCallManager::Callbacks cb;
            const auto self = who[i];
            cb.asyncSend = true;
            cb.sendV2 = [&relay, &slowDone, self](const std::string &peer, const json &s, const std::string &gcid) {
                if (self == "b@local" && peer == "c@local" && !slowDone.exchange(true)) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(4000)); // «ждём встречный ключ»
                }
                auto signal = s;
                if (!gcid.empty()) signal["group_call_id"] = gcid;
                relay.send(self, peer, signal);
                return true;
            };
            m.push_back(std::make_unique<GroupCallManager>(self, keys[i], stub, cb));
        }
        for (std::size_t i = 0; i < who.size(); ++i) {
            auto *mgr = m[i].get();
            relay.attach(who[i], [mgr](const std::string &from, const json &s) { mgr->handleV2Signal(from, s); });
        }
        const std::string g5 = "0192f1a2-2222-7000-8000-000000000005";
        m[0]->startCall(g5, who, "audio");
        check(waitFor([&] { return m[1]->pendingInviteId() == g5 && m[2]->pendingInviteId() == g5; }),
              "asyncSend: приглашение дошло до b и c");
        const auto t0 = std::chrono::steady_clock::now();
        check(m[1]->acceptInvite(), "asyncSend: b принял");
        const auto acceptMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - t0).count();
        check(acceptMs < 500, "asyncSend: «Принять» не ждёт отправку участнику (" + std::to_string(acceptMs) + " мс)");
        check(m[2]->acceptInvite(), "asyncSend: c принял");
        check(waitFor([&] { return m[0]->connectedCount() == 1 && m[1]->connectedCount() >= 1; }, 3500),
              "asyncSend: b соединился с a, пока отправка c ещё ждёт");
        check(waitFor([&] { return m[0]->connectedCount() == 2 && m[1]->connectedCount() == 2 && m[2]->connectedCount() == 2; }, 10000),
              "asyncSend: после ожидания mesh полный");
        for (auto &x : m) x->leave();
    }
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
