// Parvane fork (spec 035 T125): личное состояние через модель движка — см. state_model.h.
#include "parvane/state_model.h"

#include "parvane/engine_host.h"

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
    return run_(host_->step("stateApplyV1", args));
}

bool StateModel::submit(const json &intent) { return run_(host_->submit(intent)); }

bool StateModel::sync() {
    const auto before = view().dump();
    run_(host_->ingest(json{{"kind", "SERVER_INPUT_KIND_EVENT"}, {"method", "journal.state"}}));
    return view().dump() != before;
}

} // namespace parvane::v2
