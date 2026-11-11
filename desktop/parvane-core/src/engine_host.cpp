// Parvane fork (spec 035): хост модели движка — см. engine_host.h.
#include "parvane/engine_host.h"

#include <algorithm>
#include <optional>

#include <parvane_protocol.h>

namespace parvane::engine {

namespace {

json parseOut(char *p) {
    if (!p) return json{{"error", "Internal"}};
    auto j = json::parse(p, nullptr, false);
    pv_free_string(p);
    if (j.is_discarded()) return json{{"error", "Malformed"}};
    return j;
}

std::uint64_t u64Of(const json &v) {
    if (v.is_number_unsigned()) return v.get<std::uint64_t>();
    if (v.is_number_integer()) return static_cast<std::uint64_t>(v.get<std::int64_t>());
    if (v.is_string()) {
        try {
            return std::stoull(v.get<std::string>());
        } catch (...) {
            return 0;
        }
    }
    return 0;
}

bool isError(const json &j) { return j.is_object() && j.contains("error") && j["error"].is_string(); }

} // namespace

std::string kindOfKey(const std::string &key) {
    const auto a = key.find('/');
    if (a == std::string::npos) return key;
    const auto b = key.find('/', a + 1);
    return key.substr(a + 1, b == std::string::npos ? std::string::npos : b - a - 1);
}

std::unique_ptr<Host> Host::open(const json &config, const std::string &storeDir, std::string *error, store_fs::FsOps &fs,
                                 Step *opened) {
    return openOn(config, storeDir, fs, nullptr, error, opened);
}

std::unique_ptr<Host> Host::openMemory(const json &config, std::string *error, Step *opened) {
    auto mem = store_fs::memoryFs();
    auto &fs = *mem;
    return openOn(config, "/memory/store", fs, std::move(mem), error, opened);
}

std::unique_ptr<Host> Host::openOn(const json &config, const std::string &storeDir, store_fs::FsOps &fs,
                                   std::unique_ptr<store_fs::FsOps> owned, std::string *error, Step *opened) {
    std::string err;
    auto st = store_fs::Store::open(storeDir, fs, &err);
    if (!st) {
        if (error) *error = err.empty() ? "store_fs: не открыт" : err;
        return nullptr;
    }
    char *perr = nullptr;
    PvEngine *e = pv_engine_open(config.dump().c_str(), &perr);
    if (!e) {
        if (error) *error = perr ? perr : "pv_engine_open";
        if (perr) pv_free_string(perr);
        return nullptr;
    }
    std::unique_ptr<Host> h(new Host(e, std::move(st), std::move(owned)));
    auto s = h->step("start", json::object());
    if (!s.ok()) {
        if (error) *error = s.error;
        return nullptr;
    }
    if (opened) *opened = std::move(s);
    return h;
}

Host::~Host() {
    if (e_) pv_engine_free(e_);
}

json Host::callLocked(const std::string &name, const json &args) {
    const auto a = args.is_null() ? std::string("{}") : args.dump();
    return parseOut(pv_engine_call(e_, name.c_str(), a.c_str()));
}

json Host::raw(const std::string &name, const json &args) {
    std::lock_guard<std::mutex> lk(mu_);
    return callLocked(name, args);
}

void Host::driveLocked(json first, Step &st) {
    // Тот же порядок, что у эталонного хоста движка (tests/model_common): стек итогов; после пачки —
    // запросы, затем чтения, затем `storeCommitted` (его итог обрабатывается первым).
    std::vector<json> queue;
    queue.push_back(std::move(first));
    while (!queue.empty()) {
        json out = std::move(queue.back());
        queue.pop_back();
        if (isError(out)) {
            if (st.error.empty()) st.error = out["error"].get<std::string>();
            continue;
        }
        if (out.contains("open") && !out["open"].is_null()) st.open = out["open"];
        if (out.contains("delta") && out["delta"].is_object()) {
            const auto &d = out["delta"];
            const auto rev = u64Of(d.value("revision", json()));
            st.revisions.push_back(rev);
            if (rev > revision_) revision_ = rev;
            if (d.contains("changes") && d["changes"].is_array())
                for (const auto &c : d["changes"]) st.changes.push_back(c);
        }
        std::optional<std::uint64_t> batchId;
        if (out.contains("store_batch") && out["store_batch"].is_object()) {
            const auto &b = out["store_batch"];
            std::string err;
            if (!store_->commitJson(b.dump(), &err)) {
                // Пачки нет ни на диске, ни в памяти — её запросы не уходят (подтверждения сервер повторит).
                st.error = err.empty() ? "store_fs: пачка не записана" : err;
                return;
            }
            ++commits_;
            ++st.batches;
            if (b.contains("puts") && b["puts"].is_array()) {
                for (const auto &p : b["puts"]) {
                    const auto k = kindOfKey(p.value("key", std::string()));
                    if (std::find(st.putKinds.begin(), st.putKinds.end(), k) == st.putKinds.end()) st.putKinds.push_back(k);
                }
            }
            batchId = u64Of(b.value("batch_id", json()));
        }
        if (out.contains("requests") && out["requests"].is_array())
            for (const auto &r : out["requests"]) st.requests.push_back(r);
        if (out.contains("store_reads") && out["store_reads"].is_array()) {
            for (const auto &r : out["store_reads"]) {
                const auto loaded = json::parse(store_->readJson(r.dump()), nullptr, false);
                queue.push_back(callLocked("storeLoaded", loaded));
            }
        }
        if (batchId) queue.push_back(callLocked("storeCommitted", json{{"batch_id", std::to_string(*batchId)}}));
    }
}

Step Host::step(const std::string &name, const json &args) {
    std::lock_guard<std::mutex> lk(mu_);
    Step st;
    auto out = callLocked(name, args);
    if (isError(out)) {
        st.error = out["error"].get<std::string>();
        return st;
    }
    driveLocked(std::move(out), st);
    return st;
}

json Host::read(const std::string &name, const json &args) {
    std::lock_guard<std::mutex> lk(mu_);
    for (int i = 0; i < 8; ++i) {
        auto out = callLocked(name, args);
        if (!out.is_object() || !out.contains("pending") || out["pending"].is_null()) return out;
        // Строк нет в памяти: дочитать и повторить (contracts/engine-api.md, historyPage)
        const auto &p = out["pending"];
        const json reads = p.is_array() ? p : (p.contains("store_reads") ? p["store_reads"] : json::array({p}));
        Step st;
        for (const auto &r : reads) {
            const auto loaded = json::parse(store_->readJson(r.dump()), nullptr, false);
            driveLocked(callLocked("storeLoaded", loaded), st);
        }
    }
    return json{{"error", "NotFound"}};
}

std::uint64_t Host::revision() const {
    std::lock_guard<std::mutex> lk(mu_);
    return revision_;
}

std::uint64_t Host::commits() const {
    std::lock_guard<std::mutex> lk(mu_);
    return commits_;
}

} // namespace parvane::engine
