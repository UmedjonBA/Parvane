// Parvane fork: E2E-слой (Фаза 2). См. e2e.h. MVP: аккаунт+сессии в памяти.
#include "parvane/e2e.h"

#include "parvane_e2e.h" // C-FFI vodozemac (shared/parvane-e2e/include)
#include "parvane/itransport.h"
#include "parvane/topics.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using nlohmann::json;

namespace parvane::e2e {
namespace {

std::mutex g_mu;
ParvaneE2EAccount *g_account = nullptr;
std::map<std::string, ParvaneE2ESession *> g_sessions; // контакт → Olm-сессия
std::string g_identityB64;
std::int64_t g_otkNext = 1;

// Забрать char* из FFI в std::string и освободить.
std::string take(char *p) {
    if (!p) {
        return {};
    }
    std::string s(p);
    parvane_e2e_string_free(p);
    return s;
}

// Стандартный base64 БЕЗ padding (как у vodozemac). Encode/decode симметричны
// с FFI-контрактом parvane_e2e (см. parvane_e2e.h).
constexpr char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string b64e(const std::string &in) {
    std::string out;
    int val = 0, bits = -6;
    for (unsigned char c : in) {
        val = (val << 8) + c;
        bits += 8;
        while (bits >= 0) {
            out.push_back(kB64[(val >> bits) & 0x3F]);
            bits -= 6;
        }
    }
    if (bits > -6) {
        out.push_back(kB64[((val << 8) >> (bits + 8)) & 0x3F]);
    }
    return out; // без '='
}

std::string b64d(const std::string &in) {
    std::vector<int> t(256, -1);
    for (int i = 0; i < 64; ++i) {
        t[(unsigned char)kB64[i]] = i;
    }
    std::string out;
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (t[c] == -1) {
            break; // конец/padding/мусор
        }
        val = (val << 6) + t[c];
        bits += 6;
        if (bits >= 0) {
            out.push_back(char((val >> bits) & 0xFF));
            bits -= 8;
        }
    }
    return out;
}

} // namespace

void initDevice(ITransport &t, const std::string & /*self*/, const std::string &token) {
    std::string identity, otksJson;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_account) {
            return; // идемпотентно
        }
        g_account = parvane_e2e_account_new();
        g_identityB64 = take(parvane_e2e_account_identity(g_account));
        identity = g_identityB64;
        otksJson = take(parvane_e2e_account_gen_otks(g_account, 20, g_otkNext));
        g_otkNext += 20;
    }
    // Публикация prekeys — сетевой request, вне лока.
    try {
        json otks = json::parse(otksJson);
        json req = {
            {"token", token},
            {"registration_id", 1},
            {"identity_key", identity},
            // signed prekey — Olm его не использует; кладём заглушку (поля есть в
            // каталоге по libsignal-совместимости).
            {"signed_prekey_id", 1},
            {"signed_prekey", identity},
            {"signed_prekey_sig", "olm"},
            {"one_time", otks},
        };
        t.request(topics::IdentityPrekeysPublish, req.dump(), 5000);
    } catch (const std::exception &) {
    }
}

bool ready() {
    std::lock_guard<std::mutex> lk(g_mu);
    return g_account != nullptr;
}

std::string sealFor(const std::string &to, const std::string &contentJson, ITransport &t,
                    const std::string &token) {
    std::string identity;
    bool haveSession = false;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_account) {
            return {};
        }
        identity = g_identityB64;
        haveSession = g_sessions.count(to) > 0;
    }

    // Нет сессии → X3DH: тянем бандл собеседника (вне лока). Ретраим — на старте
    // собеседник мог ещё не опубликовать prekeys (гонка логинов).
    std::string peerIdentity, otk;
    if (!haveSession) {
        for (int attempt = 0; attempt < 4; ++attempt) {
            try {
                json fr = {{"token", token}, {"user", to}};
                auto resp = json::parse(t.request(topics::IdentityPrekeysFetch, fr.dump(), 5000));
                if (resp.value("ok", false)) {
                    peerIdentity = resp.value("identity_key", "");
                    if (resp.contains("one_time") && resp["one_time"].is_string()) {
                        otk = resp["one_time"].get<std::string>();
                    }
                }
            } catch (const std::exception &) {
            }
            if (!peerIdentity.empty() && !otk.empty()) {
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(400));
        }
        if (peerIdentity.empty() || otk.empty()) {
            return {}; // без one-time Olm-сессию не установить
        }
    }

    std::lock_guard<std::mutex> lk(g_mu);
    ParvaneE2ESession *sess = nullptr;
    auto it = g_sessions.find(to);
    if (it != g_sessions.end()) {
        sess = it->second;
    } else if (!peerIdentity.empty() && !otk.empty()) {
        sess = parvane_e2e_outbound(g_account, peerIdentity.c_str(), otk.c_str());
        if (sess) {
            g_sessions[to] = sess;
        }
    }
    if (!sess) {
        return {};
    }
    std::uint32_t ctype = 0;
    const std::string ptB64 = b64e(contentJson);
    const std::string ct = take(parvane_e2e_encrypt(sess, ptB64.c_str(), &ctype));
    if (ct.empty()) {
        return {};
    }
    json enc = {
        {"kind", "encrypted"},
        {"ciphertext", ct},
        {"ctype", ctype},
        {"sender_identity", identity},
    };
    return enc.dump();
}

std::string open(const std::string &from, const std::string &encryptedJson) {
    std::string ct, senderId;
    std::uint32_t ctype = 1;
    try {
        auto j = json::parse(encryptedJson);
        ct = j.value("ciphertext", "");
        ctype = j.value("ctype", 1u);
        senderId = j.value("sender_identity", "");
    } catch (const std::exception &) {
        return {};
    }
    if (ct.empty()) {
        return {};
    }

    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account) {
        return {};
    }
    if (ctype == 0) {
        // pre-key: новая входящая сессия (заменяет прежнюю от этого контакта).
        char *outPt = nullptr;
        auto *sess = parvane_e2e_inbound(g_account, senderId.c_str(), 0, ct.c_str(), &outPt);
        if (!sess) {
            return {};
        }
        auto it = g_sessions.find(from);
        if (it != g_sessions.end() && it->second) {
            parvane_e2e_session_free(it->second);
        }
        g_sessions[from] = sess;
        return b64d(take(outPt));
    }
    // normal: нужна установленная сессия.
    auto it = g_sessions.find(from);
    if (it == g_sessions.end() || !it->second) {
        return {};
    }
    const std::string ptB64 = take(parvane_e2e_decrypt(it->second, ctype, ct.c_str()));
    if (ptB64.empty()) {
        return {};
    }
    return b64d(ptB64);
}

} // namespace parvane::e2e
