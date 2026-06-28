// Parvane fork: подробные тесты транспорта parvane-core против ЖИВОГО бэкенда
// (NATS + identity + messenger на временных БД — поднимает scripts/run_all_tests.sh).
// Покрывает: соединение, ошибки соединения, issue/verify (вкл. неверные креды и
// мусорный токен), таймаут request, pub/sub round-trip, и полный путь
// send→sync через шард messenger (envelope ParvaneEvent<T>).
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <thread>

#include "parvane/events.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

using parvane::json;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(),
                info.empty() ? "" : (" — " + info).c_str());
}

static std::string env(const char *n, const std::string &d) {
    const char *v = std::getenv(n);
    return (v && *v) ? std::string(v) : d;
}

static std::int64_t now() {
    return std::chrono::duration_cast<std::chrono::seconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// Простой (не крипто) UUID-v4 для id события — messenger парсит как Uuid.
static std::string uuid4() {
    static std::mt19937_64 rng(std::random_device{}());
    std::uniform_int_distribution<int> hex(0, 15);
    const char *h = "0123456789abcdef";
    std::string s = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    for (auto &c : s) {
        if (c == 'x') c = h[hex(rng)];
        else if (c == 'y') c = h[(hex(rng) & 0x3) | 0x8];
    }
    return s;
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    std::printf("=== parvane-core transport tests (NATS %s) ===\n", url.c_str());

    // 1. connect к несуществующему серверу → TransportError.
    {
        parvane::Transport bad;
        bool threw = false;
        try {
            bad.connect("nats://127.0.0.1:14223");
        } catch (const parvane::TransportError &) {
            threw = true;
        }
        check(threw, "connect к мёртвому порту бросает TransportError");
    }

    parvane::Transport tr;
    try {
        tr.connect(url);
    } catch (const std::exception &e) {
        check(false, "connect к live NATS", e.what());
        std::printf("РЕЗУЛЬТАТ: НЕТ соединения, тесты прерваны\n");
        return 1;
    }
    check(tr.connected(), "connect + connected()==true");

    // 2. request на тему без ответчика с коротким таймаутом → бросает.
    {
        bool threw = false;
        try {
            tr.request("parvane.tests.no_responder", "{}", 400);
        } catch (const parvane::TransportError &) {
            threw = true;
        }
        check(threw, "request без ответчика бросает (no-responders/timeout)");
    }

    // 3. pub/sub round-trip (чистый NATS, без шардов).
    {
        const std::string subj = "parvane.tests.echo." + uuid4();
        std::string got;
        tr.subscribe(subj, [&](std::string, std::string payload) { got = payload; });
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        tr.publish(subj, "пинг");
        for (int i = 0; i < 50 && got.empty(); ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        check(got == "пинг", "publish→subscribe доставляет payload", got);
    }

    // 4. identity.token.issue — валидные креды.
    std::string jwtAlice;
    {
        parvane::IssueRequest req{"alice@local", "test"};
        auto resp = parvane::IssueResponse::fromJson(
            json::parse(tr.request(parvane::topics::IdentityIssue, req.toJson().dump())));
        check(resp.ok && resp.token.has_value(), "issue(alice) ok+token",
              resp.token ? ("len=" + std::to_string(resp.token->size())) : "no token");
        if (resp.token) jwtAlice = *resp.token;
    }

    // 5. identity.token.verify — валидный токен возвращает user.
    {
        parvane::VerifyRequest req{jwtAlice};
        auto resp = parvane::VerifyResponse::fromJson(
            json::parse(tr.request(parvane::topics::IdentityVerify, req.toJson().dump())));
        check(resp.ok && resp.user.value_or("") == "alice@local",
              "verify(jwt) → user=alice@local", resp.user.value_or("<none>"));
    }

    // 6. verify мусорного токена → ok=false (а не исключение/краш шарда).
    {
        parvane::VerifyRequest req{"not.a.jwt"};
        auto resp = parvane::VerifyResponse::fromJson(
            json::parse(tr.request(parvane::topics::IdentityVerify, req.toJson().dump())));
        check(!resp.ok, "verify(мусор) → ok=false");
    }

    // 7. issue с (предположительно) неверным паролем для НОВОГО юзера: первый
    //    issue регистрирует; поэтому проверяем повтор с другим паролем → ok=false.
    {
        const std::string u = "carol_" + uuid4().substr(0, 8) + "@local";
        parvane::IssueRequest first{u, "pw-correct"};
        auto r1 = parvane::IssueResponse::fromJson(
            json::parse(tr.request(parvane::topics::IdentityIssue, first.toJson().dump())));
        check(r1.ok, "issue(новый carol) регистрирует");
        parvane::IssueRequest wrong{u, "pw-WRONG"};
        auto r2 = parvane::IssueResponse::fromJson(
            json::parse(tr.request(parvane::topics::IdentityIssue, wrong.toJson().dump())));
        check(!r2.ok, "issue(carol, неверный пароль) → ok=false");
    }

    // 8. Полный путь messenger: send (полный envelope) → sync → сообщение видно.
    {
        std::string jwtBob;
        {
            parvane::IssueRequest req{"bob@local", "test"};
            auto resp = parvane::IssueResponse::fromJson(json::parse(
                tr.request(parvane::topics::IdentityIssue, req.toJson().dump())));
            jwtBob = resp.token.value_or("");
        }
        const std::string mid = uuid4();
        const std::string text = "из C++ теста " + uuid4().substr(0, 8);
        json sendPayload = {{"to", "bob@local"},
                            {"content", {{"kind", "text"}, {"text", text}}}};
        json sendEv = parvane::makeEvent(mid, "alice@local", now(), jwtAlice, sendPayload);
        tr.publish(parvane::topics::MsgSend, sendEv.dump());
        std::this_thread::sleep_for(std::chrono::milliseconds(400));

        json syncPayload = {{"last_seen_id", "00000000-0000-0000-0000-000000000000"},
                            {"since_updated", 0}};
        json syncEv = parvane::makeEvent(uuid4(), "bob@local", now(), jwtBob, syncPayload);
        auto raw = tr.request(parvane::topics::MsgSyncRequest, syncEv.dump(), 3000);
        auto resp = json::parse(raw);
        auto msgs = resp.value("payload", json::object()).value("messages", json::array());
        bool found = false;
        for (auto &m : msgs)
            if (m.value("id", "") == mid) found = true;
        check(found, "send→sync: отправленное сообщение присутствует",
              "msgs=" + std::to_string(msgs.size()) + " id=" + mid.substr(0, 8));
    }

    std::printf("\nИТОГО: %d/%d прошло\n", g_total - g_fail, g_total);
    return g_fail == 0 ? 0 : 1;
}
