// Parvane fork: запросы аккаунта по протоколу v2 — см. v2_account.h.
#include "parvane/v2_account.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <map>
#include <set>

#include "parvane/v2_engine.h"
#include "parvane/v2_link.h"

namespace parvane::v2::account {

namespace {

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string str(const json &o, const char *key) {
    if (!o.is_object()) return std::string();
    const auto it = o.find(key);
    return (it != o.end() && it->is_string()) ? it->get<std::string>() : std::string();
}

std::string str2(const json &o, const char *camel, const char *snake) {
    const auto *v = field(o, camel, snake);
    return (v && v->is_string()) ? v->get<std::string>() : std::string();
}

bool flag2(const json &o, const char *camel, const char *snake) {
    const auto *v = field(o, camel, snake);
    return v && v->is_boolean() && v->get<bool>();
}

// int64 в proto3-JSON — строка либо число.
std::int64_t int2(const json &o, const char *camel, const char *snake) {
    const auto *v = field(o, camel, snake);
    if (!v) return 0;
    if (v->is_number_integer()) return v->get<std::int64_t>();
    if (v->is_string()) {
        try {
            return std::stoll(v->get<std::string>());
        } catch (const std::exception &) {
        }
    }
    return 0;
}

Profile profileOf(const json &p) {
    Profile out;
    if (p.contains("user") && p["user"].is_object()) out.address = str(p["user"], "address");
    out.displayName = str2(p, "displayName", "display_name");
    out.avatarFileId = str2(p, "avatarFileId", "avatar_file_id");
    out.bio = str(p, "bio");
    out.birthday = str(p, "birthday");
    out.personalChannel = str2(p, "personalChannel", "personal_channel");
    out.phone = str(p, "phone");
    out.rootKey = str2(p, "rootKey", "root_key");
    if (field(p, "nameColor", "name_color")) out.nameColor = int(int2(p, "nameColor", "name_color"));
    return out;
}

std::vector<Profile> profilesOf(const json &resp, const char *key) {
    std::vector<Profile> out;
    if (const auto it = resp.find(key); it != resp.end() && it->is_array()) {
        for (const auto &p : *it) out.push_back(profileOf(p));
    }
    return out;
}

// Запросы, которым нужен свежий пароль (класс 15): сначала session.reauth.
void reauth(Control &c, const std::string &password) {
    if (!password.empty()) (void)c.call("identity.session.reauth", json{{"password", password}});
}

TwoFactor twoFactorOf(const json &resp) {
    TwoFactor out;
    out.enabled = flag2(resp, "enabled", "enabled");
    out.telegramLinked = flag2(resp, "telegramLinked", "telegram_linked");
    out.telegramBot = str2(resp, "telegramBot", "telegram_bot");
    out.trustSecret = str2(resp, "trustSecret", "trust_secret");
    return out;
}

} // namespace

json Profile::toJson() const {
    json u{{"username", address}, {"display_name", displayName}};
    const auto put = [&](const char *key, const std::string &value) {
        if (!value.empty()) u[key] = value;
    };
    put("avatar", avatarFileId);
    put("bio", bio);
    put("birthday", birthday);
    put("personal_channel", personalChannel);
    put("phone", phone);
    put("root_key", rootKey);
    if (nameColor) u["name_color"] = *nameColor;
    return u;
}

json LinkPreview::toJson() const {
    json page{{"url", url}};
    if (!siteName.empty()) page["site_name"] = siteName;
    if (!title.empty()) page["title"] = title;
    if (!description.empty()) page["description"] = description;
    if (!imageMime.empty() && !image.empty()) {
        page["image"] = image;
        page["image_mime"] = imageMime;
    }
    return page;
}

// ── канал PRE ───────────────────────────────────────────────────────────────

ServerInfo describeServer(const std::string &gatewayUrl, const std::string &clientVersion) {
    const auto d = preauth(gatewayUrl, "server.describe", json::object(), clientVersion);
    ServerInfo out;
    out.domain = str(d, "domain");
    out.telegramBot = str2(d, "telegramBot", "telegram_bot");
    if (const auto it = d.find("registration"); it != d.end() && it->is_array()) {
        for (const auto &m : *it) {
            if (m.is_string()) out.registration.push_back(m.get<std::string>());
        }
    }
    if (!out.registration.empty()) out.confirm = out.registration.front();
    out.emailRequired = out.confirm == "email";
    return out;
}

IssueResult issueSession(const std::string &gatewayUrl, const IssueRequest &req, const std::string &clientVersion) {
    json body{{"login", req.user}, {"password", req.password}, {"device_id", req.deviceId},
              {"login_token", req.loginToken}, {"trust_secret", req.trustSecret},
              {"client_kind", req.clientKind.empty() ? std::string("desktop") : req.clientKind}};
    // ID-01: устройство, уже привязанное к журналу, доказывает свой ключ
    if (!req.deviceId.empty() && req.deviceProof.is_object()) {
        body["device_proof"] = req.deviceProof.value("proof", std::string());
        body["proof_ts_ms"] = std::to_string(req.deviceProof.value("tsMs", std::int64_t(0)));
    }
    // spec 027: вход в аккаунт, ждущий удаления, — только с явной отменой удаления
    if (req.cancelDeletion) body["cancel_deletion"] = true;
    IssueResult out;
    json r;
    try {
        r = preauth(gatewayUrl, "identity.session.issue", body, clientVersion);
    } catch (const V2Error &e) {
        // Потеря связи и «версия клиента ниже минимальной» — сбой транспорта, остальное — отказ метода
        if (e.code() == "ERROR_CODE_UNAVAILABLE" || e.code() == "ERROR_CODE_UPGRADE_REQUIRED") throw;
        out.errorCode = e.code();
        return out;
    }
    if (flag2(r, "twofaRequired", "twofa_required")) {
        out.twofaRequired = true;
        out.loginToken = str2(r, "loginToken", "login_token");
        out.telegramBot = str2(r, "telegramBot", "telegram_bot");
        return out;
    }
    if (flag2(r, "confirmRequired", "confirm_required")) {
        out.confirmRequired = true;
        return out;
    }
    const auto deletionAt = int2(r, "deletionAtMs", "deletion_at_ms");
    out.token = str(r, "token");
    if (deletionAt > 0 && out.token.empty()) {
        // Пароль верен, аккаунт ждёт удаления: токена нет без явной отмены
        out.deletionAtMs = deletionAt;
        return out;
    }
    out.ok = !out.token.empty();
    out.trustSecret = str2(r, "trustSecret", "trust_secret");
    out.address = str(r, "address");
    return out;
}

RegisterResult registerAccount(const std::string &gatewayUrl, const std::string &user, const std::string &password,
                               const std::string &email, const std::string &invite,
                               const std::string &clientVersion) {
    RegisterResult out;
    try {
        const auto r = preauth(gatewayUrl, "identity.account.register",
            json{{"user", user}, {"password", password}, {"invite", invite}, {"email", email}}, clientVersion);
        out.ok = true;
        out.confirmRequired = flag2(r, "confirmRequired", "confirm_required");
        out.telegramToken = str2(r, "telegramToken", "telegram_token");
        return out;
    } catch (const V2Error &e) {
        if (e.code() == "ERROR_CODE_UNAVAILABLE" || e.code() == "ERROR_CODE_UPGRADE_REQUIRED") throw;
        out.errorCode = e.code();
        // Сервер с подтверждением по почте, а почты в запросе нет — экран входа спросит адрес
        if (e.code() == "ERROR_CODE_INVALID" && email.empty()) {
            try {
                const auto info = describeServer(gatewayUrl, clientVersion);
                out.emailRequired = std::find(info.registration.begin(), info.registration.end(), "email")
                    != info.registration.end();
            } catch (const std::exception &) {
            }
        }
        return out;
    }
}

std::string confirmEmail(const std::string &gatewayUrl, const std::string &user, const std::string &code,
                         const std::string &clientVersion) {
    try {
        (void)preauth(gatewayUrl, "identity.account.confirm_email", json{{"user", user}, {"code", code}},
                      clientVersion);
        return std::string();
    } catch (const V2Error &e) {
        if (e.code() == "ERROR_CODE_UNAVAILABLE" || e.code() == "ERROR_CODE_UPGRADE_REQUIRED") throw;
        return e.code();
    }
}

bool registerStatus(const std::string &gatewayUrl, const std::string &user, const std::string &token,
                    const std::string &clientVersion) {
    const auto r = preauth(gatewayUrl, "identity.account.register_status", json{{"user", user}, {"token", token}},
                           clientVersion);
    return flag2(r, "confirmed", "confirmed");
}

// ── после входа ─────────────────────────────────────────────────────────────

TwoFactor getTwoFactor(Control &c) {
    return twoFactorOf(c.call("identity.account.get_2fa", json::object()));
}

TwoFactor setTwoFactor(Control &c, bool enabled, const std::string &password) {
    reauth(c, password);
    return twoFactorOf(c.call("identity.account.set_2fa", json{{"enabled", enabled}, {"password", password}}));
}

void changePassword(Control &c, const std::string &oldPassword, const std::string &newPassword) {
    reauth(c, oldPassword);
    (void)c.call("identity.account.change_password",
                 json{{"old_password", oldPassword}, {"new_password", newPassword}});
}

static std::string lower(std::string v) {
    std::transform(v.begin(), v.end(), v.begin(), [](unsigned char ch) { return char(std::tolower(ch)); });
    return v;
}

std::vector<Profile> resolveProfiles(Control &c, const std::vector<std::string> &addresses,
                                     std::string *federationError) {
    auto users = json::array();
    for (const auto &a : addresses) users.push_back(json{{"address", a}});
    auto out = profilesOf(c.call("identity.profile.resolve", json{{"users", users}}), "profiles");
    // Федерация (spec 028): адреса, которых свой сервер не знает, — их серверам (по домену)
    std::set<std::string> known;
    for (const auto &p : out) known.insert(p.address);
    std::map<std::string, json> byDomain;
    for (const auto &address : addresses) {
        const auto at = address.find('@');
        if (known.count(address) || at == std::string::npos) continue;
        auto domain = address.substr(at + 1);
        std::transform(domain.begin(), domain.end(), domain.begin(),
                       [](unsigned char ch) { return char(std::tolower(ch)); });
        if (!byDomain.count(domain)) byDomain[domain] = json::array();
        byDomain[domain].push_back(json{{"address", address}});
    }
    for (const auto &[domain, group] : byDomain) {
        try {
            // чужой сервер отвечает только за свой домен и только за спрошенные адреса
            std::set<std::string> asked;
            for (const auto &u : group) asked.insert(lower(u.value("address", std::string())));
            for (auto &p : profilesOf(c.call("identity.profile.resolve", json{{"users", group}}, 15000, domain),
                                      "profiles")) {
                const auto addr = lower(p.address);
                const auto at = addr.rfind('@');
                if (at == std::string::npos || addr.substr(at + 1) != domain || !asked.count(addr)) continue;
                out.push_back(std::move(p));
            }
        } catch (const V2Error &e) {
            // Сервер недоступен или федерация выключена — профиль неизвестен, как несуществующий адрес
            if (federationError) *federationError = e.code();
        } catch (const std::exception &e) {
            if (federationError) *federationError = e.what();
        }
    }
    return out;
}

std::vector<Profile> searchDirectory(Control &c, const std::string &query) {
    return profilesOf(c.call("identity.directory.search", json{{"query", query}}), "results");
}

void setProfile(Control &c, const ProfilePatch &patch) {
    json r{{"display_name", patch.displayName}};
    if (patch.bio) r["bio"] = *patch.bio;
    if (patch.birthday) r["birthday"] = *patch.birthday;
    if (patch.personalChannel) r["personal_channel"] = *patch.personalChannel;
    if (patch.phone) r["phone"] = *patch.phone;
    if (patch.nameColor) r["name_color"] = std::to_string(*patch.nameColor);
    (void)c.call("identity.profile.set_name", r);
}

void setAvatar(Control &c, const std::string &fileId) {
    (void)c.call("identity.profile.set_avatar", json{{"avatar_file_id", fileId}});
}

std::vector<Device> listDevices(Control &c) {
    const auto r = c.call("identity.device.list", json::object());
    std::vector<Device> out;
    if (const auto it = r.find("devices"); it != r.end() && it->is_array()) {
        for (const auto &d : *it) {
            if (flag2(d, "revoked", "revoked")) continue;
            Device dev;
            dev.deviceId = str2(d, "deviceId", "device_id");
            dev.clientKind = str2(d, "clientKind", "client_kind");
            dev.lastSeenMs = int2(d, "lastSeenMs", "last_seen_ms");
            dev.createdMs = int2(d, "createdMs", "created_ms");
            dev.legacy = flag2(d, "legacy", "legacy");
            out.push_back(std::move(dev));
        }
    }
    return out;
}

void revokeDevice(Control &c, const std::string &deviceId, const std::string &password) {
    reauth(c, password); // неверный пароль — отказ здесь
    try {
        (void)c.call("identity.device.revoke", json{{"device_id", deviceId}});
    } catch (const V2Error &e) {
        if (e.code() != "ERROR_CODE_INVALID") throw;
    }
}

// ── привязка устройства ─────────────────────────────────────────────────────

void linkOffer(Control &c, const std::string &ephPub, const std::string &commitment,
               const std::string &signingKey, bool revoke) {
    (void)c.call("identity.link.offer", json{{"eph_pub", ephPub}, {"commitment", commitment},
                                             {"signing_key", signingKey}, {"revoke", revoke}});
}

LinkPoll linkPoll(Control &c) {
    const auto r = c.call("identity.link.poll", json::object());
    LinkPoll out;
    if (const auto it = r.find("offers"); it != r.end() && it->is_array()) {
        for (const auto &o : *it) {
            LinkOffer offer;
            offer.deviceId = str2(o, "deviceId", "device_id");
            offer.ephPub = str2(o, "ephPub", "eph_pub");
            offer.commitment = str(o, "commitment");
            offer.signingKey = str2(o, "signingKey", "signing_key");
            offer.createdMs = int2(o, "createdMs", "created_ms");
            offer.challengePub = str2(o, "challengePub", "challenge_pub");
            out.offers.push_back(std::move(offer));
        }
    }
    if (const auto it = r.find("grant"); it != r.end() && it->is_object()) {
        out.grant = LinkGrant{str2(*it, "boxPayload", "box_payload"), str2(*it, "ephPub", "eph_pub")};
    }
    out.challenge = str(r, "challenge");
    return out;
}

void linkChallenge(Control &c, const std::string &deviceId, const std::string &ephPub) {
    (void)c.call("identity.link.challenge", json{{"device_id", deviceId}, {"eph_pub", ephPub}});
}

void linkGrant(Control &c, const std::string &deviceId, const std::string &boxPayload, const std::string &ephPub) {
    (void)c.call("identity.link.grant",
                 json{{"device_id", deviceId}, {"box_payload", boxPayload}, {"eph_pub", ephPub}});
}

// ── превью, карта, звонки, блобы ────────────────────────────────────────────

LinkPreview previewLink(Control &c, const std::string &url) {
    const auto r = c.call("preview.link", json{{"url", url}});
    LinkPreview out;
    out.url = str(r, "url");
    out.siteName = str2(r, "siteName", "site_name");
    out.title = str(r, "title");
    out.description = str(r, "description");
    out.imageMime = str2(r, "imageMime", "image_mime");
    out.image = str(r, "image"); // bytes в proto3-JSON — base64
    return out;
}

std::string mapTile(Control &c, std::uint32_t zoom, std::uint32_t x, std::uint32_t y, std::int64_t timeoutMs) {
    const auto r = c.call("preview.map_tile", json{{"zoom", zoom}, {"x", x}, {"y", y}}, timeoutMs);
    const auto png = str(r, "png"); // bytes в proto3-JSON — base64
    return png.empty() ? std::string() : fromBase64(png);
}

IceConfig iceConfig(Control &c) {
    const auto r = c.call("call.ice_config", json::object());
    IceConfig out;
    if (const auto it = r.find("servers"); it != r.end() && it->is_array()) {
        for (const auto &s : *it) {
            IceServer server;
            if (s.contains("urls") && s["urls"].is_array()) {
                for (const auto &u : s["urls"]) {
                    if (u.is_string()) server.urls.push_back(u.get<std::string>());
                }
            }
            server.username = str(s, "username");
            server.credential = str(s, "credential");
            out.servers.push_back(std::move(server));
        }
    }
    const auto left = (int2(r, "expiresMs", "expires_ms") - nowMs()) / 1000;
    out.ttlSecs = left > 0 ? left : 0;
    return out;
}

void deleteBlob(Control &c, const std::string &fileId) { c.deleteBlob(fileId); }

} // namespace parvane::v2::account
