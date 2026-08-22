// Parvane fork: см. linking.h. OpenSSL 3 EVP.
#include "parvane/linking.h"

#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/core_names.h>
#include <openssl/param_build.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

namespace parvane::linking {
namespace {

constexpr char kInfo[] = "parvane-link-v1";
constexpr int kIvLen = 12;
constexpr int kTagLen = 16;

struct PkeyDel {
    void operator()(EVP_PKEY *p) const { EVP_PKEY_free(p); }
};
struct CtxDel {
    void operator()(EVP_PKEY_CTX *p) const { EVP_PKEY_CTX_free(p); }
};
struct CipherDel {
    void operator()(EVP_CIPHER_CTX *p) const { EVP_CIPHER_CTX_free(p); }
};
using Pkey = std::unique_ptr<EVP_PKEY, PkeyDel>;

Pkey publicFromRaw(const std::string &raw) {
    // Несжатая точка P-256 (65 байт, 0x04 || X || Y).
    if (raw.size() != 65 || static_cast<unsigned char>(raw[0]) != 0x04) {
        return {};
    }
    OSSL_PARAM_BLD *bld = OSSL_PARAM_BLD_new();
    if (!bld) {
        return {};
    }
    OSSL_PARAM_BLD_push_utf8_string(bld, OSSL_PKEY_PARAM_GROUP_NAME, "prime256v1", 0);
    OSSL_PARAM_BLD_push_octet_string(bld, OSSL_PKEY_PARAM_PUB_KEY, raw.data(), raw.size());
    OSSL_PARAM *params = OSSL_PARAM_BLD_to_param(bld);
    OSSL_PARAM_BLD_free(bld);
    if (!params) {
        return {};
    }
    std::unique_ptr<EVP_PKEY_CTX, CtxDel> ctx(EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr));
    EVP_PKEY *pkey = nullptr;
    bool ok = ctx && EVP_PKEY_fromdata_init(ctx.get()) == 1
        && EVP_PKEY_fromdata(ctx.get(), &pkey, EVP_PKEY_PUBLIC_KEY, params) == 1;
    OSSL_PARAM_free(params);
    if (!ok) {
        return {};
    }
    return Pkey(pkey);
}

Pkey privateFromDer(const std::string &der) {
    const unsigned char *p = reinterpret_cast<const unsigned char *>(der.data());
    EVP_PKEY *pkey = d2i_AutoPrivateKey(nullptr, &p, static_cast<long>(der.size()));
    return Pkey(pkey);
}

std::optional<std::string> deriveAesKey(EVP_PKEY *priv, EVP_PKEY *peer) {
    std::unique_ptr<EVP_PKEY_CTX, CtxDel> ctx(EVP_PKEY_CTX_new(priv, nullptr));
    if (!ctx || EVP_PKEY_derive_init(ctx.get()) != 1
        || EVP_PKEY_derive_set_peer(ctx.get(), peer) != 1) {
        return std::nullopt;
    }
    size_t len = 0;
    if (EVP_PKEY_derive(ctx.get(), nullptr, &len) != 1) {
        return std::nullopt;
    }
    std::string secret(len, '\0');
    if (EVP_PKEY_derive(ctx.get(), reinterpret_cast<unsigned char *>(secret.data()), &len) != 1) {
        return std::nullopt;
    }
    secret.resize(len);
    // HKDF-SHA256, salt = 32 нулевых байта, info = "parvane-link-v1", 32 байта.
    std::unique_ptr<EVP_PKEY_CTX, CtxDel> kctx(EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr));
    std::array<unsigned char, 32> salt{};
    if (!kctx || EVP_PKEY_derive_init(kctx.get()) != 1
        || EVP_PKEY_CTX_set_hkdf_md(kctx.get(), EVP_sha256()) != 1
        || EVP_PKEY_CTX_set1_hkdf_salt(kctx.get(), salt.data(), salt.size()) != 1
        || EVP_PKEY_CTX_set1_hkdf_key(kctx.get(),
               reinterpret_cast<const unsigned char *>(secret.data()), secret.size()) != 1
        || EVP_PKEY_CTX_add1_hkdf_info(kctx.get(),
               reinterpret_cast<const unsigned char *>(kInfo), sizeof(kInfo) - 1) != 1) {
        return std::nullopt;
    }
    std::string key(32, '\0');
    size_t klen = key.size();
    if (EVP_PKEY_derive(kctx.get(), reinterpret_cast<unsigned char *>(key.data()), &klen) != 1) {
        return std::nullopt;
    }
    return key;
}

} // namespace

std::string randomBytes(int n) {
    std::string out(static_cast<size_t>(n), '\0');
    if (n > 0 && RAND_bytes(reinterpret_cast<unsigned char *>(out.data()), n) != 1) {
        return {};
    }
    return out;
}

std::string b64encode(const std::string &raw) {
    if (raw.empty()) {
        return {};
    }
    std::string out(4 * ((raw.size() + 2) / 3), '\0');
    const int n = EVP_EncodeBlock(reinterpret_cast<unsigned char *>(out.data()),
        reinterpret_cast<const unsigned char *>(raw.data()), static_cast<int>(raw.size()));
    out.resize(n > 0 ? n : 0);
    return out;
}

std::optional<std::string> b64decode(const std::string &b64in) {
    std::string b64 = b64in;
    // Принимаем и unpadded (как у olm) — дополняем.
    while (b64.size() % 4) {
        b64.push_back('=');
    }
    if (b64.empty()) {
        return std::string();
    }
    std::string out(3 * (b64.size() / 4), '\0');
    const int n = EVP_DecodeBlock(reinterpret_cast<unsigned char *>(out.data()),
        reinterpret_cast<const unsigned char *>(b64.data()), static_cast<int>(b64.size()));
    if (n < 0) {
        return std::nullopt;
    }
    int pad = 0;
    for (auto it = b64.rbegin(); it != b64.rend() && *it == '='; ++it) {
        ++pad;
    }
    out.resize(static_cast<size_t>(n - pad));
    return out;
}

std::optional<EphemeralKey> EphemeralKey::generate() {
    std::unique_ptr<EVP_PKEY_CTX, CtxDel> ctx(EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr));
    if (!ctx || EVP_PKEY_keygen_init(ctx.get()) != 1
        || EVP_PKEY_CTX_set_ec_paramgen_curve_nid(ctx.get(), NID_X9_62_prime256v1) != 1) {
        return std::nullopt;
    }
    EVP_PKEY *raw = nullptr;
    if (EVP_PKEY_keygen(ctx.get(), &raw) != 1 || !raw) {
        return std::nullopt;
    }
    Pkey pkey(raw);
    // Публичный: несжатая точка.
    size_t publen = 0;
    if (EVP_PKEY_get_octet_string_param(pkey.get(), OSSL_PKEY_PARAM_PUB_KEY, nullptr, 0, &publen) != 1) {
        return std::nullopt;
    }
    std::string pub(publen, '\0');
    if (EVP_PKEY_get_octet_string_param(pkey.get(), OSSL_PKEY_PARAM_PUB_KEY,
            reinterpret_cast<unsigned char *>(pub.data()), pub.size(), &publen) != 1) {
        return std::nullopt;
    }
    pub.resize(publen);
    // Приватный: PKCS#8 DER.
    unsigned char *der = nullptr;
    const int derlen = i2d_PrivateKey(pkey.get(), &der);
    if (derlen <= 0) {
        return std::nullopt;
    }
    std::string priv(reinterpret_cast<char *>(der), static_cast<size_t>(derlen));
    OPENSSL_free(der);
    EphemeralKey k;
    k._pubB64 = b64encode(pub);
    k._privB64 = b64encode(priv);
    return k;
}

std::optional<EphemeralKey> EphemeralKey::fromPrivateDerB64(const std::string &privB64) {
    const auto der = b64decode(privB64);
    if (!der) {
        return std::nullopt;
    }
    auto pkey = privateFromDer(*der);
    if (!pkey) {
        return std::nullopt;
    }
    size_t publen = 0;
    if (EVP_PKEY_get_octet_string_param(pkey.get(), OSSL_PKEY_PARAM_PUB_KEY, nullptr, 0, &publen) != 1) {
        return std::nullopt;
    }
    std::string pub(publen, '\0');
    if (EVP_PKEY_get_octet_string_param(pkey.get(), OSSL_PKEY_PARAM_PUB_KEY,
            reinterpret_cast<unsigned char *>(pub.data()), pub.size(), &publen) != 1) {
        return std::nullopt;
    }
    pub.resize(publen);
    EphemeralKey k;
    k._pubB64 = b64encode(pub);
    k._privB64 = privB64;
    return k;
}

std::optional<std::string> EphemeralKey::seal(const std::string &peerPubB64,
                                              const std::string &plaintext) const {
    const auto privDer = b64decode(_privB64);
    const auto peerRaw = b64decode(peerPubB64);
    if (!privDer || !peerRaw) {
        return std::nullopt;
    }
    auto priv = privateFromDer(*privDer);
    auto peer = publicFromRaw(*peerRaw);
    if (!priv || !peer) {
        return std::nullopt;
    }
    const auto key = deriveAesKey(priv.get(), peer.get());
    if (!key) {
        return std::nullopt;
    }
    const auto iv = randomBytes(kIvLen);
    std::unique_ptr<EVP_CIPHER_CTX, CipherDel> c(EVP_CIPHER_CTX_new());
    if (!c || EVP_EncryptInit_ex(c.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1
        || EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_IVLEN, kIvLen, nullptr) != 1
        || EVP_EncryptInit_ex(c.get(), nullptr, nullptr,
               reinterpret_cast<const unsigned char *>(key->data()),
               reinterpret_cast<const unsigned char *>(iv.data())) != 1) {
        return std::nullopt;
    }
    std::string out(plaintext.size() + kTagLen, '\0');
    int len = 0, total = 0;
    if (EVP_EncryptUpdate(c.get(), reinterpret_cast<unsigned char *>(out.data()), &len,
            reinterpret_cast<const unsigned char *>(plaintext.data()),
            static_cast<int>(plaintext.size())) != 1) {
        return std::nullopt;
    }
    total = len;
    if (EVP_EncryptFinal_ex(c.get(), reinterpret_cast<unsigned char *>(out.data()) + total, &len) != 1) {
        return std::nullopt;
    }
    total += len;
    if (EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_GET_TAG, kTagLen,
            reinterpret_cast<unsigned char *>(out.data()) + total) != 1) {
        return std::nullopt;
    }
    out.resize(static_cast<size_t>(total + kTagLen));
    return b64encode(iv + out);
}

std::optional<std::string> EphemeralKey::open(const std::string &peerPubB64,
                                              const std::string &boxB64) const {
    const auto privDer = b64decode(_privB64);
    const auto peerRaw = b64decode(peerPubB64);
    const auto box = b64decode(boxB64);
    if (!privDer || !peerRaw || !box || box->size() < static_cast<size_t>(kIvLen + kTagLen)) {
        return std::nullopt;
    }
    auto priv = privateFromDer(*privDer);
    auto peer = publicFromRaw(*peerRaw);
    if (!priv || !peer) {
        return std::nullopt;
    }
    const auto key = deriveAesKey(priv.get(), peer.get());
    if (!key) {
        return std::nullopt;
    }
    const std::string iv = box->substr(0, kIvLen);
    const std::string body = box->substr(kIvLen, box->size() - kIvLen - kTagLen);
    std::string tag = box->substr(box->size() - kTagLen);
    std::unique_ptr<EVP_CIPHER_CTX, CipherDel> c(EVP_CIPHER_CTX_new());
    if (!c || EVP_DecryptInit_ex(c.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1
        || EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_IVLEN, kIvLen, nullptr) != 1
        || EVP_DecryptInit_ex(c.get(), nullptr, nullptr,
               reinterpret_cast<const unsigned char *>(key->data()),
               reinterpret_cast<const unsigned char *>(iv.data())) != 1) {
        return std::nullopt;
    }
    std::string out(body.size() + 16, '\0');
    int len = 0, total = 0;
    if (EVP_DecryptUpdate(c.get(), reinterpret_cast<unsigned char *>(out.data()), &len,
            reinterpret_cast<const unsigned char *>(body.data()),
            static_cast<int>(body.size())) != 1) {
        return std::nullopt;
    }
    total = len;
    if (EVP_CIPHER_CTX_ctrl(c.get(), EVP_CTRL_GCM_SET_TAG, kTagLen, tag.data()) != 1) {
        return std::nullopt;
    }
    if (EVP_DecryptFinal_ex(c.get(), reinterpret_cast<unsigned char *>(out.data()) + total, &len) != 1) {
        return std::nullopt;
    }
    total += len;
    out.resize(static_cast<size_t>(total));
    return out;
}

std::string sasCode(const std::string &ephPubB64) {
    const auto raw = b64decode(ephPubB64);
    if (!raw) {
        return {};
    }
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char *>(raw->data()), raw->size(), digest);
    const std::uint32_t v = (std::uint32_t(digest[0]) << 24) | (std::uint32_t(digest[1]) << 16)
        | (std::uint32_t(digest[2]) << 8) | std::uint32_t(digest[3]);
    char buf[8];
    std::snprintf(buf, sizeof(buf), "%06u", static_cast<unsigned>(v % 1000000u));
    return buf;
}

} // namespace parvane::linking
