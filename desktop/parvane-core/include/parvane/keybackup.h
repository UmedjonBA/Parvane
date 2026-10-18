// Parvane fork: ручная копия ключей устройства под паролем — ФОРМАТ ВЕБ-КЛИЕНТА (web `keyBackup.ts`,
// конверт версии 2 с T110): копия переносится между клиентами. Файл — JSON:
//   {"v":2,"kdf":"pbkdf2-sha256","iterations":600000,"salt":b64,"iv":b64,"data":b64}
// data = AES-256-GCM(key, iv, payloadJson) || tag(16)  (как WebCrypto),
// key = PBKDF2-SHA256(password, salt, iterations) → 32 байта.
// payloadJson — {"deviceId", "v2": устройство v2 (Session::deviceBackup), "v2History"?: строки истории}.
// Импорт проверяет конверт до KDF (P-48): итерации ≤ 5 млн (не ниже 310 тыс.), соль 16–64 байт, iv 12,
// данные ≤ 16 МиБ. Общие векторы с web — proto/parvane/vectors/clients/keybackup-*.json.
#pragma once

#include <optional>
#include <string>

namespace parvane::keybackup {

// Итерации: значение веба; при импорте число из файла не ниже минимума
// (подделанный бэкап с iterations=1 сделал бы перебор пароля тривиальным).
constexpr int kIterations = 600000;
constexpr int kMinIterations = 310000;
constexpr long long kMaxIterations = 5000000;

// Пустая строка — ошибка (пустой пароль/состояние, сбой OpenSSL).
[[nodiscard]] std::string exportEncrypted(const std::string &payloadJson,
                                          const std::string &password);

// nullopt — неверный пароль (не сошёлся GCM-tag), чужая версия, битый файл.
[[nodiscard]] std::optional<std::string> importEncrypted(const std::string &fileJson,
                                                         const std::string &password);

} // namespace parvane::keybackup
