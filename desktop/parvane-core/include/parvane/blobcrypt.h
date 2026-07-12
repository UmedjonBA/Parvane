// Parvane fork: E2E медиа (Фаза 3). Шифрование блоба случайным симметричным
// ключом (AES-256-GCM, OpenSSL). Блоб грузится в cloud ШИФРТЕКСТОМ; ключ+nonce
// едут в E2E-сообщении (внутри Encrypted-контента). cloud видит только байты.
#pragma once

#include <optional>
#include <string>

namespace parvane::blobcrypt {

struct Encrypted {
    std::string ciphertext; // зашифрованные данные || GCM-tag(16)
    std::string keyB64;     // 32 байта, base64 — в сообщение (не серверу-cloud)
    std::string nonceB64;   // 12 байт, base64
};

// Зашифровать блоб НОВЫМ случайным ключом. Пустой ciphertext — ошибка.
[[nodiscard]] Encrypted encrypt(const std::string &plaintext);

// Расшифровать. nullopt — ошибка/подделка (не сошёлся GCM-tag) / битый ключ.
[[nodiscard]] std::optional<std::string> decrypt(const std::string &ciphertext,
                                                 const std::string &keyB64,
                                                 const std::string &nonceB64);

} // namespace parvane::blobcrypt
