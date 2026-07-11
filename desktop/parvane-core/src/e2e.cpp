// Parvane fork: E2E-слой (Фаза 2). См. e2e.h.
// Sealed sender: реальный отправитель (from) едет ВНУТРИ шифртекста
// ({from,content}); сервер видит только шифртекст + identity-ключ отправителя.
// Сессии keyed по IDENTITY-ключу собеседника (адрес скрыт), с кэшем
// contact→identity. Персист аккаунта/сессий/кэша в storeDir.
#include "parvane/e2e.h"

#include "parvane_e2e.h" // C-FFI vodozemac (shared/parvane-e2e/include)
#include "parvane/itransport.h"
#include "parvane/topics.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
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
std::map<std::string, ParvaneE2ESession *> g_sessions; // identity собеседника → сессия
std::map<std::string, std::string> g_contactId;        // адрес контакта → identity
std::string g_identityB64;                              // свой identity-ключ
std::string g_self;                                     // свой адрес (для конверта)
std::string g_storeDir;

std::string take(char *p) {
    if (!p) {
        return {};
    }
    std::string s(p);
    parvane_e2e_string_free(p);
    return s;
}

// Стандартный base64 БЕЗ padding (как у vodozemac).
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
    return out;
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
            break;
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

// ── файловый персист (под g_mu) ───────────────────────────────────────────────
std::string hexName(const std::string &s) {
    static const char *H = "0123456789abcdef";
    std::string out;
    for (unsigned char c : s) {
        out.push_back(H[c >> 4]);
        out.push_back(H[c & 0xF]);
    }
    return out;
}
std::string readFile(const std::string &path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        return {};
    }
    return std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
}
void writeFile(const std::string &path, const std::string &data) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (f) {
        f.write(data.data(), static_cast<std::streamsize>(data.size()));
    }
}
std::string accountPath() { return g_storeDir + "/account.json"; }
std::string sessionPath(const std::string &idB64) {
    return g_storeDir + "/sess_" + hexName(idB64) + ".json";
}
std::string contactsPath() { return g_storeDir + "/contacts.json"; }

void persistAccount() {
    if (g_storeDir.empty() || !g_account) {
        return;
    }
    writeFile(accountPath(), take(parvane_e2e_account_pickle(g_account)));
}
void persistSession(const std::string &idB64, ParvaneE2ESession *s) {
    if (g_storeDir.empty() || !s) {
        return;
    }
    writeFile(sessionPath(idB64), take(parvane_e2e_session_pickle(s)));
}
void saveContacts() {
    if (g_storeDir.empty()) {
        return;
    }
    json j = json::object();
    for (const auto &[k, v] : g_contactId) {
        j[k] = v;
    }
    writeFile(contactsPath(), j.dump());
}
void loadContacts() {
    if (g_storeDir.empty()) {
        return;
    }
    const auto raw = readFile(contactsPath());
    if (raw.empty()) {
        return;
    }
    auto j = json::parse(raw, nullptr, false);
    if (j.is_object()) {
        for (auto it = j.begin(); it != j.end(); ++it) {
            if (it.value().is_string()) {
                g_contactId[it.key()] = it.value().get<std::string>();
            }
        }
    }
}

// Сессия по identity собеседника: память → диск.
ParvaneE2ESession *getSession(const std::string &idB64) {
    auto it = g_sessions.find(idB64);
    if (it != g_sessions.end()) {
        return it->second;
    }
    if (!g_storeDir.empty() && !idB64.empty()) {
        const auto pickle = readFile(sessionPath(idB64));
        if (!pickle.empty()) {
            if (auto *s = parvane_e2e_session_from_pickle(pickle.c_str())) {
                g_sessions[idB64] = s;
                return s;
            }
        }
    }
    return nullptr;
}

} // namespace

void initDevice(ITransport &t, const std::string &self, const std::string &token,
                const std::string &storeDir) {
    std::string identity, otksJson;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_account) {
            return; // идемпотентно (в рамках процесса)
        }
        g_self = self;
        g_storeDir = storeDir;
        if (!g_storeDir.empty()) {
            std::error_code ec;
            std::filesystem::create_directories(g_storeDir, ec);
            const auto pickle = readFile(accountPath());
            if (!pickle.empty()) {
                g_account = parvane_e2e_account_from_pickle(pickle.c_str());
            }
            loadContacts();
        }
        if (!g_account) {
            g_account = parvane_e2e_account_new();
        }
        g_identityB64 = take(parvane_e2e_account_identity(g_account));
        identity = g_identityB64;
        otksJson = take(parvane_e2e_account_gen_otks(g_account, 20, 1));
        persistAccount(); // новый аккаунт ИЛИ приватные one-time
    }
    try {
        json otks = json::parse(otksJson);
        json req = {
            {"token", token},
            {"registration_id", 1},
            {"identity_key", identity},
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
    // Реальный отправитель — ВНУТРЬ шифртекста (sealed sender).
    json inner;
    try {
        inner = {{"from", g_self}, {"content", json::parse(contentJson)}};
    } catch (const std::exception &) {
        return {};
    }

    std::string identity, idB64;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!g_account) {
            return {};
        }
        identity = g_identityB64;
        auto c = g_contactId.find(to);
        if (c != g_contactId.end()) {
            idB64 = c->second;
        }
    }

    // Нет известной сессии по кэшу → тянем бандл (identity + one-time), ретраим.
    std::string otk;
    bool needBundle;
    {
        std::lock_guard<std::mutex> lk(g_mu);
        needBundle = idB64.empty() || getSession(idB64) == nullptr;
    }
    if (needBundle) {
        std::string peerIdentity;
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
            return {};
        }
        idB64 = peerIdentity;
    }

    std::lock_guard<std::mutex> lk(g_mu);
    // Обновляем кэш contact→identity (детект смены ключа — новый safety number).
    if (g_contactId[to] != idB64) {
        g_contactId[to] = idB64;
        saveContacts();
    }
    ParvaneE2ESession *sess = getSession(idB64);
    if (!sess && !otk.empty()) {
        sess = parvane_e2e_outbound(g_account, idB64.c_str(), otk.c_str());
        if (sess) {
            g_sessions[idB64] = sess;
        }
    }
    if (!sess) {
        return {};
    }
    std::uint32_t ctype = 0;
    const std::string ct = take(parvane_e2e_encrypt(sess, b64e(inner.dump()).c_str(), &ctype));
    if (ct.empty()) {
        return {};
    }
    persistSession(idB64, sess);
    json enc = {
        {"kind", "encrypted"},
        {"ciphertext", ct},
        {"ctype", ctype},
        {"sender_identity", identity},
    };
    return enc.dump();
}

std::string open(const std::string & /*from_hint*/, const std::string &encryptedJson) {
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
    if (ct.empty() || senderId.empty()) {
        return {};
    }

    std::lock_guard<std::mutex> lk(g_mu);
    if (!g_account) {
        return {};
    }
    if (ctype == 0) {
        // pre-key: новая входящая сессия (keyed по identity отправителя).
        char *outPt = nullptr;
        auto *sess = parvane_e2e_inbound(g_account, senderId.c_str(), 0, ct.c_str(), &outPt);
        if (!sess) {
            return {};
        }
        auto it = g_sessions.find(senderId);
        if (it != g_sessions.end() && it->second) {
            parvane_e2e_session_free(it->second);
        }
        g_sessions[senderId] = sess;
        persistAccount(); // inbound израсходовал one-time
        persistSession(senderId, sess);
        return b64d(take(outPt)); // inner {from, content}
    }
    ParvaneE2ESession *sess = getSession(senderId);
    if (!sess) {
        return {};
    }
    const std::string ptB64 = take(parvane_e2e_decrypt(sess, ctype, ct.c_str()));
    if (ptB64.empty()) {
        return {};
    }
    persistSession(senderId, sess);
    return b64d(ptB64);
}

std::string safetyNumber(const std::string &contact) {
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_identityB64.empty()) {
        return {};
    }
    auto it = g_contactId.find(contact);
    if (it == g_contactId.end() || it->second.empty()) {
        return {};
    }
    return take(parvane_e2e_safety_number(g_identityB64.c_str(), it->second.c_str()));
}

} // namespace parvane::e2e
