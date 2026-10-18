// Parvane fork: см. keybundle.h.
#include "parvane/keybundle.h"

#include "parvane/crypto.h"

#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/rand.h>

#include <cctype>
#include <cstring>
#include <memory>

namespace parvane::keybundle {
namespace {

using nlohmann::json;

constexpr unsigned char kMagic[] = {0x50, 0x56, 0x4b, 0x42};
constexpr unsigned char kVersion = 1;
constexpr std::size_t kHeader = sizeof(kMagic) + 1;
constexpr std::size_t kNonce = 12;
constexpr std::size_t kTag = 16;
constexpr std::size_t kKeyChars = 40;
constexpr const char *kSalt = "parvane/v2/key-bundle";

bool isKeyChar(char c) {
    const auto u = static_cast<unsigned char>(c);
    return std::isdigit(u) || (u >= 'A' && u <= 'Z');
}

std::string upper(const std::string &s) {
    std::string out = s;
    for (auto &c : out) {
        const auto u = static_cast<unsigned char>(c);
        if (u < 0x80) c = static_cast<char>(std::toupper(u));
    }
    return out;
}

std::string aad(const std::string &address) {
    std::string out(reinterpret_cast<const char *>(kMagic), sizeof(kMagic));
    out.push_back(static_cast<char>(kVersion));
    return out + address;
}

std::string toHex(const unsigned char *b, std::size_t n) {
    static const char *d = "0123456789abcdef";
    std::string out;
    out.reserve(n * 2);
    for (std::size_t i = 0; i < n; ++i) {
        out.push_back(d[b[i] >> 4]);
        out.push_back(d[b[i] & 15]);
    }
    return out;
}

using CtxPtr = std::unique_ptr<EVP_CIPHER_CTX, decltype(&EVP_CIPHER_CTX_free)>;

} // namespace

std::optional<std::string> canonicalRecoveryKey(const std::string &text) {
    std::string compact;
    for (const char c : upper(text)) {
        if (!isKeyChar(c)) continue;
        compact.push_back(c == 'O' ? '0' : (c == 'I' || c == 'L') ? '1' : c);
    }
    if (compact.size() != kKeyChars || compact.find('U') != std::string::npos) return std::nullopt;
    return compact;
}

std::string pickRecoveryKey(const std::string &text) {
    // Как web KEY_IN_TEXT: десять групп по четыре знака, между ними до трёх любых знаков (не латиница и не
    // цифра), по краям — не латиница и не цифра. Поиск по позициям: первая подходящая находка.
    const auto s = upper(text);
    const auto n = s.size();
    for (std::size_t start = 0; start < n; ++start) {
        if (!isKeyChar(s[start]) || (start > 0 && isKeyChar(s[start - 1]))) continue;
        std::string groups;
        std::size_t pos = start;
        bool ok = true;
        for (int g = 0; g < 10 && ok; ++g) {
            if (g > 0) {
                std::size_t sep = 0;
                while (sep < 3 && pos < n && !isKeyChar(s[pos])) {
                    ++pos;
                    ++sep;
                }
            }
            for (int k = 0; k < 4; ++k) {
                if (pos >= n || !isKeyChar(s[pos])) {
                    ok = false;
                    break;
                }
                groups.push_back(s[pos++]);
            }
        }
        if (!ok || (pos < n && isKeyChar(s[pos]))) continue;
        if (const auto canonical = canonicalRecoveryKey(groups)) {
            std::string out;
            for (std::size_t i = 0; i < canonical->size(); i += 4) {
                if (!out.empty()) out.push_back('-');
                out += canonical->substr(i, 4);
            }
            return out;
        }
    }
    // Без пробелов по краям (как String.trim)
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

std::optional<std::string> deriveBundleKey(const std::string &recoveryKey, const std::string &address) {
    const auto canonical = canonicalRecoveryKey(recoveryKey);
    if (!canonical) return std::nullopt;
    std::unique_ptr<EVP_PKEY_CTX, decltype(&EVP_PKEY_CTX_free)> ctx(EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr),
                                                                    &EVP_PKEY_CTX_free);
    std::string out(32, '\0');
    std::size_t len = out.size();
    const bool ok = ctx && EVP_PKEY_derive_init(ctx.get()) == 1
        && EVP_PKEY_CTX_set_hkdf_md(ctx.get(), EVP_sha256()) == 1
        && EVP_PKEY_CTX_set1_hkdf_salt(ctx.get(), reinterpret_cast<const unsigned char *>(kSalt),
                                       static_cast<int>(std::strlen(kSalt))) == 1
        && EVP_PKEY_CTX_set1_hkdf_key(ctx.get(), reinterpret_cast<const unsigned char *>(canonical->data()),
                                      static_cast<int>(canonical->size())) == 1
        && EVP_PKEY_CTX_add1_hkdf_info(ctx.get(), reinterpret_cast<const unsigned char *>(address.data()),
                                       static_cast<int>(address.size())) == 1
        && EVP_PKEY_derive(ctx.get(), reinterpret_cast<unsigned char *>(out.data()), &len) == 1 && len == 32;
    if (!ok) return std::nullopt;
    return out;
}

std::string seal(const std::string &bundleKey, const std::string &address, const json &payload) {
    if (bundleKey.size() != 32) return {};
    unsigned char nonce[kNonce];
    if (RAND_bytes(nonce, kNonce) != 1) return {};
    const auto plain = payload.dump();
    const auto ad = aad(address);
    CtxPtr ctx(EVP_CIPHER_CTX_new(), &EVP_CIPHER_CTX_free);
    std::string cipher(plain.size() + kTag, '\0');
    int len = 0, total = 0;
    bool ok = ctx && EVP_EncryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1
        && EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_IVLEN, kNonce, nullptr) == 1
        && EVP_EncryptInit_ex(ctx.get(), nullptr, nullptr, reinterpret_cast<const unsigned char *>(bundleKey.data()),
                              nonce) == 1
        && EVP_EncryptUpdate(ctx.get(), nullptr, &len, reinterpret_cast<const unsigned char *>(ad.data()),
                             static_cast<int>(ad.size())) == 1
        && EVP_EncryptUpdate(ctx.get(), reinterpret_cast<unsigned char *>(cipher.data()), &len,
                             reinterpret_cast<const unsigned char *>(plain.data()), static_cast<int>(plain.size())) == 1;
    total = len;
    ok = ok && EVP_EncryptFinal_ex(ctx.get(), reinterpret_cast<unsigned char *>(cipher.data()) + total, &len) == 1;
    total += len;
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_GET_TAG, kTag,
                                   reinterpret_cast<unsigned char *>(cipher.data()) + total) == 1;
    if (!ok) return {};
    cipher.resize(static_cast<std::size_t>(total) + kTag);
    std::string out(reinterpret_cast<const char *>(kMagic), sizeof(kMagic));
    out.push_back(static_cast<char>(kVersion));
    out.append(reinterpret_cast<const char *>(nonce), kNonce);
    return out + cipher;
}

std::optional<json> open(const std::string &bundleKey, const std::string &address, const std::string &bytes) {
    if (bundleKey.size() != 32 || bytes.size() <= kHeader + kNonce + kTag) return std::nullopt;
    if (std::memcmp(bytes.data(), kMagic, sizeof(kMagic)) != 0 || static_cast<unsigned char>(bytes[4]) != kVersion) {
        return std::nullopt;
    }
    const auto nonce = reinterpret_cast<const unsigned char *>(bytes.data() + kHeader);
    const auto body = bytes.substr(kHeader + kNonce);
    const auto cipherLen = body.size() - kTag;
    const auto ad = aad(address);
    CtxPtr ctx(EVP_CIPHER_CTX_new(), &EVP_CIPHER_CTX_free);
    std::string plain(cipherLen, '\0');
    int len = 0, total = 0;
    bool ok = ctx && EVP_DecryptInit_ex(ctx.get(), EVP_aes_256_gcm(), nullptr, nullptr, nullptr) == 1
        && EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_IVLEN, kNonce, nullptr) == 1
        && EVP_DecryptInit_ex(ctx.get(), nullptr, nullptr, reinterpret_cast<const unsigned char *>(bundleKey.data()),
                              nonce) == 1
        && EVP_DecryptUpdate(ctx.get(), nullptr, &len, reinterpret_cast<const unsigned char *>(ad.data()),
                             static_cast<int>(ad.size())) == 1
        && EVP_DecryptUpdate(ctx.get(), reinterpret_cast<unsigned char *>(plain.data()), &len,
                             reinterpret_cast<const unsigned char *>(body.data()), static_cast<int>(cipherLen)) == 1;
    total = len;
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx.get(), EVP_CTRL_GCM_SET_TAG, kTag,
                                   const_cast<char *>(body.data() + cipherLen)) == 1
        && EVP_DecryptFinal_ex(ctx.get(), reinterpret_cast<unsigned char *>(plain.data()) + total, &len) == 1;
    if (!ok) return std::nullopt;
    plain.resize(static_cast<std::size_t>(total + len));
    auto v = json::parse(plain, nullptr, false);
    if (!v.is_object() || !v.contains("grant") || !v["grant"].is_string() || v["grant"].get<std::string>().empty()) {
        return std::nullopt;
    }
    json out{{"grant", v["grant"]}};
    if (v.contains("planner") && v["planner"].is_string()) out["planner"] = v["planner"];
    if (v.contains("cloud") && v["cloud"].is_string()) out["cloud"] = v["cloud"];
    if (v.contains("history") && v["history"].is_object()) {
        const auto &h = v["history"];
        if (h.contains("fileId") && h["fileId"].is_string() && h.contains("fileKey") && h["fileKey"].is_string()
            && h.contains("fileNonce") && h["fileNonce"].is_string() && h.contains("at") && h["at"].is_number()
            && h.contains("mark") && h["mark"].is_string()) {
            out["history"] = h;
        }
    }
    return out;
}

std::string withFreshLog(const std::string &grant, const std::string &logResponse) {
    auto m = json::parse(grant, nullptr, false);
    if (!m.is_object()) return grant;
    m["log"] = toHex(reinterpret_cast<const unsigned char *>(logResponse.data()), logResponse.size());
    return m.dump();
}

std::string withBundleKey(const std::string &grant, const std::string &bundleKeyB64) {
    auto m = json::parse(grant, nullptr, false);
    if (!m.is_object()) return grant;
    m["bk"] = bundleKeyB64;
    return m.dump();
}

std::string readGrantBundleKey(const std::string &grant) {
    const auto m = json::parse(grant, nullptr, false);
    if (!m.is_object() || !m.contains("bk") || !m["bk"].is_string()) return {};
    return m["bk"].get<std::string>();
}

std::string digestHex(const std::string &text) {
    unsigned char h[EVP_MAX_MD_SIZE];
    unsigned int len = 0;
    if (EVP_Digest(text.data(), text.size(), h, &len, EVP_sha256(), nullptr) != 1) return {};
    return toHex(h, len);
}

} // namespace parvane::keybundle
