// Parvane fork: обёртка C ABI движка v2 (см. v2_engine.h).
#include "parvane/v2_engine.h"

#include "parvane/crypto.h"
#include "parvane/engine_host.h"

#include <openssl/rand.h>
#include <parvane_protocol.h>

#include <algorithm>
#include <chrono>

namespace parvane::v2 {

namespace {

// Строка движка → std::string с освобождением.
std::string take(char *s) {
    if (!s) return {};
    std::string out(s);
    parvane_protocol_string_free(s);
    return out;
}

std::string takeBytes(PvBytes b) {
    std::string out;
    if (b.data && b.len) out.assign(reinterpret_cast<const char *>(b.data), b.len);
    parvane_protocol_bytes_free(b);
    return out;
}

// Бросить, если движок вернул ошибку через err.
void check(char *err) {
    if (err) throw EngineError(take(err));
}

const std::uint8_t *u8(const std::string &s) {
    return reinterpret_cast<const std::uint8_t *>(s.data());
}

json parseOrThrow(const std::string &text) {
    auto v = json::parse(text, nullptr, false);
    if (v.is_discarded()) throw EngineError(R"({"error":"Malformed"})");
    return v;
}

// Результат-строка движка: null при ошибке → EngineError.
std::string result(char *out, char *err) {
    if (err) {
        if (out) parvane_protocol_string_free(out);
        throw EngineError(take(err));
    }
    if (!out) throw EngineError(R"({"error":"Malformed"})");
    return take(out);
}

} // namespace

EngineError::EngineError(const std::string &raw)
: std::runtime_error(raw), details_(json::parse(raw, nullptr, false)) {
    if (details_.is_discarded() || !details_.is_object()) details_ = json::object();
}

bool EngineError::isNeed() const {
    return details_.contains("need") && details_["need"].is_object();
}

json EngineError::need() const {
    return isNeed() ? details_["need"] : json::object();
}

std::string EngineError::kind() const {
    if (isNeed()) return details_["need"].value("kind", std::string());
    if (details_.contains("error") && details_["error"].is_string()) {
        return details_["error"].get<std::string>();
    }
    return what();
}

std::string engineVersion() {
    const char *v = parvane_protocol_version();
    return v ? std::string(v) : std::string();
}

std::uint32_t protocolMajor() { return parvane_protocol_major(); }

std::string encodeHello(int channel, const std::string &clientKind, const std::string &clientVersion) {
    return takeBytes(pv_encode_hello(channel, clientKind.c_str(), clientVersion.c_str()));
}

std::string encodeAuth(const std::string &token) {
    return takeBytes(pv_encode_auth(token.c_str()));
}

std::string encodeRequest(std::uint64_t id, const std::string &method, const std::string &body,
                          std::uint32_t timeoutMs) {
    return takeBytes(pv_encode_request(id, method.c_str(), u8(body), body.size(), timeoutMs));
}

std::string encodeRequestTo(std::uint64_t id, const std::string &method, const std::string &body,
                            std::uint32_t timeoutMs, const std::string &dest, std::uint32_t padTo) {
    return takeBytes(pv_encode_request_to(id, method.c_str(), u8(body), body.size(), timeoutMs, dest.c_str(), padTo));
}

json engineCall(const std::string &name, const json &args) {
    char *err = nullptr;
    const auto a = args.dump();
    char *out = pv_call(name.c_str(), a.c_str(), &err);
    return parseOrThrow(result(out, err));
}


json decodeFrame(const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_decode_frame(u8(bytes), bytes.size(), &err);
    return parseOrThrow(result(out, err));
}

json verifyServerDescriptor(const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_verify_server_descriptor(u8(bytes), bytes.size(), &err);
    return parseOrThrow(result(out, err));
}

json splitSyncResponse(const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_split_sync_response(u8(bytes), bytes.size(), &err);
    return parseOrThrow(result(out, err));
}

std::string encodeMessage(const std::string &typeName, const json &value) {
    char *err = nullptr;
    const auto text = value.dump();
    auto b = pv_encode_message(typeName.c_str(), text.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

std::int64_t deviceLogEntries(const std::string &bytes) {
    char *err = nullptr;
    const auto n = pv_device_log_entries(u8(bytes), bytes.size(), &err);
    check(err);
    return n;
}

std::string fromBase64(const std::string &b64) {
    char *err = nullptr;
    auto b = pv_from_base64(b64.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

OutRequest parseRequest(const json &r) {
    OutRequest out;
    out.anon = r.value("chan", std::string()) == "anon";
    out.method = r.value("method", std::string());
    out.body = fromBase64(r.value("body", std::string()));
    out.dest = r.value("dest", std::string());
    return out;
}

std::string generateRecoveryKey() { return take(pv_generate_recovery_key()); }

std::string grantWithRootBackup(const std::string &material, const std::string &backup) {
    char *out = pv_grant_with_root_backup(material.c_str(), u8(backup), backup.size());
    return out ? take(out) : material;
}

std::string importRootBackupFor(const std::string &user, const std::string &blob, const std::string &recoveryKey) {
    char *err = nullptr;
    auto b = pv_import_root_backup_for(user.c_str(), u8(blob), blob.size(), recoveryKey.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

std::string grantRootBackup(const std::string &material) {
    return takeBytes(pv_grant_root_backup(material.c_str()));
}

json decodeMessage(const std::string &typeName, const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_decode_message(typeName.c_str(), u8(bytes), bytes.size(), &err);
    return parseOrThrow(result(out, err));
}

std::string encodeMethodRequest(const std::string &method, const json &request) {
    char *err = nullptr;
    const auto text = request.dump();
    auto b = pv_encode_method_request(method.c_str(), text.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

json decodeMethodResponse(const std::string &method, const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_decode_method_response(method.c_str(), u8(bytes), bytes.size(), &err);
    return parseOrThrow(result(out, err));
}

std::optional<json> parseInvite(const std::string &url) {
    char *err = nullptr;
    char *out = pv_parse_invite(url.c_str(), &err);
    if (err) {
        parvane_protocol_string_free(err);
        if (out) parvane_protocol_string_free(out);
        return std::nullopt;
    }
    auto v = json::parse(take(out), nullptr, false);
    if (v.is_discarded() || !v.is_object()) return std::nullopt;
    return v;
}

// ── клиент: ядро в модели движка (spec 035 T125) ───────────────────────────────

namespace {

std::int64_t wallMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

std::string randomKey32() {
    std::string key(32, '\0');
    if (RAND_bytes(reinterpret_cast<unsigned char *>(key.data()), 32) != 1) throw EngineError(R"({"error":"Internal"})");
    return key;
}

// Ответ `clientCall`/`historyCall` модели: `CallResult{result_json}` либо `{need}`/`{error}` (как прежняя обвязка).
json callResult(const json &out) {
    if (!out.is_object()) throw EngineError(R"({"error":"Malformed"})");
    if (out.contains("need") || out.contains("error")) throw EngineError(out.dump());
    const auto text = out.value("result_json", std::string("null"));
    return parseOrThrow(text.empty() ? std::string("null") : text);
}

std::string b64(const std::string &raw) { return crypto::b64encode(raw); }

// Байты результата (base64-строка); null — пусто.
std::string bytesOf(const json &v) {
    if (!v.is_string()) return {};
    return fromBase64(v.get<std::string>());
}

std::vector<std::string> stringsOf(const json &j) {
    std::vector<std::string> out;
    if (j.is_array()) {
        for (const auto &v : j) {
            if (v.is_string()) out.push_back(v.get<std::string>());
        }
    }
    return out;
}

std::uint64_t u64Of(const json &v) {
    if (v.is_number_unsigned()) return v.get<std::uint64_t>();
    if (v.is_number_integer()) return static_cast<std::uint64_t>(std::max<std::int64_t>(0, v.get<std::int64_t>()));
    if (v.is_string()) {
        try {
            return std::stoull(v.get<std::string>());
        } catch (...) {
        }
    }
    return 0;
}

json l2Idle() {
    return json{{"active", false}, {"mine", false}, {"enabledBy", json::array()}, {"pad", false},
                {"ephemeralAllowed", true}};
}

// Модель без профиля (хранилище в памяти) с клиентом пользователя `user` на устройстве `deviceId`.
std::shared_ptr<engine::Host> memoryHost(const std::string &user, const std::string &deviceId, const std::string &domain) {
    const json cfg{{"user", user},
                   {"device_id", deviceId},
                   {"domain", domain},
                   {"now_ms", std::to_string(wallMs())},
                   {"device_key", b64(randomKey32())},
                   {"host_driven", true}};
    std::string error;
    auto h = engine::Host::openMemory(cfg, &error);
    if (!h) throw EngineError(json{{"error", error.empty() ? std::string("Internal") : error}}.dump());
    return std::shared_ptr<engine::Host>(std::move(h));
}

} // namespace

Client::Client(std::shared_ptr<engine::Host> host) : host_(std::move(host)) {}

Client::~Client() = default;

std::unique_ptr<Client> Client::create(const std::string &user, const std::string &deviceId,
                                       const std::string &domain) {
    return std::make_unique<Client>(memoryHost(user, deviceId, domain));
}

std::unique_ptr<Client> Client::import(const std::string &blob, const std::string &key32) {
    auto c = std::make_unique<Client>(memoryHost("import@local", "import", "local"));
    c->replaceImport(blob, key32);
    return c;
}

void Client::replaceNew() {
    const auto out = host_->raw("clientReplace", json{{"mode", "new"}});
    if (out.is_object() && out.contains("error")) throw EngineError(out.dump());
}

void Client::replaceImport(const std::string &blob, const std::string &key32) {
    const auto out = host_->raw("clientReplace", json{{"mode", "import"}, {"blob", b64(blob)}, {"key", b64(key32)}});
    if (out.is_object() && out.contains("error")) throw EngineError(out.dump());
}

std::string Client::exportState(const std::string &key32) const {
    return bytesOf(call("export", json{{"key", b64(key32)}}));
}

json Client::call(const std::string &name, const json &args) const {
    const json a{{"name", name}, {"args_json", (args.is_null() ? json::object() : args).dump()}};
    return callResult(host_->raw("clientCall", a));
}

json Client::createIdentity(std::size_t otk) { return call("createIdentity", json{{"otkCount", otk}}); }

std::string Client::linkGrantMaterial() { return bytesOf(call("linkGrantMaterial")); }

json Client::joinWithGrant(const std::string &material, std::size_t otk) {
    return call("joinWithGrant", json{{"material", b64(material)}, {"otkCount", otk}});
}

json Client::syncRequest() { return call("syncRequest"); }

json Client::ackRequest() { return call("ackRequest"); }

std::string Client::ingestLog(const std::string &user, const std::string &resp) {
    const auto v = call("ingestLog", json{{"user", user}, {"syncResponse", b64(resp)}});
    return v.is_string() ? v.get<std::string>() : std::string();
}

std::size_t Client::ingestBundle(const std::string &user, const std::string &resp) {
    return static_cast<std::size_t>(u64Of(call("ingestBundle", json{{"user", user}, {"bundleResponse", b64(resp)}})));
}

json Client::tokenRequest(const std::string &keyList, const std::string &serverKey, std::size_t count) {
    return call("tokenRequest", json{{"keyListResponse", b64(keyList)}, {"serverKey", b64(serverKey)}, {"count", count}});
}

std::size_t Client::tokenResponse(const std::string &resp) {
    return static_cast<std::size_t>(u64Of(call("tokenResponse", json{{"resp", b64(resp)}})));
}

json Client::prepareCall(const std::string &peer, const json &signal) {
    return call("prepareCall", json{{"peer", peer}, {"signalJson", signal.dump()}});
}

json Client::prepareDirect(const std::string &peer, const json &content, const std::string &opId) {
    return call("prepareDirect", json{{"peer", peer}, {"contentJson", content.dump()}, {"opId", opId}});
}

json Client::openRecord(const std::string &record) {
    auto v = call("openRecord", json{{"record", b64(record)}});
    return v.is_array() ? v : json::array();
}

std::string Client::lastError() {
    try {
        const auto v = call("lastError");
        return v.is_string() ? v.get<std::string>() : std::string();
    } catch (const EngineError &) {
        return {};
    }
}

std::uint64_t Client::logVersion(const std::string &user) const {
    try {
        return u64Of(call("logVersion", json{{"user", user}}));
    } catch (const EngineError &) {
        return 0;
    }
}

std::string Client::exportRootBackup(const std::string &root32, const std::string &recoveryKey) const {
    json args{{"recoveryKey", recoveryKey}};
    if (!root32.empty()) args["rootSecret"] = b64(root32);
    return bytesOf(call("exportRootBackup", args));
}

std::string Client::importRootBackup(const std::string &blob, const std::string &recoveryKey) const {
    return bytesOf(call("importRootBackup", json{{"blob", b64(blob)}, {"recoveryKey", recoveryKey}}));
}

json Client::groupCreate(int kind, const std::string &name, const std::vector<std::string> &members,
                         const json &perms, const std::string &migratedFrom) {
    return call("groupCreate", json{{"kind", kind},
                                    {"name", name},
                                    {"members", members},
                                    {"permsJson", (perms.is_null() ? json::object() : perms).dump()},
                                    {"migratedFrom", migratedFrom}});
}

std::uint64_t Client::groupIngest(const std::string &domain, const std::string &groupHex, const std::string &resp) {
    return u64Of(call("groupIngest", json{{"domain", domain}, {"group", groupHex}, {"syncResponse", b64(resp)}}));
}

json Client::groupChange(const std::string &groupHex, const json &change) {
    return call("groupChange", json{{"group", groupHex}, {"changeJson", change.dump()}});
}

json Client::groupRequestDecide(const std::string &groupHex, const std::string &user, bool approve) {
    return call("groupRequestDecide", json{{"group", groupHex}, {"user", user}, {"approve", approve}});
}

json Client::groupRotateEpoch(const std::string &groupHex) { return call("groupRotateEpoch", json{{"group", groupHex}}); }

json Client::prepareGroup(const std::string &groupHex, const json &content, const std::string &opId) {
    return call("prepareGroup", json{{"group", groupHex}, {"contentJson", content.dump()}, {"opId", opId}});
}

json Client::drainReady() {
    auto v = call("drainReady");
    return v.is_array() ? v : json::array();
}

std::uint64_t Client::groupVersion(const std::string &groupHex) const {
    try {
        return u64Of(call("groupVersion", json{{"group", groupHex}}));
    } catch (const EngineError &) {
        return 0;
    }
}

std::int64_t Client::groupBehind(const std::string &groupHex) const {
    try {
        const auto v = call("groupBehind", json{{"group", groupHex}});
        if (v.is_null()) return -1;
        return static_cast<std::int64_t>(u64Of(v));
    } catch (const EngineError &) {
        return -1;
    }
}

void Client::groupForget(const std::string &groupHex) {
    try {
        (void)call("groupForget", json{{"group", groupHex}});
    } catch (const EngineError &) {
    }
}

std::vector<std::string> Client::groupList() const {
    try {
        return stringsOf(call("groupList"));
    } catch (const EngineError &) {
        return {};
    }
}

std::optional<json> Client::groupInfo(const std::string &groupHex) const {
    try {
        auto v = call("groupInfo", json{{"group", groupHex}});
        if (!v.is_object()) return std::nullopt;
        return v;
    } catch (const EngineError &) {
        return std::nullopt;
    }
}

std::vector<std::string> Client::groupUnconfirmed(const std::string &groupHex, const std::vector<std::string> &claimed) const {
    try {
        return stringsOf(call("groupUnconfirmed", json{{"group", groupHex}, {"claimed", claimed}}));
    } catch (const EngineError &) {
        return {};
    }
}

json Client::groupInviteCreate(const std::string &groupHex, const std::string &title, std::int64_t expiresMs,
                               std::uint32_t usageLimit, bool requiresApproval) {
    return call("groupInviteCreate", json{{"group", groupHex},
                                          {"title", title},
                                          {"expiresMs", expiresMs},
                                          {"usageLimit", usageLimit},
                                          {"requiresApproval", requiresApproval}});
}

json Client::groupJoin(const std::string &url) { return call("groupJoin", json{{"url", url}}); }

json Client::groupSyncByLink(const std::string &url, const std::string &domain, const std::string &groupHex,
                             std::uint64_t afterVersion, std::int64_t tsMs) {
    return call("groupSyncByLink", json{{"url", url}, {"domain", domain}, {"group", groupHex},
                                        {"afterVersion", afterVersion}, {"tsMs", tsMs}});
}

json Client::groupSetPhoto(const std::string &groupHex, const std::string &fileId, const std::string &avatarDomain,
                           const std::string &keyB64) {
    return call("groupSetPhoto", json{{"group", groupHex}, {"fileId", fileId}, {"avatarDomain", avatarDomain}, {"keyB64", keyB64}});
}

json Client::groupPhotoFollowups(const std::string &groupHex, const std::vector<std::string> &links) {
    auto content = call("groupAvatarKeyContent", json{{"group", groupHex}});
    if (content.is_string()) content = json::parse(content.get<std::string>(), nullptr, false);
    const auto wraps = call("groupInviteAvatarWraps", json{{"group", groupHex}, {"linksJson", json(links).dump()}});
    return json{{"content", content.is_object() ? content : json()}, {"requests", wraps.is_array() ? wraps : json::array()}};
}

json Client::logDevices(const std::string &user) const {
    try {
        auto v = call("logDevices", json{{"user", user}});
        if (v.is_object()) return v;
    } catch (const EngineError &) {
    }
    return json{{"v2", json::array()}, {"legacy", json::array()}};
}

json Client::readers(const std::string &opId) const {
    auto v = call("readers", json{{"id", opId}});
    return v.is_array() ? v : json::array();
}

bool Client::hasPeerDeliveryKey(const std::string &peer) const {
    try {
        return call("hasPeerDeliveryKey", json{{"peer", peer}}).get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

bool Client::deliveryKeyRejected(const std::string &peer) {
    try {
        return call("deliveryKeyRejected", json{{"peer", peer}}).get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

bool Client::acceptRootChange(const std::string &user) {
    const auto v = call("acceptRootChange", json{{"user", user}});
    return v.is_boolean() && v.get<bool>();
}

json Client::recoverWithRoot(const std::string &root32, const std::string &logResp, std::size_t otk) {
    return call("recoverWithRoot", json{{"rootSecret", b64(root32)}, {"logResponse", b64(logResp)}, {"otkCount", otk}});
}

json Client::resetIdentity(std::size_t otk) { return call("resetIdentity", json{{"otkCount", otk}}); }

json Client::revokeDevice(const std::string &deviceId) { return call("revokeDevice", json{{"deviceId", deviceId}}); }

json Client::revokeContactAccess(const std::string &peer) { return call("revokeContactAccess", json{{"peer", peer}}); }

json Client::shareDeliveryKey(const std::string &peer) { return call("shareDeliveryKey", json{{"peer", peer}}); }

json Client::shareGroupsWithOwnDevices(const json &devices) {
    return call("shareGroupsWithOwnDevices", json{{"devicesJson", devices.is_array() ? devices : json::array()}});
}

json Client::rotateSsk(const std::string &root32) {
    json args = json::object();
    if (!root32.empty()) args["rootSecret"] = b64(root32);
    return call("rotateSsk", args);
}

bool Client::ownSskExposed() const {
    try {
        return call("ownSskExposed").get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

json Client::ephSubscribe(const json &chats) { return call("ephSubscribe", json{{"chatsJson", chats.dump()}}); }

void Client::ephReset() {
    try {
        (void)call("ephReset");
    } catch (const EngineError &) {
    }
}

json Client::ephTyping(const std::string &chat, int action) const {
    return call("ephTyping", json{{"chat", chat}, {"action", action}});
}

json Client::ephPresence(bool online, std::int64_t lastSeenMs) const {
    return call("ephPresence", json{{"online", online}, {"lastSeenMs", lastSeenMs}});
}

json Client::ephOpen(const std::string &body) const {
    try {
        auto v = call("ephOpen", json{{"body", b64(body)}});
        return v.is_array() ? v : json::array();
    } catch (const EngineError &) {
        return json::array();
    }
}

std::size_t Client::tokenCount() const {
    try {
        return static_cast<std::size_t>(u64Of(call("tokenCount")));
    } catch (const EngineError &) {
        return 0;
    }
}

bool Client::tokenRefillDue() const {
    try {
        return call("tokenRefillDue").get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

std::size_t Client::tokenBatchSize() const {
    try {
        return static_cast<std::size_t>(u64Of(call("tokenBatchSize")));
    } catch (const EngineError &) {
        return 0;
    }
}

// ── режим «усиленная приватность» (L2) ──────────────────────────────────────

json Client::l2SetDirect(const std::string &peer, bool enabled, const std::string &opId) {
    return call("l2SetDirect", json{{"peer", peer}, {"enabled", enabled}, {"opId", opId}});
}

json Client::l2Direct(const std::string &peer) const {
    try {
        auto v = call("l2Direct", json{{"peer", peer}});
        return v.is_object() ? v : l2Idle();
    } catch (const EngineError &) {
        return l2Idle();
    }
}

json Client::l2Group(const std::string &groupHex) const {
    try {
        auto v = call("l2Group", json{{"group", groupHex}});
        return v.is_object() ? v : l2Idle();
    } catch (const EngineError &) {
        return l2Idle();
    }
}

void Client::l2SetGroupPref(const std::string &groupHex, bool enabled) {
    try {
        (void)call("l2SetGroupPref", json{{"group", groupHex}, {"enabled", enabled}});
    } catch (const EngineError &) {
    }
}

json Client::l2ActiveChats() const {
    try {
        auto v = call("l2ActiveChats");
        if (v.is_object()) return v;
    } catch (const EngineError &) {
    }
    return json{{"direct", json::array()}, {"groups", json::array()}};
}

bool Client::presenceAllowed() const {
    try {
        return call("presenceAllowed").get<bool>();
    } catch (const std::exception &) {
        return true;
    }
}

bool Client::hasStateKey() const {
    try {
        return call("hasStateKey").get<bool>();
    } catch (const std::exception &) {
        return false;
    }
}

bool Client::ensureStateKey() {
    const auto v = call("ensureStateKey");
    return v.is_boolean() && v.get<bool>();
}

// ── журнал истории аккаунта (spec 033) — сессия модели ─────────────────────

std::unique_ptr<HistorySession> HistorySession::open(const Client &client) {
    if (!client.hasStateKey()) return nullptr;
    return std::unique_ptr<HistorySession>(new HistorySession(client.host()));
}

HistorySession::~HistorySession() = default;

json HistorySession::call(const std::string &name, const json &args) {
    const json a{{"name", name}, {"args_json", (args.is_null() ? json::object() : args).dump()}};
    return callResult(host_->raw("historyCall", a));
}


AnonPlanner::AnonPlanner() : p_(pv_anon_planner_new()) {}

AnonPlanner::~AnonPlanner() { pv_anon_planner_free(p_); }

AnonPlanner::Assignment AnonPlanner::assign(const std::string &method, const std::string &body,
                                            std::int64_t nowMs) {
    char *err = nullptr;
    char *out = pv_anon_planner_assign(p_, method.c_str(), u8(body), body.size(), nowMs, &err);
    const auto j = parseOrThrow(result(out, err));
    Assignment a;
    a.conn = j.value("conn", std::uint64_t(0));
    a.open = j.value("open", false);
    a.closeAfter = j.value("closeAfter", false);
    return a;
}

std::vector<std::uint64_t> AnonPlanner::expired(std::int64_t nowMs) {
    std::vector<std::uint64_t> out;
    const auto j = json::parse(take(pv_anon_planner_expired(p_, nowMs)), nullptr, false);
    if (j.is_array()) {
        for (const auto &v : j) {
            if (v.is_number_unsigned()) out.push_back(v.get<std::uint64_t>());
        }
    }
    return out;
}

void AnonPlanner::closed(std::uint64_t conn) { pv_anon_planner_closed(p_, conn); }

std::size_t AnonPlanner::openCount() const { return pv_anon_planner_open_count(p_); }

} // namespace parvane::v2
