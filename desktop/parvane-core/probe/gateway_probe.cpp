// Parvane fork: живой e2e gateway + доставка Фазы 1. Проверяет:
//  1) register+login+auth через gateway;
//  2) ДОСТАВКА: alice→bob, bob получает push в свой инбокс и шлёт ack,
//     отправитель alice получает delivered после ack;
//  3) ИЗОЛЯЦИЯ: carol НЕ может слушать инбокс bob (gateway отвергает подписку).
// Нужен запущенный стек: nats + identity + messenger + gateway (TCP).
// Использование: parvane_gateway_probe [host] [tcp_port]
#include "parvane/gateway_transport.h"

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>

using nlohmann::json;
using parvane::GatewayTransport;

static std::string tokenFor(GatewayTransport &t, const std::string &user,
                            const std::string &pass) {
    try {
        t.request("identity.user.register",
                  json{{"user", user}, {"password", pass}}.dump());
    } catch (const std::exception &) {
    }
    const auto raw = t.request("identity.token.issue",
                               json{{"user", user}, {"password", pass}}.dump());
    const auto resp = json::parse(raw);
    if (!resp.value("ok", false)) {
        throw std::runtime_error("login failed: " + resp.value("error", ""));
    }
    return resp.value("token", "");
}

int main(int argc, char **argv) {
    const std::string host = argc > 1 ? argv[1] : "127.0.0.1";
    const int port = argc > 2 ? std::stoi(argv[2]) : 9223;

    try {
        GatewayTransport alice, bob, carol;
        alice.connect(host, port);
        bob.connect(host, port);
        carol.connect(host, port);

        const auto aliceToken = tokenFor(alice, "alice@local", "pw-alice");
        const auto bobToken = tokenFor(bob, "bob@local", "pw-bob");
        const auto carolToken = tokenFor(carol, "carol@local", "pw-carol");
        alice.authenticate(aliceToken);
        bob.authenticate(bobToken);
        carol.authenticate(carolToken);
        std::cout << "[ok] register+login+auth alice, bob, carol\n";

        std::atomic<bool> bobGotMsg{false};
        std::atomic<bool> carolGotBobInbox{false};
        std::atomic<bool> aliceGotDelivered{false};

        // bob слушает СВОЙ инбокс: на входящее сообщение (InboxPush) шлёт ack.
        bob.subscribe("msg.user.bob@local", [&](std::string, std::string payload) {
            auto ev = json::parse(payload, nullptr, false);
            if (ev.is_discarded() || !ev.contains("payload")) return;
            const auto &p = ev["payload"];
            if (p.contains("message")) {
                bobGotMsg = true;
                const std::string mid = p["message"].value("id", "");
                json ack = {{"id", "00000000-0000-7000-8000-000000000ac0"},
                            {"from", "bob@local"}, {"ts", 1}, {"token", bobToken},
                            {"payload", {{"message_id", mid}}}};
                bob.publish("msg.chat.ack", ack.dump());
            }
        });

        // carol (злоумышленник) пытается слушать инбокс bob — gateway отвергнет.
        carol.subscribe("msg.user.bob@local",
                        [&](std::string, std::string) { carolGotBobInbox = true; });

        // alice слушает свой инбокс: ждёт delivered после ack bob'а.
        alice.subscribe("msg.user.alice@local", [&](std::string, std::string payload) {
            auto ev = json::parse(payload, nullptr, false);
            if (ev.is_discarded() || !ev.contains("payload")) return;
            if (ev["payload"].contains("message_id")) aliceGotDelivered = true;
        });

        std::this_thread::sleep_for(std::chrono::milliseconds(200));

        // alice → bob
        json ev = {
            {"id", "00000000-0000-7000-8000-000000000abc"},
            {"from", "alice@local"}, {"ts", 1}, {"token", aliceToken},
            {"payload", {{"to", "bob@local"},
                         {"content", {{"kind", "text"}, {"text", "привет из Фазы 1"}}},
                         {"reply_to", nullptr}}},
        };
        alice.publish("msg.chat.send", ev.dump());

        std::this_thread::sleep_for(std::chrono::milliseconds(900));

        bool pass = true;
        auto check = [&](bool cond, const char *okMsg, const char *failMsg) {
            std::cout << (cond ? "[ok] " : "[FAIL] ") << (cond ? okMsg : failMsg) << "\n";
            if (!cond) pass = false;
        };
        check(bobGotMsg, "bob получил сообщение в свой инбокс (push)",
              "bob НЕ получил сообщение");
        check(aliceGotDelivered, "alice получила delivered после ack bob'а",
              "alice НЕ получила delivered");
        check(!carolGotBobInbox, "carol НЕ прочитала чужой инбокс (изоляция держится)",
              "carol ПРОЧИТАЛА чужой инбокс — изоляция сломана!");

        alice.close();
        bob.close();
        carol.close();
        std::cout << (pass ? "PASS\n" : "FAIL\n");
        return pass ? 0 : 1;
    } catch (const std::exception &e) {
        std::cout << "[FAIL] исключение: " << e.what() << "\n";
        return 2;
    }
}
