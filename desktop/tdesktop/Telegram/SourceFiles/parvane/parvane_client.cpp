// Parvane fork: см. parvane_client.h.
#include "parvane/parvane_client.h"

#include "base/debug_log.h"

#include <parvane/events.h>    // parvane-core
#include <parvane/topics.h>    // parvane-core
#include <parvane/transport.h> // parvane-core

#include <cstdlib>

namespace Parvane {

QString NatsUrl() {
    if (const char *v = std::getenv("PARVANE_NATS_URL"); v && *v) {
        return QString::fromUtf8(v);
    }
    return u"nats://127.0.0.1:4222"_q;
}

void LogStartup() {
    // Конструирование parvane::Transport заставляет линкер втянуть cnats —
    // это и есть проверка, что транспорт реально собрался в бинарь.
    parvane::Transport transport;
    LOG(("Parvane: transport linked, NATS target %1 (connected=%2)")
        .arg(NatsUrl())
        .arg(transport.connected() ? 1 : 0));
}

IssueResult Issue(const QString &user, const QString &password) {
    IssueResult out;
    try {
        parvane::Transport transport;
        transport.connect(NatsUrl().toStdString());

        parvane::IssueRequest req{user.toStdString(), password.toStdString()};
        const auto raw = transport.request(
            parvane::topics::IdentityIssue,
            req.toJson().dump(),
            5000);
        const auto resp = parvane::IssueResponse::fromJson(
            parvane::json::parse(raw));
        out.ok = resp.ok && resp.token.has_value();
        if (resp.token) {
            out.token = QString::fromStdString(*resp.token);
        }
        if (resp.error) {
            out.error = QString::fromStdString(*resp.error);
        }
        if (!out.ok && out.error.isEmpty()) {
            out.error = u"identity отклонил вход"_q;
        }
    } catch (const std::exception &e) {
        out.ok = false;
        out.error = QString::fromUtf8(e.what());
        LOG(("Parvane: Issue exception: %1").arg(out.error));
    }
    return out;
}

namespace {
QString g_token;
} // namespace

void SetToken(const QString &token) {
    g_token = token;
}

QString Token() {
    return g_token;
}

} // namespace Parvane
