// Parvane fork: журнал истории аккаунта на клиенте (spec 033) — см. include/parvane/history_sync.h.
#include "parvane/history_sync.h"

#include <algorithm>
#include <cctype>
#include <map>
#include <chrono>
#include <limits>
#include <random>

#include "parvane/engine_host.h"
#include "parvane/storecrypt.h"
#include "parvane/v2_content.h"
#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

namespace parvane::history {

namespace {

constexpr std::size_t kSeenCap = 50000;
constexpr int kSyncPages = 1000;
constexpr int kRejectRetries = 3;
constexpr std::size_t kGetBatch = 64;
constexpr std::size_t kSegmentPartBytes = 120 * 1024;
constexpr std::int64_t kHorizonMs = 180LL * 24 * 3600 * 1000;

std::int64_t i64(const json &v) {
    if (v.is_number_integer()) return v.get<std::int64_t>();
    if (v.is_number()) return static_cast<std::int64_t>(v.get<double>());
    if (v.is_string()) {
        try {
            return std::stoll(v.get<std::string>());
        } catch (...) {
        }
    }
    return 0;
}

std::string str(const json &o, const char *k) {
    return o.is_object() && o.contains(k) && o[k].is_string() ? o[k].get<std::string>() : std::string();
}

const json &field(const json &o, const char *k) {
    static const json null;
    return o.is_object() && o.contains(k) ? o[k] : null;
}

std::string hexOf(const std::string &bytes) {
    static const char *d = "0123456789abcdef";
    std::string out;
    out.reserve(bytes.size() * 2);
    for (unsigned char c : bytes) {
        out.push_back(d[c >> 4]);
        out.push_back(d[c & 15]);
    }
    return out;
}

// Вид операции (ключ oneof) и её тело.
std::pair<std::string, const json *> opKind(const json &op) {
    if (!op.is_object()) return {std::string(), nullptr};
    for (const char *k : {"row", "gone", "edit", "react", "pin", "read", "state", "summary"}) {
        if (op.contains(k) && op[k].is_object()) return {k, &op[k]};
    }
    return {std::string(), nullptr};
}

// (ts, id) > (mts, mid): id — UUID в нижнем регистре (порядок строк = порядок байтов).
bool posAfter(std::int64_t ts, const std::string &id, std::int64_t mts, const std::string &mid) {
    return ts > mts || (ts == mts && id > mid);
}

bool visibleState(const json &s) {
    return s.is_object() && s.contains("row") && s["row"].is_object() && !(s.contains("gone") && s["gone"].is_object());
}

std::string monthOfKey(const std::string &key) {
    const auto bar = key.rfind('|');
    auto m = bar == std::string::npos ? key : key.substr(bar + 1);
    const auto hash = m.find('#');
    return hash == std::string::npos ? m : m.substr(0, hash);
}

std::int64_t systemNowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

} // namespace

// ── чистые функции ───────────────────────────────────────────────────────────────────────────────────────────────

json call(const std::string &name, const json &args) {
    return v2::engineCall(name, args);
}

std::string chatKeyOf(const json &peer) {
    if (!peer.is_object()) return {};
    if (peer.contains("user") && peer["user"].is_object()) {
        const auto a = str(peer["user"], "address");
        return a.empty() ? std::string() : "u:" + a;
    }
    if (peer.contains("group") && peer["group"].is_object()) {
        const auto &g = peer["group"];
        const auto raw = v2::fromBase64Safe(str(g, "id"));
        if (!raw || raw->empty()) return {};
        // Без домена: одна группа под разными доменами — один чат (как `history_chat_key` движка)
        return "g:" + hexOf(*raw);
    }
    return {};
}

std::string chatKeyOfState(const json &state) {
    return chatKeyOf(field(state, "chat"));
}

std::optional<RowPos> rowPos(const json &state) {
    const auto &row = field(state, "row");
    if (!row.is_object()) return std::nullopt;
    RowPos p;
    p.tsMs = i64(field(row, "ts_ms"));
    p.id = str(state, "target");
    if (p.id.empty()) p.id = str(row, "id");
    return p;
}

json markAt(const json &state) {
    const auto p = rowPos(state);
    if (!p || p->id.empty()) return nullptr;
    return json{{"chat", field(state, "chat")}, {"up_to_ts_ms", std::to_string(p->tsMs)}, {"up_to_id", p->id}};
}

json stampOf(std::int64_t tsMs, const std::string &opId) {
    if (opId.empty()) return call("historyNewStamp", tsMs > 0 ? json{{"tsMs", tsMs}} : json::object());
    return json{{"ts_ms", std::to_string(tsMs)}, {"op_id", opId}};
}

json goneOp(const std::string &target, const json &chat, const json &stamp, bool everyone, const std::string &by,
            bool byAdmin) {
    json g{{"target", target}, {"chat", chat}, {"stamp", stamp}, {"scope", everyone ? "GONE_SCOPE_EVERYONE" : "GONE_SCOPE_ME"}};
    if (!by.empty()) g["by"] = by;
    if (byAdmin) g["by_admin"] = true;
    return json{{"gone", g}};
}

json editOp(const std::string &target, const json &chat, const json &stamp, const json &editFields, const std::string &by) {
    json e{{"target", target}, {"chat", chat}, {"stamp", stamp}, {"body", v2::toBase64(editFields.dump())}};
    if (!by.empty()) e["by"] = by;
    return json{{"edit", e}};
}

json reactOp(const std::string &target, const json &chat, const std::string &user, const json &stamp,
             const std::string &emoji) {
    return json{{"react", {{"target", target}, {"chat", chat}, {"user", user}, {"stamp", stamp}, {"emoji", emoji}}}};
}

json pinOp(const std::string &target, const json &chat, const json &stamp, bool pinned) {
    return json{{"pin", {{"target", target}, {"chat", chat}, {"stamp", stamp}, {"pinned", pinned}}}};
}

json rowOpFromWire(const json &wireRow, const json &chat) {
    return call("historyRowFromWire", json{{"row", wireRow}, {"chat", chat}});
}

std::string opTarget(const json &op) {
    const auto [kind, body] = opKind(op);
    if (!body) return {};
    if (kind == "row") return str(*body, "id");
    if (kind == "read" || kind == "summary") return {};
    return str(*body, "target");
}

json opChat(const json &op) {
    const auto [kind, body] = opKind(op);
    if (!body || kind == "summary") return nullptr;
    return field(*body, "chat");
}

// ── строки в модели движка (spec 035 T125) ──────────────────────────────────────────────────────────────────────

namespace {

// Операций в одном вызове модели (граница поля — 4 МиБ JSON), id в одной выборке (`rowsAll.ids` ≤ 10000)
constexpr std::size_t kApplyChunk = 200;
constexpr std::size_t kIdsChunk = 5000;

} // namespace

std::string uuidOfB64(const std::string &b64) {
    const auto raw = v2::fromBase64Safe(b64);
    if (!raw || raw->size() != 16) return {};
    const auto h = hexOf(*raw);
    return h.substr(0, 8) + "-" + h.substr(8, 4) + "-" + h.substr(12, 4) + "-" + h.substr(16, 4) + "-" + h.substr(20);
}

std::string b64OfUuid(const std::string &uuid) {
    std::string hex;
    for (char c : uuid) {
        if (c == '-') continue;
        if (!std::isxdigit(static_cast<unsigned char>(c))) return {};
        hex.push_back(char(std::tolower(static_cast<unsigned char>(c))));
    }
    if (hex.size() != 32) return {};
    std::string raw;
    for (std::size_t i = 0; i < 32; i += 2) raw.push_back(char(std::stoi(hex.substr(i, 2), nullptr, 16)));
    return v2::toBase64(raw);
}

namespace {

// Число из proto3-JSON (int64 — строкой).
std::int64_t numOf(const json &o, const char *k) {
    const auto &v = field(o, k);
    if (v.is_number_integer()) return v.get<std::int64_t>();
    if (v.is_string()) {
        try {
            return std::stoll(v.get<std::string>());
        } catch (const std::exception &) {
            return 0;
        }
    }
    return 0;
}

} // namespace

json viewOfModel(const json &mv) {
    if (!mv.is_object()) return nullptr;
    const auto id = uuidOfB64(str(mv, "id"));
    const auto &chat = field(mv, "chat");
    if (id.empty() || !chat.is_object()) return nullptr;
    auto body = json::parse(str(mv, "wire").empty() ? std::string("{}") : str(mv, "wire"), nullptr, false);
    if (!body.is_object()) body = json::object();
    if (!body.contains("content") || !body["content"].is_object()) body["content"] = json{{"kind", "unsupported"}};
    // Реакции: число и «моя» — модель; кто чем ответил — `reactors` тела (users прежнего вида)
    std::map<std::string, json> users;
    for (const auto &r : field(body, "reactors")) {
        const auto e = str(r, "emoji");
        const auto u = str(r, "user");
        if (e.empty() || u.empty()) continue;
        users.try_emplace(e, json::array()).first->second.push_back(u);
    }
    auto reactions = json::array();
    for (const auto &r : field(mv, "reactions")) {
        const auto e = str(r, "emoji");
        if (e.empty()) continue;
        const auto it = users.find(e);
        reactions.push_back(json{{"emoji", e},
                                 {"count", numOf(r, "count")},
                                 {"mine", field(r, "mine").is_boolean() && r["mine"].get<bool>()},
                                 {"users", it != users.end() ? it->second : json::array()}});
    }
    body.erase("reactors");
    const auto editTs = numOf(mv, "edited_ts_ms");
    const auto delivery = str(mv, "delivery");
    const auto flag = [&](const char *k) { return field(mv, k).is_boolean() && mv[k].get<bool>(); };
    return json{{"id", id},
                {"chat", chat},
                {"chatKey", chatKeyOf(chat)},
                {"from", str(mv, "from")},
                {"tsMs", numOf(mv, "ts_ms")},
                {"editTsMs", editTs},
                {"edited", editTs > 0},
                {"visible", true},
                {"orphan", false},
                {"pinned", flag("pinned")},
                {"reactions", reactions},
                {"body", body},
                {"order", numOf(mv, "order")},
                {"unread", flag("unread")},
                {"read", delivery == "DELIVERY_READ"},
                {"outgoing", flag("outgoing")}};
}

json removedOfModel(const json &rm) {
    if (!rm.is_object()) return nullptr;
    const auto id = uuidOfB64(str(rm, "id"));
    if (id.empty()) return nullptr;
    const auto &chat = field(rm, "chat");
    return json{{"id", id}, {"chat", chat}, {"chatKey", chat.is_object() ? chatKeyOf(chat) : std::string()}};
}

json chatViewOfModel(const json &cv) {
    if (!cv.is_object() || !field(cv, "chat").is_object()) return nullptr;
    const auto &chat = cv["chat"];
    const auto key = chatKeyOf(chat);
    if (key.empty()) return nullptr;
    auto folders = json::array();
    for (const auto &f : field(cv, "folder_ids")) {
        if (f.is_number_integer()) folders.push_back(f.get<std::int64_t>());
    }
    const auto flag = [&](const char *k) { return field(cv, k).is_boolean() && cv[k].get<bool>(); };
    const auto &last = field(cv, "last");
    return json{{"chat", chat},
                {"chatKey", key},
                {"order", numOf(cv, "order")},
                {"pinnedRank", numOf(cv, "pinned_rank")},
                {"archived", flag("archived")},
                {"unreadMark", flag("unread_mark")},
                {"mutedUntilMs", numOf(cv, "muted_until_ms")},
                {"draft", str(cv, "draft")},
                {"folderIds", folders},
                {"unread", numOf(cv, "unread")},
                {"mention", flag("mention")},
                {"last", last.is_object() ? viewOfModel(last) : json(nullptr)}};
}

json removedChatOfModel(const json &peer) {
    if (!peer.is_object()) return nullptr;
    const auto key = chatKeyOf(peer);
    if (key.empty()) return nullptr;
    return json{{"chat", peer}, {"chatKey", key}};
}

json unreadOfModel(const json &u) {
    if (!u.is_object() || !field(u, "chat").is_object()) return nullptr;
    auto mentions = json::array();
    for (const auto &m : field(u, "mentions")) {
        if (m.is_string()) {
            if (auto id = uuidOfB64(m.get<std::string>()); !id.empty()) mentions.push_back(std::move(id));
        }
    }
    return json{{"chat", u["chat"]},
                {"chatKey", chatKeyOf(u["chat"])},
                {"unread", numOf(u, "count")},
                {"lastReadId", uuidOfB64(str(u, "last_read_id"))},
                {"lastReadTsMs", numOf(u, "last_read_ts_ms")},
                {"mention", field(u, "mention").is_boolean() && u["mention"].get<bool>()},
                {"mentions", mentions}};
}

namespace {

json resultOf(const json &out) {
    if (!out.is_object() || out.contains("error")) return json();
    const auto text = str(out, "result_json");
    auto v = json::parse(text.empty() ? std::string("null") : text, nullptr, false);
    return v.is_discarded() ? json() : v;
}

} // namespace

ModelRows::ModelRows(HostFn host, std::string auxPrefix, AuxIo io)
: host_(std::move(host)), auxPrefix_(std::move(auxPrefix)), io_(std::move(io)) {}

bool ModelRows::ready() const {
    return host_ && host_() != nullptr;
}

json ModelRows::rowsAll(const json &what) const {
    const auto h = host_ ? host_() : nullptr;
    if (!h) return json();
    return resultOf(h->raw("rowsAll", what));
}

std::optional<json> ModelRows::get(const std::string &id) const {
    if (id.empty()) return std::nullopt;
    const auto r = rowsAll(json{{"states", true}, {"ids", json::array({id})}});
    const auto &s = field(r, "states");
    if (!s.is_array() || s.empty()) return std::nullopt;
    return s[0];
}

std::vector<json> ModelRows::states(const std::vector<std::string> &ids) const {
    std::vector<json> out;
    for (std::size_t i = 0; i < ids.size(); i += kIdsChunk) {
        json batch = json::array();
        for (std::size_t j = i; j < std::min(ids.size(), i + kIdsChunk); ++j) {
            if (!ids[j].empty()) batch.push_back(ids[j]);
        }
        if (batch.empty()) continue;
        const auto r = rowsAll(json{{"states", true}, {"ids", batch}});
        for (const auto &s : field(r, "states")) out.push_back(s);
    }
    return out;
}

std::vector<json> ModelRows::chat(const std::string &chatKey) const {
    if (chatKey.empty()) return {};
    const auto r = rowsAll(json{{"states", true}, {"chat_key", chatKey}});
    const auto &s = field(r, "states");
    return s.is_array() ? std::vector<json>(s.begin(), s.end()) : std::vector<json>();
}

std::vector<json> ModelRows::all() const {
    const auto r = rowsAll(json{{"states", true}});
    const auto &s = field(r, "states");
    return s.is_array() ? std::vector<json>(s.begin(), s.end()) : std::vector<json>();
}

std::optional<json> ModelRows::mark(const std::string &chatKey) const {
    if (chatKey.empty()) return std::nullopt;
    const auto r = rowsAll(json{{"marks", true}, {"chat_key", chatKey}});
    const auto &m = field(r, "marks");
    if (!m.is_array() || m.empty()) return std::nullopt;
    return m[0];
}

std::vector<json> ModelRows::marks() const {
    const auto r = rowsAll(json{{"marks", true}});
    const auto &m = field(r, "marks");
    return m.is_array() ? std::vector<json>(m.begin(), m.end()) : std::vector<json>();
}

ModelRows::Read ModelRows::read(const std::string &chatKey, const json &since) const {
    Read out;
    const auto h = host_ ? host_() : nullptr;
    if (!h || chatKey.empty()) return out;
    const auto r = resultOf(h->raw("rowsRead", json{{"chat_key", chatKey}, {"since_json", since.is_object() ? since.dump() : ""}}));
    if (!r.is_object()) return out;
    out.unread = r.value("unread", 0);
    out.lastReadId = str(r, "last_read_id");
    out.mark = r.contains("mark") && r["mark"].is_object() ? r["mark"] : json(nullptr);
    for (const auto &id : field(r, "newly_read")) {
        if (id.is_string()) out.newlyRead.push_back(id.get<std::string>());
    }
    return out;
}

std::vector<json> ModelRows::views(const std::vector<std::string> &ids) const {
    std::vector<json> out;
    for (std::size_t i = 0; i < ids.size(); i += kIdsChunk) {
        json batch = json::array();
        for (std::size_t j = i; j < std::min(ids.size(), i + kIdsChunk); ++j) {
            if (!ids[j].empty()) batch.push_back(ids[j]);
        }
        if (batch.empty()) continue;
        const auto r = rowsAll(json{{"views", true}, {"ids", batch}});
        for (const auto &v : field(r, "views")) out.push_back(v);
    }
    return out;
}

std::vector<json> ModelRows::chatViews(const std::string &chatKey) const {
    if (chatKey.empty()) return {};
    const auto r = rowsAll(json{{"views", true}, {"chat_key", chatKey}});
    const auto &v = field(r, "views");
    return v.is_array() ? std::vector<json>(v.begin(), v.end()) : std::vector<json>();
}

std::vector<json> ModelRows::allViews() const {
    const auto r = rowsAll(json{{"views", true}});
    const auto &v = field(r, "views");
    return v.is_array() ? std::vector<json>(v.begin(), v.end()) : std::vector<json>();
}

std::vector<json> ModelRows::chatList() const {
    std::vector<json> out;
    const auto h = host_ ? host_() : nullptr;
    if (!h) return out;
    json after = nullptr;
    for (int i = 0; i < 1000; ++i) {
        json args{{"limit", 200}};
        if (after.is_object()) args["after"] = after;
        const auto p = h->read("chatList", args);
        if (!p.is_object() || p.contains("error")) break;
        for (const auto &c : field(p, "chats")) {
            if (auto v = chatViewOfModel(c); v.is_object()) out.push_back(std::move(v));
        }
        const auto &next = field(p, "next");
        if (!next.is_object() || next.empty()) break;
        after = next;
    }
    return out;
}

ModelRows::Page ModelRows::page(const json &peer, const std::string &anchorId, const std::string &direction,
                                int limit) const {
    Page out;
    const auto h = host_ ? host_() : nullptr;
    if (!h || !peer.is_object()) return out;
    json args{{"chat", peer},
              {"limit", std::clamp(limit, 1, 200)},
              {"direction", direction == "newer"    ? "PAGE_DIRECTION_NEWER"
                            : direction == "around" ? "PAGE_DIRECTION_AROUND"
                                                    : "PAGE_DIRECTION_OLDER"}};
    if (!anchorId.empty()) {
        // Якорь — место строки в ленте (order, id): берётся из её показа
        const auto vs = views({anchorId});
        if (vs.empty()) return out;
        args["anchor"] = json{{"ts_ms", std::to_string(numOf(vs.front(), "order"))}, {"id", b64OfUuid(anchorId)}};
    }
    const auto p = h->read("historyPage", args);
    if (!p.is_object() || p.contains("error")) return out;
    out.ok = true;
    for (const auto &r : field(p, "rows")) {
        if (auto v = viewOfModel(r); v.is_object()) out.rows.push_back(std::move(v));
    }
    out.hasOlder = field(p, "has_older").is_boolean() && p["has_older"].get<bool>();
    out.hasNewer = field(p, "has_newer").is_boolean() && p["has_newer"].get<bool>();
    return out;
}

ModelRows::Applied ModelRows::apply(const json &ops, const json &legacyRows, const json &forget, bool wipe,
                                    bool journal) {
    Applied out;
    const auto h = host_ ? host_() : nullptr;
    if (!h) {
        out.error = "модель не открыта";
        return out;
    }
    json args{{"now_ms", std::to_string(systemNowMs())}};
    if (ops.is_array() && !ops.empty()) args["ops_json"] = ops.dump();
    if (legacyRows.is_array() && !legacyRows.empty()) args["rows_json"] = legacyRows.dump();
    if (forget.is_array() && !forget.empty()) args["forget_json"] = forget.dump();
    if (wipe) args["wipe"] = true;
    if (journal) args["journal"] = true;
    const auto st = h->step("rowsApply", args);
    if (!st.ok()) {
        out.error = st.error;
        return out;
    }
    out.ok = true;
    std::set<std::string> seen;
    for (const auto &c : st.changes) {
        const json *ch = nullptr;
        if (c.contains("message_upsert") && c["message_upsert"].is_object()) ch = &c["message_upsert"];
        else if (c.contains("message_remove") && c["message_remove"].is_object()) ch = &c["message_remove"];
        if (!ch) continue;
        const auto id = uuidOfB64(str(*ch, "id"));
        if (!id.empty() && seen.insert(id).second) out.changed.push_back(id);
    }
    return out;
}

void ModelRows::forget(const std::vector<std::string> &ids) {
    json targets = json::array();
    for (const auto &s : states(ids)) {
        if (s.contains("chat") && s["chat"].is_object()) targets.push_back(json{{"chat", s["chat"]}, {"target", str(s, "target")}});
    }
    for (std::size_t i = 0; i < targets.size(); i += kApplyChunk) {
        apply(json::array(), json::array(),
              json(std::vector<json>(targets.begin() + i, targets.begin() + std::min(targets.size(), i + kApplyChunk))));
    }
}

json ModelRows::aux(const std::string &name) {
    std::lock_guard<std::mutex> lk(auxMu_);
    if (const auto it = aux_.find(name); it != aux_.end()) return it->second;
    const auto path = auxPrefix_ + name + ".json";
    auto v = json::parse(io_.read ? io_.read(path) : storecrypt::readFile(path), nullptr, false);
    if (v.is_discarded()) v = nullptr;
    aux_[name] = v;
    return v;
}

void ModelRows::setAux(const std::string &name, const json &value) {
    std::lock_guard<std::mutex> lk(auxMu_);
    aux_[name] = value;
    if (io_.write) {
        (void)io_.write(auxPrefix_ + name + ".json", value.dump());
    } else {
        storecrypt::writeFile(auxPrefix_ + name + ".json", value.dump());
    }
}

LegacyRowFiles readLegacyRowFiles(const std::string &rowsPath, const std::string &marksPath) {
    LegacyRowFiles out;
    std::map<std::string, json> states, stored;
    for (const auto &line : storecrypt::readLines(rowsPath)) {
        auto v = json::parse(line, nullptr, false);
        if (!v.is_object()) continue;
        if (const auto target = str(v, "target"); !target.empty()) {
            states[target] = std::move(v); // дописывалось целым состоянием: последнее — сведённое
        } else if (const auto id = str(v, "id"); !id.empty() && v.contains("content")) {
            stored[id] = std::move(v); // журнал до spec 033 (StoredMessage)
        }
    }
    for (auto &[id, s] : states) out.states.push_back(std::move(s));
    for (auto &[id, s] : stored) out.storedMessages.push_back(std::move(s));
    const auto marks = json::parse(storecrypt::readFile(marksPath), nullptr, false);
    if (marks.is_object()) {
        for (auto it = marks.begin(); it != marks.end(); ++it) {
            if (it.value().is_object()) out.marks.push_back(it.value());
        }
    }
    return out;
}

bool importLegacyRows(ModelRows &rows, const std::string &rowsPath, const std::string &marksPath,
                      const std::function<std::vector<json>(const std::vector<json> &stored)> &convertStored,
                      const std::function<bool(const json &state)> &dropRow,
                      const std::function<void(const std::string &)> &log) {
    if (!rows.ready()) return false;
    if (const auto done = rows.aux("imported"); done.is_object() && done.value("rows", false)) return true;
    const auto files = readLegacyRowFiles(rowsPath, marksPath);
    json legacy = json::array();
    for (const auto &s : files.states) {
        if (!dropRow || !dropRow(s)) legacy.push_back(json{{"hs", s}});
    }
    std::vector<json> ops = convertStored && !files.storedMessages.empty() ? convertStored(files.storedMessages)
                                                                           : std::vector<json>();
    for (const auto &m : files.marks) ops.push_back(json{{"read", m}});
    for (std::size_t i = 0; i < legacy.size(); i += kApplyChunk) {
        const auto r = rows.apply(json::array(),
                                  json(std::vector<json>(legacy.begin() + i, legacy.begin() + std::min(legacy.size(), i + kApplyChunk))));
        if (!r.ok) {
            if (log) log("журнал истории: прежние строки не перенесены в модель: " + r.error);
            return false;
        }
    }
    for (std::size_t i = 0; i < ops.size(); i += kApplyChunk) {
        const auto r = rows.apply(json(std::vector<json>(ops.begin() + i, ops.begin() + std::min(ops.size(), i + kApplyChunk))));
        if (!r.ok) {
            if (log) log("журнал истории: прежние операции не перенесены в модель: " + r.error);
            return false;
        }
    }
    // Строки, очищенные «у себя» после переноса spec 035 (модель их получила раньше, файл — уже без них)
    std::size_t dropped = 0;
    if (dropRow) {
        std::vector<std::string> drop;
        for (const auto &s : rows.all()) {
            if (dropRow(s)) drop.push_back(str(s, "target"));
        }
        dropped = drop.size();
        rows.forget(drop);
    }
    rows.setAux("imported", json{{"rows", true}, {"atMs", systemNowMs()}});
    if (log) {
        log("журнал истории: прежние строки устройства — в модели (строк " + std::to_string(legacy.size()) + ", операций "
            + std::to_string(ops.size()) + ", убрано очищенных " + std::to_string(dropped) + ")");
    }
    return true;
}

// ── HistorySync ──────────────────────────────────────────────────────────────────────────────────────────────────

HistorySync::HistorySync(HistorySyncConfig cfg) : cfg_(std::move(cfg)) {}

HistorySync::~HistorySync() = default;

void HistorySync::log(const std::string &m) const {
    if (cfg_.log) cfg_.log("журнал истории: " + m);
}

void HistorySync::start() {
    if (started_.exchange(true) || !cfg_.rows) return;
    // Очередь прежнего журнала устройства (до spec 036: свои операции, маркеры, входящее, запечатанные тела)
    const auto pending = cfg_.rows->aux("pending");
    if (!pending.is_object() || pending.empty()) return;
    std::vector<json> ops;
    for (const auto &op : field(pending, "ops")) ops.push_back(op);
    if (field(pending, "marks").is_object()) {
        for (const auto &[k, m] : pending["marks"].items()) ops.push_back(json{{"read", m}});
    }
    for (const auto &x : field(pending, "incoming")) {
        if (x.is_object() && x.contains("op")) ops.push_back(x["op"]);
    }
    for (std::size_t i = 0; i < ops.size(); i += kApplyChunk) {
        const json batch(std::vector<json>(ops.begin() + i, ops.begin() + std::min(ops.size(), i + kApplyChunk)));
        if (const auto r = cfg_.rows->apply(batch, json::array(), json::array(), false, true); !r.ok) {
            log("очередь прежнего журнала не передана модели: " + r.error);
            return; // повтор при следующем запуске
        }
    }
    cfg_.rows->setAux("pending", json::object());
    log("очередь прежнего журнала передана модели: " + std::to_string(ops.size()));
}

void HistorySync::stop() {}

void HistorySync::ensureSelves() {
    std::unique_lock<std::mutex> lk(engMu_, std::try_to_lock);
    if (!lk.owns_lock() || engine_ || !cfg_.openEngine) return;
    try {
        engine_ = cfg_.openEngine();
    } catch (const std::exception &e) {
        log(std::string("сессия движка не открылась: ") + e.what());
    }
    if (!engine_) return;
    // Свои адреса (текущий и прежние) — «своё сдвигает маркер» и показ своего под прежним ником
    try {
        const auto a = engine_->call("selfAddresses");
        std::vector<std::string> out;
        for (const auto &x : a) {
            if (x.is_string() && !x.get<std::string>().empty()) out.push_back(x.get<std::string>());
        }
        std::lock_guard<std::mutex> slk(selvesMu_);
        selves_ = std::move(out);
    } catch (const std::exception &e) {
        log(std::string("свои адреса сессии не получены: ") + e.what());
    }
}

std::vector<std::string> HistorySync::selfAddresses() {
    ensureSelves();
    std::vector<std::string> out;
    if (!cfg_.self.empty()) out.push_back(cfg_.self);
    std::lock_guard<std::mutex> lk(selvesMu_);
    for (const auto &a : selves_) {
        if (std::find(out.begin(), out.end(), a) == out.end()) out.push_back(a);
    }
    return out;
}

bool HistorySync::isSelf(const std::string &address) {
    if (address.empty()) return false;
    const auto all = selfAddresses();
    return std::find(all.begin(), all.end(), address) != all.end();
}

json HistorySync::record(const json &op, bool own) {
    const auto target = opTarget(op);
    if (target.empty() || !cfg_.rows) return nullptr;
    // Строка — модели, в журнал её ставит модель (пачкой S7-3 по такту сессии); сведение и права — модель
    const auto r = cfg_.rows->apply(json::array({op}), json::array(), json::array(), false, /*journal=*/true);
    if (!r.ok) {
        log("событие не применено: " + r.error);
        return nullptr;
    }
    const auto got = cfg_.rows->get(target);
    if (!got) {
        log("событие отвергнуто моделью (" + target + ")");
        return nullptr;
    }
    // Своё сообщение (с любого своего устройства) — всё входящее до него прочитано (FR-011)
    if (op.contains("row") && isSelf(str(op["row"], "from"))) {
        if (const auto m = markAt(*got); m.is_object()) {
            cfg_.rows->apply(json::array({json{{"read", m}}}), json::array(), json::array(), false, /*journal=*/own);
        }
    }
    return *got;
}

std::vector<json> HistorySync::advanceMark(const json &mark, bool own) {
    if (!mark.is_object() || !cfg_.rows || chatKeyOf(field(mark, "chat")).empty()) return {};
    // Своё прочтение — намерением модели: квитанции о ставших прочитанными шлёт она (READ-1 п. 3). Чужое (копия
    // своей квитанции, маркер журнала) и прочтение без сессии — операцией (в журнал — если своё)
    if (own && cfg_.readIntent && cfg_.readIntent(mark)) return {};
    if (const auto r = cfg_.rows->apply(json::array({json{{"read", mark}}}), json::array(), json::array(), false, own); !r.ok) {
        log("маркер не принят моделью: " + r.error);
    }
    return {};
}

std::optional<json> HistorySync::state(const std::string &id) {
    return cfg_.rows ? cfg_.rows->get(id) : std::nullopt;
}

json HistorySync::mark(const std::string &chatKey) {
    if (!cfg_.rows) return nullptr;
    const auto m = cfg_.rows->mark(chatKey);
    return m ? *m : json(nullptr);
}

ReadState HistorySync::readState(const std::string &chatKey) {
    ReadState out;
    if (!cfg_.rows) return out;
    const auto r = cfg_.rows->read(chatKey);
    out.unread = r.unread;
    out.lastReadId = r.lastReadId;
    out.mark = r.mark;
    return out;
}

int HistorySync::unreadCount(const std::string &chatKey) {
    return readState(chatKey).unread;
}

} // namespace parvane::history
