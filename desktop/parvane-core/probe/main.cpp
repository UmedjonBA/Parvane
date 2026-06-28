// Parvane fork: standalone smoke для parvane-core. Де-риск транспорта до
// врезки в tdesktop — проверяет цепочку C++ → cnats → identity (issue+verify).
//
//   PARVANE_NATS_URL=nats://127.0.0.1:4222 \
//   PARVANE_USER=alice@local PARVANE_PASS=test ./parvane_probe
#include <cstdlib>
#include <iostream>
#include <string>

#include "parvane/events.h"
#include "parvane/topics.h"
#include "parvane/transport.h"

static std::string env(const char *name, const std::string &fallback) {
    const char *v = std::getenv(name);
    return (v && *v) ? std::string(v) : fallback;
}

int main() {
    const std::string url = env("PARVANE_NATS_URL", "nats://127.0.0.1:4222");
    const std::string user = env("PARVANE_USER", "alice@local");
    const std::string pass = env("PARVANE_PASS", "test");

    std::cout << "=== parvane-core probe ===\n";
    std::cout << "NATS: " << url << "  user: " << user << "\n";

    parvane::Transport tr;
    try {
        tr.connect(url);
        std::cout << "[1] connect ........ OK (connected=" << tr.connected()
                  << ")\n";

        // identity.token.issue — голый IssueRequest
        parvane::IssueRequest ireq{user, pass};
        auto raw = tr.request(parvane::topics::IdentityIssue,
                              ireq.toJson().dump());
        auto iresp = parvane::IssueResponse::fromJson(parvane::json::parse(raw));
        if (!iresp.ok || !iresp.token) {
            std::cout << "[2] issue .......... FAIL "
                      << (iresp.error ? *iresp.error : "no token") << "\n";
            return 1;
        }
        const std::string jwt = *iresp.token;
        std::cout << "[2] issue .......... OK (jwt len=" << jwt.size() << ")\n";

        // identity.token.verify — голый VerifyRequest
        parvane::VerifyRequest vreq{jwt};
        auto vraw = tr.request(parvane::topics::IdentityVerify,
                               vreq.toJson().dump());
        auto vresp = parvane::VerifyResponse::fromJson(parvane::json::parse(vraw));
        if (!vresp.ok || !vresp.user) {
            std::cout << "[3] verify ......... FAIL "
                      << (vresp.error ? *vresp.error : "not ok") << "\n";
            return 1;
        }
        std::cout << "[3] verify ......... OK (user=" << *vresp.user << ")\n";

        std::cout << "РЕЗУЛЬТАТ: OK\n";
        return 0;
    } catch (const std::exception &e) {
        std::cout << "ОШИБКА: " << e.what() << "\n";
        return 2;
    }
}
