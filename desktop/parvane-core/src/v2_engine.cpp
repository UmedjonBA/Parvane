// Parvane fork: обёртка C ABI движка v2 (см. v2_engine.h).
#include "parvane/v2_engine.h"

#include <parvane_protocol.h>

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

std::string encodePing(std::uint64_t nonce) { return takeBytes(pv_encode_ping(nonce)); }

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
    return out;
}

// ── клиент ──────────────────────────────────────────────────────────────────

Client::~Client() {
    if (c_) pv_client_free(c_);
}

std::unique_ptr<Client> Client::create(const std::string &user, const std::string &deviceId,
                                       const std::string &domain) {
    char *err = nullptr;
    auto *c = pv_client_new(user.c_str(), deviceId.c_str(), domain.c_str(), &err);
    check(err);
    if (!c) throw EngineError(R"({"error":"InvalidField"})");
    return std::unique_ptr<Client>(new Client(c));
}

std::unique_ptr<Client> Client::import(const std::string &blob, const std::string &key32) {
    char *err = nullptr;
    auto *c = pv_client_import(u8(blob), blob.size(), u8(key32), key32.size(), &err);
    check(err);
    if (!c) throw EngineError(R"({"error":"Malformed"})");
    return std::unique_ptr<Client>(new Client(c));
}

std::string Client::exportState(const std::string &key32) const {
    char *err = nullptr;
    auto b = pv_client_export(c_, u8(key32), key32.size(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

json Client::createIdentity(std::size_t otk) {
    char *err = nullptr;
    char *out = pv_client_create_identity(c_, otk, &err);
    return parseOrThrow(result(out, err));
}

std::string Client::linkGrantMaterial() {
    char *err = nullptr;
    char *out = pv_client_link_grant_material(c_, &err);
    return result(out, err);
}

json Client::joinWithGrant(const std::string &material, std::size_t otk) {
    char *err = nullptr;
    char *out = pv_client_join_with_grant(c_, material.c_str(), otk, &err);
    return parseOrThrow(result(out, err));
}

json Client::otkRequest(std::size_t n) {
    char *err = nullptr;
    char *out = pv_client_otk_request(c_, n, &err);
    return parseOrThrow(result(out, err));
}

json Client::syncRequest() {
    char *err = nullptr;
    char *out = pv_client_sync_request(c_, &err);
    return parseOrThrow(result(out, err));
}

json Client::ackRequest() {
    char *err = nullptr;
    char *out = pv_client_ack_request(c_, &err);
    return parseOrThrow(result(out, err));
}

std::string Client::ingestLog(const std::string &user, const std::string &resp) {
    char *err = nullptr;
    char *out = pv_client_ingest_log(c_, user.c_str(), u8(resp), resp.size(), &err);
    return result(out, err);
}

std::size_t Client::ingestBundle(const std::string &user, const std::string &resp) {
    char *err = nullptr;
    char *out = pv_client_ingest_bundle(c_, user.c_str(), u8(resp), resp.size(), &err);
    return static_cast<std::size_t>(std::stoull(result(out, err)));
}

json Client::tokenRequest(const std::string &keyList, const std::string &serverKey, std::size_t count) {
    char *err = nullptr;
    char *out = pv_client_token_request(c_, u8(keyList), keyList.size(), u8(serverKey),
                                        serverKey.size(), count, &err);
    return parseOrThrow(result(out, err));
}

std::size_t Client::tokenResponse(const std::string &resp) {
    char *err = nullptr;
    char *out = pv_client_token_response(c_, u8(resp), resp.size(), &err);
    return static_cast<std::size_t>(std::stoull(result(out, err)));
}

json Client::prepareDirect(const std::string &peer, const json &content, const std::string &opId) {
    char *err = nullptr;
    const auto text = content.dump();
    char *out = pv_client_prepare_direct(c_, peer.c_str(), text.c_str(),
                                         opId.empty() ? nullptr : opId.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::openRecord(const std::string &record) {
    char *err = nullptr;
    char *out = pv_client_open_record(c_, u8(record), record.size(), &err);
    return parseOrThrow(result(out, err));
}

std::string Client::lastError() {
    char *err = nullptr;
    char *out = pv_client_last_error(c_, &err);
    if (err) parvane_protocol_string_free(err);
    return take(out);
}

std::uint64_t Client::logVersion(const std::string &user) const {
    return pv_client_log_version(c_, user.c_str());
}

std::string Client::exportRootBackup(const std::string &root32, const std::string &recoveryKey) const {
    char *err = nullptr;
    auto b = pv_client_export_root_backup(c_, u8(root32), root32.size(), recoveryKey.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

std::string Client::importRootBackup(const std::string &blob, const std::string &recoveryKey) const {
    char *err = nullptr;
    auto b = pv_client_import_root_backup(c_, u8(blob), blob.size(), recoveryKey.c_str(), &err);
    if (err) {
        parvane_protocol_bytes_free(b);
        check(err);
    }
    return takeBytes(b);
}

std::string generateRecoveryKey() { return take(pv_generate_recovery_key()); }

json decodeMessage(const std::string &typeName, const std::string &bytes) {
    char *err = nullptr;
    char *out = pv_decode_message(typeName.c_str(), u8(bytes), bytes.size(), &err);
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

namespace {

std::vector<std::string> stringList(const json &j) {
    std::vector<std::string> out;
    if (j.is_array()) {
        for (const auto &v : j) {
            if (v.is_string()) out.push_back(v.get<std::string>());
        }
    }
    return out;
}

// JSON-массив base64 → байты тел.
std::vector<std::string> bodies(const std::string &text) {
    std::vector<std::string> out;
    for (const auto &b : stringList(parseOrThrow(text))) out.push_back(fromBase64(b));
    return out;
}

} // namespace

// ── группы ──────────────────────────────────────────────────────────────────

json Client::groupCreate(int kind, const std::string &name, const std::vector<std::string> &members,
                         const json &perms) {
    char *err = nullptr;
    const auto m = json(members).dump();
    const auto p = perms.dump();
    char *out = pv_client_group_create(c_, kind, name.c_str(), m.c_str(), p.c_str(), &err);
    return parseOrThrow(result(out, err));
}

std::uint64_t Client::groupIngest(const std::string &domain, const std::string &groupHex,
                                  const std::string &resp) {
    char *err = nullptr;
    char *out = pv_client_group_ingest(c_, domain.c_str(), groupHex.c_str(), u8(resp), resp.size(), &err);
    return static_cast<std::uint64_t>(std::stoull(result(out, err)));
}

json Client::groupChange(const std::string &groupHex, const json &change) {
    char *err = nullptr;
    const auto c = change.dump();
    char *out = pv_client_group_change(c_, groupHex.c_str(), c.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::groupRotateEpoch(const std::string &groupHex) {
    char *err = nullptr;
    char *out = pv_client_group_rotate_epoch(c_, groupHex.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::prepareGroup(const std::string &groupHex, const json &content, const std::string &opId) {
    char *err = nullptr;
    const auto text = content.dump();
    char *out = pv_client_prepare_group(c_, groupHex.c_str(), text.c_str(),
                                        opId.empty() ? nullptr : opId.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::drainReady() {
    char *err = nullptr;
    char *out = pv_client_drain_ready(c_, &err);
    return parseOrThrow(result(out, err));
}

std::uint64_t Client::groupVersion(const std::string &groupHex) const {
    return pv_client_group_version(c_, groupHex.c_str());
}

std::int64_t Client::groupBehind(const std::string &groupHex) const {
    return pv_client_group_behind(c_, groupHex.c_str());
}

void Client::groupForget(const std::string &groupHex) { pv_client_group_forget(c_, groupHex.c_str()); }

std::vector<std::string> Client::groupList() const {
    return stringList(json::parse(take(pv_client_group_list(c_)), nullptr, false));
}

std::optional<json> Client::groupInfo(const std::string &groupHex) const {
    char *err = nullptr;
    char *out = pv_client_group_info(c_, groupHex.c_str(), &err);
    if (err) {
        parvane_protocol_string_free(err);
        if (out) parvane_protocol_string_free(out);
        return std::nullopt;
    }
    auto v = json::parse(take(out), nullptr, false);
    if (v.is_discarded() || !v.is_object()) return std::nullopt;
    return v;
}

std::vector<std::string> Client::groupUnconfirmed(const std::string &groupHex,
                                                  const std::vector<std::string> &claimed) const {
    char *err = nullptr;
    const auto c = json(claimed).dump();
    char *out = pv_client_group_unconfirmed(c_, groupHex.c_str(), c.c_str(), &err);
    if (err) {
        parvane_protocol_string_free(err);
        if (out) parvane_protocol_string_free(out);
        return {};
    }
    return stringList(json::parse(take(out), nullptr, false));
}

json Client::groupInviteCreate(const std::string &groupHex, const std::string &title, std::int64_t expiresMs,
                               std::uint32_t usageLimit, bool requiresApproval) {
    char *err = nullptr;
    char *out = pv_client_group_invite_create(c_, groupHex.c_str(), title.c_str(), expiresMs, usageLimit,
                                              requiresApproval, &err);
    return parseOrThrow(result(out, err));
}

json Client::groupJoin(const std::string &url) {
    char *err = nullptr;
    char *out = pv_client_group_join(c_, url.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::logDevices(const std::string &user) const {
    auto v = json::parse(take(pv_client_log_devices(c_, user.c_str())), nullptr, false);
    return v.is_object() ? v : json{{"v2", json::array()}, {"legacy", json::array()}};
}

std::size_t Client::tokenCount() const { return pv_client_token_count(c_); }

// ── режим «усиленная приватность» (L2) ──────────────────────────────────────

namespace {

json l2Idle() {
    return json{{"active", false}, {"mine", false}, {"enabledBy", json::array()}, {"pad", false},
                {"ephemeralAllowed", true}};
}

} // namespace

json Client::l2SetDirect(const std::string &peer, bool enabled, const std::string &opId) {
    char *err = nullptr;
    char *out = pv_client_l2_set_direct(c_, peer.c_str(), enabled, opId.empty() ? nullptr : opId.c_str(), &err);
    return parseOrThrow(result(out, err));
}

json Client::l2Direct(const std::string &peer) const {
    char *out = pv_client_l2_direct(c_, peer.c_str());
    if (!out) return l2Idle();
    auto v = json::parse(take(out), nullptr, false);
    return v.is_object() ? v : l2Idle();
}

json Client::l2Group(const std::string &groupHex) const {
    char *err = nullptr;
    char *out = pv_client_l2_group(c_, groupHex.c_str(), &err);
    if (err) {
        parvane_protocol_string_free(err);
        if (out) parvane_protocol_string_free(out);
        return l2Idle();
    }
    if (!out) return l2Idle();
    auto v = json::parse(take(out), nullptr, false);
    return v.is_object() ? v : l2Idle();
}

void Client::l2SetGroupPref(const std::string &groupHex, bool enabled) {
    pv_client_l2_set_group_pref(c_, groupHex.c_str(), enabled);
}

json Client::l2ActiveChats() const {
    auto v = json::parse(take(pv_client_l2_active_chats(c_)), nullptr, false);
    if (!v.is_object()) v = json{{"direct", json::array()}, {"groups", json::array()}};
    return v;
}

bool Client::presenceAllowed() const { return pv_client_presence_allowed(c_); }

bool Client::hasStateKey() const { return pv_client_has_state_key(c_); }

bool Client::ensureStateKey() { return pv_client_ensure_state_key(c_); }

// ── журнал личного состояния ────────────────────────────────────────────────

std::unique_ptr<StateSession> StateSession::open(const Client &client) {
    auto *s = pv_client_state_session(client.raw());
    if (!s) return nullptr;
    return std::unique_ptr<StateSession>(new StateSession(s));
}

StateSession::~StateSession() {
    if (s_) pv_state_free(s_);
}

std::string StateSession::syncRequest() const { return takeBytes(pv_state_sync_request(s_)); }

json StateSession::ingest(const std::string &resp) {
    char *err = nullptr;
    char *out = pv_state_ingest(s_, u8(resp), resp.size(), &err);
    return parseOrThrow(result(out, err));
}

json StateSession::snapshot() const {
    auto v = json::parse(take(pv_state_snapshot(s_)), nullptr, false);
    return v.is_object() ? v : json::object();
}

std::vector<std::string> StateSession::diff(const json &desired, const std::vector<std::string> &kinds) {
    char *err = nullptr;
    const auto d = desired.dump();
    const auto k = json(kinds).dump();
    char *out = pv_state_diff(s_, d.c_str(), k.c_str(), &err);
    return bodies(result(out, err));
}

std::vector<std::string> StateSession::migrate(const json &local) {
    char *err = nullptr;
    const auto l = local.dump();
    char *out = pv_state_migrate(s_, l.c_str(), &err);
    return bodies(result(out, err));
}

json StateSession::claimDue(std::int64_t nowMs) {
    auto v = json::parse(take(pv_state_claim_due(s_, nowMs)), nullptr, false);
    return v.is_array() ? v : json::array();
}

std::vector<std::string> StateSession::markSent(const std::string &opIdB64) {
    char *err = nullptr;
    char *out = pv_state_mark_sent(s_, opIdB64.c_str(), &err);
    return bodies(result(out, err));
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
