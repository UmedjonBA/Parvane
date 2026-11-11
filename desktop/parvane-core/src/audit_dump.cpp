// Parvane fork: выгрузка «ничего не потеряно» (spec 035, T007) — см. include/parvane/audit_dump.h. Порт web
// `auditDump.ts`: одинаковые входы дают побайтно одинаковые строки (`conformance/audit/`).
#include "parvane/audit_dump.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <set>

#include <openssl/sha.h>

#include "parvane/history_sync.h"

namespace parvane::audit {
namespace {

// Число как JSON.stringify: целое — без дробной части, прочее — кратчайшая запись nlohmann
std::string numberJson(const json &value) {
    if (value.is_number_integer()) return value.dump();
    const double d = value.get<double>();
    if (!std::isfinite(d)) return "null";
    if (d == std::floor(d) && std::fabs(d) < 9007199254740992.0) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.0f", d);
        return buf;
    }
    return value.dump();
}

std::string stringJson(const std::string &s) {
    return json(s).dump(-1, ' ', false, json::error_handler_t::replace);
}

std::string scalarKey(const json &element, const std::vector<std::string> &fields) {
    for (const auto &field : fields) {
        const auto it = element.find(field);
        if (it == element.end()) continue;
        if (it->is_string()) return it->get<std::string>();
        if (it->is_number()) return numberJson(*it);
    }
    return {};
}

struct Pending {
    std::string kind;
    std::string key;
    json value;
};

const std::vector<std::string> kElementIdFields = {"id", "op_id", "call_id", "link_id", "set_id"};
const std::vector<std::string> kElementNameFields = {"list", "day", "key", "address"};
const std::set<std::string> kUnreadableKinds = {"encrypted", "group_encrypted", "unsupported"};

void pushSnapshot(std::vector<Pending> &out, const std::string &snapshotJson) {
    const auto snapshot = json::parse(snapshotJson);
    if (!snapshot.is_object()) return;
    for (const auto &[field, value] : snapshot.items()) {
        if (value.is_null()) continue;
        if (value.is_array()) {
            for (const auto &element : value) {
                std::string kind = field == "drafts" ? "draft" : field == "scheduled" ? "scheduled" : "state:" + field;
                if (field == "sticker_packs") {
                    const auto setId = element.is_object() ? element.value("set_id", std::string()) : std::string();
                    kind = setId.rfind("g:", 0) == 0 ? "saved-gif" : "sticker-pack";
                }
                out.push_back({kind, elementKey(element), element});
            }
        } else {
            out.push_back({"state:" + field, "_", value});
        }
    }
}

void pushPlanner(std::vector<Pending> &out, const std::string &plannerJson) {
    const auto planner = json::parse(plannerJson);
    if (!planner.is_object()) return;
    for (const auto &[field, value] : planner.items()) {
        if (field == "headSeq" || field == "sizeBytes" || value.is_null()) continue;
        if (value.is_array()) {
            for (const auto &element : value) out.push_back({"planner:" + field, elementKey(element), element});
        } else {
            out.push_back({"planner:" + field, "_", value});
        }
    }
}

bool endsWithMd(std::string name) {
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return name.size() >= 3 && name.compare(name.size() - 3, 3, ".md") == 0;
}

void pushCloud(std::vector<Pending> &out, const json &container, const std::string &stateJson) {
    const auto id = container.value("id", std::string());
    json value = json::object();
    for (const auto *field : {"name", "owner", "role", "hasKey"}) {
        if (container.contains(field)) value[field] = container[field];
    }
    if (container.contains("members") && container["members"].is_array()) {
        auto members = container["members"];
        std::sort(members.begin(), members.end(),
                  [](const json &a, const json &b) { return canonicalJson(a) < canonicalJson(b); });
        value["members"] = members;
    }
    out.push_back({"cloud:container", id, value});
    if (stateJson.empty()) return;
    const auto state = json::parse(stateJson);
    if (!state.is_object() || !state.contains("nodes") || !state["nodes"].is_array()) return;
    for (const auto &node : state["nodes"]) {
        const auto kindValue = node.contains("kind") && node["kind"].is_string() ? node["kind"].get<std::string>()
                                                                                  : std::string("null");
        const auto name = node.contains("name") && node["name"].is_string() ? node["name"].get<std::string>()
                                                                            : std::string();
        const bool isFile = kindValue != "folder";
        const std::string kind = isFile && endsWithMd(name) ? "note" : "cloud:" + kindValue;
        const auto nodeId = node.contains("id") && node["id"].is_string() ? node["id"].get<std::string>()
                                                                          : canonicalJson(node.value("id", json()));
        out.push_back({kind, id + "/" + nodeId, node});
    }
}

std::string toStringField(const json &value) {
    if (value.is_string()) return value.get<std::string>();
    if (value.is_number()) return numberJson(value);
    return "0";
}

} // namespace

std::string canonicalJson(const json &value) {
    switch (value.type()) {
    case json::value_t::null:
    case json::value_t::discarded:
        return "null";
    case json::value_t::boolean:
        return value.get<bool>() ? "true" : "false";
    case json::value_t::number_integer:
    case json::value_t::number_unsigned:
    case json::value_t::number_float:
        return numberJson(value);
    case json::value_t::string:
        return stringJson(value.get<std::string>());
    case json::value_t::array: {
        std::string out = "[";
        bool first = true;
        for (const auto &item : value) {
            if (!first) out += ',';
            first = false;
            out += canonicalJson(item);
        }
        return out + "]";
    }
    case json::value_t::object: {
        // nlohmann хранит ключи объекта в std::map — уже по возрастанию байтов
        std::string out = "{";
        bool first = true;
        for (const auto &[key, inner] : value.items()) {
            if (inner.is_null()) continue;
            if (!first) out += ',';
            first = false;
            out += stringJson(key) + ":" + canonicalJson(inner);
        }
        return out + "}";
    }
    case json::value_t::binary:
        return "null";
    }
    return "null";
}

std::string sha256Hex(const std::string &data) {
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(data.data()), data.size(), digest);
    static const char *kHex = "0123456789abcdef";
    std::string out;
    out.reserve(SHA256_DIGEST_LENGTH * 2);
    for (unsigned char byte : digest) {
        out += kHex[byte >> 4];
        out += kHex[byte & 15];
    }
    return out;
}

std::string statePeerKey(const json &peer) {
    if (!peer.is_object()) return {};
    if (const auto user = peer.find("user"); user != peer.end() && user->is_object()) {
        if (const auto a = user->find("address"); a != user->end() && a->is_string()) return "u:" + a->get<std::string>();
    }
    if (const auto group = peer.find("group"); group != peer.end() && group->is_object()) {
        if (const auto id = group->find("id"); id != group->end() && id->is_string()) return "g:" + id->get<std::string>();
    }
    return {};
}

std::string elementKey(const json &element) {
    if (element.is_string()) return element.get<std::string>();
    if (element.is_number()) return numberJson(element);
    if (element.is_object()) {
        auto key = scalarKey(element, kElementIdFields);
        if (key.empty() && element.contains("peer")) key = statePeerKey(element["peer"]);
        if (key.empty()) key = statePeerKey(element);
        if (key.empty()) {
            if (const auto ref = element.find("ref"); ref != element.end() && ref->is_object()) {
                if (const auto id = ref->find("id"); id != ref->end() && id->is_string()) key = "r:" + id->get<std::string>();
            }
        }
        if (key.empty()) key = scalarKey(element, kElementNameFields);
        if (!key.empty()) return key;
    }
    return "h:" + sha256Hex(canonicalJson(element)).substr(0, 16);
}

void addModelRows(Sources &sources, const history::ModelRows &rows) {
    for (auto &state : rows.all()) sources.rows.push_back(std::move(state));
    for (auto &mark : rows.marks()) sources.marks.push_back(std::move(mark));
}

std::vector<Line> build(const Sources &src) {
    const auto view = src.view ? src.view : [](const json &state) {
        return history::call("historyView", json{{"state", state}});
    };
    const auto chatKey = src.chatKey ? src.chatKey : [](const json &peer) { return history::chatKeyOf(peer); };

    std::vector<Pending> out;
    std::map<std::string, std::string> chats;  // ключ → тип
    std::map<std::string, std::pair<int, int>> readable;
    std::set<std::string> seenRows;

    for (const auto &state : src.rows) {
        auto v = view(state);
        auto key = v.value("chatKey", std::string());
        if (key.empty()) key = chatKey(state.value("chat", json()));
        if (key.empty()) continue;
        auto id = v.value("id", std::string());
        if (id.empty()) id = state.value("target", std::string());
        seenRows.insert(id);
        chats[key] = key.rfind("g:", 0) == 0 ? "group" : "direct";
        const bool visible = v.value("visible", false);
        std::string bodyKind;
        if (v.contains("body") && v["body"].is_object() && v["body"].contains("kind")) {
            const auto &k = v["body"]["kind"];
            bodyKind = k.is_string() ? k.get<std::string>() : canonicalJson(k);
        }
        v.erase("id");
        v.erase("chat");
        v.erase("chatKey");
        out.push_back({"message", key + "/" + id, v});
        if (visible) {
            auto &counts = readable[key];
            counts.first += 1;
            if (!kUnreadableKinds.count(bodyKind)) counts.second += 1;
        }
    }

    for (const auto &mark : src.marks) {
        const auto key = chatKey(mark.value("chat", json()));
        if (key.empty()) continue;
        out.push_back({"read-mark", key,
                       json{{"up_to_ts_ms", toStringField(mark.value("up_to_ts_ms", json("0")))},
                            {"up_to_id", mark.value("up_to_id", json())}}});
    }

    for (const auto &entry : src.ownJournal) {
        const auto id = entry.value("id", std::string());
        if (seenRows.count(id)) continue;
        json value = json::object();
        for (const auto *field : {"to", "ts", "content", "reply_to"}) {
            if (entry.contains(field)) value[field] = entry[field];
        }
        out.push_back({"outbox", id, value});
    }

    if (!src.stateSnapshot.empty()) pushSnapshot(out, src.stateSnapshot);
    if (!src.plannerState.empty()) pushPlanner(out, src.plannerState);
    for (const auto &[container, state] : src.cloud) pushCloud(out, container, state);

    for (const auto &[hex, info] : src.groups) {
        chats["g:" + hex] = "group";
        // epochStale — отметка устройства «пора начать новую эпоху», не сведения группы
        auto value = info;
        if (value.is_object()) value.erase("epochStale");
        out.push_back({"group", "g:" + hex, value});
    }
    for (const auto &log : src.deviceLogs) {
        out.push_back({"device-log-head", log.value("user", std::string()),
                       json{{"version", log.value("version", json(0))}, {"devices", log.value("devices", json())}}});
    }
    for (const auto &[key, type] : chats) out.push_back({"chat", key, json{{"type", type}}});
    for (const auto &[key, counts] : readable) {
        out.push_back({"key-material", key, json{{"rows", counts.first}, {"readable", counts.second}}});
    }
    out.push_back({"key-material", "account", src.accountKeys});

    std::vector<Line> lines;
    lines.reserve(out.size());
    for (const auto &p : out) lines.push_back({p.kind, p.key, sha256Hex(canonicalJson(p.value))});
    std::sort(lines.begin(), lines.end(), [](const Line &a, const Line &b) {
        if (a.kind != b.kind) return a.kind < b.kind;
        if (a.key != b.key) return a.key < b.key;
        return a.digest < b.digest;
    });
    return lines;
}

std::string jsonl(const std::vector<Line> &lines) {
    std::string out;
    for (const auto &l : lines) {
        out += "{\"kind\":" + stringJson(l.kind) + ",\"key\":" + stringJson(l.key) + ",\"digest\":" + stringJson(l.digest)
            + "}\n";
    }
    return out;
}

} // namespace parvane::audit
