// Parvane fork: v2-сессия parvane-core против ЖИВОГО стека (spec 007, T064):
// nats + identity + messenger + gateway (TCP 9223 / WS 9222), поднимает
// scripts/run_all_tests.sh или desktop/verify_protocol_v2.sh.
//
// Покрытие: Hello/Welcome + проверка описателя сервера, Auth, создание
// устройства и журнала, маршрутизация по журналу собеседника (D-13), текст в
// обе стороны через анонимную доставку, правка/реакция/квитанция чтения,
// доставка офлайн-устройству и восстановление состояния из файла (import),
// то же по WebSocket (двоичные кадры) при PARVANE_V2_WS_URL.
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

#include "parvane/events.h"
#include "parvane/gateway_transport.h"
#include "parvane/gateway_ws_transport.h"
#include "parvane/messenger.h"
#include "parvane/topics.h"
#include "parvane/v2_content.h"
#include "parvane/v2_session.h"

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

// Регистрация + JWT с claim dev через v1-gateway (pre-auth issue/register).
// gw — host:port (TCP) или ws://… (v1 JSON текстовыми кадрами того же
// GatewayWsTransport, у которого есть двоичный режим v2 — v1 не сломан).
static std::string issue(const std::string &gw, const std::string &user, const std::string &device) {
    std::unique_ptr<parvane::GatewayTransport> tp;
    if (gw.rfind("ws://", 0) == 0) {
        auto ws = std::make_unique<parvane::GatewayWsTransport>();
        ws->connectUrl(gw);
        tp = std::move(ws);
    } else {
        tp = std::make_unique<parvane::GatewayTransport>();
        const auto colon = gw.rfind(':');
        tp->connect(gw.substr(0, colon), std::atoi(gw.c_str() + colon + 1));
    }
    auto &t = *tp;
    parvane::IssueRequest req{user, kTestPassword, device};
    try {
        t.request(parvane::topics::IdentityRegister, req.toJson().dump(), 5000);
    } catch (const std::exception &) {
    }
    const auto resp = parvane::IssueResponse::fromJson(
        json::parse(t.request(parvane::topics::IdentityIssue, req.toJson().dump(), 5000)));
    return resp.token.value_or("");
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
            || type == "ownDevicesAdded" || type == "stateReady") {
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

    void start(const std::string &url, const std::string &dir) {
        v2::SessionConfig cfg;
        cfg.gatewayUrl = url;
        cfg.self = user;
        cfg.token = [this] { return token; };
        cfg.stateDir = dir;
        cfg.clientVersion = "desktop-test";
        cfg.otkCount = 10;
        cfg.log = [u = user](const std::string &m) { std::printf("    [%s] %s\n", u.c_str(), m.c_str()); };
        cfg.onEvent = [this](const json &ev) { inbox.push(ev, user); };
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
    check(alice.s->revokeInvite(group, url) && alice.s->listInvites(group).empty(), "ссылка отозвана записью журнала");

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

    groupScenario(tcp, dir, suffix, alice, bob);

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
    bob.start(tcp, dir + "/bob");
    check(bob.s->waitReady(30000), "bob: сессия поднята из сохранённого состояния");
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
        check(!carol.token.empty(), "v1 JSON по WebSocket (текстовые кадры) работает рядом с двоичным режимом");
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

    alice.s->stop();
    bob.s->stop();
    std::string rm = "rm -rf '" + dir + "'";
    (void)std::system(rm.c_str());
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
