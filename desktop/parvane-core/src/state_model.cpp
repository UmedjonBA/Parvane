// Parvane fork (spec 035 T125, spec 036): личное состояние через модель движка — см. state_model.h.
#include "parvane/state_model.h"

#include "parvane/engine_host.h"

#include <cctype>
#include <cstring>
#include <map>
#include <set>

namespace parvane::v2 {

namespace {

constexpr int kUnavailable = 11;

const char *const kCodes[] = {
    "ERROR_CODE_UNSPECIFIED", "ERROR_CODE_INVALID",     "ERROR_CODE_FORBIDDEN",       "ERROR_CODE_NOT_FOUND",
    "ERROR_CODE_DUPLICATE",   "ERROR_CODE_RATE_LIMITED", "ERROR_CODE_UPGRADE_REQUIRED", "ERROR_CODE_REVOKED",
    "ERROR_CODE_REAUTH_REQUIRED", "ERROR_CODE_LIMIT",   "ERROR_CODE_FEDERATION_UNAVAILABLE", "ERROR_CODE_UNAVAILABLE",
};

} // namespace

int errorCodeNumber(const std::string &code) {
    for (int i = 1; i < int(sizeof(kCodes) / sizeof(kCodes[0])); ++i) {
        if (code == kCodes[i]) return i;
    }
    return kUnavailable;
}

StateModel::StateModel(std::shared_ptr<engine::Host> host, Runner run) : host_(std::move(host)), run_(std::move(run)) {}

StateModel::~StateModel() = default;

} // namespace parvane::v2

// ── spec 036: личное состояние по видам (см. state_model.h) ──────────────────────────────────────────────────────
namespace parvane::v2::stateview {

namespace {

constexpr char kPrefix[] = "OBJECT_KIND_";

const char *const kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string b64Encode(const std::string &in) {
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) {
            out.push_back(kB64[(val >> bits) & 0x3F]);
            bits -= 6;
        }
    }
    if (bits > -6) out.push_back(kB64[((val << 8) >> (bits + 8)) & 0x3F]);
    while (out.size() % 4) out.push_back('=');
    return out;
}

std::string b64Decode(const std::string &in) {
    std::string out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        const char *p = std::strchr(kB64, c);
        if (c == '=' || !p || !c) break;
        val = (val << 6) + int(p - kB64);
        bits += 6;
        if (bits >= 0) {
            out.push_back(char((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

std::string toHex(const std::string &bytes) {
    static const char d[] = "0123456789abcdef";
    std::string out;
    for (unsigned char c : bytes) {
        out.push_back(d[c >> 4]);
        out.push_back(d[c & 15]);
    }
    return out;
}

std::string fromHex(const std::string &hex) {
    std::string out;
    if (hex.size() % 2) return out;
    for (std::size_t i = 0; i < hex.size(); i += 2) {
        const auto nib = [](char c) {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = nib(hex[i]), lo = nib(hex[i + 1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back(char((hi << 4) | lo));
    }
    return out;
}

} // namespace

std::string kindName(const std::string &kind) {
    if (kind.rfind(kPrefix, 0) == 0) return kind;
    std::string up;
    for (char c : kind) up.push_back(char(std::toupper(static_cast<unsigned char>(c))));
    return kPrefix + up;
}

json objectsOf(const json &view, const std::string &kind) {
    const auto want = kindName(kind);
    auto out = json::array();
    if (!view.is_object() || !view.contains("objects") || !view["objects"].is_array()) return out;
    for (const auto &o : view["objects"]) {
        if (o.is_object() && o.value("kind", std::string()) == want) {
            out.push_back(json{{"key", o.value("key", std::string())},
                               {"value", o.contains("value") ? o["value"] : json::object()},
                               {"marks", o.value("marks", json::array())}});
        }
    }
    return out;
}

std::string peerKeyOf(const json &peer) {
    if (!peer.is_object()) return {};
    if (peer.contains("user") && peer["user"].is_object()) {
        const auto a = peer["user"].value("address", std::string());
        return a.empty() ? std::string() : "u:" + a;
    }
    if (peer.contains("group") && peer["group"].is_object()) {
        const auto id = toHex(b64Decode(peer["group"].value("id", std::string())));
        return id.empty() ? std::string() : "g:" + peer["group"].value("domain", std::string()) + ":" + id;
    }
    return {};
}

json peerOfKey(const std::string &key) {
    if (key.rfind("u:", 0) == 0 && key.size() > 2) return json{{"user", {{"address", key.substr(2)}}}};
    if (key.rfind("g:", 0) != 0) return nullptr;
    const auto colon = key.rfind(':');
    if (colon <= 1) return nullptr;
    const auto id = fromHex(key.substr(colon + 1));
    if (id.empty()) return nullptr;
    return json{{"group", {{"domain", key.substr(2, colon - 2)}, {"id", b64Encode(id)}}}};
}

std::uint64_t markValue(const json &object, std::uint32_t field) {
    if (!object.is_object() || !object.contains("marks") || !object["marks"].is_array()) return 0;
    for (const auto &m : object["marks"]) {
        if (!m.is_object() || m.value("field", 0u) != field) continue;
        std::uint64_t v = 0;
        for (unsigned char c : b64Decode(m.value("value", std::string()))) v = (v << 8) | c;
        return v;
    }
    return 0;
}

std::string markBytes(std::uint64_t value) {
    std::string be;
    for (int i = 7; i >= 0; --i) {
        const auto b = static_cast<char>((value >> (8 * i)) & 0xFF);
        if (be.empty() && b == 0) continue;
        be.push_back(b);
    }
    return b64Encode(be);
}

json snapshotOf(const json &view) {
    json s = json::object();
    // Списки — всегда (пустой список — «в модели нет», как proto3-JSON с умолчаниями): показ снимает пропавшее
    for (const char *f : {"folders", "blocked", "notify", "drafts", "scheduled", "scheduled_sent", "archived", "pinned",
                          "unread_marks", "sticker_packs", "contacts", "cleared"}) {
        s[f] = json::array();
    }
    const auto list = [&](const char *field) -> json & {
        if (!s.contains(field)) s[field] = json::array();
        return s[field];
    };
    if (!view.is_object() || !view.contains("objects") || !view["objects"].is_array()) return s;
    for (const auto &o : view["objects"]) {
        if (!o.is_object()) continue;
        const auto kind = o.value("kind", std::string()).substr(o.value("kind", std::string()).rfind(kPrefix, 0) == 0
                                                                     ? sizeof(kPrefix) - 1 : 0);
        const auto key = o.value("key", std::string());
        const auto value = o.contains("value") && o["value"].is_object() ? o["value"] : json::object();
        if (kind == "FOLDER") list("folders").push_back(value);
        else if (kind == "FOLDER_ORDER") s["folder_order"] = value;
        else if (kind == "BLOCK") list("blocked").push_back(value);
        else if (kind == "PEER_NOTIFY") list("notify").push_back(value);
        else if (kind == "NOTIFY_DEFAULTS") s["notify_defaults"] = value;
        else if (kind == "DRAFT") list("drafts").push_back(value);
        else if (kind == "SCHEDULED") {
            if (markValue(o, 1)) {
                list("scheduled_sent").push_back(b64Encode(fromHex(key)));
            } else if (!value.empty()) {
                list("scheduled").push_back(value);
            }
        } else if (kind == "ARCHIVE" || kind == "UNREAD_MARK") {
            if (auto p = peerOfKey(key); !p.is_null()) list(kind == "ARCHIVE" ? "archived" : "unread_marks").push_back(p);
        } else if (kind == "PIN_LIST") list("pinned").push_back(value);
        else if (kind == "CALL") list("calls").push_back(value);
        else if (kind == "GROUP_INVITE") list("invites").push_back(value);
        else if (kind == "PLANNER_CONTAINER") s["planner_container"] = value;
        else if (kind == "CLOUD_CONTAINER") list("cloud_containers").push_back(value);
        else if (kind == "QUICK_REACTION") s["quick_reaction"] = value;
        else if (kind == "STICKER_PACK" || kind == "SAVED_GIF") list("sticker_packs").push_back(value);
        else if (kind == "CONTACT") list("contacts").push_back(value);
        else if (kind == "CHAT_CLEARED") {
            const auto until = markValue(o, 2);
            if (auto p = peerOfKey(key); !p.is_null() && until > 0) {
                list("cleared").push_back(json{{"peer", p}, {"cleared_until_ms", std::to_string(until)}});
            }
        }
    }
    return s;
}

std::vector<json> setsFor(const std::string &kind, const json &desired, const json &shown) {
    const auto name = kindName(kind);
    std::map<std::string, json> was;
    if (shown.is_array()) {
        for (const auto &o : shown) {
            if (o.is_object()) was[o.value("key", std::string())] = o.contains("value") ? o["value"] : json::object();
        }
    }
    std::vector<json> out;
    std::set<std::string> wanted;
    if (desired.is_array()) {
        for (const auto &o : desired) {
            if (!o.is_object()) continue;
            const auto key = o.value("key", std::string());
            const auto value = o.contains("value") ? o["value"] : json::object();
            wanted.insert(key);
            const auto hit = was.find(key);
            if (hit != was.end() && hit->second == value) continue; // хост этот объект не правил
            json args{{"kind", name}, {"key", key}, {"value", value}};
            if (hit != was.end()) args["base"] = hit->second;
            out.push_back(std::move(args));
        }
    }
    for (const auto &[key, _] : was) {
        if (!wanted.count(key)) out.push_back(json{{"kind", name}, {"key", key}, {"delete", true}});
    }
    return out;
}

json modelEventOf(const std::vector<json> &changes) {
    static const std::set<std::string> kShown{"message_upsert", "message_remove", "chat_upsert", "chat_remove",
                                              "unread_changed", "state_changed", "group_changed"};
    auto list = json::array();
    for (const auto &ch : changes) {
        if (ch.is_object() && ch.size() == 1 && kShown.count(ch.begin().key())) list.push_back(ch);
    }
    if (list.empty()) return nullptr;
    return json{{"type", "model"}, {"changes", std::move(list)}};
}

} // namespace parvane::v2::stateview

// ── StateModel поверх показа по видам (spec 036 T038: без моста `state.v1`) ────────────────────────────────────────
namespace parvane::v2 {

json StateModel::objects() {
    auto v = host_->read("viewStateJson", json{{"kinds", json::array()}});
    if (!v.is_object() || v.contains("error")) return json{{"objects", json::array()}, {"write_blocked", false}};
    return v;
}

json StateModel::snapshot() { return stateview::snapshotOf(objects()); }

json StateModel::favedStickers() {
    auto out = json::array();
    for (const auto &o : stateview::objectsOf(objects(), "FAVED_STICKER")) {
        const auto &v = o["value"];
        if (!v.is_object()) continue;
        const auto added = v.contains("added_ms") ? v["added_ms"] : json("0");
        out.push_back(json{{"set_id", v.value("set_id", std::string())},
                           {"sticker_id", v.value("sticker_id", std::string())},
                           {"added_ms", added.is_string() ? added : json(added.dump())}});
    }
    return out;
}

bool StateModel::writeBlocked() { return objects().value("write_blocked", false); }

bool StateModel::set(const std::string &kind, const std::string &key, const json &value, bool rewrite) {
    json args{{"kind", stateview::kindName(kind)}, {"key", key}, {"value", value.is_null() ? json::object() : value}};
    if (rewrite) args["rewrite"] = true;
    return run_(host_->step("stateSet", args));
}

bool StateModel::mark(const std::string &kind, const std::string &key, std::uint32_t field, std::uint64_t value) {
    if (value == 0) return false;
    return run_(host_->step("stateMark", json{{"kind", stateview::kindName(kind)}, {"key", key}, {"field", field},
                                              {"value", stateview::markBytes(value)}}));
}

bool StateModel::rewrite(const json &view) {
    if (!view.is_object() || !view.contains("objects") || !view["objects"].is_array()) return true;
    bool ok = true;
    for (const auto &o : view["objects"]) {
        if (!o.is_object()) continue;
        const auto kind = o.value("kind", std::string());
        const auto key = o.value("key", std::string());
        const auto value = o.contains("value") && o["value"].is_object() ? o["value"] : json::object();
        const auto marks = o.value("marks", json::array());
        // Отметка без полей (отправленное отложенное, граница очистки) — только отметкой
        if (!value.empty() || marks.empty()) ok = set(kind, key, value, true) && ok;
        for (const auto &m : marks) {
            if (!m.is_object()) continue;
            ok = run_(host_->step("stateMark", json{{"kind", stateview::kindName(kind)}, {"key", key},
                                                    {"field", m.value("field", 0u)}, {"value", m.value("value", std::string())}}))
                && ok;
        }
    }
    return ok;
}

bool StateModel::submit(const json &intent) { return run_(host_->submit(intent)); }

bool StateModel::sync() {
    const auto before = objects().dump();
    run_(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "journal.state"}}));
    return objects().dump() != before;
}

} // namespace parvane::v2
