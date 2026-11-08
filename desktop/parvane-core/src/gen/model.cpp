// Сгенерировано gen_bindings (cargo run -p parvane-protocol --bin gen_bindings) из proto/parvane/engine/v1/** — не править руками; проверка — gen_bindings --check (тест bindings_are_fresh).
#include "parvane/gen/model.h"

#include <stdexcept>

namespace parvane::gen {

namespace {
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

template <typename T> T numFrom(const nlohmann::json &v) {
    if (v.is_string()) {
        const auto &s = v.get_ref<const std::string &>();
        if constexpr (std::is_signed_v<T>) return static_cast<T>(std::stoll(s));
        else return static_cast<T>(std::stoull(s));
    }
    return v.get<T>();
}

const nlohmann::json *pick(const nlohmann::json &j, const char *proto, const char *camel) {
    if (!j.is_object()) return nullptr;
    auto it = j.find(proto);
    if (it != j.end() && !it->is_null()) return &*it;
    it = j.find(camel);
    if (it != j.end() && !it->is_null()) return &*it;
    return nullptr;
}
} // namespace

std::string toBase64(const std::string &b) {
    std::string out;
    for (size_t i = 0; i < b.size(); i += 3) {
        const uint32_t n = (uint32_t(uint8_t(b[i])) << 16) | (i + 1 < b.size() ? uint32_t(uint8_t(b[i + 1])) << 8 : 0) | (i + 2 < b.size() ? uint32_t(uint8_t(b[i + 2])) : 0);
        out += kB64[(n >> 18) & 63];
        out += kB64[(n >> 12) & 63];
        out += i + 1 < b.size() ? kB64[(n >> 6) & 63] : '=';
        out += i + 2 < b.size() ? kB64[n & 63] : '=';
    }
    return out;
}

std::string fromBase64(const std::string &t) {
    std::string out;
    uint32_t acc = 0;
    int bits = 0;
    for (char ch : t) {
        if (ch == '=' || ch == '\n' || ch == '\r' || ch == ' ') continue;
        if (ch == '-') ch = '+';
        if (ch == '_') ch = '/';
        const char *p = std::char_traits<char>::find(kB64, 64, ch);
        if (!p) throw std::invalid_argument("base64");
        acc = (acc << 6) | uint32_t(p - kB64);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += char((acc >> bits) & 0xff);
        }
    }
    return out;
}

void to_json(nlohmann::json &j, const DeleteScope &v) {
    switch (v) {
    case DeleteScope::DELETE_SCOPE_UNSPECIFIED: j = "DELETE_SCOPE_UNSPECIFIED"; return;
    case DeleteScope::DELETE_SCOPE_ME: j = "DELETE_SCOPE_ME"; return;
    case DeleteScope::DELETE_SCOPE_EVERYONE: j = "DELETE_SCOPE_EVERYONE"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, DeleteScope &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "DELETE_SCOPE_UNSPECIFIED") { v = DeleteScope::DELETE_SCOPE_UNSPECIFIED; return; }
        if (s == "DELETE_SCOPE_ME") { v = DeleteScope::DELETE_SCOPE_ME; return; }
        if (s == "DELETE_SCOPE_EVERYONE") { v = DeleteScope::DELETE_SCOPE_EVERYONE; return; }
        v = {};
        return;
    }
    v = static_cast<DeleteScope>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const Delivery &v) {
    switch (v) {
    case Delivery::DELIVERY_UNSPECIFIED: j = "DELIVERY_UNSPECIFIED"; return;
    case Delivery::DELIVERY_PENDING: j = "DELIVERY_PENDING"; return;
    case Delivery::DELIVERY_SENT: j = "DELIVERY_SENT"; return;
    case Delivery::DELIVERY_READ: j = "DELIVERY_READ"; return;
    case Delivery::DELIVERY_FAILED: j = "DELIVERY_FAILED"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, Delivery &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "DELIVERY_UNSPECIFIED") { v = Delivery::DELIVERY_UNSPECIFIED; return; }
        if (s == "DELIVERY_PENDING") { v = Delivery::DELIVERY_PENDING; return; }
        if (s == "DELIVERY_SENT") { v = Delivery::DELIVERY_SENT; return; }
        if (s == "DELIVERY_READ") { v = Delivery::DELIVERY_READ; return; }
        if (s == "DELIVERY_FAILED") { v = Delivery::DELIVERY_FAILED; return; }
        v = {};
        return;
    }
    v = static_cast<Delivery>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const Disposition &v) {
    switch (v) {
    case Disposition::DISPOSITION_UNSPECIFIED: j = "DISPOSITION_UNSPECIFIED"; return;
    case Disposition::DISPOSITION_SHOW: j = "DISPOSITION_SHOW"; return;
    case Disposition::DISPOSITION_STUB: j = "DISPOSITION_STUB"; return;
    case Disposition::DISPOSITION_STUB_CRITICAL: j = "DISPOSITION_STUB_CRITICAL"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, Disposition &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "DISPOSITION_UNSPECIFIED") { v = Disposition::DISPOSITION_UNSPECIFIED; return; }
        if (s == "DISPOSITION_SHOW") { v = Disposition::DISPOSITION_SHOW; return; }
        if (s == "DISPOSITION_STUB") { v = Disposition::DISPOSITION_STUB; return; }
        if (s == "DISPOSITION_STUB_CRITICAL") { v = Disposition::DISPOSITION_STUB_CRITICAL; return; }
        v = {};
        return;
    }
    v = static_cast<Disposition>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const GroupRole &v) {
    switch (v) {
    case GroupRole::GROUP_ROLE_UNSPECIFIED: j = "GROUP_ROLE_UNSPECIFIED"; return;
    case GroupRole::GROUP_ROLE_MEMBER: j = "GROUP_ROLE_MEMBER"; return;
    case GroupRole::GROUP_ROLE_ADMIN: j = "GROUP_ROLE_ADMIN"; return;
    case GroupRole::GROUP_ROLE_OWNER: j = "GROUP_ROLE_OWNER"; return;
    case GroupRole::GROUP_ROLE_LEFT: j = "GROUP_ROLE_LEFT"; return;
    case GroupRole::GROUP_ROLE_BANNED: j = "GROUP_ROLE_BANNED"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, GroupRole &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "GROUP_ROLE_UNSPECIFIED") { v = GroupRole::GROUP_ROLE_UNSPECIFIED; return; }
        if (s == "GROUP_ROLE_MEMBER") { v = GroupRole::GROUP_ROLE_MEMBER; return; }
        if (s == "GROUP_ROLE_ADMIN") { v = GroupRole::GROUP_ROLE_ADMIN; return; }
        if (s == "GROUP_ROLE_OWNER") { v = GroupRole::GROUP_ROLE_OWNER; return; }
        if (s == "GROUP_ROLE_LEFT") { v = GroupRole::GROUP_ROLE_LEFT; return; }
        if (s == "GROUP_ROLE_BANNED") { v = GroupRole::GROUP_ROLE_BANNED; return; }
        v = {};
        return;
    }
    v = static_cast<GroupRole>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const JournalWrite &v) {
    switch (v) {
    case JournalWrite::JOURNAL_WRITE_UNSPECIFIED: j = "JOURNAL_WRITE_UNSPECIFIED"; return;
    case JournalWrite::JOURNAL_WRITE_OPEN: j = "JOURNAL_WRITE_OPEN"; return;
    case JournalWrite::JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN: j = "JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN"; return;
    case JournalWrite::JOURNAL_WRITE_BLOCKED_TOO_NEW: j = "JOURNAL_WRITE_BLOCKED_TOO_NEW"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, JournalWrite &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "JOURNAL_WRITE_UNSPECIFIED") { v = JournalWrite::JOURNAL_WRITE_UNSPECIFIED; return; }
        if (s == "JOURNAL_WRITE_OPEN") { v = JournalWrite::JOURNAL_WRITE_OPEN; return; }
        if (s == "JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN") { v = JournalWrite::JOURNAL_WRITE_BLOCKED_CRITICAL_UNKNOWN; return; }
        if (s == "JOURNAL_WRITE_BLOCKED_TOO_NEW") { v = JournalWrite::JOURNAL_WRITE_BLOCKED_TOO_NEW; return; }
        v = {};
        return;
    }
    v = static_cast<JournalWrite>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const ObjectKind &v) {
    switch (v) {
    case ObjectKind::OBJECT_KIND_UNSPECIFIED: j = "OBJECT_KIND_UNSPECIFIED"; return;
    case ObjectKind::OBJECT_KIND_FOLDER: j = "OBJECT_KIND_FOLDER"; return;
    case ObjectKind::OBJECT_KIND_BLOCK: j = "OBJECT_KIND_BLOCK"; return;
    case ObjectKind::OBJECT_KIND_PEER_NOTIFY: j = "OBJECT_KIND_PEER_NOTIFY"; return;
    case ObjectKind::OBJECT_KIND_NOTIFY_DEFAULTS: j = "OBJECT_KIND_NOTIFY_DEFAULTS"; return;
    case ObjectKind::OBJECT_KIND_DRAFT: j = "OBJECT_KIND_DRAFT"; return;
    case ObjectKind::OBJECT_KIND_SCHEDULED: j = "OBJECT_KIND_SCHEDULED"; return;
    case ObjectKind::OBJECT_KIND_ARCHIVE: j = "OBJECT_KIND_ARCHIVE"; return;
    case ObjectKind::OBJECT_KIND_PIN_LIST: j = "OBJECT_KIND_PIN_LIST"; return;
    case ObjectKind::OBJECT_KIND_CALL: j = "OBJECT_KIND_CALL"; return;
    case ObjectKind::OBJECT_KIND_GROUP_INVITE: j = "OBJECT_KIND_GROUP_INVITE"; return;
    case ObjectKind::OBJECT_KIND_PLANNER_CONTAINER: j = "OBJECT_KIND_PLANNER_CONTAINER"; return;
    case ObjectKind::OBJECT_KIND_CLOUD_CONTAINER: j = "OBJECT_KIND_CLOUD_CONTAINER"; return;
    case ObjectKind::OBJECT_KIND_UNREAD_MARK: j = "OBJECT_KIND_UNREAD_MARK"; return;
    case ObjectKind::OBJECT_KIND_QUICK_REACTION: j = "OBJECT_KIND_QUICK_REACTION"; return;
    case ObjectKind::OBJECT_KIND_STICKER_PACK: j = "OBJECT_KIND_STICKER_PACK"; return;
    case ObjectKind::OBJECT_KIND_CONTACT: j = "OBJECT_KIND_CONTACT"; return;
    case ObjectKind::OBJECT_KIND_FOLDER_ORDER: j = "OBJECT_KIND_FOLDER_ORDER"; return;
    case ObjectKind::OBJECT_KIND_CHAT_CLEARED: j = "OBJECT_KIND_CHAT_CLEARED"; return;
    case ObjectKind::OBJECT_KIND_SAVED_GIF: j = "OBJECT_KIND_SAVED_GIF"; return;
    case ObjectKind::OBJECT_KIND_FAVED_STICKER: j = "OBJECT_KIND_FAVED_STICKER"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, ObjectKind &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "OBJECT_KIND_UNSPECIFIED") { v = ObjectKind::OBJECT_KIND_UNSPECIFIED; return; }
        if (s == "OBJECT_KIND_FOLDER") { v = ObjectKind::OBJECT_KIND_FOLDER; return; }
        if (s == "OBJECT_KIND_BLOCK") { v = ObjectKind::OBJECT_KIND_BLOCK; return; }
        if (s == "OBJECT_KIND_PEER_NOTIFY") { v = ObjectKind::OBJECT_KIND_PEER_NOTIFY; return; }
        if (s == "OBJECT_KIND_NOTIFY_DEFAULTS") { v = ObjectKind::OBJECT_KIND_NOTIFY_DEFAULTS; return; }
        if (s == "OBJECT_KIND_DRAFT") { v = ObjectKind::OBJECT_KIND_DRAFT; return; }
        if (s == "OBJECT_KIND_SCHEDULED") { v = ObjectKind::OBJECT_KIND_SCHEDULED; return; }
        if (s == "OBJECT_KIND_ARCHIVE") { v = ObjectKind::OBJECT_KIND_ARCHIVE; return; }
        if (s == "OBJECT_KIND_PIN_LIST") { v = ObjectKind::OBJECT_KIND_PIN_LIST; return; }
        if (s == "OBJECT_KIND_CALL") { v = ObjectKind::OBJECT_KIND_CALL; return; }
        if (s == "OBJECT_KIND_GROUP_INVITE") { v = ObjectKind::OBJECT_KIND_GROUP_INVITE; return; }
        if (s == "OBJECT_KIND_PLANNER_CONTAINER") { v = ObjectKind::OBJECT_KIND_PLANNER_CONTAINER; return; }
        if (s == "OBJECT_KIND_CLOUD_CONTAINER") { v = ObjectKind::OBJECT_KIND_CLOUD_CONTAINER; return; }
        if (s == "OBJECT_KIND_UNREAD_MARK") { v = ObjectKind::OBJECT_KIND_UNREAD_MARK; return; }
        if (s == "OBJECT_KIND_QUICK_REACTION") { v = ObjectKind::OBJECT_KIND_QUICK_REACTION; return; }
        if (s == "OBJECT_KIND_STICKER_PACK") { v = ObjectKind::OBJECT_KIND_STICKER_PACK; return; }
        if (s == "OBJECT_KIND_CONTACT") { v = ObjectKind::OBJECT_KIND_CONTACT; return; }
        if (s == "OBJECT_KIND_FOLDER_ORDER") { v = ObjectKind::OBJECT_KIND_FOLDER_ORDER; return; }
        if (s == "OBJECT_KIND_CHAT_CLEARED") { v = ObjectKind::OBJECT_KIND_CHAT_CLEARED; return; }
        if (s == "OBJECT_KIND_SAVED_GIF") { v = ObjectKind::OBJECT_KIND_SAVED_GIF; return; }
        if (s == "OBJECT_KIND_FAVED_STICKER") { v = ObjectKind::OBJECT_KIND_FAVED_STICKER; return; }
        v = {};
        return;
    }
    v = static_cast<ObjectKind>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const OpenState &v) {
    switch (v) {
    case OpenState::OPEN_STATE_UNSPECIFIED: j = "OPEN_STATE_UNSPECIFIED"; return;
    case OpenState::OPEN_STATE_READY: j = "OPEN_STATE_READY"; return;
    case OpenState::OPEN_STATE_MIGRATION_NEEDED: j = "OPEN_STATE_MIGRATION_NEEDED"; return;
    case OpenState::OPEN_STATE_TOO_NEW: j = "OPEN_STATE_TOO_NEW"; return;
    case OpenState::OPEN_STATE_LOCKED: j = "OPEN_STATE_LOCKED"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, OpenState &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "OPEN_STATE_UNSPECIFIED") { v = OpenState::OPEN_STATE_UNSPECIFIED; return; }
        if (s == "OPEN_STATE_READY") { v = OpenState::OPEN_STATE_READY; return; }
        if (s == "OPEN_STATE_MIGRATION_NEEDED") { v = OpenState::OPEN_STATE_MIGRATION_NEEDED; return; }
        if (s == "OPEN_STATE_TOO_NEW") { v = OpenState::OPEN_STATE_TOO_NEW; return; }
        if (s == "OPEN_STATE_LOCKED") { v = OpenState::OPEN_STATE_LOCKED; return; }
        v = {};
        return;
    }
    v = static_cast<OpenState>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const PageDirection &v) {
    switch (v) {
    case PageDirection::PAGE_DIRECTION_UNSPECIFIED: j = "PAGE_DIRECTION_UNSPECIFIED"; return;
    case PageDirection::PAGE_DIRECTION_OLDER: j = "PAGE_DIRECTION_OLDER"; return;
    case PageDirection::PAGE_DIRECTION_NEWER: j = "PAGE_DIRECTION_NEWER"; return;
    case PageDirection::PAGE_DIRECTION_AROUND: j = "PAGE_DIRECTION_AROUND"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, PageDirection &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "PAGE_DIRECTION_UNSPECIFIED") { v = PageDirection::PAGE_DIRECTION_UNSPECIFIED; return; }
        if (s == "PAGE_DIRECTION_OLDER") { v = PageDirection::PAGE_DIRECTION_OLDER; return; }
        if (s == "PAGE_DIRECTION_NEWER") { v = PageDirection::PAGE_DIRECTION_NEWER; return; }
        if (s == "PAGE_DIRECTION_AROUND") { v = PageDirection::PAGE_DIRECTION_AROUND; return; }
        v = {};
        return;
    }
    v = static_cast<PageDirection>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const RequestChannel &v) {
    switch (v) {
    case RequestChannel::REQUEST_CHANNEL_UNSPECIFIED: j = "REQUEST_CHANNEL_UNSPECIFIED"; return;
    case RequestChannel::REQUEST_CHANNEL_ID: j = "REQUEST_CHANNEL_ID"; return;
    case RequestChannel::REQUEST_CHANNEL_ANON: j = "REQUEST_CHANNEL_ANON"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, RequestChannel &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "REQUEST_CHANNEL_UNSPECIFIED") { v = RequestChannel::REQUEST_CHANNEL_UNSPECIFIED; return; }
        if (s == "REQUEST_CHANNEL_ID") { v = RequestChannel::REQUEST_CHANNEL_ID; return; }
        if (s == "REQUEST_CHANNEL_ANON") { v = RequestChannel::REQUEST_CHANNEL_ANON; return; }
        v = {};
        return;
    }
    v = static_cast<RequestChannel>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const ServerInputKind &v) {
    switch (v) {
    case ServerInputKind::SERVER_INPUT_KIND_UNSPECIFIED: j = "SERVER_INPUT_KIND_UNSPECIFIED"; return;
    case ServerInputKind::SERVER_INPUT_KIND_RESPONSE: j = "SERVER_INPUT_KIND_RESPONSE"; return;
    case ServerInputKind::SERVER_INPUT_KIND_EVENT: j = "SERVER_INPUT_KIND_EVENT"; return;
    case ServerInputKind::SERVER_INPUT_KIND_INBOX_RECORD: j = "SERVER_INPUT_KIND_INBOX_RECORD"; return;
    case ServerInputKind::SERVER_INPUT_KIND_STREAM_CHUNK: j = "SERVER_INPUT_KIND_STREAM_CHUNK"; return;
    }
    j = static_cast<int32_t>(v);
}

void from_json(const nlohmann::json &j, ServerInputKind &v) {
    if (j.is_string()) {
        const auto &s = j.get_ref<const std::string &>();
        if (s == "SERVER_INPUT_KIND_UNSPECIFIED") { v = ServerInputKind::SERVER_INPUT_KIND_UNSPECIFIED; return; }
        if (s == "SERVER_INPUT_KIND_RESPONSE") { v = ServerInputKind::SERVER_INPUT_KIND_RESPONSE; return; }
        if (s == "SERVER_INPUT_KIND_EVENT") { v = ServerInputKind::SERVER_INPUT_KIND_EVENT; return; }
        if (s == "SERVER_INPUT_KIND_INBOX_RECORD") { v = ServerInputKind::SERVER_INPUT_KIND_INBOX_RECORD; return; }
        if (s == "SERVER_INPUT_KIND_STREAM_CHUNK") { v = ServerInputKind::SERVER_INPUT_KIND_STREAM_CHUNK; return; }
        v = {};
        return;
    }
    v = static_cast<ServerInputKind>(j.get<int32_t>());
}

void to_json(nlohmann::json &j, const AuditDump &m) {
    j = nlohmann::json::object();
    if (!m.jsonl.empty()) j["jsonl"] = m.jsonl;
}

void from_json(const nlohmann::json &j, AuditDump &m) {
    m = AuditDump{};
    if (const auto *v = pick(j, "jsonl", "jsonl")) m.jsonl = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const CallResult &m) {
    j = nlohmann::json::object();
    if (!m.result_json.empty()) j["result_json"] = m.result_json;
}

void from_json(const nlohmann::json &j, CallResult &m) {
    m = CallResult{};
    if (const auto *v = pick(j, "result_json", "resultJson")) m.result_json = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const Capabilities &m) {
    j = nlohmann::json::object();
    if (m.send_text) j["send_text"] = m.send_text;
    if (m.send_media) j["send_media"] = m.send_media;
    if (m.send_stickers) j["send_stickers"] = m.send_stickers;
    if (m.send_polls) j["send_polls"] = m.send_polls;
    if (m.send_links) j["send_links"] = m.send_links;
    if (m.delete_everyone) j["delete_everyone"] = m.delete_everyone;
    if (m.pin) j["pin"] = m.pin;
    if (m.edit) j["edit"] = m.edit;
    if (m.react) j["react"] = m.react;
    if (m.forward) j["forward"] = m.forward;
    if (m.reply) j["reply"] = m.reply;
}

void from_json(const nlohmann::json &j, Capabilities &m) {
    m = Capabilities{};
    if (const auto *v = pick(j, "send_text", "sendText")) m.send_text = (*v).get<bool>();
    if (const auto *v = pick(j, "send_media", "sendMedia")) m.send_media = (*v).get<bool>();
    if (const auto *v = pick(j, "send_stickers", "sendStickers")) m.send_stickers = (*v).get<bool>();
    if (const auto *v = pick(j, "send_polls", "sendPolls")) m.send_polls = (*v).get<bool>();
    if (const auto *v = pick(j, "send_links", "sendLinks")) m.send_links = (*v).get<bool>();
    if (const auto *v = pick(j, "delete_everyone", "deleteEveryone")) m.delete_everyone = (*v).get<bool>();
    if (const auto *v = pick(j, "pin", "pin")) m.pin = (*v).get<bool>();
    if (const auto *v = pick(j, "edit", "edit")) m.edit = (*v).get<bool>();
    if (const auto *v = pick(j, "react", "react")) m.react = (*v).get<bool>();
    if (const auto *v = pick(j, "forward", "forward")) m.forward = (*v).get<bool>();
    if (const auto *v = pick(j, "reply", "reply")) m.reply = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const ChatAnchor &m) {
    j = nlohmann::json::object();
    if (m.ts_ms != 0) j["ts_ms"] = std::to_string(m.ts_ms);
    if (!m.chat_key.empty()) j["chat_key"] = m.chat_key;
}

void from_json(const nlohmann::json &j, ChatAnchor &m) {
    m = ChatAnchor{};
    if (const auto *v = pick(j, "ts_ms", "tsMs")) m.ts_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "chat_key", "chatKey")) m.chat_key = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ChatListRequest &m) {
    j = nlohmann::json::object();
    if (m.after.has_value()) j["after"] = *m.after;
    if (m.limit != 0) j["limit"] = m.limit;
    if (m.folder != 0) j["folder"] = m.folder;
}

void from_json(const nlohmann::json &j, ChatListRequest &m) {
    m = ChatListRequest{};
    if (const auto *v = pick(j, "after", "after")) m.after = (*v).get<ChatAnchor>();
    if (const auto *v = pick(j, "limit", "limit")) m.limit = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "folder", "folder")) m.folder = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const ClientCall &m) {
    j = nlohmann::json::object();
    if (!m.name.empty()) j["name"] = m.name;
    if (!m.args_json.empty()) j["args_json"] = m.args_json;
}

void from_json(const nlohmann::json &j, ClientCall &m) {
    m = ClientCall{};
    if (const auto *v = pick(j, "name", "name")) m.name = (*v).get<std::string>();
    if (const auto *v = pick(j, "args_json", "argsJson")) m.args_json = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ClientEvents &m) {
    j = nlohmann::json::object();
    if (!m.json.empty()) j["json"] = m.json;
}

void from_json(const nlohmann::json &j, ClientEvents &m) {
    m = ClientEvents{};
    if (const auto *v = pick(j, "json", "json")) m.json = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ClientReplace &m) {
    j = nlohmann::json::object();
    if (!m.mode.empty()) j["mode"] = m.mode;
    if (!m.blob.empty()) j["blob"] = toBase64(m.blob);
    if (!m.key.empty()) j["key"] = toBase64(m.key);
}

void from_json(const nlohmann::json &j, ClientReplace &m) {
    m = ClientReplace{};
    if (const auto *v = pick(j, "mode", "mode")) m.mode = (*v).get<std::string>();
    if (const auto *v = pick(j, "blob", "blob")) m.blob = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "key", "key")) m.key = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const CriticalRange &m) {
    j = nlohmann::json::object();
    if (!m.name.empty()) j["name"] = m.name;
    if (m.from != 0) j["from"] = m.from;
    if (m.to != 0) j["to"] = m.to;
}

void from_json(const nlohmann::json &j, CriticalRange &m) {
    m = CriticalRange{};
    if (const auto *v = pick(j, "name", "name")) m.name = (*v).get<std::string>();
    if (const auto *v = pick(j, "from", "from")) m.from = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "to", "to")) m.to = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const DeviceWrap &m) {
    j = nlohmann::json::object();
    if (!m.wrapped_dek.empty()) j["wrapped_dek"] = toBase64(m.wrapped_dek);
}

void from_json(const nlohmann::json &j, DeviceWrap &m) {
    m = DeviceWrap{};
    if (const auto *v = pick(j, "wrapped_dek", "wrappedDek")) m.wrapped_dek = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const EngineConfig &m) {
    j = nlohmann::json::object();
    if (!m.user.empty()) j["user"] = m.user;
    if (!m.device_id.empty()) j["device_id"] = m.device_id;
    if (!m.domain.empty()) j["domain"] = m.domain;
    if (!m.features.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.features) a.push_back(x);
        j["features"] = a;
    }
    if (m.now_ms != 0) j["now_ms"] = std::to_string(m.now_ms);
    if (m.memory_budget_bytes != 0) j["memory_budget_bytes"] = std::to_string(m.memory_budget_bytes);
    if (!m.device_key.empty()) j["device_key"] = toBase64(m.device_key);
    if (m.vectors) j["vectors"] = m.vectors;
    if (m.legacy_present) j["legacy_present"] = m.legacy_present;
    if (m.host_driven) j["host_driven"] = m.host_driven;
}

void from_json(const nlohmann::json &j, EngineConfig &m) {
    m = EngineConfig{};
    if (const auto *v = pick(j, "user", "user")) m.user = (*v).get<std::string>();
    if (const auto *v = pick(j, "device_id", "deviceId")) m.device_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "domain", "domain")) m.domain = (*v).get<std::string>();
    if (const auto *v = pick(j, "features", "features"); v && v->is_array())
        for (const auto &x : *v) m.features.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "now_ms", "nowMs")) m.now_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "memory_budget_bytes", "memoryBudgetBytes")) m.memory_budget_bytes = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "device_key", "deviceKey")) m.device_key = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "vectors", "vectors")) m.vectors = (*v).get<bool>();
    if (const auto *v = pick(j, "legacy_present", "legacyPresent")) m.legacy_present = (*v).get<bool>();
    if (const auto *v = pick(j, "host_driven", "hostDriven")) m.host_driven = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const EngineError &m) {
    j = nlohmann::json::object();
    if (!m.error.empty()) j["error"] = m.error;
}

void from_json(const nlohmann::json &j, EngineError &m) {
    m = EngineError{};
    if (const auto *v = pick(j, "error", "error")) m.error = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const FieldValue &m) {
    j = nlohmann::json::object();
    if (m.field != 0) j["field"] = m.field;
    if (!m.value.empty()) j["value"] = toBase64(m.value);
}

void from_json(const nlohmann::json &j, FieldValue &m) {
    m = FieldValue{};
    if (const auto *v = pick(j, "field", "field")) m.field = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "value", "value")) m.value = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const GroupPerms &m) {
    j = nlohmann::json::object();
    if (m.send_media) j["send_media"] = m.send_media;
    if (m.send_stickers) j["send_stickers"] = m.send_stickers;
    if (m.send_polls) j["send_polls"] = m.send_polls;
    if (m.send_links) j["send_links"] = m.send_links;
    if (m.invite) j["invite"] = m.invite;
    if (m.pin) j["pin"] = m.pin;
    if (m.change_info) j["change_info"] = m.change_info;
}

void from_json(const nlohmann::json &j, GroupPerms &m) {
    m = GroupPerms{};
    if (const auto *v = pick(j, "send_media", "sendMedia")) m.send_media = (*v).get<bool>();
    if (const auto *v = pick(j, "send_stickers", "sendStickers")) m.send_stickers = (*v).get<bool>();
    if (const auto *v = pick(j, "send_polls", "sendPolls")) m.send_polls = (*v).get<bool>();
    if (const auto *v = pick(j, "send_links", "sendLinks")) m.send_links = (*v).get<bool>();
    if (const auto *v = pick(j, "invite", "invite")) m.invite = (*v).get<bool>();
    if (const auto *v = pick(j, "pin", "pin")) m.pin = (*v).get<bool>();
    if (const auto *v = pick(j, "change_info", "changeInfo")) m.change_info = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const IntentFaveSticker &m) {
    j = nlohmann::json::object();
    if (!m.set_id.empty()) j["set_id"] = m.set_id;
    if (!m.sticker_id.empty()) j["sticker_id"] = m.sticker_id;
    if (m.on) j["on"] = m.on;
}

void from_json(const nlohmann::json &j, IntentFaveSticker &m) {
    m = IntentFaveSticker{};
    if (const auto *v = pick(j, "set_id", "setId")) m.set_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "sticker_id", "stickerId")) m.sticker_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "on", "on")) m.on = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const IntentGroupCreate &m) {
    j = nlohmann::json::object();
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.members.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.members) a.push_back(x);
        j["members"] = a;
    }
    if (!m.kind.empty()) j["kind"] = m.kind;
}

void from_json(const nlohmann::json &j, IntentGroupCreate &m) {
    m = IntentGroupCreate{};
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "members", "members"); v && v->is_array())
        for (const auto &x : *v) m.members.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const IntentGroupJoinByLink &m) {
    j = nlohmann::json::object();
    if (!m.url.empty()) j["url"] = m.url;
}

void from_json(const nlohmann::json &j, IntentGroupJoinByLink &m) {
    m = IntentGroupJoinByLink{};
    if (const auto *v = pick(j, "url", "url")) m.url = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const IntentRevoke &m) {
    j = nlohmann::json::object();
    if (!m.device_id.empty()) j["device_id"] = m.device_id;
    if (m.stolen) j["stolen"] = m.stolen;
}

void from_json(const nlohmann::json &j, IntentRevoke &m) {
    m = IntentRevoke{};
    if (const auto *v = pick(j, "device_id", "deviceId")) m.device_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "stolen", "stolen")) m.stolen = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const IntentRotateSsk &m) {
    j = nlohmann::json::object();
    if (!m.root_secret.empty()) j["root_secret"] = toBase64(m.root_secret);
}

void from_json(const nlohmann::json &j, IntentRotateSsk &m) {
    m = IntentRotateSsk{};
    if (const auto *v = pick(j, "root_secret", "rootSecret")) m.root_secret = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const JournalState &m) {
    j = nlohmann::json::object();
    if (!m.journal.empty()) j["journal"] = m.journal;
    if (m.cursor != 0) j["cursor"] = std::to_string(m.cursor);
    if (m.head != 0) j["head"] = std::to_string(m.head);
    if (m.write != JournalWrite{}) j["write"] = m.write;
}

void from_json(const nlohmann::json &j, JournalState &m) {
    m = JournalState{};
    if (const auto *v = pick(j, "journal", "journal")) m.journal = (*v).get<std::string>();
    if (const auto *v = pick(j, "cursor", "cursor")) m.cursor = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "head", "head")) m.head = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "write", "write")) m.write = (*v).get<JournalWrite>();
}

void to_json(nlohmann::json &j, const KindFormat &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.format != 0) j["format"] = m.format;
}

void from_json(const nlohmann::json &j, KindFormat &m) {
    m = KindFormat{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "format", "format")) m.format = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const LegacyRecord &m) {
    j = nlohmann::json::object();
    if (!m.key.empty()) j["key"] = m.key;
    if (!m.value.empty()) j["value"] = toBase64(m.value);
}

void from_json(const nlohmann::json &j, LegacyRecord &m) {
    m = LegacyRecord{};
    if (const auto *v = pick(j, "key", "key")) m.key = (*v).get<std::string>();
    if (const auto *v = pick(j, "value", "value")) m.value = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const MarkValue &m) {
    j = nlohmann::json::object();
    if (m.field != 0) j["field"] = m.field;
    if (!m.value.empty()) j["value"] = toBase64(m.value);
}

void from_json(const nlohmann::json &j, MarkValue &m) {
    m = MarkValue{};
    if (const auto *v = pick(j, "field", "field")) m.field = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "value", "value")) m.value = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const MigrateStatus &m) {
    j = nlohmann::json::object();
    if (m.point != 0) j["point"] = m.point;
    if (m.done) j["done"] = m.done;
    if (!m.report_json.empty()) j["report_json"] = m.report_json;
}

void from_json(const nlohmann::json &j, MigrateStatus &m) {
    m = MigrateStatus{};
    if (const auto *v = pick(j, "point", "point")) m.point = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "done", "done")) m.done = (*v).get<bool>();
    if (const auto *v = pick(j, "report_json", "reportJson")) m.report_json = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const MigrateStep &m) {
    j = nlohmann::json::object();
    if (!m.layer.empty()) j["layer"] = m.layer;
    if (!m.records.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.records) a.push_back(x);
        j["records"] = a;
    }
    if (m.last) j["last"] = m.last;
    if (m.chunk != 0) j["chunk"] = m.chunk;
}

void from_json(const nlohmann::json &j, MigrateStep &m) {
    m = MigrateStep{};
    if (const auto *v = pick(j, "layer", "layer")) m.layer = (*v).get<std::string>();
    if (const auto *v = pick(j, "records", "records"); v && v->is_array())
        for (const auto &x : *v) m.records.push_back(x.get<LegacyRecord>());
    if (const auto *v = pick(j, "last", "last")) m.last = (*v).get<bool>();
    if (const auto *v = pick(j, "chunk", "chunk")) m.chunk = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const MigrationPlan &m) {
    j = nlohmann::json::object();
    if (!m.steps.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.steps) a.push_back(x);
        j["steps"] = a;
    }
    if (m.legacy_records != 0) j["legacy_records"] = std::to_string(m.legacy_records);
}

void from_json(const nlohmann::json &j, MigrationPlan &m) {
    m = MigrationPlan{};
    if (const auto *v = pick(j, "steps", "steps"); v && v->is_array())
        for (const auto &x : *v) m.steps.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "legacy_records", "legacyRecords")) m.legacy_records = numFrom<uint64_t>((*v));
}

void to_json(nlohmann::json &j, const MigrationProgress &m) {
    j = nlohmann::json::object();
    if (m.from_generation != 0) j["from_generation"] = m.from_generation;
    if (m.to_generation != 0) j["to_generation"] = m.to_generation;
    if (m.point != 0) j["point"] = m.point;
    if (!m.errors.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.errors) a.push_back(x);
        j["errors"] = a;
    }
}

void from_json(const nlohmann::json &j, MigrationProgress &m) {
    m = MigrationProgress{};
    if (const auto *v = pick(j, "from_generation", "fromGeneration")) m.from_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "to_generation", "toGeneration")) m.to_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "point", "point")) m.point = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "errors", "errors"); v && v->is_array())
        for (const auto &x : *v) m.errors.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const MsgAnchor &m) {
    j = nlohmann::json::object();
    if (m.ts_ms != 0) j["ts_ms"] = std::to_string(m.ts_ms);
    if (!m.id.empty()) j["id"] = toBase64(m.id);
}

void from_json(const nlohmann::json &j, MsgAnchor &m) {
    m = MsgAnchor{};
    if (const auto *v = pick(j, "ts_ms", "tsMs")) m.ts_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "id", "id")) m.id = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const ObjectKey &m) {
    j = nlohmann::json::object();
    if (m.kind != ObjectKind{}) j["kind"] = m.kind;
    if (!m.key.empty()) j["key"] = m.key;
}

void from_json(const nlohmann::json &j, ObjectKey &m) {
    m = ObjectKey{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<ObjectKind>();
    if (const auto *v = pick(j, "key", "key")) m.key = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const OpenResult &m) {
    j = nlohmann::json::object();
    if (m.state != OpenState{}) j["state"] = m.state;
    if (m.migration.has_value()) j["migration"] = *m.migration;
}

void from_json(const nlohmann::json &j, OpenResult &m) {
    m = OpenResult{};
    if (const auto *v = pick(j, "state", "state")) m.state = (*v).get<OpenState>();
    if (const auto *v = pick(j, "migration", "migration")) m.migration = (*v).get<MigrationPlan>();
}

void to_json(nlohmann::json &j, const OutRequest &m) {
    j = nlohmann::json::object();
    if (m.req_id != 0) j["req_id"] = std::to_string(m.req_id);
    if (!m.method.empty()) j["method"] = m.method;
    if (m.channel != RequestChannel{}) j["channel"] = m.channel;
    if (!m.body.empty()) j["body"] = toBase64(m.body);
    if (m.deadline_ms != 0) j["deadline_ms"] = std::to_string(m.deadline_ms);
    if (!m.dest_domain.empty()) j["dest_domain"] = m.dest_domain;
}

void from_json(const nlohmann::json &j, OutRequest &m) {
    m = OutRequest{};
    if (const auto *v = pick(j, "req_id", "reqId")) m.req_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "method", "method")) m.method = (*v).get<std::string>();
    if (const auto *v = pick(j, "channel", "channel")) m.channel = (*v).get<RequestChannel>();
    if (const auto *v = pick(j, "body", "body")) m.body = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "deadline_ms", "deadlineMs")) m.deadline_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "dest_domain", "destDomain")) m.dest_domain = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const PinWrap &m) {
    j = nlohmann::json::object();
    if (!m.salt.empty()) j["salt"] = toBase64(m.salt);
    if (m.iterations != 0) j["iterations"] = m.iterations;
    if (!m.wrapped_dek.empty()) j["wrapped_dek"] = toBase64(m.wrapped_dek);
    if (!m.check.empty()) j["check"] = toBase64(m.check);
}

void from_json(const nlohmann::json &j, PinWrap &m) {
    m = PinWrap{};
    if (const auto *v = pick(j, "salt", "salt")) m.salt = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "iterations", "iterations")) m.iterations = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "wrapped_dek", "wrappedDek")) m.wrapped_dek = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "check", "check")) m.check = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const RangeHold &m) {
    j = nlohmann::json::object();
    if (!m.journal.empty()) j["journal"] = m.journal;
    if (m.from_seq != 0) j["from_seq"] = std::to_string(m.from_seq);
    if (m.to_seq != 0) j["to_seq"] = std::to_string(m.to_seq);
    if (!m.paths.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.paths) a.push_back(x);
        j["paths"] = a;
    }
}

void from_json(const nlohmann::json &j, RangeHold &m) {
    m = RangeHold{};
    if (const auto *v = pick(j, "journal", "journal")) m.journal = (*v).get<std::string>();
    if (const auto *v = pick(j, "from_seq", "fromSeq")) m.from_seq = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "to_seq", "toSeq")) m.to_seq = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "paths", "paths"); v && v->is_array())
        for (const auto &x : *v) m.paths.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const RangeHolds &m) {
    j = nlohmann::json::object();
    if (!m.holds.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.holds) a.push_back(x);
        j["holds"] = a;
    }
}

void from_json(const nlohmann::json &j, RangeHolds &m) {
    m = RangeHolds{};
    if (const auto *v = pick(j, "holds", "holds"); v && v->is_array())
        for (const auto &x : *v) m.holds.push_back(x.get<RangeHold>());
}

void to_json(nlohmann::json &j, const Ref &m) {
    j = nlohmann::json::object();
    if (!m.domain.empty()) j["domain"] = m.domain;
    if (!m.id.empty()) j["id"] = toBase64(m.id);
}

void from_json(const nlohmann::json &j, Ref &m) {
    m = Ref{};
    if (const auto *v = pick(j, "domain", "domain")) m.domain = (*v).get<std::string>();
    if (const auto *v = pick(j, "id", "id")) m.id = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const RowsAllRequest &m) {
    j = nlohmann::json::object();
    if (m.views) j["views"] = m.views;
    if (m.states) j["states"] = m.states;
    if (m.marks) j["marks"] = m.marks;
}

void from_json(const nlohmann::json &j, RowsAllRequest &m) {
    m = RowsAllRequest{};
    if (const auto *v = pick(j, "views", "views")) m.views = (*v).get<bool>();
    if (const auto *v = pick(j, "states", "states")) m.states = (*v).get<bool>();
    if (const auto *v = pick(j, "marks", "marks")) m.marks = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const RowsApply &m) {
    j = nlohmann::json::object();
    if (!m.ops_json.empty()) j["ops_json"] = m.ops_json;
    if (!m.receipts_json.empty()) j["receipts_json"] = m.receipts_json;
    if (!m.forget_json.empty()) j["forget_json"] = m.forget_json;
    if (m.wipe) j["wipe"] = m.wipe;
    if (m.now_ms != 0) j["now_ms"] = std::to_string(m.now_ms);
    if (!m.rows_json.empty()) j["rows_json"] = m.rows_json;
}

void from_json(const nlohmann::json &j, RowsApply &m) {
    m = RowsApply{};
    if (const auto *v = pick(j, "ops_json", "opsJson")) m.ops_json = (*v).get<std::string>();
    if (const auto *v = pick(j, "receipts_json", "receiptsJson")) m.receipts_json = (*v).get<std::string>();
    if (const auto *v = pick(j, "forget_json", "forgetJson")) m.forget_json = (*v).get<std::string>();
    if (const auto *v = pick(j, "wipe", "wipe")) m.wipe = (*v).get<bool>();
    if (const auto *v = pick(j, "now_ms", "nowMs")) m.now_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "rows_json", "rowsJson")) m.rows_json = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ServerInput &m) {
    j = nlohmann::json::object();
    if (m.kind != ServerInputKind{}) j["kind"] = m.kind;
    if (!m.method.empty()) j["method"] = m.method;
    if (m.req_id != 0) j["req_id"] = std::to_string(m.req_id);
    if (!m.body.empty()) j["body"] = toBase64(m.body);
    if (m.error != 0) j["error"] = m.error;
}

void from_json(const nlohmann::json &j, ServerInput &m) {
    m = ServerInput{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<ServerInputKind>();
    if (const auto *v = pick(j, "method", "method")) m.method = (*v).get<std::string>();
    if (const auto *v = pick(j, "req_id", "reqId")) m.req_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "body", "body")) m.body = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "error", "error")) m.error = numFrom<int32_t>((*v));
}

void to_json(nlohmann::json &j, const StateObjectView &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (!m.fields.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.fields) a.push_back(x);
        j["fields"] = a;
    }
    if (!m.marks.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.marks) a.push_back(x);
        j["marks"] = a;
    }
}

void from_json(const nlohmann::json &j, StateObjectView &m) {
    m = StateObjectView{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "fields", "fields"); v && v->is_array())
        for (const auto &x : *v) m.fields.push_back(x.get<FieldValue>());
    if (const auto *v = pick(j, "marks", "marks"); v && v->is_array())
        for (const auto &x : *v) m.marks.push_back(x.get<MarkValue>());
}

void to_json(nlohmann::json &j, const StateView &m) {
    j = nlohmann::json::object();
    if (!m.objects.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.objects) a.push_back(x);
        j["objects"] = a;
    }
}

void from_json(const nlohmann::json &j, StateView &m) {
    m = StateView{};
    if (const auto *v = pick(j, "objects", "objects"); v && v->is_array())
        for (const auto &x : *v) m.objects.push_back(x.get<StateObjectView>());
}

void to_json(nlohmann::json &j, const StorageFormat &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.format != 0) j["format"] = m.format;
}

void from_json(const nlohmann::json &j, StorageFormat &m) {
    m = StorageFormat{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "format", "format")) m.format = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const StoreCommitted &m) {
    j = nlohmann::json::object();
    if (m.batch_id != 0) j["batch_id"] = std::to_string(m.batch_id);
}

void from_json(const nlohmann::json &j, StoreCommitted &m) {
    m = StoreCommitted{};
    if (const auto *v = pick(j, "batch_id", "batchId")) m.batch_id = numFrom<uint64_t>((*v));
}

void to_json(nlohmann::json &j, const StorePut &m) {
    j = nlohmann::json::object();
    if (!m.key.empty()) j["key"] = m.key;
    if (!m.value.empty()) j["value"] = toBase64(m.value);
}

void from_json(const nlohmann::json &j, StorePut &m) {
    m = StorePut{};
    if (const auto *v = pick(j, "key", "key")) m.key = (*v).get<std::string>();
    if (const auto *v = pick(j, "value", "value")) m.value = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const StoreReads &m) {
    j = nlohmann::json::object();
    if (m.read_id != 0) j["read_id"] = std::to_string(m.read_id);
    if (!m.keys.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.keys) a.push_back(x);
        j["keys"] = a;
    }
    if (!m.prefix.empty()) j["prefix"] = m.prefix;
    if (!m.after.empty()) j["after"] = m.after;
    if (m.limit != 0) j["limit"] = m.limit;
}

void from_json(const nlohmann::json &j, StoreReads &m) {
    m = StoreReads{};
    if (const auto *v = pick(j, "read_id", "readId")) m.read_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "keys", "keys"); v && v->is_array())
        for (const auto &x : *v) m.keys.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "prefix", "prefix")) m.prefix = (*v).get<std::string>();
    if (const auto *v = pick(j, "after", "after")) m.after = (*v).get<std::string>();
    if (const auto *v = pick(j, "limit", "limit")) m.limit = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const Stored &m) {
    j = nlohmann::json::object();
    if (m.format != 0) j["format"] = m.format;
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.generation != 0) j["generation"] = m.generation;
    if (!m.payload.empty()) j["payload"] = toBase64(m.payload);
}

void from_json(const nlohmann::json &j, Stored &m) {
    m = Stored{};
    if (const auto *v = pick(j, "format", "format")) m.format = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "generation", "generation")) m.generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "payload", "payload")) m.payload = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const Tick &m) {
    j = nlohmann::json::object();
    if (m.now_ms != 0) j["now_ms"] = std::to_string(m.now_ms);
}

void from_json(const nlohmann::json &j, Tick &m) {
    m = Tick{};
    if (const auto *v = pick(j, "now_ms", "nowMs")) m.now_ms = numFrom<int64_t>((*v));
}

void to_json(nlohmann::json &j, const UnlockPin &m) {
    j = nlohmann::json::object();
    if (!m.pin.empty()) j["pin"] = m.pin;
}

void from_json(const nlohmann::json &j, UnlockPin &m) {
    m = UnlockPin{};
    if (const auto *v = pick(j, "pin", "pin")) m.pin = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const UserRef &m) {
    j = nlohmann::json::object();
    if (!m.address.empty()) j["address"] = m.address;
}

void from_json(const nlohmann::json &j, UserRef &m) {
    m = UserRef{};
    if (const auto *v = pick(j, "address", "address")) m.address = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewArticle &m) {
    j = nlohmann::json::object();
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.markdown.empty()) j["markdown"] = m.markdown;
}

void from_json(const nlohmann::json &j, ViewArticle &m) {
    m = ViewArticle{};
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "markdown", "markdown")) m.markdown = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewCall &m) {
    j = nlohmann::json::object();
    if (m.video) j["video"] = m.video;
    if (m.outgoing) j["outgoing"] = m.outgoing;
    if (m.duration_s != 0) j["duration_s"] = m.duration_s;
    if (!m.reason.empty()) j["reason"] = m.reason;
}

void from_json(const nlohmann::json &j, ViewCall &m) {
    m = ViewCall{};
    if (const auto *v = pick(j, "video", "video")) m.video = (*v).get<bool>();
    if (const auto *v = pick(j, "outgoing", "outgoing")) m.outgoing = (*v).get<bool>();
    if (const auto *v = pick(j, "duration_s", "durationS")) m.duration_s = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "reason", "reason")) m.reason = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewCloudInvite &m) {
    j = nlohmann::json::object();
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.owner.empty()) j["owner"] = m.owner;
    if (!m.role.empty()) j["role"] = m.role;
}

void from_json(const nlohmann::json &j, ViewCloudInvite &m) {
    m = ViewCloudInvite{};
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "owner", "owner")) m.owner = (*v).get<std::string>();
    if (const auto *v = pick(j, "role", "role")) m.role = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewContact &m) {
    j = nlohmann::json::object();
    if (!m.user.empty()) j["user"] = m.user;
    if (!m.first_name.empty()) j["first_name"] = m.first_name;
    if (!m.last_name.empty()) j["last_name"] = m.last_name;
}

void from_json(const nlohmann::json &j, ViewContact &m) {
    m = ViewContact{};
    if (const auto *v = pick(j, "user", "user")) m.user = (*v).get<std::string>();
    if (const auto *v = pick(j, "first_name", "firstName")) m.first_name = (*v).get<std::string>();
    if (const auto *v = pick(j, "last_name", "lastName")) m.last_name = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewEntity &m) {
    j = nlohmann::json::object();
    if (!m.type.empty()) j["type"] = m.type;
    if (m.offset != 0) j["offset"] = m.offset;
    if (m.length != 0) j["length"] = m.length;
    if (!m.url.empty()) j["url"] = m.url;
    if (!m.user.empty()) j["user"] = m.user;
    if (!m.language.empty()) j["language"] = m.language;
    if (!m.custom_emoji_id.empty()) j["custom_emoji_id"] = m.custom_emoji_id;
}

void from_json(const nlohmann::json &j, ViewEntity &m) {
    m = ViewEntity{};
    if (const auto *v = pick(j, "type", "type")) m.type = (*v).get<std::string>();
    if (const auto *v = pick(j, "offset", "offset")) m.offset = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "length", "length")) m.length = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "url", "url")) m.url = (*v).get<std::string>();
    if (const auto *v = pick(j, "user", "user")) m.user = (*v).get<std::string>();
    if (const auto *v = pick(j, "language", "language")) m.language = (*v).get<std::string>();
    if (const auto *v = pick(j, "custom_emoji_id", "customEmojiId")) m.custom_emoji_id = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewGroupRequest &m) {
    j = nlohmann::json::object();
    if (m.group.has_value()) j["group"] = *m.group;
}

void from_json(const nlohmann::json &j, ViewGroupRequest &m) {
    m = ViewGroupRequest{};
    if (const auto *v = pick(j, "group", "group")) m.group = (*v).get<Ref>();
}

void to_json(nlohmann::json &j, const ViewLocation &m) {
    j = nlohmann::json::object();
    if (m.lat != 0) j["lat"] = m.lat;
    if (m.lon != 0) j["lon"] = m.lon;
    if (!m.title.empty()) j["title"] = m.title;
}

void from_json(const nlohmann::json &j, ViewLocation &m) {
    m = ViewLocation{};
    if (const auto *v = pick(j, "lat", "lat")) m.lat = numFrom<double>((*v));
    if (const auto *v = pick(j, "lon", "lon")) m.lon = numFrom<double>((*v));
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewPoll &m) {
    j = nlohmann::json::object();
    if (!m.question.empty()) j["question"] = m.question;
    if (!m.options.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.options) a.push_back(x);
        j["options"] = a;
    }
    if (m.multiple) j["multiple"] = m.multiple;
    if (m.quiz) j["quiz"] = m.quiz;
    if (!m.my_votes.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.my_votes) a.push_back(x);
        j["my_votes"] = a;
    }
    if (!m.votes.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.votes) a.push_back(x);
        j["votes"] = a;
    }
}

void from_json(const nlohmann::json &j, ViewPoll &m) {
    m = ViewPoll{};
    if (const auto *v = pick(j, "question", "question")) m.question = (*v).get<std::string>();
    if (const auto *v = pick(j, "options", "options"); v && v->is_array())
        for (const auto &x : *v) m.options.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "multiple", "multiple")) m.multiple = (*v).get<bool>();
    if (const auto *v = pick(j, "quiz", "quiz")) m.quiz = (*v).get<bool>();
    if (const auto *v = pick(j, "my_votes", "myVotes"); v && v->is_array())
        for (const auto &x : *v) m.my_votes.push_back(numFrom<uint32_t>(x));
    if (const auto *v = pick(j, "votes", "votes"); v && v->is_array())
        for (const auto &x : *v) m.votes.push_back(numFrom<uint32_t>(x));
}

void to_json(nlohmann::json &j, const ViewReaction &m) {
    j = nlohmann::json::object();
    if (!m.emoji.empty()) j["emoji"] = m.emoji;
    if (m.count != 0) j["count"] = m.count;
    if (m.mine) j["mine"] = m.mine;
}

void from_json(const nlohmann::json &j, ViewReaction &m) {
    m = ViewReaction{};
    if (const auto *v = pick(j, "emoji", "emoji")) m.emoji = (*v).get<std::string>();
    if (const auto *v = pick(j, "count", "count")) m.count = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "mine", "mine")) m.mine = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const ViewService &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (!m.actor.empty()) j["actor"] = m.actor;
    if (!m.targets.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.targets) a.push_back(x);
        j["targets"] = a;
    }
    if (!m.text.empty()) j["text"] = m.text;
}

void from_json(const nlohmann::json &j, ViewService &m) {
    m = ViewService{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "actor", "actor")) m.actor = (*v).get<std::string>();
    if (const auto *v = pick(j, "targets", "targets"); v && v->is_array())
        for (const auto &x : *v) m.targets.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "text", "text")) m.text = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewStateRequest &m) {
    j = nlohmann::json::object();
    if (!m.kinds.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.kinds) a.push_back(x);
        j["kinds"] = a;
    }
}

void from_json(const nlohmann::json &j, ViewStateRequest &m) {
    m = ViewStateRequest{};
    if (const auto *v = pick(j, "kinds", "kinds"); v && v->is_array())
        for (const auto &x : *v) m.kinds.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const ViewTaskOffer &m) {
    j = nlohmann::json::object();
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.text.empty()) j["text"] = m.text;
    if (!m.task_id.empty()) j["task_id"] = toBase64(m.task_id);
}

void from_json(const nlohmann::json &j, ViewTaskOffer &m) {
    m = ViewTaskOffer{};
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "text", "text")) m.text = (*v).get<std::string>();
    if (const auto *v = pick(j, "task_id", "taskId")) m.task_id = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const ViewText &m) {
    j = nlohmann::json::object();
    if (!m.text.empty()) j["text"] = m.text;
    if (!m.entities.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.entities) a.push_back(x);
        j["entities"] = a;
    }
}

void from_json(const nlohmann::json &j, ViewText &m) {
    m = ViewText{};
    if (const auto *v = pick(j, "text", "text")) m.text = (*v).get<std::string>();
    if (const auto *v = pick(j, "entities", "entities"); v && v->is_array())
        for (const auto &x : *v) m.entities.push_back(x.get<ViewEntity>());
}

void to_json(nlohmann::json &j, const Wrap &m) {
    j = nlohmann::json::object();
    if (m.generation != 0) j["generation"] = m.generation;
    if (const auto *p = std::get_if<1>(&m.kind)) j["device"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["pin"] = *p;
}

void from_json(const nlohmann::json &j, Wrap &m) {
    m = Wrap{};
    if (const auto *v = pick(j, "generation", "generation")) m.generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "device", "device")) m.kind.emplace<1>(v->get<DeviceWrap>());
    if (const auto *v = pick(j, "pin", "pin")) m.kind.emplace<2>(v->get<PinWrap>());
}

void to_json(nlohmann::json &j, const WriteBlocked &m) {
    j = nlohmann::json::object();
    if (!m.journal.empty()) j["journal"] = m.journal;
    if (m.reason != JournalWrite{}) j["reason"] = m.reason;
}

void from_json(const nlohmann::json &j, WriteBlocked &m) {
    m = WriteBlocked{};
    if (const auto *v = pick(j, "journal", "journal")) m.journal = (*v).get<std::string>();
    if (const auto *v = pick(j, "reason", "reason")) m.reason = (*v).get<JournalWrite>();
}

void to_json(nlohmann::json &j, const EngineInfo &m) {
    j = nlohmann::json::object();
    if (!m.engine_api.empty()) j["engine_api"] = m.engine_api;
    if (m.proto_major != 0) j["proto_major"] = m.proto_major;
    if (m.proto_minor != 0) j["proto_minor"] = m.proto_minor;
    if (m.min_supported_minor != 0) j["min_supported_minor"] = m.min_supported_minor;
    if (!m.features.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.features) a.push_back(x);
        j["features"] = a;
    }
    if (!m.storage_formats.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.storage_formats) a.push_back(x);
        j["storage_formats"] = a;
    }
    if (!m.critical_ranges.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.critical_ranges) a.push_back(x);
        j["critical_ranges"] = a;
    }
    if (!m.source_hash.empty()) j["source_hash"] = m.source_hash;
    if (!m.schema_hash.empty()) j["schema_hash"] = m.schema_hash;
    if (!m.build_id.empty()) j["build_id"] = m.build_id;
    if (!m.target.empty()) j["target"] = m.target;
}

void from_json(const nlohmann::json &j, EngineInfo &m) {
    m = EngineInfo{};
    if (const auto *v = pick(j, "engine_api", "engineApi")) m.engine_api = (*v).get<std::string>();
    if (const auto *v = pick(j, "proto_major", "protoMajor")) m.proto_major = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "proto_minor", "protoMinor")) m.proto_minor = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "min_supported_minor", "minSupportedMinor")) m.min_supported_minor = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "features", "features"); v && v->is_array())
        for (const auto &x : *v) m.features.push_back(x.get<std::string>());
    if (const auto *v = pick(j, "storage_formats", "storageFormats"); v && v->is_array())
        for (const auto &x : *v) m.storage_formats.push_back(x.get<StorageFormat>());
    if (const auto *v = pick(j, "critical_ranges", "criticalRanges"); v && v->is_array())
        for (const auto &x : *v) m.critical_ranges.push_back(x.get<CriticalRange>());
    if (const auto *v = pick(j, "source_hash", "sourceHash")) m.source_hash = (*v).get<std::string>();
    if (const auto *v = pick(j, "schema_hash", "schemaHash")) m.schema_hash = (*v).get<std::string>();
    if (const auto *v = pick(j, "build_id", "buildId")) m.build_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "target", "target")) m.target = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const IntentDomainOp &m) {
    j = nlohmann::json::object();
    if (m.container.has_value()) j["container"] = *m.container;
    if (!m.op.empty()) j["op"] = toBase64(m.op);
}

void from_json(const nlohmann::json &j, IntentDomainOp &m) {
    m = IntentDomainOp{};
    if (const auto *v = pick(j, "container", "container")) m.container = (*v).get<Ref>();
    if (const auto *v = pick(j, "op", "op")) m.op = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const IntentGroupChange &m) {
    j = nlohmann::json::object();
    if (m.group.has_value()) j["group"] = *m.group;
    if (!m.change.empty()) j["change"] = toBase64(m.change);
}

void from_json(const nlohmann::json &j, IntentGroupChange &m) {
    m = IntentGroupChange{};
    if (const auto *v = pick(j, "group", "group")) m.group = (*v).get<Ref>();
    if (const auto *v = pick(j, "change", "change")) m.change = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const IntentStateCreate &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (!m.set.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.set) a.push_back(x);
        j["set"] = a;
    }
}

void from_json(const nlohmann::json &j, IntentStateCreate &m) {
    m = IntentStateCreate{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "set", "set"); v && v->is_array())
        for (const auto &x : *v) m.set.push_back(x.get<FieldValue>());
}

void to_json(nlohmann::json &j, const IntentStateDelete &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
}

void from_json(const nlohmann::json &j, IntentStateDelete &m) {
    m = IntentStateDelete{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
}

void to_json(nlohmann::json &j, const IntentStatePatch &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (!m.set.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.set) a.push_back(x);
        j["set"] = a;
    }
    if (!m.clear.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.clear) a.push_back(x);
        j["clear"] = a;
    }
}

void from_json(const nlohmann::json &j, IntentStatePatch &m) {
    m = IntentStatePatch{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "set", "set"); v && v->is_array())
        for (const auto &x : *v) m.set.push_back(x.get<FieldValue>());
    if (const auto *v = pick(j, "clear", "clear"); v && v->is_array())
        for (const auto &x : *v) m.clear.push_back(numFrom<uint32_t>(x));
}

void to_json(nlohmann::json &j, const IntentStateSetAdd &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (m.field != 0) j["field"] = m.field;
    if (!m.element.empty()) j["element"] = toBase64(m.element);
}

void from_json(const nlohmann::json &j, IntentStateSetAdd &m) {
    m = IntentStateSetAdd{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "field", "field")) m.field = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "element", "element")) m.element = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const IntentStateSetRemove &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (m.field != 0) j["field"] = m.field;
    if (!m.element.empty()) j["element"] = toBase64(m.element);
}

void from_json(const nlohmann::json &j, IntentStateSetRemove &m) {
    m = IntentStateSetRemove{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "field", "field")) m.field = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "element", "element")) m.element = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const Peer &m) {
    j = nlohmann::json::object();
    if (const auto *p = std::get_if<1>(&m.kind)) j["user"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["group"] = *p;
}

void from_json(const nlohmann::json &j, Peer &m) {
    m = Peer{};
    if (const auto *v = pick(j, "user", "user")) m.kind.emplace<1>(v->get<UserRef>());
    if (const auto *v = pick(j, "group", "group")) m.kind.emplace<2>(v->get<Ref>());
}

void to_json(nlohmann::json &j, const Root &m) {
    j = nlohmann::json::object();
    if (!m.store_id.empty()) j["store_id"] = toBase64(m.store_id);
    if (m.active_generation != 0) j["active_generation"] = m.active_generation;
    if (m.pending_generation != 0) j["pending_generation"] = m.pending_generation;
    if (!m.wraps.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.wraps) a.push_back(x);
        j["wraps"] = a;
    }
    if (!m.kinds_max_format.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.kinds_max_format) a.push_back(x);
        j["kinds_max_format"] = a;
    }
    if (m.retiring_generation != 0) j["retiring_generation"] = m.retiring_generation;
}

void from_json(const nlohmann::json &j, Root &m) {
    m = Root{};
    if (const auto *v = pick(j, "store_id", "storeId")) m.store_id = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "active_generation", "activeGeneration")) m.active_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "pending_generation", "pendingGeneration")) m.pending_generation = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "wraps", "wraps"); v && v->is_array())
        for (const auto &x : *v) m.wraps.push_back(x.get<Wrap>());
    if (const auto *v = pick(j, "kinds_max_format", "kindsMaxFormat"); v && v->is_array())
        for (const auto &x : *v) m.kinds_max_format.push_back(x.get<KindFormat>());
    if (const auto *v = pick(j, "retiring_generation", "retiringGeneration")) m.retiring_generation = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const StateChanged &m) {
    j = nlohmann::json::object();
    if (m.object.has_value()) j["object"] = *m.object;
    if (m.view.has_value()) j["view"] = *m.view;
}

void from_json(const nlohmann::json &j, StateChanged &m) {
    m = StateChanged{};
    if (const auto *v = pick(j, "object", "object")) m.object = (*v).get<ObjectKey>();
    if (const auto *v = pick(j, "view", "view")) m.view = (*v).get<StateObjectView>();
}

void to_json(nlohmann::json &j, const StoreBatch &m) {
    j = nlohmann::json::object();
    if (m.batch_id != 0) j["batch_id"] = std::to_string(m.batch_id);
    if (!m.puts.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.puts) a.push_back(x);
        j["puts"] = a;
    }
    if (!m.deletes.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.deletes) a.push_back(x);
        j["deletes"] = a;
    }
}

void from_json(const nlohmann::json &j, StoreBatch &m) {
    m = StoreBatch{};
    if (const auto *v = pick(j, "batch_id", "batchId")) m.batch_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "puts", "puts"); v && v->is_array())
        for (const auto &x : *v) m.puts.push_back(x.get<StorePut>());
    if (const auto *v = pick(j, "deletes", "deletes"); v && v->is_array())
        for (const auto &x : *v) m.deletes.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const StoreLoaded &m) {
    j = nlohmann::json::object();
    if (m.read_id != 0) j["read_id"] = std::to_string(m.read_id);
    if (!m.entries.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.entries) a.push_back(x);
        j["entries"] = a;
    }
}

void from_json(const nlohmann::json &j, StoreLoaded &m) {
    m = StoreLoaded{};
    if (const auto *v = pick(j, "read_id", "readId")) m.read_id = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "entries", "entries"); v && v->is_array())
        for (const auto &x : *v) m.entries.push_back(x.get<StorePut>());
}

void to_json(nlohmann::json &j, const UnreadChanged &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (m.count != 0) j["count"] = m.count;
    if (m.mention) j["mention"] = m.mention;
}

void from_json(const nlohmann::json &j, UnreadChanged &m) {
    m = UnreadChanged{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "count", "count")) m.count = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "mention", "mention")) m.mention = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const ViewMedia &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (!m.file_id.empty()) j["file_id"] = m.file_id;
    if (!m.blob_domain.empty()) j["blob_domain"] = m.blob_domain;
    if (!m.key.empty()) j["key"] = toBase64(m.key);
    if (!m.nonce.empty()) j["nonce"] = toBase64(m.nonce);
    if (!m.capability.empty()) j["capability"] = toBase64(m.capability);
    if (!m.mime.empty()) j["mime"] = m.mime;
    if (!m.name.empty()) j["name"] = m.name;
    if (m.size != 0) j["size"] = std::to_string(m.size);
    if (m.width != 0) j["width"] = m.width;
    if (m.height != 0) j["height"] = m.height;
    if (m.duration_s != 0) j["duration_s"] = m.duration_s;
    if (!m.thumb.empty()) j["thumb"] = toBase64(m.thumb);
    if (m.caption.has_value()) j["caption"] = *m.caption;
    if (m.spoiler) j["spoiler"] = m.spoiler;
    if (m.caption_above) j["caption_above"] = m.caption_above;
    if (!m.waveform.empty()) j["waveform"] = toBase64(m.waveform);
    if (!m.album_id.empty()) j["album_id"] = toBase64(m.album_id);
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.performer.empty()) j["performer"] = m.performer;
}

void from_json(const nlohmann::json &j, ViewMedia &m) {
    m = ViewMedia{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "file_id", "fileId")) m.file_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "blob_domain", "blobDomain")) m.blob_domain = (*v).get<std::string>();
    if (const auto *v = pick(j, "key", "key")) m.key = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "nonce", "nonce")) m.nonce = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "capability", "capability")) m.capability = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "mime", "mime")) m.mime = (*v).get<std::string>();
    if (const auto *v = pick(j, "name", "name")) m.name = (*v).get<std::string>();
    if (const auto *v = pick(j, "size", "size")) m.size = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "width", "width")) m.width = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "height", "height")) m.height = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "duration_s", "durationS")) m.duration_s = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "thumb", "thumb")) m.thumb = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "caption", "caption")) m.caption = (*v).get<ViewText>();
    if (const auto *v = pick(j, "spoiler", "spoiler")) m.spoiler = (*v).get<bool>();
    if (const auto *v = pick(j, "caption_above", "captionAbove")) m.caption_above = (*v).get<bool>();
    if (const auto *v = pick(j, "waveform", "waveform")) m.waveform = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "album_id", "albumId")) m.album_id = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "performer", "performer")) m.performer = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewSticker &m) {
    j = nlohmann::json::object();
    if (!m.pack.empty()) j["pack"] = m.pack;
    if (!m.sticker_id.empty()) j["sticker_id"] = m.sticker_id;
    if (!m.emoji.empty()) j["emoji"] = m.emoji;
    if (m.media.has_value()) j["media"] = *m.media;
}

void from_json(const nlohmann::json &j, ViewSticker &m) {
    m = ViewSticker{};
    if (const auto *v = pick(j, "pack", "pack")) m.pack = (*v).get<std::string>();
    if (const auto *v = pick(j, "sticker_id", "stickerId")) m.sticker_id = (*v).get<std::string>();
    if (const auto *v = pick(j, "emoji", "emoji")) m.emoji = (*v).get<std::string>();
    if (const auto *v = pick(j, "media", "media")) m.media = (*v).get<ViewMedia>();
}

void to_json(nlohmann::json &j, const CapabilitiesRequest &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
}

void from_json(const nlohmann::json &j, CapabilitiesRequest &m) {
    m = CapabilitiesRequest{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
}

void to_json(nlohmann::json &j, const ComposeContent &m) {
    j = nlohmann::json::object();
    if (!m.reply_to.empty()) j["reply_to"] = toBase64(m.reply_to);
    if (m.silent) j["silent"] = m.silent;
    if (const auto *p = std::get_if<1>(&m.kind)) j["text"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["media"] = *p;
    if (const auto *p = std::get_if<3>(&m.kind)) j["sticker"] = *p;
    if (const auto *p = std::get_if<4>(&m.kind)) j["poll"] = *p;
    if (const auto *p = std::get_if<5>(&m.kind)) j["location"] = *p;
    if (const auto *p = std::get_if<6>(&m.kind)) j["contact"] = *p;
    if (const auto *p = std::get_if<7>(&m.kind)) j["article"] = *p;
}

void from_json(const nlohmann::json &j, ComposeContent &m) {
    m = ComposeContent{};
    if (const auto *v = pick(j, "reply_to", "replyTo")) m.reply_to = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "silent", "silent")) m.silent = (*v).get<bool>();
    if (const auto *v = pick(j, "text", "text")) m.kind.emplace<1>(v->get<ViewText>());
    if (const auto *v = pick(j, "media", "media")) m.kind.emplace<2>(v->get<ViewMedia>());
    if (const auto *v = pick(j, "sticker", "sticker")) m.kind.emplace<3>(v->get<ViewSticker>());
    if (const auto *v = pick(j, "poll", "poll")) m.kind.emplace<4>(v->get<ViewPoll>());
    if (const auto *v = pick(j, "location", "location")) m.kind.emplace<5>(v->get<ViewLocation>());
    if (const auto *v = pick(j, "contact", "contact")) m.kind.emplace<6>(v->get<ViewContact>());
    if (const auto *v = pick(j, "article", "article")) m.kind.emplace<7>(v->get<ViewArticle>());
}

void to_json(nlohmann::json &j, const GroupView &m) {
    j = nlohmann::json::object();
    if (m.group.has_value()) j["group"] = *m.group;
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (!m.title.empty()) j["title"] = m.title;
    if (!m.about.empty()) j["about"] = m.about;
    if (m.photo.has_value()) j["photo"] = *m.photo;
    if (m.members_count != 0) j["members_count"] = m.members_count;
    if (m.my_role != GroupRole{}) j["my_role"] = m.my_role;
    if (m.perms.has_value()) j["perms"] = *m.perms;
    if (m.is_public) j["is_public"] = m.is_public;
    if (!m.invite_links.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.invite_links) a.push_back(x);
        j["invite_links"] = a;
    }
}

void from_json(const nlohmann::json &j, GroupView &m) {
    m = GroupView{};
    if (const auto *v = pick(j, "group", "group")) m.group = (*v).get<Ref>();
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "about", "about")) m.about = (*v).get<std::string>();
    if (const auto *v = pick(j, "photo", "photo")) m.photo = (*v).get<ViewMedia>();
    if (const auto *v = pick(j, "members_count", "membersCount")) m.members_count = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "my_role", "myRole")) m.my_role = (*v).get<GroupRole>();
    if (const auto *v = pick(j, "perms", "perms")) m.perms = (*v).get<GroupPerms>();
    if (const auto *v = pick(j, "is_public", "isPublic")) m.is_public = (*v).get<bool>();
    if (const auto *v = pick(j, "invite_links", "inviteLinks"); v && v->is_array())
        for (const auto &x : *v) m.invite_links.push_back(x.get<std::string>());
}

void to_json(nlohmann::json &j, const HistoryPageRequest &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (m.anchor.has_value()) j["anchor"] = *m.anchor;
    if (m.direction != PageDirection{}) j["direction"] = m.direction;
    if (m.limit != 0) j["limit"] = m.limit;
}

void from_json(const nlohmann::json &j, HistoryPageRequest &m) {
    m = HistoryPageRequest{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "anchor", "anchor")) m.anchor = (*v).get<MsgAnchor>();
    if (const auto *v = pick(j, "direction", "direction")) m.direction = (*v).get<PageDirection>();
    if (const auto *v = pick(j, "limit", "limit")) m.limit = numFrom<uint32_t>((*v));
}

void to_json(nlohmann::json &j, const IntentDelete &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.targets.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.targets) a.push_back(toBase64(x));
        j["targets"] = a;
    }
    if (m.scope != DeleteScope{}) j["scope"] = m.scope;
}

void from_json(const nlohmann::json &j, IntentDelete &m) {
    m = IntentDelete{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "targets", "targets"); v && v->is_array())
        for (const auto &x : *v) m.targets.push_back(fromBase64(x.get<std::string>()));
    if (const auto *v = pick(j, "scope", "scope")) m.scope = (*v).get<DeleteScope>();
}

void to_json(nlohmann::json &j, const IntentEdit &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.target.empty()) j["target"] = toBase64(m.target);
    if (m.content.has_value()) j["content"] = *m.content;
}

void from_json(const nlohmann::json &j, IntentEdit &m) {
    m = IntentEdit{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "target", "target")) m.target = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "content", "content")) m.content = (*v).get<ComposeContent>();
}

void to_json(nlohmann::json &j, const IntentPin &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.target.empty()) j["target"] = toBase64(m.target);
    if (m.on) j["on"] = m.on;
}

void from_json(const nlohmann::json &j, IntentPin &m) {
    m = IntentPin{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "target", "target")) m.target = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "on", "on")) m.on = (*v).get<bool>();
}

void to_json(nlohmann::json &j, const IntentReact &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.target.empty()) j["target"] = toBase64(m.target);
    if (!m.emoji.empty()) j["emoji"] = m.emoji;
}

void from_json(const nlohmann::json &j, IntentReact &m) {
    m = IntentReact{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "target", "target")) m.target = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "emoji", "emoji")) m.emoji = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const IntentRead &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (m.up_to.has_value()) j["up_to"] = *m.up_to;
}

void from_json(const nlohmann::json &j, IntentRead &m) {
    m = IntentRead{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "up_to", "upTo")) m.up_to = (*v).get<MsgAnchor>();
}

void to_json(nlohmann::json &j, const IntentSend &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (m.content.has_value()) j["content"] = *m.content;
    if (m.schedule_at_ms != 0) j["schedule_at_ms"] = std::to_string(m.schedule_at_ms);
}

void from_json(const nlohmann::json &j, IntentSend &m) {
    m = IntentSend{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "content", "content")) m.content = (*v).get<ComposeContent>();
    if (const auto *v = pick(j, "schedule_at_ms", "scheduleAtMs")) m.schedule_at_ms = numFrom<int64_t>((*v));
}

void to_json(nlohmann::json &j, const IntentTyping &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.action.empty()) j["action"] = m.action;
}

void from_json(const nlohmann::json &j, IntentTyping &m) {
    m = IntentTyping{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "action", "action")) m.action = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const MessageRemove &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.id.empty()) j["id"] = toBase64(m.id);
}

void from_json(const nlohmann::json &j, MessageRemove &m) {
    m = MessageRemove{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "id", "id")) m.id = fromBase64((*v).get<std::string>());
}

void to_json(nlohmann::json &j, const Need &m) {
    j = nlohmann::json::object();
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.detail.empty()) j["detail"] = m.detail;
}

void from_json(const nlohmann::json &j, Need &m) {
    m = Need{};
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "detail", "detail")) m.detail = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const Notice &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.kind.empty()) j["kind"] = m.kind;
    if (!m.detail.empty()) j["detail"] = m.detail;
}

void from_json(const nlohmann::json &j, Notice &m) {
    m = Notice{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "kind", "kind")) m.kind = (*v).get<std::string>();
    if (const auto *v = pick(j, "detail", "detail")) m.detail = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ViewBody &m) {
    j = nlohmann::json::object();
    if (const auto *p = std::get_if<1>(&m.kind)) j["text"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["media"] = *p;
    if (const auto *p = std::get_if<3>(&m.kind)) j["sticker"] = *p;
    if (const auto *p = std::get_if<4>(&m.kind)) j["poll"] = *p;
    if (const auto *p = std::get_if<5>(&m.kind)) j["location"] = *p;
    if (const auto *p = std::get_if<6>(&m.kind)) j["contact"] = *p;
    if (const auto *p = std::get_if<7>(&m.kind)) j["call"] = *p;
    if (const auto *p = std::get_if<8>(&m.kind)) j["task_offer"] = *p;
    if (const auto *p = std::get_if<9>(&m.kind)) j["article"] = *p;
    if (const auto *p = std::get_if<10>(&m.kind)) j["cloud_invite"] = *p;
    if (const auto *p = std::get_if<11>(&m.kind)) j["service"] = *p;
}

void from_json(const nlohmann::json &j, ViewBody &m) {
    m = ViewBody{};
    if (const auto *v = pick(j, "text", "text")) m.kind.emplace<1>(v->get<ViewText>());
    if (const auto *v = pick(j, "media", "media")) m.kind.emplace<2>(v->get<ViewMedia>());
    if (const auto *v = pick(j, "sticker", "sticker")) m.kind.emplace<3>(v->get<ViewSticker>());
    if (const auto *v = pick(j, "poll", "poll")) m.kind.emplace<4>(v->get<ViewPoll>());
    if (const auto *v = pick(j, "location", "location")) m.kind.emplace<5>(v->get<ViewLocation>());
    if (const auto *v = pick(j, "contact", "contact")) m.kind.emplace<6>(v->get<ViewContact>());
    if (const auto *v = pick(j, "call", "call")) m.kind.emplace<7>(v->get<ViewCall>());
    if (const auto *v = pick(j, "task_offer", "taskOffer")) m.kind.emplace<8>(v->get<ViewTaskOffer>());
    if (const auto *v = pick(j, "article", "article")) m.kind.emplace<9>(v->get<ViewArticle>());
    if (const auto *v = pick(j, "cloud_invite", "cloudInvite")) m.kind.emplace<10>(v->get<ViewCloudInvite>());
    if (const auto *v = pick(j, "service", "service")) m.kind.emplace<11>(v->get<ViewService>());
}

void to_json(nlohmann::json &j, const Intent &m) {
    j = nlohmann::json::object();
    if (const auto *p = std::get_if<1>(&m.kind)) j["send"] = *p;
    if (const auto *p = std::get_if<2>(&m.kind)) j["edit"] = *p;
    if (const auto *p = std::get_if<3>(&m.kind)) j["delete_messages"] = *p;
    if (const auto *p = std::get_if<4>(&m.kind)) j["react"] = *p;
    if (const auto *p = std::get_if<5>(&m.kind)) j["pin"] = *p;
    if (const auto *p = std::get_if<6>(&m.kind)) j["read"] = *p;
    if (const auto *p = std::get_if<7>(&m.kind)) j["typing"] = *p;
    if (const auto *p = std::get_if<8>(&m.kind)) j["state_patch"] = *p;
    if (const auto *p = std::get_if<9>(&m.kind)) j["state_create"] = *p;
    if (const auto *p = std::get_if<10>(&m.kind)) j["state_delete"] = *p;
    if (const auto *p = std::get_if<11>(&m.kind)) j["state_set_add"] = *p;
    if (const auto *p = std::get_if<12>(&m.kind)) j["state_set_remove"] = *p;
    if (const auto *p = std::get_if<13>(&m.kind)) j["group_create"] = *p;
    if (const auto *p = std::get_if<14>(&m.kind)) j["group_change"] = *p;
    if (const auto *p = std::get_if<15>(&m.kind)) j["group_join_by_link"] = *p;
    if (const auto *p = std::get_if<16>(&m.kind)) j["domain_op"] = *p;
    if (const auto *p = std::get_if<17>(&m.kind)) j["fave_sticker"] = *p;
    if (const auto *p = std::get_if<18>(&m.kind)) j["rotate_ssk"] = *p;
    if (const auto *p = std::get_if<19>(&m.kind)) j["revoke"] = *p;
}

void from_json(const nlohmann::json &j, Intent &m) {
    m = Intent{};
    if (const auto *v = pick(j, "send", "send")) m.kind.emplace<1>(v->get<IntentSend>());
    if (const auto *v = pick(j, "edit", "edit")) m.kind.emplace<2>(v->get<IntentEdit>());
    if (const auto *v = pick(j, "delete_messages", "deleteMessages")) m.kind.emplace<3>(v->get<IntentDelete>());
    if (const auto *v = pick(j, "react", "react")) m.kind.emplace<4>(v->get<IntentReact>());
    if (const auto *v = pick(j, "pin", "pin")) m.kind.emplace<5>(v->get<IntentPin>());
    if (const auto *v = pick(j, "read", "read")) m.kind.emplace<6>(v->get<IntentRead>());
    if (const auto *v = pick(j, "typing", "typing")) m.kind.emplace<7>(v->get<IntentTyping>());
    if (const auto *v = pick(j, "state_patch", "statePatch")) m.kind.emplace<8>(v->get<IntentStatePatch>());
    if (const auto *v = pick(j, "state_create", "stateCreate")) m.kind.emplace<9>(v->get<IntentStateCreate>());
    if (const auto *v = pick(j, "state_delete", "stateDelete")) m.kind.emplace<10>(v->get<IntentStateDelete>());
    if (const auto *v = pick(j, "state_set_add", "stateSetAdd")) m.kind.emplace<11>(v->get<IntentStateSetAdd>());
    if (const auto *v = pick(j, "state_set_remove", "stateSetRemove")) m.kind.emplace<12>(v->get<IntentStateSetRemove>());
    if (const auto *v = pick(j, "group_create", "groupCreate")) m.kind.emplace<13>(v->get<IntentGroupCreate>());
    if (const auto *v = pick(j, "group_change", "groupChange")) m.kind.emplace<14>(v->get<IntentGroupChange>());
    if (const auto *v = pick(j, "group_join_by_link", "groupJoinByLink")) m.kind.emplace<15>(v->get<IntentGroupJoinByLink>());
    if (const auto *v = pick(j, "domain_op", "domainOp")) m.kind.emplace<16>(v->get<IntentDomainOp>());
    if (const auto *v = pick(j, "fave_sticker", "faveSticker")) m.kind.emplace<17>(v->get<IntentFaveSticker>());
    if (const auto *v = pick(j, "rotate_ssk", "rotateSsk")) m.kind.emplace<18>(v->get<IntentRotateSsk>());
    if (const auto *v = pick(j, "revoke", "revoke")) m.kind.emplace<19>(v->get<IntentRevoke>());
}

void to_json(nlohmann::json &j, const MessageView &m) {
    j = nlohmann::json::object();
    if (!m.id.empty()) j["id"] = toBase64(m.id);
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.from.empty()) j["from"] = m.from;
    if (m.ts_ms != 0) j["ts_ms"] = std::to_string(m.ts_ms);
    if (m.edited_ts_ms != 0) j["edited_ts_ms"] = std::to_string(m.edited_ts_ms);
    if (m.outgoing) j["outgoing"] = m.outgoing;
    if (m.disposition != Disposition{}) j["disposition"] = m.disposition;
    if (m.body.has_value()) j["body"] = *m.body;
    if (!m.reply_to.empty()) j["reply_to"] = toBase64(m.reply_to);
    if (!m.forward_from.empty()) j["forward_from"] = m.forward_from;
    if (!m.reactions.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.reactions) a.push_back(x);
        j["reactions"] = a;
    }
    if (m.pinned) j["pinned"] = m.pinned;
    if (m.ttl_secs != 0) j["ttl_secs"] = m.ttl_secs;
    if (m.delivery != Delivery{}) j["delivery"] = m.delivery;
    if (!m.forward_name.empty()) j["forward_name"] = m.forward_name;
    if (m.reply_quote.has_value()) j["reply_quote"] = *m.reply_quote;
    if (m.silent) j["silent"] = m.silent;
    if (m.order != 0) j["order"] = std::to_string(m.order);
    if (!m.wire.empty()) j["wire"] = m.wire;
}

void from_json(const nlohmann::json &j, MessageView &m) {
    m = MessageView{};
    if (const auto *v = pick(j, "id", "id")) m.id = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "from", "from")) m.from = (*v).get<std::string>();
    if (const auto *v = pick(j, "ts_ms", "tsMs")) m.ts_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "edited_ts_ms", "editedTsMs")) m.edited_ts_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "outgoing", "outgoing")) m.outgoing = (*v).get<bool>();
    if (const auto *v = pick(j, "disposition", "disposition")) m.disposition = (*v).get<Disposition>();
    if (const auto *v = pick(j, "body", "body")) m.body = (*v).get<ViewBody>();
    if (const auto *v = pick(j, "reply_to", "replyTo")) m.reply_to = fromBase64((*v).get<std::string>());
    if (const auto *v = pick(j, "forward_from", "forwardFrom")) m.forward_from = (*v).get<std::string>();
    if (const auto *v = pick(j, "reactions", "reactions"); v && v->is_array())
        for (const auto &x : *v) m.reactions.push_back(x.get<ViewReaction>());
    if (const auto *v = pick(j, "pinned", "pinned")) m.pinned = (*v).get<bool>();
    if (const auto *v = pick(j, "ttl_secs", "ttlSecs")) m.ttl_secs = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "delivery", "delivery")) m.delivery = (*v).get<Delivery>();
    if (const auto *v = pick(j, "forward_name", "forwardName")) m.forward_name = (*v).get<std::string>();
    if (const auto *v = pick(j, "reply_quote", "replyQuote")) m.reply_quote = (*v).get<ViewText>();
    if (const auto *v = pick(j, "silent", "silent")) m.silent = (*v).get<bool>();
    if (const auto *v = pick(j, "order", "order")) m.order = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "wire", "wire")) m.wire = (*v).get<std::string>();
}

void to_json(nlohmann::json &j, const ChatView &m) {
    j = nlohmann::json::object();
    if (m.chat.has_value()) j["chat"] = *m.chat;
    if (!m.title.empty()) j["title"] = m.title;
    if (m.photo.has_value()) j["photo"] = *m.photo;
    if (m.last.has_value()) j["last"] = *m.last;
    if (m.unread != 0) j["unread"] = m.unread;
    if (m.mention) j["mention"] = m.mention;
    if (m.pinned_rank != 0) j["pinned_rank"] = m.pinned_rank;
    if (m.archived) j["archived"] = m.archived;
    if (m.muted_until_ms != 0) j["muted_until_ms"] = std::to_string(m.muted_until_ms);
    if (!m.draft.empty()) j["draft"] = m.draft;
    if (!m.folder_ids.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.folder_ids) a.push_back(x);
        j["folder_ids"] = a;
    }
}

void from_json(const nlohmann::json &j, ChatView &m) {
    m = ChatView{};
    if (const auto *v = pick(j, "chat", "chat")) m.chat = (*v).get<Peer>();
    if (const auto *v = pick(j, "title", "title")) m.title = (*v).get<std::string>();
    if (const auto *v = pick(j, "photo", "photo")) m.photo = (*v).get<ViewMedia>();
    if (const auto *v = pick(j, "last", "last")) m.last = (*v).get<MessageView>();
    if (const auto *v = pick(j, "unread", "unread")) m.unread = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "mention", "mention")) m.mention = (*v).get<bool>();
    if (const auto *v = pick(j, "pinned_rank", "pinnedRank")) m.pinned_rank = numFrom<uint32_t>((*v));
    if (const auto *v = pick(j, "archived", "archived")) m.archived = (*v).get<bool>();
    if (const auto *v = pick(j, "muted_until_ms", "mutedUntilMs")) m.muted_until_ms = numFrom<int64_t>((*v));
    if (const auto *v = pick(j, "draft", "draft")) m.draft = (*v).get<std::string>();
    if (const auto *v = pick(j, "folder_ids", "folderIds"); v && v->is_array())
        for (const auto &x : *v) m.folder_ids.push_back(numFrom<uint32_t>(x));
}

void to_json(nlohmann::json &j, const HistoryPage &m) {
    j = nlohmann::json::object();
    if (!m.rows.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.rows) a.push_back(x);
        j["rows"] = a;
    }
    if (m.older.has_value()) j["older"] = *m.older;
    if (m.newer.has_value()) j["newer"] = *m.newer;
    if (m.has_older) j["has_older"] = m.has_older;
    if (m.has_newer) j["has_newer"] = m.has_newer;
    if (m.pending.has_value()) j["pending"] = *m.pending;
}

void from_json(const nlohmann::json &j, HistoryPage &m) {
    m = HistoryPage{};
    if (const auto *v = pick(j, "rows", "rows"); v && v->is_array())
        for (const auto &x : *v) m.rows.push_back(x.get<MessageView>());
    if (const auto *v = pick(j, "older", "older")) m.older = (*v).get<MsgAnchor>();
    if (const auto *v = pick(j, "newer", "newer")) m.newer = (*v).get<MsgAnchor>();
    if (const auto *v = pick(j, "has_older", "hasOlder")) m.has_older = (*v).get<bool>();
    if (const auto *v = pick(j, "has_newer", "hasNewer")) m.has_newer = (*v).get<bool>();
    if (const auto *v = pick(j, "pending", "pending")) m.pending = (*v).get<StoreReads>();
}

void to_json(nlohmann::json &j, const ModelChange &m) {
    j = nlohmann::json::object();
    if (const auto *p = std::get_if<1>(&m.change)) j["chat_upsert"] = *p;
    if (const auto *p = std::get_if<2>(&m.change)) j["chat_remove"] = *p;
    if (const auto *p = std::get_if<3>(&m.change)) j["message_upsert"] = *p;
    if (const auto *p = std::get_if<4>(&m.change)) j["message_remove"] = *p;
    if (const auto *p = std::get_if<5>(&m.change)) j["state_changed"] = *p;
    if (const auto *p = std::get_if<6>(&m.change)) j["group_changed"] = *p;
    if (const auto *p = std::get_if<7>(&m.change)) j["notice"] = *p;
    if (const auto *p = std::get_if<8>(&m.change)) j["unread_changed"] = *p;
    if (const auto *p = std::get_if<9>(&m.change)) j["write_blocked"] = *p;
    if (const auto *p = std::get_if<10>(&m.change)) j["needs"] = *p;
    if (const auto *p = std::get_if<11>(&m.change)) j["client_events"] = *p;
}

void from_json(const nlohmann::json &j, ModelChange &m) {
    m = ModelChange{};
    if (const auto *v = pick(j, "chat_upsert", "chatUpsert")) m.change.emplace<1>(v->get<ChatView>());
    if (const auto *v = pick(j, "chat_remove", "chatRemove")) m.change.emplace<2>(v->get<Peer>());
    if (const auto *v = pick(j, "message_upsert", "messageUpsert")) m.change.emplace<3>(v->get<MessageView>());
    if (const auto *v = pick(j, "message_remove", "messageRemove")) m.change.emplace<4>(v->get<MessageRemove>());
    if (const auto *v = pick(j, "state_changed", "stateChanged")) m.change.emplace<5>(v->get<StateChanged>());
    if (const auto *v = pick(j, "group_changed", "groupChanged")) m.change.emplace<6>(v->get<GroupView>());
    if (const auto *v = pick(j, "notice", "notice")) m.change.emplace<7>(v->get<Notice>());
    if (const auto *v = pick(j, "unread_changed", "unreadChanged")) m.change.emplace<8>(v->get<UnreadChanged>());
    if (const auto *v = pick(j, "write_blocked", "writeBlocked")) m.change.emplace<9>(v->get<WriteBlocked>());
    if (const auto *v = pick(j, "needs", "needs")) m.change.emplace<10>(v->get<Need>());
    if (const auto *v = pick(j, "client_events", "clientEvents")) m.change.emplace<11>(v->get<ClientEvents>());
}

void to_json(nlohmann::json &j, const ModelDelta &m) {
    j = nlohmann::json::object();
    if (m.revision != 0) j["revision"] = std::to_string(m.revision);
    if (!m.changes.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.changes) a.push_back(x);
        j["changes"] = a;
    }
}

void from_json(const nlohmann::json &j, ModelDelta &m) {
    m = ModelDelta{};
    if (const auto *v = pick(j, "revision", "revision")) m.revision = numFrom<uint64_t>((*v));
    if (const auto *v = pick(j, "changes", "changes"); v && v->is_array())
        for (const auto &x : *v) m.changes.push_back(x.get<ModelChange>());
}

void to_json(nlohmann::json &j, const Outcome &m) {
    j = nlohmann::json::object();
    if (m.store_batch.has_value()) j["store_batch"] = *m.store_batch;
    if (!m.store_reads.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.store_reads) a.push_back(x);
        j["store_reads"] = a;
    }
    if (!m.requests.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.requests) a.push_back(x);
        j["requests"] = a;
    }
    if (m.delta.has_value()) j["delta"] = *m.delta;
    if (m.open.has_value()) j["open"] = *m.open;
}

void from_json(const nlohmann::json &j, Outcome &m) {
    m = Outcome{};
    if (const auto *v = pick(j, "store_batch", "storeBatch")) m.store_batch = (*v).get<StoreBatch>();
    if (const auto *v = pick(j, "store_reads", "storeReads"); v && v->is_array())
        for (const auto &x : *v) m.store_reads.push_back(x.get<StoreReads>());
    if (const auto *v = pick(j, "requests", "requests"); v && v->is_array())
        for (const auto &x : *v) m.requests.push_back(x.get<OutRequest>());
    if (const auto *v = pick(j, "delta", "delta")) m.delta = (*v).get<ModelDelta>();
    if (const auto *v = pick(j, "open", "open")) m.open = (*v).get<OpenResult>();
}

void to_json(nlohmann::json &j, const ChatPage &m) {
    j = nlohmann::json::object();
    if (!m.chats.empty()) {
        auto a = nlohmann::json::array();
        for (const auto &x : m.chats) a.push_back(x);
        j["chats"] = a;
    }
    if (m.next.has_value()) j["next"] = *m.next;
}

void from_json(const nlohmann::json &j, ChatPage &m) {
    m = ChatPage{};
    if (const auto *v = pick(j, "chats", "chats"); v && v->is_array())
        for (const auto &x : *v) m.chats.push_back(x.get<ChatView>());
    if (const auto *v = pick(j, "next", "next")) m.next = (*v).get<ChatAnchor>();
}

} // namespace parvane::gen
