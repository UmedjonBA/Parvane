// Parvane fork: E2E медиа (Фаза 3). Шифрование блоба случайным симметричным
// ключом (AES-256-GCM, OpenSSL). Блоб грузится в cloud ШИФРТЕКСТОМ; ключ+nonce
// едут в E2E-сообщении (внутри Encrypted-контента). cloud видит только байты.
//
// P-24 / правило BLOB-1: формат v2 — чанковый AEAD. Каждый чанк plaintext
// (по умолчанию 256 КиБ) шифруется отдельно с собственным тегом, поэтому
// прогрессивный плеер (web) проверяет целостность КАЖДОГО окна до того, как
// отдать байты декодеру; сервер/cloud не может бит-флипами подсунуть
// произвольный вход. Раскладка (все числа big-endian):
//   "PVB2" | u32 chunkSize | для i in 0..n: ct_i (≤ chunkSize) | tag_i (16)
//   n = max(1, ceil(len / chunkSize)); nonce_i = nonce XOR (0^8 || u32 i);
//   AAD_i = "PVB2" | u32 chunkSize | u32 i | u32 n  (защита от усечения и
//   перестановки чанков).
// Legacy v1 (данные || tag, без заголовка) по-прежнему читается decrypt().
#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace parvane::blobcrypt {

struct Encrypted {
    std::string ciphertext; // v2: заголовок + чанки (см. выше)
    std::string keyB64;     // 32 байта, base64 — в сообщение (не серверу-cloud)
    std::string nonceB64;   // 12 байт, base64
};

inline constexpr std::uint32_t kDefaultChunkSize = 256 * 1024;
inline constexpr std::uint32_t kMinChunkSize = 1024;
inline constexpr std::uint32_t kMaxChunkSize = 8 * 1024 * 1024;
inline constexpr std::size_t kHeaderLen = 8;
inline constexpr std::size_t kTagLen = 16;

struct Header {
    std::uint32_t chunkSize = 0;
};

// Заголовок v2 (nullopt — legacy v1 или битый заголовок).
[[nodiscard]] std::optional<Header> parseHeader(const std::string &ciphertext);

// Число чанков и размер plaintext по длине шифртекста v2.
[[nodiscard]] std::size_t chunkCount(std::size_t cipherLen, const Header &h);
[[nodiscard]] std::size_t plaintextSize(std::size_t cipherLen, const Header &h);

// Зашифровать блоб НОВЫМ случайным ключом (v2, chunkSize по умолчанию).
// Пустой ciphertext — ошибка.
[[nodiscard]] Encrypted encrypt(const std::string &plaintext);

// Детерминированный вариант для тестов и кросс-клиентских векторов
// (ключ 32 байта, nonce 12 байт — сырые). Пустая строка — ошибка.
[[nodiscard]] std::string encryptWithKey(const std::string &plaintext, const std::string &key,
                                         const std::string &nonce,
                                         std::uint32_t chunkSize = kDefaultChunkSize);

// Расшифровать целиком (v2 или legacy v1). nullopt — ошибка/подделка / битый ключ.
[[nodiscard]] std::optional<std::string> decrypt(const std::string &ciphertext,
                                                 const std::string &keyB64,
                                                 const std::string &nonceB64);

// Расшифровать чанки [firstChunk, firstChunk + k) из v2-шифртекста: `chunks` —
// подряд идущие байты этих чанков (каждый ct||tag), `totalChunks` — n всего
// файла. Каждый тег проверяется; любая подделка → nullopt.
[[nodiscard]] std::optional<std::string> decryptChunks(const std::string &chunks,
                                                       const std::string &keyB64,
                                                       const std::string &nonceB64,
                                                       const Header &h,
                                                       std::size_t firstChunk,
                                                       std::size_t totalChunks);

} // namespace parvane::blobcrypt
