// Parvane fork: высокоуровневый E2E-слой (Фаза 2) поверх parvane-e2e (vodozemac
// Olm) и ITransport. Оркестрирует X3DH (fetch prekey-бандла при первом сообщении),
// шифрование/расшифровку и публикацию своих prekeys. Реальный контент сообщения
// шифруется; сервер видит только вариант MessageContent::Encrypted.
//
// MVP: аккаунт и сессии — В ПАМЯТИ (персист между рестартами — follow-up).
// Потокобезопасно (внутренний мьютекс). Приватные ключи не покидают процесс.
#pragma once

#include <string>

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

} // namespace parvane::e2e
