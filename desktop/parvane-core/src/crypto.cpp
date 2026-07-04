// Parvane fork: реализация crypto.h — Ed25519 через OpenSSL EVP + base64.
#include "parvane/crypto.h"

#include <array>
#include <cstdint>
#include <fstream>
#include <vector>

#include <openssl/evp.h>

#if defined(__unix__) || defined(__APPLE__)
#include <sys/stat.h>
#endif

namespace parvane::crypto {

namespace {

constexpr char kB64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int b64val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

// EVP_PKEY из 32-байтового seed (приватный) или публичного ключа.
struct PkeyGuard {
    EVP_PKEY *p = nullptr;
    ~PkeyGuard() { if (p) EVP_PKEY_free(p); }
};

} // namespace

std::string b64encode(const std::string &raw) {
    std::string out;
    out.reserve((raw.size() + 2) / 3 * 4);
    std::size_t i = 0;
    const auto *d = reinterpret_cast<const unsigned char *>(raw.data());
    for (; i + 3 <= raw.size(); i += 3) {
        const std::uint32_t n = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        out += kB64[(n >> 18) & 63];
        out += kB64[(n >> 12) & 63];
        out += kB64[(n >> 6) & 63];
        out += kB64[n & 63];
    }
    if (const std::size_t rem = raw.size() - i; rem == 1) {
        const std::uint32_t n = d[i] << 16;
        out += kB64[(n >> 18) & 63];
        out += kB64[(n >> 12) & 63];
        out += "==";
    } else if (rem == 2) {
        const std::uint32_t n = (d[i] << 16) | (d[i + 1] << 8);
        out += kB64[(n >> 18) & 63];
        out += kB64[(n >> 12) & 63];
        out += kB64[(n >> 6) & 63];
        out += '=';
    }
    return out;
}

std::optional<std::string> b64decode(const std::string &b64) {
    std::string out;
    int buf = 0, bits = 0;
    for (const char c : b64) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        const int v = b64val(c);
        if (v < 0) return std::nullopt; // не-base64 символ
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += static_cast<char>((buf >> bits) & 0xFF);
        }
    }
    return out;
}

SigningKey SigningKey::generate() {
    PkeyGuard g;
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, nullptr);
    SigningKey key;
    if (!ctx) return key;
    if (EVP_PKEY_keygen_init(ctx) == 1) {
        EVP_PKEY_keygen(ctx, &g.p);
    }
    EVP_PKEY_CTX_free(ctx);
    if (!g.p) return key;
    std::array<unsigned char, 32> seed{}, pub{};
    std::size_t sl = seed.size(), pl = pub.size();
    if (EVP_PKEY_get_raw_private_key(g.p, seed.data(), &sl) == 1
        && EVP_PKEY_get_raw_public_key(g.p, pub.data(), &pl) == 1) {
        key.seedB64_ = b64encode(std::string(seed.begin(), seed.end()));
        key.publicB64_ = b64encode(std::string(pub.begin(), pub.end()));
    }
    return key;
}

std::optional<SigningKey> SigningKey::fromSeedB64(const std::string &seedB64) {
    const auto seed = b64decode(seedB64);
    if (!seed || seed->size() != 32) return std::nullopt;
    PkeyGuard g;
    g.p = EVP_PKEY_new_raw_private_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(seed->data()), 32);
    if (!g.p) return std::nullopt;
    std::array<unsigned char, 32> pub{};
    std::size_t pl = pub.size();
    if (EVP_PKEY_get_raw_public_key(g.p, pub.data(), &pl) != 1) return std::nullopt;
    SigningKey key;
    key.seedB64_ = seedB64;
    key.publicB64_ = b64encode(std::string(pub.begin(), pub.end()));
    return key;
}

SigningKey SigningKey::loadOrCreate(const std::string &path) {
    if (!path.empty()) {
        std::ifstream in(path);
        if (in) {
            std::string seed;
            std::getline(in, seed);
            if (auto k = fromSeedB64(seed)) return *k;
        }
    }
    SigningKey key = generate();
    if (!path.empty() && !key.seedB64_.empty()) {
        std::ofstream out(path, std::ios::trunc);
        out << key.seedB64_ << "\n";
        out.close();
#if defined(__unix__) || defined(__APPLE__)
        ::chmod(path.c_str(), 0600); // секрет — только владельцу
#endif
    }
    return key;
}

std::string SigningKey::sign(const std::string &data) const {
    const auto seed = b64decode(seedB64_);
    if (!seed || seed->size() != 32) return "";
    PkeyGuard g;
    g.p = EVP_PKEY_new_raw_private_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(seed->data()), 32);
    if (!g.p) return "";
    EVP_MD_CTX *md = EVP_MD_CTX_new();
    if (!md) return "";
    std::string sig;
    if (EVP_DigestSignInit(md, nullptr, nullptr, nullptr, g.p) == 1) {
        std::size_t len = 0;
        const auto *d = reinterpret_cast<const unsigned char *>(data.data());
        if (EVP_DigestSign(md, nullptr, &len, d, data.size()) == 1) {
            std::vector<unsigned char> out(len);
            if (EVP_DigestSign(md, out.data(), &len, d, data.size()) == 1) {
                sig = b64encode(std::string(out.begin(), out.begin() + len));
            }
        }
    }
    EVP_MD_CTX_free(md);
    return sig;
}

std::string sasEmoji(const std::string &fpA, const std::string &fpB) {
    // Фиксированный набор эмодзи (степень двойки для равномерного маппинга).
    static const char *kEmoji[] = {
        "🐱", "🐶", "🦊", "🐻", "🐼", "🐨", "🦁", "🐯",
        "🐸", "🐵", "🦉", "🦄", "🐝", "🦋", "🌺", "🌈",
        "🍎", "🍊", "🍋", "🍉", "🍇", "🍓", "🥝", "🍑",
        "🎸", "🎹", "🎺", "🥁", "🎨", "🎲", "🚀", "⚓",
    };
    constexpr int kN = 32;
    // Сортируем пару, чтобы обе стороны получили одинаковый вход.
    std::string a = fpA, b = fpB;
    if (a > b) std::swap(a, b);
    const std::string data = a + "|" + b;
    unsigned char h[EVP_MAX_MD_SIZE];
    unsigned int hlen = 0;
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    std::string out;
    if (ctx && EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr) == 1
        && EVP_DigestUpdate(ctx, data.data(), data.size()) == 1
        && EVP_DigestFinal_ex(ctx, h, &hlen) == 1 && hlen >= 4) {
        for (int i = 0; i < 4; ++i) {
            out += kEmoji[h[i] % kN];
        }
    }
    if (ctx) EVP_MD_CTX_free(ctx);
    return out;
}

bool verify(const std::string &publicB64, const std::string &data,
            const std::string &sigB64) {
    const auto pub = b64decode(publicB64);
    const auto sig = b64decode(sigB64);
    if (!pub || pub->size() != 32 || !sig) return false;
    PkeyGuard g;
    g.p = EVP_PKEY_new_raw_public_key(
        EVP_PKEY_ED25519, nullptr,
        reinterpret_cast<const unsigned char *>(pub->data()), 32);
    if (!g.p) return false;
    EVP_MD_CTX *md = EVP_MD_CTX_new();
    if (!md) return false;
    bool ok = false;
    if (EVP_DigestVerifyInit(md, nullptr, nullptr, nullptr, g.p) == 1) {
        ok = EVP_DigestVerify(
                 md,
                 reinterpret_cast<const unsigned char *>(sig->data()), sig->size(),
                 reinterpret_cast<const unsigned char *>(data.data()), data.size())
             == 1;
    }
    EVP_MD_CTX_free(md);
    return ok;
}

} // namespace parvane::crypto
