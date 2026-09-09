// Parvane fork: резервная копия ключей E2E под паролем — ФОРМАТ ВЕБ-КЛИЕНТА
// (e2e.ts exportEncrypted/importEncrypted), чтобы копия годилась для переноса
// между клиентами. Файл — JSON:
//   {"v":1,"kdf":"pbkdf2-sha256","iterations":600000,"salt":b64,"iv":b64,"data":b64}
// data = AES-256-GCM(key, iv, stateJson) || tag(16)  (как WebCrypto),
// key = PBKDF2-SHA256(password, salt, iterations) → 32 байта.
// stateJson — PersistedE2eState (e2e::exportStateJson / importLinkedHistory).
#pragma once

#include <optional>
#include <string>

namespace parvane::keybackup {

// Итерации: значение веба; при импорте число из файла не ниже минимума
// (подделанный бэкап с iterations=1 сделал бы перебор пароля тривиальным).
constexpr int kIterations = 600000;
constexpr int kMinIterations = 310000;

// Пустая строка — ошибка (пустой пароль/состояние, сбой OpenSSL).
[[nodiscard]] std::string exportEncrypted(const std::string &stateJson,
                                          const std::string &password);

// nullopt — неверный пароль (не сошёлся GCM-tag), чужая версия, битый файл.
[[nodiscard]] std::optional<std::string> importEncrypted(const std::string &fileJson,
                                                         const std::string &password);

} // namespace parvane::keybackup
