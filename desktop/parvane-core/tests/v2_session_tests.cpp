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
            || type == "ownDevicesAdded" || type == "stateReady" || type == "typing"
            || type == "peerRootChanged" || type == "needsLinking" || type == "privacy"
            || type == "privacySaved") {
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

    alice.s->stop();
    bob.s->stop();
    std::string rm = "rm -rf '" + dir + "'";
    (void)std::system(rm.c_str());
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
