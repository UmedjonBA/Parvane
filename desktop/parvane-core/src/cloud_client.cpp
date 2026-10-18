// Parvane fork: реализация CloudClient (см. cloud_client.h).
#include "parvane/cloud_client.h"
#include "parvane/v2_bridge.h"
#include "parvane/v2_link.h"

#include <algorithm>
#include <stdexcept>

namespace parvane {

std::string CloudClient::upload(const std::string &from, const std::string &token,
                                const std::string &filename, const std::string &mime,
                                const std::string &bytes,
                                const std::vector<std::string> &recipients,
                                bool publicAccess, std::size_t chunkSize, int timeoutMs) {
    (void)filename;
    (void)mime;
    (void)chunkSize;
    (void)timeoutMs;
    auto *bridge = dynamic_cast<v2::BridgeTransport *>(&_t);
    if (!bridge) throw std::runtime_error("cloud: нет моста v2");
    const bool onlyOwner = std::all_of(recipients.begin(), recipients.end(),
                                       [&](const std::string &r) { return r == from; });
    if (!onlyOwner) throw std::runtime_error("cloud: грантов получателям в v2 нет — вложения идут по capability");
    try {
        return bridge->control(token).uploadBlob(bytes, publicAccess);
    } catch (const v2::V2Error &e) {
        throw std::runtime_error("cloud: загрузка по v2 отвергнута: " + e.code());
    }
}

CloudClient::Downloaded CloudClient::download(const std::string &from, const std::string &token,
                                              const std::string &fileId, int timeoutMs) {
    (void)from;
    (void)timeoutMs;
    Downloaded out;
    auto *bridge = dynamic_cast<v2::BridgeTransport *>(&_t);
    if (!bridge) {
        out.error = "cloud: нет моста v2";
        return out;
    }
    try {
        out.bytes = bridge->control(token).downloadBlob(fileId);
        out.ok = true;
    } catch (const std::exception &e) {
        out.error = e.what();
    }
    return out;
}

} // namespace parvane
