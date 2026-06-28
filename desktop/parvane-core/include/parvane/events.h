// Parvane fork: C++-зеркало конверта событий и identity-пейлоадов из
// shared/parvane-types/src/lib.rs. Только то, что нужно для Фазы 2 (логин);
// messenger/cloud-пейлоады добавим в Фазе 3-4. Сериализация — nlohmann/json.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

namespace parvane {

using nlohmann::json;

// ── envelope ────────────────────────────────────────────────────────────────
// ParvaneEvent<T>: { id, from, ts, token, payload }. Шарды msg.* ждут полный
// конверт; identity.token.{issue,verify} принимают голый пейлоад (см. ниже).
inline json makeEvent(const std::string &id, const std::string &from,
                      std::int64_t ts, const std::string &token,
                      json payload) {
    return json{
        {"id", id},
        {"from", from},
        {"ts", ts},
        {"token", token},
        {"payload", std::move(payload)},
    };
}

// ── identity ────────────────────────────────────────────────────────────────
// identity.token.issue: запрос — голый IssueRequest, ответ — IssueResponse.
struct IssueRequest {
    std::string user;
    std::string password;

    json toJson() const { return json{{"user", user}, {"password", password}}; }
};

struct IssueResponse {
    bool ok = false;
    std::optional<std::string> token;
    std::optional<std::string> error;

    static IssueResponse fromJson(const json &j) {
        IssueResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("token"); it != j.end() && !it->is_null())
            r.token = it->get<std::string>();
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

// identity.token.verify: запрос — голый VerifyRequest, ответ — VerifyResponse.
struct VerifyRequest {
    std::string token;

    json toJson() const { return json{{"token", token}}; }
};

struct VerifyResponse {
    bool ok = false;
    std::optional<std::string> user;
    std::optional<std::string> error;

    static VerifyResponse fromJson(const json &j) {
        VerifyResponse r;
        r.ok = j.value("ok", false);
        if (auto it = j.find("user"); it != j.end() && !it->is_null())
            r.user = it->get<std::string>();
        if (auto it = j.find("error"); it != j.end() && !it->is_null())
            r.error = it->get<std::string>();
        return r;
    }
};

} // namespace parvane
