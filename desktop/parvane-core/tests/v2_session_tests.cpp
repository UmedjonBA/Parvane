// Parvane fork: v2-сессия parvane-core против ЖИВОГО стека (spec 007, T064):
// nats + identity + messenger + gateway (TCP 9223 / WS 9222), поднимает
// scripts/run_all_tests.sh или desktop/verify_protocol_v2.sh.
//
// Покрытие: Hello/Welcome + проверка описателя сервера, Auth, создание
// устройства и журнала, маршрутизация по журналу собеседника (D-13), текст в
// обе стороны через анонимную доставку, правка/реакция/квитанция чтения,
// доставка офлайн-устройству и восстановление состояния из файла (import),
// то же по WebSocket (двоичные кадры) при PARVANE_V2_WS_URL.
#include <algorithm>
#include <atomic>
#include <functional>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <optional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include "parvane/call.h"
#include "parvane/messenger.h"
#include "parvane/v2_content.h"
#include "parvane/v2_control.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"
#include "parvane/v2_session.h"
#include "parvane/sections/cloud_sync.h"
#include "parvane/sections/domain_sync.h"
#include "parvane/sections/planner_sync.h"

using nlohmann::json;
namespace v2 = parvane::v2;

constexpr auto kTestPassword = "e2e-Test-pass-2026";

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
    std::fflush(stdout);
}

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}

// Регистрация + JWT с claim dev методами v2 канала PRE (`identity.account.register`,
// `identity.session.issue`) — v1 на сервере нет (T110). `stateDir` задан — устройство уже в журнале:
// вход с доказательством ключа (ID-01, стек с PARVANE_REQUIRE_DEVICE_PROOF=1).
static std::string issue(const std::string &gw, const std::string &user, const std::string &device,
                         const std::string &stateDir = std::string()) {
    try {
        (void)v2::preauth(gw, "identity.account.register", json{{"user", user}, {"password", kTestPassword}});
    } catch (const std::exception &) {
        // уже зарегистрирован
    }
    json req{{"login", user}, {"password", kTestPassword}, {"device_id", device}, {"client_kind", "desktop-test"}};
    if (!stateDir.empty()) {
        const auto ts = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::system_clock::now().time_since_epoch()).count();
        if (const auto proof = v2::Session::sessionProofFor(stateDir, ts); proof.is_object()) {
            req["device_proof"] = proof["proof"];
            req["proof_ts_ms"] = std::to_string(ts);
        }
    }
    const auto r = v2::preauth(gw, "identity.session.issue", req);
    return r.value("token", std::string());
}

// Сборщик событий движка одного клиента.
struct Inbox {
    std::mutex mu;
    std::condition_variable cv;
    std::vector<v2::Incoming> got;
    std::vector<json> session; // события сессии (groupUpdated, …)

    void push(const json &ev, const std::string &self) {
        const auto type = ev.value("type", std::string());
        if (type == "groupUpdated" || type == "groupLeft" || type == "groupUnconfirmed"
            || type == "ownDevicesAdded" || type == "stateReady" || type == "typing"
            || type == "peerRootChanged" || type == "needsLinking" || type == "privacy"
            || type == "privacySaved" || type == "peerRenamed" || type == "peerDeleted" || type == "sskRotationNeeded"
            || type == "callSignal" || type == "presence" || type == "plannerChanged" || type == "cloudChanged") {
            std::lock_guard<std::mutex> lk(mu);
            session.push_back(ev);
            cv.notify_all();
            return;
        }
        auto in = v2::interpretDirect(ev, self);
        if (in.kind == v2::Incoming::Kind::None) return;
        std::lock_guard<std::mutex> lk(mu);
        got.push_back(std::move(in));
        cv.notify_all();
    }
    template <typename Pred>
    bool waitSession(Pred pred, int ms = 20000) {
        std::unique_lock<std::mutex> lk(mu);
        return cv.wait_for(lk, std::chrono::milliseconds(ms), [&] {
            for (const auto &x : session) {
                if (pred(x)) return true;
            }
            return false;
        });
    }
    // Ждать событие, удовлетворяющее pred.
    template <typename Pred>
    bool wait(Pred pred, int ms = 15000) {
        std::unique_lock<std::mutex> lk(mu);
        return cv.wait_for(lk, std::chrono::milliseconds(ms), [&] {
            for (const auto &x : got) {
                if (pred(x)) return true;
            }
            return false;
        });
    }
};

struct Peer {
    std::string user;
    std::string token;
    Inbox inbox;
    std::unique_ptr<v2::Session> s;
    // Задан — зовётся на рабочем потоке сессии до сборщика (как обработчик событий хоста)
    std::function<void(const json &)> hook;
    // Задан — корень на устройстве не хранится: ключ восстановления сюда.
    bool withRecoveryKey = false;
    std::string recoveryKey;

    void start(const std::string &url, const std::string &dir) {
        v2::SessionConfig cfg;
        if (withRecoveryKey) {
            cfg.onRecoveryKey = [this](const std::string &key) { recoveryKey = key; };
        }
        cfg.gatewayUrl = url;
        cfg.self = user;
        cfg.token = [this] { return token; };
        cfg.stateDir = dir;
        cfg.clientVersion = "desktop-test";
        cfg.otkCount = 10;
        cfg.log = [u = user](const std::string &m) { std::printf("    [%s] %s\n", u.c_str(), m.c_str()); };
        cfg.onEvent = [this](const json &ev) {
            if (hook) hook(ev);
            inbox.push(ev, user);
        };
        s = std::make_unique<v2::Session>(std::move(cfg));
        s->start();
    }
};

static bool textArrived(Inbox &in, const std::string &text, const std::string &from, std::string *id = nullptr,
                        int ms = 15000) {
    return in.wait([&](const v2::Incoming &x) {
        const bool ok = x.kind == v2::Incoming::Kind::Message && x.from == from
            && x.content.value("text", std::string()) == text;
        if (ok && id) *id = x.id;
        return ok;
    }, ms);
}

static bool groupTextArrived(Inbox &in, const std::string &group, const std::string &text, const std::string &from,
                             int ms = 20000) {
    return in.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Message && x.group && x.chat == group && x.from == from
            && x.content.value("text", std::string()) == text;
    }, ms);
}

// Группы v2 (T056/T073/T080/T084/T125) и журнал личного состояния (T098).
static void groupScenario(const std::string &tcp, const std::string &dir, const std::string &suffix, Peer &alice,
                          Peer &bob) {
    Peer dave, erin;
    dave.user = "v2dd" + suffix + "@local";
    erin.user = "v2de" + suffix + "@local";
    try {
        dave.token = issue(tcp, dave.user, "dd-" + suffix);
        erin.token = issue(tcp, erin.user, "de-" + suffix);
    } catch (const std::exception &e) {
        check(false, "dave/erin: JWT", e.what());
        return;
    }
    dave.start(tcp, dir + "/dave");
    erin.start(tcp, dir + "/erin");
    check(dave.s->waitReady(30000) && erin.s->waitReady(30000), "dave/erin: v2-сессии готовы");

    std::string group;
    try {
        group = alice.s->createGroup("Группа v2 " + suffix, {bob.user, dave.user}, false);
    } catch (const std::exception &e) {
        check(false, "alice: группа v2 создана", e.what());
        return;
    }
    check(v2::isGroupAddress(group), "alice: группа v2 создана (все участники на v2)", group);
    check(alice.s->createGroup("v1", {"nobody" + suffix + "@local"}, false).empty(),
          "участник без журнала v2 → группа не v2 (идти по v1)");
    const auto info = alice.s->groupInfo(group);
    check(info.is_object() && info.value("members", json::array()).size() == 3, "сведения группы по журналу: 3 участника");
    const auto seen = [&](Peer &p) {
        return p.inbox.waitSession([&](const json &e) {
            return e.value("type", std::string()) == "groupUpdated" && e.value("address", std::string()) == group;
        });
    };
    check(seen(bob) && seen(dave), "bob и dave увидели группу из журнала (groupUpdated)");

    try {
        alice.s->sendContent(group, *v2::toV2(parvane::textContent("g-hello-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "alice → группа: отправлено", e.what());
    }
    check(groupTextArrived(bob.inbox, group, "g-hello-" + suffix, alice.user), "bob получил групповое alice");
    check(groupTextArrived(dave.inbox, group, "g-hello-" + suffix, alice.user), "dave получил групповое alice");
    try {
        bob.s->sendContent(group, *v2::toV2(parvane::textContent("g-bob-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "bob → группа: отправлено", e.what());
    }
    check(groupTextArrived(alice.inbox, group, "g-bob-" + suffix, bob.user), "alice получила групповое bob");

    // T127 (FR-064): «печатает» в группе — анонимно, канал из ключа эпохи.
    check(alice.s->sendTyping(group), "T127: «печатает» в группе v2 взято на v2");
    const auto groupTyping = [&](Peer &p) {
        return p.inbox.waitSession([&](const json &e) {
            return e.value("type", std::string()) == "typing" && e.value("chat", std::string()) == group
                && e.value("from", std::string()) == alice.user;
        }, 5000);
    };
    check(groupTyping(bob) && groupTyping(dave), "T127: участники группы получили «печатает» alice");

    // FR-028 (T080): сервер показывает лишнего участника — предупреждение.
    alice.s->reportUnconfirmed(group, {alice.user, bob.user, dave.user, "mallory" + suffix + "@local"});
    check(alice.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "groupUnconfirmed" && e.value("members", json::array()).dump().find("mallory") != std::string::npos;
    }, 3000), "T080: участник без записи администратора → groupUnconfirmed");

    // Бан dave → новая эпоха; dave новых сообщений не читает.
    check(alice.s->changeGroup(group, json{{"ban", {{"member", {{"address", dave.user}}}}}}), "alice забанила dave (запись журнала)");
    check(dave.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "groupLeft" && e.value("address", std::string()) == group;
    }, 30000), "dave: группа снята (groupLeft)");
    const auto epochBefore = info.value("epoch", 0ull);
    const auto after = alice.s->groupInfo(group);
    check(after.is_object() && after.value("epoch", 0ull) > epochBefore && !after.value("epochStale", true),
          "после бана — новая эпоха", after.is_object() ? std::to_string(after.value("epoch", 0ull)) : "?");
    try {
        alice.s->sendContent(group, *v2::toV2(parvane::textContent("g-after-ban-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "alice → группа после бана", e.what());
    }
    check(groupTextArrived(bob.inbox, group, "g-after-ban-" + suffix, alice.user), "bob получил сообщение новой эпохи");
    check(!groupTextArrived(dave.inbox, group, "g-after-ban-" + suffix, alice.user, 3000), "dave сообщение новой эпохи НЕ получил");

    // Ссылка-приглашение v2 → erin вступает.
    const auto inv = alice.s->createInvite(group, "", 0, 0, false);
    const auto url = inv.is_object() ? inv.value("url", std::string()) : std::string();
    check(v2::Session::isInviteUrl(url) && url.find("/join/") != std::string::npos && url.find('#') != std::string::npos,
          "ссылка v2 https://<domain>/join/<link_id>#<seed>", url);
    check(alice.s->listInvites(group).size() == 1, "список активных ссылок");
    const auto check1 = erin.s->checkInvite(url);
    check(check1.is_object() && check1.value("address", std::string()) == group && !check1.value("isMember", true),
          "erin: превью ссылки (группа, ещё не участник)", check1.dump());
    const auto joined = erin.s->joinByInvite(url);
    check(joined.is_object() && joined.value("status", std::string()) == "ok", "erin вступила по ссылке", joined.dump());
    check(alice.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "groupUpdated" && e["info"].dump().find(erin.user) != std::string::npos;
    }, 30000), "alice увидела erin в составе");
    // Дождаться новой эпохи с erin (раздаёт владелец) и написать.
    std::this_thread::sleep_for(std::chrono::seconds(2));
    bool delivered = false;
    for (int i = 0; i < 3 && !delivered; ++i) {
        try {
            alice.s->sendContent(group, *v2::toV2(parvane::textContent("g-erin-" + suffix + std::to_string(i))), v2::newUuidV7());
        } catch (const std::exception &e) {
            std::printf("    отправка после вступления: %s\n", e.what());
        }
        delivered = groupTextArrived(erin.inbox, group, "g-erin-" + suffix + std::to_string(i), alice.user, 15000);
    }
    check(delivered, "erin получила групповое после вступления");
    // spec 024: правка ссылки (название, лимит) и вступившие по ней
    const auto linkId = inv.is_object() ? inv.value("linkId", std::string()) : std::string();
    check(alice.s->editInvite(group, url, "Ссылка для друзей", 0, 5), "spec 024: ссылка отредактирована (название, лимит)");
    {
        const auto g = alice.s->groupInfo(group);
        bool titled = false;
        for (const auto &meta : g.value("invites", json::array())) {
            titled = titled || (meta.value("id", std::string()) == linkId && meta.dump().find("Ссылка для друзей") != std::string::npos);
        }
        check(titled, "spec 024: новое название ссылки — в журнале группы");
    }
    const auto joins = alice.s->listInviteJoins(group, linkId);
    check(joins.dump().find(erin.user) != std::string::npos, "spec 024: erin — во вступивших по ссылке", joins.dump());
    check(alice.s->revokeInvite(group, url) && alice.s->listInvites(group).empty(), "ссылка отозвана записью журнала");
    const auto revoked = alice.s->listRevokedInvites(group);
    check(revoked.dump().find(linkId) != std::string::npos, "отозванная ссылка — в списке отозванных", revoked.dump());
    check(alice.s->deleteRevokedInvite(group, linkId) && alice.s->listRevokedInvites(group).empty(),
          "отозванная ссылка удалена из списка");

    // Сведения одной записью: имя и описание вместе (вторая правка не откатывает первую)
    check(alice.s->setGroupInfo(group, std::string("Кружок ") + suffix, std::string("Про всё"), std::nullopt),
          "сведения группы — одной записью");
    {
        const auto g = alice.s->groupInfo(group);
        check(g.value("name", std::string()) == "Кружок " + suffix && g.value("about", std::string()) == "Про всё",
              "имя и описание группы — оба на месте", g.value("name", std::string()));
    }

    // spec 023: публичная группа — имя, поиск, вступление по открытому секрету, история для новых
    const auto pubName = "pub" + suffix;
    const auto madePublic = alice.s->setGroupPublic(group, true, pubName, true, true);
    check(madePublic == "ok", "spec 023: группа стала публичной", madePublic);
    // proto3-JSON: false не передаётся
    check(!alice.s->checkPublicName(pubName).value("available", false), "spec 023: имя занято");
    check(alice.s->checkPublicName("free" + pubName).value("available", false), "spec 023: свободное имя — доступно");
    // История публичной группы хранит сообщения с момента публичности
    try {
        alice.s->sendContent(group, *v2::toV2(parvane::textContent("pub-hello-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "alice → публичная группа", e.what());
    }
    const auto resolved = bob.s->resolvePublic(pubName);
    check(resolved.is_object() && resolved.value("hex", std::string()) == v2::groupHex(group), "spec 023: группа находится по имени");
    check(bob.s->searchPublic(pubName).dump().find(pubName) != std::string::npos, "spec 023: группа есть в поиске");
    {
        Peer fred;
        fred.user = "v2df" + suffix + "@local";
        fred.token = issue(tcp, fred.user, "df-" + suffix);
        fred.start(tcp, dir + "/fred");
        check(fred.s->waitReady(30000), "fred: сессия готова");
        const auto found = fred.s->resolvePublic(pubName);
        json joinedPub;
        try {
            if (found.is_object()) joinedPub = fred.s->joinPublic(found.value("hex", std::string()), found.value("secretHex", std::string()));
        } catch (const std::exception &e) {
            check(false, "spec 023: вступление в публичную группу", e.what());
        }
        check(joinedPub.is_object() && joinedPub.dump().find(fred.user) != std::string::npos, "spec 023: fred вступил по открытому секрету");
        const auto hist = fred.s->publicHistory(group, 0);
        check(hist.is_object() && hist.value("opened", 0) >= 1, "spec 023: новому участнику открыта история группы",
              hist.is_object() ? hist.dump() : "null");
        fred.s->stop();
    }

    // Журнал личного состояния: миграция, правка, перечитывание после рестарта.
    const auto snap = alice.s->stateAttach(json{{"folders", json::array({json{{"id", 2}, {"title", "Работа"}}})}});
    check(snap.is_object() && snap.dump().find("Работа") != std::string::npos, "T098: локальные папки перенесены в журнал");
    const auto synced = alice.s->stateSync(
        json{{"folders", json::array({json{{"id", 2}, {"title", "Работа"}}, json{{"id", 3}, {"title", "Дом"}}})}},
        {"folders"});
    check(synced.is_object() && synced["snapshot"].dump().find("Дом") != std::string::npos, "T098: своя правка — в журнал");

    dave.s->stop();
    erin.s->stop();
}

// T185: попарный сигнал группового звонка участнику, с которым не было переписки, шлётся
// из обработчика событий — на рабочем потоке сессии (как GroupCallManager в tdesktop).
// Встречный ключ доступа приходит записью инбокса; рабочий поток, ждущий его, обязан
// разобрать её сам (verify_group_call: bob → carol упирался в 8 с и сигнал терялся).
static void groupCallKeyScenario(const std::string &tcp, const std::string &dir, const std::string &suffix) {
    Peer ka, kb, kc;
    ka.user = "v2ka" + suffix + "@local";
    kb.user = "v2kb" + suffix + "@local";
    kc.user = "v2kc" + suffix + "@local";
    try {
        ka.token = issue(tcp, ka.user, "ka-" + suffix);
        kb.token = issue(tcp, kb.user, "kb-" + suffix);
        kc.token = issue(tcp, kc.user, "kc-" + suffix);
    } catch (const std::exception &e) {
        check(false, "T185: JWT участников звонка", e.what());
        return;
    }
    std::atomic<bool> fired{false};
    std::atomic<int> result{-1};
    std::atomic<long long> tookMs{0};
    std::string group; // задаётся до появления группы у kb; читается в hook после
    std::mutex groupMu;
    const auto callId = v2::newUuidV7();
    const auto groupCallId = v2::newUuidV7();
    kb.hook = [&](const json &ev) {
        if (ev.value("type", std::string()) != "groupUpdated") return;
        {
            std::lock_guard<std::mutex> lk(groupMu);
            if (group.empty() || ev.value("address", std::string()) != group) return;
        }
        if (fired.exchange(true)) return;
        const auto t0 = std::chrono::steady_clock::now();
        const bool sent = kb.s->sendCallSignal(kc.user, parvane::inviteSignal(callId, "audio", "v=0 t185"), groupCallId);
        tookMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
        result = sent ? 1 : 0;
    };
    std::atomic<bool> signalled{false};
    kc.hook = [&](const json &ev) {
        if (ev.value("type", std::string()) == "callSignal" && ev.value("group", false)
            && ev.value("from", std::string()) == kb.user) {
            signalled = true;
        }
    };
    ka.start(tcp, dir + "/ka");
    kb.start(tcp, dir + "/kb");
    kc.start(tcp, dir + "/kc");
    check(ka.s->waitReady(30000) && kb.s->waitReady(30000) && kc.s->waitReady(30000), "T185: сессии участников готовы");
    try {
        std::lock_guard<std::mutex> lk(groupMu);
        group = ka.s->createGroup("Звонок " + suffix, {kb.user, kc.user}, false);
    } catch (const std::exception &e) {
        check(false, "T185: группа создана", e.what());
    }
    for (int i = 0; i < 300 && result < 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    check(result == 1, "T185: сигнал из обработчика событий участнику без переписки ушёл (встречный ключ пришёл)",
          std::to_string(tookMs.load()) + " мс");
    check(result == 1 && tookMs < 6000, "T185: встречный ключ разобран, не дожидаясь конца ожидания",
          std::to_string(tookMs.load()) + " мс");
    for (int i = 0; i < 100 && !signalled; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    check(signalled.load(), "T185: участник получил попарный сигнал группового звонка");
    ka.s->stop();
    kb.s->stop();
    kc.s->stop();
}

// ── spec 029, T026: живые случаи таблицы M1–M36 plan.md, которых не было ─────────────────────────────

// Транспорт разделов поверх живой сессии — как `SessionTransport` в tdesktop (parvane_sections_data.cpp).
namespace d = parvane::sections::domain;
class LiveTransport final : public d::DomainTransport {
public:
    explicit LiveTransport(v2::Session &s) : s_(s) {}
    json engine(const std::string &name, const json &args) override { return s_.engineCall(name, args, false); }
    json engineWithNeeds(const std::string &name, const json &args) override { return s_.engineCall(name, args, true); }
    std::string request(bool anon, const std::string &method, const std::string &body, const std::string &dest) override {
        try {
            return s_.busRequest(anon, method, body, dest);
        } catch (const v2::V2Error &e) {
            throw d::BusError(e.code());
        }
    }
    std::string encodeMethod(const std::string &method, const json &value) override { return v2::encodeMethodRequest(method, value); }
    json decodeMethod(const std::string &method, const std::string &bytes) override { return v2::decodeMethodResponse(method, bytes); }
    bool hasClient() override { return true; }
    bool isReady() override { return s_.isReady(); }
    bool needsLinking() override { return s_.needsLinking(); }
    std::string self() override { return s_.self(); }
    std::string serverDomain() override { return s_.serverDomain(); }
    void persist() override { s_.persistEngine(); }
    std::int64_t nowMs() override {
        return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    }
    void log(const std::string &m) override { s_.logLine("разделы: " + m); }

private:
    v2::Session &s_;
};

static std::string nowMsStr() {
    return std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::system_clock::now().time_since_epoch()).count());
}

// Хуки «Плана» и «Облака» на журнале личного состояния сессии — как plannerHooks()/cloudHooks() в tdesktop.
namespace pl = parvane::sections::planner;
namespace cl = parvane::sections::cloud;
static pl::PlannerHooks plannerHooksOf(v2::Session &s) {
    return pl::PlannerHooks{
        [&s]() -> std::optional<pl::ContainerRef> {
            const auto snap = s.stateSnapshot();
            if (!snap.is_object() || !snap.contains("planner_container")) return std::nullopt;
            const auto ref = snap["planner_container"].is_object() ? snap["planner_container"].value("ref", json::object()) : json::object();
            const auto id = ref.is_object() ? ref.value("id", std::string()) : std::string();
            if (id.empty()) return std::nullopt;
            return pl::ContainerRef{ref.value("domain", std::string()), d::b64ToHex(id)};
        },
        [&s](const pl::ContainerRef &ref) { s.stateCall("plannerContainerSet", json{{"domain", ref.domain}, {"idHex", ref.id}}); },
        [] {}};
}
static cl::CloudHooks cloudHooksOf(v2::Session &s) {
    return cl::CloudHooks{
        [&s] { return cl::parseCloudEntries(s.stateSnapshot()); },
        [&s](const cl::CloudStateEntry &entry) { s.stateCall("cloudContainerSet", json{{"containerJson", cl::cloudEntryToState(entry)}}); },
        [](const std::string &) {},
        [&s](const std::string &user) { s.refreshPeerLog(user); },
        [] {}};
}

// M15/M18/M20 (виды содержимого), M16 (удаление, закреп), M28 (сигнал личного звонка).
static void contentAndCallScenario(const std::string &tcp, const std::string &dir, const std::string &suffix,
                                   Peer &alice, Peer &bob) {
    std::printf("-- содержимое, мутации, личный звонок (M15/M16/M18/M20/M28)\n");
    const auto pollId = v2::newUuidV7();
    try {
        alice.s->sendContent(bob.user, *v2::toV2(json{{"kind", "poll"}, {"question", "Чай или кофе?"},
                                                      {"answers", json::array({"чай", "кофе"})}, {"multiple", true}}), pollId);
        alice.s->sendContent(bob.user, *v2::toV2(json{{"kind", "location"}, {"lat", 55.75}, {"long", 37.61}}), "");
    } catch (const std::exception &e) {
        check(false, "M18/M20: опрос и геопозиция отправлены", e.what());
    }
    check(bob.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Message && x.id == pollId && x.content.value("kind", "") == "poll"
            && x.content.value("question", "") == "Чай или кофе?" && x.content.value("answers", json::array()).size() == 2;
    }), "M18: опрос дошёл видом poll (вопрос, два ответа)");
    check(bob.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Message && x.from == alice.user && x.content.value("kind", "") == "location"
            && std::abs(x.content.value("lat", 0.0) - 55.75) < 1e-6;
    }), "M20: геопозиция дошла видом location");
    try {
        alice.s->sendContent(bob.user, json{{"pin", {{"target", v2::ref(pollId)}}}}, "");
        alice.s->sendContent(bob.user, json{{"delete", {{"targets", json::array({v2::ref(pollId)})}, {"for_everyone", true}}}}, "");
    } catch (const std::exception &e) {
        check(false, "M16: закреп и удаление отправлены", e.what());
    }
    check(bob.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Pin && !x.unpin && !x.targets.empty() && x.targets[0] == pollId;
    }), "M16: закреп дошёл (Pin)");
    check(bob.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Delete && !x.targets.empty() && x.targets[0] == pollId;
    }), "M16: удаление «у всех» дошло (Delete)");

    // Сигнал личного звонка — только тому, чей ключ доступа есть (D-08). bob знает ключ alice по переписке
    // (alice свой не отзывала); сбой по v2 вниз не понижается (D-13): true и причина в error.
    const auto callId = v2::newUuidV7();
    std::string error;
    const bool sent = bob.s->sendCallSignal(alice.user, parvane::inviteSignal(callId, "audio", "v=0 m28"), "", &error);
    check(sent && error.empty(), "M28: сигнал звонка собеседнику с ключом доступа ушёл", error);
    check(alice.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "callSignal" && !e.value("group", false)
            && e.value("from", std::string()) == bob.user && e["signal"].value("call_id", std::string()) == callId;
    }, 10000), "M28: alice получила приглашение в звонок (callSignal, не групповой)");
    Peer stranger;
    stranger.user = "v2dn" + suffix + "@local";
    try {
        stranger.token = issue(tcp, stranger.user, "dn-" + suffix);
        stranger.start(tcp, dir + "/stranger");
        check(stranger.s->waitReady(30000), "M28: незнакомец на v2 готов");
        error.clear();
        (void)bob.s->isV2Peer(stranger.user);
        (void)bob.s->sendCallSignal(stranger.user, parvane::inviteSignal(v2::newUuidV7(), "audio", "v=0"), "", &error);
        check(error == "forbidden", "M28: без ключа доступа адресата звонок запрещён (forbidden, по v1 не понижается)", error);
        stranger.s->stop();
    } catch (const std::exception &e) {
        check(false, "M28: незнакомец", e.what());
    }
}

// M2 (регистрация/статус), M8 (смена пароля), M13 (профиль), M34 (каталог), M24 (жалоба серверу),
// M36 (нужна новая версия) — методами v2 через `Control`/`preauth`, как мост и web.
static void identityScenario(const std::string &tcp, const std::string &upgradeTcp, const std::string &suffix,
                             Peer &alice, Peer &bob) {
    std::printf("-- identity: регистрация, пароль, профиль, каталог, жалоба, версия (M2/M8/M13/M24/M34/M36)\n");
    {
        bool dup = false;
        try {
            (void)v2::preauth(tcp, "identity.account.register", json{{"user", alice.user}, {"password", kTestPassword}});
        } catch (const v2::V2Error &e) {
            dup = e.code() == "ERROR_CODE_DUPLICATE";
        }
        check(dup, "M2: повторная регистрация ника — DUPLICATE");
        std::string bad;
        try {
            (void)v2::preauth(tcp, "identity.account.register", json{{"user", "Плохой Ник@local"}, {"password", kTestPassword}});
        } catch (const v2::V2Error &e) {
            bad = e.code();
        }
        check(bad == "ERROR_CODE_INVALID", "M2: негодный ник — INVALID", bad);
        json st;
        try {
            st = v2::preauth(tcp, "identity.account.register_status", json{{"user", alice.user}, {"token", ""}});
        } catch (const std::exception &e) {
            check(false, "M2: статус регистрации", e.what());
        }
        check(st.is_object(), "M2: статус регистрации отвечает (confirmed — только для ожидающих подтверждения)", st.dump());
    }
    {
        const auto user = "v2dp" + suffix + "@local";
        const auto device = "dp-" + suffix;
        std::string token;
        try {
            token = issue(tcp, user, device);
        } catch (const std::exception &e) {
            check(false, "M8: JWT", e.what());
        }
        v2::ControlConfig cc;
        cc.gatewayUrl = tcp;
        cc.token = [token] { return token; };
        cc.clientVersion = "desktop-test";
        v2::Control c(cc);
        const auto fresh = "e2e-New-pass-2026";
        bool changed = false;
        try {
            (void)c.call("identity.session.reauth", json{{"password", kTestPassword}});
            (void)c.call("identity.account.change_password", json{{"old_password", kTestPassword}, {"new_password", fresh}});
            changed = true;
        } catch (const std::exception &e) {
            check(false, "M8: смена пароля", e.what());
        }
        check(changed, "M8: пароль сменён (reauth + change_password)");
        bool oldRefused = false;
        try {
            (void)v2::preauth(tcp, "identity.session.issue", json{{"login", user}, {"password", kTestPassword}, {"device_id", device}});
        } catch (const v2::V2Error &) {
            oldRefused = true;
        }
        check(oldRefused, "M8: прежний пароль больше не подходит");
        json again;
        try {
            again = v2::preauth(tcp, "identity.session.issue", json{{"login", user}, {"password", fresh}, {"device_id", device}});
        } catch (const std::exception &e) {
            check(false, "M8: вход новым паролем", e.what());
        }
        check(!again.value("token", std::string()).empty(), "M8: вход новым паролем");
        c.close();
    }
    {
        v2::ControlConfig ca;
        ca.gatewayUrl = tcp;
        ca.token = [&alice] { return alice.token; };
        ca.clientVersion = "desktop-test";
        v2::Control a(ca);
        v2::ControlConfig cb = ca;
        cb.token = [&bob] { return bob.token; };
        v2::Control b(cb);
        bool set = false;
        try {
            (void)a.call("identity.profile.set_name", json{{"display_name", "Алиса Тест"}, {"bio", "о себе"}, {"name_color", "3"}});
            set = true;
        } catch (const std::exception &e) {
            check(false, "M13: профиль записан", e.what());
        }
        check(set, "M13: профиль записан (имя, о себе, цвет)");
        json resolved;
        try {
            resolved = b.call("identity.profile.resolve", json{{"users", json::array({json{{"address", alice.user}}})}});
        } catch (const std::exception &e) {
            check(false, "M13: профиль прочитан собеседником", e.what());
        }
        const auto *profiles = v2::field(resolved, "profiles", "profiles");
        const json p = profiles && profiles->is_array() && !profiles->empty() ? (*profiles)[0] : json::object();
        const auto *name = v2::field(p, "displayName", "display_name");
        const auto *color = v2::field(p, "nameColor", "name_color");
        check(name && name->is_string() && *name == "Алиса Тест" && p.value("bio", std::string()) == "о себе"
                  && color && (color->is_number() ? color->get<int>() == 3 : color->get<std::string>() == "3"),
              "M13: собеседник видит имя, «о себе» и цвет", p.dump());
        json found;
        try {
            found = b.call("identity.directory.search", json{{"query", "v2da" + suffix}});
        } catch (const std::exception &e) {
            check(false, "M34: поиск по каталогу", e.what());
        }
        check(found.dump().find(alice.user) != std::string::npos, "M34: поиск по каталогу находит ник", found.dump());
        a.close();
        b.close();
    }
    check(alice.s->submitReport(json{{"kind", "spam"}, {"user", bob.user}, {"text", "тест жалобы"}}) == "sent",
          "M24: жалоба серверу запечатана ключом администратора и отправлена");
    if (!upgradeTcp.empty()) {
        std::string code;
        try {
            (void)v2::preauth(upgradeTcp, "server.describe", json::object(), "desktop-test");
        } catch (const v2::V2Error &e) {
            code = e.code();
        } catch (const std::exception &e) {
            code = e.what();
        }
        check(code.find("UPGRADE_REQUIRED") != std::string::npos, "M36: gateway с минимальной версией выше нашей — UPGRADE_REQUIRED", code);
    }
}

// Два устройства одного аккаунта: журнал личного состояния по видам (M21/M22), история звонков и сигнал
// «принято на другом устройстве» (M30), «План» и «Облако» — домен `domains` (spec 010/016, DOMAIN-1/2).
static void devicesStateAndDomainsScenario(const std::string &tcp, const std::string &dir, const std::string &suffix,
                                           Peer &bob) {
    std::printf("-- журнал состояния, звонки, домены «План»/«Облако» на двух устройствах (M21/M22/M30, domains)\n");
    Peer d1, d2;
    d1.user = d2.user = "v2dm" + suffix + "@local";
    try {
        d1.token = issue(tcp, d1.user, "dm1-" + suffix);
    } catch (const std::exception &e) {
        check(false, "domains: JWT", e.what());
        return;
    }
    d1.start(tcp, dir + "/dm1");
    check(d1.s->waitReady(30000), "domains: первое устройство готово");
    (void)d1.s->stateAttach(json::object());
    try {
        d2.token = issue(tcp, d2.user, "dm2-" + suffix);
    } catch (const std::exception &e) {
        check(false, "domains: JWT второго устройства", e.what());
    }
    d2.start(tcp, dir + "/dm2");
    check(!d2.s->waitReady(8000) && d2.s->needsLinking(), "domains: второе устройство ждёт привязку");
    d2.s->joinWithGrant(d1.s->linkGrantMaterial());
    check(d2.s->waitReady(30000), "domains: второе устройство привязано грантом");
    (void)d2.s->stateAttach(json::object());

    // M21/M22: виды журнала состояния — блок-лист, архив, уведомления, черновик, закреп
    const auto textB64 = d::toBase64(v2::encodeMessage("parvane.msg.v2.Text", json{{"text", "черновик " + suffix}}));
    const json desired{
        {"blocked", json::array({json{{"peer", {{"user", {{"address", "spam" + suffix + "@local"}}}}}, {"blocked_at_ms", "1700000000000"}}})},
        {"archived", json::array({json{{"user", {{"address", bob.user}}}}})},
        {"notify", json::array({json{{"peer", {{"user", {{"address", bob.user}}}}}, {"settings", {{"mute_until_ms", "4102444800000"}}}}})},
        {"drafts", json::array({json{{"peer", {{"user", {{"address", bob.user}}}}}, {"text", textB64}, {"date_ms", nowMsStr()}}})},
        {"pinned", json::array({json{{"list", "PIN_LIST_MAIN"}, {"peers", json::array({json{{"user", {{"address", bob.user}}}}})}}})},
    };
    const auto synced = d1.s->stateSync(desired, {"blocked", "archived", "notify", "drafts", "pinned"});
    const auto snap1 = synced.is_object() ? synced.value("snapshot", json::object()) : json::object();
    check(snap1.contains("blocked") && snap1.dump().find("spam" + suffix) != std::string::npos
              && snap1.contains("archived") && snap1.contains("notify") && snap1.contains("drafts") && snap1.contains("pinned"),
          "M21/M22: блок-лист, архив, уведомления, черновик, закреп — в журнале", snap1.dump().substr(0, 200));
    json snap2;
    for (int i = 0; i < 20; ++i) {
        const auto r = d2.s->stateSync(json(), {});
        snap2 = r.is_object() ? r.value("snapshot", json::object()) : json::object();
        if (snap2.dump().find("spam" + suffix) != std::string::npos && snap2.dump().find(textB64) != std::string::npos) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    check(snap2.dump().find("spam" + suffix) != std::string::npos && snap2.dump().find(textB64) != std::string::npos
              && snap2.dump().find("4102444800000") != std::string::npos,
          "M21/M22: второе устройство прочитало те же виды (блок-лист, черновик, уведомления)");
    // Очистка чата «у себя» — граница между своими устройствами
    d1.s->stateChatCleared(bob.user, 1700000001000);
    bool cleared = false;
    for (int i = 0; i < 20 && !cleared; ++i) {
        const auto r = d2.s->stateSync(json(), {});
        cleared = r.is_object() && r.value("snapshot", json::object()).dump().find("1700000001000") != std::string::npos;
        if (!cleared) std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    check(cleared, "T145: граница очистки чата дошла до второго устройства (cleared)");

    // M30: история звонков в журнале и «принято/отклонено на другом устройстве»
    const auto callId = v2::newUuidV7();
        check(d1.s->stateCall("callSet", json{{"recordJson", json{{"call_id", v2::uuidToB64(callId)}, {"peer", {{"user", {{"address", bob.user}}}}},
                                                                {"outgoing", true}, {"started_ms", "1700000002000"}, {"duration_s", 42}}}}),
          "M30: запись истории звонка — в журнал состояния (callSet)");
    bool calls = false;
    for (int i = 0; i < 20 && !calls; ++i) {
        const auto r = d2.s->stateSync(json(), {});
        const auto s = r.is_object() ? r.value("snapshot", json::object()) : json::object();
        calls = s.contains("calls") && s["calls"].dump().find("1700000002000") != std::string::npos;
        if (!calls) std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    check(calls, "M30: история звонков видна второму устройству (calls, длительность 42 с)");
    check(d1.s->sendCallSignalOwn(parvane::hangupSignal(callId)), "M30: сигнал «завершено здесь» своим устройствам ушёл");
    check(d2.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "callSignal" && e.value("from", std::string()) == d1.user
            && e["signal"].value("call_id", std::string()) == callId && e["signal"].value("type", std::string()) == "hangup";
    }, 10000), "M30: второе устройство получило «принято/завершено на другом устройстве»");
    check(!d1.s->sendCallSignalOwn(parvane::inviteSignal(callId, "audio", "v=0")), "M30: своим устройствам уходит только reject/hangup");

    // «План» (spec 010): контейнер и операция с первого устройства, второе читает по ключу от своего устройства
    LiveTransport t1(*d1.s), t2(*d2.s);
    d::MemoryRecords r1, r2;
    pl::PlannerSync p1(t1, r1, plannerHooksOf(*d1.s));
    pl::PlannerSync p2(t2, r2, plannerHooksOf(*d2.s));
    p1.ensure();
    check(p1.status() == "ready", "planner: раздел подключён к стеку (ready)", p1.status());
    p1.apply(json::array({json{{"task", {{"id", "t-" + suffix}, {"name", "Полить цветы"}, {"day", "2026-10-20"}}}}}));
    p1.tick();
    p1.flush();
    const auto s1 = p1.stateJson();
    check(s1 && s1->value("tasks", json::array()).dump().find("Полить цветы") != std::string::npos,
          "planner: контейнер создан, операция применена и отправлена", s1 ? s1->dump().substr(0, 160) : "null");
    check(p1.outboxSize() == 0 && !p1.hasPending(), "planner: очередь отправки пуста");
    {
        const auto snap = d1.s->stateSnapshot();
        check(snap.is_object() && snap.contains("planner_container") && snap["planner_container"].dump().find("\"id\"") != std::string::npos,
              "planner: контейнер объявлен в журнале личного состояния (planner_container)");
    }
    bool seen = false;
    for (int i = 0; i < 60 && !seen; ++i) {
        p2.onEngineEvent();
        p2.ensure();
        p2.syncNow();
        p2.tick();
        const auto s2 = p2.stateJson();
        seen = s2 && s2->value("tasks", json::array()).dump().find("Полить цветы") != std::string::npos;
        if (!seen) std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    check(seen, "planner: второе устройство получило ключ контейнера и видит задачу", p2.status());

    // «Облако» (spec 016): личный диск с папкой с первого устройства, второе видит контейнер и дерево
    const auto nodeId = (std::string(32, '0') + suffix).substr(suffix.size()); // id узла — 16 байт hex
    cl::CloudSync c1(t1, r1, cloudHooksOf(*d1.s));
    cl::CloudSync c2(t2, r2, cloudHooksOf(*d2.s));
    c1.ensure(true);
    std::string root;
    try {
        root = c1.apply("root", json::array({json{{"op", "create"}, {"id", nodeId}, {"kind", "folder"}, {"name", "Документы"}}}));
    } catch (const std::exception &e) {
        check(false, "cloud: личный диск создан первой правкой", e.what());
    }
    check(!root.empty() && c1.rootId() == std::optional<std::string>(root), "cloud: личный диск создан первой правкой", root);
    check(c1.flush(root) && !c1.hasPending(root), "cloud: операция «папка» отправлена");
    {
        const auto tree = c1.stateJson(root);
        check(tree && tree->dump().find("Документы") != std::string::npos, "cloud: дерево диска содержит папку");
    }
    bool treeSeen = false;
    std::string c2status;
    for (int i = 0; i < 60 && !treeSeen; ++i) {
        (void)d2.s->stateSync(json(), {}); // запись о диске — в журнале личного состояния
        c2.onEngineEvent(root);
        c2.ensure(true);
        c2.syncNow(true);
        c2.tick();
        c2status = c2.status();
        const auto list = c2.containers();
        const auto tree = c2.stateJson(root);
        for (const auto &info : list) {
            treeSeen = treeSeen || (info.id == root && info.kind == "root" && info.hasKey && tree
                                    && tree->dump().find("Документы") != std::string::npos);
        }
        if (!treeSeen) {
            c2status += " [" + std::to_string(list.size()) + (list.empty() ? "" : " " + list[0].kind + (list[0].hasKey ? " key" : " nokey")) + "]";
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }
    }
    check(treeSeen, "cloud: второе устройство видит личный диск (ключ от своего устройства) и папку в дереве",
          c2status.substr(c2status.size() > 120 ? c2status.size() - 120 : 0));
    check(d2.inbox.waitSession([](const json &e) { return e.value("type", std::string()) == "plannerChanged"; }, 1000)
              && d2.inbox.waitSession([](const json &e) { return e.value("type", std::string()) == "cloudChanged"; }, 1000),
          "domains: хосту второго устройства пришли события plannerChanged и cloudChanged");

    d1.s->stop();
    d2.s->stop();
}

// M31 (FED-1): письмо и ответ между пользователями двух серверов — свой gateway у каждого, запрос к объекту
// чужого сервера идёт своему серверу с `dest_domain`, жетоны незнакомцу — от сервера адресата.
static void federationScenario(const std::string &tcpA, const std::string &tcpB, const std::string &domainB,
                               const std::string &dir, const std::string &suffix) {
    std::printf("-- федерация (M31, FED-1): %s ↔ %s\n", "local", domainB.c_str());
    Peer fa, fb;
    fa.user = "v2fa" + suffix + "@local";
    fb.user = "v2fb" + suffix + "@" + domainB;
    try {
        fa.token = issue(tcpA, fa.user, "fa-" + suffix);
        fb.token = issue(tcpB, fb.user, "fb-" + suffix);
    } catch (const std::exception &e) {
        check(false, "M31: JWT на двух серверах", e.what());
        return;
    }
    fa.start(tcpA, dir + "/fa");
    fb.start(tcpB, dir + "/fb");
    check(fa.s->waitReady(30000) && fb.s->waitReady(30000), "M31: сессии на двух серверах готовы");
    check(fa.s->serverDomain() == "local" && fb.s->serverDomain() == domainB, "M31: домены серверов из описателей",
          fa.s->serverDomain() + " / " + fb.s->serverDomain());
    check(fa.s->isV2Peer(fb.user), "M31: журнал устройств собеседника с чужого сервера прочитан (dest_domain)");
    try {
        fa.s->sendContent(fb.user, *v2::toV2(parvane::textContent("fed-a-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "M31: письмо на чужой сервер отправлено", e.what());
    }
    check(textArrived(fb.inbox, "fed-a-" + suffix, fa.user, nullptr, 40000), "M31: письмо дошло через федерацию (незнакомцу, по жетону его сервера)");
    try {
        fb.s->sendContent(fa.user, *v2::toV2(parvane::textContent("fed-b-" + suffix)), v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "M31: ответ отправлен", e.what());
    }
    check(textArrived(fa.inbox, "fed-b-" + suffix, fb.user, nullptr, 40000), "M31: ответ дошёл через федерацию");
    check(fa.s->sendTyping(fb.user), "M31: «печатает» собеседнику чужого сервера взято на v2");
    fa.s->stop();
    fb.s->stop();
}

int main() {
    const auto tcp = env("PARVANE_GATEWAY_TCP", "127.0.0.1:9223");
    const auto ws = env("PARVANE_V2_WS_URL", "");
    std::printf("=== parvane-core v2 session tests (gateway TCP %s%s) ===\n", tcp.c_str(),
                ws.empty() ? "" : (", WS " + ws).c_str());

    char tmpl[] = "/tmp/parvane-v2-test-XXXXXX";
    const char *base = mkdtemp(tmpl);
    if (!base) {
        std::printf("mkdtemp не удался\n");
        return 2;
    }
    const std::string dir = base;
    const auto suffix = std::to_string(::getpid()) + std::to_string(std::time(nullptr) % 100000);

    Peer alice, bob;
    alice.user = "v2da" + suffix + "@local";
    bob.user = "v2db" + suffix + "@local";
    try {
        alice.token = issue(tcp, alice.user, "da-" + suffix);
        bob.token = issue(tcp, bob.user, "db-" + suffix);
    } catch (const std::exception &e) {
        std::printf("стек недоступен (%s) — нужен nats+identity+messenger+gateway\n", e.what());
        return 2;
    }
    check(!alice.token.empty() && !bob.token.empty(), "JWT с claim dev выданы");

    alice.start(tcp, dir + "/alice");
    bob.start(tcp, dir + "/bob");
    check(alice.s->waitReady(30000), "alice: v2-сессия готова (Hello/Welcome/Auth/устройство/подписка)");
    check(bob.s->waitReady(30000), "bob: v2-сессия готова");

    check(alice.s->isV2Peer(bob.user), "alice видит журнал bob → v2-собеседник (D-13)");
    check(!alice.s->isV2Peer("nobody" + suffix + "@local"), "без журнала → не v2 (идти по v1)");
    check(!alice.s->isV2Peer(alice.user), "self → не v2-собеседник");

    // Текст в обе стороны.
    const auto u1 = v2::newUuidV7();
    try {
        alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("v2-hello-" + suffix)), u1);
        check(true, "alice → bob: отправлено (sealed через ANON)");
    } catch (const std::exception &e) {
        check(false, "alice → bob: отправлено", e.what());
    }
    std::string gotId;
    check(textArrived(bob.inbox, "v2-hello-" + suffix, alice.user, &gotId), "bob получил текст alice");
    check(gotId == u1, "id сообщения = op_id отправителя", gotId);

    const auto u2 = v2::newUuidV7();
    try {
        bob.s->sendContent(alice.user, *v2::toV2(parvane::textContent("v2-answer-" + suffix), u1), u2);
    } catch (const std::exception &e) {
        check(false, "bob → alice: отправлено", e.what());
    }
    check(alice.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Message && x.content.value("text", "") == "v2-answer-" + suffix
            && x.replyTo == u1;
    }), "alice получила ответ bob (reply_to сохранён)");

    // Мутации: правка, реакция, прочтение.
    try {
        alice.s->sendContent(bob.user, json{{"edit", {{"target", v2::ref(u1)}, {"text", {{"text", "v2-edited"}}}}}}, "");
        bob.s->sendContent(alice.user, json{{"reaction", {{"target", v2::ref(u1)}, {"emoji", "👍"}}}}, "");
        bob.s->sendContent(alice.user, json{{"receipt", {{"kind", "RECEIPT_KIND_READ"}, {"messages", json::array({v2::ref(u1)})}}}}, "");
    } catch (const std::exception &e) {
        check(false, "мутации отправлены", e.what());
    }
    check(bob.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Edit && x.targets.size() == 1 && x.targets[0] == u1
            && x.content.value("text", "") == "v2-edited";
    }), "bob получил правку");
    check(alice.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Reaction && x.emoji == "👍" && x.targets[0] == u1;
    }), "alice получила реакцию");
    check(alice.inbox.wait([&](const v2::Incoming &x) {
        return x.kind == v2::Incoming::Kind::Read && !x.targets.empty() && x.targets[0] == u1;
    }), "alice получила квитанцию прочтения");

    // T131 (FR-062, D-08): блоб вложения без гранта получателю — по секрету
    // capability; получатель качает анонимным каналом.
    {
        std::string blob;
        for (int i = 0; i < 5000; ++i) blob.push_back(static_cast<char>((i * 31 + 7) & 0xFF));
        const std::string capability(32, '\x5A');
        std::string fileId;
        try {
            fileId = alice.s->uploadBlob(blob, capability, 1024); // 5 чанков
        } catch (const std::exception &e) {
            check(false, "T131: блоб загружен по v2", e.what());
        }
        check(!fileId.empty(), "T131: блоб загружен по v2 (ID-канал, без получателей)", fileId);
        std::string got;
        try {
            got = bob.s->downloadBlobCap(fileId, capability);
        } catch (const std::exception &e) {
            check(false, "T131: скачивание по capability", e.what());
        }
        check(got == blob, "T131: получатель скачал блоб по секрету анонимным каналом (5 чанков)",
              std::to_string(got.size()));
        bool refused = false;
        try {
            (void)bob.s->downloadBlobCap(fileId, std::string(32, '\x11'));
        } catch (const std::exception &) {
            refused = true;
        }
        check(refused, "T131: чужой секрет — отказ");
        const auto mapped = v2::toV2(json{{"kind", "photo"}, {"file_id", fileId}, {"mime", "image/png"},
                                          {"file_key", "a2V5"}, {"file_nonce", "bm9uY2U="}, {"capability", "Y2Fw"}});
        check(mapped && mapped->dump().find("\"capability\":\"Y2Fw\"") != std::string::npos,
              "T131: capability едет в содержимом v2 (Media.capability)");
    }

    // T127: «печатает» в личном чате — эфемерным каналом v2 (без {from, to}).
    check(alice.s->sendTyping(bob.user), "T127: «печатает» v2-собеседнику взято на v2");
    check(bob.inbox.waitSession([&](const json &e) {
        return e.value("type", std::string()) == "typing" && e.value("chat", std::string()) == alice.user
            && e.value("from", std::string()) == alice.user;
    }, 5000), "T127: bob получил «печатает» alice по каналу чата");
    check(!alice.s->sendTyping("nobody" + suffix + "@local"), "T127: собеседник не на v2 — «печатает» идёт по v1");

    groupScenario(tcp, dir, suffix, alice, bob);
    groupCallKeyScenario(tcp, dir, suffix);

    // spec 025: режим L2 — записи уходят тактами (5 ± 2 с), пустые такты — пустышки себе, кадры одной длины
    try {
        alice.s->setDirectL2(bob.user, true, v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "L2: включён в личном чате", e.what());
    }
    check(!alice.s->presenceAllowed(), "L2: присутствие не публикуется, пока режим включён");
    {
        const auto started = std::chrono::steady_clock::now();
        try {
            alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("l2-tick-" + suffix)), v2::newUuidV7());
        } catch (const std::exception &e) {
            check(false, "L2: отправка тактом", e.what());
        }
        const auto waited = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
        check(waited >= 2500, "L2: запись ждала такта (" + std::to_string(waited) + " мс)");
        check(textArrived(bob.inbox, "l2-tick-" + suffix, alice.user, nullptr, 30000), "L2: сообщение тактом дошло");
    }
    try {
        alice.s->setDirectL2(bob.user, false, v2::newUuidV7());
    } catch (const std::exception &e) {
        check(false, "L2: выключен", e.what());
    }
    check(alice.s->presenceAllowed(), "L2: режим выключен — присутствие снова публикуется");

    // FR-040: приватность — на сервере; устройство при запуске читает её.
    check(bob.s->setPrivacy(true, true), "FR-040: приватность сохранена на сервере");
    check(bob.inbox.waitSession([](const json &e) { return e.value("type", std::string()) == "privacySaved"; }, 5000),
          "FR-040: правка подтверждена событием privacySaved");

    // Офлайн: bob гаснет, alice пишет, bob поднимается из сохранённого состояния.
    bob.s->stop();
    bob.s.reset();
    const auto u3 = v2::newUuidV7();
    try {
        alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("v2-offline-" + suffix)), u3);
    } catch (const std::exception &e) {
        check(false, "alice → офлайн bob: отправлено", e.what());
    }
    {
        std::lock_guard<std::mutex> lk(bob.inbox.mu);
        bob.inbox.got.clear();
    }
    // ID-01 (стек с PARVANE_REQUIRE_DEVICE_PROOF=1): устройство уже в журнале — пароль без доказательства
    // ключа сессию не даёт, с доказательством по сохранённому состоянию — даёт (так входит desktop)
    {
        std::string noProof, err;
        try {
            noProof = issue(tcp, bob.user, "db-" + suffix);
        } catch (const std::exception &e) {
            err = e.what();
        }
        check(noProof.empty(), "ID-01: вход привязанного устройства без доказательства отклонён", err);
        std::string withProof;
        try {
            withProof = issue(tcp, bob.user, "db-" + suffix, dir + "/bob");
        } catch (const std::exception &e) {
            err = e.what();
        }
        check(!withProof.empty(), "ID-01: вход с доказательством ключа устройства", err);
        if (!withProof.empty()) bob.token = withProof;
        check(v2::Session::deviceIdFor(dir + "/bob") == "db-" + suffix, "id устройства — из сохранённого состояния");
    }
    bob.start(tcp, dir + "/bob");
    check(bob.s->waitReady(30000), "bob: сессия поднята из сохранённого состояния");
    check(bob.inbox.waitSession([](const json &e) {
        return e.value("type", std::string()) == "privacy" && e.value("groupAddNobody", false)
            && e.value("strangersAllowed", false);
    }, 10000), "FR-040: после перезапуска приватность прочитана с сервера (событие privacy)");
    check(bob.s->setPrivacy(false, true), "FR-040: приватность возвращена");
    check(textArrived(bob.inbox, "v2-offline-" + suffix, alice.user), "bob догнал сообщение, отправленное офлайн (sync)");
    {
        std::lock_guard<std::mutex> lk(bob.inbox.mu);
        bool dup = false;
        for (const auto &x : bob.inbox.got) {
            if (x.kind == v2::Incoming::Kind::Message && x.id == u1) dup = true;
        }
        check(!dup, "уже подтверждённое сообщение после рестарта не пришло повторно (курсор/ack)");
    }

    // WebSocket (двоичные кадры) — тот же протокол другим транспортом.
    if (!ws.empty()) {
        Peer carol;
        carol.user = "v2dc" + suffix + "@local";
        try {
            carol.token = issue(ws, carol.user, "dc-" + suffix);
        } catch (const std::exception &e) {
            std::printf("    v1 по WS: %s\n", e.what());
        }
        check(!carol.token.empty(), "вход по WebSocket (двоичные кадры v2)");
        carol.start(ws, dir + "/carol");
        check(carol.s->waitReady(30000), "carol: v2-сессия по WebSocket готова");
        const auto u4 = v2::newUuidV7();
        try {
            carol.s->sendContent(alice.user, *v2::toV2(parvane::textContent("v2-ws-" + suffix)), u4);
        } catch (const std::exception &e) {
            check(false, "carol (WS) → alice (TCP): отправлено", e.what());
        }
        check(textArrived(alice.inbox, "v2-ws-" + suffix, carol.user), "alice (TCP) получила от carol (WS)");
        try {
            alice.s->sendContent(carol.user, *v2::toV2(parvane::textContent("v2-tcp-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "alice → carol: отправлено", e.what());
        }
        check(textArrived(carol.inbox, "v2-tcp-" + suffix, alice.user), "carol (WS) получила от alice");
        carol.s->stop();
    }

    // Журнал состояния переживает рестарт: после перезапуска — с сервера.
    alice.s->stop();
    alice.s.reset();
    alice.start(tcp, dir + "/alice");
    check(alice.s->waitReady(30000), "alice: сессия поднята заново");
    {
        const auto snap = alice.s->stateAttach(json::object());
        check(snap.is_object() && snap.dump().find("Дом") != std::string::npos,
              "T098: журнал состояния прочитан с сервера после рестарта");
    }

    // T128 (FR-066; D-11, D-12, D-16): отзыв своего устройства. alice2
    // привязана грантом; alice отзывает её: запись журнала, новый ключ доступа,
    // новый ключ личного состояния (журнал переносится под него), SSK меняется
    // корнем (alice — первое устройство, корень лежит у неё).
    {
        Peer alice2;
        alice2.user = alice.user;
        const auto device2 = "da2-" + suffix;
        try {
            alice2.token = issue(tcp, alice.user, device2);
        } catch (const std::exception &e) {
            check(false, "alice2: JWT", e.what());
        }
        alice2.start(tcp, dir + "/alice2");
        check(!alice2.s->waitReady(8000) && alice2.s->needsLinking(), "T128: второе устройство ждёт линковку");
        alice2.s->joinWithGrant(alice.s->linkGrantMaterial());
        check(alice2.s->waitReady(30000), "T128: второе устройство привязано грантом");
        try {
            bob.s->sendContent(alice.user, *v2::toV2(parvane::textContent("v2-two-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "bob → alice (два устройства): отправлено", e.what());
        }
        // Журнал alice у bob обновляется по TTL кэша (15 с) — новое устройство
        // он может ещё не знать; первое устройство получает в любом случае.
        check(textArrived(alice.inbox, "v2-two-" + suffix, bob.user), "T128: alice получила до отзыва");

        bool revoked = false;
        try {
            revoked = alice.s->revokeDevice(device2);
        } catch (const std::exception &e) {
            check(false, "T128: отзыв устройства", e.what());
        }
        check(revoked, "T128: устройство отозвано (запись журнала + ротации)");
        check(!alice.s->revokeDevice("no-such-" + suffix), "T128: устройство не из журнала v2 — false");
        const auto ssk = alice.s->sskState();
        check(ssk.value("hasRoot", false) && !ssk.value("rotationNeeded", true),
              "T128: SSK сменён корнем сразу (корень на первом устройстве)", ssk.dump());
        check(alice.inbox.waitSession([](const json &e) { return e.value("type", std::string()) == "stateReady"; }, 3000),
              "T128: ключ личного состояния сменён — хосту stateReady");
        {
            const auto snap = alice.s->stateAttach(json::object());
            check(snap.is_object() && snap.dump().find("Дом") != std::string::npos,
                  "T128: журнал состояния перенесён под новый ключ (папка на месте)");
        }
        // bob перечитывает журнал alice (TTL 15 с): отзыв, новый SSK, сертификаты.
        std::this_thread::sleep_for(std::chrono::seconds(16));
        try {
            bob.s->sendContent(alice.user, *v2::toV2(parvane::textContent("v2-after-revoke-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "bob → alice после отзыва: отправлено", e.what());
        }
        check(textArrived(alice.inbox, "v2-after-revoke-" + suffix, bob.user), "T128: живое устройство получает после отзыва");
        check(!textArrived(alice2.inbox, "v2-after-revoke-" + suffix, bob.user, nullptr, 4000),
              "T128: отозванное устройство новое сообщение не получило");
        try {
            alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("v2-new-ssk-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "alice → bob после смены SSK: отправлено", e.what());
        }
        check(textArrived(bob.inbox, "v2-new-ssk-" + suffix, alice.user), "T128: bob принимает alice с новым SSK");
        alice2.s->stop();
    }

    // T129/T130 (FR-019/FR-066): новое устройство без других устройств —
    // вход по ключу восстановления (копия корня на сервере), затем сброс
    // личности; bob замечает смену корня (KEY-1 v2) и продолжает переписку.
    {
        Peer r1;
        r1.user = "v2dr" + suffix + "@local";
        r1.withRecoveryKey = true;
        try {
            r1.token = issue(tcp, r1.user, "dr1-" + suffix);
        } catch (const std::exception &e) {
            check(false, "r1: JWT", e.what());
        }
        r1.start(tcp, dir + "/r1");
        check(r1.s->waitReady(30000) && !r1.recoveryKey.empty(), "T130: первое устройство — ключ восстановления выдан");
        try {
            bob.s->sendContent(r1.user, *v2::toV2(parvane::textContent("rc-hello-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "bob → r1: отправлено", e.what());
        }
        check(textArrived(r1.inbox, "rc-hello-" + suffix, bob.user), "T130: r1 получил до потери");
        std::this_thread::sleep_for(std::chrono::seconds(2)); // копия корня уходит на сервер после готовности
        r1.s->stop();
        r1.s.reset();

        // Устройство потеряно. Новое: ключ восстановления.
        Peer r2;
        r2.user = r1.user;
        r2.withRecoveryKey = true;
        try {
            r2.token = issue(tcp, r2.user, "dr2-" + suffix);
        } catch (const std::exception &e) {
            check(false, "r2: JWT", e.what());
        }
        r2.start(tcp, dir + "/r2");
        check(!r2.s->waitReady(8000) && r2.s->needsLinking(), "T130: новое устройство ждёт линковку");
        check(r2.s->recoverWithKey("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA") == "bad_key",
              "T130: неверный ключ восстановления отклонён");
        const auto recovered = r2.s->recoverWithKey(r1.recoveryKey);
        check(recovered == "ok", "T130: вход по ключу восстановления", recovered);
        check(r2.s->waitReady(30000) && r2.recoveryKey.empty(), "T130: устройство в журнале, новый корень не создан");
        const auto devices = r2.s->ownDevices();
        check(devices.size() == 1 && devices[0] == "dr2-" + suffix, "T130: прежнее устройство отозвано — в журнале одно");
        std::this_thread::sleep_for(std::chrono::seconds(16)); // bob перечитывает журнал
        // Хост перед отправкой спрашивает isV2Peer — он и перечитывает журнал.
        check(bob.s->isV2Peer(r2.user), "T130: bob перечитал журнал собеседника");
        try {
            bob.s->sendContent(r2.user, *v2::toV2(parvane::textContent("rc-recovered-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "bob → r2 после восстановления: отправлено", e.what());
        }
        check(textArrived(r2.inbox, "rc-recovered-" + suffix, bob.user),
              "T130: bob пишет восстановленному устройству (ключ доступа сменился — жетон)");
        check(!bob.inbox.waitSession([&](const json &e) {
            return e.value("type", std::string()) == "peerRootChanged" && e.value("user", std::string()) == r2.user;
        }, 500), "T130: восстановление — не смена корня (KEY-1 не показан)");
        r2.s->stop();
        r2.s.reset();

        // И это устройство потеряно, ключа восстановления нет: сброс личности.
        Peer r3;
        r3.user = r1.user;
        try {
            r3.token = issue(tcp, r3.user, "dr3-" + suffix);
        } catch (const std::exception &e) {
            check(false, "r3: JWT", e.what());
        }
        r3.start(tcp, dir + "/r3");
        check(!r3.s->waitReady(8000) && r3.s->needsLinking(), "T130: третье устройство ждёт линковку");
        check(r3.s->resetIdentity("wrong-password") == "bad_password", "T130: сброс личности без пароля отклонён");
        const auto reset = r3.s->resetIdentity(kTestPassword);
        check(reset == "ok", "T130: личность сброшена (новый корень и журнал)", reset);
        check(r3.s->waitReady(30000), "T130: устройство поднято на новой личности");
        std::this_thread::sleep_for(std::chrono::seconds(16));
        check(bob.s->isV2Peer(r3.user), "T129: bob перечитал журнал собеседника после сброса");
        try {
            bob.s->sendContent(r3.user, *v2::toV2(parvane::textContent("rc-reset-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "bob → r3 после сброса: отправлено", e.what());
        }
        check(bob.inbox.waitSession([&](const json &e) {
            return e.value("type", std::string()) == "peerRootChanged" && e.value("user", std::string()) == r3.user;
        }, 5000), "T129: bob заметил смену корня собеседника (KEY-1 v2)");
        check(textArrived(r3.inbox, "rc-reset-" + suffix, bob.user), "T129: сообщение после смены корня доставлено");
        r3.s->stop();
    }

    // T133 (FR-033): отзыв доступа у одного собеседника — блокировка сама ключ
    // доступа к доставке не отнимает.
    {
        check(bob.s->setPrivacy(false, false), "T133: bob запретил сообщения от незнакомых");
        bool revoked = false;
        try {
            revoked = bob.s->revokeContactAccess(alice.user);
        } catch (const std::exception &e) {
            check(false, "T133: отзыв доступа", e.what());
        }
        check(revoked, "T133: bob отозвал доступ alice (новый ключ доступа на сервере)");
        check(alice.s->isV2Peer(bob.user), "T133: alice по-прежнему видит bob на v2");
        bool refused = false;
        try {
            alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("t133-blocked-" + suffix)), "");
        } catch (const std::exception &) {
            refused = true;
        }
        check(refused, "T133: прежний ключ не принят, незнакомым закрыто — отправка alice отклонена");
        check(!textArrived(bob.inbox, "t133-blocked-" + suffix, alice.user, nullptr, 4000),
              "T133: сообщение заблокированной до bob не дошло");
        check(bob.s->setPrivacy(false, true), "T133: bob снова принимает незнакомых");
        try {
            alice.s->sendContent(bob.user, *v2::toV2(parvane::textContent("t133-stranger-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "T133: alice → bob как незнакомая", e.what());
        }
        check(textArrived(bob.inbox, "t133-stranger-" + suffix, alice.user),
              "T133: без ключа доступа alice пишет только как незнакомая (жетон)");
        bool again = true;
        try {
            again = bob.s->revokeContactAccess(alice.user);
        } catch (const std::exception &) {
        }
        check(!again, "T133: повторный отзыв — ключа у собеседника уже нет");
    }

    // spec 029: жизненный цикл аккаунта (как web controller.ts) — копия ключей аккаунта и вход по ключу
    // восстановления с сохранением прежних устройств (spec 015), выход и «украдено» (ENG-04), выход без смены
    // ключей, смена ника (spec 026) и удаление аккаунта (spec 027).
    {
        Peer k1;
        k1.user = "v2dk" + suffix + "@local";
        k1.withRecoveryKey = true;
        k1.token = issue(tcp, k1.user, "dk1-" + suffix);
        k1.start(tcp, dir + "/k1");
        check(k1.s->waitReady(30000) && !k1.recoveryKey.empty(),
              "spec 015: сервер без Telegram-бота — ключ восстановления показан окном");
        // Копия ключей аккаунта уходит на сервер через 8 с после готовности
        json bundle;
        for (int i = 0; i < 30 && !bundle.is_object(); ++i) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            bundle = k1.s->fetchKeyBundle();
        }
        check(bundle.is_object() && bundle.contains("grant"), "spec 015: копия ключей аккаунта на сервере (PVKB)");

        // Новое устройство входит по ключу восстановления из копии — прежние устройства остаются
        Peer k2;
        k2.user = k1.user;
        k2.token = issue(tcp, k2.user, "dk2-" + suffix);
        k2.start(tcp, dir + "/k2");
        check(!k2.s->waitReady(8000) && k2.s->needsLinking(), "spec 015: новое устройство ждёт привязку");
        const auto tg = k2.s->requestTelegramKey(false);
        check(tg == "no_telegram" || tg == "failed", "spec 015: без Telegram — запрос ключа через бота не уходит", tg);
        const auto joined = k2.s->joinWithRecoveryKey("Ключ: " + k1.recoveryKey + " — сохраните", false);
        check(joined.result == "ok", "spec 015: вход по ключу восстановления (ключ выделен из текста)", joined.result);
        check(k2.s->waitReady(30000), "spec 015: устройство в журнале");
        {
            const auto devices = k1.s->ownDevices();
            check(devices.size() >= 1 && std::find(devices.begin(), devices.end(), "dk1-" + suffix) != devices.end(),
                  "spec 015: прежнее устройство осталось в журнале");
        }

        // Выход самим устройством и отметка «украдено»
        k2.s->leave();
        bool gone = false;
        for (int i = 0; i < 20 && !gone; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            k1.s->pollOwnDevices();
            const auto left = k1.s->leftSskHolders();
            gone = std::find(left.begin(), left.end(), "dk2-" + suffix) != left.end();
        }
        check(gone, "ENG-04: вышедшее само устройство с SSK — в списке вышедших");
        k2.s->stop();
        bool stolen = false;
        try {
            stolen = k1.s->reportDeviceStolen("dk2-" + suffix);
        } catch (const std::exception &e) {
            check(false, "ENG-04: отметка «украдено»", e.what());
        }
        check(stolen, "ENG-04: вышедшее устройство отмечено украденным");
        check(k1.s->sskState().value("rotationNeeded", false), "ENG-04: SSK раскрыт — нужна смена");
        check(k1.s->rotateSsk(k1.recoveryKey) == "ok", "ENG-04: SSK сменён ключом восстановления");

        // Выход другого устройства без смены ключей
        Peer k3;
        k3.user = k1.user;
        k3.token = issue(tcp, k3.user, "dk3-" + suffix);
        k3.start(tcp, dir + "/k3");
        check(!k3.s->waitReady(8000) && k3.s->needsLinking(), "третье устройство ждёт привязку");
        k3.s->joinWithGrant(k1.s->linkGrantMaterial());
        check(k3.s->waitReady(30000), "третье устройство привязано грантом");
        bool signedOut = false;
        try {
            signedOut = k1.s->signOutDevice("dk3-" + suffix);
        } catch (const std::exception &e) {
            check(false, "выход другого устройства", e.what());
        }
        const auto after = k1.s->ownDevices();
        check(signedOut && std::find(after.begin(), after.end(), "dk3-" + suffix) == after.end(),
              "выход другого устройства без смены ключей — его нет в журнале");
        check(!k1.s->sskState().value("rotationNeeded", false), "выход по просьбе владельца SSK не раскрывает");
        k3.s->stop();

        // Смена ника: bob знает k1 по переписке, после смены видит переезд чата
        try {
            k1.s->sendContent(bob.user, *v2::toV2(parvane::textContent("pre-rename-" + suffix)), "");
        } catch (const std::exception &e) {
            check(false, "k1 → bob до смены ника", e.what());
        }
        check(textArrived(bob.inbox, "pre-rename-" + suffix, k1.user), "bob знает k1 до смены ника");
        const auto nick = "v2dkr" + suffix;
        check(k1.s->renameAccount(nick, "wrong-password-1", k1.recoveryKey).value("result", std::string()) == "bad_password",
              "spec 026: неверный пароль — отказ");
        const auto renamed = k1.s->renameAccount(nick, kTestPassword, k1.recoveryKey);
        check(renamed.value("result", std::string()) == "ok", "spec 026: ник сменён", renamed.dump());
        const auto newAddress = renamed.value("address", std::string());
        k1.s->stop();
        if (!newAddress.empty()) {
            k1.s.reset();
            // Устройство поднимается под новым адресом: вход новым ником с доказательством ключа
            k1.user = newAddress;
            try {
                k1.token = issue(tcp, newAddress, "dk1-" + suffix, dir + "/k1");
            } catch (const std::exception &e) {
                check(false, "spec 026: вход новым ником", e.what());
            }
            check(!k1.token.empty(), "spec 026: вход новым ником с доказательством ключа устройства");
            k1.start(tcp, dir + "/k1");
            check(k1.s->waitReady(30000), "spec 026: сессия под новым адресом");
            std::this_thread::sleep_for(std::chrono::seconds(16)); // bob перечитывает журнал по TTL
            (void)bob.s->isV2Peer("v2dk" + suffix + "@local");
            check(bob.inbox.waitSession([&](const json &e) {
                return e.value("type", std::string()) == "peerRenamed" && e.value("to", std::string()) == newAddress;
            }, 10000), "spec 026: bob видит смену ника собеседника (событие peerRenamed)");

            // Удаление аккаунта: вход в период ожидания — без токена, с отменой удаления — с токеном
            check(k1.s->deleteAccount("wrong-password-1").value("result", std::string()) == "bad_password",
                  "spec 027: неверный пароль — отказ");
            const auto deleted = k1.s->deleteAccount(kTestPassword);
            check(deleted.value("result", std::string()) == "ok" && deleted.value("deletionAtMs", 0LL) > 0,
                  "spec 027: аккаунт поставлен на удаление", deleted.dump());
            k1.s->stop();
            std::this_thread::sleep_for(std::chrono::seconds(3)); // сессии аккаунта сервер закрывает сам
            {
                const auto ts = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::system_clock::now().time_since_epoch()).count();
                json req{{"login", newAddress}, {"password", kTestPassword}, {"device_id", "dk1-" + suffix}};
                if (const auto proof = v2::Session::sessionProofFor(dir + "/k1", ts); proof.is_object()) {
                    req["device_proof"] = proof["proof"];
                    req["proof_ts_ms"] = std::to_string(ts);
                }
                json pending;
                try {
                    pending = v2::preauth(tcp, "identity.session.issue", req);
                } catch (const std::exception &e) {
                    check(false, "spec 027: вход в период ожидания", e.what());
                }
                const auto *at = v2::field(pending, "deletionAtMs", "deletion_at_ms");
                check(pending.value("token", std::string()).empty() && at && !at->is_null(),
                      "spec 027: вход в период ожидания — без токена, со сроком удаления", pending.dump());
                req["cancel_deletion"] = true;
                json restored;
                try {
                    restored = v2::preauth(tcp, "identity.session.issue", req);
                } catch (const std::exception &e) {
                    check(false, "spec 027: вход с отменой удаления", e.what());
                }
                check(!restored.value("token", std::string()).empty(), "spec 027: вход с отменой удаления — аккаунт восстановлен");
            }
        }
    }

    contentAndCallScenario(tcp, dir, suffix, alice, bob);
    identityScenario(tcp, env("PARVANE_V2_UPGRADE_TCP", ""), suffix, alice, bob);
    devicesStateAndDomainsScenario(tcp, dir, suffix, bob);
    if (const auto fed = env("PARVANE_V2_FED_TCP", ""); !fed.empty()) {
        federationScenario(tcp, fed, env("PARVANE_V2_FED_DOMAIN", "fed.parvane.test"), dir, suffix);
    } else {
        std::printf("  skip  M31: федерация (нет PARVANE_V2_FED_TCP — шард federation не собран)\n");
    }

    // NAT-07: stop() сессии, пока поток разделов грузит блоб (uploadBlob идёт без мьютекса движка) —
    // соединение ID не разрушается под запросом: загрузка завершается ошибкой, не падением.
    {
        std::printf("-- NAT-07: stop() во время uploadBlob с другого потока\n");
        Peer dora;
        dora.user = "v2dna" + suffix + "@local";
        try {
            dora.token = issue(tcp, dora.user, "dna-" + suffix);
        } catch (const std::exception &e) {
            check(false, "NAT-07: вход dora", e.what());
        }
        dora.start(tcp, dir + "/dora");
        const bool ready = dora.s->waitReady(30000);
        check(ready, "NAT-07: сессия dora готова");
        if (ready) {
            std::string blob(64 * 1024, '\0');
            for (std::size_t i = 0; i < blob.size(); ++i) blob[i] = static_cast<char>((i * 13 + 5) & 0xFF);
            const std::string capability(32, '\x3C');
            std::atomic<int> uploaded{0};
            std::atomic<int> failed{0};
            std::atomic<bool> stopLoop{false};
            std::vector<std::thread> uploaders;
            for (int w = 0; w < 2; ++w) {
                uploaders.emplace_back([&] {
                    while (!stopLoop) {
                        try {
                            if (!dora.s->uploadBlob(blob, capability, 2048).empty()) ++uploaded;
                        } catch (const std::exception &) {
                            ++failed;
                            if (!dora.s->isReady()) break;
                        }
                    }
                });
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(700));
            dora.s->stop(); // прежде разрушал соединение ID под загрузкой (use-after-free)
            stopLoop = true;
            for (auto &t : uploaders) t.join();
            check(true, "NAT-07: stop() во время загрузки — без падения",
                  std::to_string(uploaded.load()) + " загружено, " + std::to_string(failed.load()) + " прервано");
            bool after = false;
            try {
                (void)dora.s->uploadBlob(blob, capability, 2048);
            } catch (const std::exception &) {
                after = true;
            }
            check(after, "NAT-07: после stop() загрузка отвечает ошибкой, а не обращается к закрытому соединению");
        }
    }

    // NAT-16 (как web T197): выход с устройства — запись журнала своим ключом с ограниченным сроком;
    // собеседник после перечитывания журнала этого устройства больше не видит.
    {
        std::printf("-- NAT-16: выход устройства из журнала (leave с лимитом)\n");
        Peer lea;
        lea.user = "v2dle" + suffix + "@local";
        const auto leaDevice = "dle-" + suffix;
        try {
            lea.token = issue(tcp, lea.user, leaDevice);
        } catch (const std::exception &e) {
            check(false, "NAT-16: вход lea", e.what());
        }
        lea.start(tcp, dir + "/lea");
        const bool ready = lea.s->waitReady(30000);
        check(ready, "NAT-16: сессия lea готова");
        if (ready) {
            const auto devicesOf = [&] {
                bob.s->refreshPeerLog(lea.user);
                const auto log = bob.s->engineCall("logDevices", json{{"user", lea.user}});
                return log.value("v2", json::array());
            };
            const auto before = devicesOf();
            check(std::find(before.begin(), before.end(), json(leaDevice)) != before.end(),
                  "NAT-16: до выхода устройство lea в журнале", before.dump());
            const auto started = std::chrono::steady_clock::now();
            const bool left = lea.s->leave(5000);
            const auto tookMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    std::chrono::steady_clock::now() - started).count();
            check(left, "NAT-16: leave(5000) — запись выхода принята");
            check(tookMs < 6500, "NAT-16: leave уложился в лимит", std::to_string(tookMs) + " мс");
            json after = before;
            for (int i = 0; i < 10; ++i) {
                after = devicesOf();
                if (std::find(after.begin(), after.end(), json(leaDevice)) == after.end()) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(300));
            }
            check(std::find(after.begin(), after.end(), json(leaDevice)) == after.end(),
                  "NAT-16: после выхода собеседник устройства lea в журнале не видит", after.dump());
            lea.s->stop();
            check(!lea.s->leave(5000), "NAT-16: leave остановленной сессии — false сразу");
        }
    }

    alice.s->stop();
    bob.s->stop();
    std::string rm = "rm -rf '" + dir + "'";
    (void)std::system(rm.c_str());
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
