// Parvane fork: Ed25519 — генерация ключа, подпись, проверка (OpenSSL EVP).
// Нужно для аутентифицированного сигналинга звонков: клиент подписывает SDP
// своим приватным ключом, собеседник проверяет публичным (из каталога identity)
// → скомпрометированный шард не может подменить DTLS-отпечаток (MITM).
// Приватный ключ (seed) НИКОГДА не уходит с устройства. См. CALLS-parvane.md.
#pragma once

#include <optional>
#include <string>

namespace parvane::crypto {

// Ключ подписи Ed25519. Приватная часть — 32-байтовый seed внутри; наружу —
// только публичный ключ (base64) и подписи.
class SigningKey {
public:
    // Новая случайная пара.
    static SigningKey generate();
    // Восстановить из seed (base64, 32 байта). nullopt — битый/неверной длины.
    static std::optional<SigningKey> fromSeedB64(const std::string &seedB64);
    // Загрузить ключ из файла (в файле — seedB64); если файла нет/битый —
    // сгенерировать новый и сохранить (права 0600). Пустой path → generate().
    static SigningKey loadOrCreate(const std::string &path);

    // Секрет для персиста (base64 32-байтового seed). Не раздавать!
    [[nodiscard]] std::string seedB64() const { return seedB64_; }
    // Публичный ключ (base64 32 байта) — регистрировать в identity/раздавать.
    [[nodiscard]] std::string publicB64() const { return publicB64_; }
    // Подпись произвольных данных приватным ключом → base64 (64 байта). "" при
    // внутренней ошибке OpenSSL.
    [[nodiscard]] std::string sign(const std::string &data) const;

private:
    std::string seedB64_;
    std::string publicB64_;
    SigningKey() = default;
};

// Проверить, что `sigB64` — подпись `data` ключом `publicB64` (оба base64).
// Любой битый вход или несовпадение → false.
[[nodiscard]] bool verify(const std::string &publicB64, const std::string &data,
                          const std::string &sigB64);

// base64 бинарных данных (публичные — пригодятся вызывающему).
[[nodiscard]] std::string b64encode(const std::string &raw);
[[nodiscard]] std::optional<std::string> b64decode(const std::string &b64);

// SAS (Short Authentication String) для сверки звонка «голосом»: детерминированная
// цепочка из 4 эмодзи из ОТСОРТИРОВАННОЙ пары DTLS-отпечатков (fpA, fpB). Обе
// стороны знают оба отпечатка (в своих local/remote SDP) → одинаковый SAS; MITM
// в медиа-пути даёт разные отпечатки на концах → SAS не совпадёт. Порядок
// аргументов не важен.
[[nodiscard]] std::string sasEmoji(const std::string &fpA, const std::string &fpB);

} // namespace parvane::crypto
