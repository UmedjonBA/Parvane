// Parvane fork: E2E медиа (Фаза 3) — AES-256-GCM через OpenSSL. См. blobcrypt.h.
#include "parvane/blobcrypt.h"
#include "parvane/crypto.h" // b64encode/b64decode

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <cstring>

namespace parvane::blobcrypt {
namespace {
constexpr int kKeyLen = 32;   // AES-256
constexpr int kNonceLen = 12; // GCM standard
constexpr int kTagLen = 16;
} // namespace

Encrypted encrypt(const std::string &plaintext) {
    Encrypted out;
    unsigned char key[kKeyLen], nonce[kNonceLen];
    if (RAND_bytes(key, kKeyLen) != 1 || RAND_bytes(nonce, kNonceLen) != 1) {
        return out;
    }
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return out;
    }
    std::string cipher(plaintext.size() + kTagLen, '\0');
    int len = 0, total = 0;
    bool ok =
        EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, kNonceLen, nullptr) == 1 &&
        EVP_EncryptInit_ex(ctx, nullptr, nullptr, key, nonce) == 1;
    if (ok && !plaintext.empty()) {
        ok = EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(&cipher[0]), &len,
                               reinterpret_cast<const unsigned char *>(plaintext.data()),
                               static_cast<int>(plaintext.size())) == 1;
        total = len;
    }
    if (ok) {
        ok = EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(&cipher[total]),
                                 &len) == 1;
        total += len;
    }
    unsigned char tag[kTagLen];
    if (ok) {
        ok = EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, kTagLen, tag) == 1;
    }
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) {
        return out;
    }
    // Формат: ciphertext(total) || tag(16).
    std::memcpy(&cipher[total], tag, kTagLen);
    cipher.resize(total + kTagLen);
    out.ciphertext = std::move(cipher);
    out.keyB64 = parvane::crypto::b64encode(std::string(reinterpret_cast<char *>(key), kKeyLen));
    out.nonceB64 =
        parvane::crypto::b64encode(std::string(reinterpret_cast<char *>(nonce), kNonceLen));
    return out;
}

std::optional<std::string> decrypt(const std::string &ciphertext, const std::string &keyB64,
                                   const std::string &nonceB64) {
    const auto key = parvane::crypto::b64decode(keyB64);
    const auto nonce = parvane::crypto::b64decode(nonceB64);
    if (!key || !nonce || key->size() != kKeyLen || nonce->size() != kNonceLen
        || ciphertext.size() < static_cast<std::size_t>(kTagLen)) {
        return std::nullopt;
    }
    const std::size_t dataLen = ciphertext.size() - kTagLen;
    const unsigned char *tag =
        reinterpret_cast<const unsigned char *>(ciphertext.data()) + dataLen;

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return std::nullopt;
    }
    std::string plain(dataLen, '\0');
    int len = 0, total = 0;
    bool ok =
        EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, kNonceLen, nullptr) == 1 &&
        EVP_DecryptInit_ex(ctx, nullptr, nullptr,
                           reinterpret_cast<const unsigned char *>(key->data()),
                           reinterpret_cast<const unsigned char *>(nonce->data())) == 1;
    if (ok && dataLen > 0) {
        ok = EVP_DecryptUpdate(ctx, reinterpret_cast<unsigned char *>(&plain[0]), &len,
                               reinterpret_cast<const unsigned char *>(ciphertext.data()),
                               static_cast<int>(dataLen)) == 1;
        total = len;
    }
    if (ok) {
        ok = EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, kTagLen,
                                 const_cast<unsigned char *>(tag)) == 1;
    }
    if (ok) {
        // EncryptFinal проверяет tag: !=1 → подделка.
        ok = EVP_DecryptFinal_ex(ctx, reinterpret_cast<unsigned char *>(&plain[total]),
                                 &len) == 1;
        total += len;
    }
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) {
        return std::nullopt;
    }
    plain.resize(total);
    return plain;
}

} // namespace parvane::blobcrypt
