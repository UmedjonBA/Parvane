// Parvane fork: запросы аккаунта по протоколу v2 (spec 029, T038) — вход, регистрация, профили, устройства,
// привязка, превью, карта, ICE. Прежде клиент ходил сюда «мостом» (`v2_bridge`: запросы вида v1 → методы v2);
// моста больше нет — это типизированные обёртки над `preauth()` (канал PRE, до входа) и `Control` (после входа).
// Зеркало web `v2/bridge.ts` в части методов (правило E6-1): список методов — `conformance/sync-rules.json`.
// Отказ сервера — исключение `V2Error` с кодом; текст на языке интерфейса подставляет клиент.
#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "parvane/v2_control.h"

namespace parvane::v2::account {

using nlohmann::json;

// ── канал PRE (до входа) ──────────────────────────────────────────────────────

struct ServerInfo {
    std::string domain;
    std::string confirm = "none"; // none | email | telegram — первый способ подтверждения из описания сервера
    bool emailRequired = false;
    std::string telegramBot;
    // Все объявленные способы регистрации (как в описании сервера).
    std::vector<std::string> registration;
};
// server.describe одноразовым соединением. Бросает при недоступности.
[[nodiscard]] ServerInfo describeServer(const std::string &gatewayUrl, const std::string &clientVersion = "desktop");

struct IssueRequest {
    std::string user;
    std::string password;
    std::string deviceId;
    std::string loginToken;  // двухфакторный вход: подтверждённый в Telegram токен
    std::string trustSecret; // доверенное устройство 2FA
    std::string clientKind = "desktop";
    bool cancelDeletion = false; // spec 027: вход в аккаунт, ждущий удаления, — восстановить его
    // ID-01: {"proof": base64, "tsMs": n} по сохранённому состоянию движка; null — первый вход устройства
    json deviceProof;
};
struct IssueResult {
    bool ok = false;
    std::string token;
    std::string trustSecret;
    std::string address; // spec 026: адрес аккаунта (вход прежним ником после смены ведёт на новый)
    bool twofaRequired = false;
    std::string loginToken;
    std::string telegramBot;
    bool confirmRequired = false; // аккаунт ждёт подтверждения почты
    std::int64_t deletionAtMs = 0; // пароль верен, аккаунт ждёт удаления (без отмены токена нет)
    std::string errorCode;         // ERROR_CODE_* отказа метода; пусто — транспорт в порядке
};
// identity.session.issue. Отказ метода — в errorCode (не бросает); сбой транспорта — бросает.
[[nodiscard]] IssueResult issueSession(const std::string &gatewayUrl, const IssueRequest &req,
                                       const std::string &clientVersion = "desktop");

struct RegisterResult {
    bool ok = false;
    bool confirmRequired = false;
    std::string telegramToken;
    bool emailRequired = false; // сервер подтверждает почтой, а почты в запросе нет
    std::string errorCode;
};
[[nodiscard]] RegisterResult registerAccount(const std::string &gatewayUrl, const std::string &user,
                                             const std::string &password, const std::string &email,
                                             const std::string &invite = std::string(),
                                             const std::string &clientVersion = "desktop");
// identity.account.confirm_email: пусто — подтверждено, иначе код отказа.
[[nodiscard]] std::string confirmEmail(const std::string &gatewayUrl, const std::string &user,
                                       const std::string &code, const std::string &clientVersion = "desktop");
[[nodiscard]] bool registerStatus(const std::string &gatewayUrl, const std::string &user,
                                  const std::string &token, const std::string &clientVersion = "desktop");

// ── после входа (Control: своё соединение с JWT) ─────────────────────────────

struct TwoFactor {
    bool enabled = false;
    bool telegramLinked = false;
    std::string telegramBot;
    std::string trustSecret;
};
[[nodiscard]] TwoFactor getTwoFactor(Control &c);
// Свежий пароль нужен методу v2 всегда (класс 15: session.reauth перед запросом).
[[nodiscard]] TwoFactor setTwoFactor(Control &c, bool enabled, const std::string &password);
void changePassword(Control &c, const std::string &oldPassword, const std::string &newPassword);

struct Profile {
    std::string address;
    std::string displayName;
    std::string avatarFileId;
    std::string bio;
    std::string birthday;
    std::string personalChannel;
    std::string phone;
    std::string rootKey;
    std::optional<int> nameColor;
    // Вид для кэша профилей клиента (те же ключи, что у прежнего ответа): username, display_name, avatar, …
    [[nodiscard]] json toJson() const;
};
// identity.profile.resolve; адреса чужих серверов — у их серверов (spec 028). Отказ чужого сервера —
// профиль неизвестен; его код — в federationError (если задан), остальные отказы бросают.
[[nodiscard]] std::vector<Profile> resolveProfiles(Control &c, const std::vector<std::string> &addresses,
                                                   std::string *federationError = nullptr);
[[nodiscard]] std::vector<Profile> searchDirectory(Control &c, const std::string &query);
struct ProfilePatch {
    std::string displayName; // обязателен методу
    std::optional<std::string> bio, birthday, personalChannel, phone;
    std::optional<int> nameColor;
};
void setProfile(Control &c, const ProfilePatch &patch);
void setAvatar(Control &c, const std::string &fileId);

struct Device {
    std::string deviceId;
    std::string clientKind;
    std::int64_t lastSeenMs = 0;
    std::int64_t createdMs = 0;
    bool legacy = false;
};
// Неотозванные устройства аккаунта.
[[nodiscard]] std::vector<Device> listDevices(Control &c);
// P-07: отзыв — с текущим паролем (session.reauth); неверный пароль — V2Error. Устройство журнала v2 сервер
// этим методом не снимает (INVALID) — его отзывает подписанная запись журнала (Session::revokeDevice), пароль
// при этом уже проверен.
void revokeDevice(Control &c, const std::string &deviceId, const std::string &password);

// ── привязка устройства (LINK-1) ────────────────────────────────────────────
void linkOffer(Control &c, const std::string &ephPub, const std::string &commitment,
               const std::string &signingKey, bool revoke);
struct LinkOffer {
    std::string deviceId, ephPub, commitment, signingKey, challengePub;
    std::int64_t createdMs = 0;
};
struct LinkGrant {
    std::string boxPayload, ephPub;
};
struct LinkPoll {
    std::vector<LinkOffer> offers;
    std::optional<LinkGrant> grant;
    std::string challenge;
};
[[nodiscard]] LinkPoll linkPoll(Control &c);
void linkChallenge(Control &c, const std::string &deviceId, const std::string &ephPub);
void linkGrant(Control &c, const std::string &deviceId, const std::string &boxPayload,
               const std::string &ephPub);

// ── превью, карта, звонки, блобы ────────────────────────────────────────────
struct LinkPreview {
    std::string url, siteName, title, description;
    std::string image; // base64, шард отдаёт не для всех страниц
    std::string imageMime;
    [[nodiscard]] json toJson() const; // {url, site_name, title, description, image, image_mime}
};
[[nodiscard]] LinkPreview previewLink(Control &c, const std::string &url);
// Тайл карты (MAP-1): PNG байтами; пусто — тайла нет.
[[nodiscard]] std::string mapTile(Control &c, std::uint32_t zoom, std::uint32_t x, std::uint32_t y,
                                  std::int64_t timeoutMs = 15000);
struct IceServer {
    std::vector<std::string> urls;
    std::string username, credential;
};
struct IceConfig {
    std::vector<IceServer> servers;
    std::int64_t ttlSecs = 0;
};
[[nodiscard]] IceConfig iceConfig(Control &c);
void deleteBlob(Control &c, const std::string &fileId);

} // namespace parvane::v2::account
