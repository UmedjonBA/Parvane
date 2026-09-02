// Parvane fork: высокоуровневый E2E-слой поверх parvane-e2e (vodozemac Olm/Megolm)
// и ITransport. Паритет с web e2e.ts: мультидевайс (per-device бандлы, fan-out
// sealed-копий по устройствам получателя и своим устройствам), подпись Ed25519
// устройства (sender_signing_key, подписанные sync/edit/delete/react/pin),
// верификация отправителя против каталога устройств (анти-имперсонация),
// legacy-подписанты и экспорт/слияние состояния для авто-линковки истории.
//
// Персист — в `storeDir` (создаётся, права 0700). Потокобезопасно (внутренний
// мьютекс). Приватные ключи не покидают процесс (кроме явного экспорта для
// линковки — его шифрует вызывающий).
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace parvane {
class ITransport;
}

namespace parvane::e2e {

// Инициализировать устройство: загрузить/создать Olm-аккаунт и device_id,
// опубликовать бандл (однократно; далее — пополнение one-time по остатку из
// identity.device.list, порог 5). Идемпотентно в рамках процесса.
void initDevice(ITransport &t, const std::string &self, const std::string &token,
                const std::string &storeDir);

[[nodiscard]] bool ready();

// Свой identity-ключ (Curve25519, base64), device_id и Ed25519 signing_key.
[[nodiscard]] std::string myIdentity();
[[nodiscard]] std::string deviceId();
// device_id из device.json каталога persist'а ДО initDevice (нужен при выдаче
// JWT, когда E2E ещё не поднят). Пусто для новой установки.
[[nodiscard]] std::string peekDeviceId(const std::string &storeDir);
[[nodiscard]] std::string signingKey();
// Подпись строки Ed25519-ключом аккаунта (base64 без padding). "" если не готов.
[[nodiscard]] std::string sign(const std::string &data);
// Подписи той же строки legacy-подписантами (прежние устройства, принятые при
// линковке) → [(signing_key, signature)]. Для extra_signing в sync.
[[nodiscard]] std::vector<std::pair<std::string, std::string>> extraSignatures(
    const std::string &data);

// Per-device копия шифртекста (MessageDeviceCopy в parvane-types).
struct Copy {
    std::string recipient;   // адрес получателя; "" — self-копия (по signing_key)
    std::string signing_key; // только для self-копий: signing_key ЦЕЛЕВОГО устройства
    std::string device_id;
    std::string ciphertext;
    std::uint32_t ctype = 0;

    [[nodiscard]] nlohmann::json toJson() const;
};

struct Sealed {
    nlohmann::json content;   // {kind:"encrypted",ciphertext,ctype,sender_identity,sender_signing_key}
    std::vector<Copy> copies; // копии по устройствам получателя + свои устройства
};

// Запечатать `contentJson` (MessageContent) для всех устройств `to` + своих
// устройств (best-effort). Реальный отправитель — внутри шифртекста (sealed
// sender). nullopt — нет ни одного пригодного устройства/сессии.
[[nodiscard]] std::optional<Sealed> sealForAddress(const std::string &to,
                                                   const std::string &contentJson,
                                                   ITransport &t, const std::string &token);

// Расшифровать входящий Encrypted-JSON → внутренний конверт
// {"from":<отправитель>,"content":<MessageContent>}. "" при ошибке.
[[nodiscard]] std::string open(const std::string &from_hint, const std::string &encryptedJson);

// Выбрать из copies[] (InboxPush) копию для ЭТОГО устройства и подставить в
// content (ciphertext/ctype). `self` — свой адрес. Возвращает изменённый content.
[[nodiscard]] nlohmann::json pickOwnCopy(const nlohmann::json &content,
                                         const nlohmann::json &copies,
                                         const std::string &self);

// Верификация отправителя (анти-имперсонация): принадлежит ли sender_identity
// устройствам адреса claimedFrom (каталог identity, одна принудительная
// перечитка при промахе). Spoofed — каталог есть, ключа нет; Unknown — каталог
// недоступен.
enum class Verdict { Ok, Spoofed, Unknown };
[[nodiscard]] Verdict verifySender(const std::string &claimedFrom,
                                   const std::string &senderIdentity, ITransport &t,
                                   const std::string &token);
void rememberContactIdentity(const std::string &contact, const std::string &identity);

// Safety number с контактом. "" если нет identity контакта.
[[nodiscard]] std::string safetyNumber(const std::string &contact);

// ── Группы (Megolm) ──────────────────────────────────────────────────────────
[[nodiscard]] std::string groupSessionKey(const std::string &groupId);
[[nodiscard]] std::uint64_t groupEpoch(const std::string &groupId);
[[nodiscard]] bool groupSyncRecipients(const std::string &groupId,
                                       const std::vector<std::string> &members);
void groupRotate(const std::string &groupId);
// Прогреть каталоги устройств участников (ДО groupSessionKey — ротация при
// исчезновении устройства должна случиться до выбора эпохи).
void primeContactDevices(const std::vector<std::string> &contacts, ITransport &t,
                         const std::string &token);
[[nodiscard]] std::string groupSeal(const std::string &groupId,
                                    const std::string &contentJson,
                                    std::uint64_t expectedEpoch);
void groupAcceptKey(const std::string &groupId, const std::string &senderIdentity,
                    const std::string &sessionKeyB64, std::uint64_t epoch);
[[nodiscard]] std::string groupOpen(const std::string &groupId,
                                    const std::string &senderIdentity,
                                    const std::string &ciphertext);

// ── Устройства ───────────────────────────────────────────────────────────────
// После отзыва СВОЕГО устройства: убрать из каталога, ротировать все свои
// исходящие Megolm-сессии (отозванное не должно читать новые сообщения).
void forgetOwnDevice(const std::string &deviceId);
// Ротировать группы, где есть контакт (его устройство исчезло из каталога).
void rotateGroupsWith(const std::string &contact);

// ── Линковка истории ─────────────────────────────────────────────────────────
// Свежая установка без истории (нет сессий/входящих Megolm/legacy-подписантов;
// `decCacheEmpty` — от вызывающего: кэш расшифровки живёт в клиенте).
[[nodiscard]] bool needsHistoryLink(bool decCacheEmpty);
// Полный экспорт состояния в формате PersistedE2eState веб-клиента (JSON):
// аккаунт и legacy-подписанты — libolm-pickle под случайным pickleKey, входящие
// Megolm — exported session keys, decCache — от вызывающего.
[[nodiscard]] std::string exportStateJson(const nlohmann::json &decCache);
// СЛИЯНИЕ чужого экспорта: decCache (через onDecCache), входящие Megolm,
// аккаунт(ы) как legacy-подписанты. Своя identity/сессии/deviceId сохраняются.
[[nodiscard]] bool importLinkedHistory(
    const std::string &stateJson,
    const std::function<void(const std::string &uuid, const nlohmann::json &inner)> &onDecCache);

} // namespace parvane::e2e
