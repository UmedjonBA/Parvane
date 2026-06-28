// Parvane fork: см. parvane_client.h.
#include "parvane/parvane_client.h"

#include "base/debug_log.h"

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

} // namespace Parvane
