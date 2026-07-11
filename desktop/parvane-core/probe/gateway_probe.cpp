// Parvane fork: живой e2e gateway (Фаза 0). Проверяет, что:
//  1) регистрация+логин+auth через gateway работают;
//  2) ИЗОЛЯЦИЯ: bob НЕ может слушать инбокс alice (gateway отвергает подписку),
//     а alice свой delivered-ack получает.
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
    // Регистрация (идемпотентно: если занято — просто логинимся). Pre-auth ок.
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
        GatewayTransport alice, bob;
        alice.connect(host, port);
        bob.connect(host, port);

        const auto aliceToken = tokenFor(alice, "alice@local", "pw-alice");
        const auto bobToken = tokenFor(bob, "bob@local", "pw-bob");
        alice.authenticate(aliceToken);
        bob.authenticate(bobToken);
        std::cout << "[ok] register+login+auth alice & bob\n";

        std::atomic<bool> aliceGotOwn{false};
        std::atomic<bool> bobGotAliceInbox{false};

        // alice слушает СВОЙ инбокс (легально).
        alice.subscribe("msg.user.alice@local",
                        [&](std::string, std::string) { aliceGotOwn = true; });
        // bob (злоумышленник) пытается слушать инбокс alice — gateway обязан
        // отвергнуть подписку; даже если messenger туда что-то шлёт, bob не увидит.
        bob.subscribe("msg.user.alice@local",
                      [&](std::string, std::string) { bobGotAliceInbox = true; });

        std::this_thread::sleep_for(std::chrono::milliseconds(200));

        // alice шлёт сообщение bob → messenger публикует delivered-ack в
        // msg.user.alice@local (инбокс отправителя).
        json ev = {
            {"id", "00000000-0000-7000-8000-000000000abc"},
            {"from", "alice@local"},
            {"ts", 1},
            {"token", aliceToken},
            {"payload",
             {{"to", "bob@local"},
              {"content", {{"kind", "text"}, {"text", "изоляция?"}}},
              {"reply_to", nullptr}}},
        };
        alice.publish("msg.chat.send", ev.dump());

        std::this_thread::sleep_for(std::chrono::milliseconds(700));

        bool pass = true;
        if (!aliceGotOwn) {
            std::cout << "[FAIL] alice не получила delivered на свой инбокс\n";
            pass = false;
        } else {
            std::cout << "[ok] alice получила delivered на свой инбокс\n";
        }
        if (bobGotAliceInbox) {
            std::cout << "[FAIL] bob ПРОЧИТАЛ чужой инбокс — изоляция сломана!\n";
            pass = false;
        } else {
            std::cout << "[ok] bob НЕ получил чужой инбокс (изоляция держится)\n";
        }

        alice.close();
        bob.close();
        std::cout << (pass ? "PASS\n" : "FAIL\n");
        return pass ? 0 : 1;
    } catch (const std::exception &e) {
        std::cout << "[FAIL] исключение: " << e.what() << "\n";
        return 2;
    }
}
