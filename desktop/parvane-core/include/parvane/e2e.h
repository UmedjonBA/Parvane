// Parvane fork: высокоуровневый E2E-слой (Фаза 2) поверх parvane-e2e (vodozemac
// Olm) и ITransport. Оркестрирует X3DH (fetch prekey-бандла при первом сообщении),
// шифрование/расшифровку и публикацию своих prekeys. Реальный контент сообщения
// шифруется; сервер видит только вариант MessageContent::Encrypted.
//
// MVP: аккаунт и сессии — В ПАМЯТИ (персист между рестартами — follow-up).
// Потокобезопасно (внутренний мьютекс). Приватные ключи не покидают процесс.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace parvane {
class ITransport;
}

namespace parvane::e2e {

// Инициализировать устройство: загрузить/создать Olm-аккаунт (персист в
// `storeDir`) и опубликовать пачку prekeys в identity. Идемпотентно.
// `storeDir` — каталог для аккаунта и сессий (создаётся, права 0700); пустой —
// без персиста (в памяти).
void initDevice(ITransport &t, const std::string &self, const std::string &token,
                const std::string &storeDir);

// Устройство инициализировано?
[[nodiscard]] bool ready();

// Зашифровать `contentJson` (сериализованный MessageContent) для получателя `to`.
// Нет сессии → X3DH через identity.prekeys.fetch. Возвращает JSON варианта
// Encrypted {kind:"encrypted",ciphertext,ctype,sender_identity} или "" при ошибке.
[[nodiscard]] std::string sealFor(const std::string &to, const std::string &contentJson,
                                  ITransport &t, const std::string &token);

// Расшифровать входящий Encrypted-JSON → внутренний конверт JSON
// {"from":<реальный отправитель>,"content":<MessageContent>}. `from_hint` —
// открытый from события (пуст при sealed sender; сессия ищется по identity из
// конверта). "" при ошибке (нет сессии / порча / чужой ключ).
[[nodiscard]] std::string open(const std::string &from_hint, const std::string &encryptedJson);

// Safety number с контактом (для верификации против MITM). "" если ещё нет
// сессии/идентити контакта.
[[nodiscard]] std::string safetyNumber(const std::string &contact);

// ── E2E группы (Фаза 3, Megolm/sender keys) ──────────────────────────────────
// Свой identity-ключ (base64) — для SKDM sender_identity. "" если не инициализ.
[[nodiscard]] std::string myIdentity();

// Мой session_key для группы (создаёт исходящую Megolm-сессию при нужде).
// Раздать участникам по 1-на-1 E2E (SKDM). "" при ошибке.
[[nodiscard]] std::string groupSessionKey(const std::string &groupId);

// Эпоха моей текущей исходящей group-сессии (монотонна, растёт при ротации).
// Кладётся в SKDM — получатель принимает ключ только если эпоха новее.
[[nodiscard]] std::uint64_t groupEpoch(const std::string &groupId);

// Синхронизировать текущих получателей sender key с сохранённым набором.
// Если кто-то выбыл (в том числе пока клиент был офлайн), ротирует исходящую
// сессию до следующего шифрования. true — ротация действительно выполнена.
[[nodiscard]] bool groupSyncRecipients(const std::string &groupId,
                                       const std::vector<std::string> &members);

// Ротация своей исходящей сессии группы (после удаления участника): сбрасывает
// ключ, следующая отправка создаёт новый (с бОльшей эпохой) и раздаёт его только
// ТЕКУЩИМ участникам — удалённый больше не расшифрует. Forward secrecy группы.
void groupRotate(const std::string &groupId);

// Зашифровать `contentJson` для группы моей исходящей сессией → JSON
// {kind:"group_encrypted",ciphertext,group,sender_identity}. "" при ошибке.
[[nodiscard]] std::string groupSeal(const std::string &groupId,
                                    const std::string &contentJson,
                                    std::uint64_t expectedEpoch);

// Принять session_key участника (из SKDM) с эпохой `epoch` → входящая сессия
// (group, sender). Заменяет старую только если эпоха строго новее (ротация);
// та же эпоха — дедуп; меньшая — откат отклоняется.
void groupAcceptKey(const std::string &groupId, const std::string &senderIdentity,
                    const std::string &sessionKeyB64, std::uint64_t epoch);

// Расшифровать групповое сообщение (ciphertext) отправителя senderIdentity →
// внутренний конверт {from,content} JSON. "" — нет ключа (ещё не пришёл SKDM)/порча.
[[nodiscard]] std::string groupOpen(const std::string &groupId,
                                    const std::string &senderIdentity,
                                    const std::string &ciphertext);

} // namespace parvane::e2e
