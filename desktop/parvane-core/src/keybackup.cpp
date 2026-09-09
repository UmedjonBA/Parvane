// Parvane fork: см. keybackup.h. Тот же EVP-паттерн, что в blobcrypt.cpp, но
// ключ выводится из пароля (PBKDF2), а не генерируется.
#include "parvane/keybackup.h"
#include "parvane/blobcrypt.h" // decrypt(ciphertext||tag, keyB64, nonceB64)
#include "parvane/crypto.h"    // b64encode/b64decode

#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <algorithm>
#include <cstring>

namespace parvane::keybackup {
namespace {
constexpr int kVersion = 1;
constexpr int kKeyLen = 32;
constexpr int kSaltLen = 16;
constexpr int kIvLen = 12;
constexpr int kTagLen = 16;

std::string deriveKey(const std::string &password, const std::string &salt, int iterations) {
    std::string key(kKeyLen, '\0');
    const auto ok = PKCS5_PBKDF2_HMAC(
        password.data(), static_cast<int>(password.size()),
        reinterpret_cast<const unsigned char *>(salt.data()), static_cast<int>(salt.size()),
        iterations, EVP_sha256(), kKeyLen,
        reinterpret_cast<unsigned char *>(&key[0])) == 1;
    return ok ? key : std::string();
}
} // namespace

std::string exportEncrypted(const std::string &stateJson, const std::string &password) {
    if (stateJson.empty() || password.empty()) {
        return {};
    }
    unsigned char saltRaw[kSaltLen], ivRaw[kIvLen];
    if (RAND_bytes(saltRaw, kSaltLen) != 1 || RAND_bytes(ivRaw, kIvLen) != 1) {
        return {};
    }
    const std::string salt(reinterpret_cast<char *>(saltRaw), kSaltLen);
    const std::string iv(reinterpret_cast<char *>(ivRaw), kIvLen);
    const auto key = deriveKey(password, salt, kIterations);
    if (key.empty()) {
        return {};
    }
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return {};
    }
    std::string cipher(stateJson.size() + kTagLen, '\0');
    int len = 0, total = 0;
    bool ok =
        EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1 &&
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, kIvLen, nullptr) == 1 &&
        EVP_EncryptInit_ex(ctx, nullptr, nullptr,
                           reinterpret_cast<const unsigned char *>(key.data()),
                           ivRaw) == 1 &&
        EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char *>(&cipher[0]), &len,
                          reinterpret_cast<const unsigned char *>(stateJson.data()),
                          static_cast<int>(stateJson.size())) == 1;
    total = len;
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
        return {};
    }
    std::memcpy(&cipher[total], tag, kTagLen);
    cipher.resize(total + kTagLen);
    nlohmann::json out;
    out["v"] = kVersion;
    out["kdf"] = "pbkdf2-sha256";
    out["iterations"] = kIterations;
    out["salt"] = parvane::crypto::b64encode(salt);
    out["iv"] = parvane::crypto::b64encode(iv);
    out["data"] = parvane::crypto::b64encode(cipher);
    return out.dump();
}

std::optional<std::string> importEncrypted(const std::string &fileJson,
                                           const std::string &password) {
    const auto j = nlohmann::json::parse(fileJson, nullptr, false);
    if (!j.is_object() || j.value("v", 0) != kVersion || password.empty()) {
        return std::nullopt;
    }
    const auto salt = parvane::crypto::b64decode(j.value("salt", std::string()));
    if (!salt || salt->size() != kSaltLen) {
        return std::nullopt;
    }
    const auto iterations = std::max(j.value("iterations", kMinIterations), kMinIterations);
    const auto key = deriveKey(password, *salt, iterations);
    if (key.empty()) {
        return std::nullopt;
    }
    // data = ciphertext||tag — ровно формат blobcrypt::decrypt.
    return parvane::blobcrypt::decrypt(
        parvane::crypto::b64decode(j.value("data", std::string())).value_or(std::string()),
        parvane::crypto::b64encode(key),
        j.value("iv", std::string()));
}

} // namespace parvane::keybackup
