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

// Инициализировать устройство: создать Olm-аккаунт и опубликовать пачку prekeys
// в identity (через transport). Идемпотентно (повторный вызов — no-op).
void initDevice(ITransport &t, const std::string &self, const std::string &token);

// Устройство инициализировано?
[[nodiscard]] bool ready();

// Зашифровать `contentJson` (сериализованный MessageContent) для получателя `to`.
// Нет сессии → X3DH через identity.prekeys.fetch. Возвращает JSON варианта
// Encrypted {kind:"encrypted",ciphertext,ctype,sender_identity} или "" при ошибке.
[[nodiscard]] std::string sealFor(const std::string &to, const std::string &contentJson,
                                  ITransport &t, const std::string &token);

// Расшифровать входящий Encrypted-JSON (от `from`) → исходный contentJson.
// "" при ошибке (нет сессии / порча / чужой ключ).
[[nodiscard]] std::string open(const std::string &from, const std::string &encryptedJson);

} // namespace parvane::e2e
