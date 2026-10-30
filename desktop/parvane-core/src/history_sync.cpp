// Parvane fork: журнал истории аккаунта на клиенте (spec 033) — см. include/parvane/history_sync.h.
#include "parvane/history_sync.h"

#include <algorithm>
#include <chrono>
#include <limits>
#include <random>

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

std::uint64_t u64(const json &v) {
    const auto x = i64(v);
    return x > 0 ? static_cast<std::uint64_t>(x) : 0;
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

bool markPos(const json &mark, std::int64_t *ts, std::string *id) {
    if (!mark.is_object()) return false;
    *ts = i64(field(mark, "up_to_ts_ms"));
    *id = str(mark, "up_to_id");
    return true;
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

std::mt19937_64 &rng() {
    static thread_local std::mt19937_64 g{std::random_device{}()};
    return g;
}

std::int64_t randomIn(std::int64_t lo, std::int64_t hi) {
    if (hi <= lo) return lo;
    return std::uniform_int_distribution<std::int64_t>(lo, hi)(rng());
}

bool isCode(const std::exception &e, const char *code) {
    const auto *v = dynamic_cast<const v2::V2Error *>(&e);
    return v && v->code() == code;
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

// ── FileRowStore ─────────────────────────────────────────────────────────────────────────────────────────────────

FileRowStore::FileRowStore(std::string rowsPath, std::string marksPath, std::string auxPrefix)
: rowsPath_(std::move(rowsPath)), marksPath_(std::move(marksPath)), auxPrefix_(std::move(auxPrefix)) {
    std::lock_guard<std::mutex> lk(mu_);
    loadLocked();
}

FileRowStore::~FileRowStore() = default;

void FileRowStore::loadLocked() {
    std::size_t lines = 0;
    for (const auto &line : storecrypt::readLines(rowsPath_)) {
        auto v = json::parse(line, nullptr, false);
        if (!v.is_object()) continue;
        ++lines;
        const auto target = str(v, "target");
        if (!target.empty()) {
            const auto key = chatKeyOfState(v);
            if (const auto it = rows_.find(target); it != rows_.end()) {
                const auto old = chatKeyOfState(it->second);
                if (old != key) byChat_[old].erase(target);
            }
            rows_[target] = std::move(v);
            byChat_[key].insert(target);
        } else if (!str(v, "id").empty() && v.contains("content")) {
            legacy_.push_back(std::move(v)); // журнал до spec 033 (StoredMessage)
        }
    }
    appended_ = lines > rows_.size() + legacy_.size() ? lines - rows_.size() - legacy_.size() : 0;
    const auto marks = json::parse(storecrypt::readFile(marksPath_), nullptr, false);
    if (marks.is_object()) {
        for (auto it = marks.begin(); it != marks.end(); ++it) {
            if (it.value().is_object()) marks_[it.key()] = it.value();
        }
    }
    if (appended_ > 0 && appended_ >= rows_.size()) compactLocked();
}

void FileRowStore::compactLocked() {
    std::vector<std::string> lines;
    lines.reserve(rows_.size() + legacy_.size());
    for (const auto &l : legacy_) lines.push_back(l.dump()); // ещё не перенесённое остаётся на диске
    for (const auto &[id, s] : rows_) lines.push_back(s.dump());
    storecrypt::writeLines(rowsPath_, lines);
    appended_ = 0;
}

void FileRowStore::saveMarksLocked() {
    json out = json::object();
    for (const auto &[k, m] : marks_) out[k] = m;
    storecrypt::writeFile(marksPath_, out.dump());
}

std::optional<json> FileRowStore::get(const std::string &id) {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = rows_.find(id);
    if (it == rows_.end()) return std::nullopt;
    return it->second;
}

void FileRowStore::put(const json &state) {
    const auto target = str(state, "target");
    if (target.empty()) return;
    const auto key = chatKeyOfState(state);
    std::lock_guard<std::mutex> lk(mu_);
    if (const auto it = rows_.find(target); it != rows_.end()) {
        if (it->second == state) return;
        const auto old = chatKeyOfState(it->second);
        if (old != key) byChat_[old].erase(target);
    }
    rows_[target] = state;
    byChat_[key].insert(target);
    storecrypt::appendLine(rowsPath_, state.dump());
    if (++appended_ > std::max<std::size_t>(2000, rows_.size())) compactLocked();
}

void FileRowStore::erase(const std::vector<std::string> &ids) {
    std::lock_guard<std::mutex> lk(mu_);
    bool any = false;
    for (const auto &id : ids) {
        const auto it = rows_.find(id);
        if (it == rows_.end()) continue;
        byChat_[chatKeyOfState(it->second)].erase(id);
        rows_.erase(it);
        any = true;
    }
    if (any) compactLocked();
}

void FileRowStore::forEachInChat(const std::string &chatKey, const std::function<void(const json &)> &f) {
    std::vector<json> copy;
    {
        std::lock_guard<std::mutex> lk(mu_);
        const auto it = byChat_.find(chatKey);
        if (it == byChat_.end()) return;
        copy.reserve(it->second.size());
        for (const auto &id : it->second) {
            if (const auto r = rows_.find(id); r != rows_.end()) copy.push_back(r->second);
        }
    }
    for (const auto &s : copy) f(s);
}

void FileRowStore::forEach(const std::function<void(const json &)> &f) {
    std::vector<json> copy;
    {
        std::lock_guard<std::mutex> lk(mu_);
        copy.reserve(rows_.size());
        for (const auto &[id, s] : rows_) copy.push_back(s);
    }
    for (const auto &s : copy) f(s);
}

std::size_t FileRowStore::size() {
    std::lock_guard<std::mutex> lk(mu_);
    return rows_.size();
}

std::optional<json> FileRowStore::mark(const std::string &chatKey) {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = marks_.find(chatKey);
    if (it == marks_.end()) return std::nullopt;
    return it->second;
}

void FileRowStore::setMark(const std::string &chatKey, const json &mark) {
    std::lock_guard<std::mutex> lk(mu_);
    marks_[chatKey] = mark;
    saveMarksLocked();
}

void FileRowStore::forEachMark(const std::function<void(const std::string &, const json &)> &f) {
    std::map<std::string, json> copy;
    {
        std::lock_guard<std::mutex> lk(mu_);
        copy = marks_;
    }
    for (const auto &[k, m] : copy) f(k, m);
}

void FileRowStore::clear() {
    std::lock_guard<std::mutex> lk(mu_);
    rows_.clear();
    byChat_.clear();
    marks_.clear();
    legacy_.clear();
    compactLocked();
    saveMarksLocked();
}

json FileRowStore::aux(const std::string &name) {
    std::lock_guard<std::mutex> lk(mu_);
    if (const auto it = aux_.find(name); it != aux_.end()) return it->second;
    auto v = json::parse(storecrypt::readFile(auxPrefix_ + name + ".json"), nullptr, false);
    if (v.is_discarded()) v = nullptr;
    aux_[name] = v;
    return v;
}

void FileRowStore::setAux(const std::string &name, const json &value) {
    std::lock_guard<std::mutex> lk(mu_);
    aux_[name] = value;
    storecrypt::writeFile(auxPrefix_ + name + ".json", value.dump());
}

void FileRowStore::flush() {
    std::lock_guard<std::mutex> lk(mu_);
    if (appended_ > 0) compactLocked();
}

std::vector<json> FileRowStore::takeLegacyRows() {
    std::lock_guard<std::mutex> lk(mu_);
    return std::exchange(legacy_, {});
}

void FileRowStore::compact() {
    std::lock_guard<std::mutex> lk(mu_);
    compactLocked();
}

std::size_t FileRowStore::appendedSinceCompact() {
    std::lock_guard<std::mutex> lk(mu_);
    return appended_;
}

// ── HistorySync ──────────────────────────────────────────────────────────────────────────────────────────────────

HistorySync::HistorySync(HistorySyncConfig cfg) : cfg_(std::move(cfg)) {
    meta_ = cfg_.store ? cfg_.store->aux("meta") : json();
    if (!meta_.is_object()) meta_ = json::object();
    const auto pending = cfg_.store ? cfg_.store->aux("pending") : json();
    if (pending.is_object()) {
        if (pending.contains("ops") && pending["ops"].is_array()) {
            for (const auto &op : pending["ops"]) pendingOwn_.push_back(op);
        }
        if (pending.contains("marks") && pending["marks"].is_object()) {
            for (auto it = pending["marks"].begin(); it != pending["marks"].end(); ++it) {
                pendingMarks_[it.key()] = it.value();
            }
        }
    }
    const auto t = now();
    if (!pendingOwn_.empty()) ownDue_ = t;
    if (!pendingMarks_.empty()) marksDue_ = t;
}

HistorySync::~HistorySync() {
    stop();
}

std::int64_t HistorySync::now() const {
    return cfg_.nowMs ? cfg_.nowMs() : systemNowMs();
}

void HistorySync::log(const std::string &m) const {
    if (cfg_.log) cfg_.log("журнал истории: " + m);
}

void HistorySync::start() {
    if (started_.exchange(true)) return;
    stop_ = false;
    {
        std::lock_guard<std::mutex> lk(mu_);
        syncRequested_ = true;
    }
    if (cfg_.thread) worker_ = std::thread([this] { loop(); });
}

void HistorySync::stop() {
    stop_ = true;
    wake();
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
    started_ = false;
    if (cfg_.store) cfg_.store->flush();
}

void HistorySync::wake() {
    std::lock_guard<std::mutex> lk(cvMu_);
    kicked_ = true;
    cv_.notify_all();
}

void HistorySync::onSessionEvent(const json &ev) {
    const auto type = str(ev, "type");
    if (type == "journal") {
        if (str(ev, "journal") != "history") return;
        std::lock_guard<std::mutex> lk(mu_);
        syncRequested_ = true;
    } else if (type == "stateReady") {
        std::lock_guard<std::mutex> lk(mu_);
        reopenRequested_ = true;
        if (ev.value("rotated", false)) rotated_ = true;
        syncRequested_ = true;
    } else {
        return;
    }
    wake();
}

bool HistorySync::ensureEngineLocked() {
    if (engine_) return true;
    if (!cfg_.openEngine) return false;
    try {
        engine_ = cfg_.openEngine();
    } catch (const std::exception &e) {
        log(std::string("сессия движка не открылась: ") + e.what());
    }
    if (engine_) {
        // Свои адреса (текущий и прежние) — набор `self` для непрочитанного и «своё сдвигает маркер»
        try {
            const auto a = engine_->call("selfAddresses");
            std::vector<std::string> out;
            if (a.is_array()) {
                for (const auto &x : a) {
                    if (x.is_string() && !x.get<std::string>().empty()) out.push_back(x.get<std::string>());
                }
            }
            std::lock_guard<std::mutex> lk(selvesMu_);
            selves_ = std::move(out);
        } catch (const std::exception &e) {
            log(std::string("свои адреса сессии не получены: ") + e.what());
        }
    }
    return engine_ != nullptr;
}

std::vector<std::string> HistorySync::selfAddresses() {
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

json HistorySync::selvesJson() {
    json a = json::array();
    for (const auto &x : selfAddresses()) a.push_back(x);
    return a;
}

json HistorySync::engine(const std::string &name, const json &args) {
    std::lock_guard<std::mutex> lk(engMu_);
    if (!ensureEngineLocked()) throw v2::V2Error("ERROR_CODE_UNAVAILABLE");
    return engine_->call(name, args);
}

std::string HistorySync::req(const std::string &method, const std::string &body) {
    if (!cfg_.request) throw v2::V2Error("ERROR_CODE_UNAVAILABLE");
    return cfg_.request(method, body);
}

std::string HistorySync::opKey(const json &op) {
    const auto [kind, body] = opKind(op);
    if (!body) return {};
    const auto stampId = [&] { return str(field(*body, "stamp"), "op_id"); };
    if (kind == "row") return "r:" + str(*body, "id");
    if (kind == "gone") return "g:" + stampId() + ":" + str(*body, "target");
    if (kind == "edit") return "e:" + stampId() + ":" + str(*body, "target");
    if (kind == "react") return "x:" + stampId() + ":" + str(*body, "target") + ":" + str(*body, "user");
    if (kind == "pin") return "p:" + stampId() + ":" + str(*body, "target");
    return {};
}

void HistorySync::noteSeen(const json &op) {
    const auto key = opKey(op);
    if (key.empty()) return;
    std::lock_guard<std::mutex> lk(mu_);
    if (!seen_.insert(key).second) return;
    seenOrder_.push_back(key);
    while (seenOrder_.size() > kSeenCap) {
        seen_.erase(seenOrder_.front());
        seenOrder_.pop_front();
    }
}

bool HistorySync::seen(const std::string &key) {
    std::lock_guard<std::mutex> lk(mu_);
    return seen_.count(key) > 0;
}

void HistorySync::saveMetaLocked() {
    if (cfg_.store) cfg_.store->setAux("meta", meta_);
}

void HistorySync::savePendingLocked() {
    if (!cfg_.store) return;
    json marks = json::object();
    for (const auto &[k, m] : pendingMarks_) marks[k] = m;
    cfg_.store->setAux("pending", json{{"ops", pendingOwn_}, {"marks", marks}});
}

json HistorySync::applyToStore(const json &op, bool *changed) {
    *changed = false;
    const auto target = opTarget(op);
    if (target.empty() || !cfg_.store) throw v2::EngineError(R"({"error":"InvalidField"})");
    const auto prev = cfg_.store->get(target);
    json args{{"op", op}};
    if (prev) args["state"] = *prev;
    auto next = call("historyApply", args);
    if (prev && *prev == next) return next;
    *changed = true;
    cfg_.store->put(next);
    return next;
}

bool HistorySync::mergeMark(const json &mark, std::string *chatKey) {
    if (!mark.is_object() || !cfg_.store) return false;
    const auto key = chatKeyOf(field(mark, "chat"));
    if (key.empty()) return false;
    if (chatKey) *chatKey = key;
    const auto prev = cfg_.store->mark(key);
    json args{{"b", mark}};
    if (prev) args["a"] = *prev;
    json merged;
    try {
        merged = call("historyMarkMerge", args);
    } catch (const std::exception &e) {
        log(std::string("маркер не сведён: ") + e.what());
        return false;
    }
    if (!merged.is_object() || (prev && *prev == merged)) return false;
    cfg_.store->setMark(key, merged);
    return true;
}

void HistorySync::releaseParked(const json &state, std::vector<json> *rows) {
    const auto row = field(state, "row");
    if (!row.is_object()) return;
    std::vector<Parked> ready;
    {
        std::lock_guard<std::mutex> lk(mu_);
        const auto it = parked_.find(str(state, "target"));
        if (it == parked_.end()) return;
        ready = std::move(it->second);
        parked_.erase(it);
        parkedCount_ -= std::min(parkedCount_, ready.size());
    }
    const auto author = str(row, "from");
    for (const auto &p : ready) {
        if (p.author != author) {
            log("мутация чужого сообщения отброшена (автор не совпал)");
            continue;
        }
        const auto st = record(p.op, p.own);
        if (rows && st.is_object()) rows->push_back(st);
    }
}

json HistorySync::record(const json &op, bool own, const std::string &requiredAuthor) {
    if (!requiredAuthor.empty()) {
        const auto target = opTarget(op);
        const auto prev = target.empty() || !cfg_.store ? std::nullopt : cfg_.store->get(target);
        const auto &row = prev ? field(*prev, "row") : field(json(), "row");
        if (prev && row.is_object()) {
            if (str(row, "from") != requiredAuthor) {
                log("мутация чужого сообщения отвергнута");
                return nullptr;
            }
        } else {
            std::lock_guard<std::mutex> lk(mu_);
            if (parkedCount_ < kSeenCap) {
                parked_[target].push_back(Parked{op, own, requiredAuthor});
                ++parkedCount_;
            }
            return nullptr;
        }
    }
    bool changed = false;
    json st;
    try {
        st = applyToStore(op, &changed);
    } catch (const std::exception &e) {
        log(std::string("событие отвергнуто: ") + e.what());
        return nullptr;
    }
    if (op.contains("row")) {
        std::vector<json> released;
        releaseParked(st, &released);
        if (!released.empty()) st = released.back();
    }
    const auto key = opKey(op);
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (own) {
            pendingOwn_.push_back(op);
            if (!ownDue_) ownDue_ = now() + cfg_.ownDelayMs;
            savePendingLocked();
        } else if (!key.empty() && !seen_.count(key)) {
            incoming_.push_back(Incoming{op, key, now() + randomIn(cfg_.incomingMinMs, cfg_.incomingMaxMs)});
        }
    }
    // Своё сообщение (с любого своего устройства) — всё входящее до него прочитано (FR-011)
    if (op.contains("row") && isSelf(str(op["row"], "from"))) {
        if (const auto m = markAt(st); m.is_object()) advanceMark(m, own);
    }
    wake();
    return st;
}

std::vector<json> HistorySync::advanceMark(const json &mark, bool own) {
    std::vector<json> out;
    if (!mark.is_object() || !cfg_.store) return out;
    const auto key = chatKeyOf(field(mark, "chat"));
    if (key.empty()) return out;
    const auto prev = cfg_.store->mark(key);
    if (!mergeMark(mark, nullptr)) return out;
    const auto merged = cfg_.store->mark(key);
    if (own && merged) {
        std::lock_guard<std::mutex> lk(mu_);
        pendingMarks_[key] = *merged;
        if (!marksDue_) marksDue_ = now() + cfg_.markDelayMs;
        savePendingLocked();
    }
    // Входящие, которые этот сдвиг сделал прочитанными (квитанции собеседникам)
    std::int64_t lo = std::numeric_limits<std::int64_t>::min(), hi = 0;
    std::string loId, hiId;
    const bool hasPrev = prev && markPos(*prev, &lo, &loId);
    if (!merged || !markPos(*merged, &hi, &hiId)) return out;
    const auto selves = selvesJson();
    cfg_.store->forEachInChat(key, [&](const json &s) {
        if (!visibleState(s)) return;
        const auto p = rowPos(s);
        if (!p || posAfter(p->tsMs, p->id, hi, hiId)) return;
        if (hasPrev && !posAfter(p->tsMs, p->id, lo, loId)) return;
        try {
            json args{{"state", s}, {"self", selves}};
            if (prev) args["mark"] = *prev;
            if (call("historyIsUnread", args).get<bool>()) out.push_back(s);
        } catch (const std::exception &) {
        }
    });
    if (own) wake();
    return out;
}

std::optional<json> HistorySync::state(const std::string &id) {
    return cfg_.store ? cfg_.store->get(id) : std::nullopt;
}

json HistorySync::view(const json &state) {
    try {
        return call("historyView", json{{"state", state}});
    } catch (const std::exception &e) {
        log(std::string("строка не показана: ") + e.what());
        return json::object();
    }
}

json HistorySync::mark(const std::string &chatKey) {
    if (!cfg_.store) return nullptr;
    const auto m = cfg_.store->mark(chatKey);
    return m ? *m : json(nullptr);
}

ReadState HistorySync::readState(const std::string &chatKey) {
    ReadState out;
    if (!cfg_.store) return out;
    const auto m = cfg_.store->mark(chatKey);
    out.mark = m ? *m : json(nullptr);
    std::int64_t mts = 0, bestTs = std::numeric_limits<std::int64_t>::min();
    std::string mid, bestId;
    const bool hasMark = m && markPos(*m, &mts, &mid);
    const auto selves = selvesJson();
    cfg_.store->forEachInChat(chatKey, [&](const json &s) {
        if (!visibleState(s)) return;
        const auto p = rowPos(s);
        if (!p) return;
        if (hasMark && !posAfter(p->tsMs, p->id, mts, mid)) {
            if (posAfter(p->tsMs, p->id, bestTs, bestId)) {
                bestTs = p->tsMs;
                bestId = p->id;
            }
            return;
        }
        try {
            json args{{"state", s}, {"self", selves}};
            if (hasMark) args["mark"] = *m;
            if (call("historyIsUnread", args).get<bool>()) ++out.unread;
        } catch (const std::exception &) {
        }
    });
    out.lastReadId = bestId;
    return out;
}

int HistorySync::unreadCount(const std::string &chatKey) {
    return readState(chatKey).unread;
}

void HistorySync::absorbOps(const json &ops, std::vector<json> &rows, std::map<std::string, json> &marks) {
    if (!ops.is_array()) return;
    for (const auto &op : ops) {
        const auto [kind, body] = opKind(op);
        if (!body || kind == "summary") continue;
        if (kind == "read") {
            std::string key;
            if (mergeMark(*body, &key)) marks[key] = *cfg_.store->mark(key);
            continue;
        }
        noteSeen(op);
        // Строка очищенного «у себя» чата (граница ChatCleared) — не храним
        if (cfg_.dropRow) {
            const auto target = opTarget(op);
            const auto prev = target.empty() ? std::nullopt : cfg_.store->get(target);
            if (prev && cfg_.dropRow(*prev)) continue;
            if (kind == "row" || kind == "state") {
                const auto probe = kind == "state" ? *body : json{{"target", target}, {"chat", field(*body, "chat")}, {"row", *body}};
                if (cfg_.dropRow(probe)) continue;
            }
        }
        bool changed = false;
        json st;
        try {
            st = applyToStore(op, &changed);
        } catch (const std::exception &e) {
            log(std::string("операция журнала отвергнута: ") + e.what());
            continue;
        }
        if (changed) rows.push_back(st);
        if (kind == "row" || kind == "state") releaseParked(st, &rows);
        if (kind == "row" && isSelf(str(*body, "from"))) {
            std::string key;
            if (const auto m = markAt(st); m.is_object() && mergeMark(m, &key)) marks[key] = *cfg_.store->mark(key);
        }
    }
}

void HistorySync::deliver(std::vector<json> &rows, std::map<std::string, json> &marks) {
    if (!rows.empty() && cfg_.onRows) cfg_.onRows(rows);
    if (cfg_.onMark) {
        for (const auto &[k, m] : marks) cfg_.onMark(k, m);
    }
    rows.clear();
    marks.clear();
}

std::vector<json> HistorySync::getRecordsLocked(const std::vector<std::uint64_t> &seqs, json *recordsOut) {
    std::vector<json> ops;
    if (recordsOut) *recordsOut = json::array();
    std::vector<std::uint64_t> rest = seqs;
    while (!rest.empty() && !stop_) {
        const std::vector<std::uint64_t> batch(rest.begin(), rest.begin() + std::min(rest.size(), std::size_t(256)));
        const auto body = engine("getRequest", json{{"seqs", batch}});
        const auto resp = req("history.get", v2::fromBase64(body.get<std::string>()));
        const auto r = engine("ingest", json{{"resp", v2::toBase64(resp)}});
        std::set<std::uint64_t> got;
        const auto &allOps = field(r, "ops");
        for (const auto &rec : field(r, "records")) {
            got.insert(u64(rec["seq"]));
            const auto first = rec.value("first", std::size_t(0));
            const auto count = rec.value("count", std::size_t(0));
            for (std::size_t i = first; i < first + count && i < allOps.size(); ++i) ops.push_back(allOps[i]);
            if (recordsOut) recordsOut->push_back(rec);
        }
        // Страница не вместила всё — остальное следующим запросом; пустой ответ — записей нет
        std::vector<std::uint64_t> next;
        bool progressed = false;
        for (const auto s : rest) {
            if (got.count(s)) {
                progressed = true;
                continue;
            }
            next.push_back(s);
        }
        const auto rejected = r.value("rejected", 0);
        if (!progressed && rejected == 0) break;
        if (!progressed) {
            // Записи пришли, но не открылись (чужой ключ) — дальше не ждём
            next.erase(next.begin(), next.begin() + std::min(next.size(), batch.size()));
        }
        rest = std::move(next);
    }
    return ops;
}

bool HistorySync::appendLocked(const std::vector<json> &ops, bool chunk, std::vector<std::uint64_t> *seqs) {
    if (ops.empty()) return true;
    const auto sealed = engine("seal", json{{"ops", ops}, {"chunk", chunk}, {"tsMs", now()}});
    for (const auto &rec : sealed) {
        try {
            const auto resp = req("history.append", v2::fromBase64(str(rec, "body")));
            const auto r = engine("ingestAppend", json{{"resp", v2::toBase64(resp)}});
            if (seqs) seqs->push_back(u64(r["seq"]));
        } catch (const std::exception &e) {
            if (isCode(e, "ERROR_CODE_DUPLICATE") && !chunk) continue; // запись уже есть
            throw;
        }
    }
    for (const auto &op : ops) noteSeen(op);
    return true;
}

bool HistorySync::migrateLocked() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (meta_.value("migrated", false)) return true;
    }
    auto ops = cfg_.legacyOps ? cfg_.legacyOps() : std::vector<json>();
    std::map<std::string, json> states;
    std::map<std::string, json> marks;
    for (const auto &op : ops) {
        if (op.contains("read") && op["read"].is_object()) {
            std::string key;
            mergeMark(op["read"], &key);
            if (!key.empty()) {
                if (const auto m = cfg_.store->mark(key)) marks[key] = *m;
            }
            continue;
        }
        bool changed = false;
        try {
            const auto st = applyToStore(op, &changed);
            states[str(st, "target")] = st;
        } catch (const std::exception &e) {
            log(std::string("перенос: строка пропущена: ") + e.what());
        }
    }
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto &[k, m] : marks) pendingMarks_[k] = m;
    if (!marks.empty()) marksDue_ = now();
    for (const auto &[id, st] : states) pendingOwn_.push_back(json{{"state", st}});
    if (!states.empty()) ownDue_ = now();
    meta_["migrated"] = true;
    savePendingLocked();
    saveMetaLocked();
    log("локальная история перенесена в очередь журнала (" + std::to_string(states.size()) + " строк)");
    return true;
}

bool HistorySync::loadCheckpointLocked(const json &cp, bool isJoin) {
    const auto summarySeq = u64(field(cp, "summarySeq"));
    const auto upto = u64(field(cp, "uptoSeq"));
    const auto cpId = u64(field(cp, "id"));
    json summary, summaryRecs;
    if (summarySeq) {
        for (const auto &op : getRecordsLocked({summarySeq}, &summaryRecs)) {
            if (op.contains("summary")) summary = op["summary"];
        }
    }
    std::int64_t since = 0, lastFull = 0;
    std::uint64_t cursor = 0;
    {
        std::lock_guard<std::mutex> lk(mu_);
        lastFull = meta_.value("lastFullSyncMs", std::int64_t(0));
        cursor = meta_.value("cursor", std::uint64_t(0));
    }
    since = i64(field(summary, "tombstones_since_ms"));
    bool replace = false;
    try {
        replace = call("historyNeedsReplace", json{{"lastFullSyncMs", lastFull}, {"tombstonesSinceMs", since},
                                                   {"cursor", cursor}, {"uptoSeq", upto}})
                      .get<bool>();
    } catch (const std::exception &e) {
        log(std::string("горизонт не проверен: ") + e.what());
    }
    if (replace) {
        log("устройство не синхронизировалось дольше горизонта — история заменяется контрольной точкой");
        cfg_.store->clear();
    }
    std::vector<json> rows;
    std::map<std::string, json> marks;
    // Сводка — список чатов со счётчиками и последними сообщениями сразу (до сегментов)
    if (summary.is_object()) {
        json ops = json::array();
        for (const auto &c : field(summary, "chats")) {
            if (c.contains("last") && c["last"].is_object()) ops.push_back(json{{"state", c["last"]}});
            if (c.contains("mark") && c["mark"].is_object()) ops.push_back(json{{"read", c["mark"]}});
        }
        absorbOps(ops, rows, marks);
        if (!replace) deliver(rows, marks);
    }
    // Сегменты: свежие месяцы первыми
    json segRefs = field(summary, "segments").is_array() ? field(summary, "segments") : json::array();
    std::vector<json> refs(segRefs.begin(), segRefs.end());
    std::stable_sort(refs.begin(), refs.end(), [](const json &a, const json &b) {
        return monthOfKey(str(a, "key")) > monthOfKey(str(b, "key"));
    });
    std::vector<std::uint64_t> seqs;
    for (const auto &r : refs) seqs.push_back(u64(r["seq"]));
    for (const auto &s : field(cp, "chunkSeqs").is_array() ? field(cp, "chunkSeqs") : json::array()) {
        const auto v = u64(s);
        if (v && v != summarySeq && std::find(seqs.begin(), seqs.end(), v) == seqs.end()) seqs.push_back(v);
    }
    std::set<std::uint64_t> staleSeqs;
    for (std::size_t i = 0; i < seqs.size() && !stop_; i += kGetBatch) {
        const std::vector<std::uint64_t> batch(seqs.begin() + i, seqs.begin() + std::min(seqs.size(), i + kGetBatch));
        json recs;
        const auto ops = getRecordsLocked(batch, &recs);
        for (const auto &rec : recs) {
            if (rec.value("stale", false)) staleSeqs.insert(u64(rec["seq"]));
        }
        absorbOps(json(ops), rows, marks);
        if (!replace) deliver(rows, marks);
    }
    if (stop_) return false; // точка загружена не вся — курсор не двигаем, догрузим при следующем запуске
    const bool summaryStale = !summaryRecs.empty() && summaryRecs[0].value("stale", false);
    {
        std::lock_guard<std::mutex> lk(mu_);
        json segments = json::object();
        for (const auto &r : refs) {
            const auto seq = u64(r["seq"]);
            segments[str(r, "key")] = json{{"digest", str(r, "digest")}, {"seq", seq},
                                           {"stale", summaryStale || staleSeqs.count(seq) > 0}};
        }
        meta_["segments"] = segments;
        meta_["segmentsOf"] = cpId;
        meta_["checkpoint"] = cp;
        meta_["cursor"] = std::max(meta_.value("cursor", std::uint64_t(0)), upto);
        if (isJoin || replace) meta_["joined"] = true;
        saveMetaLocked();
    }
    log(std::string(isJoin ? "вход" : "догон") + ": контрольная точка " + std::to_string(cpId) + " загружена (сегментов "
        + std::to_string(seqs.size()) + (replace ? ", замена" : "") + ")");
    if (replace) {
        rows.clear();
        marks.clear();
        if (cfg_.onReplaced) cfg_.onReplaced();
    }
    return true;
}

bool HistorySync::joinLocked() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (meta_.value("joined", false)) return true;
        if (meta_.value("cursor", std::uint64_t(0)) > 0) {
            meta_["joined"] = true;
            saveMetaLocked();
            return true;
        }
    }
    const auto resp = req("history.head", v2::fromBase64(engine("headRequest", json::object()).get<std::string>()));
    const auto head = engine("ingestHead", json{{"resp", v2::toBase64(resp)}});
    const auto headSeq = u64(field(head, "headSeq"));
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (headSeq < meta_.value("headSeq", std::uint64_t(0))) {
            log("откат сервера: голова " + std::to_string(headSeq) + " меньше виденной — журнал не применяется");
            return false;
        }
        meta_["headSeq"] = headSeq;
    }
    if (head.contains("checkpoint") && head["checkpoint"].is_object()) {
        if (!loadCheckpointLocked(head["checkpoint"], true)) return false;
    }
    std::lock_guard<std::mutex> lk(mu_);
    meta_["joined"] = true;
    saveMetaLocked();
    return true;
}

bool HistorySync::pullLocked() {
    std::vector<json> rows;
    std::map<std::string, json> marks;
    bool ok = true;
    for (int page = 0; page < kSyncPages && !stop_; ++page) {
        std::uint64_t cursor = 0;
        {
            std::lock_guard<std::mutex> lk(mu_);
            cursor = meta_.value("cursor", std::uint64_t(0));
        }
        const auto body = engine("syncRequest", json{{"afterSeq", cursor}, {"skipChunks", true}});
        const auto resp = req("history.sync", v2::fromBase64(body.get<std::string>()));
        const auto r = engine("ingest", json{{"resp", v2::toBase64(resp)}});
        const auto head = u64(field(r, "headSeq"));
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (head < meta_.value("headSeq", std::uint64_t(0))) {
                log("откат сервера: голова " + std::to_string(head) + " меньше виденной "
                    + std::to_string(meta_.value("headSeq", std::uint64_t(0))) + " — журнал не применяется");
                ok = false;
                break;
            }
            meta_["headSeq"] = head;
        }
        if (r.contains("compacted") && r["compacted"].is_object() && cursor < u64(r["compacted"]["uptoSeq"])) {
            deliver(rows, marks);
            if (!loadCheckpointLocked(r["compacted"], false)) {
                ok = false;
                break;
            }
        }
        if (r.value("rejected", 0) > 0) {
            std::lock_guard<std::mutex> lk(mu_);
            const auto streak = meta_.value("rejectStreak", 0) + 1;
            meta_["rejectStreak"] = streak;
            saveMetaLocked();
            log(std::to_string(r.value("rejected", 0)) + " записей не открылись (ключ состояния?) — попытка "
                + std::to_string(streak));
            if (streak <= kRejectRetries) {
                ok = false;
                break; // курсор стоит: ключ может прийти позже
            }
        }
        absorbOps(field(r, "ops"), rows, marks);
        std::uint64_t maxSeq = 0;
        for (const auto &rec : field(r, "records")) maxSeq = std::max(maxSeq, u64(rec["seq"]));
        {
            std::lock_guard<std::mutex> lk(mu_);
            auto c = std::max(meta_.value("cursor", std::uint64_t(0)), maxSeq);
            const bool more = r.value("more", false);
            if (!more) {
                c = std::max(c, head);
                meta_["lastFullSyncMs"] = now();
            }
            meta_["cursor"] = c;
            meta_["rejectStreak"] = 0;
            saveMetaLocked();
            if (!more) break;
        }
    }
    deliver(rows, marks);
    return ok;
}

bool HistorySync::flushLocked(bool includeIncoming, bool dueOnly) {
    const auto t = now();
    std::vector<json> ops;
    std::size_t ownCount = 0;
    std::map<std::string, json> marksSent;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (!dueOnly || (ownDue_ && ownDue_ <= t)) {
            ownCount = pendingOwn_.size();
            ops.insert(ops.end(), pendingOwn_.begin(), pendingOwn_.end());
        }
        if (!dueOnly || (marksDue_ && marksDue_ <= t)) {
            marksSent = pendingMarks_;
            for (const auto &[k, m] : marksSent) ops.push_back(json{{"read", m}});
        }
    }
    std::vector<Incoming> incoming;
    if (includeIncoming) {
        bool any = false;
        {
            std::lock_guard<std::mutex> lk(mu_);
            for (const auto &x : incoming_) any = any || !dueOnly || x.due <= t;
        }
        if (any) {
            // Перед записью входящего — дотянуть журнал: другое своё устройство могло уже записать
            try {
                pullLocked();
            } catch (const std::exception &e) {
                log(std::string("sync перед записью входящего: ") + e.what());
            }
            std::lock_guard<std::mutex> lk(mu_);
            std::vector<Incoming> keep;
            for (auto &x : incoming_) {
                if (dueOnly && x.due > t) {
                    keep.push_back(std::move(x));
                } else if (!seen_.count(x.key)) {
                    incoming.push_back(std::move(x));
                }
            }
            incoming_ = std::move(keep);
        }
        for (const auto &x : incoming) ops.push_back(x.op);
    }
    if (ops.empty()) {
        std::lock_guard<std::mutex> lk(mu_);
        if (!ownCount) ownDue_ = pendingOwn_.empty() ? 0 : ownDue_;
        if (marksSent.empty()) marksDue_ = pendingMarks_.empty() ? 0 : marksDue_;
        return true;
    }
    try {
        appendLocked(ops, false, nullptr);
    } catch (const std::exception &e) {
        log(std::string("запись не ушла: ") + e.what());
        std::lock_guard<std::mutex> lk(mu_);
        for (auto &x : incoming) {
            x.due = t + cfg_.retryMs;
            incoming_.push_back(std::move(x));
        }
        if (ownCount) ownDue_ = t + cfg_.retryMs;
        if (!marksSent.empty()) marksDue_ = t + cfg_.retryMs;
        if (isCode(e, "ERROR_CODE_LIMIT")) {
            meta_["forceCheckpoint"] = true;
            nextCheckpoint_ = t;
        }
        return false;
    }
    std::lock_guard<std::mutex> lk(mu_);
    pendingOwn_.erase(pendingOwn_.begin(), pendingOwn_.begin() + std::min(ownCount, pendingOwn_.size()));
    for (const auto &[k, m] : marksSent) {
        if (const auto it = pendingMarks_.find(k); it != pendingMarks_.end() && it->second == m) pendingMarks_.erase(it);
    }
    ownDue_ = pendingOwn_.empty() ? 0 : t + cfg_.ownDelayMs;
    marksDue_ = pendingMarks_.empty() ? 0 : t + cfg_.markDelayMs;
    savePendingLocked();
    return true;
}

bool HistorySync::maybeCheckpointLocked(bool force) {
    const auto resp = req("history.head", v2::fromBase64(engine("headRequest", json::object()).get<std::string>()));
    const auto head = engine("ingestHead", json{{"resp", v2::toBase64(resp)}});
    const auto headSeq = u64(field(head, "headSeq"));
    const json cp = head.contains("checkpoint") && head["checkpoint"].is_object() ? head["checkpoint"] : json();
    const auto cpId = cp.is_object() ? u64(cp["id"]) : 0;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (headSeq < meta_.value("headSeq", std::uint64_t(0))) {
            log("откат сервера при точке — пропуск");
            return false;
        }
        if (meta_.contains("casFailedFor") && !meta_["casFailedFor"].is_null() && u64(meta_["casFailedFor"]) != cpId) {
            meta_.erase("casFailedFor"); // пришла новая точка
        }
        if (!force) {
            if (meta_.contains("casFailedFor")) return true; // точку уже сменило другое устройство — ждём новую
            const auto upto = cp.is_object() ? u64(cp["uptoSeq"]) : 0;
            const auto since = headSeq > upto ? headSeq - upto : 0;
            const bool aged = cp.is_object() && since > 0 && now() - i64(cp["createdMs"]) > cfg_.checkpointAgeMs;
            const bool due = meta_.value("forceCheckpoint", false) ? since > 0 || !cp.is_object()
                                                                     : (since > cfg_.checkpointRecords || aged);
            if (!due) return true;
        }
    }
    // Точку пишет устройство, догнавшее голову
    if (!pullLocked()) return false;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (meta_.value("cursor", std::uint64_t(0)) < headSeq) return false;
    }
    return buildCheckpointLocked(head);
}

bool HistorySync::buildCheckpointLocked(const json &head) {
    const json cp = head.contains("checkpoint") && head["checkpoint"].is_object() ? head["checkpoint"] : json();
    const auto expected = cp.is_object() ? u64(cp["id"]) : 0;
    const auto t = now();
    bool forced = false;
    json known;
    {
        std::lock_guard<std::mutex> lk(mu_);
        forced = meta_.value("forceCheckpoint", false);
        if (u64(field(meta_, "segmentsOf")) == expected && meta_.contains("segments")) known = meta_["segments"];
    }
    // Сегменты прежней точки, которых это устройство не знает (её писало другое) — из её сводки
    std::set<std::uint64_t> liveSeqs;
    if (cp.is_object()) {
        for (const auto &s : field(cp, "chunkSeqs")) liveSeqs.insert(u64(s));
        if (!known.is_object() && u64(cp["summarySeq"])) {
            json recs;
            for (const auto &op : getRecordsLocked({u64(cp["summarySeq"])}, &recs)) {
                if (!op.contains("summary")) continue;
                const bool stale = !recs.empty() && recs[0].value("stale", false);
                known = json::object();
                for (const auto &r : field(op["summary"], "segments")) {
                    known[str(r, "key")] = json{{"digest", str(r, "digest")}, {"seq", u64(r["seq"])}, {"stale", stale}};
                }
            }
        }
    }
    if (forced || !known.is_object()) known = json::object();
    // Все строки хранилища (без очищенных «у себя»), за горизонтом — без надгробий и сирот
    json states = json::array();
    cfg_.store->forEach([&](const json &s) {
        if (!cfg_.dropRow || !cfg_.dropRow(s)) states.push_back(s);
    });
    states = call("historyCompact", json{{"states", states}, {"nowMs", t}});
    std::map<std::string, std::vector<json>> bySegment;
    std::map<std::string, std::vector<json>> byChat;
    for (auto &s : states) {
        try {
            bySegment[call("historySegmentKey", json{{"state", s}}).get<std::string>()].push_back(s);
            byChat[chatKeyOfState(s)].push_back(s);
        } catch (const std::exception &e) {
            log(std::string("точка: строка пропущена: ") + e.what());
        }
    }
    json segments = json::array();
    json newKnown = json::object();
    std::vector<std::uint64_t> chunkSeqs;
    std::size_t uploaded = 0, reused = 0;
    for (const auto &[key, list] : bySegment) {
        if (stop_) return false; // остановка (выход): точку не дописываем
        // Части сегмента — каждая в одну запись журнала
        std::vector<std::vector<json>> parts(1);
        std::size_t bytes = 0;
        for (const auto &s : list) {
            const auto sz = s.dump().size();
            if (!parts.back().empty() && bytes + sz > kSegmentPartBytes) {
                parts.emplace_back();
                bytes = 0;
            }
            parts.back().push_back(s);
            bytes += sz;
        }
        for (std::size_t i = 0; i < parts.size(); ++i) {
            const auto partKey = i == 0 ? key : key + "#" + std::to_string(i + 1);
            const auto digest = call("historySegmentDigest", json{{"states", parts[i]}}).get<std::string>();
            std::uint64_t seq = 0;
            if (known.contains(partKey)) {
                const auto &k = known[partKey];
                if (str(k, "digest") == digest && !k.value("stale", false) && liveSeqs.count(u64(k["seq"]))) {
                    seq = u64(k["seq"]);
                    ++reused;
                }
            }
            if (!seq) {
                std::vector<json> ops;
                ops.reserve(parts[i].size());
                for (const auto &s : parts[i]) ops.push_back(json{{"state", s}});
                std::vector<std::uint64_t> got;
                appendLocked(ops, true, &got);
                if (got.empty()) return false;
                seq = got.front();
                for (std::size_t j = 1; j < got.size(); ++j) {
                    // Движок разбил часть на несколько записей — каждая своей ссылкой
                    const auto extraKey = partKey + "." + std::to_string(j + 1);
                    segments.push_back(json{{"key", extraKey}, {"digest", digest}, {"seq", std::to_string(got[j])}});
                    newKnown[extraKey] = json{{"digest", digest}, {"seq", got[j]}, {"stale", true}};
                    chunkSeqs.push_back(got[j]);
                }
                ++uploaded;
            }
            segments.push_back(json{{"key", partKey}, {"digest", digest}, {"seq", std::to_string(seq)}});
            newKnown[partKey] = json{{"digest", digest}, {"seq", seq}, {"stale", false}};
            chunkSeqs.push_back(seq);
        }
    }
    // Сводка: по чату — последняя видимая строка, маркер, непрочитанные, число строк
    json chats = json::array();
    for (const auto &[chatKey, list] : byChat) {
        const json *last = nullptr;
        std::int64_t lts = std::numeric_limits<std::int64_t>::min();
        std::string lid;
        for (const auto &s : list) {
            if (!visibleState(s)) continue;
            const auto p = rowPos(s);
            if (p && posAfter(p->tsMs, p->id, lts, lid)) {
                lts = p->tsMs;
                lid = p->id;
                last = &s;
            }
        }
        json c{{"chat", field(list.front(), "chat")}, {"unread", unreadCount(chatKey)}, {"rows", list.size()}};
        if (last) c["last"] = *last;
        if (const auto m = cfg_.store->mark(chatKey)) c["mark"] = *m;
        chats.push_back(std::move(c));
    }
    // Маркеры чатов без строк (всё за горизонтом) — тоже в сводку
    cfg_.store->forEachMark([&](const std::string &chatKey, const json &m) {
        if (!byChat.count(chatKey)) chats.push_back(json{{"chat", field(m, "chat")}, {"mark", m}, {"unread", 0}, {"rows", 0}});
    });
    const auto summaryOp = call("historySummary", json{{"chats", chats}, {"segments", segments},
                                                       {"tombstonesSinceMs", t - kHorizonMs}});
    std::vector<std::uint64_t> sseq;
    appendLocked({summaryOp}, true, &sseq);
    if (sseq.empty()) return false;
    const auto summarySeq = sseq.back();
    // Гонка: чужие записи между головой и сводкой были бы удалены точкой — тогда не фиксируем
    std::uint64_t cursor = 0;
    {
        std::lock_guard<std::mutex> lk(mu_);
        cursor = meta_.value("cursor", std::uint64_t(0));
    }
    {
        const auto body = engine("syncRequest", json{{"afterSeq", cursor}, {"skipChunks", true}});
        const auto r = engine("ingest", json{{"resp", v2::toBase64(req("history.sync", v2::fromBase64(body.get<std::string>())))}});
        for (const auto &rec : field(r, "records")) {
            if (u64(rec["seq"]) < summarySeq) {
                log("точка отложена: за время сборки в журнал пришли записи");
                pullLocked();
                return false;
            }
        }
        if (r.value("rejected", 0) > 0) return false;
    }
    std::uint64_t id = 0;
    try {
        const auto body = engine("commitRequest", json{{"expected", expected}, {"uptoSeq", summarySeq},
                                                      {"summarySeq", summarySeq}, {"chunkSeqs", chunkSeqs}});
        const auto resp = req("history.checkpoint.commit", v2::fromBase64(body.get<std::string>()));
        id = u64(engine("ingestCommit", json{{"resp", v2::toBase64(resp)}})["checkpointId"]);
    } catch (const std::exception &e) {
        if (isCode(e, "ERROR_CODE_DUPLICATE")) {
            std::lock_guard<std::mutex> lk(mu_);
            meta_["casFailedFor"] = expected;
            saveMetaLocked();
            log("точку уже сменило другое устройство — не повторяем до новой");
            return false;
        }
        throw;
    }
    std::lock_guard<std::mutex> lk(mu_);
    meta_["checkpoint"] = json{{"id", id}, {"uptoSeq", summarySeq}, {"summarySeq", summarySeq}, {"chunkSeqs", chunkSeqs},
                               {"createdMs", t}};
    meta_["segments"] = newKnown;
    meta_["segmentsOf"] = id;
    meta_["forceCheckpoint"] = false;
    meta_.erase("casFailedFor");
    meta_["cursor"] = std::max(meta_.value("cursor", std::uint64_t(0)), summarySeq);
    meta_["headSeq"] = std::max(meta_.value("headSeq", std::uint64_t(0)), summarySeq);
    saveMetaLocked();
    log("контрольная точка " + std::to_string(id) + " до seq " + std::to_string(summarySeq) + ": сегментов "
        + std::to_string(chunkSeqs.size()) + " (новых " + std::to_string(uploaded) + ", прежних " + std::to_string(reused)
        + "), чатов " + std::to_string(chats.size()));
    return true;
}

bool HistorySync::syncNow() {
    std::lock_guard<std::mutex> net(netMu_);
    try {
        if (!migrateLocked() || !joinLocked()) return false;
        return pullLocked();
    } catch (const std::exception &e) {
        log(std::string("sync: ") + e.what());
        return false;
    }
}

bool HistorySync::flushNow(bool includeIncoming) {
    std::lock_guard<std::mutex> net(netMu_);
    try {
        return flushLocked(includeIncoming, false);
    } catch (const std::exception &e) {
        log(std::string("запись: ") + e.what());
        return false;
    }
}

bool HistorySync::checkpointNow(bool force) {
    std::lock_guard<std::mutex> net(netMu_);
    try {
        return maybeCheckpointLocked(force);
    } catch (const std::exception &e) {
        log(std::string("точка: ") + e.what());
        return false;
    }
}

json HistorySync::status() {
    std::lock_guard<std::mutex> lk(mu_);
    json s{{"cursor", meta_.value("cursor", std::uint64_t(0))},
           {"headSeq", meta_.value("headSeq", std::uint64_t(0))},
           {"lastFullSyncMs", meta_.value("lastFullSyncMs", std::int64_t(0))},
           {"migrated", meta_.value("migrated", false)},
           {"joined", meta_.value("joined", false)},
           {"checkpointId", meta_.contains("checkpoint") && meta_["checkpoint"].is_object() ? u64(meta_["checkpoint"]["id"]) : 0},
           {"pendingOwn", pendingOwn_.size() + pendingMarks_.size()},
           {"pendingIncoming", incoming_.size()}};
    {
        std::unique_lock<std::mutex> e(engMu_, std::try_to_lock);
        s["engine"] = e.owns_lock() ? engine_ != nullptr : true;
    }
    return s;
}

void HistorySync::loop() {
    bool ready = false;
    while (!stop_) {
        const auto t = now();
        bool reopen = false, rotated = false, sync = false;
        {
            std::lock_guard<std::mutex> lk(mu_);
            reopen = std::exchange(reopenRequested_, false);
            rotated = std::exchange(rotated_, false);
            sync = std::exchange(syncRequested_, false) || t >= nextPoll_;
        }
        if (reopen) {
            std::lock_guard<std::mutex> lk(engMu_);
            engine_.reset();
        }
        if (rotated) {
            // Ключ состояния сменён: сегменты под прежним ключом отозванное устройство читает — точку заново
            std::lock_guard<std::mutex> lk(mu_);
            meta_["forceCheckpoint"] = true;
            meta_["segments"] = json::object();
            saveMetaLocked();
            nextCheckpoint_ = t + randomIn(0, cfg_.checkpointJitterMs);
        }
        if (t >= retryAt_ && (sync || !ready)) {
            std::lock_guard<std::mutex> net(netMu_);
            try {
                bool migratedNow = false;
                {
                    std::lock_guard<std::mutex> lk(mu_);
                    migratedNow = !meta_.value("migrated", false);
                }
                ready = migrateLocked();
                // Перенесённое — в журнал до входа: замена по точке (HIST-2) не должна его стереть
                if (ready && migratedNow) flushLocked(false, false);
                ready = ready && joinLocked() && pullLocked();
                std::lock_guard<std::mutex> lk(mu_);
                nextPoll_ = t + cfg_.pollMs;
                if (!ready) retryAt_ = t + cfg_.retryMs;
                // Пора ли точку: условия — по голове, точная проверка — перед сборкой
                if (ready && !nextCheckpoint_) {
                    const auto &cp = field(meta_, "checkpoint");
                    const auto upto = cp.is_object() ? u64(cp["uptoSeq"]) : 0;
                    const auto head = meta_.value("headSeq", std::uint64_t(0));
                    const auto since = head > upto ? head - upto : 0;
                    const bool aged = cp.is_object() && since > 0 && t - i64(cp["createdMs"]) > cfg_.checkpointAgeMs;
                    if (since > cfg_.checkpointRecords || aged || meta_.value("forceCheckpoint", false)) {
                        nextCheckpoint_ = t + randomIn(0, cfg_.checkpointJitterMs);
                    }
                }
            } catch (const std::exception &e) {
                log(std::string("sync: ") + e.what());
                ready = false;
                std::lock_guard<std::mutex> lk(mu_);
                retryAt_ = t + cfg_.retryMs;
                nextPoll_ = t + cfg_.pollMs;
            }
        }
        if (ready) {
            std::lock_guard<std::mutex> net(netMu_);
            try {
                flushLocked(true, true);
            } catch (const std::exception &e) {
                log(std::string("запись: ") + e.what());
            }
            bool cpDue = false;
            {
                std::lock_guard<std::mutex> lk(mu_);
                cpDue = nextCheckpoint_ && now() >= nextCheckpoint_;
                if (cpDue) nextCheckpoint_ = 0;
            }
            if (cpDue) {
                try {
                    maybeCheckpointLocked(false);
                } catch (const std::exception &e) {
                    log(std::string("точка: ") + e.what());
                }
            }
        }
        // Ждать до ближайшего срока
        std::int64_t wakeAt = 0;
        {
            std::lock_guard<std::mutex> lk(mu_);
            if (syncRequested_ || reopenRequested_) continue;
            wakeAt = nextPoll_;
            const auto consider = [&](std::int64_t x) {
                if (x > 0 && x < wakeAt) wakeAt = x;
            };
            if (!ready) consider(retryAt_);
            if (!pendingOwn_.empty()) consider(ownDue_ ? ownDue_ : now());
            if (!pendingMarks_.empty()) consider(marksDue_ ? marksDue_ : now());
            for (const auto &x : incoming_) consider(x.due);
            consider(nextCheckpoint_);
        }
        const auto waitMs = std::max<std::int64_t>(10, wakeAt - now());
        std::unique_lock<std::mutex> lk(cvMu_);
        cv_.wait_for(lk, std::chrono::milliseconds(std::min<std::int64_t>(waitMs, cfg_.pollMs)),
                     [this] { return kicked_ || stop_.load(); });
        kicked_ = false;
    }
}

} // namespace parvane::history
