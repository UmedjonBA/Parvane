// Parvane fork (spec 035 T125): личное состояние через модель движка — см. state_model.h.
#include "parvane/state_model.h"

#include "parvane/engine_host.h"
#include "parvane/gen/model.h"
#include "parvane/v2_engine.h"

#include <openssl/rand.h>

#include <chrono>
#include <deque>
#include <filesystem>

namespace parvane::v2 {

namespace {

constexpr int kUnavailable = 11;
constexpr int kMaxRounds = 64; // потолок кругов «запрос → ответ → новые запросы» одного вызова

const char *const kCodes[] = {
    "ERROR_CODE_UNSPECIFIED", "ERROR_CODE_INVALID",     "ERROR_CODE_FORBIDDEN",       "ERROR_CODE_NOT_FOUND",
    "ERROR_CODE_DUPLICATE",   "ERROR_CODE_RATE_LIMITED", "ERROR_CODE_UPGRADE_REQUIRED", "ERROR_CODE_REVOKED",
    "ERROR_CODE_REAUTH_REQUIRED", "ERROR_CODE_LIMIT",   "ERROR_CODE_FEDERATION_UNAVAILABLE", "ERROR_CODE_UNAVAILABLE",
};

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

} // namespace

int errorCodeNumber(const std::string &code) {
    for (int i = 1; i < int(sizeof(kCodes) / sizeof(kCodes[0])); ++i) {
        if (code == kCodes[i]) return i;
    }
    return kUnavailable;
}

StateModel::StateModel(std::unique_ptr<engine::Host> host, Send send) : host_(std::move(host)), send_(std::move(send)) {}

StateModel::~StateModel() = default;

std::unique_ptr<StateModel> StateModel::open(const Client &client, const std::string &user, const std::string &deviceId,
                                             const std::string &domain, const std::string &dir, Send send,
                                             std::string *error) {
    if (!client.hasStateKey()) {
        if (error) *error = "нет ключа личного состояния";
        return nullptr;
    }
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    std::string key(32, '\0');
    if (RAND_bytes(reinterpret_cast<unsigned char *>(key.data()), 32) != 1) {
        if (error) *error = "RAND_bytes";
        return nullptr;
    }
    const json cfg{{"user", user},
                   {"device_id", deviceId},
                   {"domain", domain},
                   {"now_ms", std::to_string(nowMs())},
                   {"device_key", gen::toBase64(key)}};
    auto host = engine::Host::open(cfg, dir, error);
    if (!host) return nullptr;
    std::unique_ptr<StateModel> m(new StateModel(std::move(host), std::move(send)));
    const auto adopted = m->host_->adoptStateKeys(client.raw());
    if (!adopted.ok()) {
        if (error) *error = "adoptStateKeys: " + adopted.error;
        return nullptr;
    }
    m->run(json{{"requests", adopted.requests}});
    return m;
}

bool StateModel::run(const json &first) {
    bool ok = true;
    std::deque<json> queue;
    for (const auto &r : first.value("requests", json::array())) queue.push_back(r);
    for (int round = 0; !queue.empty() && round < kMaxRounds * 8; ++round) {
        const auto req = std::move(queue.front());
        queue.pop_front();
        int code = 0;
        std::string body;
        try {
            body = send_(req, &code);
        } catch (const std::exception &) {
            code = kUnavailable;
        }
        if (code != 0) ok = false;
        const json input{{"kind", "SERVER_INPUT_KIND_RESPONSE"},
                         {"method", req.value("method", std::string())},
                         {"req_id", req.contains("req_id") ? req["req_id"] : json("0")},
                         {"body", gen::toBase64(body)},
                         {"error", code}};
        const auto st = host_->ingest(input);
        if (!st.ok()) ok = false;
        for (const auto &r : st.requests) queue.push_back(r);
    }
    return ok;
}

json StateModel::view() {
    auto v = host_->read("stateViewV1", json::object());
    if (!v.is_object() || v.contains("error")) return json{{"snapshot", json::object()}};
    return v;
}

bool StateModel::apply(const json &desired, const std::vector<std::string> &kinds, bool prune, bool rewrite,
                       const json &base) {
    json args{{"snapshot", desired.is_object() ? desired : json::object()},
              {"kinds", kinds},
              {"prune", prune},
              {"rewrite", rewrite}};
    if (base.is_object()) args["base"] = base;
    const auto st = host_->step("stateApplyV1", args);
    if (!st.ok()) return false;
    return run(json{{"requests", st.requests}});
}

bool StateModel::submit(const json &intent) {
    const auto st = host_->submit(intent);
    if (!st.ok()) return false;
    return run(json{{"requests", st.requests}});
}

bool StateModel::sync() {
    const auto before = view().dump();
    const auto st = host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "journal.state"}});
    if (st.ok()) run(json{{"requests", st.requests}});
    return view().dump() != before;
}

} // namespace parvane::v2
