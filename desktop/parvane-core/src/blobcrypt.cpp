// Parvane fork: E2E медиа (Фаза 3) — AES-256-GCM через OpenSSL. См. blobcrypt.h.
// P-24: чанковый AEAD (v2) + чтение legacy v1.
#include "parvane/blobcrypt.h"
#include "parvane/crypto.h" // b64encode/b64decode

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <algorithm>
#include <cstring>

namespace parvane::blobcrypt {
namespace {
constexpr int kKeyLen = 32;   // AES-256
constexpr int kNonceLen = 12; // GCM standard
constexpr char kMagic[4] = {'P', 'V', 'B', '2'};

void putU32(std::string &out, std::uint32_t v) {
    out.push_back(static_cast<char>((v >> 24) & 0xff));
    out.push_back(static_cast<char>((v >> 16) & 0xff));
    out.push_back(static_cast<char>((v >> 8) & 0xff));
    out.push_back(static_cast<char>(v & 0xff));
}

std::uint32_t getU32(const unsigned char *p) {
    return (static_cast<std::uint32_t>(p[0]) << 24) | (static_cast<std::uint32_t>(p[1]) << 16)
           | (static_cast<std::uint32_t>(p[2]) << 8) | static_cast<std::uint32_t>(p[3]);
}

std::string aadFor(std::uint32_t chunkSize, std::uint32_t index, std::uint32_t total) {
    std::string aad(kMagic, 4);
    putU32(aad, chunkSize);
    putU32(aad, index);
    putU32(aad, total);
    return aad;
}

std::string nonceFor(const std::string &nonce, std::uint32_t index) {
    std::string n = nonce;
    n[8] = static_cast<char>(static_cast<unsigned char>(n[8]) ^ ((index >> 24) & 0xff));
    n[9] = static_cast<char>(static_cast<unsigned char>(n[9]) ^ ((index >> 16) & 0xff));
    n[10] = static_cast<char>(static_cast<unsigned char>(n[10]) ^ ((index >> 8) & 0xff));
    n[11] = static_cast<char>(static_cast<unsigned char>(n[11]) ^ (index & 0xff));
    return n;
}

// Один GCM-сеанс: plaintext → ct||tag (aad может быть пустым — legacy v1).
bool gcmSeal(const unsigned char *key, const std::string &nonce, const std::string &aad,
             const unsigned char *plain, std::size_t plainLen, std::string &out) {
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return false;
    }
    std::string cipher(plainLen + kTagLen, '\0');
    int len = 0, total = 0;
    bool ok = EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1
              && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, kNonceLen, nullptr) == 1
              && EVP_EncryptInit_ex(ctx, nullptr, nullptr, key,
                                    reinterpret_cast<const unsigned char *>(nonce.data())) == 1;
    if (ok && !aad.empty()) {
        ok = EVP_EncryptUpdate(ctx, nullptr, &len,
                               reinterpret_cast<const unsigned char *>(aad.data()),
                               static_cast<int>(aad.size())) == 1;
    }
    if (ok && plainLen > 0) {
        ok = EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(&cipher[0]), &len, plain,
                               static_cast<int>(plainLen)) == 1;
        total = len;
    }
    if (ok) {
        ok = EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(&cipher[total]), &len) == 1;
        total += len;
    }
    unsigned char tag[kTagLen];
    if (ok) {
        ok = EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, kTagLen, tag) == 1;
    }
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) {
        return false;
    }
    std::memcpy(&cipher[total], tag, kTagLen);
    cipher.resize(total + kTagLen);
    out += cipher;
    return true;
}

// ct||tag → plaintext (append в out); false — тег не сошёлся.
bool gcmOpen(const unsigned char *key, const std::string &nonce, const std::string &aad,
             const unsigned char *ct, std::size_t ctLen, std::string &out) {
    if (ctLen < kTagLen) {
        return false;
    }
    const std::size_t dataLen = ctLen - kTagLen;
    const unsigned char *tag = ct + dataLen;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return false;
    }
    std::string plain(dataLen, '\0');
    int len = 0, total = 0;
    bool ok = EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1
              && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, kNonceLen, nullptr) == 1
              && EVP_DecryptInit_ex(ctx, nullptr, nullptr, key,
                                    reinterpret_cast<const unsigned char *>(nonce.data())) == 1;
    if (ok && !aad.empty()) {
        ok = EVP_DecryptUpdate(ctx, nullptr, &len,
                               reinterpret_cast<const unsigned char *>(aad.data()),
                               static_cast<int>(aad.size())) == 1;
    }
    if (ok && dataLen > 0) {
        ok = EVP_DecryptUpdate(ctx, reinterpret_cast<unsigned char *>(&plain[0]), &len, ct,
                               static_cast<int>(dataLen)) == 1;
        total = len;
    }
    if (ok) {
        ok = EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, kTagLen,
                                 const_cast<unsigned char *>(tag)) == 1;
    }
    if (ok) {
        // DecryptFinal проверяет tag: !=1 → подделка.
        ok = EVP_DecryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(&plain[total]), &len) == 1;
        total += len;
    }
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) {
        return false;
    }
    plain.resize(total);
    out += plain;
    return true;
}

std::optional<std::string> decryptV1(const std::string &ciphertext, const std::string &key,
                                     const std::string &nonce) {
    std::string out;
    if (!gcmOpen(reinterpret_cast<const unsigned char *>(key.data()), nonce, std::string(),
                 reinterpret_cast<const unsigned char *>(ciphertext.data()), ciphertext.size(),
                 out)) {
        return std::nullopt;
    }
    return out;
}

bool keyNonceOk(const std::optional<std::string> &key, const std::optional<std::string> &nonce) {
    return key && nonce && key->size() == kKeyLen && nonce->size() == kNonceLen;
}
} // namespace

std::optional<Header> parseHeader(const std::string &ciphertext) {
    if (ciphertext.size() < kHeaderLen || std::memcmp(ciphertext.data(), kMagic, 4) != 0) {
        return std::nullopt;
    }
    Header h;
    h.chunkSize = getU32(reinterpret_cast<const unsigned char *>(ciphertext.data()) + 4);
    if (h.chunkSize < kMinChunkSize || h.chunkSize > kMaxChunkSize) {
        return std::nullopt;
    }
    return h;
}

std::size_t chunkCount(std::size_t cipherLen, const Header &h) {
    if (cipherLen < kHeaderLen + kTagLen) {
        return 0;
    }
    const std::size_t body = cipherLen - kHeaderLen;
    const std::size_t full = h.chunkSize + kTagLen;
    return (body + full - 1) / full;
}

std::size_t plaintextSize(std::size_t cipherLen, const Header &h) {
    const std::size_t n = chunkCount(cipherLen, h);
    if (n == 0) {
        return 0;
    }
    return cipherLen - kHeaderLen - n * kTagLen;
}

std::string encryptWithKey(const std::string &plaintext, const std::string &key,
                           const std::string &nonce, std::uint32_t chunkSize) {
    if (key.size() != kKeyLen || nonce.size() != kNonceLen || chunkSize < kMinChunkSize
        || chunkSize > kMaxChunkSize) {
        return {};
    }
    const std::size_t n = plaintext.empty() ? 1 : (plaintext.size() + chunkSize - 1) / chunkSize;
    if (n > 0xffffffffu) {
        return {};
    }
    std::string out(kMagic, 4);
    putU32(out, chunkSize);
    out.reserve(kHeaderLen + plaintext.size() + n * kTagLen);
    const auto *k = reinterpret_cast<const unsigned char *>(key.data());
    for (std::size_t i = 0; i < n; ++i) {
        const std::size_t off = i * chunkSize;
        const std::size_t len = off < plaintext.size() ? std::min<std::size_t>(chunkSize, plaintext.size() - off) : 0;
        if (!gcmSeal(k, nonceFor(nonce, static_cast<std::uint32_t>(i)),
                     aadFor(chunkSize, static_cast<std::uint32_t>(i), static_cast<std::uint32_t>(n)),
                     reinterpret_cast<const unsigned char *>(plaintext.data()) + off, len, out)) {
            return {};
        }
    }
    return out;
}

Encrypted encrypt(const std::string &plaintext) {
    Encrypted out;
    unsigned char key[kKeyLen], nonce[kNonceLen];
    if (RAND_bytes(key, kKeyLen) != 1 || RAND_bytes(nonce, kNonceLen) != 1) {
        return out;
    }
    const std::string k(reinterpret_cast<char *>(key), kKeyLen);
    const std::string n(reinterpret_cast<char *>(nonce), kNonceLen);
    out.ciphertext = encryptWithKey(plaintext, k, n, kDefaultChunkSize);
    if (out.ciphertext.empty()) {
        return {};
    }
    out.keyB64 = parvane::crypto::b64encode(k);
    out.nonceB64 = parvane::crypto::b64encode(n);
    return out;
}

std::optional<std::string> decryptChunks(const std::string &chunks, const std::string &keyB64,
                                         const std::string &nonceB64, const Header &h,
                                         std::size_t firstChunk, std::size_t totalChunks) {
    const auto key = parvane::crypto::b64decode(keyB64);
    const auto nonce = parvane::crypto::b64decode(nonceB64);
    if (!keyNonceOk(key, nonce) || totalChunks == 0 || totalChunks > 0xffffffffu) {
        return std::nullopt;
    }
    const auto *k = reinterpret_cast<const unsigned char *>(key->data());
    const std::size_t full = h.chunkSize + kTagLen;
    std::string out;
    std::size_t pos = 0;
    std::size_t index = firstChunk;
    while (pos < chunks.size()) {
        if (index >= totalChunks) {
            return std::nullopt; // больше чанков, чем объявлено
        }
        const std::size_t len = std::min(full, chunks.size() - pos);
        // Не последний чанк обязан быть полным; последний — любой длины ≥ tag.
        if (index + 1 < totalChunks && len != full) {
            return std::nullopt;
        }
        if (!gcmOpen(k, nonceFor(*nonce, static_cast<std::uint32_t>(index)),
                     aadFor(h.chunkSize, static_cast<std::uint32_t>(index),
                            static_cast<std::uint32_t>(totalChunks)),
                     reinterpret_cast<const unsigned char *>(chunks.data()) + pos, len, out)) {
            return std::nullopt;
        }
        pos += len;
        ++index;
    }
    return out;
}

std::optional<std::string> decrypt(const std::string &ciphertext, const std::string &keyB64,
                                   const std::string &nonceB64) {
    const auto key = parvane::crypto::b64decode(keyB64);
    const auto nonce = parvane::crypto::b64decode(nonceB64);
    if (!keyNonceOk(key, nonce)) {
        return std::nullopt;
    }
    if (const auto h = parseHeader(ciphertext)) {
        const std::size_t n = chunkCount(ciphertext.size(), *h);
        if (n == 0) {
            return std::nullopt;
        }
        return decryptChunks(ciphertext.substr(kHeaderLen), keyB64, nonceB64, *h, 0, n);
    }
    // legacy v1: данные || tag
    return decryptV1(ciphertext, *key, *nonce);
}


// ── Фото частной группы (A0089-5): см. blobcrypt.h ──
namespace {
std::string groupPhotoLabel(const char *label, const std::string &secret) {
    const std::string input = std::string("parvane/group-avatar/v1/") + label + secret;
    unsigned char out[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    if (EVP_Digest(input.data(), input.size(), out, &len, EVP_sha256(), nullptr) != 1 || len != 32) return {};
    return std::string(reinterpret_cast<const char *>(out), len);
}
} // namespace

std::optional<GroupPhotoKeys> deriveGroupPhotoKeys(const std::string &secret32) {
    if (secret32.size() != 32) return std::nullopt;
    GroupPhotoKeys k;
    k.capability = groupPhotoLabel("cap", secret32);
    k.key = groupPhotoLabel("key", secret32);
    k.nonce = groupPhotoLabel("nonce", secret32).substr(0, 12);
    if (k.capability.size() != 32 || k.key.size() != 32 || k.nonce.size() != 12) return std::nullopt;
    return k;
}

std::string newGroupPhotoSecret() {
    std::string s(32, '\0');
    if (RAND_bytes(reinterpret_cast<unsigned char *>(&s[0]), 32) != 1) return {};
    return s;
}

std::string sealGroupPhoto(const std::string &plain, const std::string &secret32) {
    const auto k = deriveGroupPhotoKeys(secret32);
    if (!k || plain.empty()) return {};
    return encryptWithKey(plain, k->key, k->nonce);
}

std::optional<std::string> openGroupPhoto(const std::string &cipher, const std::string &secret32) {
    const auto k = deriveGroupPhotoKeys(secret32);
    if (!k) return std::nullopt;
    return decrypt(cipher, parvane::crypto::b64encode(k->key), parvane::crypto::b64encode(k->nonce));
}

} // namespace parvane::blobcrypt
