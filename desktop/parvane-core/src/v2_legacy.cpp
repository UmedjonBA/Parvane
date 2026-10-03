// Parvane fork: v1-устройства в переходный период v2 (см. v2_legacy.h).
#include "parvane/v2_legacy.h"

#include "parvane/e2e.h"
#include "parvane/messenger_client.h"
#include "parvane/v2_content.h"
#include "parvane/v2_session.h"

namespace parvane::v2 {

using json = nlohmann::json;

void publishLegacySet(Session &session, ITransport &t, const std::string &token) {
    if (!session.isReady()) return;
    const auto catalog = e2e::ownDeviceCatalog(t, token);
    if (catalog.empty()) return; // каталог недоступен — не сокращаем список вслепую
    session.syncLegacySet(catalog);
}

bool sendLegacyCopies(Session &session, ITransport &t, const std::string &token,
                      const std::string &to, const json &content, const std::string &id,
                      const std::optional<std::string> &replyTo) {
    if (!session.isReady() || isGroupAddress(to)) return false;
    const auto self = session.self();
    const auto peer = (to == self) ? e2e::DeviceFilter{} : session.legacyDevices(to);
    const auto own = session.legacyDevices(self);
    if (peer.empty() && own.empty()) return false;
    try {
        const auto sealed = e2e::sealLegacyCopies(to, content.dump(), t, token, peer, own);
        if (!sealed) return false;
        auto copies = json::array();
        std::size_t toPeer = 0;
        for (const auto &c : sealed->copies) {
            copies.push_back(c.toJson());
            if (!c.recipient.empty()) ++toPeer;
        }
        json payload = {
            {"to", to},
            {"content", sealed->content},
            {"copies", copies},
            // SEND-1: `send:<id>:<ciphertext>` — основной шифртекст пуст.
            {"signature", e2e::sign("send:" + id + ":")},
        };
        if (replyTo && !replyTo->empty()) payload["reply_to"] = *replyTo;
        session.deliverLegacy(id, payload);
        session.logLine("легаси-копии v1-устройствам: собеседника " + std::to_string(toPeer)
            + ", своим " + std::to_string(sealed->copies.size() - toPeer));
        return true;
    } catch (const std::exception &e) {
        session.logLine(std::string("легаси-копии не отправлены: ") + e.what());
        return false;
    }
}

bool editLegacyCopies(Session &session, ITransport &t, MessengerClient &m,
                      const std::string &token, const std::string &to, const json &content,
                      const std::string &id) {
    if (!session.isReady() || isGroupAddress(to)) return false;
    const auto self = session.self();
    const auto peer = (to == self) ? e2e::DeviceFilter{} : session.legacyDevices(to);
    const auto own = session.legacyDevices(self);
    if (peer.empty() && own.empty()) return false;
    try {
        const auto sealed = e2e::sealLegacyCopies(to, content.dump(), t, token, peer, own);
        if (!sealed) return false;
        auto copies = json::array();
        for (const auto &c : sealed->copies) copies.push_back(c.toJson());
        m.editContent(self, id, sealed->content, e2e::sign("edit:" + id + ":"), copies, token);
        session.logLine("правка v1-устройствам (" + std::to_string(sealed->copies.size()) + ")");
        return true;
    } catch (const std::exception &e) {
        session.logLine(std::string("правка v1-устройствам не отправлена: ") + e.what());
        return false;
    }
}

bool deleteLegacyCopies(Session &session, MessengerClient &m, const std::string &token,
                        const std::string &to, const std::string &id) {
    if (!session.isReady() || isGroupAddress(to)) return false;
    const auto self = session.self();
    if (session.legacyDevices(to).empty() && session.legacyDevices(self).empty()) return false;
    try {
        m.deleteMessage(self, id, token, e2e::sign("delete:" + id));
        session.logLine("удаление v1-устройствам");
        return true;
    } catch (const std::exception &e) {
        session.logLine(std::string("удаление v1-устройствам не отправлено: ") + e.what());
        return false;
    }
}

} // namespace parvane::v2
