// Parvane fork: мост «запросы клиента → методы v2» — см. v2_bridge.h.
#include "parvane/v2_bridge.h"

#include <cctype>

#include <set>

#include <map>

#include <algorithm>

#include <chrono>
#include <vector>

#include "parvane/itransport.h"
#include "parvane/v2_link.h"

namespace parvane::v2 {

namespace {

using nlohmann::json;

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string str(const json &o, const char *key) {
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

// Тело запроса: клиенты шлют либо голый объект, либо ParvaneEvent с `payload`.
json bodyOf(const json &j) {
    if (j.is_object() && j.contains("payload") && j["payload"].is_object()) {
        auto body = j["payload"];
        if (!body.contains("token") && j.contains("token")) body["token"] = j["token"];
        return body;
    }
    return j.is_object() ? j : json::object();
}

json fail(const std::string &text) { return json{{"ok", false}, {"error", text}}; }

// Прежние формулировки сервера (identity) по методу и коду v2.
std::string errorText(const std::string &subject, const std::string &code) {
    if (code == "ERROR_CODE_RATE_LIMITED") return "слишком много попыток, попробуйте позже";
    if (code == "ERROR_CODE_UPGRADE_REQUIRED") return "нужна новая версия приложения";
    if (code == "ERROR_CODE_UNAVAILABLE") return "сервер временно недоступен";
    if (code == "ERROR_CODE_REVOKED") return "устройство отозвано";
    if (subject == "identity.token.issue") {
        if (code == "ERROR_CODE_INVALID") return "пустой логин или пароль";
        return "неверный логин или пароль";
    }
    if (subject == "identity.user.register") {
        if (code == "ERROR_CODE_DUPLICATE") return "логин занят";
        if (code == "ERROR_CODE_INVALID") {
            return "некорректный ник или пароль: ник — 2–64 символа (латиница в нижнем регистре, цифры, _ . -), "
                   "пароль — не короче 8 символов";
        }
        return "нужен валидный инвайт-код";
    }
    if (subject == "identity.email.confirm") {
        if (code == "ERROR_CODE_EXPIRED") return "код истёк, запросите новый";
        if (code == "ERROR_CODE_INVALID") return "пустой логин или код";
        return "неверный код";
    }
    if (subject == "identity.user.twofa") {
        if (code == "ERROR_CODE_REAUTH_REQUIRED") return "требуется пароль";
        if (code == "ERROR_CODE_FORBIDDEN") return "сначала привяжите Telegram (подтверждение через бота)";
    }
    if (subject == "identity.password.change") {
        if (code == "ERROR_CODE_INVALID") return "пароль короче 8 символов";
        if (code == "ERROR_CODE_DUPLICATE") return "новый пароль совпадает со старым";
        return "неверный пароль";
    }
    if (subject == "identity.device.revoke") {
        if (code == "ERROR_CODE_REAUTH_REQUIRED") return "требуется пароль";
        if (code == "ERROR_CODE_NOT_FOUND") return "устройство не найдено";
        return "неверный пароль";
    }
    if (subject.rfind("identity.link.", 0) == 0) {
        if (code == "ERROR_CODE_NOT_FOUND" || code == "ERROR_CODE_EXPIRED") return "оффер линковки не найден или истёк";
        if (code == "ERROR_CODE_INVALID") return "некорректный эфемерный ключ";
    }
    if (code == "ERROR_CODE_NOT_FOUND") return "не найдено";
    if (code == "ERROR_CODE_INVALID") return "некорректный запрос";
    if (code == "ERROR_CODE_LIMIT") return "квота исчерпана";
    if (code == "ERROR_CODE_EXPIRED") return "срок действия истёк";
    return "отказано";
}

json profileToV1(const json &p) {
    json u{{"username", p.contains("user") && p["user"].is_object() ? str(p["user"], "address") : std::string()},
           {"display_name", str2(p, "displayName", "display_name")}};
    const auto put = [&](const char *key, const std::string &value) {
        if (!value.empty()) u[key] = value;
    };
    put("avatar", str2(p, "avatarFileId", "avatar_file_id"));
    put("bio", str(p, "bio"));
    put("birthday", str(p, "birthday"));
    put("personal_channel", str2(p, "personalChannel", "personal_channel"));
    put("phone", str(p, "phone"));
    put("root_key", str2(p, "rootKey", "root_key"));
    if (field(p, "nameColor", "name_color")) u["name_color"] = int2(p, "nameColor", "name_color");
    return u;
}

json profilesToV1(const json &resp, const char *key) {
    auto users = json::array();
    if (const auto it = resp.find(key); it != resp.end() && it->is_array()) {
        for (const auto &p : *it) users.push_back(profileToV1(p));
    }
    return json{{"ok", true}, {"users", users}};
}

// Запросы, которым нужен свежий пароль (класс 15): сначала session.reauth.
void reauth(Control &c, const std::string &password) {
    if (!password.empty()) (void)c.call("identity.session.reauth", json{{"password", password}});
}

json twofaToV1(const json &resp) {
    json out{{"ok", true}, {"enabled", flag2(resp, "enabled", "enabled")},
             {"telegram_linked", flag2(resp, "telegramLinked", "telegram_linked")}};
    if (const auto bot = str2(resp, "telegramBot", "telegram_bot"); !bot.empty()) out["telegram_bot"] = bot;
    if (const auto secret = str2(resp, "trustSecret", "trust_secret"); !secret.empty()) out["trust_secret"] = secret;
    return out;
}

// «v1, если жив»: обслуживает v1-шифрование и каталог v1-устройств.

} // namespace

BridgeTransport::BridgeTransport(BridgeConfig cfg)
: cfg_(std::move(cfg)), token_(cfg_.token) {}

BridgeTransport::~BridgeTransport() {
    if (control_) control_->close();
}

Control &BridgeTransport::control(const std::string &requestToken) {
    std::lock_guard<std::mutex> lk(mu_);
    if (!requestToken.empty() && requestToken != token_) {
        // Другой токен (перевыпуск, одноразовый транспорт входа) — новое соединение
        if (cfg_.token.empty()) {
            token_ = requestToken;
            if (control_) control_->close();
            control_.reset();
        }
    }
    if (!control_) {
        ControlConfig c;
        c.gatewayUrl = cfg_.gatewayUrl;
        c.clientVersion = cfg_.clientVersion;
        c.log = cfg_.log;
        const auto token = token_;
        c.token = [token] { return token; };
        control_ = std::make_unique<Control>(std::move(c));
    }
    return *control_;
}

json BridgeTransport::describe() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (described_.is_object()) return described_;
    }
    auto got = preauth(cfg_.gatewayUrl, "server.describe", json::object(), cfg_.clientVersion);
    std::lock_guard<std::mutex> lk(mu_);
    described_ = got;
    return got;
}

bool BridgeTransport::viaV2(const std::string &subject, const json &raw, std::string *reply) {
    const auto p = bodyOf(raw);
    const auto token = str(p, "token");
    const auto pre = [&](const std::string &method, const json &request) {
        return preauth(cfg_.gatewayUrl, method, request, cfg_.clientVersion);
    };
    json out;
    if (subject == "identity.server.info") {
        const auto d = describe();
        std::string mode = "none";
        if (const auto it = d.find("registration"); it != d.end() && it->is_array() && !it->empty() && (*it)[0].is_string()) {
            mode = (*it)[0].get<std::string>();
        }
        out = json{{"domain", str(d, "domain")}, {"email_required", mode == "email"}, {"confirm", mode},
                   {"telegram_bot", str2(d, "telegramBot", "telegram_bot")}};
    } else if (subject == "identity.token.issue") {
        json req{{"login", str(p, "user")}, {"password", str(p, "password")}, {"device_id", str(p, "device_id")},
                 {"login_token", str(p, "login_token")}, {"trust_secret", str(p, "trust_secret")},
                 {"client_kind", str(p, "client").empty() ? std::string("desktop") : str(p, "client")}};
        // ID-01: устройство, уже привязанное к журналу, доказывает свой ключ
        if (!str(p, "device_id").empty() && cfg_.sessionProof) {
            if (const auto proof = cfg_.sessionProof(str(p, "user"), str(p, "device_id")); proof.is_object()) {
                req["device_proof"] = proof.value("proof", std::string());
                req["proof_ts_ms"] = std::to_string(proof.value("tsMs", std::int64_t(0)));
            }
        }
        // spec 027: вход в аккаунт, ждущий удаления, — только с явной отменой удаления
        if (flag2(p, "cancel_deletion", "cancelDeletion")) req["cancel_deletion"] = true;
        const auto r = pre("identity.session.issue", req);
        if (flag2(r, "twofaRequired", "twofa_required")) {
            out = json{{"ok", false}, {"twofa_required", true}, {"login_token", str2(r, "loginToken", "login_token")},
                       {"telegram_bot", str2(r, "telegramBot", "telegram_bot")}};
        } else if (flag2(r, "confirmRequired", "confirm_required")) {
            out = fail("почта не подтверждена");
        } else if (const auto deletionAt = int2(r, "deletionAtMs", "deletion_at_ms"); deletionAt > 0 && str(r, "token").empty()) {
            // Пароль верен, аккаунт ждёт удаления: токена нет без явной отмены
            out = json{{"ok", false}, {"deletion_at_ms", deletionAt}};
        } else {
            out = json{{"ok", true}, {"token", str(r, "token")}};
            if (const auto secret = str2(r, "trustSecret", "trust_secret"); !secret.empty()) out["trust_secret"] = secret;
            // spec 026: адрес аккаунта (вход прежним ником после смены ника ведёт на новый)
            if (const auto address = str(r, "address"); !address.empty()) out["address"] = address;
        }
    } else if (subject == "identity.user.register") {
        try {
            const auto r = pre("identity.account.register",
                json{{"user", str(p, "user")}, {"password", str(p, "password")}, {"invite", str(p, "invite")},
                     {"email", str(p, "email")}});
            out = json{{"ok", true}, {"confirm_required", flag2(r, "confirmRequired", "confirm_required")}};
            if (const auto t = str2(r, "telegramToken", "telegram_token"); !t.empty()) out["telegram_token"] = t;
        } catch (const V2Error &e) {
            // Сервер с подтверждением по почте, а почты в запросе нет — экран
            // входа ждёт именно эту формулировку, чтобы спросить адрес.
            if (e.code() == "ERROR_CODE_INVALID" && str(p, "email").empty()) {
                bool email = false;
                try {
                    const auto d = describe();
                    if (const auto it = d.find("registration"); it != d.end() && it->is_array()) {
                        for (const auto &m : *it) email = email || (m.is_string() && m.get<std::string>() == "email");
                    }
                } catch (const std::exception &) {
                }
                if (email) {
                    *reply = fail("нужен корректный email").dump();
                    return true;
                }
            }
            throw;
        }
    } else if (subject == "identity.email.confirm") {
        (void)pre("identity.account.confirm_email", json{{"user", str(p, "user")}, {"code", str(p, "code")}});
        out = json{{"ok", true}};
    } else if (subject == "identity.register.status") {
        const auto r = pre("identity.account.register_status", json{{"user", str(p, "user")}, {"token", str(p, "token")}});
        out = json{{"confirmed", flag2(r, "confirmed", "confirmed")}};
    } else if (subject == "identity.user.twofa") {
        auto &c = control(token);
        if (!p.contains("enabled") || p["enabled"].is_null()) {
            out = twofaToV1(c.call("identity.account.get_2fa", json::object()));
        } else {
            const auto password = str(p, "password");
            // Свежий пароль нужен методу v2 всегда — тумблер настроек спрашивает его
            // и при включении, и при выключении 2FA. Запрос без пароля (прежний
            // вызов) — по v1, пока оно живо; без v1 сервер ответит REAUTH_REQUIRED.
            reauth(c, password);
            out = twofaToV1(c.call("identity.account.set_2fa", json{{"enabled", p["enabled"]}, {"password", password}}));
        }
    } else if (subject == "identity.password.change") {
        auto &c = control(token);
        reauth(c, str(p, "old_password"));
        (void)c.call("identity.account.change_password",
            json{{"old_password", str(p, "old_password")}, {"new_password", str(p, "new_password")}});
        out = json{{"ok", true}};
    } else if (subject == "identity.user.resolve") {
        auto users = json::array();
        if (const auto it = p.find("usernames"); it != p.end() && it->is_array()) {
            for (const auto &u : *it) {
                if (u.is_string()) users.push_back(json{{"address", u.get<std::string>()}});
            }
        }
        auto &c = control(token);
        out = profilesToV1(c.call("identity.profile.resolve", json{{"users", users}}), "profiles");
        // Федерация (spec 028): адреса, которых свой сервер не знает, — их серверам (по домену)
        std::set<std::string> known;
        for (const auto &u : out["users"]) known.insert(u.value("username", std::string()));
        std::map<std::string, json> byDomain;
        for (const auto &u : users) {
            const auto address = u.value("address", std::string());
            const auto at = address.find('@');
            if (known.count(address) || at == std::string::npos) continue;
            auto domain = address.substr(at + 1);
            std::transform(domain.begin(), domain.end(), domain.begin(), [](unsigned char ch) {
                return char(std::tolower(ch));
            });
            if (!byDomain.count(domain)) byDomain[domain] = json::array();
            byDomain[domain].push_back(u);
        }
        for (const auto &[domain, group] : byDomain) {
            try {
                const auto remote = profilesToV1(
                    c.call("identity.profile.resolve", json{{"users", group}}, 15000, domain), "profiles");
                for (const auto &u : remote["users"]) out["users"].push_back(u);
            } catch (const std::exception &) {
                // Сервер недоступен или федерация выключена — профиль неизвестен, как несуществующий адрес
            }
        }
    } else if (subject == "identity.user.search") {
        out = profilesToV1(control(token).call("identity.directory.search", json{{"query", str(p, "query")}}), "results");
    } else if (subject == "identity.user.setname") {
        json r{{"display_name", str(p, "display_name")}};
        for (const char *key : {"bio", "birthday", "personal_channel", "phone"}) {
            if (p.contains(key) && p[key].is_string()) r[key] = p[key];
        }
        if (p.contains("name_color") && p["name_color"].is_number_integer()) {
            r["name_color"] = std::to_string(p["name_color"].get<std::int64_t>());
        }
        (void)control(token).call("identity.profile.set_name", r);
        out = json{{"ok", true}};
    } else if (subject == "identity.user.setavatar") {
        (void)control(token).call("identity.profile.set_avatar", json{{"avatar_file_id", str(p, "file_id")}});
        out = json{{"ok", true}};
    } else if (subject == "identity.user.setkey") {
        out = json{{"ok", true}}; // ключ подписи v1-звонков: в v2 сигнал подписывает устройство
    } else if (subject == "identity.device.list") {
        const auto r = control(token).call("identity.device.list", json::object());
        auto devices = json::array();
        if (const auto it = r.find("devices"); it != r.end() && it->is_array()) {
            for (const auto &d : *it) {
                if (flag2(d, "revoked", "revoked")) continue;
                devices.push_back(json{{"device_id", str2(d, "deviceId", "device_id")}, {"signing_key", ""},
                                       {"identity_key", ""}, {"one_time_available", 0},
                                       {"updated_at", int2(d, "lastSeenMs", "last_seen_ms") / 1000},
                                       {"created_at", int2(d, "createdMs", "created_ms") / 1000},
                                       {"legacy", flag2(d, "legacy", "legacy")},
                                       {"client_kind", str2(d, "clientKind", "client_kind")}});
            }
        }
        out = json{{"ok", true}, {"devices", devices}};
    } else if (subject == "identity.device.revoke") {
        auto &c = control(token);
        reauth(c, str(p, "password")); // неверный пароль — отказ здесь
        try {
            (void)c.call("identity.device.revoke", json{{"device_id", str(p, "device_id")}});
        } catch (const V2Error &e) {
            // Метод сервера снимает только v1-устройства; устройство журнала v2
            // (INVALID) отзывается подписанной записью журнала — её пишет сессия
            // движка следом за этим запросом. Пароль уже проверен.
            if (e.code() != "ERROR_CODE_INVALID") throw;
        }
        out = json{{"ok", true}};
    } else if (subject == "identity.link.offer") {
        (void)control(token).call("identity.link.offer",
            json{{"eph_pub", str(p, "eph_pub")}, {"commitment", str(p, "commitment")},
                 {"signing_key", str(p, "signing_key")}, {"revoke", p.value("revoke", false)}});
        out = json{{"ok", true}};
    } else if (subject == "identity.link.poll") {
        const auto r = control(token).call("identity.link.poll", json::object());
        auto offers = json::array();
        if (const auto it = r.find("offers"); it != r.end() && it->is_array()) {
            for (const auto &o : *it) {
                offers.push_back(json{{"device_id", str2(o, "deviceId", "device_id")}, {"eph_pub", str2(o, "ephPub", "eph_pub")},
                                      {"commitment", str(o, "commitment")}, {"signing_key", str2(o, "signingKey", "signing_key")},
                                      {"created_at", int2(o, "createdMs", "created_ms") / 1000},
                                      {"challenge_pub", str2(o, "challengePub", "challenge_pub")}});
            }
        }
        out = json{{"ok", true}, {"offers", offers}};
        if (const auto it = r.find("grant"); it != r.end() && it->is_object()) {
            out["grant"] = json{{"box_payload", str2(*it, "boxPayload", "box_payload")}, {"eph_pub", str2(*it, "ephPub", "eph_pub")}};
        }
        if (const auto challenge = str(r, "challenge"); !challenge.empty()) out["challenge"] = challenge;
    } else if (subject == "identity.link.challenge") {
        (void)control(token).call("identity.link.challenge",
            json{{"device_id", str(p, "device_id")}, {"eph_pub", str(p, "eph_pub")}});
        out = json{{"ok", true}};
    } else if (subject == "identity.link.grant") {
        (void)control(token).call("identity.link.grant",
            json{{"device_id", str(p, "device_id")}, {"box_payload", str(p, "box_payload")}, {"eph_pub", str(p, "eph_pub")}});
        out = json{{"ok", true}};
    } else if (subject == "preview.link.fetch") {
        const auto r = control(token).call("preview.link", json{{"url", str(p, "url")}});
        json page{{"url", str(r, "url")}};
        if (const auto v = str2(r, "siteName", "site_name"); !v.empty()) page["site_name"] = v;
        if (const auto v = str(r, "title"); !v.empty()) page["title"] = v;
        if (const auto v = str(r, "description"); !v.empty()) page["description"] = v;
        // Картинка превью (bytes в proto3-JSON — base64); шард отдаёт её не для всех страниц
        if (const auto mime = str2(r, "imageMime", "image_mime"); !mime.empty() && !str(r, "image").empty()) {
            page["image"] = str(r, "image");
            page["image_mime"] = mime;
        }
        out = json{{"ok", true}, {"webpage", page}};
    } else if (subject == "preview.map.tile") {
        const auto r = control(token).call("preview.map_tile",
            json{{"zoom", p.value("z", 0u)}, {"x", p.value("x", 0u)}, {"y", p.value("y", 0u)}});
        out = json{{"ok", true}, {"png_base64", str(r, "png")}}; // bytes в proto3-JSON — base64
    } else if (subject == "call.ice.request") {
        const auto r = control(token).call("call.ice_config", json::object());
        auto servers = json::array();
        if (const auto it = r.find("servers"); it != r.end() && it->is_array()) {
            for (const auto &s : *it) {
                json server{{"urls", s.contains("urls") && s["urls"].is_array() ? s["urls"] : json::array()}};
                if (const auto v = str(s, "username"); !v.empty()) server["username"] = v;
                if (const auto v = str(s, "credential"); !v.empty()) server["credential"] = v;
                servers.push_back(std::move(server));
            }
        }
        const auto left = (int2(r, "expiresMs", "expires_ms") - nowMs()) / 1000;
        // Шард call отвечает событием: клиенты читают серверы из `payload`
        out = json{{"payload", {{"ice_servers", servers}, {"ttl_secs", left > 0 ? left : 0}}}};
    } else if (subject == "file.delete") {
        (void)control(token).call("cloud.blob.delete", json{{"file_id", str(p, "file_id")}});
        out = json{{"ok", true}};
    } else {
        return false;
    }
    *reply = out.dump();
    return true;
}

std::string BridgeTransport::request(const std::string &subject, const std::string &payload,
                                     std::int64_t timeout_ms) {
    (void)timeout_ms;
    std::string reply;
    try {
        const auto raw = json::parse(payload, nullptr, false);
        if (viaV2(subject, raw.is_discarded() ? json::object() : raw, &reply)) return reply;
    } catch (const V2Error &e) {
        // Отказ метода — ответ прежнего вида; потеря связи и «версия клиента ниже минимальной» — ошибка
        // транспорта.
        const bool transport = e.code() == "ERROR_CODE_UNAVAILABLE" || e.code() == "ERROR_CODE_UPGRADE_REQUIRED";
        if (!transport) {
            auto out = fail(errorText(subject, e.code()));
            out["error_code"] = e.code(); // клиент подставляет текст на языке интерфейса
            return out.dump();
        }
        throw TransportError(e.code() == "ERROR_CODE_UPGRADE_REQUIRED"
            ? std::string("gateway: upgrade_required") : "gateway v2: " + subject + ": недоступен");
    } catch (const TransportError &) {
        throw;
    } catch (const std::exception &e) {
        throw TransportError(std::string("gateway v2: ") + subject + ": " + e.what());
    }
    // Протокола v1 нет (spec 029): запрос без метода v2 — ошибка вызывающего
    throw TransportError("gateway: нет метода v2 для " + subject);
}

void BridgeTransport::publish(const std::string &subject, const std::string &payload) {
    (void)subject;
    (void)payload;
}

void BridgeTransport::requestMany(const std::string &subject, const std::string &payload,
                                  const ReplyHandler &onReply, std::int64_t timeout_ms) {
    (void)payload;
    (void)onReply;
    (void)timeout_ms;
    throw TransportError("gateway: нет метода v2 для " + subject);
}

void BridgeTransport::subscribe(const std::string &subject, Handler handler) {
    std::lock_guard<std::mutex> lk(handlersMu_);
    handlers_.emplace(subject, std::move(handler));
}


} // namespace parvane::v2
