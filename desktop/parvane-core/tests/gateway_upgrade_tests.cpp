// Parvane fork: переход на протокол v2 (E6, T110) на v1-транспорте — без
// стека: локальный TCP-сервер играет gateway в режимах PARVANE_V1_MODE.
//  - notice: после auth_ok приходит {"op":"notice","kind":"upgrade_available"}
//    → обработчик Available, соединение работает дальше;
//  - disabled: на первый кадр клиента — {"op":"err","error":"upgrade_required"},
//    сервер закрывает соединение → обработчик Required, вход и запросы до
//    входа отвергаются сразу (не по таймауту) с upgrade_required, повторные
//    запросы НЕ открывают новых соединений.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

#include "parvane/gateway_transport.h"

using parvane::GatewayError;
using parvane::GatewayTransport;
using Upgrade = parvane::GatewayTransport::Upgrade;

static int g_total = 0, g_fail = 0;

static void check(bool ok, const std::string &name, const std::string &info = "") {
    ++g_total;
    if (!ok) ++g_fail;
    std::printf("  %s  %s%s\n", ok ? "ok  " : "FAIL", name.c_str(), info.empty() ? "" : (" — " + info).c_str());
}

// Локальный «gateway»: слушает 127.0.0.1:<порт>, на каждое соединение —
// сценарий режима. Считает принятые соединения.
class FakeGateway {
public:
    explicit FakeGateway(bool disabled) : disabled_(disabled) {
        fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = 0;
        ::bind(fd_, reinterpret_cast<sockaddr *>(&a), sizeof(a));
        ::listen(fd_, 8);
        socklen_t len = sizeof(a);
        ::getsockname(fd_, reinterpret_cast<sockaddr *>(&a), &len);
        port_ = ntohs(a.sin_port);
        thread_ = std::thread([this] { loop(); });
    }
    ~FakeGateway() {
        stop_ = true;
        ::shutdown(fd_, SHUT_RDWR);
        ::close(fd_);
        if (thread_.joinable()) thread_.join();
    }
    [[nodiscard]] int port() const { return port_; }
    [[nodiscard]] int accepted() const { return accepted_; }

private:
    static void sendLine(int c, const std::string &s) {
        const auto line = s + "\n";
        (void)!::send(c, line.data(), line.size(), MSG_NOSIGNAL);
    }
    void loop() {
        while (!stop_) {
            const int c = ::accept(fd_, nullptr, nullptr);
            if (c < 0) return;
            ++accepted_;
            if (disabled_) {
                // Как настоящий gateway: протокол соединения узнаётся по первым
                // байтам клиента — ответ приходит на первый кадр.
                char first[1024];
                (void)!::recv(c, first, sizeof(first), 0);
                sendLine(c, R"({"op":"err","error":"upgrade_required"})");
                ::shutdown(c, SHUT_RDWR);
                ::close(c);
                continue;
            }
            // notice: ждём кадр auth, отвечаем auth_ok + notice, затем эхо-ответы.
            std::string buf;
            char tmp[1024];
            bool authed = false;
            for (;;) {
                const auto n = ::recv(c, tmp, sizeof(tmp), 0);
                if (n <= 0) break;
                buf.append(tmp, static_cast<std::size_t>(n));
                std::size_t nl;
                while ((nl = buf.find('\n')) != std::string::npos) {
                    const auto line = buf.substr(0, nl);
                    buf.erase(0, nl + 1);
                    if (!authed && line.find("\"auth\"") != std::string::npos) {
                        authed = true;
                        sendLine(c, R"({"op":"auth_ok","user":"alice@local"})");
                        sendLine(c, R"({"op":"notice","kind":"upgrade_available"})");
                    } else if (line.find("\"req\"") != std::string::npos) {
                        const auto at = line.find("\"id\":\"");
                        const auto id = at == std::string::npos ? std::string() : line.substr(at + 6, line.find('"', at + 6) - at - 6);
                        sendLine(c, "{\"op\":\"reply\",\"id\":\"" + id + "\",\"payload\":\"pong\"}");
                    }
                }
            }
            ::close(c);
        }
    }

    bool disabled_;
    int fd_ = -1;
    int port_ = 0;
    std::atomic<bool> stop_{false};
    std::atomic<int> accepted_{0};
    std::thread thread_;
};

static bool waitFor(const std::atomic<int> &v, int want, int ms) {
    for (int i = 0; i < ms / 10; ++i) {
        if (v.load() >= want) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return v.load() >= want;
}

int main() {
    std::printf("=== parvane-core: кадры перехода на v2 (E6) ===\n");

    // ── разбор кадров ──────────────────────────────────────────────────────
    check(GatewayTransport::upgradeKindOf(R"({"op":"notice","kind":"upgrade_available"})") == Upgrade::Available,
          "notice upgrade_available → Available");
    check(GatewayTransport::upgradeKindOf(R"({"op":"err","error":"upgrade_required"})") == Upgrade::Required,
          "err upgrade_required без id → Required");
    check(GatewayTransport::upgradeKindOf(R"({"op":"err","id":"7","error":"upgrade_required"})") == Upgrade::None,
          "адресная ошибка запроса — не режим сервера");
    check(GatewayTransport::upgradeKindOf(R"({"op":"notice","kind":"maintenance"})") == Upgrade::None,
          "незнакомый notice игнорируется");
    check(GatewayTransport::upgradeKindOf(R"({"op":"err","error":"rate_limited"})") == Upgrade::None,
          "другая безадресная ошибка — не Required");
    check(GatewayTransport::upgradeKindOf(R"({"op":"msg","subject":"x","payload":"upgrade_required"})") == Upgrade::None,
          "содержимое сообщения не путается с кадром");
    check(GatewayTransport::upgradeKindOf("не json") == Upgrade::None && GatewayTransport::upgradeKindOf("[1]") == Upgrade::None
              && GatewayTransport::upgradeKindOf(R"({"op":5,"kind":"upgrade_available"})") == Upgrade::None,
          "мусор и кривые типы полей — None");

    std::atomic<int> available{0}, required{0};
    GatewayTransport::setUpgradeHandler([&](Upgrade u) {
        if (u == Upgrade::Available) ++available;
        if (u == Upgrade::Required) ++required;
    });

    // ── режим notice ───────────────────────────────────────────────────────
    {
        FakeGateway gw(false);
        GatewayTransport t;
        bool ok = false;
        try {
            t.connect("127.0.0.1", gw.port());
            t.authenticate("jwt");
            ok = true;
        } catch (const std::exception &e) {
            std::printf("    notice: %s\n", e.what());
        }
        check(ok, "notice: вход по v1 проходит");
        check(waitFor(available, 1, 2000) && required == 0, "notice: обработчик получил Available");
        check(!GatewayTransport::upgradeRequired(), "notice: флаг upgrade_required не стоит");
        std::string reply;
        try {
            reply = t.request("identity.server.info", "{}", 2000);
        } catch (const std::exception &e) {
            reply = e.what();
        }
        check(reply == "pong", "notice: v1-запросы работают дальше", reply);
        t.close();
    }

    // ── режим disabled ─────────────────────────────────────────────────────
    {
        FakeGateway gw(true);
        GatewayTransport t;
        std::string error;
        const auto started = std::chrono::steady_clock::now();
        try {
            t.connect("127.0.0.1", gw.port());
            t.authenticate("jwt", 5000);
        } catch (const std::exception &e) {
            error = e.what();
        }
        const auto tookMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
        check(error.find("upgrade_required") != std::string::npos, "disabled: вход отвергнут с upgrade_required", error);
        check(error.find("отказ авторизации") == std::string::npos,
              "disabled: это не «отказ авторизации» (клиент не должен разлогинивать)", error);
        check(tookMs < 3000, "disabled: отказ сразу, не по таймауту авторизации", std::to_string(tookMs) + " мс");
        check(waitFor(required, 1, 2000), "disabled: обработчик получил Required");
        check(GatewayTransport::upgradeRequired(), "disabled: флаг upgrade_required стоит");
        // Запрос до входа (логин/регистрация) на свежем соединении — тот же отказ.
        {
            FakeGateway gw2(true);
            GatewayTransport pre;
            std::string preError;
            const auto t0 = std::chrono::steady_clock::now();
            try {
                pre.connect("127.0.0.1", gw2.port());
                (void)pre.request("identity.token.issue", "{}", 5000);
            } catch (const std::exception &e) {
                preError = e.what();
            }
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
            check(preError.find("upgrade_required") != std::string::npos && ms < 3000,
                  "disabled: запрос до входа отвергнут с upgrade_required сразу", preError + ", " + std::to_string(ms) + " мс");
            pre.close();
        }
        // Повторные запросы не крутят переподключение: сервер видит одно соединение.
        int refused = 0;
        for (int i = 0; i < 5; ++i) {
            try {
                (void)t.request("identity.token.issue", "{}", 500);
            } catch (const GatewayError &e) {
                if (std::string(e.what()).find("upgrade_required") != std::string::npos) ++refused;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        check(refused >= 4, "disabled: запросы отвергаются с upgrade_required", std::to_string(refused));
        check(gw.accepted() <= 2, "disabled: нет цикла переподключений", "соединений " + std::to_string(gw.accepted()));
        t.close();
    }

    // ── оператор вернул v1: успешный вход снимает флаг ─────────────────────
    {
        FakeGateway gw(false);
        GatewayTransport t;
        try {
            t.connect("127.0.0.1", gw.port());
            t.authenticate("jwt");
        } catch (const std::exception &) {
        }
        check(!GatewayTransport::upgradeRequired(), "после успешного входа флаг upgrade_required снят");
        t.close();
    }

    GatewayTransport::setUpgradeHandler(nullptr);
    std::printf("=== %d/%d ok ===\n", g_total - g_fail, g_total);
    return g_fail ? 1 : 0;
}
